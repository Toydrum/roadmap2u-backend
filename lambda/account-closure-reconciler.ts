import {
  ACCOUNT_CLOSURE_OPEN_GSI_PK,
  createAccountClosureQueue,
  type AccountClosureItem,
  type AccountClosureQueue,
} from './account-closure';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { QueryCommand, type Deps, type DynamoKey } from './db';
import { instrumentHandler } from './observability';

export interface AccountClosureReconcilerDeps extends Pick<Deps, 'ddb' | 'table' | 'now'> {
  readonly queue: AccountClosureQueue;
}

export async function reconcileOpenAccountClosures(
  deps: AccountClosureReconcilerDeps,
): Promise<void> {
  let exclusiveStartKey: DynamoKey | undefined;
  do {
    const page = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.table,
        IndexName: 'gsi1',
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'gsi1pk', '#sk': 'gsi1sk' },
        ExpressionAttributeValues: {
          ':pk': ACCOUNT_CLOSURE_OPEN_GSI_PK,
          ':prefix': 'NEXT#',
        },
        Limit: 25,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const closure of (page.Items ?? []) as AccountClosureItem[]) {
      if (
        closure.state !== 'completed' &&
        closure.state !== 'blocked' &&
        typeof closure.sub === 'string' &&
        typeof closure.closureId === 'string' &&
        typeof closure.nextAttemptAt === 'number' &&
        closure.nextAttemptAt <= deps.now()
      ) {
        await deps.queue.enqueue({ sub: closure.sub, closureId: closure.closureId });
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function realAccountClosureReconcilerDeps(): AccountClosureReconcilerDeps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    table: requiredEnvironment('TABLE_NAME'),
    now: Date.now,
    queue: createAccountClosureQueue(
      new SQSClient({}),
      requiredEnvironment('ACCOUNT_CLOSURE_QUEUE_URL'),
    ),
  };
}

let reconcilerDeps: AccountClosureReconcilerDeps | undefined;

export function createAccountClosureReconcilerHandler(
  resolveDeps: () => AccountClosureReconcilerDeps,
): (event: unknown, context?: Context) => Promise<void> {
  return instrumentHandler(
    'account-closure-reconciler',
    async (_event: unknown, _context?: Context) => {
      await reconcileOpenAccountClosures(resolveDeps());
    },
  );
}

export const handler = createAccountClosureReconcilerHandler(
  () => (reconcilerDeps ??= realAccountClosureReconcilerDeps()),
);
