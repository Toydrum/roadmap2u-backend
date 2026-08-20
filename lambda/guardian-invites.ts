import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { K, type CodeItem, type Deps } from './db';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export interface GuardianInviteMirrorItem {
  readonly pk: string;
  readonly sk: string;
  readonly subjectId: string;
  readonly code: string;
  readonly kind: 'coGuardian' | 'linkExisting';
  readonly userId: string;
  readonly minorId?: string;
  readonly expiresAt: number;
  readonly ttl: number;
  readonly closureMirrorVersion: 1;
}

function assertMirroredGuardianInvite(
  invite: CodeItem,
): asserts invite is CodeItem & {
  kind: 'coGuardian' | 'linkExisting';
  closureMirrorVersion: 1;
} {
  if (
    (invite.kind !== 'coGuardian' && invite.kind !== 'linkExisting') ||
    invite.closureMirrorVersion !== 1
  ) {
    throw new Error('guardian invite is not closure-mirrored');
  }
}

export function guardianInviteMirrorKey(subjectId: string, code: string) {
  return { pk: K.user(subjectId), sk: `GINVITE#${code}` };
}

export function guardianInviteMirrors(invite: CodeItem): GuardianInviteMirrorItem[] {
  assertMirroredGuardianInvite(invite);
  const subjects = [...new Set([invite.userId, invite.minorId].filter(Boolean) as string[])];
  return subjects.map((subjectId) => ({
    ...guardianInviteMirrorKey(subjectId, invite.code),
    subjectId,
    code: invite.code,
    kind: invite.kind,
    userId: invite.userId,
    ...(invite.minorId ? { minorId: invite.minorId } : {}),
    expiresAt: invite.expiresAt,
    ttl: invite.ttl,
    closureMirrorVersion: 1,
  }));
}

export function guardianInviteFromMirror(mirror: GuardianInviteMirrorItem): CodeItem {
  const structurallyValid =
    mirror.closureMirrorVersion === 1 &&
    typeof mirror.subjectId === 'string' &&
    Boolean(mirror.subjectId) &&
    typeof mirror.code === 'string' &&
    Boolean(mirror.code) &&
    mirror.code.length <= 64 &&
    mirror.pk === K.user(mirror.subjectId) &&
    mirror.sk === `GINVITE#${mirror.code}` &&
    typeof mirror.userId === 'string' &&
    Boolean(mirror.userId) &&
    Number.isSafeInteger(mirror.expiresAt) &&
    Number.isSafeInteger(mirror.ttl) &&
    (mirror.kind === 'coGuardian'
      ? typeof mirror.minorId === 'string' &&
        Boolean(mirror.minorId) &&
        mirror.userId !== mirror.minorId &&
        (mirror.subjectId === mirror.userId || mirror.subjectId === mirror.minorId)
      : mirror.kind === 'linkExisting' &&
        mirror.minorId === undefined &&
        mirror.subjectId === mirror.userId);
  if (!structurallyValid) throw new Error('invalid guardian invite mirror');
  return {
    ...K.codeG(mirror.code),
    code: mirror.code,
    kind: mirror.kind,
    userId: mirror.userId,
    ...(mirror.minorId ? { minorId: mirror.minorId } : {}),
    expiresAt: mirror.expiresAt,
    ttl: mirror.ttl,
    closureMirrorVersion: 1,
  };
}

function mirrorIdentity(mirror: GuardianInviteMirrorItem) {
  return {
    expression: [
      'subjectId = :subjectId',
      '#code = :code',
      '#kind = :kind',
      'userId = :userId',
      mirror.minorId === undefined ? 'attribute_not_exists(minorId)' : 'minorId = :minorId',
      'expiresAt = :expiresAt',
      '#ttl = :ttl',
      'closureMirrorVersion = :closureMirrorVersion',
    ].join(' AND '),
    names: { '#code': 'code', '#kind': 'kind', '#ttl': 'ttl' },
    values: {
      ':subjectId': mirror.subjectId,
      ':code': mirror.code,
      ':kind': mirror.kind,
      ':userId': mirror.userId,
      ...(mirror.minorId === undefined ? {} : { ':minorId': mirror.minorId }),
      ':expiresAt': mirror.expiresAt,
      ':ttl': mirror.ttl,
      ':closureMirrorVersion': 1,
    },
  };
}

/** Missing mirrors are allowed so TTL and concurrent closure remain idempotent. */
export function idempotentGuardianInviteMirrorDelete(
  deps: Pick<Deps, 'table'>,
  mirror: GuardianInviteMirrorItem,
): TransactItem {
  const identity = mirrorIdentity(mirror);
  return {
    Delete: {
      TableName: deps.table,
      Key: { pk: mirror.pk, sk: mirror.sk },
      ConditionExpression: `attribute_not_exists(pk) OR (${identity.expression})`,
      ExpressionAttributeNames: identity.names,
      ExpressionAttributeValues: identity.values,
    },
  };
}

/** Missing codes are allowed; a later code reusing the key is never deleted. */
export function idempotentGuardianInviteCodeDelete(
  deps: Pick<Deps, 'table'>,
  invite: CodeItem,
): TransactItem {
  assertMirroredGuardianInvite(invite);
  const minorCondition =
    invite.minorId === undefined ? 'attribute_not_exists(minorId)' : 'minorId = :minorId';
  return {
    Delete: {
      TableName: deps.table,
      Key: K.codeG(invite.code),
      ConditionExpression: [
        'attribute_not_exists(pk) OR (',
        '#code = :code AND #kind = :kind AND userId = :userId AND',
        `${minorCondition} AND expiresAt = :expiresAt AND #ttl = :ttl AND`,
        'closureMirrorVersion = :closureMirrorVersion)',
      ].join(' '),
      ExpressionAttributeNames: { '#code': 'code', '#kind': 'kind', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':code': invite.code,
        ':kind': invite.kind,
        ':userId': invite.userId,
        ...(invite.minorId === undefined ? {} : { ':minorId': invite.minorId }),
        ':expiresAt': invite.expiresAt,
        ':ttl': invite.ttl,
        ':closureMirrorVersion': 1,
      },
    },
  };
}

export function guardianInviteClosureDeletes(
  deps: Pick<Deps, 'table'>,
  invite: CodeItem,
): TransactItem[] {
  return [
    idempotentGuardianInviteCodeDelete(deps, invite),
    ...guardianInviteMirrors(invite).map((mirror) =>
      idempotentGuardianInviteMirrorDelete(deps, mirror),
    ),
  ];
}
