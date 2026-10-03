import {
  ApiError,
  LIMITS,
  type CodeGrant,
  type CreateAdultFriendRequestRequest,
  type FriendRequestView,
  type FriendView,
} from '@app/api/contracts';
import {
  type Ctx,
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  friendshipBetween,
  profileOf,
  requireSocial,
  requireWritableOwner,
  toPublic,
} from '../authz';
import { friendCode } from '../codes';
import { guardedSocialWrite, resolveSocialCapability } from '../commercial/social-policy';
import {
  type CodeItem,
  type FriendItem,
  type FriendRequestItem,
  K,
  type LinkItem,
  type ProfileItem,
  getItem,
  queryPrefix,
} from '../db';
import {
  SK,
  canonicalFriendshipPair,
  createActiveAdultFriendship,
  type FriendshipItem,
} from '../social/model';
import { authorizeFriendRequest, type SocialPolicyPerson } from '../social/policy';
import {
  type TransactItem,
  absentConditionCheck,
  exactCodeOperation,
  exactLinkOperation,
  exactRequestOperation,
  getConsistent,
  guardedWrite,
  reserveCodeAttempt,
  sameLink,
  sameRequest,
} from './guarded-mutation';

const FRIEND_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function policyPerson(profile: ProfileItem): SocialPolicyPerson {
  return {
    accountId: profile.userId,
    accountType: profile.accountType,
    socialEnabled: profile.socialEnabled,
    status: profile.status ?? 'active',
    ...(profile.majorityAt ? { majorityAt: profile.majorityAt } : {}),
  };
}

function isExactProfile(profile: ProfileItem, expectedUserId: string): boolean {
  const expectedKey = K.profile(expectedUserId);
  return (
    profile.userId === expectedUserId &&
    profile.pk === expectedKey.pk &&
    profile.sk === expectedKey.sk
  );
}

function requireAdultCaller(ctx: Ctx): void {
  requireSocial(ctx);
  if (!isExactProfile(ctx.caller, ctx.callerId)) throw new ApiError('UNAUTHENTICATED');
  if (ctx.caller.accountType !== 'adult') throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  if (ctx.caller.status === 'closing') {
    throw new ApiError('CONFLICT', 'account closure is in progress');
  }
}

function requireAdultCodeTarget(
  ctx: Ctx,
  target: ProfileItem | null,
  expectedUserId: string,
): ProfileItem {
  // Code possession is not authority to inspect the target's account class.
  if (
    !target ||
    !isExactProfile(target, expectedUserId) ||
    target.accountType !== 'adult' ||
    !target.socialEnabled ||
    target.status === 'closing'
  ) {
    throw new ApiError('CODE_INVALID');
  }
  const decision = authorizeFriendRequest({
    actor: policyPerson(ctx.caller),
    target: policyPerson(target),
    action: 'create',
    now: ctx.deps.now(),
  });
  if (!decision.allowed) {
    if (decision.code === 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN') throw new ApiError('CODE_INVALID');
    throw new ApiError(decision.code);
  }
  return target;
}

function requireAdultRequestSender(
  ctx: Ctx,
  sender: ProfileItem | null,
  expectedUserId: string,
): ProfileItem {
  // Old incompatible requests remain removable, but cannot be accepted.
  if (!sender || !isExactProfile(sender, expectedUserId) || sender.accountType !== 'adult') {
    throw new ApiError('NOT_FOUND');
  }
  const decision = authorizeFriendRequest({
    actor: policyPerson(ctx.caller),
    target: policyPerson(sender),
    action: 'accept',
    now: ctx.deps.now(),
  });
  if (!decision.allowed) {
    if (decision.code === 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN') throw new ApiError('NOT_FOUND');
    throw new ApiError(decision.code);
  }
  return sender;
}

function adultSocialProfileGuard(ctx: Ctx, ownerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.profile(ownerId),
      ConditionExpression:
        `${WRITABLE_PROFILE_CONDITION} AND ` +
        '(#socialEnabled = :socialEnabled AND #accountType = :adult AND #userId = :ownerId)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#socialEnabled': 'socialEnabled',
        '#accountType': 'accountType',
        '#userId': 'userId',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':socialEnabled': true,
        ':adult': 'adult',
        ':ownerId': ownerId,
      },
    },
  };
}

