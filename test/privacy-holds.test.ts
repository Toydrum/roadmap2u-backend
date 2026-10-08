import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { changePrivacyHold, type PrivacyHoldCommand } from '../lambda/privacy/retention';
const NOW = 1_800_000_000_000;
const ddb = mockClient(DynamoDBDocumentClient);
const operator = {
  roleArn: 'arn:aws:iam::123456789012:role/roadmap2u/dev/operators/roadmap2u-dev-privacy-operator',
  arn: 'arn:aws:sts::123456789012:assumed-role/roadmap2u-dev-privacy-operator/operator-session',
};
const command = (overrides: Partial<PrivacyHoldCommand> = {}): PrivacyHoldCommand => ({
  action: 'set',
  userId: 'adult',
  caseId: 'case-1',
  commandId: 'hold-1',
  expectedRevision: 0,
  scope: 'forest',
  legalBasis: 'specific preservation obligation',
  expiresAt: NOW + 86400000,
  reviewAt: NOW + 3600000,
  ...overrides,
});
const deps = () => ({
  table: 'main',
  privacyTable: 'privacy',
  now: () => NOW,
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  cognito: new CognitoIdentityProviderClient({}),
  userPoolId: 'pool',
});
let rows: Map<string, Record<string, unknown>>;
const key = (item: Record<string, unknown>) => `${item['pk']}/${item['sk']}`;
beforeEach(() => {
  ddb.reset();
  rows = new Map([
    [
      'USER#adult/PROFILE',
      { pk: 'USER#adult', sk: 'PROFILE', userId: 'adult', accountType: 'adult', status: 'active' },
    ],
  ]);
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(key(input.Key)) }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? [])
      if (item.Put?.Item) rows.set(key(item.Put.Item), item.Put.Item);
    return {};
  });
});
describe('private documented privacy holds', () => {
  it('requires the exact IAM operator identity, excluding ordinary app users', async () => {
    await expect(
      changePrivacyHold(deps(), command(), {
        ...operator,
        arn: 'arn:aws:sts::123456789012:assumed-role/router/session',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it.each([
    { legalBasis: '' },
    { expiresAt: NOW },
    { reviewAt: NOW + 2 * 86400000 },
    { userId: 'adult#other' },
  ])('rejects undocumented or malformed holds %j', async (override) => {
    await expect(changePrivacyHold(deps(), command(override), operator)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('serializes hold decisions with erasure and adds minimal immutable operator evidence', async () => {
    await changePrivacyHold(deps(), command(), operator);
    expect(rows.get('HOLD#adult/CASE#case-1')).toMatchObject({
      state: 'active',
      scope: 'forest',
      legalBasis: 'specific preservation obligation',
    });
    expect(rows.get('RESTORE#adult/STATE')).toMatchObject({
      revision: 1,
      holdRevision: 1,
      cutoffRevision: 0,
    });
    expect(rows.get('HOLD_AUDIT#adult/COMMAND#hold-1')).toMatchObject({
      actor: operator.arn,
      action: 'set',
      updatedAt: NOW,
    });
    const calls = ddb.commandCalls(TransactWriteCommand).length;
    await changePrivacyHold(deps(), command(), operator);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(calls);
    await expect(
      changePrivacyHold(deps(), command({ legalBasis: 'different case' }), operator),
    ).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
  });
  it('will not insert a new hold after account closure has begun', async () => {
    rows.set('ACCOUNT_CLOSURE#adult/STATE', {
      pk: 'ACCOUNT_CLOSURE#adult',
      sk: 'STATE',
      state: 'requested',
    });
    await expect(changePrivacyHold(deps(), command(), operator)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('can release an existing hold while closure is waiting, without reactivating the account', async () => {
    await changePrivacyHold(deps(), command(), operator);
    rows.set('ACCOUNT_CLOSURE#adult/STATE', {
      pk: 'ACCOUNT_CLOSURE#adult',
      sk: 'STATE',
      state: 'requested',
    });
    rows.delete('USER#adult/PROFILE');
    await changePrivacyHold(
      deps(),
      {
        action: 'release',
        userId: 'adult',
        caseId: 'case-1',
        commandId: 'release-1',
        expectedRevision: 1,
      },
      operator,
    );
    expect(rows.get('HOLD#adult/CASE#case-1')).toMatchObject({ state: 'released' });
    expect(rows.get('RESTORE#adult/STATE')).toMatchObject({ revision: 2, holdRevision: 2 });
    expect(rows.has('USER#adult/PROFILE')).toBe(false);
    const transaction = ddb.commandCalls(TransactWriteCommand).at(-1)!.args[0].input.TransactItems!;
    expect(
      transaction.every((item) => !item.ConditionCheck || item.ConditionCheck.TableName !== 'main'),
    ).toBe(true);
  });
});
