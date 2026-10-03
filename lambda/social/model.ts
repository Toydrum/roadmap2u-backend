import {
  CONSENT_KINDS,
  type ConsentKind,
  type FriendshipClass,
  type MinorFriendRequestState,
} from '@app/api/contracts';

const SOCIAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const MINOR_INVITE_CODE_PATTERN = /^[2346790CDFGHJKMNPQRTVWXZ]{8}$/;

export type FriendshipSide = 'A' | 'B';
export const MINOR_SOCIAL_POLICY_VERSION = 'minor-social-v1' as const;
export const MINOR_FRIEND_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const MINOR_FRIEND_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface CanonicalFriendshipPair {
  readonly friendshipId: string;
  readonly userA: string;
  readonly userB: string;
}

export interface FriendshipItem {
  readonly pk: string;
  readonly sk: 'META';
  readonly entityType: 'Friendship';
  readonly friendshipId: string;
  readonly userA: string;
  readonly userB: string;
  readonly friendshipClass: FriendshipClass;
  readonly state: MinorFriendRequestState;
  readonly requestId: string | null;
  readonly requestCycleId: string | null;
  readonly requesterId: string | null;
  readonly recipientId: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly activatedAt: number | null;
  readonly endedAt: number | null;
}

export interface MinorFriendInviteCodeItem {
  readonly pk: string;
  readonly sk: 'CODE';
  readonly entityType: 'MinorFriendInviteCode';
  readonly kind: 'minor_friend';
  readonly code: string;
  readonly minorId: string;
  readonly issuedById: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly ttl: number;
}

export interface ConsentItem {
  readonly pk: string;
  readonly sk: `CONSENT#${FriendshipSide}#${ConsentKind}`;
  readonly entityType: 'Consent';
  readonly friendshipId: string;
  readonly requestId: string;
  readonly requestCycleId: string;
  readonly side: FriendshipSide;
  readonly kind: ConsentKind;
  readonly actorId: string;
  readonly subjectMinorId: string;
  readonly policyVersion: typeof MINOR_SOCIAL_POLICY_VERSION;
  readonly revision: number;
  readonly recordedAt: number;
}

function assertSocialIdentifier(value: string, label: string): void {
  if (!SOCIAL_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-empty opaque identifier`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative epoch timestamp`);
  }
}

function parseCanonicalFriendshipId(friendshipId: string): CanonicalFriendshipPair {
  const separator = friendshipId.indexOf('~');
  if (separator <= 0 || separator !== friendshipId.lastIndexOf('~')) {
    throw new TypeError('friendshipId must be a canonical account pair');
  }
  const userA = friendshipId.slice(0, separator);
  const userB = friendshipId.slice(separator + 1);
  const pair = canonicalFriendshipPair(userA, userB);
  if (pair.friendshipId !== friendshipId) {
    throw new TypeError('friendshipId must be a canonical account pair');
  }
  return pair;
}

export function canonicalFriendshipPair(
  leftAccountId: string,
  rightAccountId: string,
): CanonicalFriendshipPair {
  assertSocialIdentifier(leftAccountId, 'leftAccountId');
  assertSocialIdentifier(rightAccountId, 'rightAccountId');
  if (leftAccountId === rightAccountId) {
    throw new RangeError('friendship requires two distinct accounts');
  }
  const [userA, userB] =
    leftAccountId < rightAccountId
      ? [leftAccountId, rightAccountId]
      : [rightAccountId, leftAccountId];
  return { friendshipId: `${userA}~${userB}`, userA, userB };
}

export function friendshipSide(friendshipId: string, accountId: string): FriendshipSide {
  assertSocialIdentifier(accountId, 'accountId');
  const pair = parseCanonicalFriendshipId(friendshipId);
  if (accountId === pair.userA) return 'A';
  if (accountId === pair.userB) return 'B';
  throw new RangeError('accountId is not part of friendshipId');
}