function embeddedAdultProfiles(ownerIds: readonly string[]) {
  return Object.fromEntries(ownerIds.map((ownerId) => [ownerId, { profile: true as const }]));
}

async function mintAdultFriendCode(ctx: Ctx, previous: CodeItem | null): Promise<CodeGrant> {
  const previousCode = ctx.caller.friendCode;
  let code = friendCode();
  while (code === previousCode) code = friendCode();
  const expiresAt = ctx.deps.now() + FRIEND_CODE_TTL_MS;
  const grant = {
    ...K.codeF(code),
    code,
    kind: 'friend',
    userId: ctx.callerId,
    expiresAt,
    ttl: Math.ceil(expiresAt / 1000),
  } satisfies CodeItem & { pk: string; sk: string };
  const writes: TransactItem[] = [
    {
      Put: {
        TableName: ctx.deps.table,
        Item: grant,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Update: {
        TableName: ctx.deps.table,
        Key: K.profile(ctx.callerId),
        UpdateExpression: 'SET friendCode = :code',
        ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND (#socialEnabled = :socialEnabled AND #accountType = :adult AND #userId = :ownerId AND ${
          previousCode ? '#friendCode = :previousCode' : 'attribute_not_exists(#friendCode)'
        })`,
        ExpressionAttributeNames: {
          '#status': 'status',
          '#friendCode': 'friendCode',
          '#socialEnabled': 'socialEnabled',
          '#accountType': 'accountType',
          '#userId': 'userId',
        },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':socialEnabled': true,
          ':adult': 'adult',
          ':ownerId': ctx.callerId,
          ':code': code,
          ...(previousCode ? { ':previousCode': previousCode } : {}),
        },
      },
    },
    closureAbsenceConditionCheck(ctx.deps, ctx.callerId),
  ];
  if (previous) {
    const ownedGrant = previous.kind === 'friend' && previous.userId === ctx.callerId;
    writes.push(exactCodeOperation(ctx.deps, previous, ownedGrant ? 'delete' : 'check'));
  } else if (previousCode) {
    writes.push(absentConditionCheck(ctx.deps, K.codeF(previousCode)));
  }
  await guardedSocialWrite(ctx, 'create', [ctx.callerId], writes, undefined, {
    [ctx.callerId]: { profile: true, closure: true },
  });
  return { code, expiresAt };
}

/** Adult code surface retained for legacy clients until the v2 UI migrates. */
export async function getAdultFriendCode(ctx: Ctx): Promise<CodeGrant> {
  requireAdultCaller(ctx);
  let existing: CodeItem | null = null;
  if (ctx.caller.friendCode) {
    existing = await getItem<CodeItem>(ctx.deps, K.codeF(ctx.caller.friendCode));
    if (
      existing?.kind === 'friend' &&
      existing.userId === ctx.callerId &&
      existing.expiresAt > ctx.deps.now()
    ) {
      await resolveSocialCapability(ctx, 'create', [ctx.callerId]);
      const currentCaller = await requireWritableOwner(ctx, ctx.callerId);
      if (!isExactProfile(currentCaller, ctx.callerId)) throw new ApiError('UNAUTHENTICATED');
      if (currentCaller.accountType !== 'adult') throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
      if (!currentCaller.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
      if (currentCaller.friendCode !== existing.code) {
        throw new ApiError('CONFLICT', 'friend code changed; retry');
      }
      return { code: existing.code, expiresAt: existing.expiresAt };
    }
  }
  return mintAdultFriendCode(ctx, existing);
}

export async function rotateAdultFriendCode(ctx: Ctx): Promise<CodeGrant> {
  requireAdultCaller(ctx);
  const previous = ctx.caller.friendCode
    ? await getItem<CodeItem>(ctx.deps, K.codeF(ctx.caller.friendCode))
    : null;
  return mintAdultFriendCode(ctx, previous);
}

export async function createAdultFriendRequest(
  ctx: Ctx,
  body: CreateAdultFriendRequestRequest,
): Promise<FriendRequestView> {
  requireAdultCaller(ctx);
  const rawCode = (body as { code?: unknown } | null)?.code;
  if (typeof rawCode !== 'string') throw new ApiError('VALIDATION', 'code required');
  const code = rawCode.trim().toUpperCase().replace(/-/g, '');
  if (!code) throw new ApiError('VALIDATION', 'code required');

  // Transaction 0 reserves every bearer-code lookup, valid or invalid.
  await reserveCodeAttempt(ctx);

  const grant = await getItem<CodeItem>(ctx.deps, K.codeF(code));
  if (!grant || grant.kind !== 'friend') throw new ApiError('CODE_INVALID');
  if (grant.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');
  if (grant.userId === ctx.callerId) throw new ApiError('VALIDATION', 'that is your own code');

  const target = requireAdultCodeTarget(
    ctx,
    await profileOf(ctx.deps, grant.userId),
    grant.userId,
  );
  const pair = canonicalFriendshipPair(ctx.callerId, target.userId);
  const [legacyFriendship, canonicalFriendship] = await Promise.all([
    friendshipBetween(ctx.deps, ctx.callerId, target.userId),
    getItem<FriendshipItem>(ctx.deps, SK.friendship(pair.userA, pair.userB)),
  ]);
  if (legacyFriendship || canonicalFriendship) throw new ApiError('CONFLICT', 'already friends');

  const now = ctx.deps.now();
  if (grant.expiresAt <= now) throw new ApiError('CODE_EXPIRED');
  const reverseRequestId = `freq-${target.userId}~${ctx.callerId}`;
  const reverse = await getItem<FriendRequestItem>(ctx.deps, K.freq(ctx.callerId, reverseRequestId));
  if (reverse && reverse.expiresAt > now) throw new ApiError('CONFLICT', 'they already asked you');

  const myFriends = await queryPrefix<FriendItem>(ctx.deps, K.user(ctx.callerId), 'FRIEND#');
  if (myFriends.length >= LIMITS.maxFriends) throw new ApiError('LIMIT_EXCEEDED');

  const requestId = `freq-${ctx.callerId}~${target.userId}`;
  const item: FriendRequestItem = {
    ...K.freq(target.userId, requestId),
    gsi1pk: K.user(ctx.callerId),
    gsi1sk: `FREQ#${requestId}`,
    requestId,
    fromId: ctx.callerId,
    toId: target.userId,
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    ttl: Math.ceil((now + REQUEST_TTL_MS) / 1000),
  };
  const reverseGuard = reverse
    ? exactRequestOperation(ctx.deps, reverse, 'check')
    : absentConditionCheck(ctx.deps, K.freq(ctx.callerId, reverseRequestId));
  const participantIds = [ctx.callerId, target.userId];
  await guardedSocialWrite(
    ctx,
    'create',
    participantIds,
    [
      {
        Put: {
          TableName: ctx.deps.table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
          ExpressionAttributeValues: { ':now': now },
        },
      },
      exactCodeOperation(ctx.deps, grant, 'check', now),
      reverseGuard,
      absentConditionCheck(ctx.deps, K.friend(ctx.callerId, target.userId)),
      absentConditionCheck(ctx.deps, K.friend(target.userId, ctx.callerId)),
      absentConditionCheck(ctx.deps, SK.friendship(pair.userA, pair.userB)),
      ...participantIds.map((ownerId) => adultSocialProfileGuard(ctx, ownerId)),
    ],
    async () => {
      const [currentGrant, currentRequest, currentReverse, currentLegacy, currentCanonical] =
        await Promise.all([
          getConsistent<CodeItem>(ctx, K.codeF(code)),
          getConsistent<FriendRequestItem>(ctx, K.freq(target.userId, requestId)),
          getConsistent<FriendRequestItem>(ctx, K.freq(ctx.callerId, reverseRequestId)),
          getConsistent<FriendItem>(ctx, K.friend(ctx.callerId, target.userId)),
          getConsistent<FriendshipItem>(ctx, SK.friendship(pair.userA, pair.userB)),
        ]);
      if (!currentGrant || currentGrant.kind !== 'friend' || currentGrant.userId !== target.userId) {
        throw new ApiError('CODE_INVALID');
      }
      if (currentGrant.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');
      if (currentRequest && currentRequest.expiresAt > ctx.deps.now()) {
        throw new ApiError('CONFLICT', 'request already pending');
      }
      if (currentReverse && currentReverse.expiresAt > ctx.deps.now()) {
        throw new ApiError('CONFLICT', 'they already asked you');
      }
      if (currentLegacy || currentCanonical) throw new ApiError('CONFLICT', 'already friends');
    },
    embeddedAdultProfiles(participantIds),
  );
  return { requestId, user: toPublic(target, false), createdAt: now, expiresAt: item.expiresAt };
}

function isExactRequest(item: FriendRequestItem, expectedRequestId: string): boolean {
  try {
    canonicalFriendshipPair(item.fromId, item.toId);
  } catch {
    return false;
  }
  return (
    item.requestId === expectedRequestId &&
    item.requestId === `freq-${item.fromId}~${item.toId}` &&
    item.pk === K.user(item.toId) &&
    item.sk === `FREQ#${item.requestId}` &&
    item.gsi1pk === K.user(item.fromId) &&
    item.gsi1sk === `FREQ#${item.requestId}`
  );
}

async function findIncoming(ctx: Ctx, requestId: string): Promise<FriendRequestItem> {
  const item = await getItem<FriendRequestItem>(ctx.deps, K.freq(ctx.callerId, requestId));
  if (
    !item ||
    !isExactRequest(item, requestId) ||
    item.toId !== ctx.callerId ||
    item.expiresAt <= ctx.deps.now()
  ) {
    throw new ApiError('NOT_FOUND');
  }
  return item;
}

export async function acceptAdultFriendRequest(ctx: Ctx, requestId: string): Promise<FriendView> {
  requireAdultCaller(ctx);
  const request = await findIncoming(ctx, requestId);
  const sender = requireAdultRequestSender(
    ctx,
    await profileOf(ctx.deps, request.fromId),
    request.fromId,
  );

  const [mine, theirs] = await Promise.all([
    queryPrefix<FriendItem>(ctx.deps, K.user(ctx.callerId), 'FRIEND#'),
    queryPrefix<FriendItem>(ctx.deps, K.user(sender.userId), 'FRIEND#'),
  ]);
  if (mine.length >= LIMITS.maxFriends || theirs.length >= LIMITS.maxFriends) {
    throw new ApiError('LIMIT_EXCEEDED');
  }

  const now = ctx.deps.now();
  if (request.expiresAt <= now) throw new ApiError('NOT_FOUND');
  const canonical = createActiveAdultFriendship({
    leftAccountId: ctx.callerId,
    rightAccountId: sender.userId,
    now,
  });
  const mirror = (me: string, otherId: string): FriendItem => ({
    ...K.friend(me, otherId),
    friendshipId: canonical.friendshipId,
    userA: canonical.userA,
    userB: canonical.userB,
    createdAt: canonical.createdAt,
  });
  const participantIds = [ctx.callerId, sender.userId];
  await guardedSocialWrite(
    ctx,
    'accept',
    participantIds,
    [
      {
        Put: {
          TableName: ctx.deps.table,
          Item: canonical,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: mirror(ctx.callerId, sender.userId),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: mirror(sender.userId, ctx.callerId),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      exactRequestOperation(ctx.deps, request, 'delete', now),
      ...participantIds.map((ownerId) => adultSocialProfileGuard(ctx, ownerId)),
    ],
    async () => {
      const [currentRequest, currentCanonical, currentLegacy] = await Promise.all([
        getConsistent<FriendRequestItem>(ctx, K.freq(ctx.callerId, requestId)),
        getConsistent<FriendshipItem>(ctx, SK.friendship(ctx.callerId, sender.userId)),
        getConsistent<FriendItem>(ctx, K.friend(ctx.callerId, sender.userId)),
      ]);
      if (
        !currentRequest ||
        !isExactRequest(currentRequest, requestId) ||
        currentRequest.expiresAt <= ctx.deps.now()
      ) {
        throw new ApiError('NOT_FOUND');
      }
      if (currentCanonical || currentLegacy) throw new ApiError('CONFLICT', 'already friends');
      if (!sameRequest(currentRequest, request)) return;
    },
    embeddedAdultProfiles(participantIds),
  );
  return {
    friendshipId: canonical.friendshipId,
    user: toPublic(sender, false),
    since: canonical.createdAt,
  };
}

/** Silent cleanup remains available for incompatible legacy requests. */
export async function declineSocialFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  const request = await findIncoming(ctx, requestId);
  await guardedWrite(
    ctx,
    [ctx.callerId, request.fromId],
    [exactRequestOperation(ctx.deps, request, 'delete')],
    async () => {
      const current = await getConsistent<FriendRequestItem>(ctx, K.freq(ctx.callerId, requestId));
      if (!current || !isExactRequest(current, requestId) || current.expiresAt <= ctx.deps.now()) {
        throw new ApiError('NOT_FOUND');
      }
      if (!sameRequest(current, request)) return;
    },
  );
}

export async function cancelSocialFriendRequest(ctx: Ctx, requestId: string): Promise<void> {
  const mine = await queryPrefix<FriendRequestItem>(ctx.deps, K.user(ctx.callerId), 'FREQ#', {
    index: 'gsi1',
  });
  const item = mine.find(
    (candidate) =>
      candidate.requestId === requestId &&
      candidate.fromId === ctx.callerId &&
      isExactRequest(candidate, requestId),
  );
  if (!item) throw new ApiError('NOT_FOUND');
  await guardedWrite(
    ctx,
    [ctx.callerId, item.toId],
    [exactRequestOperation(ctx.deps, item, 'delete')],
    async () => {
      const current = await getConsistent<FriendRequestItem>(ctx, K.freq(item.toId, requestId));
      if (!current || !isExactRequest(current, requestId) || current.expiresAt <= ctx.deps.now()) {
        throw new ApiError('NOT_FOUND');
      }
      if (!sameRequest(current, item)) return;
    },
  );
}

function parseExactFriendshipId(friendshipId: string): { a: string; b: string } | null {
  const pieces = friendshipId.split('~');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
  try {
    const pair = canonicalFriendshipPair(pieces[0], pieces[1]);
    return pair.friendshipId === friendshipId ? { a: pair.userA, b: pair.userB } : null;
  } catch {
    return null;
  }
}

export async function removeSocialFriendship(ctx: Ctx, friendshipId: string): Promise<void> {
  if (!isExactProfile(ctx.caller, ctx.callerId)) throw new ApiError('UNAUTHENTICATED');
  if (ctx.caller.accountType !== 'adult') throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  await removeSocialFriendshipAs(ctx, ctx.callerId, friendshipId);
}

/** Shared with guardian cleanup; authorizationLink must cover a participant. */
export async function removeSocialFriendshipAs(
  ctx: Ctx,
  asUserId: string,
  friendshipId: string,
  authorizationLink?: LinkItem,
): Promise<void> {
  const pair = parseExactFriendshipId(friendshipId);
  if (!pair || (pair.a !== asUserId && pair.b !== asUserId)) throw new ApiError('NOT_FOUND');
  if (authorizationLink) {
    const expectedLinkKey = K.link(asUserId, ctx.callerId);
    if (
      authorizationLink.guardianId !== ctx.callerId ||
      authorizationLink.minorId !== asUserId ||
      authorizationLink.pk !== expectedLinkKey.pk ||
      authorizationLink.sk !== expectedLinkKey.sk ||
      authorizationLink.gsi1pk !== K.user(ctx.callerId) ||
      authorizationLink.gsi1sk !== `MINOR#${asUserId}` ||
      authorizationLink.linkId !== `${ctx.callerId}~${asUserId}`
    ) {
      throw new ApiError('NOT_FOUND');
    }
  } else if (ctx.callerId !== asUserId) {
    throw new ApiError('NOT_FOUND');
  }
  const owners = [ctx.callerId, pair.a, pair.b];
  await guardedWrite(
    ctx,
    owners,
    [
      { Delete: { TableName: ctx.deps.table, Key: SK.friendship(pair.a, pair.b) } },
      { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.a, pair.b) } },
      { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.b, pair.a) } },
      ...(authorizationLink ? [exactLinkOperation(ctx.deps, authorizationLink, 'check')] : []),
    ],
    authorizationLink
      ? async () => {
          const current = await getConsistent<LinkItem>(ctx, {
            pk: authorizationLink.pk,
            sk: authorizationLink.sk,
          });
          if (!current) throw new ApiError('NOT_FOUND');
          if (!sameLink(current, authorizationLink)) return;
        }
      : undefined,
  );
}

export {
  createMinorFriendRequest,
  getMinorFriendRequests,
  mintMinorInviteCode,
  recordMinorAcceptance,
  recordResponsibleApproval,
  rejectMinorFriendRequest,
  revokeMinorFriendship,
} from './minor-social';
