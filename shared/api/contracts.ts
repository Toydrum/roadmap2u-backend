import {
  CheckIn,
  ExportEnvelope,
  Harvest,
  Preserve,
  Tree,
  TreeNode,
  TimerSession,
} from '../db/schema';

/**
 * THE backend contract — normative and single-source. Three implementations
 * type against it: `mock-api.ts` (the executable spec, on-device), `http-api.ts`
 * (fetch → API Gateway), and the external backend Lambda router (through a
 * parity-checked vendored copy). If a shape changes here, all three follow or
 * fail to compile — that is the point.
 *
 * Angular-free on purpose: Lambda code must be able to import it.
 * Human-readable companion: docs/backend-contract.md.
 */

// ── Commercial catalog & access ─────────────────────────────────────────────

export type PlanKey = 'free' | 'premium';

export type OfferKey =
  | 'premium_individual'
  | 'family_1_minor'
  | 'family_2_minors'
  | 'family_1_minor_1_additional_responsible'
  | 'family_2_minors_1_additional_responsible';

export type BillingInterval = 'month' | 'year';

export interface OfferDefinition {
  offerKey: OfferKey;
  planKey: 'premium';
  minorSeats: 0 | 1 | 2;
  additionalResponsibleSeat: 0 | 1;
  prices: Record<BillingInterval, { amountMinor: number }>;
}

export const FAMILY_OFFER_DEFINITIONS: readonly OfferDefinition[] = Object.freeze([
  Object.freeze({
    offerKey: 'premium_individual',
    planKey: 'premium',
    minorSeats: 0,
    additionalResponsibleSeat: 0,
    prices: Object.freeze({
      month: Object.freeze({ amountMinor: 9_900 }),
      year: Object.freeze({ amountMinor: 94_900 }),
    }),
  }),
  Object.freeze({
    offerKey: 'family_1_minor',
    planKey: 'premium',
    minorSeats: 1,
    additionalResponsibleSeat: 0,
    prices: Object.freeze({
      month: Object.freeze({ amountMinor: 14_900 }),
      year: Object.freeze({ amountMinor: 142_900 }),
    }),
  }),
  Object.freeze({
    offerKey: 'family_2_minors',
    planKey: 'premium',
    minorSeats: 2,
    additionalResponsibleSeat: 0,
    prices: Object.freeze({
      month: Object.freeze({ amountMinor: 18_900 }),
      year: Object.freeze({ amountMinor: 180_900 }),
    }),
  }),
  Object.freeze({
    offerKey: 'family_1_minor_1_additional_responsible',
    planKey: 'premium',
    minorSeats: 1,
    additionalResponsibleSeat: 1,
    prices: Object.freeze({
      month: Object.freeze({ amountMinor: 19_900 }),
      year: Object.freeze({ amountMinor: 190_900 }),
    }),
  }),
  Object.freeze({
    offerKey: 'family_2_minors_1_additional_responsible',
    planKey: 'premium',
    minorSeats: 2,
    additionalResponsibleSeat: 1,
    prices: Object.freeze({
      month: Object.freeze({ amountMinor: 23_900 }),
      year: Object.freeze({ amountMinor: 228_900 }),
    }),
  }),
]);

export interface PlanCatalog {
  version: '2026-09-family-v1';
  pricingVersion: 'family-launch-2026';
  currency: 'MXN';
  taxInclusive: true;
  paymentsEnabled: false;
  offers: readonly OfferDefinition[];
  plans: {
    free: {
      limits: { maxActiveTrees: 2; maxVisibleBranchesPerTree: 10 };
      capabilities: { cloudSync: false; social: false; family: false };
    };
    premium: {
      limits: { maxActiveTrees: null; maxVisibleBranchesPerTree: null };
      capabilities: { cloudSync: true; social: true; family: false };
      prices: {
        month: { amountMinor: 9900 };
        year: { amountMinor: 94900 };
      };
    };
  };
}

/**
 * The phase-one catalog is compiled data, not runtime payment configuration.
 * In particular `paymentsEnabled` cannot be changed by a client or flag.
 */
