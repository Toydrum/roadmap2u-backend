import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AuditWriter } from '../lambda/commercial/audit';
import { createFamilyPilotBroker } from '../lambda/family-pilot-broker';
import { createEmptySeatAssignments, createHousehold, createCoverageAssignment,
  createFamilyEntitlement } from '../lambda/family/model';
import { FK } from '../lambda/family/keys';
import { K } from '../lambda/db';

const NOW = 1_800_000_000_000;
const ACCOUNT = '123456789012';
const ADULT = 'adult-invited';
const COMMAND_ID = '9c09f76b-246a-4f0d-a188-8ba97f7f518d';
const ACTOR = `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-dev-family-pilot-operator/session`;
const household = createHousehold({ primaryResponsibleId: ADULT, now: NOW - 1000 });
const seats = createEmptySeatAssignments(household.householdId, NOW - 1000);
const ddbMock = mockClient(DynamoDBDocumentClient);

function broker() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return createFamilyPilotBroker({
    ddb, tableName: 'roadmap-dev', auditWriter: new AuditWriter({ ddb, tableName: 'audit-dev' }),
    stage: 'dev', accountId: ACCOUNT, now: () => NOW,
  });
}

function event(command: 'grant' | 'revoke', overrides: Record<string, unknown> = {}, actor = ACTOR) {
  return {
    body: JSON.stringify({ command, stage: 'dev', adultId: ADULT, householdId: household.householdId,
      expectedHouseholdRevision: 1, expectedEntitlementRevision: command === 'grant' ? 0 : 1,
      commandId: COMMAND_ID, reason: 'invited_household', ...overrides }),
    requestContext: { requestId: 'request-1', http: { method: 'POST' },
      authorizer: { iam: { userArn: actor } } },
  };
}

function installReads(entitlement: ReturnType<typeof createFamilyEntitlement> | null = null,
  coverage: ReturnType<typeof createCoverageAssignment> | null = null) {
  const rows = [
    { ...K.profile(ADULT), userId: ADULT, accountType: 'adult', status: 'active', familyFenceVersion: 1 },
    household, ...seats, ...(entitlement ? [entitlement] : []), ...(coverage ? [coverage] : []),
  ];
  ddbMock.on(GetCommand).callsFake(({ Key }) => {
    const item = rows.find((row) => row.pk === Key.pk && row.sk === Key.sk);
    return item ? { Item: item } : {};
  });
  ddbMock.on(TransactWriteCommand).resolves({});
}

beforeEach(() => ddbMock.reset());

describe('private family pilot broker', () => {
  it('rejects a caller outside the exact IAM operator role before touching data', async () => {
    const response = await broker()(event('grant', {},
      `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-dev-backend-deploy/session`));
    expect(response.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('grants two minor seats and one additional seat without a payment date', async () => {
    installReads();
    const response = await broker()(event('grant'));
    expect(response.statusCode).toBe(200);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ ConditionCheck: expect.objectContaining({
        Key: K.profile(ADULT),
        ConditionExpression: expect.stringContaining('familyFenceVersion = :familyFenceVersion'),
      }) }),
      expect.objectContaining({ Put: expect.objectContaining({
        Item: expect.objectContaining({ ...FK.familyEntitlement(household.householdId),
          source: 'sponsored_pilot', minorSeats: 2, additionalResponsibleSeat: 1,
          paidThrough: null }),
      }) }),
      expect.objectContaining({ Put: expect.objectContaining({
        Item: expect.objectContaining({ ...FK.familyCoverage(ADULT), source: 'sponsored_pilot',
          paidThrough: null }),
      }) }),
      expect.objectContaining({ Put: expect.objectContaining({
        TableName: 'audit-dev', Item: expect.objectContaining({ action: 'grant' }),
      }) }),
    ]));
  });

  it('revokes the entitlement and member coverage in one audited transaction', async () => {
    const entitlement = createFamilyEntitlement({ householdId: household.householdId,
      source: 'sponsored_pilot', now: NOW - 500 });
    const coverage = createCoverageAssignment({ householdId: household.householdId,
      accountId: ADULT, seatType: 'primary_responsible', source: 'sponsored_pilot', now: NOW - 500 });
    installReads(entitlement, coverage);
    const response = await broker()(event('revoke'));
    expect(response.statusCode).toBe(200);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ Update: expect.objectContaining({
        Key: FK.familyEntitlement(household.householdId),
        ExpressionAttributeValues: expect.objectContaining({ ':ended': 'ended', ':expectedRevision': 1 }),
      }) }),
      expect.objectContaining({ Update: expect.objectContaining({
        Key: FK.familyCoverage(ADULT),
        ExpressionAttributeValues: expect.objectContaining({ ':ended': 'ended', ':expectedRevision': 1 }),
      }) }),
    ]));
    expect(items.some((item) => item.Delete)).toBe(false);
  });
});
