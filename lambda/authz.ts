import { ApiError, PublicProfile } from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { accountClosureKey } from './account-closure';
import { FK } from './family/keys';
import type { CoverageAssignmentItem, HouseholdSnapshot } from './family/model';
import { readHouseholdSnapshot } from './family/repository';
import {
  authorizeForestVisit,
  type ForestRelationship,
  type SocialPolicyPerson,
} from './social/policy';
import { SK, type FriendshipItem as CanonicalFriendshipItem } from './social/model';
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
  /** Cognito auth_time normalized to epoch milliseconds; absent fails reinforced actions closed. */
  authenticatedAt?: number;
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
export async function resolveCaller(
  deps: Deps,
  callerId: string,
  authenticatedAt?: number,
): Promise<Ctx> {
  const caller = await getItem<ProfileItem>(deps, K.profile(callerId));
  if (!caller) throw new ApiError('UNAUTHENTICATED');
  return { callerId, caller, ...(authenticatedAt === undefined ? {} : { authenticatedAt }), deps };
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

export type ResolvedRelationship = ForestRelationship | null;
type ActiveCanonicalFriendship = CanonicalFriendshipItem & { readonly state: 'active' };

function socialPolicyPerson(profile: ProfileItem): SocialPolicyPerson {
  return {
    accountId: profile.userId,
    accountType: profile.accountType,
    socialEnabled: profile.socialEnabled,
    status: profile.status ?? 'active',
    ...(profile.majorityAt === undefined ? {} : { majorityAt: profile.majorityAt }),
  };
}

function exactProfile(profile: ProfileItem | null, accountId: string): profile is ProfileItem {
  const expected = K.profile(accountId);
  return Boolean(
    profile &&
      profile.pk === expected.pk &&
      profile.sk === expected.sk &&
      profile.userId === accountId,
  );
}

async function canonicalFriendshipBetween(
  deps: Deps,
  leftAccountId: string,
  rightAccountId: string,
): Promise<ActiveCanonicalFriendship | undefined> {
  let key: ReturnType<typeof SK.friendship>;
  try {
    key = SK.friendship(leftAccountId, rightAccountId);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: key,
      ConsistentRead: true,
    }),
  );
  const friendship = result.Item as CanonicalFriendshipItem | undefined;
  if (
    !friendship ||
    friendship.pk !== key.pk ||
    friendship.sk !== key.sk ||
    friendship.entityType !== 'Friendship' ||
    friendship.state !== 'active' ||
    !Number.isSafeInteger(friendship.revision) ||
    friendship.revision < 1 ||
    !Number.isSafeInteger(friendship.activatedAt) ||
    (friendship.activatedAt ?? -1) < 0 ||
    friendship.endedAt !== null
  ) {
    return undefined;
  }
  return friendship as ActiveCanonicalFriendship;
}

async function householdForMinor(
  deps: Deps,
  minorId: string,
): Promise<HouseholdSnapshot | undefined> {
  let coverageKey: ReturnType<typeof FK.familyCoverage>;
  try {
    coverageKey = FK.familyCoverage(minorId);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: coverageKey,
      ConsistentRead: true,
    }),
  );
  const coverage = result.Item as CoverageAssignmentItem | undefined;
  if (
    !coverage ||
    coverage.pk !== coverageKey.pk ||
    coverage.sk !== coverageKey.sk ||
    coverage.entityType !== 'CoverageAssignment' ||
    coverage.accountId !== minorId ||
    coverage.seatType !== 'minor' ||
    typeof coverage.householdId !== 'string'
  ) {
    return undefined;
  }
  return (
    (await readHouseholdSnapshot(
      { ddb: deps.ddb, tableName: deps.table, now: deps.now },
      coverage.householdId,
    )) ?? undefined
  );
}

async function currentRelationshipProfile(ctx: Ctx, accountId: string): Promise<ProfileItem | null> {
  try {
    return await requireWritableOwner(ctx, accountId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONFLICT') return null;
    throw error;
  }
}

/** Resolve the canonical relationship used to authorize forest access. */
export async function resolveRelationship(
  ctx: Ctx,
  targetId: string,
): Promise<ResolvedRelationship> {
  if (ctx.callerId === targetId) return 'self';
  const [actor, target] = await Promise.all([
    currentRelationshipProfile(ctx, ctx.callerId),
    currentRelationshipProfile(ctx, targetId),
  ]);
  if (!exactProfile(actor, ctx.callerId) || !exactProfile(target, targetId)) return null;

  const compatibleFriendPair = actor.accountType === target.accountType;
  const friendship = compatibleFriendPair
    ? await canonicalFriendshipBetween(ctx.deps, actor.userId, target.userId)
    : undefined;
  const household =
    actor.accountType === 'adult' && target.accountType === 'minor'
      ? await householdForMinor(ctx.deps, target.userId)
      : undefined;
  const decision = authorizeForestVisit({
    actor: socialPolicyPerson(actor),
    target: socialPolicyPerson(target),
    ...(friendship === undefined ? {} : { friendship }),
    ...(household === undefined ? {} : { household }),
    now: ctx.deps.now(),
  });
  return decision.allowed ? decision.relationship : null;
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
