import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHash } from 'node:crypto';
import {
  CURRENT_MINOR_LINK_PRIVACY_VERSION,
  CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION,
  ApiError,
  FAMILY_BILLING_CONTRACT_VERSION,
  LIMITS,
  type AcceptAdditionalResponsibleInvitationRequest,
  type AcceptMinorLinkRequest,
  type AdditionalResponsibleInvitationView,
  type ApproveMinorLinkRequest,
  type CreateAdditionalResponsibleInvitationRequest,
  type CreateMinorLinkRequest,
  type CreateMinorLinkCodeRequest,
  type CodeGrant,
  type CreateMinorRequest,
  type CreateMinorResponse,
  type FamilyCommandBase,
  type HouseholdView,
  type MinorLinkRequestView,
  type ReplaceAdditionalResponsibleScopeRequest,
  type RevokeAdditionalResponsibleRequest,
  type TransferPrimaryResponsibilityRequest,
  type UserProfile,
} from '@app/api/contracts';
import { USERNAME_PATTERN } from '@app/auth/auth-types';
import {
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  profileOfConsistent,
  toPublic,
  writableOwnerConditionChecks,
  type Ctx,
} from '../authz';
import { accountClosureKey } from '../account-closure';
import { friendCode, tempPassword } from '../codes';
import { deriveAccessItem } from '../commercial/access-resolver';
import { requireFamilyRolloutFlag } from '../commercial/family-rollout';
import {
  GetCommand,
  K,
  TransactWriteCommand,
  type CodeItem,
  type LinkItem,
  type ProfileItem,
  composite,
} from '../db';
import { assertFamilyIdentifier, FK, householdIdForPrimary } from '../family/keys';
import {
  CURRENT_MINOR_CONSENT_VERSION,
  CURRENT_MINOR_DECLARATION_VERSION,
  assignSeat,
  createCoverageAssignment,
  createMinorConsentAcceptance,
  createMinorLinkAcceptance,
  createPrimaryTransferAcceptance,
  createPrimaryTransferProposal,
  createSupervisionLink,
  familyEntitlementAllows,
  nextRevision,
  type AdditionalResponsibleSeatAssignmentItem,
  type CoverageAssignmentItem,
  type FamilyEntitlementItem,
  type HouseholdSnapshot,
  type MinorSeatAssignmentItem,
  type PrimaryTransferProposalItem,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../family/model';
import {
  buildAssignMinorTransaction,
  buildTransferPrimaryTransaction,
  classifyFamilyTransactionCancellation,
  readHouseholdSnapshot,
} from '../family/repository';
import {
  FAMILY_POLICY_VERSION,
  authorizeFamilyAction,
  type FamilyAction,
} from '../family/policy';
import {
  guardianInviteMirrors,
  idempotentGuardianInviteMirrorDelete,
} from '../guardian-invites';
import { reserveCodeAttempt } from './guarded-mutation';
import { familyInboxWrites } from '../family/inbox';

const FAMILY_NOTICE_TTL_MS = 72 * 60 * 60 * 1_000;
const PRIMARY_TRANSFER_TTL_MS = 15 * 60 * 1_000;
const FAMILY_STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;
const FAMILY_STEP_UP_CLOCK_SKEW_MS = 60 * 1_000;
const FAMILY_FENCE_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type NoticeState = 'pending' | 'approved' | 'accepted' | 'rejected' | 'revoked';
type FamilyNoticeKind = 'minor_link_request' | 'additional_responsible_invitation';

interface FamilyNoticeItem {
  readonly pk: string;
  readonly sk: 'META';
  readonly entityType: 'FamilyNotice';
  readonly noticeId: string;
  readonly kind: FamilyNoticeKind;
  readonly householdId: string;
  readonly targetHouseholdRevision: number;
  readonly createdById: string;
  readonly minorId: string | null;
  readonly minorIds: readonly string[];
  readonly sourceHouseholdId: string | null;
  readonly sourceHouseholdRevision: number | null;
  readonly sourcePrimaryId: string | null;
  readonly intendedAdultId: string | null;
  readonly acceptedById: string | null;
  readonly sourceApprovalCommandId: string | null;
  readonly sourceApprovedAt: number | null;
  readonly acceptanceCommandId: string | null;
  readonly state: NoticeState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revision: number;
  readonly commandId: string;
  readonly policyVersion: typeof FAMILY_POLICY_VERSION;
  readonly code: string | null;
}

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('VALIDATION', 'body must be an object');
  }
  return body as Record<string, unknown>;
}

function assertExactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const exact = [...expected].sort();
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) {
    throw new ApiError('VALIDATION', 'body keys must match the contract exactly');
  }
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ApiError('VALIDATION', `${label} must be a string`);
  try {
    assertFamilyIdentifier(value, label);
  } catch {
    throw new ApiError('VALIDATION', `${label} is invalid`);
  }
  return value;
}

function parseBase(
  body: Record<string, unknown>,
  expectedKeys: readonly string[],
): FamilyCommandBase {
  assertExactKeys(body, expectedKeys);
  const householdId = safeIdentifier(body['householdId'], 'householdId');
  const expectedHouseholdRevision = body['expectedHouseholdRevision'];
  if (
    typeof expectedHouseholdRevision !== 'number' ||
    !Number.isSafeInteger(expectedHouseholdRevision) ||
    expectedHouseholdRevision < 1
  ) {
    throw new ApiError('VALIDATION', 'expectedHouseholdRevision must be positive');
  }
  const commandId = body['commandId'];
  if (typeof commandId !== 'string' || !UUID_PATTERN.test(commandId)) {
    throw new ApiError('VALIDATION', 'commandId must be a UUID');
  }
  if (body['policyVersion'] !== FAMILY_POLICY_VERSION) {
    throw new ApiError('VALIDATION', 'unsupported family policy version');
  }
  return {
    householdId,
    expectedHouseholdRevision,
    commandId,
    policyVersion: FAMILY_POLICY_VERSION,
  };
}

const BASE_KEYS = [
  'householdId',
  'expectedHouseholdRevision',
  'commandId',
  'policyVersion',
] as const;

function parseCreateMinor(body: unknown): CreateMinorRequest {
  const record = asRecord(body);
  const base = parseBase(record, [
    ...BASE_KEYS,
    'username',
    'country',
    'majorityAt',
    'declarationVersion',
    'consentVersion',
  ]);
  const username = typeof record['username'] === 'string'
    ? record['username'].trim().toLowerCase()
    : '';
  if (!USERNAME_PATTERN.test(username)) throw new ApiError('VALIDATION', 'invalid username');
  if (record['country'] !== 'MX') throw new ApiError('LEGAL_REGION_UNSUPPORTED');
  const majorityAt = record['majorityAt'];
  if (typeof majorityAt !== 'string' || !ISO_DATE_PATTERN.test(majorityAt)) {
    throw new ApiError('VALIDATION', 'majorityAt must be an ISO date');
  }
  const majorityTime = Date.parse(`${majorityAt}T00:00:00.000Z`);
  if (!Number.isFinite(majorityTime)) throw new ApiError('VALIDATION', 'majorityAt is invalid');
  const declarationVersion = record['declarationVersion'];
  const consentVersion = record['consentVersion'];
  if (
    declarationVersion !== CURRENT_MINOR_DECLARATION_VERSION ||
    consentVersion !== CURRENT_MINOR_CONSENT_VERSION
  ) {
    throw new ApiError('VALIDATION', 'consent versions are not current');
  }
  return {
    ...base,
    username,
    country: 'MX',
    majorityAt,
    declarationVersion,
    consentVersion,
  };
}

function requireRecentFamilyAuthentication(ctx: Ctx): void {
  const authenticatedAt = ctx.authenticatedAt;
  const now = ctx.deps.now();
  if (
    authenticatedAt === undefined ||
    !Number.isSafeInteger(authenticatedAt) ||
    authenticatedAt > now + FAMILY_STEP_UP_CLOCK_SKEW_MS ||
    now - authenticatedAt > FAMILY_STEP_UP_MAX_AGE_MS
  ) {
    throw new ApiError('REAUTHENTICATION_REQUIRED');
  }
}

function parseCodeCommand(body: unknown): CreateMinorLinkRequest {
  const record = asRecord(body);
  const base = parseBase(record, [...BASE_KEYS, 'code']);
  const code = typeof record['code'] === 'string'
    ? record['code'].trim().toUpperCase().replace(/-/g, '')
    : '';
  if (!/^[A-Z0-9]{6,64}$/.test(code)) throw new ApiError('VALIDATION', 'invalid code');
  return { ...base, code };
}

function parseAcceptMinorLink(body: unknown): AcceptMinorLinkRequest {
  const record = asRecord(body);
  const base = parseBase(record, [
    ...BASE_KEYS,
    'responsibilityVersion',
    'privacyVersion',
  ]);
  if (
    record['responsibilityVersion'] !== CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION ||
    record['privacyVersion'] !== CURRENT_MINOR_LINK_PRIVACY_VERSION
  ) {
    throw new ApiError('VALIDATION', 'minor link consent versions are not current');
  }
  return {
    ...base,
    responsibilityVersion: CURRENT_MINOR_LINK_RESPONSIBILITY_VERSION,
    privacyVersion: CURRENT_MINOR_LINK_PRIVACY_VERSION,
  };
}

function parseCommand(body: unknown): FamilyCommandBase {
  const record = asRecord(body);
  return parseBase(record, BASE_KEYS);
}

function parseMinorIds(record: Record<string, unknown>): string[] {
  const raw = record['minorIds'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
    throw new ApiError('VALIDATION', 'minorIds must contain one or two accounts');
  }
  const minorIds = raw.map((minorId) => safeIdentifier(minorId, 'minorId')).sort();
  if (new Set(minorIds).size !== minorIds.length) {
    throw new ApiError('VALIDATION', 'minorIds must be unique');
  }
  return minorIds;
}

function parseAdditionalInvitation(body: unknown): CreateAdditionalResponsibleInvitationRequest {
  const record = asRecord(body);
  const base = parseBase(record, [...BASE_KEYS, 'intendedAdultId', 'minorIds']);
  return {
    ...base,
    intendedAdultId: safeIdentifier(record['intendedAdultId'], 'intendedAdultId'),
    minorIds: parseMinorIds(record),
  };
}

function parseScopeCommand(body: unknown): ReplaceAdditionalResponsibleScopeRequest {
  const record = asRecord(body);
  const base = parseBase(record, [...BASE_KEYS, 'minorIds']);
  return { ...base, minorIds: parseMinorIds(record) };
}

function parseTransfer(body: unknown): TransferPrimaryResponsibilityRequest {
  const record = asRecord(body);
  const base = parseBase(record, [...BASE_KEYS, 'newPrimaryAccountId']);
  return {
    ...base,
    newPrimaryAccountId: safeIdentifier(record['newPrimaryAccountId'], 'newPrimaryAccountId'),
  };
}

function repoDeps(ctx: Ctx) {
  return { ddb: ctx.deps.ddb, tableName: ctx.deps.table, now: ctx.deps.now };
}

async function explicitSnapshot(ctx: Ctx, householdId: string): Promise<HouseholdSnapshot> {
  const snapshot = await readHouseholdSnapshot(repoDeps(ctx), householdId);
  if (!snapshot) throw new ApiError('NOT_FOUND');
  return snapshot;
}

async function coverageOfConsistent(
  ctx: Ctx,
  accountId: string,
): Promise<CoverageAssignmentItem | null> {
  const response = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: FK.familyCoverage(accountId),
      ConsistentRead: true,
    }),
  );
  return (response.Item as CoverageAssignmentItem | undefined) ?? null;
}

