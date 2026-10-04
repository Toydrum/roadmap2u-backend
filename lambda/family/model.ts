import {
  CURRENT_MINOR_LINK_PRIVACY_VERSION,
  CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION,
  FAMILY_OFFER_DEFINITIONS,
  type OfferKey,
  type CoverageState,
  type HouseholdState,
  type SeatType,
  type SupervisionRole,
} from '@app/api/contracts';
import {
  FK,
  assertFamilyIdentifier,
  householdIdForPrimary,
  supervisionLinkId,
} from './keys';

export interface HouseholdItem {
  readonly pk: string;
  readonly sk: 'META';
  readonly entityType: 'Household';
  readonly householdId: string;
  readonly primaryResponsibleId: string;
  readonly country: 'MX';
  readonly state: HouseholdState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface SeatAssignmentBase {
  readonly pk: string;
  readonly entityType: 'SeatAssignment';
  readonly householdId: string;
  readonly seatType: SeatType;
  readonly state: 'empty' | 'assigned';
  readonly accountId: string | null;
  readonly revision: number;
  readonly assignedAt: number | null;
  readonly updatedAt: number;
}

export interface MinorSeatAssignmentItem extends SeatAssignmentBase {
  readonly sk: `SEAT#MINOR#${1 | 2}`;
  readonly seatType: 'minor';
  readonly seatNumber: 1 | 2;
}

export interface AdditionalResponsibleSeatAssignmentItem extends SeatAssignmentBase {
  readonly sk: 'SEAT#ADDITIONAL';
  readonly seatType: 'additional_responsible';
}

export type SeatAssignmentItem =
  | MinorSeatAssignmentItem
  | AdditionalResponsibleSeatAssignmentItem;

export interface SupervisionLinkItem {
  readonly pk: string;
  readonly sk: string;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  readonly entityType: 'SupervisionLink';
  readonly linkId: string;
  readonly householdId: string;
  readonly adultId: string;
  readonly minorId: string;
  readonly role: SupervisionRole;
  readonly state: 'active' | 'revoked' | 'ended';
  readonly revision: number;
  readonly validFrom: number;
  readonly validUntil: number | null;
  readonly updatedAt: number;
}

export interface CoverageAssignmentItem {
  readonly pk: string;
  readonly sk: 'COVERAGE#FAMILY';
  readonly entityType: 'CoverageAssignment';
  readonly accountId: string;
  readonly householdId: string;
  readonly seatType: SeatType | 'primary_responsible';
  readonly state: CoverageState;
  readonly revision: number;
  readonly paidThrough: number | null;
  readonly source: FamilyEntitlementSource;
  readonly graceUntil: number | null;
  readonly updatedAt: number;
}

export type FamilyOfferKey = Exclude<OfferKey, 'premium_individual'>;
export type FamilyEntitlementSource = 'subscription_projection' | 'test_seed' | 'sponsored_pilot';

export interface FamilyEntitlementItem {
  readonly pk: string;
  readonly sk: 'ENTITLEMENT#FAMILY';
  readonly entityType: 'FamilyEntitlement';
  readonly householdId: string;
  readonly offerKey: FamilyOfferKey | null;
  readonly minorSeats: 1 | 2;
  readonly additionalResponsibleSeat: 0 | 1;
  readonly state: CoverageState;
  readonly revision: number;
  readonly paidThrough: number | null;
  readonly graceUntil: number | null;
  readonly source: FamilyEntitlementSource;
  readonly updatedAt: number;
}

export const CURRENT_MINOR_DECLARATION_VERSION = 'declaration-v1' as const;
export const CURRENT_MINOR_CONSENT_VERSION = 'consent-v1' as const;

export interface MinorConsentAcceptanceItem {
  readonly pk: string;
  readonly sk: 'CONSENT#FAMILY_ONBOARDING';
  readonly entityType: 'MinorConsentAcceptance';
  readonly householdId: string;
  readonly minorId: string;
  readonly actorId: string;
  readonly majorityAt: string;
  readonly declarationVersion: typeof CURRENT_MINOR_DECLARATION_VERSION;
  readonly consentVersion: typeof CURRENT_MINOR_CONSENT_VERSION;
  readonly commandId: string;
  readonly policyVersion: 'family-policy-v2';
  readonly acceptedAt: number;
}

export interface MinorLinkAcceptanceItem {
  readonly pk: string;
  readonly sk: `CONSENT#FAMILY_LINK#${string}`;
  readonly entityType: 'MinorLinkAcceptance';
  readonly requestId: string;
  readonly minorId: string;
  readonly sourceHouseholdId: string;
  readonly targetHouseholdId: string;
  readonly sourcePrimaryId: string;
  readonly targetPrimaryId: string;
  readonly responsibilityVersion: typeof CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION;
  readonly privacyVersion: typeof CURRENT_MINOR_LINK_PRIVACY_VERSION;
  readonly requestCommandId: string;
  readonly sourceApprovalCommandId: string;
  readonly acceptanceCommandId: string;
  readonly policyVersion: 'family-policy-v2';
  readonly sourceApprovedAt: number;
  readonly acceptedAt: number;
}

export interface PrimaryTransferProposalItem {
  readonly pk: string;
  readonly sk: 'TRANSFER#PRIMARY';
  readonly entityType: 'PrimaryTransferProposal';
  readonly householdId: string;
  readonly currentPrimaryId: string;
  readonly newPrimaryId: string;
  readonly householdRevision: number;
  readonly commandId: string;
  readonly state: 'pending' | 'accepted' | 'expired';
  readonly revision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly acceptedById: string | null;
  readonly acceptedAt: number | null;
  readonly updatedAt: number;
}

export interface PrimaryTransferAcceptanceItem {
  readonly pk: string;
  readonly sk: `AUDIT#PRIMARY_TRANSFER#${string}`;
  readonly entityType: 'PrimaryTransferAcceptance';
  readonly householdId: string;
  readonly currentPrimaryId: string;
  readonly newPrimaryId: string;
  readonly householdRevision: number;
  readonly commandId: string;
  readonly acceptedById: string;
  readonly policyVersion: 'family-policy-v2';
  readonly proposedAt: number;
  readonly acceptedAt: number;
}

export type FamilyDomainErrorCode =
  | 'INVALID_FAMILY_STATE'
  | 'STALE_REVISION'
  | 'SEAT_OCCUPIED';

export class FamilyDomainError extends Error {
  constructor(
    readonly code: FamilyDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FamilyDomainError';
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertMutationTime(now: number, updatedAt: number): void {
  assertTimestamp(now, 'now');
  if (now < updatedAt) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'mutation time precedes current state');
  }
}

export function nextRevision(currentRevision: number, expectedRevision: number): number {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'revision must be a positive integer');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new FamilyDomainError('STALE_REVISION', 'expected revision must be a positive integer');
  }
  if (currentRevision !== expectedRevision) {
    throw new FamilyDomainError(
      'STALE_REVISION',
      `expected revision ${expectedRevision}, found ${currentRevision}`,
    );
  }
  if (currentRevision === Number.MAX_SAFE_INTEGER) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'revision exhausted');
  }
  return currentRevision + 1;
}

