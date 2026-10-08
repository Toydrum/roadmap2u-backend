import type { Deps } from '../db';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { adultPrivacyMode } from './consent';
import { processCloudErasurePage } from './erasure';
import { reconcilePrivateAdolescentMajority } from './majority';
import {
  activePrivacyHolds,
  readRestoreExclusion,
  restoreExclusionCheck,
  privacyTableName,
  restoreExclusionKey,
} from './retention';
export async function maintainPrivacy(
  deps: Deps & { auditTable: string },
): Promise<{ erasures: number; audits: number; failures: number }> {
  const result = { erasures: 0, audits: 0, failures: 0 };
  const due = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      IndexName: 'gsi2',
      Limit: 25,
      KeyConditionExpression: 'gsi2pk = :pk AND gsi2sk <= :until',
      ExpressionAttributeValues: {
        ':pk': 'PRIVACY#ERASURE',
        ':until': `NEXT#${String(deps.now()).padStart(14, '0')}#~`,
      },
    }),
  );
  for (const item of (due.Items ?? []).slice(0, 25)) {
    try {
      if (
        typeof item['userId'] !== 'string' ||
        item['pk'] !== `USER#${item['userId']}` ||
        item['sk'] !== 'PRIVACY#ADULT'
      )
        throw new Error('invalid erasure identity');
      await processCloudErasurePage(deps, item['userId']);
      result.erasures++;
    } catch {
      result.failures++;
    }
  }
  const majority = await reconcilePrivateAdolescentMajority(deps);
  result.failures += majority.failures;
  if (adultPrivacyMode() === 'off') return result;
  const audits = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.auditTable,
      IndexName: 'gsi1',
      Limit: 25,
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk <= :until',
      ExpressionAttributeValues: {
        ':pk': 'RETENTION#AUDIT',
        ':until': `DUE#${String(deps.now()).padStart(14, '0')}#~`,
      },
    }),
  );
  for (const item of (audits.Items ?? []).slice(0, 25)) {
    if (
      item['retentionCategory'] !== 'ordinary' ||
      !Number.isSafeInteger(item['retainUntil']) ||
      item['retainUntil'] > deps.now()
    )
      continue;
    try {
      const userId = item['retentionUserId'];
      if (
        typeof userId !== 'string' ||
        item['targetKind'] !== 'USER' ||
        item['targetId'] !== userId ||
        item['pk'] !== `TARGET#USER#${userId}` ||
        typeof item['sk'] !== 'string' ||
        !item['sk'].startsWith('EVENT#')
      )
        throw new Error('invalid retention identity');
      const control = await readRestoreExclusion(deps, userId);
      const holds = await activePrivacyHolds(deps, userId);
      if (holds.some((hold) => hold.scope === 'audit' || hold.scope === 'account')) {
        // A held first page must not starve unrelated due users indefinitely.
        await deps.ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: deps.auditTable,
                  Key: { pk: item['pk'], sk: item['sk'] },
                  UpdateExpression: 'SET gsi1sk = :next',
                  ConditionExpression:
                    'retentionCategory = :ordinary AND retainUntil = :until AND retentionUserId = :user',
                  ExpressionAttributeValues: {
                    ':next': `DUE#${String(deps.now() + 3600000).padStart(14, '0')}#${item['sk']}`,
                    ':ordinary': 'ordinary',
                    ':until': item['retainUntil'],
                    ':user': userId,
                  },
                },
              },
            ],
          }),
        );
        continue;
      }
      await deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            control
              ? restoreExclusionCheck(deps, control)
              : {
                  ConditionCheck: {
                    TableName: privacyTableName(deps),
                    Key: restoreExclusionKey(userId),
                    ConditionExpression: 'attribute_not_exists(pk)',
                  },
                },
            {
              Delete: {
                TableName: deps.auditTable,
                Key: { pk: item['pk'], sk: item['sk'] },
                ConditionExpression:
                  'retentionCategory = :ordinary AND retainUntil = :until AND retentionUserId = :user',
                ExpressionAttributeValues: {
                  ':ordinary': 'ordinary',
                  ':until': item['retainUntil'],
                  ':user': userId,
                },
              },
            },
          ],
        }),
      );
      result.audits++;
    } catch {
      result.failures++;
    }
  }
  return result;
}