async function familyEntitlementOfConsistent(
  ctx: Ctx,
  householdId: string,
): Promise<FamilyEntitlementItem | null> {
  const response = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: FK.familyEntitlement(householdId),
      ConsistentRead: true,
    }),
  );
  return (response.Item as FamilyEntitlementItem | undefined) ?? null;
}

async function requireFamilyEntitlement(
  ctx: Ctx,
  householdId: string,
  required: { readonly minorSeats: number; readonly additionalResponsibleSeat: number },
): Promise<FamilyEntitlementItem> {
  const entitlement = await familyEntitlementOfConsistent(ctx, householdId);
  if (!familyEntitlementAllows(entitlement, required, ctx.deps.now())) {
    throw new ApiError('PAYMENT_REQUIRED');
  }
  return entitlement!;
}

function familyEntitlementConditionCheck(
  ctx: Ctx,
  entitlement: FamilyEntitlementItem,
  required: { readonly minorSeats: number; readonly additionalResponsibleSeat: number },
): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: FK.familyEntitlement(entitlement.householdId),
      ConditionExpression: [
        'entityType = :entityType',
        'householdId = :householdId',
        'revision = :expectedRevision',
        'offerKey = :offerKey',
        '#source = :source',
        'minorSeats >= :requiredMinorSeats',
        'additionalResponsibleSeat >= :requiredAdditionalResponsibleSeat',
        entitlement.source === 'sponsored_pilot'
          ? '#state = :active'
          : '(((#state = :active OR #state = :scheduledEnd) AND paidThrough > :now) OR (#state = :grace AND graceUntil > :now))',
      ].join(' AND '),
      ExpressionAttributeNames: { '#state': 'state', '#source': 'source' },
      ExpressionAttributeValues: {
        ':entityType': 'FamilyEntitlement',
        ':householdId': entitlement.householdId,
        ':expectedRevision': entitlement.revision,
        ':offerKey': entitlement.offerKey,
        ':source': entitlement.source,
        ':requiredMinorSeats': required.minorSeats,
        ':requiredAdditionalResponsibleSeat': required.additionalResponsibleSeat,
        ':active': 'active',
        ...(entitlement.source === 'sponsored_pilot' ? {} : {
          ':scheduledEnd': 'scheduled_end',
          ':grace': 'grace',
          ':now': ctx.deps.now(),
        }),
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

async function primaryTransferOfConsistent(
  ctx: Ctx,
  householdId: string,
): Promise<PrimaryTransferProposalItem | null> {
  const response = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: FK.primaryTransfer(householdId),
      ConsistentRead: true,
    }),
  );
  return (response.Item as PrimaryTransferProposalItem | undefined) ?? null;
}