export const PREPAYMENT_PLAN_CATALOG: PlanCatalog = Object.freeze({
  version: '2026-09-family-v1',
  pricingVersion: 'family-launch-2026',
  currency: 'MXN',
  taxInclusive: true,
  paymentsEnabled: false,
  offers: FAMILY_OFFER_DEFINITIONS,
  plans: Object.freeze({
    free: Object.freeze({
      limits: Object.freeze({ maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 }),
      capabilities: Object.freeze({ cloudSync: false, social: false, family: false }),
    }),
    premium: Object.freeze({
      limits: Object.freeze({ maxActiveTrees: null, maxVisibleBranchesPerTree: null }),
      capabilities: Object.freeze({ cloudSync: true, social: true, family: false }),
      prices: Object.freeze({
        month: Object.freeze({ amountMinor: 9900 }),
        year: Object.freeze({ amountMinor: 94900 }),
      }),
    }),
  }),
});

export interface AccessSource {
  kind: 'default' | 'sponsored' | 'subscription';
  sourceId: string;
  planKey: PlanKey;
  validUntil: number | null;
  scope?: 'individual' | 'family_member';
  householdId?: string;
  seatType?: SeatType;
}

export interface AccessSummary {
  effectivePlanKey: PlanKey;
  catalogVersion: string;
  status: 'active' | 'expired';
  activeSources: AccessSource[];
  limits: {
    maxActiveTrees: number | null;
    maxVisibleBranchesPerTree: number | null;
  };
  capabilities: {
    cloudSync: boolean;
    social: boolean;
    family: boolean;
  };
  usage: {
    activeTrees: number;
    visibleBranchesByTree: Record<string, number>;
  };
  revision: number;
  nextRecomputeAt: number | null;
  offlineValidUntil: number;
}

export const ACCESS_OFFLINE_LEASE_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_STATES = Object.freeze([
  'minor_supervised',
  'adult_transition_pending',
  'adult_self_managed',
] as const);
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const HOUSEHOLD_STATES = Object.freeze([
  'active',
  'disputed',
  'legacy_over_capacity',
  'closed',
] as const);
export type HouseholdState = (typeof HOUSEHOLD_STATES)[number];

export const SUPERVISION_ROLES = Object.freeze([
  'primary_responsible',
  'additional_responsible',
] as const);
export type SupervisionRole = (typeof SUPERVISION_ROLES)[number];

export const SEAT_TYPES = Object.freeze(['minor', 'additional_responsible'] as const);
export type SeatType = (typeof SEAT_TYPES)[number];

export const COVERAGE_STATES = Object.freeze([
  'active',
  'grace',
  'scheduled_end',
  'ended',
] as const);
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const FRIENDSHIP_CLASSES = Object.freeze(['adult_adult', 'minor_minor'] as const);
export type FriendshipClass = (typeof FRIENDSHIP_CLASSES)[number];

export const CONSENT_KINDS = Object.freeze([
  'requester_action',
  'requester_responsible_approval',
  'recipient_acceptance',
  'recipient_responsible_approval',
] as const);
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const BILLING_STATES = Object.freeze([
  'none',
  'checkout_pending',
  'active',
  'cancel_at_period_end',
  'past_due_grace',
  'scheduled_change',
  'expired',
  'payment_review',
] as const);
export type BillingState = (typeof BILLING_STATES)[number];