function assertConsentKind(kind: string): asserts kind is ConsentKind {
  if (!(CONSENT_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError('kind must be a supported minor friendship consent');
  }
}

/** Canonical keys for the social-v2 single-table records. */
export const SK = Object.freeze({
  friendship: (leftAccountId: string, rightAccountId: string) => {
    const pair = canonicalFriendshipPair(leftAccountId, rightAccountId);
    return { pk: `FRIENDSHIP#${pair.friendshipId}`, sk: 'META' as const };
  },
  consent: (
    leftAccountId: string,
    rightAccountId: string,
    subjectAccountId: string,
    kind: ConsentKind,
  ) => {
    const pair = canonicalFriendshipPair(leftAccountId, rightAccountId);
    assertConsentKind(kind);
    const side = friendshipSide(pair.friendshipId, subjectAccountId);
    return {
      pk: `FRIENDSHIP#${pair.friendshipId}`,
      sk: `CONSENT#${side}#${kind}` as const,
    };
  },
  minorInviteCode: (code: string) => {
    if (!MINOR_INVITE_CODE_PATTERN.test(code)) {
      throw new TypeError('minor friendship code must be an uppercase opaque code');
    }
    return { pk: `CODE#MF#${code}`, sk: 'CODE' as const };
  },
});

/** Starts a minor-minor request without granting friendship authority. */
export function createPendingMinorFriendship(input: {
  readonly requesterId: string;
  readonly recipientId: string;
  readonly requestCycleId: string;
  readonly now: number;
  readonly expiresAt: number;
}): FriendshipItem {
  const pair = canonicalFriendshipPair(input.requesterId, input.recipientId);
  assertSocialIdentifier(input.requestCycleId, 'requestCycleId');
  assertTimestamp(input.now, 'now');
  assertTimestamp(input.expiresAt, 'expiresAt');
  if (
    input.expiresAt <= input.now ||
    input.expiresAt - input.now > MINOR_FRIEND_REQUEST_TTL_MS
  ) {
    throw new RangeError('minor friendship request expiry is outside the allowed window');
  }
  return {
    ...SK.friendship(pair.userA, pair.userB),
    entityType: 'Friendship',
    ...pair,
    friendshipClass: 'minor_minor',
    state: 'pending',
    requestId: `minor-friend:${pair.friendshipId}`,
    requestCycleId: input.requestCycleId,
    requesterId: input.requesterId,
    recipientId: input.recipientId,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.expiresAt,
    activatedAt: null,
    endedAt: null,
  };
}

/** Creates an adult-only direct edge after both profiles passed social policy. */
export function createActiveAdultFriendship(input: {
  readonly leftAccountId: string;
  readonly rightAccountId: string;
  readonly now: number;
}): FriendshipItem {
  const pair = canonicalFriendshipPair(input.leftAccountId, input.rightAccountId);
  assertTimestamp(input.now, 'now');
  return {
    ...SK.friendship(pair.userA, pair.userB),
    entityType: 'Friendship',
    ...pair,
    friendshipClass: 'adult_adult',
    state: 'active',
    requestId: null,
    requestCycleId: null,
    requesterId: null,
    recipientId: null,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: null,
    activatedAt: input.now,
    endedAt: null,
  };
}

/** Materializes a short-lived code whose row presence is its one-use authority. */
export function createMinorFriendInviteCode(input: {
  readonly code: string;
  readonly minorId: string;
  readonly issuedById: string;
  readonly now: number;
  readonly expiresAt: number;
}): MinorFriendInviteCodeItem {
  const key = SK.minorInviteCode(input.code);
  assertSocialIdentifier(input.minorId, 'minorId');
  assertSocialIdentifier(input.issuedById, 'issuedById');
  assertTimestamp(input.now, 'now');
  assertTimestamp(input.expiresAt, 'expiresAt');
  if (
    input.expiresAt <= input.now ||
    input.expiresAt - input.now > MINOR_FRIEND_INVITE_TTL_MS
  ) {
    throw new RangeError('minor friendship code expiry is outside the allowed window');
  }
  return {
    ...key,
    entityType: 'MinorFriendInviteCode',
    kind: 'minor_friend',
    code: input.code,
    minorId: input.minorId,
    issuedById: input.issuedById,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    ttl: Math.floor(input.expiresAt / 1000),
  };
}

function expectedConsentSubject(
  friendship: FriendshipItem,
  kind: ConsentKind,
): string {
  const requesterSide =
    kind === 'requester_action' || kind === 'requester_responsible_approval';
  const subjectMinorId = requesterSide
    ? friendship.requesterId
    : friendship.recipientId;
  if (!subjectMinorId) {
    throw new TypeError('minor friendship request is missing a participant');
  }
  return subjectMinorId;
}

export function createMinorFriendConsent(input: {
  readonly friendship: FriendshipItem;
  readonly kind: ConsentKind;
  readonly actorId: string;
  readonly subjectMinorId: string;
  readonly policyVersion: string;
  readonly now: number;
}): ConsentItem {
  const friendship = input.friendship;
  assertConsentKind(input.kind);
  assertSocialIdentifier(input.actorId, 'actorId');
  assertSocialIdentifier(input.subjectMinorId, 'subjectMinorId');
  assertTimestamp(input.now, 'now');
  const pair = canonicalFriendshipPair(friendship.userA, friendship.userB);
  const expectedKey = SK.friendship(pair.userA, pair.userB);
  if (friendship.requestId !== `minor-friend:${pair.friendshipId}`) {
    throw new RangeError('consent requires the canonical request id');
  }
  if (
    friendship.entityType !== 'Friendship' ||
    friendship.pk !== expectedKey.pk ||
    friendship.sk !== expectedKey.sk ||
    friendship.friendshipId !== pair.friendshipId ||
    friendship.friendshipClass !== 'minor_minor' ||
    friendship.state !== 'pending' ||
    !friendship.requestId ||
    !friendship.requestCycleId ||
    friendship.expiresAt === null ||
    friendship.expiresAt <= input.now
  ) {
    throw new TypeError('consent requires a current pending minor friendship request');
  }
  if (input.now < friendship.createdAt) {
    throw new RangeError('consent timestamp is outside the request window');
  }
  const expectedSubjectMinorId = expectedConsentSubject(friendship, input.kind);
  if (input.subjectMinorId !== expectedSubjectMinorId) {
    throw new RangeError('consent subject does not match the request side');
  }
  const isMinorAction =
    input.kind === 'requester_action' || input.kind === 'recipient_acceptance';
  if (
    (isMinorAction && input.actorId !== input.subjectMinorId) ||
    (!isMinorAction && input.actorId === input.subjectMinorId)
  ) {
    throw new RangeError('consent actor does not match the consent kind');
  }
  if (input.policyVersion !== MINOR_SOCIAL_POLICY_VERSION) {
    throw new RangeError('minor friendship consent policy version is not current');
  }
  const side = friendshipSide(friendship.friendshipId, input.subjectMinorId);
  return {
    ...SK.consent(pair.userA, pair.userB, input.subjectMinorId, input.kind),
    entityType: 'Consent',
    friendshipId: friendship.friendshipId,
    requestId: friendship.requestId,
    requestCycleId: friendship.requestCycleId,
    side,
    kind: input.kind,
    actorId: input.actorId,
    subjectMinorId: input.subjectMinorId,
    policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    revision: 1,
    recordedAt: input.now,
  };
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Checks the four persisted pieces of evidence for one live request cycle.
 * This is deliberately structural: callers must still revalidate both account
 * types and each responsible adult's current supervision scope atomically.
 */
export function hasFourCurrentMinorFriendConsents(
  friendship: FriendshipItem,
  consents: readonly ConsentItem[],
  now: number,
): boolean {
  if (!isTimestamp(now) || consents.length !== CONSENT_KINDS.length) return false;
  try {
    const pair = canonicalFriendshipPair(friendship.userA, friendship.userB);
    const key = SK.friendship(pair.userA, pair.userB);
    if (
      friendship.entityType !== 'Friendship' ||
      friendship.pk !== key.pk ||
      friendship.sk !== key.sk ||
      friendship.friendshipId !== pair.friendshipId ||
      friendship.friendshipClass !== 'minor_minor' ||
      friendship.state !== 'pending' ||
      friendship.requestId !== `minor-friend:${pair.friendshipId}` ||
      !friendship.requestCycleId ||
      !friendship.requesterId ||
      !friendship.recipientId ||
      ![pair.userA, pair.userB].includes(friendship.requesterId) ||
      ![pair.userA, pair.userB].includes(friendship.recipientId) ||
      friendship.requesterId === friendship.recipientId ||
      !isTimestamp(friendship.createdAt) ||
      !isTimestamp(friendship.expiresAt) ||
      friendship.expiresAt <= now
    ) {
      return false;
    }
    assertSocialIdentifier(friendship.requestCycleId, 'requestCycleId');

    const observedKinds = new Set<ConsentKind>();
    for (const consent of consents) {
      assertConsentKind(consent.kind);
      assertSocialIdentifier(consent.actorId, 'consent.actorId');
      const expectedSubjectMinorId = expectedConsentSubject(friendship, consent.kind);
      const side = friendshipSide(friendship.friendshipId, expectedSubjectMinorId);
      const consentKey = SK.consent(
        pair.userA,
        pair.userB,
        expectedSubjectMinorId,
        consent.kind,
      );
      const isMinorAction =
        consent.kind === 'requester_action' || consent.kind === 'recipient_acceptance';
      if (
        observedKinds.has(consent.kind) ||
        consent.entityType !== 'Consent' ||
        consent.pk !== consentKey.pk ||
        consent.sk !== consentKey.sk ||
        consent.friendshipId !== friendship.friendshipId ||
        consent.requestId !== friendship.requestId ||
        consent.requestCycleId !== friendship.requestCycleId ||
        consent.side !== side ||
        consent.subjectMinorId !== expectedSubjectMinorId ||
        consent.policyVersion !== MINOR_SOCIAL_POLICY_VERSION ||
        !Number.isSafeInteger(consent.revision) ||
        consent.revision < 1 ||
        !isTimestamp(consent.recordedAt) ||
        consent.recordedAt < friendship.createdAt ||
        consent.recordedAt > now ||
        consent.recordedAt >= friendship.expiresAt ||
        (isMinorAction && consent.actorId !== expectedSubjectMinorId) ||
        (!isMinorAction && consent.actorId === expectedSubjectMinorId)
      ) {
        return false;
      }
      observedKinds.add(consent.kind);
    }
    return CONSENT_KINDS.every((kind) => observedKinds.has(kind));
  } catch {
    return false;
  }
}

/**
 * Produces the sole valid minor-minor activation transition. Persisting this
 * value is still the handler's responsibility and must be guarded by exact
 * consent, profile and current-responsible condition checks in one transaction.
 */
export function activateMinorFriendship(
  friendship: FriendshipItem,
  consents: readonly ConsentItem[],
  now: number,
): FriendshipItem {
  if (!hasFourCurrentMinorFriendConsents(friendship, consents, now)) {
    throw new RangeError('minor friendship activation requires four current consents');
  }
  return {
    ...friendship,
    state: 'active',
    revision: friendship.revision + 1,
    updatedAt: now,
    activatedAt: now,
    endedAt: null,
  };
}