function writableMinorConditionChecks(ctx: Ctx, minorIds: readonly string[]): TransactItem[] {
  const today = new Date(ctx.deps.now()).toISOString().slice(0, 10);
  return [...new Set(minorIds)].flatMap((minorId): TransactItem[] => [
    { ConditionCheck: {
      TableName: ctx.deps.table, Key: K.profile(minorId),
      ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND userId = :minorId AND accountType = :minor AND (attribute_not_exists(majorityAt) OR majorityAt > :today)`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':minorId': minorId,
        ':minor': 'minor', ':today': today },
    } },
    closureAbsenceConditionCheck(ctx.deps, minorId),
  ]);
}

async function validatedPrimaryTransferState(
  ctx: Ctx,
  snapshot: HouseholdSnapshot,
  newPrimaryAccountId: string,
) {
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'assigned' || seat.accountId !== newPrimaryAccountId) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  const nextPrimary = await profileOfConsistent(ctx.deps, newPrimaryAccountId);
  if (!nextPrimary || nextPrimary.accountType !== 'adult') {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  if ((nextPrimary.status ?? 'active') !== 'active') throw new ApiError('CONFLICT');

  const minors = assignedMinorSeats(snapshot).map((minorSeat) => minorSeat.accountId!);
  const currentPrimaryLinks = snapshot.supervisionLinks.filter(
    (link) =>
      minors.includes(link.minorId) &&
      link.adultId === snapshot.household.primaryResponsibleId &&
      link.role === 'primary_responsible' &&
      link.state === 'active',
  );
  const nextPrimaryLinks = snapshot.supervisionLinks.filter(
    (link) =>
      minors.includes(link.minorId) &&
      link.adultId === newPrimaryAccountId &&
      link.role === 'additional_responsible' &&
      link.state === 'active',
  );
  if (
    minors.length < 1 ||
    currentPrimaryLinks.length !== minors.length ||
    nextPrimaryLinks.length !== minors.length
  ) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }

  const currentPrimaryCoverage = currentCoverage(
    snapshot,
    snapshot.household.primaryResponsibleId,
  );
  const nextPrimaryCoverage = currentCoverage(snapshot, newPrimaryAccountId);
  if (!currentPrimaryCoverage || !nextPrimaryCoverage) throw new ApiError('PAYMENT_REQUIRED');

  return {
    seat,
    minors,
    currentPrimaryLinks,
    nextPrimaryLinks,
    currentPrimaryCoverage,
    nextPrimaryCoverage,
  };
}

async function snapshotForCaller(ctx: Ctx): Promise<HouseholdSnapshot> {
  const deterministicId = householdIdForPrimary(ctx.callerId);
  const coverage = await coverageOfConsistent(ctx, ctx.callerId);
  if (coverage) {
    const covered = await readHouseholdSnapshot(repoDeps(ctx), coverage.householdId);
    if (covered) return covered;
  }
  const deterministic = await readHouseholdSnapshot(repoDeps(ctx), deterministicId);
  if (deterministic?.household.primaryResponsibleId === ctx.callerId) return deterministic;
  if (deterministic) return deterministic;
  throw new ApiError('NOT_FOUND');
}

function authorize(
  ctx: Ctx,
  snapshot: HouseholdSnapshot,
  action: FamilyAction,
  expectedHouseholdRevision?: number,
  targetAccountId?: string,
): void {
  const decision = authorizeFamilyAction({
    actor: {
      accountId: ctx.callerId,
      accountType: ctx.caller.accountType,
      status: ctx.caller.status ?? 'active',
      socialEnabled: ctx.caller.socialEnabled,
    },
    action,
    household: snapshot,
    targetAccountId,
    expectedHouseholdRevision,
    now: ctx.deps.now(),
  });
  if (!decision.allowed) throw new ApiError(decision.code);
}

function currentCoverage(
  snapshot: HouseholdSnapshot,
  accountId: string,
): CoverageAssignmentItem | null {
  return snapshot.coverages.find(
    (coverage) =>
      coverage.accountId === accountId &&
      coverage.householdId === snapshot.household.householdId &&
      coverage.state !== 'ended',
  ) ?? null;
}

function coverageAllowsNewFamilyAction(
  coverage: CoverageAssignmentItem | null,
  now: number,
): coverage is CoverageAssignmentItem {
  if (!coverage || (coverage.state !== 'active' && coverage.state !== 'scheduled_end')) {
    return false;
  }
  return coverage.source === 'sponsored_pilot'
    ? coverage.paidThrough === null
    : coverage.paidThrough !== null && coverage.paidThrough > now;
}

function inheritedCoverage(
  householdId: string,
  accountId: string,
  seatType: 'minor' | 'additional_responsible',
  payerCoverage: CoverageAssignmentItem,
  now: number,
): CoverageAssignmentItem {
  if (payerCoverage.source === 'sponsored_pilot') {
    return createCoverageAssignment({ householdId, accountId, seatType, source: 'sponsored_pilot', now });
  }
  if (payerCoverage.paidThrough === null) throw new ApiError('PAYMENT_REQUIRED');
  return createCoverageAssignment({
    householdId, accountId, seatType, paidThrough: payerCoverage.paidThrough,
    source: payerCoverage.source ?? 'subscription_projection', now,
  });
}

function assignedMinorSeats(snapshot: HouseholdSnapshot): MinorSeatAssignmentItem[] {
  return snapshot.seats.filter(
    (seat): seat is MinorSeatAssignmentItem =>
      seat.seatType === 'minor' && seat.state === 'assigned' && seat.accountId !== null,
  );
}

function emptyMinorSeat(snapshot: HouseholdSnapshot): MinorSeatAssignmentItem | null {
  return snapshot.seats.find(
    (seat): seat is MinorSeatAssignmentItem =>
      seat.seatType === 'minor' && seat.state === 'empty' && seat.accountId === null,
  ) ?? null;
}

function additionalSeat(snapshot: HouseholdSnapshot): AdditionalResponsibleSeatAssignmentItem {
  const seat = snapshot.seats.find(
    (candidate): candidate is AdditionalResponsibleSeatAssignmentItem =>
      candidate.seatType === 'additional_responsible',
  );
  if (!seat) throw new ApiError('CONFLICT', 'household has no additional seat');
  return seat;
}

function coverageState(
  snapshot: HouseholdSnapshot,
  accountId: string,
): HouseholdView['minors'][number]['coverageState'] {
  return snapshot.coverages.find(
    (coverage) =>
      coverage.accountId === accountId &&
      coverage.householdId === snapshot.household.householdId,
  )?.state ?? null;
}

async function householdView(
  ctx: Ctx,
  snapshot: HouseholdSnapshot,
  callerId = ctx.callerId,
): Promise<HouseholdView> {
  const allMinorSeats = assignedMinorSeats(snapshot).sort(
    (left, right) => left.seatNumber - right.seatNumber,
  );
  const extraSeat = additionalSeat(snapshot);
  const additionalCaller =
    extraSeat.state === 'assigned' && extraSeat.accountId === callerId;
  const visibleMinorIds = additionalCaller
    ? new Set(
        snapshot.supervisionLinks
          .filter(
            (link) =>
              link.adultId === callerId &&
              link.role === 'additional_responsible' &&
              link.state === 'active' &&
              link.validUntil === null &&
              link.validFrom <= ctx.deps.now(),
          )
          .map((link) => link.minorId),
      )
    : null;
  const minorSeats = visibleMinorIds
    ? allMinorSeats.filter((seat) => visibleMinorIds.has(seat.accountId!))
    : allMinorSeats;
  const participantIds = [
    snapshot.household.primaryResponsibleId,
    ...minorSeats.map((seat) => seat.accountId!),
    ...(extraSeat.accountId ? [extraSeat.accountId] : []),
  ];
  const profiles = await Promise.all(
    participantIds.map((accountId) => profileOfConsistent(ctx.deps, accountId)),
  );
  const byId = new Map(
    profiles.flatMap((profile) => (profile ? [[profile.userId, profile] as const] : [])),
  );
  const primary = byId.get(snapshot.household.primaryResponsibleId);
  if (!primary || primary.accountType !== 'adult') throw new ApiError('NOT_FOUND');

  const minors: HouseholdView['minors'] = minorSeats.map((seat) => {
    const profile = byId.get(seat.accountId!);
    if (!profile || profile.accountType !== 'minor') throw new ApiError('NOT_FOUND');
    return {
      user: toPublic(profile, true),
      seat: seat.seatNumber,
      majorityAt: profile.majorityAt ?? '9999-12-31',
      coverageState: coverageState(snapshot, profile.userId),
    };
  });

  let additionalResponsible: HouseholdView['additionalResponsible'] = null;
  if (extraSeat.state === 'assigned' && extraSeat.accountId !== null) {
    const profile = byId.get(extraSeat.accountId);
    if (!profile || profile.accountType !== 'adult') throw new ApiError('NOT_FOUND');
    additionalResponsible = {
      user: toPublic(profile, false),
      minorIds: snapshot.supervisionLinks
        .filter(
          (link) =>
            link.adultId === profile.userId &&
            link.role === 'additional_responsible' &&
            link.state === 'active' &&
            link.validUntil === null,
        )
        .map((link) => link.minorId)
        .sort(),
      coverageState: coverageState(snapshot, profile.userId),
    };
  }

  const myRole =
    snapshot.household.primaryResponsibleId === callerId
      ? 'primary_responsible'
      : extraSeat.state === 'assigned' && extraSeat.accountId === callerId
        ? 'additional_responsible'
        : null;
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    householdId: snapshot.household.householdId,
    country: snapshot.household.country,
    state: snapshot.household.state,
    myRole,
    primaryResponsible: toPublic(primary, false),
    familyCoverage: (() => {
      const coverage = snapshot.coverages.find((item) =>
        item.accountId === primary.userId && item.householdId === snapshot.household.householdId);
      return coverage ? { source: coverage.source, state: coverage.state } : null;
    })(),
    additionalResponsible,
    minors,
    availableMinorSeats: (2 - allMinorSeats.length) as 0 | 1 | 2,
    additionalResponsibleSeatAvailable: extraSeat.state === 'empty',
    revision: snapshot.household.revision,
  };
}

async function refreshedView(ctx: Ctx, householdId: string): Promise<HouseholdView> {
  return householdView(ctx, await explicitSnapshot(ctx, householdId));
}

function noticeKey(noticeId: string): { pk: string; sk: 'META' } {
  safeIdentifier(noticeId, 'noticeId');
  return { pk: `FAMILY_NOTICE#${noticeId}`, sk: 'META' };
}

function noticeId(prefix: 'mlr' | 'ari', ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}_${digest}`;
}

async function readNotice(ctx: Ctx, id: string): Promise<FamilyNoticeItem | null> {
  const response = await ctx.deps.ddb.send(
    new GetCommand({ TableName: ctx.deps.table, Key: noticeKey(id), ConsistentRead: true }),
  );
  return (response.Item as FamilyNoticeItem | undefined) ?? null;
}

function exactUnexpiredLegacyInviteDelete(
  ctx: Ctx,
  invite: CodeItem,
  now: number,
): TransactItem {
  return {
    Delete: {
      TableName: ctx.deps.table,
      Key: K.codeG(invite.code),
      ConditionExpression: [
        'attribute_exists(pk)',
        '#code = :code',
        '#kind = :kind',
        'userId = :userId',
        invite.minorId === undefined ? 'attribute_not_exists(minorId)' : 'minorId = :minorId',
        'expiresAt = :expiresAt',
        'expiresAt > :now',
        '#ttl = :ttl',
        invite.closureMirrorVersion === undefined
          ? 'attribute_not_exists(closureMirrorVersion)'
          : 'closureMirrorVersion = :closureMirrorVersion',
      ].join(' AND '),
      ExpressionAttributeNames: { '#code': 'code', '#kind': 'kind', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':code': invite.code,
        ':kind': invite.kind,
        ':userId': invite.userId,
        ...(invite.minorId === undefined ? {} : { ':minorId': invite.minorId }),
        ':expiresAt': invite.expiresAt,
        ':now': now,
        ':ttl': invite.ttl,
        ...(invite.closureMirrorVersion === undefined
          ? {}
          : { ':closureMirrorVersion': invite.closureMirrorVersion }),
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

function legacyInviteDeleteOperations(
  ctx: Ctx,
  invite: CodeItem,
  now: number,
): TransactItem[] {
  return [
    exactUnexpiredLegacyInviteDelete(ctx, invite, now),
    ...(invite.closureMirrorVersion === 1
      ? guardianInviteMirrors(invite).map((mirror) =>
          idempotentGuardianInviteMirrorDelete(ctx.deps, mirror),
        )
      : []),
  ];
}

function householdRevisionUpdate(
  ctx: Ctx,
  snapshot: HouseholdSnapshot,
  expectedRevision: number,
  now: number,
): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: FK.household(snapshot.household.householdId),
      UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :primaryResponsibleId',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':expectedRevision': expectedRevision,
        ':nextRevision': nextRevision(snapshot.household.revision, expectedRevision),
        ':active': 'active',
        ':primaryResponsibleId': snapshot.household.primaryResponsibleId,
        ':now': now,
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

function exactHouseholdCheck(
  ctx: Ctx,
  snapshot: HouseholdSnapshot,
  expectedRevision: number,
): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: FK.household(snapshot.household.householdId),
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :primaryResponsibleId',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':expectedRevision': expectedRevision,
        ':active': 'active',
        ':primaryResponsibleId': snapshot.household.primaryResponsibleId,
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

async function transact(ctx: Ctx, items: readonly TransactItem[]): Promise<void> {
  if (items.length > 100) throw new Error('family transaction exceeds DynamoDB limit');
  try {
    await ctx.deps.ddb.send(
      new TransactWriteCommand({ TransactItems: [...items] }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') {
      throw new ApiError('STALE_REVISION');
    }
    throw error;
  }
}

function minorLinkView(notice: FamilyNoticeItem, profile: ProfileItem): MinorLinkRequestView {
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    requestId: notice.noticeId,
    householdId: notice.householdId,
    minor: toPublic(profile, true),
    state:
      notice.state === 'accepted'
        ? 'accepted'
        : notice.state === 'approved'
          ? 'approved'
          : 'pending',
    expiresAt: notice.expiresAt,
    revision: notice.revision,
  };
}

function invitationView(notice: FamilyNoticeItem): AdditionalResponsibleInvitationView {
  if (!notice.intendedAdultId) throw new ApiError('NOT_FOUND');
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    invitationId: notice.noticeId,
    householdId: notice.householdId,
    intendedAdultId: notice.intendedAdultId,
    minorIds: [...notice.minorIds],
    state: notice.state === 'accepted' ? 'accepted' : 'pending',
    expiresAt: notice.expiresAt,
    revision: notice.revision,
  };
}

export async function getHousehold(ctx: Ctx): Promise<HouseholdView> {
  const snapshot = await snapshotForCaller(ctx);
  authorize(ctx, snapshot, 'read_household');
  return householdView(ctx, snapshot);
}

function legacyLinkItem(
  guardianId: string,
  minorId: string,
  kind: LinkItem['kind'],
  now: number,
): LinkItem {
  return {
    ...K.link(minorId, guardianId),
    gsi1pk: K.user(guardianId),
    gsi1sk: `MINOR#${minorId}`,
    linkId: composite.linkId(guardianId, minorId),
    kind,
    guardianId,
    minorId,
    createdAt: now,
  };
}

function addLegacyCreatedMinorToFence(
  ctx: Ctx,
  guardianId: string,
  minorId: string,
): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: K.profile(guardianId),
      UpdateExpression: 'ADD createdMinorIds :createdMinorIds',
      ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND ((attribute_not_exists(familyFenceVersion) OR familyFenceVersion = :familyFenceVersion) AND (attribute_not_exists(createdMinorIds) OR size(createdMinorIds) < :maxCreatedMinors))`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':familyFenceVersion': FAMILY_FENCE_VERSION,
        ':createdMinorIds': new Set([minorId]),
        ':maxCreatedMinors': LIMITS.maxChildrenPerGuardian,
      },
    },
  };
}

interface MinorAuthorityCreationInput {
  readonly snapshot: HouseholdSnapshot;
  readonly expectedHouseholdRevision: number;
  readonly username: string;
  readonly displayName: string;
  readonly majorityAt: string | null;
  readonly consent: {
    readonly declarationVersion: typeof CURRENT_MINOR_DECLARATION_VERSION;
    readonly consentVersion: typeof CURRENT_MINOR_CONSENT_VERSION;
    readonly commandId: string;
    readonly policyVersion: typeof FAMILY_POLICY_VERSION;
  } | null;
  readonly writeLegacyCompatibility: boolean;
}

async function createMinorWithAuthority(
  ctx: Ctx,
  input: MinorAuthorityCreationInput,
): Promise<{ readonly minor: UserProfile; readonly tempPassword: string }> {
  const snapshot = input.snapshot;
  authorize(
    ctx,
    snapshot,
    'create_minor',
    input.expectedHouseholdRevision,
  );
  requireRecentFamilyAuthentication(ctx);
  const seat = emptyMinorSeat(snapshot);
  if (!seat) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const requiredMinorSeats = assignedMinorSeats(snapshot).length + 1;
  const entitlement = await requireFamilyEntitlement(ctx, snapshot.household.householdId, {
    minorSeats: requiredMinorSeats,
    additionalResponsibleSeat: 0,
  });
  const payerCoverage = currentCoverage(snapshot, ctx.callerId);
  const now = ctx.deps.now();
  if ((input.majorityAt === null) !== (input.consent === null)) {
    throw new Error('minor legal evidence must be complete or absent');
  }
  if (entitlement.source === 'sponsored_pilot' && input.majorityAt === null) {
    throw new ApiError('VALIDATION', 'pilot minors require a majority date and consent');
  }
  if (input.majorityAt !== null) {
    const majorityTime = Date.parse(`${input.majorityAt}T00:00:00.000Z`);
    if (
      majorityTime <= now ||
      majorityTime > now + 18 * 366 * 24 * 60 * 60 * 1_000
    ) {
      throw new ApiError('VALIDATION', 'majorityAt must describe a current minor');
    }
  }
  if (
    !coverageAllowsNewFamilyAction(payerCoverage, now)
  ) {
    throw new ApiError('PAYMENT_REQUIRED');
  }

  const password = tempPassword();
  let cognitoUsernameCreated = false;
  let familyStateCommitted = false;
  try {
    const created = await ctx.deps.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: ctx.deps.userPoolId,
        Username: input.username,
        TemporaryPassword: password,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'name', Value: input.displayName },
          { Name: 'custom:accountType', Value: 'minor' },
        ],
      }),
    );
    cognitoUsernameCreated = true;
    const minorId = created.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    if (!minorId) throw new Error('Cognito did not return a sub for the minor');
    safeIdentifier(minorId, 'minorId');

    const child: ProfileItem = {
      ...K.profile(minorId),
      userId: minorId,
      username: input.username,
      displayName: input.displayName,
      accountType: 'minor',
      socialEnabled: false,
      createdAt: now,
      status: 'active',
      ...(input.majorityAt === null ? {} : {
        majorityAt: input.majorityAt,
        gsi2pk: 'FAMILY#MAJORITY',
        gsi2sk: `${input.majorityAt}#${minorId}`,
      }),
    };
    const primaryLink = createSupervisionLink({
      householdId: snapshot.household.householdId,
      adultId: snapshot.household.primaryResponsibleId,
      minorId,
      role: 'primary_responsible',
      now,
    });
    const minorCoverage = inheritedCoverage(snapshot.household.householdId, minorId, 'minor', payerCoverage, now);
    const consent = input.consent && input.majorityAt
      ? createMinorConsentAcceptance({
          householdId: snapshot.household.householdId,
          minorId,
          actorId: ctx.callerId,
          majorityAt: input.majorityAt,
          declarationVersion: input.consent.declarationVersion,
          consentVersion: input.consent.consentVersion,
          commandId: input.consent.commandId,
          policyVersion: input.consent.policyVersion,
          now,
        })
      : null;
    const assignment = buildAssignMinorTransaction({
      tableName: ctx.deps.table,
      household: snapshot.household,
      seat,
      minorId,
      primaryLink,
      coverage: minorCoverage,
      expectedHouseholdRevision: input.expectedHouseholdRevision,
      expectedSeatRevision: seat.revision,
      now,
    });
    const legacyLink = input.writeLegacyCompatibility
      ? legacyLinkItem(ctx.callerId, minorId, 'created', now)
      : null;
    const items: TransactItem[] = [
      ...(assignment.TransactItems ?? []),
      familyEntitlementConditionCheck(ctx, entitlement, {
        minorSeats: requiredMinorSeats,
        additionalResponsibleSeat: 0,
      }),
      ...(input.writeLegacyCompatibility
        ? [closureAbsenceConditionCheck(ctx.deps, ctx.callerId)]
        : writableOwnerConditionChecks(ctx.deps, ctx.callerId)),
      closureAbsenceConditionCheck(ctx.deps, minorId),
      {
        Put: {
          TableName: ctx.deps.table,
          Item: child,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: { ...K.uniqUsername(input.username), userId: minorId },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: deriveAccessItem(minorId, now, undefined, []),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: { pk: K.user(minorId), sk: 'USAGE', state: 'active', activeTrees: 0 },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      ...(consent
        ? [{
            Put: {
              TableName: ctx.deps.table,
              Item: consent,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          } satisfies TransactItem]
        : []),
      ...(legacyLink
        ? [
            {
              Put: {
                TableName: ctx.deps.table,
                Item: legacyLink,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              },
            } satisfies TransactItem,
            addLegacyCreatedMinorToFence(ctx, ctx.callerId, minorId),
          ]
        : []),
    ];
    try {
      await ctx.deps.ddb.send(new TransactWriteCommand({ TransactItems: items }));
      familyStateCommitted = true;
    } catch (error) {
      const cancellation = classifyFamilyTransactionCancellation('assign_minor', error);
      if (cancellation?.kind === 'stale_household_revision') throw new ApiError('STALE_REVISION');
      if (cancellation?.kind === 'seat_conflict') {
        throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
      }
      if (cancellation?.kind === 'coverage_conflict') {
        throw new ApiError('MINOR_ALREADY_COVERED');
      }
      if ((error as { name?: string }).name === 'TransactionCanceledException') {
        throw new ApiError('CONFLICT');
      }
      throw error;
    }
    return {
      minor: {
      userId: child.userId,
      username: child.username,
      displayName: child.displayName,
      accountType: 'minor',
      socialEnabled: false,
      createdAt: child.createdAt,
      },
      tempPassword: password,
    };
  } catch (error) {
    if (cognitoUsernameCreated && !familyStateCommitted) {
      await ctx.deps.cognito
        .send(
          new AdminDeleteUserCommand({
            UserPoolId: ctx.deps.userPoolId,
            Username: input.username,
          }),
        )
        .catch(() => undefined);
    }
    if ((error as { name?: string }).name === 'UsernameExistsException') {
      throw new ApiError('USERNAME_TAKEN');
    }
    throw error;
  }
}

export async function createMinor(ctx: Ctx, body: unknown): Promise<CreateMinorResponse> {
  const request = parseCreateMinor(body);
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  const result = await createMinorWithAuthority(ctx, {
    snapshot,
    expectedHouseholdRevision: request.expectedHouseholdRevision,
    username: request.username,
    displayName: request.username,
    majorityAt: request.majorityAt,
    consent: {
      declarationVersion: CURRENT_MINOR_DECLARATION_VERSION,
      consentVersion: CURRENT_MINOR_CONSENT_VERSION,
      commandId: request.commandId,
      policyVersion: FAMILY_POLICY_VERSION,
    },
    writeLegacyCompatibility: false,
  });
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    household: await refreshedView(ctx, request.householdId),
    ...result,
  };
}

