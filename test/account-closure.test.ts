import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AuditWriter } from '../lambda/commercial/audit';
import * as authz from '../lambda/authz';
import type { Ctx } from '../lambda/authz';
import { K, type Deps, type ProfileItem } from '../lambda/db';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const sqsMock = mockClient(SQSClient);

function profile(overrides: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile('adult-1'),
    userId: 'adult-1',
    username: 'rocio',
    displayName: 'Rocio',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 10_000,
    email: 'private@example.com',
    friendCode: 'FRIEND12',
    ...overrides,
  };
}

function baseDeps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
    table: 'roadmap-dev',
    userPoolId: 'pool-dev',
    now: () => NOW,
  };
}

async function loadHandlerModule(): Promise<Record<string, any> | null> {
  return import('../lambda/account-closure-handler').catch(() => null);
}

async function loadClosureModule(): Promise<Record<string, any> | null> {
  return import('../lambda/account-closure').catch(() => null);
}

async function loadReconcilerModule(): Promise<Record<string, any> | null> {
  return import('../lambda/account-closure-reconciler').catch(() => null);
}

function closureDeps(enqueue = vi.fn(async () => {})) {
  const base = baseDeps();
  return {
    ...base,
    auditWriter: new AuditWriter({
      ddb: base.ddb,
      tableName: 'roadmap-access-audit-dev',
      now: () => NOW,
      nextEventId: () => 'audit-transition',
    }),
    queue: { enqueue },
    nextClosureId: () => 'closure-1',
    nextWorkerId: () => 'worker-1',
  };
}

function closureItem(overrides: Record<string, unknown> = {}) {
  return {
    pk: 'ACCOUNT_CLOSURE#adult-1',
    sk: 'STATE',
    closureId: 'closure-1',
    sub: 'adult-1',
    username: 'rocio',
    friendCode: 'FRIEND12',
    state: 'requested',
    revision: 1,
    requestedAt: NOW - 1000,
    updatedAt: NOW - 1000,
    nextAttemptAt: NOW,
    gsi1pk: 'ACCOUNT_CLOSURE#OPEN',
    gsi1sk: `NEXT#${NOW}#adult-1`,
    checkpoint: { phase: 'friendMirrors' },
    ...overrides,
  };
}

