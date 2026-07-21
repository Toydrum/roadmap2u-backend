import { CheckIn, ExportEnvelope, Harvest, Preserve, Tree, TreeNode, TimerSession } from '../db/schema';

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

/**
 * coGuardian   — invite another adult to co-guard one of my minors.
 * linkExisting — invite an existing account to become my linked minor
 *                (kind 'invited'); consent = they redeem the code.
 */
export type FamilyInviteRequest =
  | { kind: 'coGuardian'; minorId: string }
  | { kind: 'linkExisting' };

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
export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND' // also every denied forest fetch — never 403, no existence oracle
  | 'VALIDATION'
  | 'CONFLICT'
  | 'USERNAME_TAKEN'
  | 'LAST_GUARDIAN' // the last active link on a minor cannot be removed
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SYNC_TOO_OLD' // client schemaVersion newer than the server understands
  | 'offline'
  | 'server'
  | 'unknown';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/** Contract-level caps — the mock and the Lambdas enforce the same numbers. */
export const LIMITS = Object.freeze({
  maxFriends: 50,
  maxGuardiansPerMinor: 2,
  maxChildrenPerGuardian: 8,
  syncPushMax: 100,
  /** BAD code redemptions (invalid/expired) per hour before RATE_LIMITED —
   *  successful redemptions never count toward the brake. */
  codeAttemptsPerHour: 5,
});

// ── The API surface ─────────────────────────────────────────────────────────

export interface RoadmapApi {
  // me
  getMe(): Promise<MeResponse>;
  patchMe(patch: { displayName?: string }): Promise<UserProfile>;

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

  // forests & sync
  getForest(userId: string): Promise<ForestSnapshot>;
  getSyncChanges(cursor?: string): Promise<SyncChangesResponse>;
  pushSync(req: SyncPushRequest): Promise<SyncPushResponse>;
  /** Guardian write-through (co-gardening): records land in the minor's store;
   *  their devices pull them on the next sync. */
  pushSyncFor(userId: string, req: SyncPushRequest): Promise<SyncPushResponse>;
}

/** REST paths under `${apiBaseUrl}/v1` — HttpApi and the Lambda router share them. */
export const API_PATHS = Object.freeze({
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
  friends: '/friends',
  friendCode: '/friends/code',
  friendCodeRotate: '/friends/code/rotate',
  friendRequests: '/friends/requests',
  friendRequestAccept: (id: string) => `/friends/requests/${id}/accept`,
  friendRequestDecline: (id: string) => `/friends/requests/${id}/decline`,
  friendRequest: (id: string) => `/friends/requests/${id}`,
  friend: (id: string) => `/friends/${id}`,
  userForest: (id: string) => `/users/${id}/forest`,
  syncChanges: '/sync/changes',
  syncPush: '/sync/push',
  userSyncPush: (id: string) => `/users/${id}/sync/push`,
});