export async function createMinorFromLegacy(
  ctx: Ctx,
  input: { readonly username: string; readonly displayName: string },
): Promise<{ readonly minor: UserProfile; readonly tempPassword: string }> {
  const snapshot = await snapshotForCaller(ctx);
  return createMinorWithAuthority(ctx, {
    snapshot,
    expectedHouseholdRevision: snapshot.household.revision,
    username: input.username,
    displayName: input.displayName,
    majorityAt: null,
    consent: null,
    writeLegacyCompatibility: true,
  });
}

/** A source primary shares a one-use code for a specific existing minor. */
export async function createMinorLinkCode(ctx: Ctx, body: unknown): Promise<CodeGrant> {
  const record = asRecord(body);
  assertExactKeys(record, ['minorId']);
  const request: CreateMinorLinkCodeRequest = {
    minorId: safeIdentifier(record['minorId'], 'minorId'),
  };
  const source = await explicitSnapshot(ctx, householdIdForPrimary(ctx.callerId));
  authorize(ctx, source, 'approve_minor_link', source.household.revision, request.minorId);
  requireRecentFamilyAuthentication(ctx);
  const seat = assignedMinorSeats(source).find((row) => row.accountId === request.minorId);
  if (!seat) throw new ApiError('NOT_FOUND');
  const minor = await profileOfConsistent(ctx.deps, request.minorId);
  if (!minor || minor.accountType !== 'minor' ||
    (minor.status ?? 'active') !== 'active' ||
    !minor.majorityAt || minor.majorityAt <= new Date(ctx.deps.now()).toISOString().slice(0, 10)) {
    throw new ApiError('NOT_FOUND');
  }
  const now = ctx.deps.now();
  const code = friendCode();
  const expiresAt = now + FAMILY_NOTICE_TTL_MS;
  const grant: CodeItem = {
    ...K.codeG(code), code, kind: 'linkExisting', userId: ctx.callerId,
    minorId: request.minorId, closureMirrorVersion: 1,
    expiresAt, ttl: Math.ceil(expiresAt / 1000),
  };
  await transact(ctx, [
    exactHouseholdCheck(ctx, source, source.household.revision),
    { ConditionCheck: {
      TableName: ctx.deps.table,
      Key: FK.minorSeat(source.household.householdId, seat.seatNumber),
      ConditionExpression: 'entityType = :entityType AND #state = :assigned AND accountId = :minorId AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'SeatAssignment', ':assigned': 'assigned',
        ':minorId': request.minorId, ':revision': seat.revision },
    } },
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableMinorConditionChecks(ctx, [request.minorId]),
    { Put: { TableName: ctx.deps.table, Item: grant,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' } },
    ...guardianInviteMirrors(grant).map((mirror): TransactItem => ({ Put: {
      TableName: ctx.deps.table, Item: mirror,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    } })),
  ]);
  return { code, expiresAt };
}

export async function createMinorLinkRequest(
  ctx: Ctx,
  body: unknown,
): Promise<MinorLinkRequestView> {
  const request = parseCodeCommand(body);
  const target = await explicitSnapshot(ctx, request.householdId);
  authorize(
    ctx,
    target,
    'create_minor_link_request',
    request.expectedHouseholdRevision,
  );
  if (!emptyMinorSeat(target)) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');

  await reserveCodeAttempt(ctx);

  const grantResult = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: K.codeG(request.code),
      ConsistentRead: true,
    }),
  );
  const grant = grantResult.Item as CodeItem | undefined;
  const now = ctx.deps.now();
  if (!grant || grant.kind !== 'linkExisting' || !grant.minorId) {
    throw new ApiError('CODE_INVALID');
  }
  if (grant.expiresAt <= now) throw new ApiError('CODE_EXPIRED');
  const minor = await profileOfConsistent(ctx.deps, grant.minorId);
  if (!minor || minor.accountType !== 'minor' || !minor.majorityAt ||
    minor.majorityAt <= new Date(now).toISOString().slice(0, 10)) {
    throw new ApiError('CODE_INVALID');
  }
  const coverage = await coverageOfConsistent(ctx, minor.userId);
  if (!coverage) throw new ApiError('CODE_INVALID');
  const source = await readHouseholdSnapshot(repoDeps(ctx), coverage.householdId);
  if (!source) throw new ApiError('CODE_INVALID');
  if (
    source.household.primaryResponsibleId !== grant.userId ||
    source.household.householdId === target.household.householdId ||
    !assignedMinorSeats(source).some((seat) => seat.accountId === minor.userId)
  ) {
    throw new ApiError('CODE_INVALID');
  }
  const id = noticeId('mlr', request.householdId, request.commandId);
  const notice: FamilyNoticeItem = {
    ...noticeKey(id),
    entityType: 'FamilyNotice',
    noticeId: id,
    kind: 'minor_link_request',
    householdId: target.household.householdId,
    targetHouseholdRevision: target.household.revision,
    createdById: ctx.callerId,
    minorId: minor.userId,
    minorIds: [minor.userId],
    sourceHouseholdId: source.household.householdId,
    sourceHouseholdRevision: source.household.revision,
    sourcePrimaryId: source.household.primaryResponsibleId,
    intendedAdultId: null,
    acceptedById: null,
    sourceApprovalCommandId: null,
    sourceApprovedAt: null,
    acceptanceCommandId: null,
    state: 'pending',
    createdAt: now,
    expiresAt: Math.min(grant.expiresAt, now + FAMILY_NOTICE_TTL_MS),
    revision: 1,
    commandId: request.commandId,
    policyVersion: FAMILY_POLICY_VERSION,
    code: request.code,
  };
  await transact(ctx, [
    exactHouseholdCheck(ctx, target, request.expectedHouseholdRevision),
    exactHouseholdCheck(ctx, source, source.household.revision),
    ...[...new Set([ctx.callerId, source.household.primaryResponsibleId, minor.userId])]
      .flatMap((recipientId) => writableOwnerConditionChecks(ctx.deps, recipientId)),
    ...familyInboxWrites(ctx, notice, [notice.createdById, notice.sourcePrimaryId, notice.intendedAdultId, notice.minorId]),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: notice,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    },
  ]);
  return minorLinkView(notice, minor);
}

