import { randomUUID } from 'node:crypto';
import { ApiError } from '@app/api/contracts';
import { SQSClient } from '@aws-sdk/client-sqs';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ACCOUNT_CLOSURE_OPEN_GSI_PK,
  accountClosureKey,
  closureOpenSortKey,
  createAccountClosureQueue,
  type AccountClosureDeps,
  type AccountClosureItem,
  type AccountClosureState,
} from './account-closure';
import { AuditWriter } from './commercial/audit';
import { K, type Deps, type LinkItem, type ProfileItem } from './db';

interface ProfileWithStatus extends ProfileItem {
  status?: 'active' | 'closing';
}

export interface AccountClosureReceipt {
  readonly closureId: string;
  readonly state: Exclude<AccountClosureState, 'blocked'>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Enriches the router's already configured data clients with closure-only dependencies. */
export function realAccountClosureRequestDeps(base: Deps): AccountClosureDeps {
  return {
    ...base,
    auditWriter: new AuditWriter({
      ddb: base.ddb,
      tableName: requiredEnvironment('AUDIT_TABLE_NAME'),
    }),
    queue: createAccountClosureQueue(
      new SQSClient({}),
      requiredEnvironment('ACCOUNT_CLOSURE_QUEUE_URL'),
    ),
    nextClosureId: randomUUID,
    nextWorkerId: randomUUID,
  };
}

async function enqueueDurableClosure(
  deps: AccountClosureDeps,
  sub: string,
  closureId: string,
): Promise<void> {
  await deps.queue.enqueue({ sub, closureId }).catch(() => {
    // ACCOUNT_CLOSURE is the durable outbox; the reconciler retries delivery.
  });
}

export async function requestAccountClosure(
  deps: AccountClosureDeps,
  sub: string,
  requestId: string,
): Promise<AccountClosureReceipt> {
  const existingResult = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: accountClosureKey(sub),
      ConsistentRead: true,
    }),
  );
  const existing = existingResult.Item as AccountClosureItem | undefined;
  if (typeof existing?.closureId === 'string') {
    if (existing.state === 'blocked') {
      throw new ApiError('CONFLICT', 'account closure is blocked by family ownership');
    }
    if (existing.state !== 'completed') {
      await enqueueDurableClosure(deps, sub, existing.closureId);
    }
    return { closureId: existing.closureId, state: existing.state };
  }

  const profileResult = await deps.ddb.send(
    new GetCommand({ TableName: deps.table, Key: K.profile(sub), ConsistentRead: true }),
  );
  const profile = profileResult.Item as ProfileWithStatus | undefined;
  if (
    !profile ||
    profile.accountType !== 'adult' ||
    (profile.status !== undefined && profile.status !== 'active')
  ) {
    throw new ApiError('CONFLICT', 'account is not writable');
  }

  const now = deps.now();
  const closureId = deps.nextClosureId();
  const closure: AccountClosureItem = {
    ...accountClosureKey(sub),
    closureId,
    kind: 'self_adult',
    actorSub: sub,
    sub,
    username: profile.username,
    ...(profile.friendCode ? { friendCode: profile.friendCode } : {}),
    state: 'requested',
    revision: 1,
    requestedAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    gsi1pk: ACCOUNT_CLOSURE_OPEN_GSI_PK,
    gsi1sk: closureOpenSortKey(now, sub),
    checkpoint: { phase: 'inboundGuardianLinks' },
  };
  const profileCondition = [
    'attribute_exists(pk)',
    'accountType = :adult',
    '(attribute_not_exists(#status) OR #status = :active)',
    'familyFenceVersion = :familyFenceVersion',
    'attribute_not_exists(createdMinorIds)',
    'username = :username',
    profile.friendCode ? 'friendCode = :friendCode' : 'attribute_not_exists(friendCode)',
  ].join(' AND ');

  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.table,
              Item: closure,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          {
            Update: {
              TableName: deps.table,
              Key: K.profile(sub),
              UpdateExpression: 'SET #status = :closing',
              ConditionExpression: profileCondition,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':adult': 'adult',
                ':active': 'active',
                ':closing': 'closing',
                ':familyFenceVersion': 1,
                ':username': profile.username,
                ...(profile.friendCode ? { ':friendCode': profile.friendCode } : {}),
              },
            },
          },
          deps.auditWriter.transactPut({
            targetKind: 'USER',
            targetId: sub,
            timestamp: now,
            requestId,
            action: 'account_closure.requested',
            actor: `user:${sub}`,
            subject: sub,
            details: { closureId, requestId, from: null, to: 'requested' },
          }),
        ],
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name !== 'TransactionCanceledException') throw error;
    const winnerResult = await deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: accountClosureKey(sub),
        ConsistentRead: true,
      }),
    );
    const winner = winnerResult.Item as AccountClosureItem | undefined;
    if (typeof winner?.closureId !== 'string') {
      const currentProfile = await readConsistent<ProfileWithStatus>(deps, K.profile(sub));
      if (
        currentProfile?.familyFenceVersion !== 1 ||
        currentProfile.createdMinorIds !== undefined
      ) {
        throw new ApiError('CONFLICT', 'family ownership must be reconciled before closure');
      }
      throw error;
    }
    if (winner.state === 'blocked') {
      throw new ApiError('CONFLICT', 'account closure is blocked by family ownership');
    }
    if (winner.state !== 'completed') {
      await enqueueDurableClosure(deps, sub, winner.closureId);
    }
    return { closureId: winner.closureId, state: winner.state };
  }

  await enqueueDurableClosure(deps, sub, closureId);
  return { closureId, state: 'requested' };
}

