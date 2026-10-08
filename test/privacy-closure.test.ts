import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  processAccountClosureMessage,
  ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
  type AccountClosureDeps,
} from '../lambda/account-closure';
import { AuditWriter } from '../lambda/commercial/audit';
import { decisionLedgerPut } from '../lambda/privacy/retention';
import type { AdultPrivacyItem } from '../lambda/privacy/consent';
const NOW = 1_800_000_000_000;
const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const closure = {
  pk: 'ACCOUNT_CLOSURE#adult',
  sk: 'STATE',
  sub: 'adult',
  username: 'adult',
  closureId: 'close-1',
  state: 'purgeComplete',
  revision: 3,
  requestedAt: NOW - 10000,
  updatedAt: NOW - 1000,
  purgeCompleteAt: NOW - 100,
  familyCleanupVersion: ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
};
const deps = (): AccountClosureDeps => {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    table: 'main',
    privacyTable: 'privacy',
    now: () => NOW,
    ddb: client,
    cognito: new CognitoIdentityProviderClient({}),
    userPoolId: 'pool',
    nextClosureId: () => 'close-1',
    nextWorkerId: () => 'worker',
    auditWriter: new AuditWriter({ ddb: client, tableName: 'audit' }),
    queue: { enqueue: vi.fn(async () => {}) },
  };
};
beforeEach(() => {
  ddb.reset();
  cognito.reset();
  ddb
    .on(GetCommand)
    .callsFake((input) => ({ Item: input.Key?.['pk'] === closure.pk ? closure : undefined }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).resolves({});
  cognito.on(AdminDeleteUserCommand).resolves({});
});
describe('closure and the independent privacy register', () => {
  it('writes an independent whole-account restore exclusion before and after completion', async () => {
    await expect(
      processAccountClosureMessage(deps(), { sub: 'adult', closureId: 'close-1' }),
    ).resolves.toBe('completed');
    const exclusions = ddb
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? [])
      .filter(
        (item) => item.Put?.TableName === 'privacy' && item.Put.Item?.['pk'] === 'RESTORE#adult',
      );
    expect(exclusions.length).toBeGreaterThanOrEqual(2);
    expect(exclusions[0].Put?.Item).toMatchObject({ scope: 'account', erasureId: 'close-1' });
    expect(exclusions[0].Put?.Item).not.toHaveProperty('ttl');
    expect(exclusions.at(-1)?.Put?.Item).toMatchObject({
      completedAt: NOW,
      ttl: Math.ceil((NOW + 36 * 86400000) / 1000),
    });
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
  });
  it('defers destructive closure under an existing, documented forest obligation', async () => {
    ddb.on(QueryCommand).callsFake((input) =>
      input.TableName === 'privacy'
        ? {
            Items: [
              {
                pk: 'HOLD#adult',
                sk: 'CASE#case',
                userId: 'adult',
                caseId: 'case',
                scope: 'forest',
                state: 'active',
                legalBasis: 'specific preservation obligation',
                expiresAt: NOW + 86400000,
                reviewAt: NOW + 3600000,
              },
            ],
          }
        : { Items: [] },
    );
    const dependencies = deps();
    await expect(
      processAccountClosureMessage(dependencies, { sub: 'adult', closureId: 'close-1' }),
    ).resolves.toBe('pending');
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(dependencies.queue.enqueue).toHaveBeenCalledWith(
      { sub: 'adult', closureId: 'close-1' },
      900,
    );
  });
  it.each<NonNullable<AdultPrivacyItem['guardianAuthorization']>>([
    {
      method: 'account_attestation',
      attestation: {
        subjectId: 'guardian',
        authenticatedAt: NOW - 300000,
        emailVerified: true,
        declaredName: 'Synthetic Guardian',
        relationship: 'parent',
        declaredAt: NOW - 200000,
      },
    },
    {
      method: 'operator_verified',
      verifiedAt: NOW - 200000,
      caseId: 'legacy-representation-case',
      verifiedBy: 'private-operator',
    },
  ])(
    'preserves $method authorization under a consent hold after account closure',
    async (authorization) => {
      const dependencies = deps();
      const snapshot: AdultPrivacyItem = {
        pk: 'USER#adult',
        sk: 'PRIVACY#ADULT',
        userId: 'adult',
        revision: 1,
        updatedAt: NOW - 100000,
        cloudConsent: 'revoked',
      erasure: 'completed',
        subjectKind: 'adolescent_private',
        adolescentAcceptedAt: NOW - 100000,
        guardianId: 'guardian',
        guardianConsent: 'granted',
        guardianAuthorization: authorization,
      };
      const ledger = decisionLedgerPut(dependencies, snapshot).Put!.Item;
      const expiry = NOW + 60 * 86400000;
      ddb.on(GetCommand).callsFake((input) => ({
        Item:
          input.Key?.['pk'] === closure.pk
            ? closure
            : input.Key?.['pk'] === 'PRIVACY_STATE#adult'
              ? ledger
              : undefined,
      }));
      ddb.on(QueryCommand).callsFake((input) => {
        if (
          input.TableName === 'privacy' &&
          input.ExpressionAttributeValues?.[':pk'] === 'HOLD#adult'
        )
          return {
            Items: [
              {
                pk: 'HOLD#adult',
                sk: 'CASE#consent-case',
                userId: 'adult',
                caseId: 'consent-case',
                scope: 'consent',
                state: 'active',
                legalBasis: 'specific consent evidence preservation obligation',
                expiresAt: expiry,
                reviewAt: NOW + 86400000,
              },
            ],
          };
        if (
          input.TableName === 'main' &&
          input.ExpressionAttributeValues?.[':prefix'] === 'PRIVACY#'
        )
          return {
            Items: [
              { ...snapshot, record: { notes: 'private forest content' }, trees: ['private tree'] },
            ],
          };
        return { Items: [] };
      });
      await expect(
        processAccountClosureMessage(dependencies, { sub: 'adult', closureId: 'close-1' }),
      ).resolves.toBe('completed');
      const writes = ddb
        .commandCalls(TransactWriteCommand)
        .flatMap((call) => call.args[0].input.TransactItems ?? []);
      const archived = writes.find(
        (item) =>
          item.Put?.TableName === 'privacy' &&
          item.Put.Item?.['pk'] === 'CONSENT_ARCHIVE#adult' &&
          item.Put.Item?.['sk'] === 'PRIVACY#ADULT',
      )?.Put?.Item;
      expect(archived?.['guardianAuthorization']).toEqual(authorization);
      expect(archived).toMatchObject({
        closureId: 'close-1',
        retainUntil: expiry,
        ttl: Math.ceil(expiry / 1000),
      });
      expect(archived).not.toHaveProperty('record');
      expect(archived).not.toHaveProperty('trees');
      expect(
        writes.some(
          (item) =>
            item.Delete?.TableName === 'privacy' &&
            item.Delete.Key?.['pk'] === 'PRIVACY_STATE#adult',
        ),
      ).toBe(true);
      expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    },
  );
});
