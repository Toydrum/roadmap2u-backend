import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { maintainPrivacy } from '../lambda/privacy/maintenance';
const NOW = 1_800_000_000_000;
const ddb = mockClient(DynamoDBDocumentClient);
const deps = () => ({
  table: 'main',
  privacyTable: 'privacy',
  auditTable: 'audit',
  now: () => NOW,
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  cognito: new CognitoIdentityProviderClient({}),
  userPoolId: 'pool',
});
beforeEach(() => {
  ddb.reset();
  vi.stubEnv('ADULT_PRIVACY_MODE', 'enforce');
  ddb.on(GetCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).resolves({});
});
afterEach(() => vi.unstubAllEnvs());
describe('bounded privacy maintenance', () => {
  const ordinary = {
    pk: 'TARGET#USER#owner',
    sk: 'EVENT#1#req',
    targetKind: 'USER',
    targetId: 'owner',
    retentionCategory: 'ordinary',
    retentionUserId: 'owner',
    retainUntil: NOW - 1,
    gsi1pk: 'RETENTION#AUDIT',
    gsi1sk: 'DUE#1',
  };
  it('deletes only due, explicitly classified ordinary evidence after checking its holds', async () => {
    ddb
      .on(QueryCommand)
      .callsFake((input) => (input.TableName === 'audit' ? { Items: [ordinary] } : { Items: [] }));
    expect(await maintainPrivacy(deps())).toEqual({ erasures: 0, audits: 1, failures: 0 });
    const operations = ddb
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? []);
    expect(operations.filter((item) => item.Delete)).toHaveLength(1);
    expect(operations.find((item) => item.Delete)?.Delete?.Key).toEqual({
      pk: ordinary.pk,
      sk: ordinary.sk,
    });
    expect(operations.some((item) => item.ConditionCheck?.TableName === 'privacy')).toBe(true);
  });
  it('preserves ordinary evidence under a specific active audit hold', async () => {
    ddb
      .on(QueryCommand)
      .callsFake((input) =>
        input.TableName === 'audit'
          ? { Items: [ordinary] }
          : input.TableName === 'privacy'
            ? {
                Items: [
                  {
                    pk: 'HOLD#owner',
                    sk: 'CASE#case',
                    userId: 'owner',
                    caseId: 'case',
                    scope: 'audit',
                    state: 'active',
                    legalBasis: 'specific preservation obligation',
                    expiresAt: NOW + 86400000,
                    reviewAt: NOW + 3600000,
                  },
                ],
              }
            : { Items: [] },
      );
    expect(await maintainPrivacy(deps())).toEqual({ erasures: 0, audits: 0, failures: 0 });
    const items = ddb
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? []);
    expect(items.some((item) => item.Delete)).toBe(false);
    expect(items.find((item) => item.Update)?.Update?.UpdateExpression).toBe('SET gsi1sk = :next');
  });
  it('does not treat financial, unknown or future evidence as ordinary expired rows', async () => {
    ddb.on(QueryCommand).callsFake((input) =>
      input.TableName === 'audit'
        ? {
            Items: [
              { ...ordinary, retentionCategory: 'review_required' },
              { ...ordinary, retainUntil: NOW + 1 },
            ],
          }
        : { Items: [] },
    );
    const result = await maintainPrivacy(deps());
    expect(result.audits).toBe(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('leaves a raced audit hold protected and reports a retryable failure', async () => {
    ddb
      .on(QueryCommand)
      .callsFake((input) => (input.TableName === 'audit' ? { Items: [ordinary] } : { Items: [] }));
    ddb
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('hold won'), { name: 'TransactionCanceledException' }));
    expect(await maintainPrivacy(deps())).toEqual({ erasures: 0, audits: 0, failures: 1 });
  });
  it('does not start audit retention while the deployment mode is off', async () => {
    vi.stubEnv('ADULT_PRIVACY_MODE', 'off');
    await maintainPrivacy(deps());
    expect(
      ddb.commandCalls(QueryCommand).some((call) => call.args[0].input.TableName === 'audit'),
    ).toBe(false);
  });
});
