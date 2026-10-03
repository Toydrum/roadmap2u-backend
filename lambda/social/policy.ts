import type { AccountType, FriendshipClass } from '@app/api/contracts';
import type { HouseholdSnapshot } from '../family/model';
import { authorizeFamilyAction } from '../family/policy';
import { canonicalFriendshipPair } from './model';

export interface SocialPolicyPerson {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly socialEnabled: boolean;
  readonly status: 'active' | 'closing';
  readonly majorityAt?: string;
}

export type FriendRequestAction = 'create' | 'accept' | 'remove' | 'decline' | 'cancel';

export type FriendRequestDecision =
  | { readonly allowed: true; readonly friendshipClass: FriendshipClass | null }
  | {
      readonly allowed: false;
      readonly code:
        | 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN'
        | 'FORBIDDEN'
        | 'CONFLICT';
    };

export interface AuthorizeFriendRequestInput {
  readonly actor: SocialPolicyPerson;
  readonly target: SocialPolicyPerson;
  readonly action: FriendRequestAction;
  readonly now: number;
}

export interface SocialFriendshipFacts {
  readonly friendshipId: string;
  readonly userA: string;
  readonly userB: string;
  readonly friendshipClass: FriendshipClass;
  readonly state: 'active' | 'revoked';
}

export type ForestRelationship =
  | 'self'
  | 'primary_supervision'
  | 'additional_supervision'
  | 'adult_friend'
  | 'minor_friend';

export type ForestVisitDecision =
  | { readonly allowed: true; readonly relationship: ForestRelationship }
  | { readonly allowed: false; readonly code: 'NOT_FOUND' };

export interface AuthorizeForestVisitInput {
  readonly actor: SocialPolicyPerson;
  readonly target: SocialPolicyPerson;
  readonly friendship?: SocialFriendshipFacts;
  readonly household?: HouseholdSnapshot;
  readonly now: number;
}

const CLEANUP_ACTIONS = new Set<FriendRequestAction>(['remove', 'decline', 'cancel']);

function friendshipClassFor(
  left: AccountType,
  right: AccountType,
): FriendshipClass | null {
  if (left === 'adult' && right === 'adult') return 'adult_adult';
  if (left === 'minor' && right === 'minor') return 'minor_minor';
  return null;
}

function reachedMajority(person: SocialPolicyPerson, now: number): boolean {
  if (person.accountType !== 'minor' || !person.majorityAt) return false;
  const boundary = Date.parse(`${person.majorityAt}T00:00:00.000Z`);
  return !Number.isFinite(boundary) || boundary <= now;
}

export function authorizeFriendRequest(
  input: AuthorizeFriendRequestInput,
): FriendRequestDecision {
  const friendshipClass = friendshipClassFor(
    input.actor.accountType,
    input.target.accountType,
  );
  if (CLEANUP_ACTIONS.has(input.action)) {
    return { allowed: true, friendshipClass };
  }
  if (input.actor.status !== 'active' || input.target.status !== 'active') {
    return { allowed: false, code: 'CONFLICT' };
  }
  if (!input.actor.socialEnabled || !input.target.socialEnabled) {
    return { allowed: false, code: 'FORBIDDEN' };
  }
  if (reachedMajority(input.actor, input.now) || reachedMajority(input.target, input.now)) {
    return { allowed: false, code: 'CONFLICT' };
  }
  if (friendshipClass === null) {
    return { allowed: false, code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' };
  }
  return { allowed: true, friendshipClass };
}

function exactActiveFriendship(
  input: AuthorizeForestVisitInput,
  expectedClass: FriendshipClass,
): boolean {
  const friendship = input.friendship;
  if (!friendship || friendship.state !== 'active' || friendship.friendshipClass !== expectedClass) {
    return false;
  }
  try {
    const pair = canonicalFriendshipPair(friendship.userA, friendship.userB);
    if (
      friendship.friendshipId !== pair.friendshipId ||
      friendship.userA !== pair.userA ||
      friendship.userB !== pair.userB
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    (friendship.userA === input.actor.accountId &&
      friendship.userB === input.target.accountId) ||
    (friendship.userB === input.actor.accountId &&
      friendship.userA === input.target.accountId)
  );
}

export function authorizeForestVisit(
  input: AuthorizeForestVisitInput,
): ForestVisitDecision {
  if (input.actor.accountId === input.target.accountId) {
    return { allowed: true, relationship: 'self' };
  }

  if (input.actor.accountType === 'adult' && input.target.accountType === 'minor') {
    if (input.target.status !== 'active' || reachedMajority(input.target, input.now)) {
      return { allowed: false, code: 'NOT_FOUND' };
    }
    if (!input.household) return { allowed: false, code: 'NOT_FOUND' };
    const familyDecision = authorizeFamilyAction({
      actor: {
        accountId: input.actor.accountId,
        accountType: input.actor.accountType,
        status: input.actor.status,
        socialEnabled: input.actor.socialEnabled,
      },
      action: 'accompany_minor_forest',
      household: input.household,
      targetAccountId: input.target.accountId,
      expectedHouseholdRevision: input.household.household.revision,
      now: input.now,
    });
    if (!familyDecision.allowed) return { allowed: false, code: 'NOT_FOUND' };
    if (familyDecision.actorRole === 'primary_responsible') {
      return { allowed: true, relationship: 'primary_supervision' };
    }
    if (familyDecision.actorRole === 'additional_responsible') {
      return { allowed: true, relationship: 'additional_supervision' };
    }
    return { allowed: false, code: 'NOT_FOUND' };
  }

  if (
    input.actor.status !== 'active' ||
    input.target.status !== 'active' ||
    !input.actor.socialEnabled ||
    !input.target.socialEnabled ||
    reachedMajority(input.actor, input.now) ||
    reachedMajority(input.target, input.now)
  ) {
    return { allowed: false, code: 'NOT_FOUND' };
  }

  if (input.actor.accountType === 'adult' && input.target.accountType === 'adult') {
    return exactActiveFriendship(input, 'adult_adult')
      ? { allowed: true, relationship: 'adult_friend' }
      : { allowed: false, code: 'NOT_FOUND' };
  }
  if (input.actor.accountType === 'minor' && input.target.accountType === 'minor') {
    return exactActiveFriendship(input, 'minor_minor')
      ? { allowed: true, relationship: 'minor_friend' }
      : { allowed: false, code: 'NOT_FOUND' };
  }
  return { allowed: false, code: 'NOT_FOUND' };
}