describe('account closure request', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('persists closure, closing profile and audit atomically before enqueueing', async () => {
    const module = await loadHandlerModule();
    expect(module, 'account closure handler module should exist').not.toBeNull();

    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push('enqueue');
    });
    const deps = {
      ...baseDeps(),
      auditWriter: new AuditWriter({
        ddb: baseDeps().ddb,
        tableName: 'roadmap-access-audit-dev',
        now: () => NOW,
        nextEventId: () => 'audit-requested',
      }),
      queue: { enqueue },
      nextClosureId: () => 'closure-1',
    };
    ddbMock.on(GetCommand).resolves({ Item: profile() });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      order.push('transact');
      return {};
    });

    const receipt = await module!.requestAccountClosure(
      deps,
      'adult-1',
      'request-1',
    );

    expect(receipt).toEqual({ closureId: 'closure-1', state: 'requested' });
    expect(order).toEqual(['transact', 'enqueue']);
    expect(enqueue).toHaveBeenCalledWith({ sub: 'adult-1', closureId: 'closure-1' });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems).toHaveLength(3);
    const closurePut = transaction.TransactItems?.[0]?.Put;
    expect(closurePut).toMatchObject({
      TableName: 'roadmap-dev',
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        pk: 'ACCOUNT_CLOSURE#adult-1',
        sk: 'STATE',
        closureId: 'closure-1',
        sub: 'adult-1',
        username: 'rocio',
        friendCode: 'FRIEND12',
        state: 'requested',
        revision: 1,
        requestedAt: NOW,
        updatedAt: NOW,
        nextAttemptAt: NOW,
        gsi1pk: 'ACCOUNT_CLOSURE#OPEN',
      },
    });
    expect(closurePut?.Item).not.toHaveProperty('email');
    expect(closurePut?.Item).not.toHaveProperty('displayName');

    const profileUpdate = transaction.TransactItems?.[1]?.Update;
    expect(profileUpdate?.Key).toEqual(K.profile('adult-1'));
    expect(profileUpdate?.UpdateExpression).toContain('#status = :closing');
    expect(profileUpdate?.ConditionExpression).toContain('attribute_exists(pk)');
    expect(profileUpdate?.ConditionExpression).toContain('accountType = :adult');
    expect(profileUpdate?.ConditionExpression).toContain('attribute_not_exists(#status)');
    expect(profileUpdate?.ConditionExpression).toContain('#status = :active');
    expect(profileUpdate?.ConditionExpression).toContain('username = :username');
    expect(profileUpdate?.ConditionExpression).toContain('friendCode = :friendCode');

    expect(transaction.TransactItems?.[2]?.Put).toMatchObject({
      TableName: 'roadmap-access-audit-dev',
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        action: 'account_closure.requested',
        actor: 'user:adult-1',
        subject: 'adult-1',
        eventId: 'audit-requested',
        occurredAt: NOW,
      },
    });
  });

  it('reuses an existing closure even when the profile is already gone', async () => {
    const module = await loadHandlerModule();
    expect(module).not.toBeNull();
    const enqueue = vi.fn(async () => {
      throw new Error('SQS unavailable');
    });
    const deps = {
      ...baseDeps(),
      auditWriter: new AuditWriter({
        ddb: baseDeps().ddb,
        tableName: 'roadmap-access-audit-dev',
        now: () => NOW,
        nextEventId: () => 'unused',
      }),
      queue: { enqueue },
      nextClosureId: () => 'must-not-be-used',
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#adult-1') {
        return {
          Item: {
            pk: key.pk,
            sk: 'STATE',
            closureId: 'closure-existing',
            sub: 'adult-1',
            username: 'rocio',
            state: 'purging',
            revision: 4,
            requestedAt: NOW - 1000,
            updatedAt: NOW - 100,
            nextAttemptAt: NOW,
            gsi1pk: 'ACCOUNT_CLOSURE#OPEN',
            gsi1sk: `NEXT#${NOW}#adult-1`,
            checkpoint: { phase: 'userPartition' },
          },
        };
      }
      return { Item: undefined };
    });

    const receipt = await module!.requestAccountClosure(deps, 'adult-1', 'request-retry');

    expect(receipt).toEqual({ closureId: 'closure-existing', state: 'purging' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledWith({
      sub: 'adult-1',
      closureId: 'closure-existing',
    });
  });

  it('keeps the durable request accepted when its first enqueue fails', async () => {
    const module = await loadHandlerModule();
    expect(module).not.toBeNull();
    const deps = {
      ...baseDeps(),
      auditWriter: new AuditWriter({
        ddb: baseDeps().ddb,
        tableName: 'roadmap-access-audit-dev',
        now: () => NOW,
        nextEventId: () => 'audit-requested',
      }),
      queue: {
        enqueue: vi.fn(async () => {
          throw new Error('SQS unavailable');
        }),
      },
      nextClosureId: () => 'closure-durable',
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.sk === 'PROFILE' ? { Item: profile() } : { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-durable'),
    ).resolves.toEqual({ closureId: 'closure-durable', state: 'requested' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('re-reads the winning closure when concurrent requests race the transaction', async () => {
    const module = await loadHandlerModule();
    expect(module).not.toBeNull();
    const enqueue = vi.fn(async () => {});
    const deps = {
      ...closureDeps(enqueue),
      nextClosureId: () => 'closure-loser',
    };
    let closureReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile() };
      closureReads += 1;
      return closureReads === 1
        ? { Item: undefined }
        : {
            Item: closureItem({
              closureId: 'closure-winner',
              state: 'requested',
              revision: 1,
            }),
          };
    });
    const conflict = new Error('concurrent closure');
    conflict.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteCommand).rejects(conflict);

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-race'),
    ).resolves.toEqual({ closureId: 'closure-winner', state: 'requested' });
    expect(closureReads).toBe(2);
    expect(enqueue).toHaveBeenCalledWith({
      sub: 'adult-1',
      closureId: 'closure-winner',
    });
  });
});

