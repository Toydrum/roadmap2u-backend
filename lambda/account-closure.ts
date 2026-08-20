import { randomUUID } from 'node:crypto';
import { AuditWriter } from './commercial/audit';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  GetCommand,
  K,
  TransactWriteCommand,
  UpdateCommand,
  batchWriteAll,
  queryPrefixPage,
  type Deps,
  type DynamoKey,
  type FriendItem,
} from './db';
import { instrumentHandler } from './observability';
import {
  guardianInviteClosureDeletes,
  guardianInviteFromMirror,
  type GuardianInviteMirrorItem,
} from './guardian-invites';

export const ACCOUNT_CLOSURE_OPEN_GSI_PK = 'ACCOUNT_CLOSURE#OPEN';

export type AccountClosureState = 'requested' | 'purging' | 'purgeComplete' | 'completed';

export type AccountClosureKind = 'self_adult' | 'guardian_minor';

export type AccountClosurePhase =
  | 'friendMirrors'
  | 'outgoingFriendRequests'
  | 'guardianLinks'
  | 'guardianInvites'
  | 'directMirrors'
  | 'userPartition';

export interface AccountClosureCheckpoint {
  readonly phase: AccountClosurePhase;
  readonly exclusiveStartKey?: DynamoKey;
  readonly quietPasses?: number;
}

export interface AccountClosureItem {
  readonly pk: string;
  readonly sk: 'STATE';
  readonly closureId: string;
  /** Optional only for closure records created before closure kinds were introduced. */
  readonly kind?: AccountClosureKind;
  /** Actor snapshot; guardian-minor retries are authorized against this value. */
  readonly actorSub?: string;
  readonly sub: string;
  readonly username: string;
  readonly friendCode?: string;
  readonly state: AccountClosureState;
  readonly revision: number;
  readonly requestedAt: number;
  readonly updatedAt: number;
  readonly nextAttemptAt?: number;
  readonly gsi1pk?: string;
  readonly gsi1sk?: string;
  readonly checkpoint?: AccountClosureCheckpoint;
  readonly purgeCompleteAt?: number;
  readonly completedAt?: number;
  readonly ttl?: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: number;
}

export interface AccountClosureMessage {
  readonly sub: string;
  readonly closureId: string;
}

export interface AccountClosureQueue {
  enqueue(message: AccountClosureMessage, delaySeconds?: number): Promise<void>;
}

export function createAccountClosureQueue(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
): AccountClosureQueue {
  return {
    async enqueue(message, delaySeconds) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          ...(delaySeconds === undefined ? {} : { DelaySeconds: delaySeconds }),
        }),
      );
    },
  };
}

export interface AccountClosureDeps extends Deps {
  readonly auditWriter: AuditWriter;
  readonly queue: AccountClosureQueue;
  readonly nextClosureId: () => string;
  readonly nextWorkerId: () => string;
}

export function accountClosureKey(sub: string): { pk: string; sk: 'STATE' } {
  return { pk: `ACCOUNT_CLOSURE#${sub}`, sk: 'STATE' };
}

export function closureOpenSortKey(nextAttemptAt: number, sub: string): string {
  return `NEXT#${String(nextAttemptAt).padStart(13, '0')}#${sub}`;
}

export type AccountClosureProcessResult = 'ignored' | 'pending' | 'completed';

const WORKER_LEASE_MS = 60_000;
// GSI reads are eventual. With writes blocked by the closure tombstone, two
// empty full sweeps separated by this window provide a stable purge boundary.
const GSI_STABILITY_DELAY_MS = 30_000;
// Keep completed tombstones for 30 days so delayed/duplicate deliveries remain idempotent.
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function parseClosureMessage(body: string): AccountClosureMessage | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'closureId,sub') return null;
    if (typeof record['sub'] !== 'string' || !record['sub']) return null;
    if (typeof record['closureId'] !== 'string' || !record['closureId']) return null;
    return { sub: record['sub'], closureId: record['closureId'] };
  } catch {
    return null;
  }
}

async function acquireClosureLease(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<AccountClosureItem> {
  const now = deps.now();
  const leaseOwner = deps.nextWorkerId();
  const out = await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: accountClosureKey(closure.sub),
      UpdateExpression:
        'SET leaseOwner = :leaseOwner, leaseUntil = :leaseUntil, revision = :nextRevision, updatedAt = :now',
      ConditionExpression:
        'closureId = :closureId AND revision = :expectedRevision AND #state = :state AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':closureId': closure.closureId,
        ':expectedRevision': closure.revision,
        ':state': 'purging',
        ':leaseOwner': leaseOwner,
        ':leaseUntil': now + WORKER_LEASE_MS,
        ':nextRevision': closure.revision + 1,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return out.Attributes as unknown as AccountClosureItem;
}

async function saveClosureCheckpoint(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  checkpoint: AccountClosureCheckpoint,
  delayMs = 0,
): Promise<void> {
  const now = deps.now();
  const nextAttemptAt = now + delayMs;
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: accountClosureKey(closure.sub),
      UpdateExpression:
        'SET checkpoint = :checkpoint, revision = :nextRevision, updatedAt = :now, nextAttemptAt = :nextAttemptAt, gsi1sk = :gsi1sk REMOVE leaseOwner, leaseUntil',
      ConditionExpression:
        'closureId = :closureId AND revision = :expectedRevision AND #state = :state AND leaseOwner = :leaseOwner',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':closureId': closure.closureId,
        ':expectedRevision': closure.revision,
        ':state': 'purging',
        ':leaseOwner': closure.leaseOwner,
        ':checkpoint': checkpoint,
        ':nextRevision': closure.revision + 1,
        ':now': now,
        ':nextAttemptAt': nextAttemptAt,
        ':gsi1sk': closureOpenSortKey(nextAttemptAt, closure.sub),
      },
    }),
  );
}