export function createHousehold(input: {
  primaryResponsibleId: string;
  now: number;
}): HouseholdItem {
  assertFamilyIdentifier(input.primaryResponsibleId, 'primaryResponsibleId');
  assertTimestamp(input.now, 'now');
  const householdId = householdIdForPrimary(input.primaryResponsibleId);
  return {
    ...FK.household(householdId),
    entityType: 'Household',
    householdId,
    primaryResponsibleId: input.primaryResponsibleId,
    country: 'MX',
    state: 'active',
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function createEmptySeatAssignments(
  householdId: string,
  now: number,
): [
  MinorSeatAssignmentItem,
  MinorSeatAssignmentItem,
  AdditionalResponsibleSeatAssignmentItem,
] {
  assertFamilyIdentifier(householdId, 'householdId');
  assertTimestamp(now, 'now');
  const common = {
    entityType: 'SeatAssignment' as const,
    householdId,
    state: 'empty' as const,
    accountId: null,
    revision: 1,
    assignedAt: null,
    updatedAt: now,
  };
  return [
    { ...FK.minorSeat(householdId, 1), ...common, seatType: 'minor', seatNumber: 1 },
    { ...FK.minorSeat(householdId, 2), ...common, seatType: 'minor', seatNumber: 2 },
    { ...FK.additionalSeat(householdId), ...common, seatType: 'additional_responsible' },
  ];
}

export function assignSeat<T extends SeatAssignmentItem>(
  seat: T,
  accountId: string,
  expectedRevision: number,
  now: number,
): T {
  assertFamilyIdentifier(accountId, 'accountId');
  const revision = nextRevision(seat.revision, expectedRevision);
  assertMutationTime(now, seat.updatedAt);
  if (seat.state !== 'empty' || seat.accountId !== null || seat.assignedAt !== null) {
    throw new FamilyDomainError('SEAT_OCCUPIED', 'seat is already assigned');
  }
  return {
    ...seat,
    state: 'assigned',
    accountId,
    revision,
    assignedAt: now,
    updatedAt: now,
  };
}

export function transferPrimaryResponsibility(
  household: HouseholdItem,
  nextPrimaryResponsibleId: string,
  expectedRevision: number,
  now: number,
): HouseholdItem {
  assertFamilyIdentifier(nextPrimaryResponsibleId, 'nextPrimaryResponsibleId');
  const revision = nextRevision(household.revision, expectedRevision);
  assertMutationTime(now, household.updatedAt);
  if (household.state !== 'active' || household.primaryResponsibleId === nextPrimaryResponsibleId) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'primary responsibility can only transfer to a different adult in an active household',
    );
  }
  return {
    ...household,
    primaryResponsibleId: nextPrimaryResponsibleId,
    revision,
    updatedAt: now,
  };
}

