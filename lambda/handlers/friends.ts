import type { CodeGrant, FriendRequestView, FriendView, FriendsResponse } from '@app/api/contracts';
import { ApiError } from '@app/api/contracts';
import { type Ctx, profileOfConsistent, toPublic } from '../authz';
import { type FriendItem, type FriendRequestItem, K, type LinkItem, queryPrefix } from '../db';
import {
  acceptAdultFriendRequest,
  cancelSocialFriendRequest,
  createAdultFriendRequest,
  declineSocialFriendRequest,
  getAdultFriendCode,
  removeSocialFriendshipAs,
  rotateAdultFriendCode,
} from './social';

async function requestView(
  ctx: Ctx,
  item: FriendRequestItem,
  otherId: string,
): Promise<FriendRequestView | null> {
  const other = await profileOfConsistent(ctx.deps, otherId);
  if (!other || other.privacyMode) return null;
  return {
    requestId: item.requestId,
    user: toPublic(other, false),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export async function getFriends(ctx: Ctx): Promise<FriendsResponse> {
  return friendsOf(ctx, ctx.callerId);
}

/** Legacy listing stays readable so incompatible relationships can be removed. */
export async function friendsOf(ctx: Ctx, userId: string): Promise<FriendsResponse> {
  const profiles = await Promise.all(
    [...new Set([ctx.callerId, userId])].map((id) => profileOfConsistent(ctx.deps, id)),
  );
  if (profiles.some((profile) => profile?.privacyMode)) throw new ApiError('FORBIDDEN');
  const now = ctx.deps.now();
  const [friendItems, incomingItems, outgoingItems] = await Promise.all([
    queryPrefix<FriendItem>(ctx.deps, K.user(userId), 'FRIEND#'),
    queryPrefix<FriendRequestItem>(ctx.deps, K.user(userId), 'FREQ#'),
    queryPrefix<FriendRequestItem>(ctx.deps, K.user(userId), 'FREQ#', { index: 'gsi1' }),
  ]);

  const friends: FriendView[] = [];
  for (const item of friendItems) {
    const otherId = item.userA === userId ? item.userB : item.userA;
    const other = await profileOfConsistent(ctx.deps, otherId);
    if (!other || other.privacyMode) continue;
    friends.push({
      friendshipId: item.friendshipId,
      user: toPublic(other, false),
      since: item.createdAt,
    });
  }
  const incoming: FriendRequestView[] = [];
  for (const item of incomingItems.filter((candidate) => candidate.expiresAt > now)) {
    const view = await requestView(ctx, item, item.fromId);
    if (view) incoming.push(view);
  }
  const outgoing: FriendRequestView[] = [];
  for (const item of outgoingItems.filter((candidate) => candidate.expiresAt > now)) {
    const view = await requestView(ctx, item, item.toId);
    if (view) outgoing.push(view);
  }
  return { friends, incoming, outgoing };
}

// Legacy mutations are adapters. Adult accounts use the v2 adult path;
// incompatible historical state is limited to reading and cleanup.
export async function getFriendCode(ctx: Ctx): Promise<CodeGrant> {
  return getAdultFriendCode(ctx);
}

export async function rotateFriendCode(ctx: Ctx): Promise<CodeGrant> {
  return rotateAdultFriendCode(ctx);
}

export async function createFriendRequest(
  ctx: Ctx,
  body: { code?: string },
): Promise<FriendRequestView> {
  return createAdultFriendRequest(ctx, { code: body?.code ?? '' });
}

export async function acceptFriendRequest(ctx: Ctx, requestId: string): Promise<FriendView> {
  return acceptAdultFriendRequest(ctx, requestId);
}

export async function declineFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  return declineSocialFriendRequest(ctx, requestId);
}

export async function cancelFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  return cancelSocialFriendRequest(ctx, requestId);
}

export async function removeFriend(ctx: Ctx, friendshipId: string): Promise<void> {
  return removeSocialFriendshipAs(ctx, ctx.callerId, friendshipId);
}

/** Shared with guardian oversight; `asUserId` must be one side of the edge. */
export async function removeFriendshipAs(
  ctx: Ctx,
  asUserId: string,
  friendshipId: string,
  authorizationLink?: LinkItem,
): Promise<void> {
  return removeSocialFriendshipAs(ctx, asUserId, friendshipId, authorizationLink);
}