async function purgeFriendMirrorPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const page = await queryPrefixPage<FriendItem>(deps, K.user(closure.sub), 'FRIEND#', {
    limit: 25,
    exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    consistentRead: true,
  });
  const deletes = page.items.flatMap((edge) => {
    const otherId = edge.userA === closure.sub ? edge.userB : edge.userA;
    return otherId === closure.sub
      ? []
      : [{ DeleteRequest: { Key: K.friend(otherId, closure.sub) } }];
  });
  await batchWriteAll(deps, deletes);
  await saveClosureCheckpoint(
    deps,
    closure,
    page.lastEvaluatedKey
      ? { phase: 'friendMirrors', exclusiveStartKey: page.lastEvaluatedKey }
      : { phase: 'outgoingFriendRequests' },
  );
}

async function purgeIndexedMirrorPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  prefix: 'FREQ#' | 'MINOR#',
  currentPhase: 'outgoingFriendRequests' | 'guardianLinks',
  nextPhase: 'guardianLinks' | 'guardianInvites',
): Promise<number | undefined> {
  const page = await queryPrefixPage<{ pk: string; sk: string }>(
    deps,
    K.user(closure.sub),
    prefix,
    {
      index: 'gsi1',
      limit: 25,
      exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    },
  );
  await batchWriteAll(
    deps,
    page.items.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
  );
  if (page.lastEvaluatedKey) {
    await saveClosureCheckpoint(deps, closure, {
      phase: currentPhase,
      exclusiveStartKey: page.lastEvaluatedKey,
      quietPasses: 0,
    });
    return undefined;
  }
  if (page.items.length) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: currentPhase, quietPasses: 0 },
      GSI_STABILITY_DELAY_MS,
    );
    return GSI_STABILITY_DELAY_MS / 1000;
  }
  if ((closure.checkpoint?.quietPasses ?? 0) < 1) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: currentPhase, quietPasses: 1 },
      GSI_STABILITY_DELAY_MS,
    );
    return GSI_STABILITY_DELAY_MS / 1000;
  }
  await saveClosureCheckpoint(deps, closure, { phase: nextPhase });
  return undefined;
}

async function purgeGuardianInvitePage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  // One mirrored co-guardian invite expands to CODE + issuer mirror + minor
  // mirror. A 25-record page produces at most 75 of DynamoDB's 100 actions.
  const page = await queryPrefixPage<GuardianInviteMirrorItem>(
    deps,
    K.user(closure.sub),
    'GINVITE#',
    {
      limit: 25,
      exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
      consistentRead: true,
    },
  );
  if (page.items.length) {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: page.items.flatMap((mirror) =>
          guardianInviteClosureDeletes(deps, guardianInviteFromMirror(mirror)),
        ),
      }),
    );
    await saveClosureCheckpoint(
      deps,
      closure,
      page.lastEvaluatedKey
        ? { phase: 'guardianInvites', exclusiveStartKey: page.lastEvaluatedKey }
        : { phase: 'guardianInvites' },
    );
    return;
  }
  await saveClosureCheckpoint(deps, closure, { phase: 'directMirrors' });
}

async function purgeDirectMirrors(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const keys = [
    K.uniqUsername(closure.username),
    ...(closure.friendCode ? [K.codeF(closure.friendCode)] : []),
  ];
  await batchWriteAll(
    deps,
    keys.map((key) => ({ DeleteRequest: { Key: key } })),
  );
  await saveClosureCheckpoint(deps, closure, { phase: 'userPartition' });
}

async function purgeUserPartitionPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<boolean> {
  const page = await queryPrefixPage<{ pk: string; sk: string }>(deps, K.user(closure.sub), '', {
    limit: 25,
    exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    consistentRead: true,
  });
  await batchWriteAll(
    deps,
    page.items.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
  );
  if (page.items.length) {
    await saveClosureCheckpoint(
      deps,
      closure,
      page.lastEvaluatedKey
        ? { phase: 'userPartition', exclusiveStartKey: page.lastEvaluatedKey }
        : { phase: 'userPartition' },
    );
    return false;
  }
  return true;
}