/** Missing access is always a bounded Free lease; it never guesses Premium. */
export function createFreeAccessSummary(now: number = Date.now()): AccessSummary {
  return {
    effectivePlanKey: 'free',
    catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active',
    activeSources: [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
    limits: { ...PREPAYMENT_PLAN_CATALOG.plans.free.limits },
    capabilities: { ...PREPAYMENT_PLAN_CATALOG.plans.free.capabilities },
    usage: { activeTrees: 0, visibleBranchesByTree: {} },
    revision: 0,
    nextRecomputeAt: null,
    offlineValidUntil: now + ACCESS_OFFLINE_LEASE_MS,
  };
}

// ── Accounts ────────────────────────────────────────────────────────────────

/**
 * Two types + link records; "teen" is deliberately NOT a third value.
 * adult  — self-signed (email + password), may guard minors.
 * minor  — born via a guardian (no email; the guardian IS the recovery
 *          channel) or linked later by invite. `socialEnabled` splits them:
 *          child (false, no friend surfaces) vs teen (true, friends+visits).
 */
export type AccountType = 'adult' | 'minor';

export interface UserProfile {
  userId: string;
  /** Login handle, 3-20 chars of [a-z0-9_], unique, NEVER searchable. */
  username: string;
  /** What family and friends see. */
  displayName: string;
  accountType: AccountType;
  /** Adults: always true. Minors: guardian-controlled, default false. */
  socialEnabled: boolean;
  createdAt: number;
}

/** What OTHER people see of a user. `socialEnabled` only on minors you guard. */
export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string;
  accountType: AccountType;
  socialEnabled?: boolean;
}

export const FAMILY_BILLING_CONTRACT_VERSION = 1 as const;

export interface HouseholdMinorView {
  user: PublicProfile;
  seat: 1 | 2;
  majorityAt: string;
  coverageState: CoverageState | null;
}

export interface HouseholdAdditionalResponsibleView {
  user: PublicProfile;
  minorIds: string[];
  coverageState: CoverageState | null;
}

export interface HouseholdView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  householdId: string;
  country: 'MX';
  state: HouseholdState;
  myRole: SupervisionRole | null;
  primaryResponsible: PublicProfile;
  additionalResponsible: HouseholdAdditionalResponsibleView | null;
  minors: HouseholdMinorView[];
  availableMinorSeats: 0 | 1 | 2;
  additionalResponsibleSeatAvailable: boolean;
  revision: number;
}

export const MINOR_FRIEND_REQUEST_STATES = Object.freeze([
  'pending',
  'active',
  'rejected',
  'revoked',
  'expired',
] as const);
export type MinorFriendRequestState = (typeof MINOR_FRIEND_REQUEST_STATES)[number];

export interface MinorFriendConsentView {
  kind: ConsentKind;
  recordedAt: number;
}

export interface MinorFriendRequestView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  requestId: string;
  friendshipClass: 'minor_minor';
  state: MinorFriendRequestState;
  requester: PublicProfile;
  recipient: PublicProfile;
  consents: MinorFriendConsentView[];
  expiresAt: number;
  revision: number;
}

export interface PendingBillingChangeView {
  offerKey: OfferKey;
  interval: BillingInterval;
  effectiveAt: number;
  keepCoveredMinorId: string | null;
}

export interface BillingSummary {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  availability: 'disabled' | 'available' | 'recovery_required';
  householdId: string;
  payerAccountId: string;
  state: BillingState;
  currentOfferKey: OfferKey | null;
  interval: BillingInterval | null;
  paidThrough: number | null;
  graceUntil: number | null;
  cancelAtPeriodEnd: boolean;
  pendingChange: PendingBillingChangeView | null;
  revision: number;
}

export interface BillingCommandBase {
  householdId: string;
  expectedHouseholdRevision: number;
  commandId: string;
}

export interface CreateCheckoutRequest extends BillingCommandBase {
  offerKey: OfferKey;
  interval: BillingInterval;
}

export interface PreviewSubscriptionChangeRequest extends BillingCommandBase {
  offerKey: OfferKey;
  interval: BillingInterval;
  keepCoveredMinorId?: string;
}

export interface ApplySubscriptionChangeRequest extends PreviewSubscriptionChangeRequest {}

export interface CreatePortalRequest extends BillingCommandBase {}

export interface FamilyCommandBase {
  householdId: string;
  expectedHouseholdRevision: number;
  commandId: string;
  policyVersion: string;
}

export interface CreateMinorRequest extends FamilyCommandBase {
  username: string;
  country: 'MX';
  majorityAt: string;
  declarationVersion: string;
  consentVersion: string;
}

export interface CreateMinorResponse {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  household: HouseholdView;
  minor: UserProfile;
  tempPassword: string;
}

export const MINOR_LINK_REQUEST_STATES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
] as const);
export type MinorLinkRequestState = (typeof MINOR_LINK_REQUEST_STATES)[number];

