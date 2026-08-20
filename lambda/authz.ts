import { ApiError, PublicProfile } from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { accountClosureKey } from './account-closure';
import {
  Deps,
  FriendItem,
  GetCommand,
  K,
  LinkItem,
  ProfileItem,
  getItem,
  queryPrefix,
} from './db';

/**
 * Authorization primitives — every rule from the permissions matrix
 * (backend-contract.md §4) reads the TABLE, never token claims.
 */

export interface Ctx {
  callerId: string;
  caller: ProfileItem;
  deps: Deps;
}

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export const WRITABLE_PROFILE_CONDITION =
  'attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)';

/** Transaction guards used by every owner-scoped write. Legacy profiles have no status. */
export function writableProfileConditionCheck(deps: Deps, ownerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: K.profile(ownerId),
      ConditionExpression: WRITABLE_PROFILE_CONDITION,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
    },
  };
}

export function closureAbsenceConditionCheck(deps: Deps, ownerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: accountClosureKey(ownerId),
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export function writableOwnerConditionChecks(deps: Deps, ownerId: string): TransactItem[] {
  return [
    writableProfileConditionCheck(deps, ownerId),
    closureAbsenceConditionCheck(deps, ownerId),
  ];
}

/** Resolve the caller or 401 — a live token for a deleted account is not a user. */
export async function resolveCaller(deps: Deps, callerId: string): Promise<Ctx> {
  const caller = await getItem<ProfileItem>(deps, K.profile(callerId));
  if (!caller) throw new ApiError('UNAUTHENTICATED');
  return { callerId, caller, deps };
}

export async function profileOf(deps: Deps, userId: string): Promise<ProfileItem | null> {
  return getItem<ProfileItem>(deps, K.profile(userId));
}

/** Strong read for lifecycle-sensitive listings and authorization decisions. */
export async function profileOfConsistent(
  deps: Deps,
  userId: string,
): Promise<ProfileItem | null> {
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: K.profile(userId),
      ConsistentRead: true,
    }),
  );
  return (result.Item as ProfileItem | undefined) ?? null;
}

/** Consistent preflight for every mutation owned by one account. */
export async function requireWritableOwner(ctx: Ctx, ownerId: string): Promise<ProfileItem> {
  const [profileResult, closureResult] = await Promise.all([
    ctx.deps.ddb.send(
      new GetCommand({
        TableName: ctx.deps.table,
        Key: K.profile(ownerId),
        ConsistentRead: true,
      }),
    ),
    ctx.deps.ddb.send(
      new GetCommand({
        TableName: ctx.deps.table,
        Key: accountClosureKey(ownerId),
        ConsistentRead: true,
      }),
    ),
  ]);
  const profile = profileResult.Item as ProfileItem | undefined;
  if (
    !profile ||
    (profile.status !== undefined && profile.status !== 'active') ||
    closureResult.Item
  ) {
    throw new ApiError('CONFLICT', 'account closure is in progress');
  }
  return profile;
}

export function toPublic(profile: ProfileItem, includeSocial: boolean): PublicProfile {
  return {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    accountType: profile.accountType,
    ...(includeSocial ? { socialEnabled: profile.socialEnabled } : {}),
  };
}

export async function guardianLink(
  deps: Deps,
  guardianId: string,
  minorId: string,
): Promise<LinkItem | null> {
  return getItem<LinkItem>(deps, K.link(minorId, guardianId));
}

/** People I guard. */
export async function minorsOf(deps: Deps, guardianId: string): Promise<LinkItem[]> {
  return queryPrefix<LinkItem>(deps, K.user(guardianId), 'MINOR#', { index: 'gsi1' });
}

/** People who guard me. */
export async function guardiansOf(deps: Deps, minorId: string): Promise<LinkItem[]> {
  return queryPrefix<LinkItem>(deps, K.user(minorId), 'GUARDIAN#');
}

export async function friendshipBetween(
  deps: Deps,
  a: string,
  b: string,
): Promise<FriendItem | null> {
  return getItem<FriendItem>(deps, K.friend(a, b));
}

export type Relationship = 'self' | 'guardian' | 'minor' | 'friend' | null;

/** How the caller relates to `targetId` — drives forest detail per the matrix. */
export async function relationshipTo(ctx: Ctx, targetId: string): Promise<Relationship> {
  if (ctx.callerId === targetId) return 'self';
  if (await guardianLink(ctx.deps, ctx.callerId, targetId)) return 'guardian';
  if (await guardianLink(ctx.deps, targetId, ctx.callerId)) return 'minor';
  const friends = await friendshipBetween(ctx.deps, ctx.callerId, targetId);
  if (friends) {
    // Friend visits require socialEnabled on BOTH sides.
    const target = await profileOf(ctx.deps, targetId);
    if (ctx.caller.socialEnabled && target?.socialEnabled) return 'friend';
    return null;
  }
  return null;
}

/** Guardian gate for /family/children/:id/* — 404-shaped, never an oracle. */
export async function requireGuardianOf(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const link = await guardianLink(ctx.deps, ctx.callerId, minorId);
  if (!link) throw new ApiError('NOT_FOUND');
  return link;
}

/** Re-check the relationship after a failed transaction without an eventual-read window. */
export async function requireGuardianOfConsistent(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const result = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: K.link(minorId, ctx.callerId),
      ConsistentRead: true,
    }),
  );
  const link = result.Item as LinkItem | undefined;
  if (!link) throw new ApiError('NOT_FOUND');
  return link;
}

/** Identity-admin gate — only over minors the caller CREATED. */
export async function requireCreatedGuardianOf(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const link = await requireGuardianOf(ctx, minorId);
  if (link.kind !== 'created') throw new ApiError('FORBIDDEN', 'invited links have no identity admin');
  return link;
}

export function requireSocial(ctx: Ctx): void {
  if (!ctx.caller.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
}
