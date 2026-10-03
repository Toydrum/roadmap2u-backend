import type { AccountType } from '@app/api/contracts';
import {
  validateHouseholdSnapshot,
  type CoverageAssignmentItem,
  type HouseholdSnapshot,
} from './model';

export const FAMILY_POLICY_VERSION = 'family-policy-v2' as const;

export type FamilyAction =
  | 'read_household'
  | 'create_minor'
  | 'create_minor_link_request'
  | 'approve_minor_link'
  | 'accept_minor_link'
  | 'invite_additional_responsible'
  | 'replace_additional_scope'
  | 'revoke_additional_responsible'
  | 'transfer_primary_responsibility'
  | 'accept_primary_transfer'
  | 'manage_minor_recovery'
  | 'manage_minor_identity'
  | 'accompany_minor_forest'
  | 'approve_minor_friendship'
  | 'revoke_minor_friendship'
  | 'export_minor'
  | 'delete_minor';

export interface FamilyPolicyActor {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly status: 'active' | 'closing';
  readonly socialEnabled: boolean;
}

export type FamilyActorRole =
  | 'primary_responsible'
  | 'additional_responsible'
  | 'minor_self';

export type FamilyPolicyDenialCode =
  | 'STALE_REVISION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'ACCOUNT_TYPE_INCOMPATIBLE'
  | 'RESPONSIBLE_SCOPE_REQUIRED'
  | 'PAYMENT_REQUIRED'
  | 'CONFLICT';

export type FamilyAuthorizationDecision =
  | { readonly allowed: true; readonly actorRole: FamilyActorRole }
  | { readonly allowed: false; readonly code: FamilyPolicyDenialCode };

export interface AuthorizeFamilyActionInput {
  readonly actor: FamilyPolicyActor;
  readonly action: FamilyAction;
  readonly household: HouseholdSnapshot;
  readonly targetAccountId?: string;
  readonly expectedHouseholdRevision?: number;
  readonly now: number;
}

const ACTIONS_REQUIRING_SEATED_MINOR = new Set<FamilyAction>([
  'manage_minor_recovery',
  'manage_minor_identity',
  'approve_minor_link',
  'accompany_minor_forest',
  'approve_minor_friendship',
  'revoke_minor_friendship',
  'export_minor',
  'delete_minor',
]);

const PRIMARY_SAFETY_ACTIONS = new Set<FamilyAction>([
  'read_household',
  'manage_minor_recovery',
  'manage_minor_identity',
  'revoke_additional_responsible',
  'revoke_minor_friendship',
  'export_minor',
  'delete_minor',
]);

const ADDITIONAL_SCOPED_ACTIONS = new Set<FamilyAction>([
  'accompany_minor_forest',
  'approve_minor_friendship',
  'revoke_minor_friendship',
]);

function denied(code: FamilyPolicyDenialCode): FamilyAuthorizationDecision {
  return { allowed: false, code };
}

function isCurrentCoverage(
  coverage: CoverageAssignmentItem | undefined,
  now: number,
): boolean {
  if (!coverage || coverage.state === 'ended') return false;
  if (coverage.state === 'grace') {
    return coverage.graceUntil !== null && coverage.graceUntil > now;
  }
  if (coverage.source === 'sponsored_pilot') return coverage.paidThrough === null;
  return coverage.paidThrough !== null && coverage.paidThrough > now;
}

function hasCurrentCoverage(
  snapshot: HouseholdSnapshot,
  accountId: string,
  now: number,
): boolean {
  return isCurrentCoverage(
    snapshot.coverages.find(
      (coverage) =>
        coverage.accountId === accountId &&
        coverage.householdId === snapshot.household.householdId,
    ),
    now,
  );
}

function isSeatedMinor(snapshot: HouseholdSnapshot, accountId: string | undefined): boolean {
  return (
    accountId !== undefined &&
    snapshot.seats.some(
      (seat) =>
        seat.seatType === 'minor' &&
        seat.state === 'assigned' &&
        seat.accountId === accountId,
    )
  );
}

function actorRole(
  snapshot: HouseholdSnapshot,
  actor: FamilyPolicyActor,
): FamilyActorRole | null {
  if (snapshot.household.primaryResponsibleId === actor.accountId) {
    return 'primary_responsible';
  }
  if (
    snapshot.seats.some(
      (seat) =>
        seat.seatType === 'additional_responsible' &&
        seat.state === 'assigned' &&
        seat.accountId === actor.accountId,
    )
  ) {
    return 'additional_responsible';
  }
  if (isSeatedMinor(snapshot, actor.accountId)) return 'minor_self';
  return null;
}

function accountTypeMatchesRole(role: FamilyActorRole, accountType: AccountType): boolean {
  return role === 'minor_self' ? accountType === 'minor' : accountType === 'adult';
}

export function authorizeFamilyAction(
  input: AuthorizeFamilyActionInput,
): FamilyAuthorizationDecision {
  if (
    input.expectedHouseholdRevision !== undefined &&
    input.expectedHouseholdRevision !== input.household.household.revision
  ) {
    return denied('STALE_REVISION');
  }

  validateHouseholdSnapshot(input.household, input.now);

  if (input.actor.status === 'closing' || input.household.household.state !== 'active') {
    return denied('CONFLICT');
  }

  if (
    ACTIONS_REQUIRING_SEATED_MINOR.has(input.action) &&
    !isSeatedMinor(input.household, input.targetAccountId)
  ) {
    return denied('NOT_FOUND');
  }

  const role = actorRole(input.household, input.actor);
  if (role === null) return denied('FORBIDDEN');
  if (!accountTypeMatchesRole(role, input.actor.accountType)) {
    return denied('ACCOUNT_TYPE_INCOMPATIBLE');
  }

  if (role === 'primary_responsible') {
    if (input.action === 'accept_primary_transfer') return denied('FORBIDDEN');
    if (
      !PRIMARY_SAFETY_ACTIONS.has(input.action) &&
      !hasCurrentCoverage(input.household, input.actor.accountId, input.now)
    ) {
      return denied('PAYMENT_REQUIRED');
    }
    return { allowed: true, actorRole: role };
  }

  if (role === 'additional_responsible') {
    if (!hasCurrentCoverage(input.household, input.actor.accountId, input.now)) {
      return denied('PAYMENT_REQUIRED');
    }
    if (input.action === 'read_household') {
      return { allowed: true, actorRole: role };
    }
    if (input.action === 'accept_primary_transfer') {
      return input.targetAccountId === input.actor.accountId
        ? { allowed: true, actorRole: role }
        : denied('FORBIDDEN');
    }
    if (!ADDITIONAL_SCOPED_ACTIONS.has(input.action)) return denied('FORBIDDEN');
    const inScope = input.household.supervisionLinks.some(
      (link) =>
        link.adultId === input.actor.accountId &&
        link.minorId === input.targetAccountId &&
        link.role === 'additional_responsible' &&
        link.state === 'active' &&
        link.validUntil === null &&
        link.validFrom <= input.now,
    );
    return inScope
      ? { allowed: true, actorRole: role }
      : denied('RESPONSIBLE_SCOPE_REQUIRED');
  }

  if (
    input.action === 'read_household' ||
    (input.action === 'accompany_minor_forest' &&
      input.targetAccountId === input.actor.accountId)
  ) {
    return { allowed: true, actorRole: role };
  }
  return denied('FORBIDDEN');
}