describe('requireWritableOwner', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  function ctx(): Ctx {
    const caller = profile();
    return { callerId: caller.userId, caller, deps: baseDeps() };
  }

  it('treats a legacy profile with missing status as active', async () => {
    const guard = (authz as Record<string, any>)['requireWritableOwner'];
    expect(guard).toBeTypeOf('function');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.sk === 'PROFILE' ? { Item: profile() } : { Item: undefined };
    });

    await expect(guard(ctx(), 'adult-1')).resolves.toMatchObject({ userId: 'adult-1' });
    const reads = ddbMock.commandCalls(GetCommand);
    expect(reads).toHaveLength(2);
    expect(reads.every((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
  });

  it('blocks a closing profile', async () => {
    const guard = (authz as Record<string, any>)['requireWritableOwner'];
    expect(guard).toBeTypeOf('function');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.sk === 'PROFILE'
        ? { Item: { ...profile(), status: 'closing' } }
        : { Item: undefined };
    });

    await expect(guard(ctx(), 'adult-1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('blocks an owner as soon as an external closure exists', async () => {
    const guard = (authz as Record<string, any>)['requireWritableOwner'];
    expect(guard).toBeTypeOf('function');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: { ...profile(), status: 'active' } };
      return { Item: { ...key, closureId: 'closure-1', state: 'requested' } };
    });

    await expect(guard(ctx(), 'adult-1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('account closure worker', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('advances requested to purging with revision CAS and audit before continuing', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({ Item: closureItem() });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('pending');

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const transition = transaction.TransactItems?.[0]?.Update;
    expect(transition?.Key).toEqual({ pk: 'ACCOUNT_CLOSURE#adult-1', sk: 'STATE' });
    expect(transition?.ConditionExpression).toContain('closureId = :closureId');
    expect(transition?.ConditionExpression).toContain('revision = :expectedRevision');
    expect(transition?.ConditionExpression).toContain('#state = :expectedState');
    expect(transition?.ExpressionAttributeValues).toMatchObject({
      ':closureId': 'closure-1',
      ':expectedRevision': 1,
      ':expectedState': 'requested',
      ':nextState': 'purging',
      ':nextRevision': 2,
    });
    expect(transaction.TransactItems?.[1]?.Put).toMatchObject({
      TableName: 'roadmap-access-audit-dev',
      Item: {
        action: 'account_closure.purging',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
    expect(enqueue).toHaveBeenCalledWith({ sub: 'adult-1', closureId: 'closure-1' });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('deletes a friend mirror before checkpointing the paginated user scan', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push('enqueue');
    });
    const deps = closureDeps(enqueue);
    const purging = closureItem({ state: 'purging', revision: 2 });
    ddbMock.on(GetCommand).callsFake(() => {
      order.push('get');
      return { Item: purging };
    });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      order.push(updates === 1 ? 'lease' : 'checkpoint');
      return updates === 1
        ? {
            Attributes: {
              ...purging,
              revision: 3,
              leaseOwner: 'worker-1',
              leaseUntil: NOW + 60_000,
            },
          }
        : {};
    });
    ddbMock.on(QueryCommand).callsFake(() => {
      order.push('query');
      return {
        Items: [
          {
            pk: 'USER#adult-1',
            sk: 'FRIEND#friend-2',
            friendshipId: 'adult-1~friend-2',
            userA: 'adult-1',
            userB: 'friend-2',
            createdAt: NOW - 1000,
          },
        ],
        LastEvaluatedKey: { pk: 'USER#adult-1', sk: 'FRIEND#friend-2' },
      };
    });
    ddbMock.on(BatchWriteCommand).callsFake(() => {
      order.push('batch');
      return {};
    });

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    expect(order).toEqual(['get', 'lease', 'query', 'batch', 'checkpoint', 'enqueue']);
    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      TableName: 'roadmap-dev',
      Limit: 25,
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ':pk': 'USER#adult-1',
        ':prefix': 'FRIEND#',
      },
    });
    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: K.friend('friend-2', 'adult-1') } },
    ]);
    expect(JSON.stringify(batch)).not.toContain('"sk":"PROFILE"');

    const lease = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(lease.ConditionExpression).toContain('revision = :expectedRevision');
    expect(lease.ConditionExpression).toContain('attribute_not_exists(leaseUntil)');
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ConditionExpression).toContain('leaseOwner = :leaseOwner');
    expect(checkpoint.ConditionExpression).toContain('revision = :expectedRevision');
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: 'friendMirrors',
      exclusiveStartKey: { pk: 'USER#adult-1', sk: 'FRIEND#friend-2' },
    });
    expect(checkpoint.UpdateExpression).toContain('REMOVE leaseOwner, leaseUntil');
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it.each([
    {
      phase: 'outgoingFriendRequests',
      prefix: 'FREQ#',
      item: {
        pk: 'USER#recipient-2',
        sk: 'FREQ#request-1',
        gsi1pk: 'USER#adult-1',
        gsi1sk: 'FREQ#request-1',
        requestId: 'request-1',
        fromId: 'adult-1',
        toId: 'recipient-2',
      },
      nextPhase: 'guardianLinks',
    },
    {
      phase: 'guardianLinks',
      prefix: 'MINOR#',
      item: {
        pk: 'USER#minor-2',
        sk: 'GUARDIAN#adult-1',
        gsi1pk: 'USER#adult-1',
        gsi1sk: 'MINOR#minor-2',
        guardianId: 'adult-1',
        minorId: 'minor-2',
      },
      nextPhase: 'directMirrors',
    },
  ])('paginates and deletes $phase primary mirrors through gsi1', async (fixture) => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    const purging = closureItem({
      state: 'purging',
      revision: 4,
      checkpoint: { phase: fixture.phase },
    });
    ddbMock.on(GetCommand).resolves({ Item: purging });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1
        ? {
            Attributes: {
              ...purging,
              revision: 5,
              leaseOwner: 'worker-1',
              leaseUntil: NOW + 60_000,
            },
          }
        : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [fixture.item] });
    ddbMock.on(BatchWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.IndexName).toBe('gsi1');
    expect(query.ConsistentRead).not.toBe(true);
    expect(query.ExpressionAttributeValues).toMatchObject({
      ':pk': 'USER#adult-1',
      ':prefix': fixture.prefix,
    });
    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: { pk: fixture.item.pk, sk: fixture.item.sk } } },
    ]);
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: fixture.phase,
      quietPasses: 0,
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it.each([
    {
      quietPasses: 0,
      expectedCheckpoint: { phase: 'outgoingFriendRequests', quietPasses: 1 },
      expectedDelay: 30,
    },
    {
      quietPasses: 1,
      expectedCheckpoint: { phase: 'guardianLinks' },
      expectedDelay: undefined,
    },
  ])(
    'requires two separated empty gsi sweeps from quietPasses=$quietPasses',
    async ({ quietPasses, expectedCheckpoint, expectedDelay }) => {
      const module = await loadClosureModule();
      const processMessage = module?.['processAccountClosureMessage'];
      expect(processMessage).toBeTypeOf('function');
      const enqueue = vi.fn(async () => {});
      const deps = closureDeps(enqueue);
      const purging = closureItem({
        state: 'purging',
        revision: 4,
        checkpoint: { phase: 'outgoingFriendRequests', quietPasses },
      });
      ddbMock.on(GetCommand).resolves({ Item: purging });
      let updates = 0;
      ddbMock.on(UpdateCommand).callsFake(() => {
        updates += 1;
        return updates === 1
          ? {
              Attributes: {
                ...purging,
                revision: 5,
                leaseOwner: 'worker-1',
                leaseUntil: NOW + 60_000,
              },
            }
          : {};
      });
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
      const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
      expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual(
        expectedCheckpoint,
      );
      expect(checkpoint.ExpressionAttributeValues?.[':nextAttemptAt']).toBe(
        expectedDelay === undefined ? NOW : NOW + 30_000,
      );
      if (expectedDelay === undefined) {
        expect(enqueue).toHaveBeenCalledWith({
          sub: 'adult-1',
          closureId: 'closure-1',
        });
      } else {
        expect(enqueue).toHaveBeenCalledWith(
          { sub: 'adult-1', closureId: 'closure-1' },
          expectedDelay,
        );
      }
    },
  );

  it('does not let an early duplicate bypass the gsi stability window', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: closureItem({
        state: 'purging',
        revision: 5,
        nextAttemptAt: NOW + 30_000,
        checkpoint: { phase: 'outgoingFriendRequests', quietPasses: 1 },
      }),
    });

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('pending');

    expect(enqueue).toHaveBeenCalledWith(
      { sub: 'adult-1', closureId: 'closure-1' },
      30,
    );
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('deletes username and friend-code mirrors before entering the user partition phase', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    const purging = closureItem({
      state: 'purging',
      revision: 6,
      checkpoint: { phase: 'directMirrors' },
    });
    ddbMock.on(GetCommand).resolves({ Item: purging });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1
        ? {
            Attributes: {
              ...purging,
              revision: 7,
              leaseOwner: 'worker-1',
              leaseUntil: NOW + 60_000,
            },
          }
        : {};
    });
    ddbMock.on(BatchWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: K.uniqUsername('rocio') } },
      { DeleteRequest: { Key: K.codeF('FRIEND12') } },
    ]);
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: 'userPartition',
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('resumes and deletes one consistent USER partition page without touching Cognito', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    const previousKey = { pk: 'USER#adult-1', sk: 'REC#nodes#n0' };
    const nextKey = { pk: 'USER#adult-1', sk: 'REC#nodes#n2' };
    const purging = closureItem({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'userPartition', exclusiveStartKey: previousKey },
    });
    ddbMock.on(GetCommand).resolves({ Item: purging });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1
        ? {
            Attributes: {
              ...purging,
              revision: 9,
              leaseOwner: 'worker-1',
              leaseUntil: NOW + 60_000,
            },
          }
        : {};
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: 'USER#adult-1', sk: 'REC#nodes#n1' },
        { pk: 'USER#adult-1', sk: 'REC#nodes#n2' },
      ],
      LastEvaluatedKey: nextKey,
    });
    ddbMock.on(BatchWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      TableName: 'roadmap-dev',
      Limit: 25,
      ConsistentRead: true,
      ExclusiveStartKey: previousKey,
      ExpressionAttributeValues: { ':pk': 'USER#adult-1' },
    });
    expect(query.IndexName).toBeUndefined();
    expect(query.ExpressionAttributeValues).not.toHaveProperty(':prefix');
    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: { pk: 'USER#adult-1', sk: 'REC#nodes#n1' } } },
      { DeleteRequest: { Key: { pk: 'USER#adult-1', sk: 'REC#nodes#n2' } } },
    ]);
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: 'userPartition',
      exclusiveStartKey: nextKey,
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('marks purgeComplete only after a consistent empty USER verification', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    const purging = closureItem({
      state: 'purging',
      revision: 10,
      checkpoint: { phase: 'userPartition' },
    });
    ddbMock.on(GetCommand).resolves({ Item: purging });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        ...purging,
        revision: 11,
        leaseOwner: 'worker-1',
        leaseUntil: NOW + 60_000,
      },
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    const transition = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transition.TransactItems?.[0]?.Update).toMatchObject({
      Key: { pk: 'ACCOUNT_CLOSURE#adult-1', sk: 'STATE' },
      ExpressionAttributeValues: {
        ':closureId': 'closure-1',
        ':expectedRevision': 11,
        ':expectedState': 'purging',
        ':leaseOwner': 'worker-1',
        ':nextState': 'purgeComplete',
        ':nextRevision': 12,
        ':now': NOW,
      },
    });
    expect(transition.TransactItems?.[0]?.Update?.ConditionExpression).toContain(
      'leaseOwner = :leaseOwner',
    );
    expect(transition.TransactItems?.[0]?.Update?.UpdateExpression).toContain(
      'purgeCompleteAt = :now',
    );
    expect(transition.TransactItems?.[0]?.Update?.UpdateExpression).toContain(
      'REMOVE leaseOwner, leaseUntil, checkpoint',
    );
    expect(transition.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        action: 'account_closure.purge_complete',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
    expect(enqueue).toHaveBeenCalledWith({ sub: 'adult-1', closureId: 'closure-1' });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('deletes Cognito from purgeComplete and then records completed with TTL', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push('enqueue');
    });
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).callsFake(() => {
      order.push('get');
      return {
        Item: closureItem({
          state: 'purgeComplete',
          revision: 12,
          purgeCompleteAt: NOW - 100,
          checkpoint: undefined,
        }),
      };
    });
    cognitoMock.on(AdminDeleteUserCommand).callsFake(() => {
      order.push('cognito');
      return {};
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      order.push('complete');
      return {};
    });

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('completed');

    expect(order).toEqual(['get', 'cognito', 'complete']);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)[0].args[0].input).toEqual({
      UserPoolId: 'pool-dev',
      Username: 'rocio',
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const completed = transaction.TransactItems?.[0]?.Update;
    expect(completed?.ConditionExpression).toContain('revision = :expectedRevision');
    expect(completed?.ConditionExpression).toContain('#state = :expectedState');
    expect(completed?.ExpressionAttributeValues).toMatchObject({
      ':closureId': 'closure-1',
      ':expectedRevision': 12,
      ':expectedState': 'purgeComplete',
      ':nextState': 'completed',
      ':nextRevision': 13,
      ':now': NOW,
      ':ttl': Math.ceil((NOW + 30 * 24 * 60 * 60 * 1000) / 1000),
    });
    expect(completed?.UpdateExpression).toContain('completedAt = :now');
    expect(completed?.UpdateExpression).toContain('ttl = :ttl');
    expect(completed?.UpdateExpression).toContain(
      'REMOVE gsi1pk, gsi1sk, nextAttemptAt, leaseOwner, leaseUntil, checkpoint',
    );
    expect(transaction.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        action: 'account_closure.completed',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('treats an already missing Cognito user as a resumable successful delete', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    ddbMock.on(GetCommand).resolves({
      Item: closureItem({ state: 'purgeComplete', revision: 12, checkpoint: undefined }),
    });
    const missing = new Error('already deleted');
    missing.name = 'UserNotFoundException';
    cognitoMock.on(AdminDeleteUserCommand).rejects(missing);
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('completed');
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('keeps purgeComplete open when Cognito fails transiently', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: closureItem({ state: 'purgeComplete', revision: 12, checkpoint: undefined }),
    });
    const throttled = new Error('retry later');
    throttled.name = 'TooManyRequestsException';
    cognitoMock.on(AdminDeleteUserCommand).rejects(throttled);

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).rejects.toBe(throttled);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acks a purging message that loses the lease revision race', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: closureItem({ state: 'purging', revision: 8, checkpoint: { phase: 'userPartition' } }),
    });
    const lost = new Error('lease already acquired');
    lost.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(lost);

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('pending');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['unknown', { phase: 'not-a-real-phase' }],
  ])('fails a purging closure with a %s checkpoint instead of hot-looping', async (_label, checkpoint) => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = closureDeps(enqueue);
    const purging = closureItem({ state: 'purging', revision: 8, checkpoint });
    ddbMock.on(GetCommand).resolves({ Item: purging });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        ...purging,
        revision: 9,
        leaseOwner: 'worker-1',
        leaseUntil: NOW + 60_000,
      },
    });

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).rejects.toThrow('invalid account closure checkpoint');

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('account closure SQS boundary', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    sqsMock.reset();
  });

  it('serializes the exact closure message and optional delay through SQS', async () => {
    const module = await loadClosureModule();
    const createQueue = module?.['createAccountClosureQueue'];
    expect(createQueue).toBeTypeOf('function');
    sqsMock.on(SendMessageCommand).resolves({});
    const queue = createQueue(new SQSClient({}), 'https://sqs.test/closure');

    await queue.enqueue({ sub: 'adult-1', closureId: 'closure-1' }, 30);

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input).toEqual({
      QueueUrl: 'https://sqs.test/closure',
      MessageBody: JSON.stringify({ sub: 'adult-1', closureId: 'closure-1' }),
      DelaySeconds: 30,
    });
  });

  it('returns partial failures for invalid or failed records without logging bodies', async () => {
    const module = await loadClosureModule();
    const handleQueue = module?.['handleAccountClosureQueueEvent'];
    expect(handleQueue).toBeTypeOf('function');
    const deps = closureDeps();
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#adult-error') throw new Error('Dynamo unavailable');
      return {
        Item: closureItem({
          pk: key.pk,
          sub: key.pk.replace('ACCOUNT_CLOSURE#', ''),
          state: 'completed',
          revision: 13,
        }),
      };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = {
      Records: [
        {
          messageId: 'ok',
          body: JSON.stringify({ sub: 'adult-1', closureId: 'closure-1' }),
        },
        {
          messageId: 'invalid',
          body: JSON.stringify({
            sub: 'adult-1',
            closureId: 'closure-1',
            unexpected: 'must-fail-closed',
          }),
        },
        {
          messageId: 'error',
          body: JSON.stringify({ sub: 'adult-error', closureId: 'closure-1' }),
        },
      ],
    };

    await expect(handleQueue(event, deps)).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'invalid' },
        { itemIdentifier: 'error' },
      ],
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});