export interface MinorLinkRequestView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  requestId: string;
  householdId: string;
  minor: PublicProfile;
  state: MinorLinkRequestState;
  expiresAt: number;
  revision: number;
}

export interface CreateMinorLinkRequest extends FamilyCommandBase {
  code: string;
}

export interface ApproveMinorLinkRequest extends FamilyCommandBase {}

export const ADDITIONAL_RESPONSIBLE_INVITATION_STATES = Object.freeze([
  'pending',
  'accepted',
  'revoked',
  'expired',
] as const);
export type AdditionalResponsibleInvitationState =
  (typeof ADDITIONAL_RESPONSIBLE_INVITATION_STATES)[number];

export interface AdditionalResponsibleInvitationView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  invitationId: string;
  householdId: string;
  minorIds: string[];
  state: AdditionalResponsibleInvitationState;
  expiresAt: number;
  revision: number;
}

export interface CreateAdditionalResponsibleInvitationRequest extends FamilyCommandBase {
  minorIds: string[];
}

export interface AcceptAdditionalResponsibleInvitationRequest extends FamilyCommandBase {}

export interface ReplaceAdditionalResponsibleScopeRequest extends FamilyCommandBase {
  minorIds: string[];
}

export interface RevokeAdditionalResponsibleRequest extends FamilyCommandBase {}

export interface TransferPrimaryResponsibilityRequest extends FamilyCommandBase {
  newPrimaryAccountId: string;
}

export interface CreateAdultFriendRequestRequest {
  code: string;
}

export interface CreateMinorInviteCodeRequest {
  minorId: string;
}

export interface CreateMinorFriendRequestRequest {
  minorId: string;
  code: string;
}

export interface MinorFriendActionRequest {
  minorId: string;
  commandId: string;
  policyVersion: string;
}

export interface BillingRedirectView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  url: string;
  expiresAt: number;
}

export interface SubscriptionChangePreviewView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  householdId: string;
  currentOfferKey: OfferKey | null;
  targetOfferKey: OfferKey;
  interval: BillingInterval;
  amountDueMinor: number;
  effectiveAt: number;
  requiresPayment: boolean;
  revision: number;
}

export interface BillingActionView {
  contractVersion: typeof FAMILY_BILLING_CONTRACT_VERSION;
  summary: BillingSummary;
  redirect: BillingRedirectView | null;
}

/**
 * created — guardian created this minor: full identity admin (rename, reset
 *           password, social toggle, export-first delete).
 * invited — an existing account accepted a family invite: the guardian gets
 *           forest view+edit and friend oversight, but the account owns its
 *           own identity (it has email recovery; no reset/delete/toggle).
 */
export type GuardianLinkKind = 'created' | 'invited';

/** One side of a guardian link, as seen from the caller's perspective. */
export interface FamilyLinkView {
  linkId: string;
  kind: GuardianLinkKind;
  /** The person on the other end of the link. */
  user: PublicProfile;
  createdAt: number;
}

/** One call paints the whole account section. */
export interface MeResponse {
  profile: UserProfile;
  family: {
    /** People who guard me. */
    guardians: FamilyLinkView[];
    /** People I guard. */
    minors: FamilyLinkView[];
  };
}

export interface CreateChildRequest {
  username: string;
  displayName: string;
}

/** `tempPassword` is shown ONCE to the guardian and never stored client-side. */
export interface CreateChildResponse {
  child: UserProfile;
  tempPassword: string;
}

export type AccountClosureState = 'requested' | 'purging' | 'purgeComplete' | 'completed';

export interface AccountClosureReceipt {
  closureId: string;
  state: AccountClosureState;
}

/**
 * coGuardian   — invite another adult to co-guard one of my minors.
 * linkExisting — invite an existing account to become my linked minor
 *                (kind 'invited'); consent = they redeem the code.
 */
export type FamilyInviteRequest =
  { kind: 'coGuardian'; minorId: string } | { kind: 'linkExisting' };

/** Short-lived shareable code (family invites 72 h, friend codes 7 d). */
export interface CodeGrant {
  code: string;
  expiresAt: number;
}