export function createSupervisionLink(input: {
  householdId: string;
  adultId: string;
  minorId: string;
  role: SupervisionRole;
  now: number;
}): SupervisionLinkItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertFamilyIdentifier(input.adultId, 'adultId');
  assertFamilyIdentifier(input.minorId, 'minorId');
  assertTimestamp(input.now, 'now');
  if (input.adultId === input.minorId) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'adult and minor must be distinct');
  }
  if (input.role !== 'primary_responsible' && input.role !== 'additional_responsible') {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'unsupported supervision role');
  }
  return {
    ...FK.supervision(input.minorId, input.adultId),
    ...FK.supervisionByAdult(input.adultId, input.minorId),
    entityType: 'SupervisionLink',
    linkId: supervisionLinkId(input.householdId, input.minorId, input.adultId),
    householdId: input.householdId,
    adultId: input.adultId,
    minorId: input.minorId,
    role: input.role,
    state: 'active',
    revision: 1,
    validFrom: input.now,
    validUntil: null,
    updatedAt: input.now,
  };
}

export function createCoverageAssignment(input: {
  householdId: string;
  accountId: string;
  seatType: SeatType | 'primary_responsible';
  paidThrough: number;
  source?: Exclude<FamilyEntitlementSource, 'sponsored_pilot'>;
  now: number;
} | {
  householdId: string;
  accountId: string;
  seatType: SeatType | 'primary_responsible';
  source: 'sponsored_pilot';
  now: number;
}): CoverageAssignmentItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertFamilyIdentifier(input.accountId, 'accountId');
  assertTimestamp(input.now, 'now');
  const pilot = input.source === 'sponsored_pilot';
  const paidThrough = pilot ? null : input.paidThrough;
  if (paidThrough !== null) assertTimestamp(paidThrough, 'paidThrough');
  if (paidThrough !== null && paidThrough <= input.now) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'active coverage must be paid ahead');
  }
  if (
    input.seatType !== 'primary_responsible' &&
    input.seatType !== 'minor' &&
    input.seatType !== 'additional_responsible'
  ) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'unsupported coverage seat type');
  }
  return {
    ...FK.familyCoverage(input.accountId),
    entityType: 'CoverageAssignment',
    accountId: input.accountId,
    householdId: input.householdId,
    seatType: input.seatType,
    state: 'active',
    revision: 1,
    paidThrough,
    source: input.source ?? 'subscription_projection',
    graceUntil: null,
    updatedAt: input.now,
  };
}

