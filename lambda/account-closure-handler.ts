import { ApiError } from '@app/api/contracts';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  ACCOUNT_CLOSURE_OPEN_GSI_PK,
  accountClosureKey,
  closureOpenSortKey,
  type AccountClosureDeps,
  type AccountClosureItem,
  type AccountClosureState,
} from './account-closure';
import { K, type ProfileItem } from './db';

interface ProfileWithStatus extends ProfileItem {
  status?: 'active' | 'closing';
}

export interface AccountClosureReceipt {
  readonly closureId: string;
  readonly state: AccountClosureState;
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
    checkpoint: { phase: 'friendMirrors' },
  };
  const profileCondition = [
    'attribute_exists(pk)',
    'accountType = :adult',
    '(attribute_not_exists(#status) OR #status = :active)',
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
    if (typeof winner?.closureId !== 'string') throw error;
    if (winner.state !== 'completed') {
      await enqueueDurableClosure(deps, sub, winner.closureId);
    }
    return { closureId: winner.closureId, state: winner.state };
  }

  await enqueueDurableClosure(deps, sub, closureId);
  return { closureId, state: 'requested' };
}