export async function approveMinorLinkRequest(
  ctx: Ctx,
  requestId: string,
  body: unknown,
): Promise<MinorLinkRequestView> {
  const request = parseCommand(body) as ApproveMinorLinkRequest;
  safeIdentifier(requestId, 'requestId');
  const notice = await readNotice(ctx, requestId);
  const now = ctx.deps.now();
  if (
    !notice ||
    notice.kind !== 'minor_link_request' ||
    notice.expiresAt <= now ||
    !notice.minorId ||
    !notice.sourceHouseholdId ||
    notice.sourceHouseholdRevision === null ||
    !notice.sourcePrimaryId
  ) {
    throw new ApiError('NOT_FOUND');
  }
  if (request.householdId !== notice.householdId) throw new ApiError('NOT_FOUND');
  if (ctx.callerId !== notice.sourcePrimaryId) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  if (
    notice.state === 'approved' &&
    notice.sourceApprovalCommandId === request.commandId &&
    notice.sourceApprovedAt !== null &&
    request.expectedHouseholdRevision === notice.targetHouseholdRevision
  ) {
    const [source, minor] = await Promise.all([
      explicitSnapshot(ctx, notice.sourceHouseholdId),
      profileOfConsistent(ctx.deps, notice.minorId),
    ]);
    if (source.household.primaryResponsibleId !== ctx.callerId) {
      throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
    }
    authorize(ctx, source, 'approve_minor_link', undefined, notice.minorId);
    requireRecentFamilyAuthentication(ctx);
    if (!minor || minor.accountType !== 'minor' ||
      (minor.majorityAt !== undefined &&
        minor.majorityAt <= new Date(now).toISOString().slice(0, 10))) throw new ApiError('NOT_FOUND');
    return minorLinkView(notice, minor);
  }
  if (notice.state !== 'pending') throw new ApiError('NOT_FOUND');
  const [source, target] = await Promise.all([
    explicitSnapshot(ctx, notice.sourceHouseholdId),
    explicitSnapshot(ctx, notice.householdId),
  ]);
  if (
    source.household.primaryResponsibleId !== ctx.callerId ||
    source.household.revision !== notice.sourceHouseholdRevision ||
    target.household.primaryResponsibleId !== notice.createdById ||
    target.household.revision !== notice.targetHouseholdRevision ||
    target.household.revision !== request.expectedHouseholdRevision
  ) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  authorize(
    ctx,
    source,
    'approve_minor_link',
    source.household.revision,
    notice.minorId,
  );
  requireRecentFamilyAuthentication(ctx);
  const sourceSeat = assignedMinorSeats(source).find((seat) => seat.accountId === notice.minorId);
  const targetSeat = emptyMinorSeat(target);
  if (!sourceSeat) throw new ApiError('NOT_FOUND');
  if (!targetSeat) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const minor = await profileOfConsistent(ctx.deps, notice.minorId);
  if (!minor || minor.accountType !== 'minor' ||
    (minor.majorityAt !== undefined &&
      minor.majorityAt <= new Date(now).toISOString().slice(0, 10))) throw new ApiError('NOT_FOUND');

  const approvedNotice: FamilyNoticeItem = {
    ...notice,
    state: 'approved',
    sourceApprovalCommandId: request.commandId,
    sourceApprovedAt: now,
    revision: nextRevision(notice.revision, notice.revision),
  };
  await transact(ctx, [
    exactHouseholdCheck(ctx, source, notice.sourceHouseholdRevision),
    exactHouseholdCheck(ctx, target, notice.targetHouseholdRevision),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: noticeKey(notice.noticeId),
        UpdateExpression:
          'SET #state = :approved, sourceApprovalCommandId = :sourceApprovalCommandId, sourceApprovedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :pending AND householdId = :targetHouseholdId AND targetHouseholdRevision = :targetHouseholdRevision AND sourceHouseholdId = :sourceHouseholdId AND sourceHouseholdRevision = :sourceHouseholdRevision AND sourcePrimaryId = :sourcePrimaryId AND createdById = :targetPrimaryId AND expiresAt > :now',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': notice.revision,
          ':nextRevision': approvedNotice.revision,
          ':pending': 'pending',
          ':approved': 'approved',
          ':targetHouseholdId': notice.householdId,
          ':targetHouseholdRevision': notice.targetHouseholdRevision,
          ':sourceHouseholdId': notice.sourceHouseholdId,
          ':sourceHouseholdRevision': notice.sourceHouseholdRevision,
          ':sourcePrimaryId': ctx.callerId,
          ':targetPrimaryId': notice.createdById,
          ':sourceApprovalCommandId': request.commandId,
          ':now': now,
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableOwnerConditionChecks(ctx.deps, target.household.primaryResponsibleId),
    ...writableMinorConditionChecks(ctx, [notice.minorId]),
  ]);
  return minorLinkView(approvedNotice, minor);
}