export function createFamilyEntitlement(input: {
  householdId: string;
  offerKey: OfferKey;
  paidThrough: number;
  now: number;
  source: Exclude<FamilyEntitlementSource, 'sponsored_pilot'>;
} | {
  householdId: string;
  now: number;
  source: 'sponsored_pilot';
}): FamilyEntitlementItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertTimestamp(input.now, 'now');
  if (input.source === 'sponsored_pilot') {
    return {
      ...FK.familyEntitlement(input.householdId),
      entityType: 'FamilyEntitlement',
      householdId: input.householdId,
      offerKey: null,
      minorSeats: 2,
      additionalResponsibleSeat: 1,
      state: 'active',
      revision: 1,
      paidThrough: null,
      graceUntil: null,
      source: 'sponsored_pilot',
      updatedAt: input.now,
    };
  }
  assertTimestamp(input.paidThrough, 'paidThrough');
  const offer = FAMILY_OFFER_DEFINITIONS.find(
    (candidate) => candidate.offerKey === input.offerKey,
  );
  if (!offer || offer.minorSeats < 1 || input.offerKey === 'premium_individual') {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'family entitlement requires a family offer',
    );
  }
  if (input.paidThrough <= input.now) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'active family entitlement must be paid ahead',
    );
  }
  return {
    ...FK.familyEntitlement(input.householdId),
    entityType: 'FamilyEntitlement',
    householdId: input.householdId,
    offerKey: input.offerKey as FamilyOfferKey,
    minorSeats: offer.minorSeats as 1 | 2,
    additionalResponsibleSeat: offer.additionalResponsibleSeat,
    state: 'active',
    revision: 1,
    paidThrough: input.paidThrough,
    graceUntil: null,
    source: input.source,
    updatedAt: input.now,
  };
}

export function familyEntitlementAllows(
  entitlement: FamilyEntitlementItem | null | undefined,
  required: { readonly minorSeats: number; readonly additionalResponsibleSeat: number },
  now: number,
): boolean {
  assertTimestamp(now, 'now');
  if (
    !entitlement ||
    entitlement.entityType !== 'FamilyEntitlement' ||
    !sameKey(entitlement, FK.familyEntitlement(entitlement.householdId)) ||
    !Number.isSafeInteger(entitlement.revision) ||
    entitlement.revision < 1 ||
    !Number.isSafeInteger(required.minorSeats) ||
    required.minorSeats < 0 ||
    required.minorSeats > 2 ||
    !Number.isSafeInteger(required.additionalResponsibleSeat) ||
    required.additionalResponsibleSeat < 0 ||
    required.additionalResponsibleSeat > 1
  ) {
    return false;
  }
  const current = entitlement.state === 'grace'
    ? entitlement.graceUntil !== null && entitlement.graceUntil > now
    : entitlement.source === 'sponsored_pilot'
      ? entitlement.state === 'active' && entitlement.paidThrough === null
      : (entitlement.state === 'active' || entitlement.state === 'scheduled_end') &&
        entitlement.paidThrough !== null && entitlement.paidThrough > now;
  return (
    current &&
    entitlement.minorSeats >= required.minorSeats &&
    entitlement.additionalResponsibleSeat >= required.additionalResponsibleSeat
  );
}

export function createMinorConsentAcceptance(input: {
  householdId: string;
  minorId: string;
  actorId: string;
  majorityAt: string;
  declarationVersion: string;
  consentVersion: string;
  commandId: string;
  policyVersion: string;
  now: number;
}): MinorConsentAcceptanceItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertFamilyIdentifier(input.minorId, 'minorId');
  assertFamilyIdentifier(input.actorId, 'actorId');
  assertFamilyIdentifier(input.commandId, 'commandId');
  assertTimestamp(input.now, 'now');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.majorityAt)) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'majorityAt must be an ISO date');
  }
  if (
    input.declarationVersion !== CURRENT_MINOR_DECLARATION_VERSION ||
    input.consentVersion !== CURRENT_MINOR_CONSENT_VERSION ||
    input.policyVersion !== 'family-policy-v2'
  ) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'minor consent must use the current server versions',
    );
  }
  return {
    ...FK.minorConsent(input.minorId),
    entityType: 'MinorConsentAcceptance',
    householdId: input.householdId,
    minorId: input.minorId,
    actorId: input.actorId,
    majorityAt: input.majorityAt,
    declarationVersion: CURRENT_MINOR_DECLARATION_VERSION,
    consentVersion: CURRENT_MINOR_CONSENT_VERSION,
    commandId: input.commandId,
    policyVersion: 'family-policy-v2',
    acceptedAt: input.now,
  };
}