function sameGuardianMinorClosure(
  closure: AccountClosureItem | undefined,
  guardianSub: string,
  minorSub: string,
): closure is AccountClosureItem {
  return (
    closure?.kind === 'guardian_minor' &&
    closure.actorSub === guardianSub &&
    closure.sub === minorSub
  );
}

function isWritableProfile(profile: ProfileWithStatus | undefined): profile is ProfileWithStatus {
  return Boolean(profile && (profile.status === undefined || profile.status === 'active'));
}

function guardianFenceAllowsMinor(profile: ProfileWithStatus, minorSub: string): boolean {
  const version = (profile as { familyFenceVersion?: unknown }).familyFenceVersion;
  if (version === undefined) return true;
  if (version !== 1) return false;
  return profile.createdMinorIds instanceof Set && profile.createdMinorIds.has(minorSub);
}

async function readConsistent<T>(
  deps: Pick<AccountClosureDeps, 'ddb' | 'table'>,
  key: { pk: string; sk: string },
): Promise<T | undefined> {
  const result = await deps.ddb.send(
    new GetCommand({ TableName: deps.table, Key: key, ConsistentRead: true }),
  );
  return result.Item as T | undefined;
}

/**
 * Starts deletion of a guardian-created minor through the same durable outbox,
 * worker, checkpoint and reconciler used by adult account closure.
 */
