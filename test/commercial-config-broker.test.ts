import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWriter } from '../lambda/commercial/audit';
import {
  createCommercialConfigBroker,
  type CommercialConfigBrokerEvent,
  type CommercialConfigCommand,
} from '../lambda/commercial-config-broker';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ACTOR = 'arn:aws:sts::111122223333:assumed-role/CommercialMigrationRole-dev/session-1';
const FLAG_ACTOR =
  'arn:aws:sts::111122223333:assumed-role/CommercialFlagOperatorRole-dev/session-2';
const NOW = Date.parse('2026-08-19T18:30:00.000Z');
const CUTOVER_AT = '2026-08-20T01:00:00.000Z';
const MANIFEST_HASH = 'a'.repeat(64);

const bootstrapBody = Object.freeze({
  command: 'bootstrap-flags',
  stage: 'dev',
  reason: 'initialize the prepayment rollout safely',
});

const setBody = Object.freeze({
  command: 'set-flags',
  stage: 'dev',
  expectedRevision: 7,
  reason: 'begin quota observation after reconciliation',
  changes: Object.freeze({
    quotaMode: 'observe',
    accessCodeIssuanceEnabled: true,
  }),
});

const freezeBody = Object.freeze({
  command: 'freeze-cutover',
  stage: 'dev',
  commercialEntitlementsCutoverAt: CUTOVER_AT,
  inventoryManifestHash: MANIFEST_HASH,
  reason: 'freeze the reconciled legacy inventory',
});

function event(body: unknown, actorArn: string | null = ACTOR): CommercialConfigBrokerEvent {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: {
      http: { method: 'POST' },
      authorizer: actorArn === null ? undefined : { iam: { userArn: actorArn } },
    },
  };
}

function conflict(): Error {
  const error = new Error('conditional transaction conflict') as Error & {
    CancellationReasons: Array<{ Code: string }>;
  };
  error.name = 'TransactionCanceledException';
  error.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
  return error;
}

function createBroker(
  allowlist: ReadonlyArray<{
    accountId: string;
    roleName: string;
    stage: string;
    commands: readonly CommercialConfigCommand[];
  }> = [
    {
      accountId: '111122223333',
      roleName: 'CommercialMigrationRole-dev',
      stage: 'dev',
      commands: ['bootstrap-flags', 'freeze-cutover'],
    },
    {
      accountId: '111122223333',
      roleName: 'CommercialFlagOperatorRole-dev',
      stage: 'dev',
      commands: ['set-flags'],
    },
  ],
) {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  let auditSequence = 0;
  return createCommercialConfigBroker({
    ddb,
    tableName: 'roadmap-dev',
    now: () => NOW,
    allowlist,
    auditWriter: new AuditWriter({
      ddb,
      tableName: 'roadmap-access-audit-dev',
      now: () => NOW,
      nextEventId: () => `broker-event-${++auditSequence}`,
    }),
  });
}

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