export function createMinorLinkAcceptance(input: {
  requestId: string;
  minorId: string;
  sourceHouseholdId: string;
  targetHouseholdId: string;
  sourcePrimaryId: string;
  targetPrimaryId: string;
  responsibilityVersion: string;
  privacyVersion: string;
  requestCommandId: string;
  sourceApprovalCommandId: string;
  acceptanceCommandId: string;
  policyVersion: string;
  sourceApprovedAt: number;
  now: number;
}): MinorLinkAcceptanceItem {
  assertFamilyIdentifier(input.requestId, 'requestId');
  assertFamilyIdentifier(input.minorId, 'minorId');
  assertFamilyIdentifier(input.sourceHouseholdId, 'sourceHouseholdId');
  assertFamilyIdentifier(input.targetHouseholdId, 'targetHouseholdId');
  assertFamilyIdentifier(input.sourcePrimaryId, 'sourcePrimaryId');
  assertFamilyIdentifier(input.targetPrimaryId, 'targetPrimaryId');
  assertFamilyIdentifier(input.requestCommandId, 'requestCommandId');
  assertFamilyIdentifier(input.sourceApprovalCommandId, 'sourceApprovalCommandId');
  assertFamilyIdentifier(input.acceptanceCommandId, 'acceptanceCommandId');
  assertTimestamp(input.sourceApprovedAt, 'sourceApprovedAt');
  assertTimestamp(input.now, 'now');
  if (
    input.sourceHouseholdId === input.targetHouseholdId ||
    input.sourcePrimaryId === input.targetPrimaryId ||
    input.sourceApprovedAt > input.now ||
    input.responsibilityVersion !== CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION ||
    input.privacyVersion !== CURRENT_MINOR_LINK_PRIVACY_VERSION ||
    input.policyVersion !== 'family-policy-v2'
  ) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'minor link acceptance must bind both principals and current server versions',
    );
  }
  return {
    ...FK.minorLinkAcceptance(input.minorId, input.requestId),
    entityType: 'MinorLinkAcceptance',
    requestId: input.requestId,
    minorId: input.minorId,
    sourceHouseholdId: input.sourceHouseholdId,
    targetHouseholdId: input.targetHouseholdId,
    sourcePrimaryId: input.sourcePrimaryId,
    targetPrimaryId: input.targetPrimaryId,
    responsibilityVersion: CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION,
    privacyVersion: CURRENT_MINOR_LINK_PRIVACY_VERSION,
    requestCommandId: input.requestCommandId,
    sourceApprovalCommandId: input.sourceApprovalCommandId,
    acceptanceCommandId: input.acceptanceCommandId,
    policyVersion: 'family-policy-v2',
    sourceApprovedAt: input.sourceApprovedAt,
    acceptedAt: input.now,
  };
}

export function createPrimaryTransferProposal(input: {
  householdId: string;
  currentPrimaryId: string;
  newPrimaryId: string;
  householdRevision: number;
  commandId: string;
  now: number;
  expiresAt: number;
}): PrimaryTransferProposalItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertFamilyIdentifier(input.currentPrimaryId, 'currentPrimaryId');
  assertFamilyIdentifier(input.newPrimaryId, 'newPrimaryId');
  assertFamilyIdentifier(input.commandId, 'commandId');
  assertTimestamp(input.now, 'now');
  assertTimestamp(input.expiresAt, 'expiresAt');
  if (
    input.currentPrimaryId === input.newPrimaryId ||
    !Number.isSafeInteger(input.householdRevision) ||
    input.householdRevision < 1 ||
    input.expiresAt <= input.now
  ) {
    throw new FamilyDomainError('INVALID_FAMILY_STATE', 'primary transfer proposal is invalid');
  }
  return {
    ...FK.primaryTransfer(input.householdId),
    entityType: 'PrimaryTransferProposal',
    householdId: input.householdId,
    currentPrimaryId: input.currentPrimaryId,
    newPrimaryId: input.newPrimaryId,
    householdRevision: input.householdRevision,
    commandId: input.commandId,
    state: 'pending',
    revision: 1,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    acceptedById: null,
    acceptedAt: null,
    updatedAt: input.now,
  };
}

