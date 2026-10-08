import { ApiError } from '@app/api/contracts';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { K, type Deps } from '../db';
import { closureAbsenceConditionCheck } from '../authz';
import { migrationGuard, usageMigrationKey } from '../commercial/mutation-writer';
import { privacyKey, readPrivacyItem, type AdultPrivacyItem } from './consent';
import {
  activePrivacyHolds,
  decisionLedgerPut,
  readRestoreExclusion,
  RESTORE_EXCLUSION_MS,
  restoreExclusionCheck,
  restoreExclusionKey,
  restoreExclusionPut,
  type RestoreExclusionItem,
} from './retention';

type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
const FOREST_PREFIXES = ['REC#', 'MUTATION#', 'USAGE#TREE#'] as const;
async function strong(
  deps: Deps,
  userId: string,
  sk: string,
): Promise<Record<string, unknown> | undefined> {
  return (
    await deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: { pk: K.user(userId), sk },
        ConsistentRead: true,
      }),
    )
  ).Item;
}
async function migrationCondition(deps: Deps, userId: string): Promise<TransactionItem> {
  return migrationGuard(
    deps.table,
    userId,
    await strong(deps, userId, usageMigrationKey(userId).sk),
    deps.now(),
  );
}
async function resetUsage(deps: Deps, userId: string): Promise<TransactionItem> {
  const usage = await strong(deps, userId, 'USAGE');
  const key = { pk: K.user(userId), sk: 'USAGE' };
  if (!usage)
    return {
      ConditionCheck: {
        TableName: deps.table,
        Key: key,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    };
  if (
    usage['pk'] !== key.pk ||
    usage['sk'] !== key.sk ||
    usage['state'] !== 'active' ||
    typeof usage['activeGeneration'] !== 'string' ||
    !usage['activeGeneration'].trim() ||
    !Number.isSafeInteger(usage['activeTrees']) ||
    (usage['activeTrees'] as number) < 0
  )
    throw new ApiError('USAGE_MIGRATION_IN_PROGRESS');
  return {
    Put: {
      TableName: deps.table,
      Item: { ...usage, activeTrees: 0 },
      ConditionExpression:
        '#state = :state AND activeGeneration = :generation AND activeTrees = :trees',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':state': usage['state'],
        ':generation': usage['activeGeneration'],
        ':trees': usage['activeTrees'],
      },
    },
  };
}
function privacyStatePut(
  deps: Deps,
  next: AdultPrivacyItem,
  previous: AdultPrivacyItem,
): TransactionItem {
  return {
    Put: {
      TableName: deps.table,
      Item: next,
      ConditionExpression: 'revision = :revision AND cloudConsent = :revoked AND erasureId = :id',
      ExpressionAttributeValues: {
        ':revision': previous.revision,
        ':revoked': 'revoked',
        ':id': previous.erasureId,
      },
    },
  };
}
function nextState(
  deps: Deps,
  current: AdultPrivacyItem,
  erasure: AdultPrivacyItem['erasure'],
): AdultPrivacyItem {
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ApiError('PRIVACY_REVISION_CONFLICT');
  const next: AdultPrivacyItem = {
    ...current,
    revision: current.revision + 1,
    updatedAt: deps.now(),
    erasure,
  };
  if (erasure === 'completed') {
    next.erasureCompletedAt = deps.now();
    delete next.gsi2pk;
    delete next.gsi2sk;
  } else {
    const delay = erasure === 'blocked' ? 3600000 : 30000;
    next.gsi2pk = 'PRIVACY#ERASURE';
    next.gsi2sk = `NEXT#${String(deps.now() + delay).padStart(14, '0')}#${current.userId}`;
  }
  return next;
}
async function commitState(
  deps: Deps,
  old: AdultPrivacyItem,
  next: AdultPrivacyItem,
  exclusion: RestoreExclusionItem,
  deletes: TransactionItem[] = [],
): Promise<AdultPrivacyItem> {
  const complete = next.erasure === 'completed';
  const final = complete
    ? {
        ...exclusion,
        revision: exclusion.revision + 1,
        updatedAt: deps.now(),
        completedAt: deps.now(),
        ttl: Math.ceil((deps.now() + RESTORE_EXCLUSION_MS) / 1000),
      }
    : exclusion;
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        privacyStatePut(deps, next, old),
        decisionLedgerPut(deps, next, old),
        complete
          ? restoreExclusionPut(deps, final, exclusion)
          : restoreExclusionCheck(deps, exclusion),
        closureAbsenceConditionCheck(deps, old.userId),
        ...(next.erasure === 'blocked' ? [] : [await migrationCondition(deps, old.userId)]),
        ...(complete ? [await resetUsage(deps, old.userId)] : []),
        ...deletes,
      ],
    }),
  );
  return next;
}
/** One bounded, strongly verified page; scheduled work continues if the client leaves. */
export async function processCloudErasurePage(
  deps: Deps,
  userId: string,
): Promise<AdultPrivacyItem | undefined> {
  let state = await readPrivacyItem(deps, userId);
  if (!state || !['requested', 'purging', 'blocked'].includes(state.erasure)) return state;
  if (state.cloudConsent !== 'revoked' || !state.erasureId)
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  let exclusion = await readRestoreExclusion(deps, userId);
  if (exclusion?.scope === 'account')
    throw new ApiError('CONFLICT', 'account closure supersedes forest cancellation');
  if (!exclusion || exclusion.erasureId !== state.erasureId) {
    const next: RestoreExclusionItem = {
      ...restoreExclusionKey(userId),
      userId,
      revision: (exclusion?.revision ?? 0) + 1,
      updatedAt: deps.now(),
      scope: 'forest',
      erasureId: state.erasureId,
      cutoffRevision: state.revision,
      holdRevision: exclusion?.holdRevision ?? 0,
    };
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: privacyKey(userId),
              ConditionExpression:
                'revision = :revision AND cloudConsent = :revoked AND erasureId = :id',
              ExpressionAttributeValues: {
                ':revision': state.revision,
                ':revoked': 'revoked',
                ':id': state.erasureId,
              },
            },
          },
          restoreExclusionPut(deps, next, exclusion),
        ],
      }),
    );
    exclusion = next;
  }
  const holds = await activePrivacyHolds(deps, userId);
  if (holds.some((hold) => hold.scope === 'forest' || hold.scope === 'account')) {
    return commitState(deps, state, nextState(deps, state, 'blocked'), exclusion);
  }
  const deletes: TransactionItem[] = [];
  for (const prefix of FOREST_PREFIXES) {
    if (deletes.length === 20) break;
    const limit = 20 - deletes.length;
    const page = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': K.user(userId), ':prefix': prefix },
        ConsistentRead: true,
        Limit: limit,
      }),
    );
    if ((page.Items?.length ?? 0) > limit)
      throw new ApiError('server', 'erasure page exceeded its bound');
    for (const item of page.Items ?? []) {
      if (
        item['pk'] !== K.user(userId) ||
        typeof item['sk'] !== 'string' ||
        !item['sk'].startsWith(prefix)
      )
        throw new ApiError('PRIVACY_REVISION_CONFLICT');
      deletes.push({
        Delete: {
          TableName: deps.table,
          Key: { pk: item['pk'], sk: item['sk'] },
          ConditionExpression: 'attribute_exists(pk)',
        },
      });
    }
  }
  if (!deletes.length)
    return commitState(deps, state, nextState(deps, state, 'completed'), exclusion);
  state = await commitState(deps, state, nextState(deps, state, 'purging'), exclusion, deletes);
  for (const prefix of FOREST_PREFIXES) {
    const remaining = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': K.user(userId), ':prefix': prefix },
        ConsistentRead: true,
        Limit: 1,
      }),
    );
    if (remaining.Items?.length || remaining.LastEvaluatedKey) return state;
  }
  return commitState(deps, state, nextState(deps, state, 'completed'), exclusion);
}