describe('account closure reconciler', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('paginates the sparse open index and only enqueues closures that are due', async () => {
    const module = await loadReconcilerModule();
    expect(module, 'account closure reconciler module should exist').not.toBeNull();
    const reconcile = module?.['reconcileOpenAccountClosures'];
    expect(reconcile).toBeTypeOf('function');
    const enqueue = vi.fn(async () => {});
    const deps = { ...baseDeps(), queue: { enqueue } };
    const pageKey = { pk: 'ACCOUNT_CLOSURE#adult-future', sk: 'STATE' };
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (!input.ExclusiveStartKey) {
        return {
          Items: [
            closureItem({ sub: 'adult-due-1', closureId: 'closure-due-1', nextAttemptAt: NOW }),
            closureItem({
              sub: 'adult-future',
              closureId: 'closure-future',
              nextAttemptAt: NOW + 1,
            }),
          ],
          LastEvaluatedKey: pageKey,
        };
      }
      return {
        Items: [
          closureItem({
            sub: 'adult-due-2',
            closureId: 'closure-due-2',
            nextAttemptAt: NOW - 1,
          }),
        ],
      };
    });

    await reconcile(deps);

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'roadmap-dev',
      IndexName: 'gsi1',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': 'ACCOUNT_CLOSURE#OPEN',
        ':prefix': 'NEXT#',
      },
      Limit: 25,
    });
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual(pageKey);
    expect(enqueue.mock.calls).toEqual([
      [{ sub: 'adult-due-1', closureId: 'closure-due-1' }],
      [{ sub: 'adult-due-2', closureId: 'closure-due-2' }],
    ]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });
});