export function createPrimaryTransferAcceptance(input: {
  householdId: string;
  currentPrimaryId: string;
  newPrimaryId: string;
  householdRevision: number;
  commandId: string;
  acceptedById: string;
  policyVersion: string;
  proposedAt: number;
  now: number;
}): PrimaryTransferAcceptanceItem {
  assertFamilyIdentifier(input.householdId, 'householdId');
  assertFamilyIdentifier(input.currentPrimaryId, 'currentPrimaryId');
  assertFamilyIdentifier(input.newPrimaryId, 'newPrimaryId');
  assertFamilyIdentifier(input.commandId, 'commandId');
  assertFamilyIdentifier(input.acceptedById, 'acceptedById');
  assertTimestamp(input.proposedAt, 'proposedAt');
  assertTimestamp(input.now, 'now');
  if (
    input.currentPrimaryId === input.newPrimaryId ||
    input.acceptedById !== input.newPrimaryId ||
    !Number.isSafeInteger(input.householdRevision) ||
    input.householdRevision < 1 ||
    input.proposedAt > input.now ||
    input.policyVersion !== 'family-policy-v2'
  ) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'primary transfer acceptance is invalid',
    );
  }
  return {
    ...FK.primaryTransferAcceptance(input.householdId, input.commandId),
    entityType: 'PrimaryTransferAcceptance',
    householdId: input.householdId,
    currentPrimaryId: input.currentPrimaryId,
    newPrimaryId: input.newPrimaryId,
    householdRevision: input.householdRevision,
    commandId: input.commandId,
    acceptedById: input.acceptedById,
    policyVersion: 'family-policy-v2',
    proposedAt: input.proposedAt,
    acceptedAt: input.now,
  };
}

export interface HouseholdSnapshot {
  readonly household: HouseholdItem;
  readonly seats: readonly SeatAssignmentItem[];
  readonly supervisionLinks: readonly SupervisionLinkItem[];
  readonly coverages: readonly CoverageAssignmentItem[];
}

function invalidFamilyState(message: string): never {
  throw new FamilyDomainError('INVALID_FAMILY_STATE', message);
}

function assertPositiveRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    invalidFamilyState(`${label} revision must be a positive integer`);
  }
}

function sameKey(
  item: { readonly pk: string; readonly sk: string },
  key: { readonly pk: string; readonly sk: string },
): boolean {
  return item.pk === key.pk && item.sk === key.sk;
}

function assertSeatShape(seat: SeatAssignmentItem, householdId: string): void {
  if (seat.entityType !== 'SeatAssignment' || seat.householdId !== householdId) {
    invalidFamilyState('seat belongs to another entity or household');
  }
  assertPositiveRevision(seat.revision, `seat ${seat.sk}`);
  assertTimestamp(seat.updatedAt, `seat ${seat.sk} updatedAt`);
  if (seat.state === 'empty') {
    if (seat.accountId !== null || seat.assignedAt !== null) {
      invalidFamilyState('an empty seat cannot carry an identity');
    }
  } else if (seat.state === 'assigned') {
    if (seat.accountId === null || seat.assignedAt === null) {
      invalidFamilyState('an assigned seat requires an account and assignment time');
    }
    assertFamilyIdentifier(seat.accountId, 'seat accountId');
    assertTimestamp(seat.assignedAt, `seat ${seat.sk} assignedAt`);
  } else {
    invalidFamilyState('unsupported seat state');
  }
}

