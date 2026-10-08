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
import { reconcilePrivateAdolescentMajority } from '../lambda/privacy/majority';
import { K } from '../lambda/db';
import { privacySnapshotHash } from '../lambda/privacy/retention';
const NOW = Date.parse('2026-10-07T18:00:00Z');
const ddb = mockClient(DynamoDBDocumentClient);
const profile = {
  ...K.profile('teen'),
  userId: 'teen',
  username: 'teen',
  accountType: 'minor',
  privacyMode: 'adolescent_private',
  socialEnabled: false,
  status: 'active',
  majorityAt: '2026-10-07',
  gsi2pk: 'PRIVACY#MAJORITY',
  gsi2sk: '2026-10-07#teen',
};
const decision = {
  pk: 'USER#teen',
  sk: 'PRIVACY#ADULT',
  userId: 'teen',
  revision: 2,
  updatedAt: NOW - 1,
  subjectKind: 'adolescent_private',
  adolescentAcceptedAt: NOW - 100,
  majorityAt: profile.majorityAt,
  guardianId: 'parent',
  guardianConsent: 'granted',
  cloudConsent: 'granted',
  erasure: 'none',
};
const deps = () => ({
  table: 'main',
  privacyTable: 'privacy',
  userPoolId: 'pool',
  now: () => NOW,
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  cognito: new CognitoIdentityProviderClient({}),
});
beforeEach(() => {
  ddb.reset();
  vi.stubEnv('PRIVATE_ADOLESCENT_MODE', 'off');
  ddb.on(QueryCommand).resolves({ Items: [profile] });
  ddb
    .on(GetCommand)
    .callsFake((input) => ({
      Item:
        input.Key?.sk === 'PROFILE'
          ? profile
          : input.Key?.pk === 'PRIVACY_STATE#teen'
            ? {
                pk: 'PRIVACY_STATE#teen',
                sk: 'STATE',
                userId: 'teen',
                updatedAt: decision.updatedAt,
                snapshot: decision,
                revision: decision.revision,
                snapshotHash: privacySnapshotHash(decision as never),
              }
            : input.Key?.sk === 'PRIVACY#ADULT'
              ? decision
              : undefined,
    }));
  ddb.on(TransactWriteCommand).resolves({});
});
afterEach(() => vi.unstubAllEnvs());
describe('private adolescent majority maintenance', () => {
  it('automatically ends authority and cloud at 18, preserving all forest rows and the private restriction even with new admissions off', async () => {
    expect(await reconcilePrivateAdolescentMajority(deps())).toEqual({
      transitioned: 1,
      failures: 0,
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items.some((item) => item.Delete)).toBe(false);
    expect(items.find((item) => item.Update)?.Update?.UpdateExpression).toContain(
      'REMOVE gsi2pk, gsi2sk',
    );
    const next = items.find((item) => item.Put?.Item?.sk === 'PRIVACY#ADULT')?.Put?.Item;
    expect(next).toMatchObject({ revision: 3, guardianConsent: 'ended', cloudConsent: 'revoked' });
    expect(next).not.toHaveProperty('adultDeclaredAt');
    expect(JSON.stringify(items)).not.toContain('SET privacyMode');
    expect(items.some((item) => item.ConditionCheck?.Key?.pk === 'ACCOUNT_CLOSURE#teen')).toBe(
      true,
    );
  });
  it('leaves a concurrent closing account for the closure worker and reports retryable conflicts', async () => {
    ddb
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('closure won'), { name: 'TransactionCanceledException' }));
    expect(await reconcilePrivateAdolescentMajority(deps())).toEqual({
      transitioned: 0,
      failures: 1,
    });
  });
});