describe('CommercialConfigBroker authorization and exact request parsing', () => {
  beforeEach(() => ddbMock.reset());

  it('takes the actor only from Function URL IAM context and returns 401 before DynamoDB', async () => {
    const broker = createBroker();

    const response = await broker(
      event({ ...bootstrapBody, actorArn: ACTOR }, null),
    );

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'UNAUTHENTICATED' }),
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', []],
    ['an extra root field', { ...bootstrapBody, extra: true }],
    ['a blank reason', { ...bootstrapBody, reason: '   ' }],
    ['an oversized reason', { ...bootstrapBody, reason: 'x'.repeat(257) }],
    ['an empty set', { ...setBody, changes: {} }],
    [
      'an unknown set field',
      { ...setBody, changes: { ...setBody.changes, checkoutEnabled: true } },
    ],
    [
      'premiumPaymentsEnabled=false nested in changes',
      { ...setBody, changes: { premiumPaymentsEnabled: false } },
    ],
    [
      'premiumPaymentsEnabled=true at the root',
      { ...bootstrapBody, premiumPaymentsEnabled: true },
    ],
    [
      'premiumPaymentsEnabled=false hidden in an unrelated nested object',
      { ...bootstrapBody, extra: { premiumPaymentsEnabled: false } },
    ],
    [
      'an oversized body before parsing',
      `{"command":"bootstrap-flags","stage":"dev","reason":"ok","padding":"${'x'.repeat(4096)}"}`,
    ],
    [
      'an oversized deeply nested body before parsing',
      `{"command":"bootstrap-flags","stage":"dev","reason":"ok","extra":${'['.repeat(4096)}0${']'.repeat(4096)}}`,
    ],
    [
      'a non-canonical UTC cutover',
      { ...freezeBody, commercialEntitlementsCutoverAt: '2026-08-20T01:00:00Z' },
    ],
    ['an invalid manifest hash', { ...freezeBody, inventoryManifestHash: 'ABC123' }],
  ])('rejects %s with 400 and performs no DynamoDB operation', async (_label, body) => {
    const response = await createBroker()(event(body));

    expect(response.statusCode).toBe(400);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(json(response)).toEqual({ error: 'INVALID_REQUEST' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('enforces the injected actor, command, and stage allowlist before DynamoDB', async () => {
    const broker = createBroker([
      {
        accountId: '111122223333',
        roleName: 'CommercialMigrationRole-dev',
        stage: 'test',
        commands: ['bootstrap-flags'],
      },
      {
        accountId: '111122223333',
        roleName: 'CommercialMigrationRole-dev',
        stage: 'dev',
        commands: ['freeze-cutover'],
      },
    ]);

    const response = await broker(event(bootstrapBody));

    expect(response.statusCode).toBe(403);
    expect(json(response)).toEqual({ error: 'FORBIDDEN' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each([
    [
      'another AWS account',
      'arn:aws:sts::999900001111:assumed-role/CommercialMigrationRole-dev/session-1',
    ],
    [
      'a role with the allowed role as a prefix',
      'arn:aws:sts::111122223333:assumed-role/CommercialMigrationRole-dev-evil/session-1',
    ],
    ['an IAM role ARN', 'arn:aws:iam::111122223333:role/CommercialMigrationRole-dev'],
    ['an IAM user ARN', 'arn:aws:iam::111122223333:user/CommercialMigrationRole-dev'],
    [
      'an STS ARN without a session',
      'arn:aws:sts::111122223333:assumed-role/CommercialMigrationRole-dev',
    ],
  ])('rejects %s instead of loosely matching the operator role', async (_label, actorArn) => {
    const response = await createBroker()(event(bootstrapBody, actorArn));

    expect(response.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('allows a different STS session for the exact allowlisted account and role', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const anotherSession =
      'arn:aws:sts::111122223333:assumed-role/CommercialMigrationRole-dev/session-rotated';

    const response = await createBroker()(event(bootstrapBody, anotherSession));

    expect(response.statusCode).toBe(201);
    expect(
      ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.[0]?.Put
        ?.Item?.updatedBy,
    ).toBe(anotherSession);
  });
});

describe('CommercialConfigBroker flag mutations', () => {
  beforeEach(() => ddbMock.reset());

  it('bootstraps revision 1 off/false and audit with conditional Put entries', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const response = await createBroker()(event(bootstrapBody));

    expect(response.statusCode).toBe(201);
    expect(json(response)).toEqual({ command: 'bootstrap-flags', revision: 1 });
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems).toHaveLength(2);
    expect(transaction.TransactItems?.[0]?.Put).toEqual({
      TableName: 'roadmap-dev',
      Item: {
        pk: 'COMMERCIAL#CONFIG',
        sk: 'FLAGS',
        revision: 1,
        quotaMode: 'off',
        capabilityMode: 'off',
        accessCodeIssuanceEnabled: false,
        accessCodeRedemptionEnabled: false,
        premiumPaymentsEnabled: false,
        updatedAt: NOW,
        updatedBy: ACTOR,
        reason: bootstrapBody.reason,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(transaction.TransactItems?.[1]).toMatchObject({
      Put: {
        TableName: 'roadmap-access-audit-dev',
        Item: {
          action: 'commercial_config.flags_bootstrapped',
          actor: ACTOR,
          subject: 'COMMERCIAL#CONFIG/FLAGS',
          details: { stage: 'dev', revision: 1 },
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('updates only the requested mutable flags with revision CAS and conditional audit', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const response = await createBroker()(event(setBody, FLAG_ACTOR));

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ command: 'set-flags', revision: 8 });
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems).toHaveLength(2);
    const update = transaction.TransactItems?.[0]?.Update;
    expect(update).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' },
      ConditionExpression:
        'attribute_exists(pk) AND attribute_exists(sk) AND #revision = :expectedRevision AND #premiumPaymentsEnabled = :paymentsDisabled',
      ExpressionAttributeNames: {
        '#revision': 'revision',
        '#updatedAt': 'updatedAt',
        '#updatedBy': 'updatedBy',
        '#reason': 'reason',
        '#premiumPaymentsEnabled': 'premiumPaymentsEnabled',
        '#quotaMode': 'quotaMode',
        '#accessCodeIssuanceEnabled': 'accessCodeIssuanceEnabled',
      },
      ExpressionAttributeValues: {
        ':expectedRevision': 7,
        ':nextRevision': 8,
        ':paymentsDisabled': false,
        ':updatedAt': NOW,
        ':updatedBy': FLAG_ACTOR,
        ':reason': setBody.reason,
        ':quotaMode': 'observe',
        ':accessCodeIssuanceEnabled': true,
      },
    });
    expect(update?.UpdateExpression).toBe(
      'SET #revision = :nextRevision, #updatedAt = :updatedAt, #updatedBy = :updatedBy, #reason = :reason, #quotaMode = :quotaMode, #accessCodeIssuanceEnabled = :accessCodeIssuanceEnabled',
    );
    expect(transaction.TransactItems?.[1]).toMatchObject({
      Put: {
        TableName: 'roadmap-access-audit-dev',
        Item: {
          action: 'commercial_config.flags_changed',
          actor: FLAG_ACTOR,
          subject: 'COMMERCIAL#CONFIG/FLAGS',
          details: {
            stage: 'dev',
            expectedRevision: 7,
            revision: 8,
            changedFields: ['accessCodeIssuanceEnabled', 'quotaMode'],
          },
        },
      },
    });
  });

  it('lets exactly one of two concurrent writes win the same expected revision', async () => {
    let storedRevision = 7;
    ddbMock.on(TransactWriteCommand).callsFake(async (input) => {
      const expected = input.TransactItems?.[0]?.Update?.ExpressionAttributeValues?.[
        ':expectedRevision'
      ] as number;
      await Promise.resolve();
      if (storedRevision !== expected) throw conflict();
      storedRevision = expected + 1;
      return {};
    });
    const broker = createBroker();

    const responses = await Promise.all([
      broker(event(setBody, FLAG_ACTOR)),
      broker(
        event(
          {
            ...setBody,
            reason: 'begin capability observation after reconciliation',
            changes: { capabilityMode: 'observe' },
          },
          FLAG_ACTOR,
        ),
      ),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(storedRevision).toBe(8);
  });
});

describe('CommercialConfigBroker immutable cutover', () => {
  beforeEach(() => ddbMock.reset());

  it('freezes CUTOVER once with a conditional Put and audit in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const response = await createBroker()(event(freezeBody));

    expect(response.statusCode).toBe(201);
    expect(json(response)).toEqual({
      command: 'freeze-cutover',
      commercialEntitlementsCutoverAt: CUTOVER_AT,
      inventoryManifestHash: MANIFEST_HASH,
      idempotent: false,
    });
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems).toHaveLength(2);
    expect(transaction.TransactItems?.[0]?.Put).toEqual({
      TableName: 'roadmap-dev',
      Item: {
        pk: 'COMMERCIAL#CONFIG',
        sk: 'CUTOVER',
        commercialEntitlementsCutoverAt: CUTOVER_AT,
        inventoryManifestHash: MANIFEST_HASH,
        frozenAt: NOW,
        frozenBy: ACTOR,
        reason: freezeBody.reason,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(transaction.TransactItems?.[1]).toMatchObject({
      Put: {
        TableName: 'roadmap-access-audit-dev',
        Item: {
          action: 'commercial_config.cutover_frozen',
          actor: ACTOR,
          subject: 'COMMERCIAL#CONFIG/CUTOVER',
          details: {
            stage: 'dev',
            commercialEntitlementsCutoverAt: CUTOVER_AT,
            inventoryManifestHash: MANIFEST_HASH,
          },
        },
      },
    });
  });

  it('returns an identical existing CUTOVER as an idempotent success', async () => {
    ddbMock.on(TransactWriteCommand).rejects(conflict());
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'COMMERCIAL#CONFIG',
        sk: 'CUTOVER',
        commercialEntitlementsCutoverAt: CUTOVER_AT,
        inventoryManifestHash: MANIFEST_HASH,
        frozenAt: NOW - 60_000,
        frozenBy: ACTOR,
        reason: freezeBody.reason,
      },
    });

    const response = await createBroker()(event(freezeBody));

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      command: 'freeze-cutover',
      commercialEntitlementsCutoverAt: CUTOVER_AT,
      inventoryManifestHash: MANIFEST_HASH,
      idempotent: true,
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('returns 409 when an existing CUTOVER differs from the requested freeze', async () => {
    ddbMock.on(TransactWriteCommand).rejects(conflict());
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'COMMERCIAL#CONFIG',
        sk: 'CUTOVER',
        commercialEntitlementsCutoverAt: CUTOVER_AT,
        inventoryManifestHash: 'b'.repeat(64),
        frozenAt: NOW - 60_000,
        frozenBy: ACTOR,
        reason: freezeBody.reason,
      },
    });

    const response = await createBroker()(event(freezeBody));

    expect(response.statusCode).toBe(409);
    expect(json(response)).toEqual({ error: 'CONFIGURATION_CONFLICT' });
  });
});

describe('CommercialConfigBroker operational errors and log hygiene', () => {
  beforeEach(() => ddbMock.reset());

  it('maps an unexpected DynamoDB failure to a generic 503 without echoing input', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('table roadmap-dev unavailable'));

    const response = await createBroker()(event(bootstrapBody));

    expect(response.statusCode).toBe(503);
    expect(json(response)).toEqual({ error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
    expect(response.body).not.toContain(bootstrapBody.reason);
    expect(response.body).not.toContain(ACTOR);
  });

  it('does not misreport a throughput-cancelled transaction as a CAS conflict', async () => {
    const throughput = new Error('capacity unavailable') as Error & {
      CancellationReasons: Array<{ Code: string }>;
    };
    throughput.name = 'TransactionCanceledException';
    throughput.CancellationReasons = [{ Code: 'ProvisionedThroughputExceeded' }];
    ddbMock.on(TransactWriteCommand).rejects(throughput);

    const response = await createBroker()(event(bootstrapBody));

    expect(response.statusCode).toBe(503);
    expect(json(response)).toEqual({ error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
  });

  it('never logs the request body, actor ARN, or operator reason', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await createBroker()(event(setBody, FLAG_ACTOR));
      const captured = JSON.stringify([
        ...log.mock.calls,
        ...error.mock.calls,
        ...warn.mock.calls,
      ]);
      expect(captured).not.toContain(JSON.stringify(setBody));
      expect(captured).not.toContain(FLAG_ACTOR);
      expect(captured).not.toContain(setBody.reason);
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