async function markPurgeComplete(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, purgeCompleteAt = :now, nextAttemptAt = :now, gsi1sk = :gsi1sk REMOVE leaseOwner, leaseUntil, checkpoint',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState AND leaseOwner = :leaseOwner',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purging',
              ':leaseOwner': closure.leaseOwner,
              ':nextState': 'purgeComplete',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':gsi1sk': closureOpenSortKey(now, closure.sub),
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-purgeComplete-${closure.revision + 1}`,
          action: 'account_closure.purge_complete',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: { closureId: closure.closureId, from: 'purging', to: 'purgeComplete' },
        }),
      ],
    }),
  );
}

async function deleteIdentityAndComplete(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  try {
    await deps.cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: deps.userPoolId,
        Username: closure.username,
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name !== 'UserNotFoundException') throw error;
  }
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, completedAt = :now, ttl = :ttl REMOVE gsi1pk, gsi1sk, nextAttemptAt, leaseOwner, leaseUntil, checkpoint',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purgeComplete',
              ':nextState': 'completed',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':ttl': Math.ceil((now + COMPLETED_RETENTION_MS) / 1000),
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-completed-${closure.revision + 1}`,
          action: 'account_closure.completed',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: { closureId: closure.closureId, from: 'purgeComplete', to: 'completed' },
        }),
      ],
    }),
  );
}

export async function processAccountClosureMessage(
  deps: AccountClosureDeps,
  message: AccountClosureMessage,
): Promise<AccountClosureProcessResult> {
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: accountClosureKey(message.sub),
      ConsistentRead: true,
    }),
  );
  const closure = result.Item as AccountClosureItem | undefined;
  if (!closure || closure.closureId !== message.closureId) return 'ignored';
  if (closure.state === 'completed') return 'completed';
  const observedAt = deps.now();
  if (typeof closure.nextAttemptAt === 'number' && closure.nextAttemptAt > observedAt) {
    const delaySeconds = Math.min(
      900,
      Math.max(1, Math.ceil((closure.nextAttemptAt - observedAt) / 1000)),
    );
    await deps.queue.enqueue(message, delaySeconds);
    return 'pending';
  }
  if (closure.state === 'purgeComplete') {
    await deleteIdentityAndComplete(deps, closure);
    return 'completed';
  }
  if (closure.state === 'purging') {
    let leased: AccountClosureItem;
    try {
      leased = await acquireClosureLease(deps, closure);
    } catch (error) {
      if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return 'pending';
      }
      throw error;
    }
    let continuationDelay: number | undefined;
    switch (leased.checkpoint?.phase) {
      case 'friendMirrors':
        await purgeFriendMirrorPage(deps, leased);
        break;
      case 'outgoingFriendRequests':
        continuationDelay = await purgeIndexedMirrorPage(
          deps,
          leased,
          'FREQ#',
          'outgoingFriendRequests',
          'guardianLinks',
        );
        break;
      case 'guardianLinks':
        continuationDelay = await purgeIndexedMirrorPage(
          deps,
          leased,
          'MINOR#',
          'guardianLinks',
          'guardianInvites',
        );
        break;
      case 'guardianInvites':
        await purgeGuardianInvitePage(deps, leased);
        break;
      case 'directMirrors':
        await purgeDirectMirrors(deps, leased);
        break;
      case 'userPartition':
        if (await purgeUserPartitionPage(deps, leased)) {
          await markPurgeComplete(deps, leased);
        }
        break;
      default:
        throw new Error('invalid account closure checkpoint');
    }
    if (continuationDelay === undefined) await deps.queue.enqueue(message);
    else await deps.queue.enqueue(message, continuationDelay);
    return 'pending';
  }
  if (closure.state !== 'requested') return 'pending';

  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(message.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, nextAttemptAt = :now, gsi1sk = :gsi1sk',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': closure.state,
              ':nextState': 'purging',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':gsi1sk': closureOpenSortKey(now, closure.sub),
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-purging-${closure.revision + 1}`,
          action: 'account_closure.purging',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            kind: closure.kind ?? 'self_adult',
            ...(closure.actorSub ? { actorSub: closure.actorSub } : {}),
            from: closure.state,
            to: 'purging',
          },
        }),
      ],
    }),
  );
  await deps.queue.enqueue(message);
  return 'pending';
}

export async function handleAccountClosureQueueEvent(
  event: Pick<SQSEvent, 'Records'>,
  deps: AccountClosureDeps,
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const message = parseClosureMessage(record.body);
    if (!message) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await processAccountClosureMessage(deps, message);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function realAccountClosureWorkerDeps(): AccountClosureDeps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    ddb,
    cognito: new CognitoIdentityProviderClient({}),
    table: requiredEnvironment('TABLE_NAME'),
    userPoolId: requiredEnvironment('USER_POOL_ID'),
    now: Date.now,
    auditWriter: new AuditWriter({
      ddb,
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

let workerDeps: AccountClosureDeps | undefined;

export function createAccountClosureWorkerHandler(
  resolveDeps: () => AccountClosureDeps,
): (event: SQSEvent, context?: Context) => Promise<SQSBatchResponse> {
  return instrumentHandler(
    'account-closure-worker',
    (event: SQSEvent, _context?: Context) =>
      handleAccountClosureQueueEvent(event, resolveDeps()),
  );
}

export const handler = createAccountClosureWorkerHandler(
  () => (workerDeps ??= realAccountClosureWorkerDeps()),
);
