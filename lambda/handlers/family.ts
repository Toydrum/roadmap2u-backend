import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  minorsOf,
  profileOf,
  requireCreatedGuardianOf,
  requireGuardianOf,
  requireGuardianOfConsistent,
  requireWritableOwner,
  toPublic,
} from '../authz';
import { accountClosureKey, type AccountClosureDeps } from '../account-closure';
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
  composite,
  getItem,
  queryPrefix,
  readRateCount,
} from '../db';
import { friendCode, tempPassword } from '../codes';
import {
  guardianInviteMirrors,
  idempotentGuardianInviteMirrorDelete,
} from '../guardian-invites';
import { profileView } from './me';
import { friendsOf, removeFriendshipAs } from './friends';
import {
  exactCodeOperation,
  exactLinkOperation,
  exactRequestOperation,
  getConsistent,
  guardedWrite,
  recordBadAttempt,
  sameCode,
  sameLink,
  sameRequest,
} from './guarded-mutation';

const INVITE_TTL_MS = 72 * 3600 * 1000;
const IDENTITY_OPERATION_LEASE_MS = 60_000;

async function requireCreatedGuardianConsistent(ctx: Ctx, minorId: string): Promise<LinkItem> {
  const current = await requireGuardianOfConsistent(ctx, minorId);
  if (current.kind !== 'created') {
    throw new ApiError('FORBIDDEN', 'invited links have no identity admin');
  }
  return current;
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
  if ((await minorsOf(ctx.deps, ctx.callerId)).length >= LIMITS.maxChildrenPerGuardian) {
    throw new ApiError(
      'LIMIT_EXCEEDED',
      `max ${LIMITS.maxChildrenPerGuardian} minors per guardian`,
    );
  }

  // Cognito owns login-name uniqueness; SUPPRESS = no invitation email (kids
  // have none). The guardian relays the temp password in person.
  const password = tempPassword();
  let sub: string;
  try {
    const created = await ctx.deps.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: ctx.deps.userPoolId,
        Username: username,
        TemporaryPassword: password,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'name', Value: displayName },
          { Name: 'custom:accountType', Value: 'minor' },
        ],
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? username;
  } catch (error) {
    if ((error as { name?: string })?.name === 'UsernameExistsException') {
      throw new ApiError('USERNAME_TAKEN');
    }
    throw error;
  }

  const now = ctx.deps.now();
  const child: ProfileItem = {
    ...K.profile(sub),
    userId: sub,
    username,
    displayName,
    accountType: 'minor',
    socialEnabled: false,
    createdAt: now,
    status: 'active',
  };
  try {
    await guardedWrite(
      ctx,
      [ctx.callerId],
      [
        closureAbsenceConditionCheck(ctx.deps, sub),
        {
          Put: {
            TableName: ctx.deps.table,
            Item: { ...K.uniqUsername(username), userId: sub },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: ctx.deps.table,
            Item: child,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: ctx.deps.table,
            Item: linkItem(ctx.callerId, sub, 'created', now),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
      async () => {
        const [closure, reservation] = await Promise.all([
          getConsistent<Record<string, unknown>>(ctx, accountClosureKey(sub)),
          getConsistent<{ userId?: string }>(ctx, K.uniqUsername(username)),
        ]);
        if (closure) throw new ApiError('CONFLICT', 'account closure is in progress');
        if (reservation) throw new ApiError('USERNAME_TAKEN');
      },
    );
  } catch (error) {
    // Compensate the identity so a failed transact never leaves a ghost login.
    await ctx.deps.cognito
      .send(new AdminDeleteUserCommand({ UserPoolId: ctx.deps.userPoolId, Username: username }))
      .catch(() => {});
    throw error;
  }
  return { child: profileView(child), tempPassword: password };
}

export async function resetChildPassword(
  ctx: Ctx,
  minorId: string,
  nextIdentityLeaseId: () => string = randomUUID,
): Promise<{ tempPassword: string }> {
  const guardianLink = await requireCreatedGuardianConsistent(ctx, minorId);
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
      exactLinkOperation(ctx.deps, guardianLink, 'check'),
    ],
    async () => {
      const currentLink = await requireCreatedGuardianConsistent(ctx, minorId);
      if (!sameLink(currentLink, guardianLink)) return;
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
    await ctx.deps.ddb.send(
      new UpdateCommand({
        TableName: ctx.deps.table,
        Key: K.profile(minorId),
        UpdateExpression: 'REMOVE identityLeaseOwner, identityLeaseUntil',
        ConditionExpression: 'identityLeaseOwner = :identityLeaseOwner',
        ExpressionAttributeValues: { ':identityLeaseOwner': identityLeaseOwner },
      }),
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
  const guardianLink = await requireCreatedGuardianOf(ctx, minorId);
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
        exactLinkOperation(ctx.deps, guardianLink, 'check'),
      ],
      async () => {
        const currentLink = await requireCreatedGuardianConsistent(ctx, minorId);
        if (!sameLink(currentLink, guardianLink)) return;
      },
      { [minorId]: { profile: true, closure: true } },
    );
  }
  return profileView(child);
}