describe('account closure instrumentation', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('instruments a partial-failure worker invocation without logging records or response', async () => {
    const module = await loadClosureModule();
    const createHandler = module?.['createAccountClosureWorkerHandler'];
    expect(createHandler).toBeTypeOf('function');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createHandler(() => closureDeps());
    const event = {
      Records: [
        {
          messageId: 'never-log-message-id',
          body: JSON.stringify({
            sub: 'never-log-sub',
            closureId: 'never-log-closure',
            username: 'never-log-username',
          }),
        },
      ],
    };

    await expect(
      handler(event, { awsRequestId: 'worker-request-id' }),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'never-log-message-id' }],
    });

    const capture = [...info.mock.calls, ...error.mock.calls]
      .map(([line]) => String(line))
      .join('\n');
    expect(capture).toContain('"service":"account-closure-worker"');
    expect(capture).toContain('"requestId":"worker-request-id"');
    expect(capture).toContain('"correlationId":"worker-request-id"');
    expect(capture).toContain('InvocationSucceeded');
    for (const secret of [
      'never-log-message-id',
      'never-log-sub',
      'never-log-closure',
      'never-log-username',
      'batchItemFailures',
    ]) {
      expect(capture).not.toContain(secret);
    }
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it('instruments reconciliation with Lambda context without logging event identity fields', async () => {
    const module = await loadReconcilerModule();
    const createHandler = module?.['createAccountClosureReconcilerHandler'];
    expect(createHandler).toBeTypeOf('function');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = { ...baseDeps(), queue: { enqueue: vi.fn(async () => {}) } };
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const handler = createHandler(() => deps);
    const event = {
      detail: { sub: 'never-log-reconciler-sub', username: 'never-log-reconciler-username' },
      body: 'never-log-reconciler-body',
    };

    await expect(
      handler(event, { awsRequestId: 'reconciler-request-id' }),
    ).resolves.toBeUndefined();

    const capture = [...info.mock.calls, ...error.mock.calls]
      .map(([line]) => String(line))
      .join('\n');
    expect(capture).toContain('"service":"account-closure-reconciler"');
    expect(capture).toContain('"requestId":"reconciler-request-id"');
    expect(capture).toContain('"correlationId":"reconciler-request-id"');
    expect(capture).toContain('InvocationSucceeded');
    for (const secret of [
      'never-log-reconciler-sub',
      'never-log-reconciler-username',
      'never-log-reconciler-body',
    ]) {
      expect(capture).not.toContain(secret);
    }
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });
});
