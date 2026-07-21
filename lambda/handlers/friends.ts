import {
  ApiError,
  ApiErrorCode,
  CodeGrant,
  FriendRequestView,
  FriendView,
  FriendsResponse,
  LIMITS,
} from '@app/api/contracts';
import { Ctx, friendshipBetween, profileOf, requireSocial, toPublic } from '../authz';
import {
  CodeItem,
  Deps,
  FriendItem,
  FriendRequestItem,
  K,
  ProfileItem,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  bumpBadAttempt,
  composite,
  deleteItem,
  getItem,
  putItem,
  queryPrefix,
  readRateCount,
} from '../db';
import { friendCode } from '../codes';

const FRIEND_CODE_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_TTL_MS = 14 * 24 * 3600 * 1000;

async function requestView(deps: Deps, item: FriendRequestItem, otherId: string): Promise<FriendRequestView | null> {
  const other = await profileOf(deps, otherId);
  if (!other) return null;
  return {
    requestId: item.requestId,
    user: toPublic(other, false),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export async function getFriends(ctx: Ctx): Promise<FriendsResponse> {
  requireSocial(ctx);
  return friendsOf(ctx, ctx.callerId);
}

/** Shared with guardian oversight (family.listChildFriends). */
export async function friendsOf(ctx: Ctx, userId: string): Promise<FriendsResponse> {
  const now = ctx.deps.now();
  const [friendItems, incomingItems, outgoingItems] = await Promise.all([
    queryPrefix<FriendItem>(ctx.deps, K.user(userId), 'FRIEND#'),
    queryPrefix<FriendRequestItem>(ctx.deps, K.user(userId), 'FREQ#'),
    queryPrefix<FriendRequestItem>(ctx.deps, K.user(userId), 'FREQ#', { index: 'gsi1' }),
  ]);

  const friends: FriendView[] = [];
  for (const item of friendItems) {
    const otherId = item.userA === userId ? item.userB : item.userA;
    const other = await profileOf(ctx.deps, otherId);
    if (!other) continue;
    friends.push({ friendshipId: item.friendshipId, user: toPublic(other, false), since: item.createdAt });
  }
  const incoming: FriendRequestView[] = [];
  for (const item of incomingItems.filter((i) => i.expiresAt > now)) {
    const view = await requestView(ctx.deps, item, item.fromId);
    if (view) incoming.push(view);
  }
  const outgoing: FriendRequestView[] = [];
  for (const item of outgoingItems.filter((i) => i.expiresAt > now)) {
    const view = await requestView(ctx.deps, item, item.toId);
    if (view) outgoing.push(view);
  }
  return { friends, incoming, outgoing };
}

async function mintFriendCode(ctx: Ctx): Promise<CodeGrant> {
  const code = friendCode();
  const expiresAt = ctx.deps.now() + FRIEND_CODE_TTL_MS;
  await putItem(ctx.deps, {
    ...K.codeF(code),
    code,
    kind: 'friend',
    userId: ctx.callerId,
    expiresAt,
    ttl: Math.ceil(expiresAt / 1000),
  } satisfies CodeItem & { pk: string; sk: string });
  await ctx.deps.ddb.send(
    new UpdateCommand({
      TableName: ctx.deps.table,
      Key: K.profile(ctx.callerId),
      UpdateExpression: 'SET friendCode = :c',
      ExpressionAttributeValues: { ':c': code },
    }),
  );
  return { code, expiresAt };
}

export async function getFriendCode(ctx: Ctx): Promise<CodeGrant> {
  requireSocial(ctx);
  if (ctx.caller.friendCode) {
    const existing = await getItem<CodeItem>(ctx.deps, K.codeF(ctx.caller.friendCode));
    if (existing && existing.expiresAt > ctx.deps.now()) {
      return { code: existing.code, expiresAt: existing.expiresAt };
    }
  }
  return mintFriendCode(ctx);
}

export async function rotateFriendCode(ctx: Ctx): Promise<CodeGrant> {
  requireSocial(ctx);
  if (ctx.caller.friendCode) await deleteItem(ctx.deps, K.codeF(ctx.caller.friendCode));
  return mintFriendCode(ctx);
}

// The code-guessing brake moved to db.ts (0.0.115) — family invites share it.

export async function createFriendRequest(ctx: Ctx, body: { code?: string }): Promise<FriendRequestView> {
  requireSocial(ctx);
  const code = body.code?.trim().toUpperCase().replace(/-/g, '');
  if (!code) throw new ApiError('VALIDATION', 'code required');

  if ((await readRateCount(ctx.deps, ctx.callerId)) >= LIMITS.codeAttemptsPerHour) throw new ApiError('RATE_LIMITED');
  const badAttempt = async (errorCode: ApiErrorCode, message?: string): Promise<never> => {
    await bumpBadAttempt(ctx.deps, ctx.callerId);
    throw new ApiError(errorCode, message);
  };

  const grant = await getItem<CodeItem>(ctx.deps, K.codeF(code));
  if (!grant || grant.kind !== 'friend') return badAttempt('CODE_INVALID');
  if (grant.expiresAt <= ctx.deps.now()) return badAttempt('CODE_EXPIRED');
  if (grant.userId === ctx.callerId) throw new ApiError('VALIDATION', 'that is your own code');

  const target = await profileOf(ctx.deps, grant.userId);
  if (!target || !target.socialEnabled) return badAttempt('CODE_INVALID');
  if (await friendshipBetween(ctx.deps, ctx.callerId, grant.userId)) {
    throw new ApiError('CONFLICT', 'already friends');
  }
  const now = ctx.deps.now();
  const reverseRequestId = `freq-${grant.userId}~${ctx.callerId}`;
  const reverse = await getItem<FriendRequestItem>(ctx.deps, K.freq(ctx.callerId, reverseRequestId));
  if (reverse && reverse.expiresAt > now) {
    throw new ApiError('CONFLICT', 'they already asked you');
  }
  const myFriends = await queryPrefix<FriendItem>(ctx.deps, K.user(ctx.callerId), 'FRIEND#');
  if (myFriends.length >= LIMITS.maxFriends) throw new ApiError('LIMIT_EXCEEDED');

  // Deterministic per direction: a double-submit (or a race across devices)
  // maps to the SAME item, and the conditional put turns the duplicate into
  // CONFLICT — no TOCTOU window. Expired leftovers may be overwritten.
  const requestId = `freq-${ctx.callerId}~${grant.userId}`;
  const item: FriendRequestItem = {
    ...K.freq(grant.userId, requestId),
    gsi1pk: K.user(ctx.callerId),
    gsi1sk: `FREQ#${requestId}`,
    requestId,
    fromId: ctx.callerId,
    toId: grant.userId,
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    ttl: Math.ceil((now + REQUEST_TTL_MS) / 1000),
  };
  try {
    await ctx.deps.ddb.send(
      new PutCommand({
        TableName: ctx.deps.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': now },
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
    throw new ApiError('CONFLICT', 'request already pending');
  }
  return { requestId, user: toPublic(target, false), createdAt: now, expiresAt: item.expiresAt };
}

async function findIncoming(ctx: Ctx, requestId: string): Promise<FriendRequestItem> {
  const item = await getItem<FriendRequestItem>(ctx.deps, K.freq(ctx.callerId, requestId));
  if (!item || item.expiresAt <= ctx.deps.now()) throw new ApiError('NOT_FOUND');
  return item;
}

export async function acceptFriendRequest(ctx: Ctx, requestId: string): Promise<FriendView> {
  requireSocial(ctx);
  const request = await findIncoming(ctx, requestId);
  const other = await profileOf(ctx.deps, request.fromId);
  if (!other) throw new ApiError('NOT_FOUND');

  // The cap holds on BOTH ends at accept time too — requests sit for days,
  // and either side may have filled up since the request was sent.
  const [mine, theirs] = await Promise.all([
    queryPrefix<FriendItem>(ctx.deps, K.user(ctx.callerId), 'FRIEND#'),
    queryPrefix<FriendItem>(ctx.deps, K.user(request.fromId), 'FRIEND#'),
  ]);
  if (mine.length >= LIMITS.maxFriends || theirs.length >= LIMITS.maxFriends) {
    throw new ApiError('LIMIT_EXCEEDED');
  }

  const friendshipId = composite.friendshipId(ctx.callerId, request.fromId);
  const now = ctx.deps.now();
  const mirror = (me: string, otherId: string): FriendItem => ({
    ...K.friend(me, otherId),
    friendshipId,
    userA: friendshipId.split('~')[0],
    userB: friendshipId.split('~')[1],
    createdAt: now,
  });
  await ctx.deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: ctx.deps.table, Item: mirror(ctx.callerId, request.fromId) } },
        { Put: { TableName: ctx.deps.table, Item: mirror(request.fromId, ctx.callerId) } },
        { Delete: { TableName: ctx.deps.table, Key: K.freq(ctx.callerId, requestId) } },
      ],
    }),
  );
  return { friendshipId, user: toPublic(other, false), since: now };
}