function assertCoverageShape(coverage: CoverageAssignmentItem, now: number): void {
  if (
    coverage.entityType !== 'CoverageAssignment' ||
    !sameKey(coverage, FK.familyCoverage(coverage.accountId))
  ) {
    invalidFamilyState('family coverage uses a non-canonical key');
  }
  assertPositiveRevision(coverage.revision, `coverage ${coverage.accountId}`);
  assertTimestamp(coverage.updatedAt, `coverage ${coverage.accountId} updatedAt`);
  if (coverage.source === 'sponsored_pilot') {
    if (coverage.paidThrough !== null || coverage.graceUntil !== null || coverage.state === 'grace') {
      invalidFamilyState('pilot coverage cannot carry a payment or grace boundary');
    }
  } else {
    if (coverage.paidThrough === null) {
      invalidFamilyState('paid coverage requires a payment boundary');
    }
    assertTimestamp(coverage.paidThrough, `coverage ${coverage.accountId} paidThrough`);
  }
  if (
    coverage.state !== 'active' &&
    coverage.state !== 'grace' &&
    coverage.state !== 'scheduled_end' &&
    coverage.state !== 'ended'
  ) {
    invalidFamilyState('unsupported family coverage state');
  }
  if (
    (coverage.state === 'active' || coverage.state === 'scheduled_end') &&
    coverage.source !== 'sponsored_pilot' &&
    (coverage.paidThrough === null || coverage.paidThrough <= now)
  ) {
    invalidFamilyState('paid family coverage must extend beyond now');
  }
  if (coverage.state === 'grace') {
    if (coverage.graceUntil === null || coverage.graceUntil <= now) {
      invalidFamilyState('grace coverage requires a future grace boundary');
    }
  } else if (coverage.graceUntil !== null) {
    invalidFamilyState('only grace coverage may carry graceUntil');
  }
}

