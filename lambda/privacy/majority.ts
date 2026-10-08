import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { K, type Deps, type ProfileItem } from '../db';
import { closureAbsenceConditionCheck } from '../authz';
import { privacyCalendarDate, privacyKey, readPrivacyItem } from './consent';
import { decisionLedgerPut } from './retention';

/** Existing admissions finish their lifecycle even while new ones are disabled. */
export async function reconcilePrivateAdolescentMajority(
  deps: Deps,
): Promise<{ transitioned: number; failures: number }> {
  const result = { transitioned: 0, failures: 0 };
  const today = privacyCalendarDate(deps.now());
  const page = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      IndexName: 'gsi2',
      Limit: 25,
      KeyConditionExpression: 'gsi2pk = :pk AND gsi2sk <= :until',
      ExpressionAttributeValues: { ':pk': 'PRIVACY#MAJORITY', ':until': `${today}#~` },
    }),
  );
  for (const candidate of (page.Items ?? []).slice(0, 25)) {
    try {
      if (
        typeof candidate['userId'] !== 'string' ||
        candidate['pk'] !== K.user(candidate['userId']) ||
        candidate['sk'] !== 'PROFILE'
      )
        throw new Error('invalid majority identity');
      const id = candidate['userId'];
      const profile = (
        await deps.ddb.send(
          new GetCommand({ TableName: deps.table, Key: K.profile(id), ConsistentRead: true }),
        )
      ).Item as ProfileItem | undefined;
      if (
        !profile ||
        profile.accountType !== 'minor' ||
        profile.privacyMode !== 'adolescent_private' ||
        !profile.majorityAt ||
        profile.majorityAt > today ||
        profile.status === 'closing'
      )
        continue;
      const old = await readPrivacyItem(deps, id);
      if (
        !old ||
        old.subjectKind !== 'adolescent_private' ||
        old.majorityAt !== profile.majorityAt ||
        old.revision >= Number.MAX_SAFE_INTEGER
      )
        throw new Error('inconsistent majority decision');
      const next = {
        ...old,
        revision: old.revision + 1,
        updatedAt: deps.now(),
        guardianConsent: 'ended' as const,
        cloudConsent: 'revoked' as const,
      };
      await deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: deps.table,
                Key: K.profile(id),
                UpdateExpression:
                  'SET accountType = :adult, socialEnabled = :disabled, familyFenceVersion = :fence REMOVE gsi2pk, gsi2sk',
                ConditionExpression:
                  'userId = :id AND accountType = :minor AND privacyMode = :private AND majorityAt = :date AND (attribute_not_exists(#status) OR #status = :active)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':id': id,
                  ':adult': 'adult',
                  ':minor': 'minor',
                  ':disabled': false,
                  ':fence': 1,
                  ':private': 'adolescent_private',
                  ':date': profile.majorityAt,
                  ':active': 'active',
                },
              },
            },
            closureAbsenceConditionCheck(deps, id),
            {
              Put: {
                TableName: deps.table,
                Item: next,
                ConditionExpression: 'revision = :revision',
                ExpressionAttributeValues: { ':revision': old.revision },
              },
            },
            decisionLedgerPut(deps, next, old),
            {
              Put: {
                TableName: deps.table,
                Item: {
                  pk: privacyKey(id).pk,
                  sk: `PRIVACY#MAJORITY#${profile.majorityAt}`,
                  userId: id,
                  revision: next.revision,
                  updatedAt: deps.now(),
                  action: 'majority_transition',
                  authentication: 'server_schedule',
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      result.transitioned++;
    } catch {
      result.failures++;
    }
  }
  return result;
}