export async function acceptMinorLinkRequest(
  ctx: Ctx,
  requestId: string,
  body: unknown,
): Promise<HouseholdView> {
  const request = parseAcceptMinorLink(body);
  safeIdentifier(requestId, 'requestId');
  const notice = await readNotice(ctx, requestId);
  const now = ctx.deps.now();
  if (
    !notice ||
    notice.kind !== 'minor_link_request' ||
    !notice.minorId ||
    !notice.sourceHouseholdId ||
    notice.sourceHouseholdRevision === null ||
    !notice.sourcePrimaryId ||
    !notice.sourceApprovalCommandId ||
    notice.sourceApprovedAt === null
  ) {
    throw new ApiError('NOT_FOUND');
  }
  if (request.householdId !== notice.householdId) throw new ApiError('NOT_FOUND');
  if (
    notice.state === 'accepted' &&
    notice.acceptedById === ctx.callerId &&
    notice.createdById === ctx.callerId &&
    notice.acceptanceCommandId === request.commandId &&
    request.expectedHouseholdRevision === notice.targetHouseholdRevision
  ) {
    const target = await explicitSnapshot(ctx, notice.householdId);
    authorize(ctx, target, 'read_household');
    requireRecentFamilyAuthentication(ctx);
    return householdView(ctx, target);
  }
  if (notice.state !== 'approved' || notice.expiresAt <= now) {
    throw new ApiError('NOT_FOUND');
  }
  if (ctx.callerId !== notice.createdById) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  const [source, target] = await Promise.all([
    explicitSnapshot(ctx, notice.sourceHouseholdId),
    explicitSnapshot(ctx, notice.householdId),
  ]);
  if (
    source.household.primaryResponsibleId !== notice.sourcePrimaryId ||
    source.household.revision !== notice.sourceHouseholdRevision ||
    target.household.primaryResponsibleId !== ctx.callerId ||
    target.household.revision !== notice.targetHouseholdRevision ||
    target.household.revision !== request.expectedHouseholdRevision
  ) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  authorize(
    ctx,
    target,
    'accept_minor_link',
    request.expectedHouseholdRevision,
    notice.minorId,
  );
  requireRecentFamilyAuthentication(ctx);
  const sourceSeat = assignedMinorSeats(source).find((seat) => seat.accountId === notice.minorId);
  const targetSeat = emptyMinorSeat(target);
  if (!sourceSeat) throw new ApiError('NOT_FOUND');
  if (!targetSeat) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const requiredMinorSeats = assignedMinorSeats(target).length + 1;
  const entitlement = await requireFamilyEntitlement(ctx, target.household.householdId, {
    minorSeats: requiredMinorSeats,
    additionalResponsibleSeat: 0,
  });
  const targetCoverage = currentCoverage(target, target.household.primaryResponsibleId);
  if (!coverageAllowsNewFamilyAction(targetCoverage, now)) throw new ApiError('PAYMENT_REQUIRED');
  const oldCoverage = source.coverages.find((item) => item.accountId === notice.minorId) ?? null;
  const activeSourceLinks = source.supervisionLinks.filter(
    (link) => link.minorId === notice.minorId && link.state === 'active',
  );
  const oldPrimary = activeSourceLinks.find((link) => link.role === 'primary_responsible');
  if (!oldPrimary) throw new ApiError('NOT_FOUND');
  const sourceExtraSeat = additionalSeat(source);
  const movedAdditionalLink =
    sourceExtraSeat.state === 'assigned' &&
    sourceExtraSeat.accountId !== null &&
    activeSourceLinks.some(
      (link) =>
        link.role === 'additional_responsible' &&
        link.adultId === sourceExtraSeat.accountId,
    );
  const additionalKeepsAnotherMinor =
    sourceExtraSeat.state === 'assigned' &&
    sourceExtraSeat.accountId !== null &&
    source.supervisionLinks.some(
      (link) =>
        link.role === 'additional_responsible' &&
        link.adultId === sourceExtraSeat.accountId &&
        link.minorId !== notice.minorId &&
        link.state === 'active',
    );
  const clearSourceAdditionalSeat = movedAdditionalLink && !additionalKeepsAnotherMinor;
  const sourceAdditionalCoverage = sourceExtraSeat.accountId
    ? source.coverages.find((item) => item.accountId === sourceExtraSeat.accountId) ?? null
    : null;
  const newPrimary = createSupervisionLink({
    householdId: target.household.householdId,
    adultId: target.household.primaryResponsibleId,
    minorId: notice.minorId,
    role: 'primary_responsible',
    now,
  });
  const acceptance = createMinorLinkAcceptance({
    requestId: notice.noticeId,
    minorId: notice.minorId,
    sourceHouseholdId: source.household.householdId,
    targetHouseholdId: target.household.householdId,
    sourcePrimaryId: notice.sourcePrimaryId,
    targetPrimaryId: ctx.callerId,
    responsibilityVersion: request.responsibilityVersion,
    privacyVersion: request.privacyVersion,
    requestCommandId: notice.commandId,
    sourceApprovalCommandId: notice.sourceApprovalCommandId,
    acceptanceCommandId: request.commandId,
    policyVersion: request.policyVersion,
    sourceApprovedAt: notice.sourceApprovedAt,
    now,
  });
  const items: TransactItem[] = [
    householdRevisionUpdate(ctx, source, notice.sourceHouseholdRevision, now),
    householdRevisionUpdate(ctx, target, request.expectedHouseholdRevision, now),
    familyEntitlementConditionCheck(ctx, entitlement, {
      minorSeats: requiredMinorSeats,
      additionalResponsibleSeat: 0,
    }),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.minorSeat(source.household.householdId, sourceSeat.seatNumber),
        UpdateExpression:
          'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :assigned AND accountId = :minorId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': sourceSeat.revision,
          ':nextRevision': nextRevision(sourceSeat.revision, sourceSeat.revision),
          ':assigned': 'assigned',
          ':empty': 'empty',
          ':emptyAccountId': null,
          ':emptyAssignedAt': null,
          ':minorId': notice.minorId,
          ':now': now,
        },
      },
    },
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.minorSeat(target.household.householdId, targetSeat.seatNumber),
        UpdateExpression:
          'SET #state = :assigned, accountId = :minorId, assignedAt = :now, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :empty AND accountId = :emptyAccountId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': targetSeat.revision,
          ':nextRevision': nextRevision(targetSeat.revision, targetSeat.revision),
          ':empty': 'empty',
          ':assigned': 'assigned',
          ':emptyAccountId': null,
          ':minorId': notice.minorId,
          ':now': now,
        },
      },
    },
    ...activeSourceLinks.map<TransactItem>((link) => ({
      Update: {
        TableName: ctx.deps.table,
        Key: FK.supervision(link.minorId, link.adultId),
        UpdateExpression:
          'SET #state = :ended, validUntil = :now, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :active AND householdId = :householdId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': link.revision,
          ':nextRevision': nextRevision(link.revision, link.revision),
          ':active': 'active',
          ':ended': 'ended',
          ':householdId': source.household.householdId,
          ':now': now,
        },
      },
    })),
    ...(clearSourceAdditionalSeat && sourceExtraSeat.accountId
      ? [
          {
            Update: {
              TableName: ctx.deps.table,
              Key: FK.additionalSeat(source.household.householdId),
              UpdateExpression:
                'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
              ConditionExpression:
                'revision = :expectedRevision AND #state = :assigned AND accountId = :additionalId',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':expectedRevision': sourceExtraSeat.revision,
                ':nextRevision': nextRevision(sourceExtraSeat.revision, sourceExtraSeat.revision),
                ':assigned': 'assigned',
                ':empty': 'empty',
                ':emptyAccountId': null,
                ':emptyAssignedAt': null,
                ':additionalId': sourceExtraSeat.accountId,
                ':now': now,
              },
            },
          } as TransactItem,
          ...(sourceAdditionalCoverage && sourceAdditionalCoverage.state !== 'ended'
            ? [{
                Update: {
                  TableName: ctx.deps.table,
                  Key: FK.familyCoverage(sourceExtraSeat.accountId),
                  UpdateExpression:
                    'SET #state = :ended, updatedAt = :now, revision = :nextRevision',
                  ConditionExpression:
                    'revision = :expectedRevision AND #state <> :ended AND householdId = :householdId',
                  ExpressionAttributeNames: { '#state': 'state' },
                  ExpressionAttributeValues: {
                    ':expectedRevision': sourceAdditionalCoverage.revision,
                    ':nextRevision': nextRevision(
                      sourceAdditionalCoverage.revision,
                      sourceAdditionalCoverage.revision,
                    ),
                    ':ended': 'ended',
                    ':householdId': source.household.householdId,
                    ':now': now,
                  },
                },
              } as TransactItem]
            : []),
        ]
      : []),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: newPrimary,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    },
    oldCoverage
      ? {
          Update: {
            TableName: ctx.deps.table,
            Key: FK.familyCoverage(notice.minorId),
            UpdateExpression:
              'SET householdId = :targetHouseholdId, #state = :active, paidThrough = :paidThrough, #source = :source, graceUntil = :noGrace, updatedAt = :now, revision = :nextRevision',
            ConditionExpression:
              'revision = :expectedRevision AND householdId = :sourceHouseholdId AND accountId = :minorId',
            ExpressionAttributeNames: { '#state': 'state', '#source': 'source' },
            ExpressionAttributeValues: {
              ':expectedRevision': oldCoverage.revision,
              ':nextRevision': nextRevision(oldCoverage.revision, oldCoverage.revision),
              ':sourceHouseholdId': source.household.householdId,
              ':targetHouseholdId': target.household.householdId,
              ':minorId': notice.minorId,
              ':active': 'active',
              ':paidThrough': targetCoverage.paidThrough,
              ':source': targetCoverage.source,
              ':noGrace': null,
              ':now': now,
            },
          },
        }
      : {
          Put: {
            TableName: ctx.deps.table,
            Item: inheritedCoverage(target.household.householdId, notice.minorId, 'minor', targetCoverage, now),
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: acceptance,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    {
      Update: {
        TableName: ctx.deps.table,
        Key: noticeKey(notice.noticeId),
        UpdateExpression:
          'SET #state = :accepted, acceptedById = :acceptedById, acceptanceCommandId = :acceptanceCommandId, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :approved AND householdId = :targetHouseholdId AND targetHouseholdRevision = :targetHouseholdRevision AND sourceHouseholdId = :sourceHouseholdId AND sourceHouseholdRevision = :sourceHouseholdRevision AND sourcePrimaryId = :sourcePrimaryId AND createdById = :targetPrimaryId AND sourceApprovalCommandId = :sourceApprovalCommandId AND sourceApprovedAt = :sourceApprovedAt AND expiresAt > :now',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': notice.revision,
          ':nextRevision': nextRevision(notice.revision, notice.revision),
          ':approved': 'approved',
          ':accepted': 'accepted',
          ':acceptedById': ctx.callerId,
          ':acceptanceCommandId': request.commandId,
          ':targetHouseholdId': notice.householdId,
          ':targetHouseholdRevision': notice.targetHouseholdRevision,
          ':sourceHouseholdId': notice.sourceHouseholdId,
          ':sourceHouseholdRevision': notice.sourceHouseholdRevision,
          ':sourcePrimaryId': notice.sourcePrimaryId,
          ':targetPrimaryId': ctx.callerId,
          ':sourceApprovalCommandId': notice.sourceApprovalCommandId,
          ':sourceApprovedAt': notice.sourceApprovedAt,
          ':now': now,
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    ...(notice.code
      ? [{ Delete: { TableName: ctx.deps.table, Key: K.codeG(notice.code) } } as TransactItem]
      : []),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableOwnerConditionChecks(ctx.deps, notice.sourcePrimaryId),
    ...writableMinorConditionChecks(ctx, [notice.minorId]),
  ];
  await transact(ctx, items);
  return refreshedView(ctx, target.household.householdId);
}

function additionalResponsibleCoverageWrite(
  ctx: Ctx,
  householdId: string,
  previousCoverage: CoverageAssignmentItem | null,
  payerCoverage: CoverageAssignmentItem,
  now: number,
): TransactItem {
  if (previousCoverage) {
    return {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.familyCoverage(ctx.callerId),
        UpdateExpression:
          'SET householdId = :householdId, seatType = :seatType, #state = :active, paidThrough = :paidThrough, #source = :source, graceUntil = :noGrace, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :ended AND accountId = :accountId',
        ExpressionAttributeNames: { '#state': 'state', '#source': 'source' },
        ExpressionAttributeValues: {
          ':expectedRevision': previousCoverage.revision,
          ':nextRevision': nextRevision(previousCoverage.revision, previousCoverage.revision),
          ':ended': 'ended',
          ':active': 'active',
          ':accountId': ctx.callerId,
          ':householdId': householdId,
          ':seatType': 'additional_responsible',
          ':paidThrough': payerCoverage.paidThrough,
          ':source': payerCoverage.source,
          ':noGrace': null,
          ':now': now,
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    };
  }
  const coverage = inheritedCoverage(householdId, ctx.callerId, 'additional_responsible', payerCoverage, now);
  return {
    Put: {
      TableName: ctx.deps.table,
      Item: coverage,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

export async function acceptLegacyCoGuardianInvite(
  ctx: Ctx,
  invite: CodeItem,
): Promise<{ readonly link: LinkItem; readonly minor: ProfileItem }> {
  if (ctx.caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
  if ((ctx.caller.status ?? 'active') !== 'active') throw new ApiError('CONFLICT');
  const now = ctx.deps.now();
  if (
    invite.kind !== 'coGuardian' ||
    !invite.minorId ||
    invite.expiresAt <= now ||
    invite.userId === ctx.callerId
  ) {
    throw new ApiError('CODE_INVALID');
  }

  const snapshot = await readHouseholdSnapshot(
    repoDeps(ctx),
    householdIdForPrimary(invite.userId),
  );
  if (!snapshot || snapshot.household.primaryResponsibleId !== invite.userId) {
    throw new ApiError('CODE_INVALID');
  }
  const minorSeat = assignedMinorSeats(snapshot).find(
    (candidate) => candidate.accountId === invite.minorId,
  );
  const primaryLink = snapshot.supervisionLinks.find(
    (link) =>
      link.minorId === invite.minorId &&
      link.adultId === invite.userId &&
      link.role === 'primary_responsible' &&
      link.state === 'active' &&
      link.validUntil === null,
  );
  if (!minorSeat || !primaryLink) throw new ApiError('CODE_INVALID');
  const minor = await profileOfConsistent(ctx.deps, invite.minorId);
  if (
    !minor ||
    minor.accountType !== 'minor' ||
    (minor.status ?? 'active') !== 'active'
  ) {
    throw new ApiError('CODE_INVALID');
  }
  requireRecentFamilyAuthentication(ctx);
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'empty') throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const requiredMinorSeats = assignedMinorSeats(snapshot).length;
  const entitlement = await requireFamilyEntitlement(ctx, snapshot.household.householdId, {
    minorSeats: requiredMinorSeats,
    additionalResponsibleSeat: 1,
  });
  const payerCoverage = currentCoverage(snapshot, snapshot.household.primaryResponsibleId);
  if (
    !coverageAllowsNewFamilyAction(payerCoverage, now)
  ) {
    throw new ApiError('PAYMENT_REQUIRED');
  }
  const previousCoverage = await coverageOfConsistent(ctx, ctx.callerId);
  if (previousCoverage && previousCoverage.state !== 'ended') {
    throw new ApiError('MINOR_ALREADY_COVERED');
  }

  const assigned = assignSeat(seat, ctx.callerId, seat.revision, now);
  const scopedLink = createSupervisionLink({
    householdId: snapshot.household.householdId,
    adultId: ctx.callerId,
    minorId: invite.minorId,
    role: 'additional_responsible',
    now,
  });
  const legacyLink = legacyLinkItem(ctx.callerId, invite.minorId, 'invited', now);
  await transact(ctx, [
    householdRevisionUpdate(ctx, snapshot, snapshot.household.revision, now),
    familyEntitlementConditionCheck(ctx, entitlement, {
      minorSeats: requiredMinorSeats,
      additionalResponsibleSeat: 1,
    }),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.additionalSeat(snapshot.household.householdId),
        UpdateExpression:
          'SET #state = :assigned, accountId = :accountId, assignedAt = :now, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :empty AND accountId = :emptyAccountId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': seat.revision,
          ':nextRevision': assigned.revision,
          ':empty': 'empty',
          ':assigned': 'assigned',
          ':emptyAccountId': null,
          ':accountId': ctx.callerId,
          ':now': now,
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: scopedLink,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    additionalResponsibleCoverageWrite(
      ctx,
      snapshot.household.householdId,
      previousCoverage,
      payerCoverage,
      now,
    ),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: legacyLink,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    ...legacyInviteDeleteOperations(ctx, invite, now),
    supervisionExactCheck(ctx, primaryLink),
    ...writableOwnerConditionChecks(ctx.deps, snapshot.household.primaryResponsibleId),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableMinorConditionChecks(ctx, [invite.minorId]),
  ]);
  return { link: legacyLink, minor };
}

export async function acceptLegacyLinkExistingInvite(
  ctx: Ctx,
  invite: CodeItem,
): Promise<{ readonly link: LinkItem; readonly issuer: ProfileItem }> {
  const now = ctx.deps.now();
  if (
    ctx.caller.accountType !== 'minor' ||
    (ctx.caller.status ?? 'active') !== 'active'
  ) {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  if (
    invite.kind !== 'linkExisting' ||
    invite.minorId !== undefined ||
    invite.expiresAt <= now ||
    invite.userId === ctx.callerId
  ) {
    throw new ApiError('CODE_INVALID');
  }
  const issuer = await profileOfConsistent(ctx.deps, invite.userId);
  if (
    !issuer ||
    issuer.accountType !== 'adult' ||
    (issuer.status ?? 'active') !== 'active'
  ) {
    throw new ApiError('CODE_INVALID');
  }

  const sourceCoverage = await coverageOfConsistent(ctx, ctx.callerId);
  if (!sourceCoverage || sourceCoverage.state === 'ended') throw new ApiError('CODE_INVALID');
  const source = await readHouseholdSnapshot(repoDeps(ctx), sourceCoverage.householdId);
  if (!source) throw new ApiError('CODE_INVALID');
  authorize(ctx, source, 'read_household');
  if (!currentCoverage(source, ctx.callerId)) throw new ApiError('CODE_INVALID');
  const sourceSeat = assignedMinorSeats(source).find(
    (candidate) => candidate.accountId === ctx.callerId,
  );
  const sourcePrimaryLink = source.supervisionLinks.find(
    (link) =>
      link.minorId === ctx.callerId &&
      link.adultId === source.household.primaryResponsibleId &&
      link.role === 'primary_responsible' &&
      link.state === 'active' &&
      link.validUntil === null,
  );
  if (!sourceSeat || !sourcePrimaryLink) throw new ApiError('CODE_INVALID');

  const target = await readHouseholdSnapshot(
    repoDeps(ctx),
    householdIdForPrimary(invite.userId),
  );
  if (
    !target ||
    target.household.primaryResponsibleId !== invite.userId ||
    target.household.householdId === source.household.householdId
  ) {
    throw new ApiError('CODE_INVALID');
  }
  if (!emptyMinorSeat(target)) throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const targetCoverage = currentCoverage(target, invite.userId);
  if (
    !coverageAllowsNewFamilyAction(targetCoverage, now)
  ) {
    throw new ApiError('PAYMENT_REQUIRED');
  }

  const id = noticeId(
    'mlr',
    target.household.householdId,
    invite.code,
    ctx.callerId,
  );
  const notice: FamilyNoticeItem = {
    ...noticeKey(id),
    entityType: 'FamilyNotice',
    noticeId: id,
    kind: 'minor_link_request',
    householdId: target.household.householdId,
    targetHouseholdRevision: target.household.revision,
    createdById: target.household.primaryResponsibleId,
    minorId: ctx.callerId,
    minorIds: [ctx.callerId],
    sourceHouseholdId: source.household.householdId,
    sourceHouseholdRevision: source.household.revision,
    sourcePrimaryId: source.household.primaryResponsibleId,
    intendedAdultId: null,
    acceptedById: null,
    sourceApprovalCommandId: null,
    sourceApprovedAt: null,
    acceptanceCommandId: null,
    state: 'pending',
    createdAt: now,
    expiresAt: Math.min(invite.expiresAt, now + FAMILY_NOTICE_TTL_MS),
    revision: 1,
    commandId: id,
    policyVersion: FAMILY_POLICY_VERSION,
    code: null,
  };
  await transact(ctx, [
    exactHouseholdCheck(ctx, source, source.household.revision),
    exactHouseholdCheck(ctx, target, target.household.revision),
    supervisionExactCheck(ctx, sourcePrimaryLink),
    ...legacyInviteDeleteOperations(ctx, invite, now),
    ...familyInboxWrites(ctx, notice, [notice.createdById, notice.sourcePrimaryId, notice.intendedAdultId, notice.minorId]),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: notice,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    ...writableOwnerConditionChecks(ctx.deps, source.household.primaryResponsibleId),
    ...writableOwnerConditionChecks(ctx.deps, target.household.primaryResponsibleId),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
  ]);
  return {
    link: legacyLinkItem(invite.userId, ctx.callerId, 'invited', now),
    issuer,
  };
}

export async function inviteAdditionalResponsible(
  ctx: Ctx,
  body: unknown,
): Promise<AdditionalResponsibleInvitationView> {
  const request = parseAdditionalInvitation(body);
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  authorize(
    ctx,
    snapshot,
    'invite_additional_responsible',
    request.expectedHouseholdRevision,
  );
  requireRecentFamilyAuthentication(ctx);
  const intendedAdult = await profileOfConsistent(ctx.deps, request.intendedAdultId);
  if (!intendedAdult || intendedAdult.accountType !== 'adult') {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  if ((intendedAdult.status ?? 'active') !== 'active') throw new ApiError('CONFLICT');
  if (intendedAdult.userId === ctx.callerId) throw new ApiError('CONFLICT');
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'empty') throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const available = new Set(assignedMinorSeats(snapshot).map((minorSeat) => minorSeat.accountId));
  if (request.minorIds.some((minorId) => !available.has(minorId))) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  const now = ctx.deps.now();
  const id = noticeId('ari', request.householdId, request.commandId);
  const notice: FamilyNoticeItem = {
    ...noticeKey(id),
    entityType: 'FamilyNotice',
    noticeId: id,
    kind: 'additional_responsible_invitation',
    householdId: snapshot.household.householdId,
    targetHouseholdRevision: snapshot.household.revision,
    createdById: ctx.callerId,
    minorId: null,
    minorIds: request.minorIds,
    sourceHouseholdId: null,
    sourceHouseholdRevision: null,
    sourcePrimaryId: ctx.callerId,
    intendedAdultId: intendedAdult.userId,
    acceptedById: null,
    sourceApprovalCommandId: null,
    sourceApprovedAt: null,
    acceptanceCommandId: null,
    state: 'pending',
    createdAt: now,
    expiresAt: now + FAMILY_NOTICE_TTL_MS,
    revision: 1,
    commandId: request.commandId,
    policyVersion: FAMILY_POLICY_VERSION,
    code: null,
  };
  await transact(ctx, [
    exactHouseholdCheck(ctx, snapshot, request.expectedHouseholdRevision),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableOwnerConditionChecks(ctx.deps, intendedAdult.userId),
    ...familyInboxWrites(ctx, notice, [notice.createdById, notice.sourcePrimaryId, notice.intendedAdultId, notice.minorId]),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: notice,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    },
  ]);
  return invitationView(notice);
}

export async function acceptAdditionalResponsible(
  ctx: Ctx,
  invitationId: string,
  body: unknown,
): Promise<HouseholdView> {
  const request = parseCommand(body) as AcceptAdditionalResponsibleInvitationRequest;
  safeIdentifier(invitationId, 'invitationId');
  if (ctx.caller.accountType !== 'adult') throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  if ((ctx.caller.status ?? 'active') !== 'active') throw new ApiError('CONFLICT');
  requireRecentFamilyAuthentication(ctx);
  const notice = await readNotice(ctx, invitationId);
  const now = ctx.deps.now();
  if (
    !notice ||
    notice.kind !== 'additional_responsible_invitation' ||
    !notice.intendedAdultId
  ) {
    throw new ApiError('NOT_FOUND');
  }
  if (request.householdId !== notice.householdId) throw new ApiError('NOT_FOUND');
  if (
    notice.state === 'accepted' &&
    notice.acceptedById === ctx.callerId &&
    notice.intendedAdultId === ctx.callerId &&
    notice.acceptanceCommandId === request.commandId &&
    request.expectedHouseholdRevision === notice.targetHouseholdRevision
  ) {
    const acceptedSnapshot = await explicitSnapshot(ctx, notice.householdId);
    authorize(ctx, acceptedSnapshot, 'read_household');
    return householdView(ctx, acceptedSnapshot);
  }
  if (notice.state !== 'pending' || notice.expiresAt <= now) throw new ApiError('NOT_FOUND');
  if (ctx.callerId !== notice.intendedAdultId) throw new ApiError('FORBIDDEN');
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  if (snapshot.household.revision !== request.expectedHouseholdRevision) {
    throw new ApiError('STALE_REVISION');
  }
  if (
    notice.createdById !== snapshot.household.primaryResponsibleId ||
    notice.sourcePrimaryId !== snapshot.household.primaryResponsibleId ||
    notice.targetHouseholdRevision !== snapshot.household.revision
  ) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  if (ctx.callerId === snapshot.household.primaryResponsibleId) throw new ApiError('CONFLICT');
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'empty') throw new ApiError('HOUSEHOLD_CAPACITY_EXCEEDED');
  const available = new Set(assignedMinorSeats(snapshot).map((minorSeat) => minorSeat.accountId));
  if (notice.minorIds.some((minorId) => !available.has(minorId))) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  const requiredMinorSeats = assignedMinorSeats(snapshot).length;
  const entitlement = await requireFamilyEntitlement(ctx, request.householdId, {
    minorSeats: requiredMinorSeats,
    additionalResponsibleSeat: 1,
  });
  const payerCoverage = currentCoverage(snapshot, snapshot.household.primaryResponsibleId);
  if (!coverageAllowsNewFamilyAction(payerCoverage, now)) throw new ApiError('PAYMENT_REQUIRED');
  const previousCoverage = await coverageOfConsistent(ctx, ctx.callerId);
  if (previousCoverage && previousCoverage.state !== 'ended') {
    throw new ApiError('MINOR_ALREADY_COVERED');
  }
  const assigned = assignSeat(seat, ctx.callerId, seat.revision, now);
  const links = notice.minorIds.map((minorId) =>
    createSupervisionLink({
      householdId: snapshot.household.householdId,
      adultId: ctx.callerId,
      minorId,
      role: 'additional_responsible',
      now,
    }),
  );
  const coverage = inheritedCoverage(snapshot.household.householdId, ctx.callerId, 'additional_responsible', payerCoverage, now);
  const coverageWrite: TransactItem = previousCoverage
    ? {
        Update: {
          TableName: ctx.deps.table,
          Key: FK.familyCoverage(ctx.callerId),
          UpdateExpression:
            'SET householdId = :householdId, seatType = :seatType, #state = :active, paidThrough = :paidThrough, #source = :source, graceUntil = :noGrace, updatedAt = :now, revision = :nextRevision',
          ConditionExpression: 'revision = :expectedRevision AND #state = :ended',
          ExpressionAttributeNames: { '#state': 'state', '#source': 'source' },
          ExpressionAttributeValues: {
            ':expectedRevision': previousCoverage.revision,
            ':nextRevision': nextRevision(previousCoverage.revision, previousCoverage.revision),
            ':ended': 'ended',
            ':active': 'active',
            ':householdId': snapshot.household.householdId,
            ':seatType': 'additional_responsible',
            ':paidThrough': payerCoverage.paidThrough,
            ':source': payerCoverage.source,
            ':noGrace': null,
            ':now': now,
          },
        },
      }
    : {
        Put: {
          TableName: ctx.deps.table,
          Item: coverage,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      };
  await transact(ctx, [
    householdRevisionUpdate(ctx, snapshot, request.expectedHouseholdRevision, now),
    familyEntitlementConditionCheck(ctx, entitlement, {
      minorSeats: requiredMinorSeats,
      additionalResponsibleSeat: 1,
    }),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.additionalSeat(snapshot.household.householdId),
        UpdateExpression:
          'SET #state = :assigned, accountId = :accountId, assignedAt = :now, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :empty AND accountId = :emptyAccountId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': seat.revision,
          ':nextRevision': assigned.revision,
          ':empty': 'empty',
          ':assigned': 'assigned',
          ':emptyAccountId': null,
          ':accountId': ctx.callerId,
          ':now': now,
        },
      },
    },
    ...links.map<TransactItem>((link) => ({
      Put: {
        TableName: ctx.deps.table,
        Item: link,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    })),
    coverageWrite,
    {
      Update: {
        TableName: ctx.deps.table,
        Key: noticeKey(notice.noticeId),
        UpdateExpression:
          'SET #state = :accepted, acceptedById = :acceptedById, acceptanceCommandId = :acceptanceCommandId, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :pending AND intendedAdultId = :intendedAdultId AND createdById = :primaryResponsibleId AND targetHouseholdRevision = :targetHouseholdRevision AND expiresAt > :now',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': notice.revision,
          ':nextRevision': nextRevision(notice.revision, notice.revision),
          ':pending': 'pending',
          ':accepted': 'accepted',
          ':acceptedById': ctx.callerId,
          ':acceptanceCommandId': request.commandId,
          ':intendedAdultId': ctx.callerId,
          ':primaryResponsibleId': snapshot.household.primaryResponsibleId,
          ':targetHouseholdRevision': snapshot.household.revision,
          ':now': now,
        },
      },
    },
    ...writableOwnerConditionChecks(ctx.deps, snapshot.household.primaryResponsibleId),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableMinorConditionChecks(ctx, notice.minorIds),
  ]);
  return refreshedView(ctx, snapshot.household.householdId);
}

function supervisionExactCheck(ctx: Ctx, link: SupervisionLinkItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: FK.supervision(link.minorId, link.adultId),
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND householdId = :householdId',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':expectedRevision': link.revision,
        ':active': 'active',
        ':householdId': link.householdId,
      },
    },
  };
}