export function validateHouseholdSnapshot(snapshot: HouseholdSnapshot, now: number): void {
  assertTimestamp(now, 'now');
  const { household } = snapshot;
  if (
    household.entityType !== 'Household' ||
    !sameKey(household, FK.household(household.householdId)) ||
    household.country !== 'MX'
  ) {
    invalidFamilyState('household metadata is not canonical');
  }
  assertFamilyIdentifier(household.primaryResponsibleId, 'primaryResponsibleId');
  assertPositiveRevision(household.revision, 'household');
  assertTimestamp(household.createdAt, 'household createdAt');
  assertTimestamp(household.updatedAt, 'household updatedAt');
  if (household.updatedAt < household.createdAt) {
    invalidFamilyState('household timestamps are not monotonic');
  }

  const expectedSeatKeys = new Map<string, SeatType>([
    [FK.minorSeat(household.householdId, 1).sk, 'minor'],
    [FK.minorSeat(household.householdId, 2).sk, 'minor'],
    [FK.additionalSeat(household.householdId).sk, 'additional_responsible'],
  ]);
  if (snapshot.seats.length !== expectedSeatKeys.size) {
    invalidFamilyState('household must have exactly two minor seats and one additional seat');
  }

  const seenSeatKeys = new Set<string>();
  const assignedAccounts = new Set<string>();
  const assignedMinorIds = new Set<string>();
  let additionalResponsibleId: string | null = null;
  for (const seat of snapshot.seats) {
    assertSeatShape(seat, household.householdId);
    const expectedType = expectedSeatKeys.get(seat.sk);
    if (!expectedType || expectedType !== seat.seatType || seenSeatKeys.has(seat.sk)) {
      invalidFamilyState('seat key, type or cardinality is invalid');
    }
    seenSeatKeys.add(seat.sk);
    if (seat.seatType === 'minor') {
      if (
        seat.seatNumber !== (seat.sk === 'SEAT#MINOR#1' ? 1 : 2) ||
        !sameKey(seat, FK.minorSeat(household.householdId, seat.seatNumber))
      ) {
        invalidFamilyState('minor seat number is not canonical');
      }
    } else if (!sameKey(seat, FK.additionalSeat(household.householdId))) {
      invalidFamilyState('additional-responsible seat key is not canonical');
    }
    if (seat.accountId !== null) {
      if (assignedAccounts.has(seat.accountId) || seat.accountId === household.primaryResponsibleId) {
        invalidFamilyState('an account cannot occupy multiple household roles');
      }
      assignedAccounts.add(seat.accountId);
      if (seat.seatType === 'minor') assignedMinorIds.add(seat.accountId);
      else additionalResponsibleId = seat.accountId;
    }
  }
  if (seenSeatKeys.size !== expectedSeatKeys.size || assignedMinorIds.size > 2) {
    invalidFamilyState('household seat capacity was exceeded');
  }

  const primaryCounts = new Map<string, number>();
  const additionalScope = new Set<string>();
  const activeAddresses = new Set<string>();
  for (const link of snapshot.supervisionLinks) {
    if (
      link.entityType !== 'SupervisionLink' ||
      link.householdId !== household.householdId ||
      !sameKey(link, FK.supervision(link.minorId, link.adultId)) ||
      link.gsi1pk !== FK.supervisionByAdult(link.adultId, link.minorId).gsi1pk ||
      link.gsi1sk !== FK.supervisionByAdult(link.adultId, link.minorId).gsi1sk ||
      link.linkId !== supervisionLinkId(link.householdId, link.minorId, link.adultId)
    ) {
      invalidFamilyState('supervision link is not canonical');
    }
    assertPositiveRevision(link.revision, `supervision ${link.linkId}`);
    assertTimestamp(link.validFrom, `supervision ${link.linkId} validFrom`);
    assertTimestamp(link.updatedAt, `supervision ${link.linkId} updatedAt`);
    if (link.state !== 'active') continue;
    if (link.validUntil !== null || link.validFrom > now || !assignedMinorIds.has(link.minorId)) {
      invalidFamilyState('active supervision must target a seated minor and be currently valid');
    }
    const address = `${link.minorId}\0${link.adultId}`;
    if (activeAddresses.has(address)) invalidFamilyState('duplicate active supervision link');
    activeAddresses.add(address);
    if (link.role === 'primary_responsible') {
      if (link.adultId !== household.primaryResponsibleId) {
        invalidFamilyState('primary supervision does not match the household primary');
      }
      primaryCounts.set(link.minorId, (primaryCounts.get(link.minorId) ?? 0) + 1);
    } else if (link.role === 'additional_responsible') {
      if (additionalResponsibleId === null || link.adultId !== additionalResponsibleId) {
        invalidFamilyState('additional supervision does not match the additional seat');
      }
      if (additionalScope.has(link.minorId)) invalidFamilyState('duplicate additional scope');
      additionalScope.add(link.minorId);
    } else {
      invalidFamilyState('unsupported supervision role');
    }
  }
  for (const minorId of assignedMinorIds) {
    if (primaryCounts.get(minorId) !== 1) {
      invalidFamilyState('each seated minor requires exactly one active primary supervision link');
    }
  }
  if (additionalResponsibleId === null) {
    if (additionalScope.size !== 0) invalidFamilyState('additional scope exists without a seat');
  } else if (additionalScope.size < 1 || additionalScope.size > 2) {
    invalidFamilyState('additional-responsible scope must contain one or two seated minors');
  }

  const emptyPersonalHousehold =
    household.householdId === householdIdForPrimary(household.primaryResponsibleId) &&
    assignedAccounts.size === 0;
  const activeCoverageAccounts = new Set<string>();
  for (const coverage of snapshot.coverages) {
    assertCoverageShape(coverage, now);
    const isCurrent = coverage.state !== 'ended';
    if (!isCurrent) continue;
    if (activeCoverageAccounts.has(coverage.accountId)) {
      invalidFamilyState('an account has more than one current family coverage');
    }
    activeCoverageAccounts.add(coverage.accountId);
    if (coverage.householdId !== household.householdId) {
      // Adults keep an empty personal household while serving another household.
      if (
        emptyPersonalHousehold &&
        coverage.accountId === household.primaryResponsibleId &&
        (coverage.seatType === 'primary_responsible' || coverage.seatType === 'additional_responsible')
      ) continue;
      invalidFamilyState('current family coverage belongs to another household');
    }
    if (coverage.accountId === household.primaryResponsibleId) {
      if (coverage.seatType !== 'primary_responsible') {
        invalidFamilyState('primary coverage uses the wrong seat type');
      }
      continue;
    }
    const assignedSeat = snapshot.seats.find((seat) => seat.accountId === coverage.accountId);
    if (!assignedSeat || assignedSeat.seatType !== coverage.seatType) {
      invalidFamilyState('family coverage does not match an assigned household role');
    }
  }
}
