import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { AuditWriter } from './commercial/audit';
import { K, type ProfileItem } from './db';
import { FK } from './family/keys';
import { buildMajorityTransition, MAJORITY_GSI_PK, majorityGsiSk } from './family/majority-transition';
import { type CoverageAssignmentItem } from './family/model';
import { readHouseholdSnapshot } from './family/repository';
import { instrumentHandler } from './observability';

interface ReconcilerDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly cognito: CognitoIdentityProviderClient;
  readonly tableName: string;
  readonly userPoolId: string;
  readonly auditWriter: AuditWriter;
  readonly now: () => number;
}

export async function transitionDueMinor(deps: ReconcilerDeps,
  accountId: string, requestId: string): Promise<'transitioned' | 'skipped'> {
  const profileResult = await deps.ddb.send(new GetCommand({
    TableName: deps.tableName, Key: K.profile(accountId), ConsistentRead: true,
  }));
  const profile = profileResult.Item as ProfileItem | undefined;
  const now = deps.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (!profile || profile.accountType !== 'minor' || !profile.majorityAt ||
    profile.majorityAt > today || profile.gsi2pk !== MAJORITY_GSI_PK ||
    profile.gsi2sk !== majorityGsiSk(profile.majorityAt, accountId)) return 'skipped';
  if (profile.status !== 'active') return 'skipped';
  const coverageResult = await deps.ddb.send(new GetCommand({
    TableName: deps.tableName, Key: FK.familyCoverage(accountId), ConsistentRead: true,
  }));
  const coverage = coverageResult.Item as CoverageAssignmentItem | undefined;
  if (!coverage || coverage.accountId !== accountId || coverage.seatType !== 'minor') {
    throw new Error('due minor is missing canonical family coverage');
  }
  const snapshot = await readHouseholdSnapshot({
    ddb: deps.ddb, tableName: deps.tableName, now: deps.now,
  }, coverage.householdId);
  if (!snapshot) throw new Error('due minor is missing canonical household');
  const items = buildMajorityTransition({ tableName: deps.tableName, now, profile, snapshot });
  // Cognito is updated first so a failed identity write leaves indexed DynamoDB
  // facts retryable. DynamoDB remains the authorization authority during that gap.
  await deps.cognito.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: deps.userPoolId,
    Username: profile.username,
    UserAttributes: [{ Name: 'custom:accountType', Value: 'adult' }],
  }));
  await deps.ddb.send(new TransactWriteCommand({ TransactItems: [
    ...items,
    deps.auditWriter.transactPut({ targetKind: 'FAMILY_AGE', targetId: accountId,
      timestamp: now, requestId, action: 'reached_majority', actor: 'family-majority-reconciler',
      subject: accountId,
      details: { formerHouseholdId: snapshot.household.householdId,
        majorityAt: profile.majorityAt } }),
  ] }));
  return 'transitioned';
}

export async function reconcileDueMajority(deps: ReconcilerDeps, requestId: string): Promise<number> {
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let transitioned = 0;
  do {
    const page = await deps.ddb.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :pk AND gsi2sk <= :through',
      ExpressionAttributeValues: { ':pk': MAJORITY_GSI_PK, ':through': `${today}~` },
      Limit: 25,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const candidate of page.Items ?? []) {
      if (typeof candidate['userId'] !== 'string') continue;
      if (await transitionDueMinor(deps, candidate['userId'], requestId) === 'transitioned') {
        transitioned += 1;
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return transitioned;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let productionDeps: ReconcilerDeps | undefined;
function realDeps(): ReconcilerDeps {
  if (productionDeps) return productionDeps;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  productionDeps = { ddb, cognito: new CognitoIdentityProviderClient({}),
    tableName: required('TABLE_NAME'), userPoolId: required('USER_POOL_ID'),
    auditWriter: new AuditWriter({ ddb, tableName: required('AUDIT_TABLE_NAME') }),
    now: Date.now };
  return productionDeps;
}

export const handler = instrumentHandler('family-majority-reconciler',
  async (_event: unknown, context?: Context) => {
    await reconcileDueMajority(realDeps(), context?.awsRequestId ?? 'scheduled-majority');
  });