function revokeLinkUpdate(ctx: Ctx, link: SupervisionLinkItem, now: number): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: FK.supervision(link.minorId, link.adultId),
      UpdateExpression:
        'SET #state = :revoked, validUntil = :now, updatedAt = :now, revision = :nextRevision',
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND householdId = :householdId',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':expectedRevision': link.revision,
        ':nextRevision': nextRevision(link.revision, link.revision),
        ':active': 'active',
        ':revoked': 'revoked',
        ':householdId': link.householdId,
        ':now': now,
      },
    },
  };
}

export async function replaceAdditionalScope(
  ctx: Ctx,
  body: unknown,
): Promise<HouseholdView> {
  const request = parseScopeCommand(body);
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  authorize(
    ctx,
    snapshot,
    'replace_additional_scope',
    request.expectedHouseholdRevision,
  );
  requireRecentFamilyAuthentication(ctx);
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'assigned' || !seat.accountId) throw new ApiError('NOT_FOUND');
  const available = new Set(assignedMinorSeats(snapshot).map((minorSeat) => minorSeat.accountId));
  if (request.minorIds.some((minorId) => !available.has(minorId))) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  const requiredMinorSeats = assignedMinorSeats(snapshot).length;
  const entitlement = await requireFamilyEntitlement(ctx, request.householdId, {
    minorSeats: requiredMinorSeats,
    additionalResponsibleSeat: 1,
  });
  const now = ctx.deps.now();
  const linksForAdult = snapshot.supervisionLinks.filter(
    (link) =>
      link.adultId === seat.accountId && link.role === 'additional_responsible',
  );
  const activeScope = new Set(
    linksForAdult.filter((link) => link.state === 'active').map((link) => link.minorId),
  );
  if (request.minorIds.some((minorId) => !activeScope.has(minorId))) {
    await requireFamilyRolloutFlag(ctx, 'minorLinkingEnabled');
  }
  const byMinor = new Map(linksForAdult.map((link) => [link.minorId, link] as const));
  const desired = new Set(request.minorIds);
  const operations: TransactItem[] = [];
  for (const link of linksForAdult) {
    if (link.state === 'active') {
      operations.push(
        desired.has(link.minorId)
          ? supervisionExactCheck(ctx, link)
          : revokeLinkUpdate(ctx, link, now),
      );
    }
  }
  for (const minorId of request.minorIds) {
    const historical = byMinor.get(minorId);
    if (historical?.state === 'active') continue;
    if (historical) {
      operations.push({
        Update: {
          TableName: ctx.deps.table,
          Key: FK.supervision(minorId, seat.accountId),
          UpdateExpression:
            'SET #state = :active, validFrom = :now, validUntil = :noEnd, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state <> :active AND householdId = :householdId',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': historical.revision,
            ':nextRevision': nextRevision(historical.revision, historical.revision),
            ':active': 'active',
            ':householdId': snapshot.household.householdId,
            ':now': now,
            ':noEnd': null,
          },
        },
      });
    } else {
      operations.push({
        Put: {
          TableName: ctx.deps.table,
          Item: createSupervisionLink({
            householdId: snapshot.household.householdId,
            adultId: seat.accountId,
            minorId,
            role: 'additional_responsible',
            now,
          }),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      });
    }
  }
  await transact(ctx, [
    householdRevisionUpdate(ctx, snapshot, request.expectedHouseholdRevision, now),
    familyEntitlementConditionCheck(ctx, entitlement, {
      minorSeats: requiredMinorSeats,
      additionalResponsibleSeat: 1,
    }),
    ...operations,
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableOwnerConditionChecks(ctx.deps, seat.accountId),
    ...writableMinorConditionChecks(ctx, request.minorIds),
  ]);
  return refreshedView(ctx, snapshot.household.householdId);
}