export async function exportChild(ctx: Ctx, minorId: string): Promise<ExportEnvelope> {
  await requireCreatedGuardianOf(ctx, minorId);
  const records = await queryPrefix<RecordItem>(ctx.deps, K.user(minorId), 'REC#');
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
      ...remaining.map((current) => exactLinkOperation(ctx.deps, current, 'check')),
    ],
    async () => {
      const current = await getConsistent<LinkItem>(ctx, K.link(minorId, guardianId));
      if (!current) throw new ApiError('NOT_FOUND');
      if (!sameLink(current, link)) return;
    },
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
  // Same guessing brake as friend codes (0.0.115 S1 — this door had none):
  // 5 bad redemptions per rolling hour, shared bucket with friend attempts.
  if ((await readRateCount(ctx.deps, ctx.callerId)) >= LIMITS.codeAttemptsPerHour) {
    throw new ApiError('RATE_LIMITED');
  }
  const badAttempt = async (errorCode: 'CODE_INVALID' | 'CODE_EXPIRED'): Promise<never> => {
    await recordBadAttempt(ctx);
    throw new ApiError(errorCode);
  };
  const invite = await getItem<CodeItem>(ctx.deps, K.codeG(code));
  if (!invite) return badAttempt('CODE_INVALID');
  if (invite.expiresAt <= ctx.deps.now()) return badAttempt('CODE_EXPIRED');

  const now = ctx.deps.now();
  if (invite.kind === 'coGuardian') {
    // Redeemer becomes a co-guardian of the invite's minor.
    if (ctx.caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
    const minorId = invite.minorId;
    if (!minorId) return badAttempt('CODE_INVALID');
    const issuerLink = await getItem<LinkItem>(ctx.deps, K.link(minorId, invite.userId));
    if (issuerLink?.kind !== 'created') return badAttempt('CODE_INVALID');
    const minor = await profileOf(ctx.deps, minorId);
    if (!minor) throw new ApiError('NOT_FOUND');
    if (await getItem<LinkItem>(ctx.deps, K.link(minorId, ctx.callerId))) {
      throw new ApiError('CONFLICT', 'already a guardian');
    }
    if ((await guardiansOf(ctx.deps, minorId)).length >= LIMITS.maxGuardiansPerMinor) {
      throw new ApiError('LIMIT_EXCEEDED');
    }
    const link = linkItem(ctx.callerId, minorId, 'created', now);
    const owners = [ctx.callerId, invite.userId, minorId];
    await guardedWrite(
      ctx,
      owners,
      [
        {
          Put: {
            TableName: ctx.deps.table,
            Item: link,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        ...familyInviteDeleteOperations(ctx, invite),
        exactLinkOperation(ctx.deps, issuerLink, 'check'),
      ],
      async () => {
        const [currentInvite, currentIssuerLink, currentLink] = await Promise.all([
          getConsistent<CodeItem>(ctx, K.codeG(code)),
          getConsistent<LinkItem>(ctx, K.link(minorId, invite.userId)),
          getConsistent<LinkItem>(ctx, K.link(minorId, ctx.callerId)),
        ]);
        if (!currentInvite || currentInvite.kind !== 'coGuardian') {
          throw new ApiError('CODE_INVALID');
        }
        if (currentInvite.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');
        if (!currentIssuerLink || currentIssuerLink.kind !== 'created') {
          throw new ApiError('CODE_INVALID');
        }
        if (currentLink) throw new ApiError('CONFLICT', 'already a guardian');
        if (!sameCode(currentInvite, invite) || !sameLink(currentIssuerLink, issuerLink)) return;
      },
    );
    return linkView(link, minor, true);
  }

  // linkExisting: the REDEEMER consents to become the issuer's invited minor.
  const issuer = await profileOf(ctx.deps, invite.userId);
  if (!issuer) throw new ApiError('CODE_INVALID');
  if (invite.userId === ctx.callerId) throw new ApiError('VALIDATION', 'that is your own invite');
  if (await getItem<LinkItem>(ctx.deps, K.link(ctx.callerId, invite.userId))) {
    throw new ApiError('CONFLICT', 'already linked');
  }
  if ((await minorsOf(ctx.deps, invite.userId)).length >= LIMITS.maxChildrenPerGuardian) {
    throw new ApiError('LIMIT_EXCEEDED');
  }
  const link = linkItem(invite.userId, ctx.callerId, 'invited', now);
  await guardedWrite(
    ctx,
    [ctx.callerId, invite.userId],
    [
      {
        Put: {
          TableName: ctx.deps.table,
          Item: link,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      ...familyInviteDeleteOperations(ctx, invite),
    ],
    async () => {
      const [currentInvite, currentLink] = await Promise.all([
        getConsistent<CodeItem>(ctx, K.codeG(code)),
        getConsistent<LinkItem>(ctx, K.link(ctx.callerId, invite.userId)),
      ]);
      if (!currentInvite || currentInvite.kind !== 'linkExisting') {
        throw new ApiError('CODE_INVALID');
      }
      if (currentInvite.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');
      if (currentLink) throw new ApiError('CONFLICT', 'already linked');
      if (!sameCode(currentInvite, invite)) return;
    },
  );
  // The redeemer sees the GUARDIAN on the other end of this new link.
  return linkView(link, issuer, false);
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

export async function listChildFriends(ctx: Ctx, minorId: string): Promise<FriendsResponse> {
  await requireGuardianOf(ctx, minorId);
  return friendsOf(ctx, minorId);
}

export async function removeChildFriendship(
  ctx: Ctx,
  minorId: string,
  friendshipId: string,
): Promise<void> {
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
