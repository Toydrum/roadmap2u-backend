import { ApiError, PublicProfile } from '@app/api/contracts';
import { Deps, FriendItem, K, LinkItem, ProfileItem, getItem, queryPrefix } from './db';

/**
 * Authorization primitives — every rule from the permissions matrix
 * (backend-contract.md §4) reads the TABLE, never token claims.
 */

export interface Ctx {
  callerId: string;
  caller: ProfileItem;
  deps: Deps;
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

/** Identity-admin gate — only over minors the caller CREATED. */
export async function requireCreatedGuardianOf(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const link = await requireGuardianOf(ctx, minorId);
  if (link.kind !== 'created') throw new ApiError('FORBIDDEN', 'invited links have no identity admin');
  return link;
}

export function requireSocial(ctx: Ctx): void {
  if (!ctx.caller.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
}