export async function revokeAdditionalResponsible(
  ctx: Ctx,
  body: unknown,
): Promise<HouseholdView> {
  const request = parseCommand(body) as RevokeAdditionalResponsibleRequest;
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  authorize(
    ctx,
    snapshot,
    'revoke_additional_responsible',
    request.expectedHouseholdRevision,
  );
  requireRecentFamilyAuthentication(ctx);
  const seat = additionalSeat(snapshot);
  if (seat.state !== 'assigned' || !seat.accountId) throw new ApiError('NOT_FOUND');
  const now = ctx.deps.now();
  const links = snapshot.supervisionLinks.filter(
    (link) =>
      link.adultId === seat.accountId &&
      link.role === 'additional_responsible' &&
      link.state === 'active',
  );
  const coverage = snapshot.coverages.find((item) => item.accountId === seat.accountId) ?? null;
  const items: TransactItem[] = [
    householdRevisionUpdate(ctx, snapshot, request.expectedHouseholdRevision, now),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.additionalSeat(snapshot.household.householdId),
        UpdateExpression:
          'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :assigned AND accountId = :additionalId',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': seat.revision,
          ':nextRevision': nextRevision(seat.revision, seat.revision),
          ':assigned': 'assigned',
          ':empty': 'empty',
          ':emptyAccountId': null,
          ':emptyAssignedAt': null,
          ':additionalId': seat.accountId,
          ':now': now,
        },
      },
    },
    ...links.map((link) => revokeLinkUpdate(ctx, link, now)),
    ...(coverage && coverage.state !== 'ended'
      ? [{
          Update: {
            TableName: ctx.deps.table,
            Key: FK.familyCoverage(seat.accountId),
            UpdateExpression:
              'SET #state = :ended, updatedAt = :now, revision = :nextRevision',
            ConditionExpression:
              'revision = :expectedRevision AND #state <> :ended AND householdId = :householdId',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':expectedRevision': coverage.revision,
              ':nextRevision': nextRevision(coverage.revision, coverage.revision),
              ':ended': 'ended',
              ':householdId': snapshot.household.householdId,
              ':now': now,
            },
          },
        } as TransactItem]
      : []),
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
  ];
  await transact(ctx, items);
  return refreshedView(ctx, snapshot.household.householdId);
}

export async function transferPrimaryResponsibility(
  ctx: Ctx,
  body: unknown,
): Promise<HouseholdView> {
  const request = parseTransfer(body);
  const snapshot = await explicitSnapshot(ctx, request.householdId);
  const existingProposal = await primaryTransferOfConsistent(ctx, request.householdId);

  if (
    existingProposal?.state === 'accepted' &&
    existingProposal.householdId === request.householdId &&
    existingProposal.newPrimaryId === ctx.callerId &&
    existingProposal.newPrimaryId === request.newPrimaryAccountId &&
    existingProposal.commandId === request.commandId &&
    existingProposal.householdRevision === request.expectedHouseholdRevision &&
    snapshot.household.primaryResponsibleId === ctx.callerId
  ) {
    authorize(ctx, snapshot, 'read_household');
    return householdView(ctx, snapshot);
  }

  if (snapshot.household.primaryResponsibleId === ctx.callerId) {
    authorize(
      ctx,
      snapshot,
      'transfer_primary_responsibility',
      request.expectedHouseholdRevision,
      request.newPrimaryAccountId,
    );
    requireRecentFamilyAuthentication(ctx);
    const transfer = await validatedPrimaryTransferState(
      ctx,
      snapshot,
      request.newPrimaryAccountId,
    );
    const entitlement = await requireFamilyEntitlement(ctx, request.householdId, {
      minorSeats: transfer.minors.length,
      additionalResponsibleSeat: 1,
    });
    const now = ctx.deps.now();
    if (
      existingProposal?.state === 'pending' &&
      existingProposal.expiresAt > now &&
      existingProposal.currentPrimaryId === ctx.callerId &&
      existingProposal.newPrimaryId === request.newPrimaryAccountId &&
      existingProposal.householdRevision === request.expectedHouseholdRevision &&
      existingProposal.commandId === request.commandId
    ) {
      return householdView(ctx, snapshot);
    }
    if (existingProposal?.state === 'pending' && existingProposal.expiresAt > now) {
      throw new ApiError('CONFLICT');
    }

    const proposal = createPrimaryTransferProposal({
      householdId: request.householdId,
      currentPrimaryId: ctx.callerId,
      newPrimaryId: request.newPrimaryAccountId,
      householdRevision: request.expectedHouseholdRevision,
      commandId: request.commandId,
      now,
      expiresAt: now + PRIMARY_TRANSFER_TTL_MS,
    });
    await transact(ctx, [
      exactHouseholdCheck(ctx, snapshot, request.expectedHouseholdRevision),
      familyEntitlementConditionCheck(ctx, entitlement, {
        minorSeats: transfer.minors.length,
        additionalResponsibleSeat: 1,
      }),
      ...familyInboxWrites(ctx, proposal, [proposal.currentPrimaryId, proposal.newPrimaryId]),
      {
        Put: {
          TableName: ctx.deps.table,
          Item: proposal,
          ConditionExpression:
            'attribute_not_exists(pk) OR #state <> :pending OR expiresAt <= :now',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':pending': 'pending', ':now': now },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
      ...writableOwnerConditionChecks(ctx.deps, request.newPrimaryAccountId),
    ]);
    return householdView(ctx, snapshot);
  }

  authorize(
    ctx,
    snapshot,
    'accept_primary_transfer',
    request.expectedHouseholdRevision,
    request.newPrimaryAccountId,
  );
  requireRecentFamilyAuthentication(ctx);
  if (
    !existingProposal ||
    existingProposal.state !== 'pending' ||
    existingProposal.expiresAt <= ctx.deps.now() ||
    existingProposal.householdId !== request.householdId ||
    existingProposal.currentPrimaryId !== snapshot.household.primaryResponsibleId ||
    existingProposal.newPrimaryId !== ctx.callerId ||
    existingProposal.newPrimaryId !== request.newPrimaryAccountId ||
    existingProposal.householdRevision !== request.expectedHouseholdRevision ||
    existingProposal.commandId !== request.commandId
  ) {
    throw new ApiError('CURRENT_PRIMARY_APPROVAL_REQUIRED');
  }
  const transfer = await validatedPrimaryTransferState(
    ctx,
    snapshot,
    request.newPrimaryAccountId,
  );
  const entitlement = await requireFamilyEntitlement(ctx, request.householdId, {
    minorSeats: transfer.minors.length,
    additionalResponsibleSeat: 1,
  });
  const now = ctx.deps.now();
  const transaction = buildTransferPrimaryTransaction({
    tableName: ctx.deps.table,
    household: snapshot.household,
    nextPrimaryResponsibleId: request.newPrimaryAccountId,
    additionalSeat: transfer.seat,
    currentPrimaryLinks: transfer.currentPrimaryLinks,
    nextPrimaryLinks: transfer.nextPrimaryLinks,
    currentPrimaryCoverage: transfer.currentPrimaryCoverage,
    nextPrimaryCoverage: transfer.nextPrimaryCoverage,
    expectedHouseholdRevision: request.expectedHouseholdRevision,
    now,
  });
  const acceptance = createPrimaryTransferAcceptance({
    householdId: request.householdId,
    currentPrimaryId: snapshot.household.primaryResponsibleId,
    newPrimaryId: ctx.callerId,
    householdRevision: request.expectedHouseholdRevision,
    commandId: request.commandId,
    acceptedById: ctx.callerId,
    policyVersion: request.policyVersion,
    proposedAt: existingProposal.createdAt,
    now,
  });
  await transact(ctx, [
    ...(transaction.TransactItems ?? []),
    familyEntitlementConditionCheck(ctx, entitlement, {
      minorSeats: transfer.minors.length,
      additionalResponsibleSeat: 1,
    }),
    {
      Update: {
        TableName: ctx.deps.table,
        Key: FK.primaryTransfer(request.householdId),
        UpdateExpression:
          'SET #state = :accepted, acceptedById = :acceptedById, acceptedAt = :now, updatedAt = :now, revision = :nextRevision',
        ConditionExpression:
          'revision = :expectedRevision AND #state = :pending AND householdId = :householdId AND currentPrimaryId = :currentPrimaryId AND newPrimaryId = :newPrimaryId AND householdRevision = :householdRevision AND commandId = :commandId AND expiresAt > :now',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expectedRevision': existingProposal.revision,
          ':nextRevision': nextRevision(existingProposal.revision, existingProposal.revision),
          ':pending': 'pending',
          ':accepted': 'accepted',
          ':householdId': request.householdId,
          ':currentPrimaryId': snapshot.household.primaryResponsibleId,
          ':newPrimaryId': ctx.callerId,
          ':householdRevision': request.expectedHouseholdRevision,
          ':commandId': request.commandId,
          ':acceptedById': ctx.callerId,
          ':now': now,
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: acceptance,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    },
    ...writableOwnerConditionChecks(ctx.deps, ctx.callerId),
    ...writableOwnerConditionChecks(ctx.deps, snapshot.household.primaryResponsibleId),
    ...writableMinorConditionChecks(ctx, transfer.minors),
  ]);
  return refreshedView(ctx, snapshot.household.householdId);
}
