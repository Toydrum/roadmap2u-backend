import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
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
import { accountClosureKey } from '../lambda/account-closure';
import * as authz from '../lambda/authz';
import type { Ctx } from '../lambda/authz';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import {
  adultFamilyClosureBlockReason,
  adultFamilyClosureConditionChecks,
} from '../lambda/family/account-closure';
import { createSupervisionLink } from '../lambda/family/model';
import { SK } from '../lambda/social/model';
import type { FamilyV2Fixture } from './support/family-v2-fixture';
import { familyV2Fixture } from './support/family-v2-fixture';

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
    familyFenceVersion: 1,
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
    familyCleanupVersion: 1,
    checkpoint: { phase: 'friendMirrors' },
    ...overrides,
  };
}

function installFamilyReads(family: FamilyV2Fixture, account: ProfileItem): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (key.pk === accountClosureKey(account.userId).pk) return {};
    if (key.pk === K.user(account.userId) && key.sk === 'PROFILE') return { Item: account };
    const coverage = family.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
    return coverage ? { Item: coverage } : {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
    const pk = values?.[':pk'];
    const prefix = values?.[':prefix'] ?? '';
    if (pk === family.household.pk) return { Items: [family.household, ...family.seats] };
    if (input.IndexName === 'gsi1') {
      return {
        Items: family.supervisionLinks.filter(
          (item) => item.gsi1pk === pk && item.gsi1sk.startsWith(prefix),
        ),
      };
    }
    return {
      Items: family.supervisionLinks.filter(
        (item) => item.pk === pk && item.sk.startsWith(prefix),
      ),
    };
  });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const keys = (input.RequestItems?.['roadmap-dev']?.Keys ?? []) as Array<{
      pk: string;
      sk: string;
    }>;
    return {
      Responses: {
        'roadmap-dev': family.coverages.filter((coverage) =>
          keys.some((key) => key.pk === coverage.pk && key.sk === coverage.sk),
        ),
      },
    };
  });
}

