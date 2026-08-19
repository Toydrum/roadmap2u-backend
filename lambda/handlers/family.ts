import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
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
  guardiansOf,
  minorsOf,
  profileOf,
  requireCreatedGuardianOf,
  requireGuardianOf,
  toPublic,
} from '../authz';
import {
  CodeItem,
  FriendItem,
  K,
  LinkItem,
  ProfileItem,
  RecordItem,
  TransactWriteCommand,
  UpdateCommand,
  batchWriteAll,
  bumpBadAttempt,
  composite,
  deleteItem,
  getItem,
  putItem,
  queryPrefix,
  readRateCount,
} from '../db';
import { friendCode, tempPassword } from '../codes';
import { profileView } from './me';
import { friendsOf, removeFriendshipAs } from './friends';

const INVITE_TTL_MS = 72 * 3600 * 1000;

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
  };
  try {
    await ctx.deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: ctx.deps.table,
              Item: { ...K.uniqUsername(username), userId: sub },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: ctx.deps.table, Item: child } },
          { Put: { TableName: ctx.deps.table, Item: linkItem(ctx.callerId, sub, 'created', now) } },
        ],
      }),
    );
  } catch (error) {
    // Compensate the identity so a failed transact never leaves a ghost login.
    await ctx.deps.cognito
      .send(new AdminDeleteUserCommand({ UserPoolId: ctx.deps.userPoolId, Username: username }))
      .catch(() => {});
    if ((error as { name?: string })?.name === 'TransactionCanceledException') {
      throw new ApiError('USERNAME_TAKEN');
    }
    throw error;
  }
  return { child: profileView(child), tempPassword: password };
}

export async function resetChildPassword(
  ctx: Ctx,
  minorId: string,
): Promise<{ tempPassword: string }> {
  await requireCreatedGuardianOf(ctx, minorId);
  const child = await profileOf(ctx.deps, minorId);
  if (!child) throw new ApiError('NOT_FOUND');
  const password = tempPassword();
  await ctx.deps.cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: ctx.deps.userPoolId,
      Username: child.username,
      Password: password,
      Permanent: false, // next sign-in lands in the newPasswordRequired step
    }),
  );
  return { tempPassword: password };
}

export async function patchChild(
  ctx: Ctx,
  minorId: string,
  body: { displayName?: string; socialEnabled?: boolean },
): Promise<UserProfile> {
  await requireCreatedGuardianOf(ctx, minorId);
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
    await ctx.deps.ddb.send(
      new UpdateCommand({
        TableName: ctx.deps.table,
        Key: K.profile(minorId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeValues: values,
      }),
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
export async function deleteChild(ctx: Ctx, minorId: string): Promise<void> {
  await requireCreatedGuardianOf(ctx, minorId);
  const child = await profileOf(ctx.deps, minorId);
  if (!child) throw new ApiError('NOT_FOUND');

  await ctx.deps.cognito
    .send(new AdminDeleteUserCommand({ UserPoolId: ctx.deps.userPoolId, Username: child.username }))
    .catch(() => {}); // identity may already be gone; the purge still runs

  // Friendship mirrors live on OTHER users' partitions — collect before purge.
  const friendEdges = await queryPrefix<FriendItem>(ctx.deps, K.user(minorId), 'FRIEND#');
  const partition = await queryPrefix<{ pk: string; sk: string }>(ctx.deps, K.user(minorId), '');
  const keys: { pk: string; sk: string }[] = [
    ...partition.map(({ pk, sk }) => ({ pk, sk })),
    ...friendEdges.map((edge) => {
      const otherId = edge.userA === minorId ? edge.userB : edge.userA;
      return K.friend(otherId, minorId);
    }),
    K.uniqUsername(child.username),
  ];
  if (child.friendCode) keys.push(K.codeF(child.friendCode));
  await batchWriteAll(
    ctx.deps,
    keys.map((key) => ({ DeleteRequest: { Key: key } })),
  );
  // Guardian invites for this minor expire via TTL (≤72 h) — acceptable orphan.
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

  if (link.kind === 'created') {
    const remaining = (await guardiansOf(ctx.deps, minorId)).filter(
      (l) => l.guardianId !== guardianId,
    );
    if (!remaining.length) throw new ApiError('LAST_GUARDIAN');
  }
  await deleteItem(ctx.deps, K.link(minorId, guardianId));
}

export async function createFamilyInvite(ctx: Ctx, body: FamilyInviteRequest): Promise<CodeGrant> {
  if (ctx.caller.accountType !== 'adult') throw new ApiError('FORBIDDEN');
  let minorId: string | null = null;
  if (body.kind === 'coGuardian') {
    await requireCreatedGuardianOf(ctx, body.minorId);
    if ((await guardiansOf(ctx.deps, body.minorId)).length >= LIMITS.maxGuardiansPerMinor) {
      throw new ApiError('LIMIT_EXCEEDED', `max ${LIMITS.maxGuardiansPerMinor} guardians`);
    }
    minorId = body.minorId;
  } else if (body.kind !== 'linkExisting') {
    throw new ApiError('VALIDATION', 'unknown invite kind');
  }
  const code = friendCode();
  const expiresAt = ctx.deps.now() + INVITE_TTL_MS;
  await putItem(ctx.deps, {
    ...K.codeG(code),
    code,
    kind: body.kind,
    userId: ctx.callerId,
    ...(minorId ? { minorId } : {}),
    expiresAt,
    ttl: Math.ceil(expiresAt / 1000),
  } satisfies CodeItem & { pk: string; sk: string });
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
    await bumpBadAttempt(ctx.deps, ctx.callerId);
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
    await putItem(ctx.deps, link as unknown as Record<string, unknown>);
    await deleteItem(ctx.deps, K.codeG(code)); // single-use
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
  await putItem(ctx.deps, link as unknown as Record<string, unknown>);
  await deleteItem(ctx.deps, K.codeG(code));
  // The redeemer sees the GUARDIAN on the other end of this new link.
  return linkView(link, issuer, false);
}

export async function revokeFamilyInvite(ctx: Ctx, code: string): Promise<void> {
  const invite = await getItem<CodeItem>(ctx.deps, K.codeG(code));
  if (!invite || invite.userId !== ctx.callerId) throw new ApiError('NOT_FOUND');
  await deleteItem(ctx.deps, K.codeG(code));
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
  await requireGuardianOf(ctx, minorId);
  await removeFriendshipAs(ctx, minorId, friendshipId);
}

export async function cancelChildRequest(
  ctx: Ctx,
  minorId: string,
  requestId: string,
): Promise<void> {
  await requireGuardianOf(ctx, minorId);
  const outgoing = await queryPrefix<{ requestId: string; toId: string }>(
    ctx.deps,
    K.user(minorId),
    'FREQ#',
    { index: 'gsi1' },
  );
  const item = outgoing.find((r) => r.requestId === requestId);
  if (!item) throw new ApiError('NOT_FOUND');
  await deleteItem(ctx.deps, K.freq(item.toId, requestId));
}