/** Silent by design — the requester's pending item simply disappears. */
export async function declineFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  requireSocial(ctx);
  await findIncoming(ctx, requestId);
  await deleteItem(ctx.deps, K.freq(ctx.callerId, requestId));
}

export async function cancelFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  requireSocial(ctx);
  const mine = await queryPrefix<FriendRequestItem>(ctx.deps, K.user(ctx.callerId), 'FREQ#', {
    index: 'gsi1',
  });
  const item = mine.find((r) => r.requestId === requestId);
  if (!item) throw new ApiError('NOT_FOUND');
  await deleteItem(ctx.deps, K.freq(item.toId, requestId));
}

export async function removeFriend(ctx: Ctx, friendshipId: string): Promise<void> {
  requireSocial(ctx);
  await removeFriendshipAs(ctx, ctx.callerId, friendshipId);
}

/** Shared with guardian oversight — `asUserId` must be one side of the edge. */
export async function removeFriendshipAs(ctx: Ctx, asUserId: string, friendshipId: string): Promise<void> {
  const pair = composite.parseFriendshipId(friendshipId);
  if (!pair || (pair.a !== asUserId && pair.b !== asUserId)) throw new ApiError('NOT_FOUND');
  await ctx.deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.a, pair.b) } },
        { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.b, pair.a) } },
      ],
    }),
  );
}