// ── Friends ─────────────────────────────────────────────────────────────────

export interface FriendView {
  friendshipId: string;
  user: PublicProfile;
  since: number;
}

export interface FriendRequestView {
  requestId: string;
  user: PublicProfile;
  createdAt: number;
  expiresAt: number;
}

export interface FriendsResponse {
  friends: FriendView[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

// ── Forests & sync ──────────────────────────────────────────────────────────

/**
 * detail 'full'     — guardian → linked minor (co-gardening needs real nodes).
 * detail 'stripped' — friends and minor→guardian: note→'', trigger→null,
 *                     targetDate→null, priority→null, estimateMin→null,
 *                     repeatsDaily→absent, repeats→absent,
 *                     repeatsSetAt→absent, remindAt→absent (attention
 *                     allocation and routines are intimate — «la luz» and a
 *                     weekday pattern travel only to guardians), stripped
 *                     SERVER-side. Both exclude archived and tombstoned
 *                     records. Check-ins, sessions, HARVESTS, PRESERVES and
 *                     settings are NEVER served to anyone — visits render a
 *                     neutral sky (weather derives from private feelings),
 *                     and the pantry is personal (harvest titles and jam
 *                     names are as intimate as trigger; if preserves are
 *                     EVER served in any future phase, premio/savedFor/
 *                     openedAt strip FIRST — a self-granted permission is
 *                     the most intimate sentence in the whole model).
 */
export interface ForestSnapshot {
  owner: PublicProfile;
  detail: 'full' | 'stripped';
  trees: Tree[];
  nodes: TreeNode[];
  fetchedAt: number;
}

/** Settings are device preferences (no rev) — deliberately NOT synced. */
export type SyncStore = 'trees' | 'nodes' | 'checkins' | 'sessions' | 'harvests' | 'preserves';

export interface SyncRecord {
  store: SyncStore;
  record: Tree | TreeNode | CheckIn | TimerSession | Harvest | Preserve;
}

export interface SyncPushRequest {
  schemaVersion: number;
  /** ≤ LIMITS.syncPushMax per call. */
  records: SyncRecord[];
}

/** Wire contract revision; independent from the local forest schemaVersion. */
export const CONTRACT_VERSION = 2 as const;

/** One all-or-nothing logical write; never larger than syncMutationGroupMax. */
export interface SyncMutationGroup {
  id: string;
  expectedCount: number;
  records: SyncRecord[];
}

/**
 * Transaction-aware contract. `SyncPushRequest` deliberately remains the
 * v12 flat payload so already-deployed clients and handlers stay typed.
 */
export interface SyncPushV2Request {
  schemaVersion: number;
  contractVersion: typeof CONTRACT_VERSION;
  /** Sum of all records remains ≤ LIMITS.syncPushMax. */
  mutationGroups: SyncMutationGroup[];
}

export type SyncPushPayload = SyncPushRequest | SyncPushV2Request;

/**
 * THE one LWW ordering, shared verbatim by every implementation (client
 * repos, mock cloud, DynamoDB condition expression): higher rev wins; equal
 * revs fall to updatedAt. An EXACT tie (same rev AND same updatedAt) goes to
 * the copy the server already stores — servers reject the push and hand back
 * the stored winner, while clients ACCEPT server records on exact ties. Every
 * replica therefore converges on one copy instead of each keeping its own.
 */
export function lwwBeats(
  incoming: { rev: number; updatedAt: number },
  stored: { rev: number; updatedAt: number },
): boolean {
  if (incoming.rev !== stored.rev) return incoming.rev > stored.rev;
  return incoming.updatedAt > stored.updatedAt;
}

/**
 * Per-record LWW, same law as RecordsRepo.applyExternal: the server accepts a
 * record iff `lwwBeats(incoming, stored)`, otherwise rejects STALE_REV and
 * returns its winner in `serverRecords` so the client can converge.
 * Tombstones travel as ordinary records (deletedAt set) — never deletes.
 */
export interface SyncPushResponse {
  applied: string[];
  rejected: { id: string; reason: 'STALE_REV' }[];
  serverRecords: SyncRecord[];
}

/**
 * Change feed ordered by SERVER receive time (client clocks skew), exposed as
 * an opaque cursor. The server validates only SyncBase + the store enum and
 * stores records opaquely — additive schema evolution (the trigger/flow
 * precedent) needs zero backend change.
 */
export interface SyncChangesResponse {
  changes: SyncRecord[];
  cursor: string;
  more: boolean;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * SCREAMING codes travel in the server envelope `{error:{code,message}}`;
 * lowercase codes are minted client-side by the transport (never on the wire).
 * `message` is for developers — the client maps `code` to i18n copy.
 */
export const SERVER_API_ERROR_CODES = Object.freeze([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND', // also every denied forest fetch — never 403, no existence oracle
  'VALIDATION',
  'CONFLICT',
  'USERNAME_TAKEN',
  'LAST_GUARDIAN', // the last active link on a minor cannot be removed
  'CODE_INVALID',
  'CODE_EXPIRED',
  'LIMIT_EXCEEDED',
  'RATE_LIMITED',
  'SYNC_TOO_OLD', // client schemaVersion newer than the server understands
  'QUOTA_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'MUTATION_GROUP_INVALID',
  'ACCESS_REVISION_CONFLICT',
  'ACCESS_CODE_INVALID',
  'ACCESS_CODE_RATE_LIMITED',
  'ACCESS_CODE_ALREADY_REDEEMED',
  'SYNC_SCHEMA_INVALID',
  'SYNC_CLIENT_UPGRADE_REQUIRED',
  'USAGE_MIGRATION_IN_PROGRESS',
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
  'ADULT_MINOR_FRIENDSHIP_FORBIDDEN',
  'ACCOUNT_TYPE_INCOMPATIBLE',
  'RESPONSIBLE_SCOPE_REQUIRED',
  'CONSENT_INCOMPLETE',
  'MINOR_ALREADY_COVERED',
  'HOUSEHOLD_CAPACITY_EXCEEDED',
  'CURRENT_PRIMARY_APPROVAL_REQUIRED',
  'LEGAL_REGION_UNSUPPORTED',
  'OFFER_NOT_ALLOWED',
  'CHECKOUT_IN_PROGRESS',
  'SUBSCRIPTION_CONFLICT',
  'PAYMENT_REQUIRED',
  'REAUTHENTICATION_REQUIRED',
  'STALE_REVISION',
] as const);

export type ServerApiErrorCode = (typeof SERVER_API_ERROR_CODES)[number];
export type ClientApiErrorCode = 'offline' | 'server' | 'unknown';
export type ApiErrorCode = ServerApiErrorCode | ClientApiErrorCode;

const RETRYABLE_API_ERROR_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'ACCESS_REVISION_CONFLICT',
  'USAGE_MIGRATION_IN_PROGRESS',
]);

/** Client policy only; retryability is not an extra field in the wire envelope. */
export function isRetryableApiErrorCode(code: ApiErrorCode): boolean {
  return RETRYABLE_API_ERROR_CODES.has(code);
}

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }

  get retryable(): boolean {
    return isRetryableApiErrorCode(this.code);
  }
}