export async function requestGuardianMinorClosure(
  deps: AccountClosureDeps,
  guardianSub: string,
  minorSub: string,
): Promise<AccountClosureReceipt> {
  const closureKey = accountClosureKey(minorSub);
  const existing = await readConsistent<AccountClosureItem>(deps, closureKey);
  if (existing) {
    if (!sameGuardianMinorClosure(existing, guardianSub, minorSub)) {
      throw new ApiError('CONFLICT', 'account closure belongs to another actor');
    }
    if (existing.state === 'blocked') {
      throw new ApiError('CONFLICT', 'minor closure is blocked by family ownership');
    }
    if (existing.state !== 'completed') {
      await enqueueDurableClosure(deps, minorSub, existing.closureId);
    }
    return { closureId: existing.closureId, state: existing.state };
  }

  const [guardian, minor, guardianClosure, link] = await Promise.all([
    readConsistent<ProfileWithStatus>(deps, K.profile(guardianSub)),
    readConsistent<ProfileWithStatus>(deps, K.profile(minorSub)),
    readConsistent<AccountClosureItem>(deps, accountClosureKey(guardianSub)),
    readConsistent<LinkItem>(deps, K.link(minorSub, guardianSub)),
  ]);
  if (!isWritableProfile(guardian) || guardian.accountType !== 'adult' || guardianClosure) {
    throw new ApiError('CONFLICT', 'guardian account is not writable');
  }
  if (!guardianFenceAllowsMinor(guardian, minorSub)) {
    throw new ApiError('CONFLICT', 'guardian family ownership is not authoritative');
  }
  if (!isWritableProfile(minor) || minor.accountType !== 'minor') {
    throw new ApiError('NOT_FOUND');
  }
  if (
    !link ||
    link.kind !== 'created' ||
    link.guardianId !== guardianSub ||
    link.minorId !== minorSub
  ) {
    throw new ApiError('NOT_FOUND');
  }

  const now = deps.now();
  const closureId = deps.nextClosureId();
  const closure: AccountClosureItem = {
    ...closureKey,
    closureId,
    kind: 'guardian_minor',
    actorSub: guardianSub,
    sub: minorSub,
    username: minor.username,
    ...(minor.friendCode ? { friendCode: minor.friendCode } : {}),
    state: 'requested',
    revision: 1,
    requestedAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    gsi1pk: ACCOUNT_CLOSURE_OPEN_GSI_PK,
    gsi1sk: closureOpenSortKey(now, minorSub),
    checkpoint: { phase: 'inboundGuardianLinks' },
  };
  const requestId = `${closureId}-requested`;

  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.table,
              Item: closure,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          {
            Update: {
              TableName: deps.table,
              Key: K.profile(minorSub),
              UpdateExpression: 'SET #status = :closing',
              ConditionExpression: [
                'attribute_exists(pk)',
                'accountType = :minor',
                '(attribute_not_exists(#status) OR #status = :active)',
                'userId = :minorSub',
                'username = :username',
                minor.friendCode ? 'friendCode = :friendCode' : 'attribute_not_exists(friendCode)',
                '(attribute_not_exists(identityLeaseUntil) OR identityLeaseUntil < :now)',
              ].join(' AND '),
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':minor': 'minor',
                ':active': 'active',
                ':closing': 'closing',
                ':minorSub': minorSub,
                ':username': minor.username,
                ':now': now,
                ...(minor.friendCode ? { ':friendCode': minor.friendCode } : {}),
              },
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: K.profile(guardianSub),
              ConditionExpression: [
                'attribute_exists(pk)',
                'accountType = :adult',
                '(attribute_not_exists(#status) OR #status = :active)',
                'userId = :guardianSub',
                'username = :guardianUsername',
                '(attribute_not_exists(familyFenceVersion) OR familyFenceVersion = :familyFenceVersion)',
                '(attribute_not_exists(familyFenceVersion) OR contains(createdMinorIds, :minorSub))',
              ].join(' AND '),
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':adult': 'adult',
                ':active': 'active',
                ':guardianSub': guardianSub,
                ':guardianUsername': guardian.username,
                ':familyFenceVersion': 1,
                ':minorSub': minorSub,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: accountClosureKey(guardianSub),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: K.link(minorSub, guardianSub),
              ConditionExpression: [
                'attribute_exists(pk)',
                '#kind = :created',
                'guardianId = :guardianId',
                'minorId = :minorId',
                'linkId = :linkId',
                'createdAt = :createdAt',
                'gsi1pk = :gsi1pk',
                'gsi1sk = :gsi1sk',
              ].join(' AND '),
              ExpressionAttributeNames: { '#kind': 'kind' },
              ExpressionAttributeValues: {
                ':created': 'created',
                ':guardianId': guardianSub,
                ':minorId': minorSub,
                ':linkId': link.linkId,
                ':createdAt': link.createdAt,
                ':gsi1pk': link.gsi1pk,
                ':gsi1sk': link.gsi1sk,
              },
            },
          },
          deps.auditWriter.transactPut({
            targetKind: 'USER',
            targetId: minorSub,
            timestamp: now,
            requestId,
            action: 'account_closure.requested',
            actor: `user:${guardianSub}`,
            subject: minorSub,
            details: {
              closureId,
              kind: 'guardian_minor',
              actorSub: guardianSub,
              from: null,
              to: 'requested',
            },
          }),
        ],
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name !== 'TransactionCanceledException') throw error;
    const winner = await readConsistent<AccountClosureItem>(deps, closureKey);
    if (!sameGuardianMinorClosure(winner, guardianSub, minorSub)) {
      throw new ApiError('CONFLICT', 'minor closure request raced another mutation');
    }
    if (winner.state === 'blocked') {
      throw new ApiError('CONFLICT', 'minor closure is blocked by family ownership');
    }
    if (winner.state !== 'completed') {
      await enqueueDurableClosure(deps, minorSub, winner.closureId);
    }
    return { closureId: winner.closureId, state: winner.state };
  }

  await enqueueDurableClosure(deps, minorSub, closureId);
  return { closureId, state: 'requested' };
}