describe('account closure request', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'roadmap-dev': [] } });
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
    expect(transaction.TransactItems).toHaveLength(4);
    const closurePut = transaction.TransactItems?.find(
      (item) => item.Put?.TableName === 'roadmap-dev',
    )?.Put;
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

    const profileUpdate = transaction.TransactItems?.find((item) => item.Update)?.Update;
    expect(profileUpdate?.Key).toEqual(K.profile('adult-1'));
    expect(profileUpdate?.UpdateExpression).toContain('#status = :closing');
    expect(profileUpdate?.ConditionExpression).toContain('attribute_exists(pk)');
    expect(profileUpdate?.ConditionExpression).toContain('accountType = :adult');
    expect(profileUpdate?.ConditionExpression).toContain('attribute_not_exists(#status)');
    expect(profileUpdate?.ConditionExpression).toContain('#status = :active');
    expect(profileUpdate?.ConditionExpression).toContain('username = :username');
    expect(profileUpdate?.ConditionExpression).toContain('friendCode = :friendCode');
    expect(profileUpdate?.ConditionExpression).toContain('familyFenceVersion = :familyFenceVersion');
    expect(profileUpdate?.ConditionExpression).toContain('attribute_not_exists(createdMinorIds)');
    expect(profileUpdate?.ExpressionAttributeValues).toMatchObject({ ':familyFenceVersion': 1 });

    expect(transaction.TransactItems?.find((item) =>
      item.ConditionCheck?.Key?.['pk'] === FK.familyCoverage('adult-1').pk &&
      item.ConditionCheck.Key['sk'] === FK.familyCoverage('adult-1').sk
    )?.ConditionCheck).toMatchObject({
      TableName: 'roadmap-dev',
      Key: FK.familyCoverage('adult-1'),
      ConditionExpression: expect.stringContaining('attribute_not_exists(pk)'),
    });

    expect(transaction.TransactItems?.find(
      (item) => item.Put?.TableName === 'roadmap-access-audit-dev',
    )?.Put).toMatchObject({
      TableName: 'roadmap-access-audit-dev',
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        targetKind: 'USER',
        targetId: 'adult-1',
        timestamp: NOW,
        requestId: 'request-1',
        action: 'account_closure.requested',
        actor: 'user:adult-1',
        subject: 'adult-1',
      },
    });
  });

  it.each([
    ['a legacy profile without a completed fence', { familyFenceVersion: undefined }],
    [
      'a guardian that still owns a created minor',
      { familyFenceVersion: 1 as const, createdMinorIds: new Set(['minor-1']) },
    ],
  ])('fails closed for %s and never enqueues', async (_label, profileOverrides) => {
    const module = await loadHandlerModule();
    expect(module).not.toBeNull();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const cancelled = Object.assign(new Error('family fence rejected closure'), {
      name: 'TransactionCanceledException',
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.user('adult-1') && key.sk === 'PROFILE') {
        return { Item: profile(profileOverrides) };
      }
      return {};
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-family-fence'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(enqueue).not.toHaveBeenCalled();
    const update = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems?.find((item) => item.Update)?.Update;
    expect(update?.ConditionExpression).toContain('familyFenceVersion = :familyFenceVersion');
    expect(update?.ConditionExpression).toContain('attribute_not_exists(createdMinorIds)');
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

  it('keeps the internal blocked state out of the public receipt contract', async () => {
    const module = await loadHandlerModule();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: closureItem({ state: 'blocked', blockReason: 'created_family_link' }),
    });

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-blocked'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('keeps the durable request accepted when its first enqueue fails', async () => {
    const module = await loadHandlerModule();
    expect(module).not.toBeNull();
    const deps = {
      ...baseDeps(),
      auditWriter: new AuditWriter({
        ddb: baseDeps().ddb,
        tableName: 'roadmap-access-audit-dev',
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
      if (key.pk !== accountClosureKey('adult-1').pk || key.sk !== 'STATE') return {};
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

  it('fences the exact active supervision row before a worker can durably block closure', () => {
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-1',
      minorIds: ['minor-1'],
      additionalResponsibleSeat: 1,
      additionalId: 'adult-1',
      additionalScope: ['minor-1'],
    });
    const activeLink = family.supervisionLinks.find((link) => link.adultId === 'adult-1')!;

    const checks = adultFamilyClosureConditionChecks('roadmap-dev', {
      accountId: 'adult-1',
      coverage: family.coverages.find((item) => item.accountId === 'adult-1')!,
      snapshots: [{
        household: family.household,
        seats: family.seats,
        supervisionLinks: family.supervisionLinks,
        coverages: family.coverages,
      }],
      indexedSupervisionLinks: [activeLink],
    });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: FK.supervision('minor-1', 'adult-1'),
          ConditionExpression: expect.stringContaining('#state = :state'),
          ExpressionAttributeValues: expect.objectContaining({
            ':state': 'active',
            ':revision': activeLink.revision,
          }),
        }),
      }),
    ]));
  });

  it('fails closed when a non-active Household still contains a primary minor seat', () => {
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'adult-1',
      minorIds: ['minor-1'],
    });

    expect(adultFamilyClosureBlockReason({
      accountId: 'adult-1',
      coverage: family.coverages.find((item) => item.accountId === 'adult-1')!,
      snapshots: [{
        household: { ...family.household, state: 'closed', revision: 2, updatedAt: NOW },
        seats: family.seats,
        supervisionLinks: family.supervisionLinks,
        coverages: family.coverages,
      }],
      indexedSupervisionLinks: [],
    })).toBe('incomplete_family_state');
  });

  it('blocks a current primary with seated minors even when paid coverage has ended', async () => {
    const module = await loadHandlerModule();
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'adult-1',
      minorIds: ['minor-1'],
    });
    family.coverages[0] = {
      ...family.coverages[0]!,
      state: 'ended',
      revision: family.coverages[0]!.revision + 1,
      updatedAt: NOW - 1_000,
    };
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    installFamilyReads(family, profile());
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-primary-with-minor'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('blocks an active additional responsible until the primary revokes the assignment', async () => {
    const module = await loadHandlerModule();
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-1',
      minorIds: ['minor-1'],
      additionalResponsibleSeat: 1,
      additionalId: 'adult-1',
      additionalScope: ['minor-1'],
    });
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    installFamilyReads(family, profile());
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-active-additional'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows an additional responsible after revocation and fences the released family state', async () => {
    const module = await loadHandlerModule();
    const activeFamily = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-1',
      minorIds: ['minor-1'],
      additionalResponsibleSeat: 1,
      additionalId: 'adult-1',
      additionalScope: ['minor-1'],
    });
    const family: FamilyV2Fixture = {
      ...activeFamily,
      household: {
        ...activeFamily.household,
        revision: activeFamily.household.revision + 1,
      },
      seats: activeFamily.seats.map((seat) =>
        seat.seatType === 'additional_responsible'
          ? {
              ...seat,
              state: 'empty',
              accountId: null,
              assignedAt: null,
              revision: seat.revision + 1,
              updatedAt: NOW - 1_000,
            }
          : seat,
      ),
      supervisionLinks: activeFamily.supervisionLinks.map((link) =>
        link.adultId === 'adult-1'
          ? {
              ...link,
              state: 'revoked',
              validUntil: NOW - 1_000,
              revision: link.revision + 1,
              updatedAt: NOW - 1_000,
            }
          : link,
      ),
      coverages: activeFamily.coverages.map((coverage) =>
        coverage.accountId === 'adult-1'
          ? {
              ...coverage,
              state: 'ended',
              revision: coverage.revision + 1,
              updatedAt: NOW - 1_000,
            }
          : coverage,
      ),
    };
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    installFamilyReads(family, profile());
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      module!.requestAccountClosure(deps, 'adult-1', 'request-revoked-additional'),
    ).resolves.toEqual({ closureId: 'closure-1', state: 'requested' });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: FK.familyCoverage('adult-1'),
          ConditionExpression: expect.stringContaining('#state = :state'),
          ExpressionAttributeValues: expect.objectContaining({ ':state': 'ended' }),
        }),
      }),
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: FK.additionalSeat(family.household.householdId),
          ConditionExpression: expect.stringContaining('accountId = :expectedAccountId'),
        }),
      }),
    ]));
    expect(enqueue).toHaveBeenCalledWith({ sub: 'adult-1', closureId: 'closure-1' });
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
      ':familyCleanupVersion': 1,
      ':checkpoint': { phase: 'familyMembership' },
    });
    expect(transaction.TransactItems?.[1]?.Put).toMatchObject({
      TableName: 'roadmap-access-audit-dev',
      Item: {
        targetKind: 'USER',
        targetId: 'adult-1',
        timestamp: NOW,
        requestId: 'closure-1-purging-2',
        action: 'account_closure.purging',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
    expect(enqueue).toHaveBeenCalledWith({ sub: 'adult-1', closureId: 'closure-1' });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('atomically releases a v2 minor seat, coverage and supervision before legacy purge', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'adult-1',
      minorIds: ['minor-1'],
      additionalResponsibleSeat: 1,
      additionalId: 'adult-2',
      additionalScope: ['minor-1'],
    });
    const oldLink = createSupervisionLink({
      householdId: family.household.householdId,
      adultId: 'adult-old',
      minorId: 'minor-1',
      role: 'additional_responsible',
      now: NOW - 10_000,
    });
    family.supervisionLinks.push({
      ...oldLink,
      state: 'revoked',
      revision: 2,
      validUntil: NOW - 6_000,
      updatedAt: NOW - 6_000,
    });
    const purging = closureItem({
      pk: accountClosureKey('minor-1').pk,
      kind: 'guardian_minor',
      actorSub: 'adult-1',
      sub: 'minor-1',
      username: 'minor-1',
      state: 'purging',
      revision: 2,
      familyCleanupVersion: 1,
      checkpoint: { phase: 'familyMembership' },
    });
    const leased = {
      ...purging,
      revision: 3,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const deps = closureDeps();
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === accountClosureKey('minor-1').pk && key.sk === 'STATE') {
        return { Item: purging };
      }
      const coverage = family.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
      return coverage ? { Item: coverage } : {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
      const pk = values?.[':pk'];
      const prefix = values?.[':prefix'] ?? '';
      if (pk === family.household.pk) return { Items: [family.household, ...family.seats] };
      return {
        Items: family.supervisionLinks.filter(
          (item) => item.pk === pk && item.sk.startsWith(prefix),
        ),
      };
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'roadmap-dev': family.coverages } });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      processMessage(deps, { sub: 'minor-1', closureId: 'closure-1' }),
    ).resolves.toBe('pending');

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.household(family.household.householdId),
          UpdateExpression: expect.stringContaining('revision = :nextRevision'),
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.minorSeat(family.household.householdId, 1),
          UpdateExpression: expect.stringContaining('#state = :empty'),
        }),
      }),
      expect.objectContaining({
        Delete: expect.objectContaining({ Key: FK.familyCoverage('minor-1') }),
      }),
      expect.objectContaining({
        Delete: expect.objectContaining({
          Key: FK.supervision('minor-1', 'adult-1'),
          ConditionExpression: expect.stringContaining('revision = :revision'),
        }),
      }),
      expect.objectContaining({
        Delete: expect.objectContaining({
          Key: FK.supervision('minor-1', 'adult-2'),
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.additionalSeat(family.household.householdId),
          UpdateExpression: expect.stringContaining('#state = :empty'),
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.familyCoverage('adult-2'),
          UpdateExpression: expect.stringContaining('#state = :ended'),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'roadmap-access-audit-dev',
          Item: expect.objectContaining({ action: 'account_closure.family_detached' }),
        }),
      }),
    ]));
    expect(items.some((item) =>
      item.Delete?.Key?.['pk'] === FK.supervision('minor-1', 'adult-old').pk &&
      item.Delete.Key['sk'] === FK.supervision('minor-1', 'adult-old').sk
    )).toBe(false);
    expect(ddbMock.commandCalls(UpdateCommand)[1].args[0].input
      .ExpressionAttributeValues?.[':checkpoint']).toEqual({
        phase: 'familySupervisionLinks',
      });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('closes an owned empty Household with exact seat fences before account purge', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    const family = familyV2Fixture({ now: NOW, primaryId: 'adult-1' });
    const purging = closureItem({
      state: 'purging',
      revision: 3,
      familyCleanupVersion: 1,
      checkpoint: { phase: 'ownedHousehold' },
    });
    const deps = closureDeps();
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === accountClosureKey('adult-1').pk && key.sk === 'STATE') {
        return { Item: purging };
      }
      const coverage = family.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
      return coverage ? { Item: coverage } : {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
      const pk = values?.[':pk'];
      if (input.IndexName === 'gsi1') return { Items: [] };
      if (pk === family.household.pk) return { Items: [family.household, ...family.seats] };
      return { Items: [] };
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'roadmap-dev': family.coverages } });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1
        ? {
            Attributes: {
              ...purging,
              revision: 4,
              leaseOwner: 'worker-1',
              leaseUntil: NOW + 60_000,
            },
          }
        : {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items.find((item) => item.Update?.Key?.['sk'] === 'META')?.Update).toMatchObject({
      Key: FK.household(family.household.householdId),
      UpdateExpression: expect.stringContaining('#state = :closed'),
      ExpressionAttributeValues: expect.objectContaining({ ':closed': 'closed' }),
    });
    expect(items.filter((item) => item.ConditionCheck?.Key?.['sk']?.startsWith('SEAT#')))
      .toHaveLength(3);
    expect(items.find((item) =>
      item.ConditionCheck?.Key?.['pk'] === FK.familyEntitlement(family.household.householdId).pk &&
      item.ConditionCheck.Key['sk'] === FK.familyEntitlement(family.household.householdId).sk
    )?.ConditionCheck?.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
    expect(items.find((item) => item.Put?.TableName === 'roadmap-access-audit-dev')?.Put)
      .toMatchObject({ Item: expect.objectContaining({ action: 'account_closure.household_closed' }) });
    expect(ddbMock.commandCalls(UpdateCommand)[1].args[0].input
      .ExpressionAttributeValues?.[':checkpoint']).toEqual({ phase: 'ownedHousehold' });
  });

  it('deletes a revoked v2 supervision link exactly and resumes the gsi sweep', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-1',
      minorIds: ['minor-1'],
      additionalResponsibleSeat: 1,
      additionalId: 'adult-1',
      additionalScope: ['minor-1'],
    });
    const revoked = {
      ...family.supervisionLinks.find((item) => item.adultId === 'adult-1')!,
      state: 'revoked' as const,
      validUntil: NOW - 1_000,
      revision: 2,
      updatedAt: NOW - 1_000,
    };
    const purging = closureItem({
      state: 'purging',
      revision: 4,
      familyCleanupVersion: 1,
      checkpoint: { phase: 'familySupervisionLinks' },
    });
    const deps = closureDeps();
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
    ddbMock.on(QueryCommand).resolves({ Items: [revoked] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Delete: expect.objectContaining({
          Key: FK.supervision('minor-1', 'adult-1'),
          ConditionExpression: expect.stringContaining('linkId = :linkId'),
        }),
      }),
    ]));
    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      IndexName: 'gsi1',
      Limit: 1,
      ExpressionAttributeValues: { ':pk': K.user('adult-1'), ':prefix': 'SUPERVISION#' },
    });
    expect(ddbMock.commandCalls(UpdateCommand)[1].args[0].input
      .ExpressionAttributeValues?.[':checkpoint']).toEqual({
        phase: 'familySupervisionLinks',
        quietPasses: 0,
      });
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
        linkId: 'adult-1~minor-2',
        kind: 'invited',
        guardianId: 'adult-1',
        minorId: 'minor-2',
        createdAt: NOW - 1_000,
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
    if (fixture.phase === 'guardianLinks') {
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
      const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(transaction.TransactItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ConditionCheck: expect.objectContaining({
              Key: { pk: 'ACCOUNT_CLOSURE#adult-1', sk: 'STATE' },
            }),
          }),
          expect.objectContaining({
            Delete: expect.objectContaining({
              Key: { pk: fixture.item.pk, sk: fixture.item.sk },
              ConditionExpression: expect.stringContaining('linkId = :linkId'),
            }),
          }),
        ]),
      );
    } else {
      const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
      expect(batch.RequestItems?.['roadmap-dev']).toEqual([
        { DeleteRequest: { Key: { pk: fixture.item.pk, sk: fixture.item.sk } } },
      ]);
    }
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: fixture.phase,
      quietPasses: 0,
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('treats a legacy closure kind as self-adult and blocks on an outgoing created link', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const purging = closureItem({
      state: 'purging',
      revision: 4,
      checkpoint: { phase: 'guardianLinks' },
    });
    const leased = {
      ...purging,
      revision: 5,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const created = {
      pk: 'USER#minor-2',
      sk: 'GUARDIAN#adult-1',
      gsi1pk: 'USER#adult-1',
      gsi1sk: 'MINOR#minor-2',
      linkId: 'adult-1~minor-2',
      kind: 'created',
      guardianId: 'adult-1',
      minorId: 'minor-2',
      createdAt: NOW - 1_000,
    };
    ddbMock.on(GetCommand).resolves({ Item: purging });
    ddbMock.on(UpdateCommand).resolves({ Attributes: leased });
    ddbMock.on(QueryCommand).resolves({ Items: [created] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems?.find((item) => item.Update)?.Update)
      .toMatchObject({
        Key: accountClosureKey('adult-1'),
        ExpressionAttributeValues: expect.objectContaining({ ':nextState': 'blocked' }),
      });
    expect(transaction.TransactItems?.some((item) => item.Delete)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
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

  it('also deletes the one-use minor-code mirror when purging a supervised account', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    const purging = closureItem({
      pk: accountClosureKey('minor-1').pk,
      kind: 'guardian_minor',
      actorSub: 'adult-1',
      sub: 'minor-1',
      username: 'minor-1',
      friendCode: 'CDFGHJKM',
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

    await processMessage(deps, { sub: 'minor-1', closureId: 'closure-1' });

    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: K.uniqUsername('minor-1') } },
      { DeleteRequest: { Key: K.codeF('CDFGHJKM') } },
      { DeleteRequest: { Key: SK.minorInviteCode('CDFGHJKM') } },
    ]);
  });

  it('does not stall minor closure on a legacy friend code outside the new alphabet', async () => {
    const module = await loadClosureModule();
    const processMessage = module?.['processAccountClosureMessage'];
    expect(processMessage).toBeTypeOf('function');
    const deps = closureDeps();
    const purging = closureItem({
      pk: accountClosureKey('minor-legacy').pk,
      kind: 'guardian_minor',
      actorSub: 'adult-1',
      sub: 'minor-legacy',
      username: 'minor-legacy',
      friendCode: 'FRIEND12',
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

    await expect(
      processMessage(deps, { sub: 'minor-legacy', closureId: 'closure-1' }),
    ).resolves.toBe('pending');

    const batch = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    expect(batch.RequestItems?.['roadmap-dev']).toEqual([
      { DeleteRequest: { Key: K.uniqUsername('minor-legacy') } },
      { DeleteRequest: { Key: K.codeF('FRIEND12') } },
    ]);
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
        targetKind: 'USER',
        targetId: 'adult-1',
        timestamp: NOW,
        requestId: 'closure-1-purgeComplete-12',
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
        targetKind: 'USER',
        targetId: 'adult-1',
        timestamp: NOW,
        requestId: 'closure-1-completed-13',
        action: 'account_closure.completed',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reopens a legacy purgeComplete closure for Household v2 cleanup before deleting Cognito', async () => {
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
          familyCleanupVersion: undefined,
        }),
      };
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      order.push('reopen');
      return {};
    });

    await expect(
      processMessage(deps, { sub: 'adult-1', closureId: 'closure-1' }),
    ).resolves.toBe('pending');

    expect(order).toEqual(['get', 'reopen', 'enqueue']);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems?.[0]?.Update).toMatchObject({
      Key: { pk: 'ACCOUNT_CLOSURE#adult-1', sk: 'STATE' },
      ConditionExpression: expect.stringContaining('attribute_not_exists(familyCleanupVersion)'),
      ExpressionAttributeValues: {
        ':closureId': 'closure-1',
        ':expectedRevision': 12,
        ':expectedState': 'purgeComplete',
        ':nextState': 'purging',
        ':nextRevision': 13,
        ':now': NOW,
        ':checkpoint': { phase: 'familyMembership' },
        ':familyCleanupVersion': 1,
      },
    });
    expect(transaction.TransactItems?.[0]?.Update?.UpdateExpression).toContain(
      'REMOVE purgeCompleteAt, leaseOwner, leaseUntil',
    );
    expect(transaction.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        targetKind: 'USER',
        targetId: 'adult-1',
        timestamp: NOW,
        requestId: 'closure-1-familyCleanup-13',
        action: 'account_closure.family_cleanup_reopened',
        actor: 'system:account-closure-worker',
        subject: 'adult-1',
      },
    });
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
              sub: 'adult-legacy-complete',
              closureId: 'closure-legacy-complete',
              state: 'purgeComplete',
              familyCleanupVersion: undefined,
              nextAttemptAt: NOW,
            }),
            closureItem({
              sub: 'adult-corrupt',
              closureId: 'closure-corrupt',
              state: 'unknown-state',
              nextAttemptAt: NOW,
            }),
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
      [{ sub: 'adult-legacy-complete', closureId: 'closure-legacy-complete' }],
      [{ sub: 'adult-due-2', closureId: 'closure-due-2' }],
    ]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('does not enqueue a blocked closure still visible through an eventually consistent GSI', async () => {
    const module = await loadReconcilerModule();
    const reconcile = module?.['reconcileOpenAccountClosures'];
    expect(reconcile).toBeTypeOf('function');
    const enqueue = vi.fn(async () => undefined);
    const deps = { ...baseDeps(), queue: { enqueue } };
    ddbMock.on(QueryCommand).resolves({
      Items: [
        closureItem({
          state: 'blocked',
          blockReason: 'created_family_link',
          nextAttemptAt: NOW - 1,
        }),
      ],
    });

    await reconcile(deps);

    expect(enqueue).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
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
    expect(capture).toContain('invocation.succeeded');
    expect(capture).not.toContain('InvocationSucceeded');
    expect(capture).not.toContain('CloudWatchMetrics');
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
    expect(capture).toContain('invocation.succeeded');
    expect(capture).not.toContain('InvocationSucceeded');
    expect(capture).not.toContain('CloudWatchMetrics');
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