/** Contract-level caps — the mock and the Lambdas enforce the same numbers. */
export const LIMITS = Object.freeze({
  maxFriends: 50,
  maxGuardiansPerMinor: 2,
  maxChildrenPerGuardian: 8,
  syncPushMax: 100,
  syncMutationGroupMax: 20,
  /** BAD code redemptions (invalid/expired) per hour before RATE_LIMITED —
   *  successful redemptions never count toward the brake. */
  codeAttemptsPerHour: 5,
});

// ── The API surface ─────────────────────────────────────────────────────────

export interface RoadmapApi {
  // commercial access
  getPlans(): Promise<PlanCatalog>;
  getAccess(): Promise<AccessSummary>;
  redeemAccessCode(code: string): Promise<AccessSummary>;

  // me
  getMe(): Promise<MeResponse>;
  patchMe(patch: { displayName?: string }): Promise<UserProfile>;
  deleteMe(): Promise<AccountClosureReceipt>;

  // family
  createChild(req: CreateChildRequest): Promise<CreateChildResponse>;
  resetChildPassword(userId: string): Promise<{ tempPassword: string }>;
  patchChild(
    userId: string,
    patch: { displayName?: string; socialEnabled?: boolean },
  ): Promise<UserProfile>;
  exportChild(userId: string): Promise<ExportEnvelope>;
  deleteChild(userId: string): Promise<void>;
  deleteFamilyLink(linkId: string): Promise<void>;
  createFamilyInvite(req: FamilyInviteRequest): Promise<CodeGrant>;
  acceptFamilyInvite(code: string): Promise<FamilyLinkView>;
  revokeFamilyInvite(code: string): Promise<void>;
  listChildFriends(userId: string): Promise<FriendsResponse>;
  removeChildFriendship(userId: string, friendshipId: string): Promise<void>;
  cancelChildRequest(userId: string, requestId: string): Promise<void>;

