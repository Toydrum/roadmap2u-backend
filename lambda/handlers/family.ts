import {
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import {
  ApiError,
  CodeGrant,
  CreateChildRequest,
  CreateChildResponse,
  FamilyInviteRequest,
  FamilyLinkView,
  FriendsResponse,
  LIMITS,
  UserProfile,
} from '@app/api/contracts';
import { USERNAME_PATTERN } from '@app/auth/auth-types';
import {
  CheckIn,
  ExportEnvelope,
  Harvest,
  Preserve,
  SCHEMA_VERSION,
  TimerSession,
  Tree,
  TreeNode,
} from '@app/db/schema';
import {
  Ctx,
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  guardiansOf,
  profileOf,
  requireCreatedGuardianOf,
  requireGuardianOf,
  requireWritableOwner,
  toPublic,
} from '../authz';
import type { AccountClosureDeps } from '../account-closure';
import {
  realAccountClosureRequestDeps,
  requestGuardianMinorClosure,
} from '../account-closure-handler';
import {
  CodeItem,
  FriendRequestItem,
  K,
  LinkItem,
  ProfileItem,
  RecordItem,
  type DynamoKey,
  composite,
  getItem,
  queryPrefix,
  queryPrefixPage,
} from '../db';
import { friendCode, tempPassword } from '../codes';
import { FK } from '../family/keys';
import type { CoverageAssignmentItem } from '../family/model';
import {
  primaryMinorAuthorityChecks,
  requirePrimaryMinorAuthority,
  samePrimaryMinorAuthority,
  type PrimaryMinorAction,
  type PrimaryMinorAuthority,
} from '../family/minor-authority';
import {
  guardianInviteMirrors,
  idempotentGuardianInviteMirrorDelete,
} from '../guardian-invites';
import { profileView } from './me';
import { friendsOf, removeFriendshipAs } from './friends';
import { requireMinorFriendOversight, revokeMinorFriendship } from './minor-social';
import {
  acceptLegacyCoGuardianInvite,
  acceptLegacyLinkExistingInvite,
  createMinorFromLegacy,
} from './household';
import {
  exactCodeOperation,
  exactLinkOperation,
  exactRequestOperation,
  getConsistent,
  guardedWrite,
  reserveCodeAttempt,
  sameCode,
  sameLink,
  sameRequest,
  type TransactItem,
} from './guarded-mutation';

const INVITE_TTL_MS = 72 * 3600 * 1000;
const IDENTITY_OPERATION_LEASE_MS = 60_000;
const FAMILY_FENCE_VERSION = 1;

/** Version 1 proves the set is authoritative, so deleting requires membership. */
function removeCreatedMinorFromFence(
  ctx: Ctx,
  guardianId: string,
  minorId: string,
): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: K.profile(guardianId),
      UpdateExpression: 'DELETE createdMinorIds :createdMinorIds',
      ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND (attribute_not_exists(familyFenceVersion) OR (familyFenceVersion = :familyFenceVersion AND contains(createdMinorIds, :minorId)))`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':familyFenceVersion': FAMILY_FENCE_VERSION,
        ':createdMinorIds': new Set([minorId]),
        ':minorId': minorId,
      },
    },
  };
}

function authorityChecks(ctx: Ctx, authority: PrimaryMinorAuthority): TransactItem[] {
  return authority.model === 'legacy'
    ? [exactLinkOperation(ctx.deps, authority.link, 'check')]
    : primaryMinorAuthorityChecks(ctx.deps.table, authority);
}

async function requireSensitiveMinorAuthority(
  ctx: Ctx,
  minorId: string,
  action: PrimaryMinorAction,
): Promise<PrimaryMinorAuthority> {
  return requirePrimaryMinorAuthority(ctx.deps, ctx.caller, minorId, action);
}

async function requireCreatedGuardianConsistent(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const link = await getConsistent<LinkItem>(ctx, K.link(minorId, ctx.callerId));
  if (!link) throw new ApiError('NOT_FOUND');
  if (link.kind !== 'created') {
    throw new ApiError('FORBIDDEN', 'invited links have no identity admin');
  }
  await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_identity');
  return link;
}

async function requireWritableExportAuthority(
  ctx: Ctx,
  minorId: string,
): Promise<PrimaryMinorAuthority> {
  const [caller, child, authority] = await Promise.all([
    requireWritableOwner(ctx, ctx.callerId),
    requireWritableOwner(ctx, minorId),
    requireSensitiveMinorAuthority(ctx, minorId, 'export_minor'),
  ]);
  if (
    caller.userId !== ctx.callerId ||
    child.userId !== minorId
  ) {
    throw new ApiError('NOT_FOUND');
  }
  return authority;
}

async function exportRecordsConsistent(ctx: Ctx, ownerId: string): Promise<RecordItem[]> {
  const records: RecordItem[] = [];
  let exclusiveStartKey: DynamoKey | undefined;
  do {
    const page = await queryPrefixPage<RecordItem>(ctx.deps, K.user(ownerId), 'REC#', {
      consistentRead: true,
      exclusiveStartKey,
    });
    records.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

function linkItem(
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

function linkView(link: LinkItem, other: ProfileItem, includeSocial: boolean): FamilyLinkView {
  return {
    linkId: link.linkId,
    kind: link.kind,
    user: toPublic(other, includeSocial),
    createdAt: link.createdAt,
  };
}

// ── Children (created minors) ───────────────────────────────────────────────

export async function createChild(
  ctx: Ctx,
  body: CreateChildRequest,
): Promise<CreateChildResponse> {
  if (ctx.caller.accountType !== 'adult')
    throw new ApiError('FORBIDDEN', 'only adults create minors');
  const username = body.username?.trim().toLowerCase() ?? '';
  const displayName = body.displayName?.trim() ?? '';
  if (!USERNAME_PATTERN.test(username)) throw new ApiError('VALIDATION', 'username 3-20 [a-z0-9_]');
  if (!displayName || displayName.length > 40)
    throw new ApiError('VALIDATION', 'displayName 1-40 chars');
  await requireWritableOwner(ctx, ctx.callerId);
  const result = await createMinorFromLegacy(ctx, { username, displayName });
  return { child: result.minor, tempPassword: result.tempPassword };
}

export async function resetChildPassword(
  ctx: Ctx,
  minorId: string,
  nextIdentityLeaseId: () => string = randomUUID,
): Promise<{ tempPassword: string }> {
  const authority = await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_recovery');
  await requireWritableOwner(ctx, ctx.callerId);
  const child = await requireWritableOwner(ctx, minorId);
  const password = tempPassword();
  const identityLeaseOwner = nextIdentityLeaseId();
  const now = ctx.deps.now();
  await guardedWrite(
    ctx,
    [ctx.callerId, minorId],
    [
      {
        Update: {
          TableName: ctx.deps.table,
          Key: K.profile(minorId),
          UpdateExpression:
            'SET identityLeaseOwner = :identityLeaseOwner, identityLeaseUntil = :identityLeaseUntil',
          ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND (attribute_not_exists(identityLeaseUntil) OR identityLeaseUntil < :now)`,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':identityLeaseOwner': identityLeaseOwner,
            ':identityLeaseUntil': now + IDENTITY_OPERATION_LEASE_MS,
            ':now': now,
          },
        },
      },
      closureAbsenceConditionCheck(ctx.deps, minorId),
      ...authorityChecks(ctx, authority),
    ],
    async () => {
      const current = await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_recovery');
      if (!samePrimaryMinorAuthority(current, authority)) return;
    },
    { [minorId]: { profile: true, closure: true } },
  );

  let failure: unknown;
  try {
    await ctx.deps.cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: ctx.deps.userPoolId,
        Username: child.username,
        Password: password,
        Permanent: false, // next sign-in lands in the newPasswordRequired step
      }),
    );
  } catch (error) {
    failure = error;
  }
  try {
    // This nonce-matched REMOVE cannot grant authority or recreate data, but it
    // still carries the exact guardian link and both owners' lifecycle fences.
    await guardedWrite(
      ctx,
      [ctx.callerId, minorId],
      [
        {
          Update: {
            TableName: ctx.deps.table,
            Key: K.profile(minorId),
            UpdateExpression: 'REMOVE identityLeaseOwner, identityLeaseUntil',
            ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND (identityLeaseOwner = :identityLeaseOwner)`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':identityLeaseOwner': identityLeaseOwner,
            },
          },
        },
        ...authorityChecks(ctx, authority),
      ],
      async () => {
        const current = await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_recovery');
        if (!samePrimaryMinorAuthority(current, authority)) throw new ApiError('NOT_FOUND');
      },
      { [minorId]: { profile: true } },
    );
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return { tempPassword: password };
}

function familyInviteDeleteOperations(ctx: Ctx, invite: CodeItem) {
  return [
    exactCodeOperation(ctx.deps, invite, 'delete'),
    ...(invite.closureMirrorVersion === 1
      ? guardianInviteMirrors(invite).map((mirror) =>
          idempotentGuardianInviteMirrorDelete(ctx.deps, mirror),
        )
      : []),
  ];
}

export async function patchChild(
  ctx: Ctx,
  minorId: string,
  body: { displayName?: string; socialEnabled?: boolean },
): Promise<UserProfile> {
  const authority = await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_identity');
  const child = await profileOf(ctx.deps, minorId);
  if (!child) throw new ApiError('NOT_FOUND');

  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  if (body.displayName !== undefined) {
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 40) throw new ApiError('VALIDATION');
    sets.push('displayName = :d');
    values[':d'] = displayName;
    child.displayName = displayName;
  }
  if (body.socialEnabled !== undefined) {
    sets.push('socialEnabled = :s');
    values[':s'] = !!body.socialEnabled;
    child.socialEnabled = !!body.socialEnabled;
  }
  if (!sets.length) {
    const [caller, currentChild, currentAuthority] = await Promise.all([
      requireWritableOwner(ctx, ctx.callerId),
      requireWritableOwner(ctx, minorId),
      requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_identity'),
    ]);
    if (
      caller.userId !== ctx.callerId ||
      currentChild.userId !== minorId ||
      !samePrimaryMinorAuthority(currentAuthority, authority)
    ) {
      throw new ApiError('NOT_FOUND');
    }
    return profileView(currentChild);
  }
  if (sets.length) {
    await guardedWrite(
      ctx,
      [ctx.callerId, minorId],
      [
        {
          Update: {
            TableName: ctx.deps.table,
            Key: K.profile(minorId),
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: WRITABLE_PROFILE_CONDITION,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ...values, ':active': 'active' },
          },
        },
        closureAbsenceConditionCheck(ctx.deps, minorId),
        ...authorityChecks(ctx, authority),
      ],
      async () => {
        const current = await requireSensitiveMinorAuthority(ctx, minorId, 'manage_minor_identity');
        if (!samePrimaryMinorAuthority(current, authority)) return;
      },
      { [minorId]: { profile: true, closure: true } },
    );
  }
  return profileView(child);
}

export async function exportChild(ctx: Ctx, minorId: string): Promise<ExportEnvelope> {
  const expectedLink = await requireWritableExportAuthority(ctx, minorId);
  const records = await exportRecordsConsistent(ctx, minorId);
  // The postflight keeps a concurrent closure or unlink from returning a stale
  // export. This lifecycle check is deliberately independent of Premium.
  const currentLink = await requireWritableExportAuthority(ctx, minorId);
  if (!samePrimaryMinorAuthority(currentLink, expectedLink)) throw new ApiError('NOT_FOUND');
  const of = <T>(store: string): T[] =>
    records.filter((r) => r.store === store).map((r) => r.record as T);
  return {
    app: 'roadmap2u',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(ctx.deps.now()).toISOString(),
    data: {
      trees: of<Tree>('trees'),
      nodes: of<TreeNode>('nodes'),
      checkins: of<CheckIn>('checkins'),
      sessions: of<TimerSession>('sessions'),
      harvests: of<Harvest>('harvests'),
      preserves: of<Preserve>('preserves'),
      settings: null, // device preferences never reach the cloud
    },
  };
}

/** Export-first is the CLIENT flow; the server purge is total and final. */
export async function deleteChild(
  ctx: Ctx,
  minorId: string,
  closureDeps: AccountClosureDeps = realAccountClosureRequestDeps(ctx.deps),
): Promise<void> {
  await requestGuardianMinorClosure(closureDeps, ctx.callerId, minorId);
}

// ── Links & invites ─────────────────────────────────────────────────────────

export async function deleteFamilyLink(ctx: Ctx, linkId: string): Promise<void> {
  const parsed = composite.parseLinkId(linkId);
  if (!parsed) throw new ApiError('NOT_FOUND');
  const { guardianId, minorId } = parsed;
  // A guardian removes their OWN link; the linked account may also unlink an
  // 'invited' relation from its side.
  const link = await getItem<LinkItem>(ctx.deps, K.link(minorId, guardianId));
  if (!link) throw new ApiError('NOT_FOUND');
  const callerIsGuardian = ctx.callerId === guardianId;
  const callerIsMinorSide = ctx.callerId === minorId && link.kind === 'invited';
  if (!callerIsGuardian && !callerIsMinorSide) throw new ApiError('NOT_FOUND');

  let remaining: LinkItem[] = [];
  if (link.kind === 'created') {
    remaining = (await guardiansOf(ctx.deps, minorId)).filter(
      (l) => l.guardianId !== guardianId,
    );
    if (!remaining.length) throw new ApiError('LAST_GUARDIAN');
  }
  await guardedWrite(
    ctx,
    [guardianId, minorId],
    [
      exactLinkOperation(ctx.deps, link, 'delete'),
      ...(link.kind === 'created'
        ? [removeCreatedMinorFromFence(ctx, guardianId, minorId)]
        : []),
      ...remaining.map((current) => exactLinkOperation(ctx.deps, current, 'check')),
    ],
    async () => {
      const current = await getConsistent<LinkItem>(ctx, K.link(minorId, guardianId));
      if (!current) throw new ApiError('NOT_FOUND');
      if (!sameLink(current, link)) return;
    },
    link.kind === 'created' ? { [guardianId]: { profile: true } } : {},
  );
}

export async function createFamilyInvite(ctx: Ctx, body: FamilyInviteRequest): Promise<CodeGrant> {
  if (ctx.caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
  let minorId: string | null = null;
  let issuerLink: LinkItem | null = null;
  if (body.kind === 'coGuardian') {
    issuerLink = await requireCreatedGuardianOf(ctx, body.minorId);
    if ((await guardiansOf(ctx.deps, body.minorId)).length >= LIMITS.maxGuardiansPerMinor) {
      throw new ApiError('LIMIT_EXCEEDED', `max ${LIMITS.maxGuardiansPerMinor} guardians`);
    }
    minorId = body.minorId;
  } else if (body.kind !== 'linkExisting') {
    throw new ApiError('VALIDATION', 'unknown invite kind');
  }
  const code = friendCode();
  const expiresAt = ctx.deps.now() + INVITE_TTL_MS;
  const item = {
    ...K.codeG(code),
    code,
    kind: body.kind,
    userId: ctx.callerId,
    ...(minorId ? { minorId } : {}),
    closureMirrorVersion: 1,
    expiresAt,
    ttl: Math.ceil(expiresAt / 1000),
  } satisfies CodeItem & { pk: string; sk: string };
  const owners = minorId ? [ctx.callerId, minorId] : [ctx.callerId];
  await guardedWrite(
    ctx,
    owners,
    [
      {
        Put: {
          TableName: ctx.deps.table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      ...guardianInviteMirrors(item).map((mirror) => ({
        Put: {
          TableName: ctx.deps.table,
          Item: mirror,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      })),
      ...(issuerLink ? [exactLinkOperation(ctx.deps, issuerLink, 'check')] : []),
    ],
    issuerLink
      ? async () => {
          const current = await requireCreatedGuardianConsistent(ctx, issuerLink.minorId);
          if (!sameLink(current, issuerLink)) return;
        }
      : undefined,
  );
  return { code, expiresAt };
}

export async function acceptFamilyInvite(
  ctx: Ctx,
  body: { code?: string },
): Promise<FamilyLinkView> {
  const code = body.code?.trim().toUpperCase().replace(/-/g, '');
  if (!code) throw new ApiError('VALIDATION');
  await reserveCodeAttempt(ctx);
  const invite = await getItem<CodeItem>(ctx.deps, K.codeG(code));
  if (!invite) throw new ApiError('CODE_INVALID');
  if (invite.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');

  if (invite.kind === 'coGuardian') {
    const accepted = await acceptLegacyCoGuardianInvite(ctx, invite);
    return linkView(accepted.link, accepted.minor, true);
  }

  const pending = await acceptLegacyLinkExistingInvite(ctx, invite);
  return linkView(pending.link, pending.issuer, false);
}

export async function revokeFamilyInvite(ctx: Ctx, code: string): Promise<void> {
  const invite = await getItem<CodeItem>(ctx.deps, K.codeG(code));
  if (!invite || invite.userId !== ctx.callerId) throw new ApiError('NOT_FOUND');
  await guardedWrite(
    ctx,
    [ctx.callerId, ...(invite.minorId ? [invite.minorId] : [])],
    familyInviteDeleteOperations(ctx, invite),
    async () => {
      const current = await getConsistent<CodeItem>(ctx, K.codeG(code));
      if (!current || current.userId !== ctx.callerId) throw new ApiError('NOT_FOUND');
      if (!sameCode(current, invite)) return;
    },
  );
}

// ── Guardian oversight of a minor's friendships ─────────────────────────────

async function hasV2MinorCoverage(ctx: Ctx, minorId: string): Promise<boolean> {
  const coverage = await getConsistent<CoverageAssignmentItem>(ctx, FK.familyCoverage(minorId));
  return coverage?.entityType === 'CoverageAssignment' &&
    coverage.accountId === minorId &&
    coverage.seatType === 'minor' &&
    typeof coverage.householdId === 'string';
}

export async function listChildFriends(ctx: Ctx, minorId: string): Promise<FriendsResponse> {
  if (await hasV2MinorCoverage(ctx, minorId)) {
    await requireMinorFriendOversight(ctx, minorId);
    return friendsOf(ctx, minorId);
  }
  await requireGuardianOf(ctx, minorId);
  return friendsOf(ctx, minorId);
}

export async function removeChildFriendship(
  ctx: Ctx,
  minorId: string,
  friendshipId: string,
): Promise<void> {
  if (await hasV2MinorCoverage(ctx, minorId)) {
    await requireMinorFriendOversight(ctx, minorId);
    await revokeMinorFriendship(ctx, friendshipId);
    return;
  }
  const guardianLink = await requireGuardianOf(ctx, minorId);
  await removeFriendshipAs(ctx, minorId, friendshipId, guardianLink);
}

export async function cancelChildRequest(
  ctx: Ctx,
  minorId: string,
  requestId: string,
): Promise<void> {
  const guardianLink = await requireGuardianOf(ctx, minorId);
  const outgoing = await queryPrefix<FriendRequestItem>(
    ctx.deps,
    K.user(minorId),
    'FREQ#',
    { index: 'gsi1' },
  );
  const item = outgoing.find((r) => r.requestId === requestId);
  if (!item) throw new ApiError('NOT_FOUND');
  await guardedWrite(
    ctx,
    [ctx.callerId, minorId, item.toId],
    [
      exactRequestOperation(ctx.deps, item, 'delete'),
      exactLinkOperation(ctx.deps, guardianLink, 'check'),
    ],
    async () => {
      const [currentRequest, currentLink] = await Promise.all([
        getConsistent<FriendRequestItem>(ctx, K.freq(item.toId, requestId)),
        getConsistent<LinkItem>(ctx, K.link(minorId, ctx.callerId)),
      ]);
      if (!currentRequest || currentRequest.expiresAt <= ctx.deps.now()) {
        throw new ApiError('NOT_FOUND');
      }
      if (!currentLink) throw new ApiError('NOT_FOUND');
      if (!sameRequest(currentRequest, item) || !sameLink(currentLink, guardianLink)) return;
    },
  );
}