  // family v2 (additive while legacy routes remain available)
  getHousehold(): Promise<HouseholdView>;
  createMinor(req: CreateMinorRequest): Promise<CreateMinorResponse>;
  createMinorLinkRequest(req: CreateMinorLinkRequest): Promise<MinorLinkRequestView>;
  approveMinorLinkRequest(requestId: string, req: ApproveMinorLinkRequest): Promise<HouseholdView>;
  createAdditionalResponsibleInvitation(
    req: CreateAdditionalResponsibleInvitationRequest,
  ): Promise<AdditionalResponsibleInvitationView>;
  acceptAdditionalResponsibleInvitation(
    invitationId: string,
    req: AcceptAdditionalResponsibleInvitationRequest,
  ): Promise<HouseholdView>;
  replaceAdditionalResponsibleScope(
    req: ReplaceAdditionalResponsibleScopeRequest,
  ): Promise<HouseholdView>;
  revokeAdditionalResponsible(req: RevokeAdditionalResponsibleRequest): Promise<HouseholdView>;
  transferPrimaryResponsibility(req: TransferPrimaryResponsibilityRequest): Promise<HouseholdView>;

  // friends (social-enabled accounts only; declines are silent by design)
  getFriends(): Promise<FriendsResponse>;
  getFriendCode(): Promise<CodeGrant>;
  rotateFriendCode(): Promise<CodeGrant>;
  /** A second request while one is already pending to the same person is
   *  CONFLICT — implementations must make the duplicate impossible even under
   *  a double-submit race (deterministic key or conditional write). */
  createFriendRequest(code: string): Promise<FriendRequestView>;
  /** `maxFriends` is enforced at request time AND here — requests can sit for
   *  days, so either side may have reached the cap since. */
  acceptFriendRequest(requestId: string): Promise<FriendView>;
  declineFriendRequest(requestId: string): Promise<void>;
  cancelFriendRequest(requestId: string): Promise<void>;
  removeFriend(friendshipId: string): Promise<void>;

  // social v2
  createAdultFriendRequest(req: CreateAdultFriendRequestRequest): Promise<FriendRequestView>;
  acceptAdultFriendRequest(requestId: string): Promise<FriendView>;
  removeSocialFriendship(friendshipId: string): Promise<void>;
  createMinorInviteCode(req: CreateMinorInviteCodeRequest): Promise<CodeGrant>;
  createMinorFriendRequest(req: CreateMinorFriendRequestRequest): Promise<MinorFriendRequestView>;
  acceptMinorFriendRequest(
    requestId: string,
    req: MinorFriendActionRequest,
  ): Promise<MinorFriendRequestView>;
  approveMinorFriendRequest(
    requestId: string,
    req: MinorFriendActionRequest,
  ): Promise<MinorFriendRequestView>;
  rejectMinorFriendRequest(requestId: string, req: MinorFriendActionRequest): Promise<void>;
  removeMinorFriendship(friendshipId: string): Promise<void>;

  // billing v1
  getBillingSummary(): Promise<BillingSummary>;
  createCheckout(req: CreateCheckoutRequest): Promise<BillingRedirectView>;
  previewSubscriptionChange(
    req: PreviewSubscriptionChangeRequest,
  ): Promise<SubscriptionChangePreviewView>;
  applySubscriptionChange(req: ApplySubscriptionChangeRequest): Promise<BillingActionView>;
  createPortalSession(req: CreatePortalRequest): Promise<BillingRedirectView>;

  // forests & sync
  getForest(userId: string): Promise<ForestSnapshot>;
  getSyncChanges(cursor?: string): Promise<SyncChangesResponse>;
  pushSync(req: SyncPushPayload): Promise<SyncPushResponse>;
  /** Guardian write-through (co-gardening): records land in the minor's store;
   *  their devices pull them on the next sync. */
  pushSyncFor(userId: string, req: SyncPushPayload): Promise<SyncPushResponse>;
}

/** REST paths under `${apiBaseUrl}/v1` — HttpApi and the Lambda router share them. */
export const API_PATHS = Object.freeze({
  plans: '/plans',
  access: '/access',
  accessCodesRedeem: '/access-codes/redeem',
  me: '/me',
  familyChildren: '/family/children',
  familyChild: (id: string) => `/family/children/${id}`,
  familyChildResetPassword: (id: string) => `/family/children/${id}/reset-password`,
  familyChildExport: (id: string) => `/family/children/${id}/export`,
  familyChildFriends: (id: string) => `/family/children/${id}/friends`,
  familyChildFriend: (id: string, fid: string) => `/family/children/${id}/friends/${fid}`,
  familyChildRequest: (id: string, rid: string) => `/family/children/${id}/requests/${rid}`,
  familyLink: (linkId: string) => `/family/links/${linkId}`,
  familyInvites: '/family/invites',
  familyInvitesAccept: '/family/invites/accept',
  familyInvite: (code: string) => `/family/invites/${code}`,
  familyHousehold: '/family/household',
  familyMinors: '/family/minors',
  familyMinorLinkRequests: '/family/minor-link-requests',
  familyMinorLinkRequestApprove: (id: string) => `/family/minor-link-requests/${id}/approve`,
  familyAdditionalResponsibleInvitations: '/family/additional-responsible-invitations',
  familyAdditionalResponsibleInvitationAccept: (id: string) =>
    `/family/additional-responsible-invitations/${id}/accept`,
  familyAdditionalResponsibleScope: '/family/additional-responsible/scope',
  familyAdditionalResponsible: '/family/additional-responsible',
  familyTransferPrimaryResponsibility: '/family/transfer-primary-responsibility',
  friends: '/friends',
  friendCode: '/friends/code',
  friendCodeRotate: '/friends/code/rotate',
  friendRequests: '/friends/requests',
  friendRequestAccept: (id: string) => `/friends/requests/${id}/accept`,
  friendRequestDecline: (id: string) => `/friends/requests/${id}/decline`,
  friendRequest: (id: string) => `/friends/requests/${id}`,
  friend: (id: string) => `/friends/${id}`,
  socialAdultFriendRequests: '/social/adult-friend-requests',
  socialAdultFriendRequestAccept: (id: string) => `/social/adult-friend-requests/${id}/accept`,
  socialFriendship: (id: string) => `/social/friendships/${id}`,
  socialMinorInviteCodes: '/social/minor-invite-codes',
  socialMinorFriendRequests: '/social/minor-friend-requests',
  socialMinorFriendRequestAccept: (id: string) =>
    `/social/minor-friend-requests/${id}/minor-accept`,
  socialMinorFriendRequestResponsibleApprove: (id: string) =>
    `/social/minor-friend-requests/${id}/responsible-approve`,
  socialMinorFriendRequestReject: (id: string) => `/social/minor-friend-requests/${id}/reject`,
  socialMinorFriendship: (id: string) => `/social/minor-friendships/${id}`,
  billingSummary: '/billing/summary',
  billingCheckout: '/billing/checkout',
  billingChangePreview: '/billing/change-preview',
  billingChange: '/billing/change',
  billingPortal: '/billing/portal',
  userForest: (id: string) => `/users/${id}/forest`,
  syncChanges: '/sync/changes',
  syncPush: '/sync/push',
  userSyncPush: (id: string) => `/users/${id}/sync/push`,
});
