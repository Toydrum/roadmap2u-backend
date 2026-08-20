import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { AuditWriter } from '../lambda/commercial/audit';
import type { Ctx } from '../lambda/authz';
import { K, type CodeItem, type Deps, type LinkItem, type ProfileItem } from '../lambda/db';
import {
  processAccountClosureMessage,
  type AccountClosureItem,
} from '../lambda/account-closure';
import * as closureHandler from '../lambda/account-closure-handler';
import {
  createFamilyInvite,
  deleteChild,
  resetChildPassword,
  revokeFamilyInvite,
} from '../lambda/handlers/family';
import { getMe } from '../lambda/handlers/me';
import { exactCodeOperation, sameCode } from '../lambda/handlers/guarded-mutation';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function requestGuardianMinorClosure(...args: unknown[]): Promise<unknown> {
  const request = (closureHandler as Record<string, unknown>)['requestGuardianMinorClosure'];
  expect(request, 'guardian-minor closure requester should exist').toBeTypeOf('function');
  return (request as (...values: unknown[]) => Promise<unknown>)(...args);
}

function profile(
  userId: string,
  accountType: ProfileItem['accountType'],
  overrides: Partial<ProfileItem> = {},
): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId,
    displayName: userId,
    accountType,
    socialEnabled: true,
    createdAt: NOW - 10_000,
    status: 'active',
    ...overrides,
  };
}

function createdLink(guardianId = 'guardian-1', minorId = 'minor-1'): LinkItem {
  return {
    ...K.link(minorId, guardianId),
    gsi1pk: K.user(guardianId),
    gsi1sk: `MINOR#${minorId}`,
    linkId: `${guardianId}~${minorId}`,
    kind: 'created',
    guardianId,
    minorId,
    createdAt: NOW - 5_000,
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

function closureDeps(enqueue = vi.fn(async () => undefined)) {
  const base = baseDeps();
  return {
    ...base,
    auditWriter: new AuditWriter({
      ddb: base.ddb,
      tableName: 'roadmap-access-audit-dev',
    }),
    queue: { enqueue },
    nextClosureId: () => 'minor-closure-1',
    nextWorkerId: () => 'worker-1',
  };
}

function ctxOf(caller = profile('guardian-1', 'adult')): Ctx {
  return { callerId: caller.userId, caller, deps: baseDeps() };
}

function guardianClosure(overrides: Partial<AccountClosureItem> = {}): AccountClosureItem {
  return {
    pk: 'ACCOUNT_CLOSURE#minor-1',
    sk: 'STATE',
    closureId: 'minor-closure-1',
    kind: 'guardian_minor',
    actorSub: 'guardian-1',
    sub: 'minor-1',
    username: 'minor-1',
    state: 'requested',
    revision: 1,
    requestedAt: NOW,
    updatedAt: NOW,
    nextAttemptAt: NOW,
    gsi1pk: 'ACCOUNT_CLOSURE#OPEN',
    gsi1sk: `NEXT#${NOW}#minor-1`,
    checkpoint: { phase: 'friendMirrors' },
    ...overrides,
  };
}

describe('guardian-owned minor closure request', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('atomically snapshots the guardian actor, closes the minor, verifies the exact created link and audits before enqueue', async () => {
    const guardian = profile('guardian-1', 'adult', {
      familyFenceVersion: 1,
      createdMinorIds: new Set(['minor-1']),
    });
    const minor = profile('minor-1', 'minor', { friendCode: 'MINORCODE' });
    const link = createdLink();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const order: string[] = [];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') return {};
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'ACCOUNT_CLOSURE#guardian-1') return {};
      return {};
    });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      order.push('transact');
      return {};
    });
    enqueue.mockImplementation(async () => {
      order.push('enqueue');
    });

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).resolves.toEqual({ closureId: 'minor-closure-1', state: 'requested' });

    expect(order).toEqual(['transact', 'enqueue']);
    expect(enqueue).toHaveBeenCalledWith({ sub: 'minor-1', closureId: 'minor-closure-1' });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(6);

    const closurePut = items.find((item) => item.Put?.TableName === 'roadmap-dev')?.Put;
    expect(closurePut).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        pk: 'ACCOUNT_CLOSURE#minor-1',
        sk: 'STATE',
        closureId: 'minor-closure-1',
        kind: 'guardian_minor',
        actorSub: 'guardian-1',
        sub: 'minor-1',
        username: 'minor-1',
        friendCode: 'MINORCODE',
        state: 'requested',
      },
    });
    expect(closurePut?.Item).not.toHaveProperty('displayName');

    const minorUpdate = items.find((item) => item.Update)?.Update;
    expect(minorUpdate?.Key).toEqual(K.profile('minor-1'));
    expect(minorUpdate?.UpdateExpression).toBe('SET #status = :closing');
    expect(minorUpdate?.ConditionExpression).toContain('accountType = :minor');
    expect(minorUpdate?.ConditionExpression).toContain('username = :username');
    expect(minorUpdate?.ConditionExpression).toContain('identityLeaseUntil < :now');

    const checks = items.flatMap((item) => (item.ConditionCheck ? [item.ConditionCheck] : []));
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: K.profile('guardian-1'),
          ConditionExpression: expect.stringContaining('familyFenceVersion = :familyFenceVersion'),
          ExpressionAttributeValues: expect.objectContaining({
            ':familyFenceVersion': 1,
            ':minorSub': 'minor-1',
          }),
        }),
        expect.objectContaining({
          Key: { pk: 'ACCOUNT_CLOSURE#guardian-1', sk: 'STATE' },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
        expect.objectContaining({
          Key: K.link('minor-1', 'guardian-1'),
          ConditionExpression: expect.stringContaining('kind = :created'),
          ExpressionAttributeValues: expect.objectContaining({
            ':created': 'created',
            ':guardianId': 'guardian-1',
            ':minorId': 'minor-1',
            ':linkId': 'guardian-1~minor-1',
            ':createdAt': link.createdAt,
          }),
        }),
      ]),
    );

    const audit = items.find((item) => item.Put?.TableName === 'roadmap-access-audit-dev')?.Put;
    expect(audit).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        targetKind: 'USER',
        targetId: 'minor-1',
        requestId: 'minor-closure-1-requested',
        action: 'account_closure.requested',
        actor: 'user:guardian-1',
        subject: 'minor-1',
        details: expect.objectContaining({
          closureId: 'minor-closure-1',
          kind: 'guardian_minor',
          actorSub: 'guardian-1',
        }),
      },
    });
  });

  it('rejects a version-1 guardian whose authoritative set does not contain the minor', async () => {
    const guardian = profile('guardian-1', 'adult', {
      familyFenceVersion: 1,
      createdMinorIds: new Set(['other-minor']),
    });
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') return {};
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'ACCOUNT_CLOSURE#guardian-1') return {};
      return {};
    });

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns the same receipt for a duplicate request from the same guardian even after purge starts', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: guardianClosure({ state: 'purging', revision: 4 }),
    });

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).resolves.toEqual({ closureId: 'minor-closure-1', state: 'purging' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not treat a closure created by another actor or kind as an authorized retry', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    ddbMock.on(GetCommand).resolves({
      Item: guardianClosure({ actorSub: 'other-guardian' }),
    });

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('maps a transaction lost to an active identity lease to a retryable conflict without creating a closure', async () => {
    const guardian = profile('guardian-1', 'adult');
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const deps = closureDeps();
    let closureReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') {
        closureReads += 1;
        return {};
      }
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'ACCOUNT_CLOSURE#guardian-1') return {};
      return {};
    });
    const lost = new Error('identity reset holds the lease');
    lost.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteCommand).rejects(lost);

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(closureReads).toBe(2);
  });

  it('returns the winning receipt when two identical guardian requests race', async () => {
    const guardian = profile('guardian-1', 'adult');
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    let targetClosureReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') {
        targetClosureReads += 1;
        return targetClosureReads === 1
          ? {}
          : { Item: guardianClosure({ closureId: 'winning-closure' }) };
      }
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      return {};
    });
    const lost = new Error('another identical request won');
    lost.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteCommand).rejects(lost);

    await expect(
      requestGuardianMinorClosure(deps, 'guardian-1', 'minor-1'),
    ).resolves.toEqual({ closureId: 'winning-closure', state: 'requested' });
    expect(enqueue).toHaveBeenCalledWith({ sub: 'minor-1', closureId: 'winning-closure' });
  });
});

describe('family delegates child deletion to the durable closure', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('keeps the existing void/204 handler contract and never deletes Cognito or batches records inline', async () => {
    const guardian = profile('guardian-1', 'adult');
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const ctx: Ctx = { callerId: guardian.userId, caller: guardian, deps };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') return {};
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'ACCOUNT_CLOSURE#guardian-1') return {};
      return {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    await expect(deleteChild(ctx, 'minor-1', deps)).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledWith({ sub: 'minor-1', closureId: 'minor-closure-1' });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe('guardian-minor closure worker coverage', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('creates issuer and minor mirrors for every new co-guardian invite', async () => {
    const guardian = profile('guardian-1', 'adult');
    const link = createdLink();
    const ctx = ctxOf(guardian);
    ddbMock.on(GetCommand).resolves({ Item: link });
    ddbMock.on(QueryCommand).resolves({ Items: [link] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await createFamilyInvite(ctx, { kind: 'coGuardian', minorId: 'minor-1' });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const codePut = items.find((item) => item.Put?.Item?.kind === 'coGuardian')?.Put;
    const code = codePut?.Item?.code as string;
    expect(codePut?.Item).toMatchObject({
      minorId: 'minor-1',
      closureMirrorVersion: 1,
    });
    expect(items.map((item) => item.Put?.Item).filter(Boolean)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pk: K.user('guardian-1'),
          sk: `GINVITE#${code}`,
          code,
          userId: 'guardian-1',
          minorId: 'minor-1',
          closureMirrorVersion: 1,
        }),
        expect.objectContaining({
          pk: K.user('minor-1'),
          sk: `GINVITE#${code}`,
          code,
          userId: 'guardian-1',
          minorId: 'minor-1',
          closureMirrorVersion: 1,
        }),
      ]),
    );
  });

  it('protects the mirror marker from being stripped in an accept/revoke race', () => {
    const mirrored: CodeItem = {
      ...K.codeG('JOINCODE'),
      code: 'JOINCODE',
      kind: 'coGuardian',
      userId: 'guardian-1',
      minorId: 'minor-1',
      closureMirrorVersion: 1,
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1_000),
    };
    const operation = exactCodeOperation(baseDeps(), mirrored, 'delete').Delete;

    expect(operation?.ConditionExpression).toContain(
      '#closureMirrorVersion = :closureMirrorVersion',
    );
    expect(operation?.ExpressionAttributeValues).toMatchObject({
      ':closureMirrorVersion': 1,
    });
    expect(sameCode(mirrored, { ...mirrored, closureMirrorVersion: undefined })).toBe(false);
  });

  it('revokes the primary code and every closure mirror in one transaction', async () => {
    const guardian = profile('guardian-1', 'adult');
    const ctx = ctxOf(guardian);
    const invite: CodeItem = {
      ...K.codeG('JOINCODE'),
      code: 'JOINCODE',
      kind: 'coGuardian',
      userId: 'guardian-1',
      minorId: 'minor-1',
      closureMirrorVersion: 1,
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1_000),
    };
    ddbMock.on(GetCommand).resolves({ Item: invite });
    ddbMock.on(TransactWriteCommand).resolves({});

    await revokeFamilyInvite(ctx, 'JOINCODE');

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items.map((item) => item.Delete?.Key)).toEqual(
      expect.arrayContaining([
        K.codeG('JOINCODE'),
        { pk: K.user('guardian-1'), sk: 'GINVITE#JOINCODE' },
        { pk: K.user('minor-1'), sk: 'GINVITE#JOINCODE' },
      ]),
    );
  });

  it('purges indexed co-guardian invite mirrors through the existing resumable worker', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'guardianInvites' },
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const inviteMirror = {
      pk: K.user('minor-1'),
      sk: 'GINVITE#JOINCODE',
      subjectId: 'minor-1',
      code: 'JOINCODE',
      kind: 'coGuardian',
      userId: 'guardian-1',
      minorId: 'minor-1',
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1000),
      closureMirrorVersion: 1 as const,
    };
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [inviteMirror] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      processAccountClosureMessage(deps, { sub: 'minor-1', closureId: 'minor-closure-1' }),
    ).resolves.toBe('pending');

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      TableName: 'roadmap-dev',
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ':pk': K.user('minor-1'),
        ':prefix': 'GINVITE#',
      },
    });
    expect(query.IndexName).toBeUndefined();
    const purge = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(purge.map((item) => item.Delete?.Key)).toEqual(
      expect.arrayContaining([
        K.codeG('JOINCODE'),
        { pk: K.user('guardian-1'), sk: 'GINVITE#JOINCODE' },
        { pk: K.user('minor-1'), sk: 'GINVITE#JOINCODE' },
      ]),
    );
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledWith({ sub: 'minor-1', closureId: 'minor-closure-1' });
  });

  it('lets a self-adult closure discover its issued invite and delete the target minor mirror too', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const closure = guardianClosure({
      pk: 'ACCOUNT_CLOSURE#guardian-1',
      kind: 'self_adult',
      actorSub: 'guardian-1',
      sub: 'guardian-1',
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'guardianInvites' },
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const issuerMirror = {
      pk: K.user('guardian-1'),
      sk: 'GINVITE#JOINCODE',
      subjectId: 'guardian-1',
      code: 'JOINCODE',
      kind: 'coGuardian',
      userId: 'guardian-1',
      minorId: 'minor-1',
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1000),
      closureMirrorVersion: 1 as const,
    };
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [issuerMirror] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processAccountClosureMessage(deps, {
      sub: 'guardian-1',
      closureId: 'minor-closure-1',
    });

    const purge = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(purge.map((item) => item.Delete?.Key)).toEqual(
      expect.arrayContaining([
        K.codeG('JOINCODE'),
        { pk: K.user('guardian-1'), sk: 'GINVITE#JOINCODE' },
        { pk: K.user('minor-1'), sk: 'GINVITE#JOINCODE' },
      ]),
    );
  });

  it('fails closed on a forged invite mirror instead of deleting keys named by its payload', async () => {
    const deps = closureDeps();
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'guardianInvites' },
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    ddbMock.on(GetCommand).resolves({ Item: closure });
    ddbMock.on(UpdateCommand).resolves({ Attributes: leased });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: K.user('minor-1'),
          sk: 'GINVITE#JOINCODE',
          subjectId: 'victim-not-in-this-partition',
          code: 'JOINCODE',
          kind: 'coGuardian',
          userId: 'guardian-1',
          minorId: 'minor-1',
          expiresAt: NOW + 60_000,
          ttl: Math.ceil((NOW + 60_000) / 1000),
          closureMirrorVersion: 1,
        },
      ],
    });

    await expect(
      processAccountClosureMessage(deps, { sub: 'minor-1', closureId: 'minor-closure-1' }),
    ).rejects.toThrow('invalid guardian invite mirror');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('packs a full 25-invite page into at most 100 transactional deletes', async () => {
    const deps = closureDeps();
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'guardianInvites' },
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const mirrors = Array.from({ length: 25 }, (_, index) => {
      const code = `CODE${String(index).padStart(4, '0')}`;
      return {
        pk: K.user('minor-1'),
        sk: `GINVITE#${code}`,
        subjectId: 'minor-1',
        code,
        kind: 'coGuardian' as const,
        userId: 'guardian-1',
        minorId: 'minor-1',
        expiresAt: NOW + 60_000,
        ttl: Math.ceil((NOW + 60_000) / 1000),
        closureMirrorVersion: 1 as const,
      };
    });
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: mirrors });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processAccountClosureMessage(deps, {
      sub: 'minor-1',
      closureId: 'minor-closure-1',
    });

    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(25);
    const deletes = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(deletes).toHaveLength(75);
    expect(deletes.length).toBeLessThanOrEqual(100);
  });

  it('removes an inbound created link and the guardian fence in one leased exact transaction', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'inboundGuardianLinks' } as never,
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const link = createdLink();
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [link] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processAccountClosureMessage(deps, {
      sub: 'minor-1',
      closureId: 'minor-closure-1',
    });

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      ConsistentRead: true,
      Limit: 1,
      ExpressionAttributeValues: {
        ':pk': K.user('minor-1'),
        ':prefix': 'GUARDIAN#',
      },
    });
    expect(query.IndexName).toBeUndefined();
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { pk: 'ACCOUNT_CLOSURE#minor-1', sk: 'STATE' },
            ConditionExpression: expect.stringContaining('leaseOwner = :leaseOwner'),
          }),
        }),
        expect.objectContaining({
          Delete: expect.objectContaining({
            Key: K.link('minor-1', 'guardian-1'),
            ConditionExpression: expect.stringContaining('linkId = :linkId'),
          }),
        }),
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: K.profile('guardian-1'),
            UpdateExpression: 'DELETE createdMinorIds :createdMinorIds',
            ConditionExpression: expect.stringContaining(
              'familyFenceVersion = :familyFenceVersion AND contains(createdMinorIds, :minorId)',
            ),
            ExpressionAttributeValues: expect.objectContaining({
              ':createdMinorIds': new Set(['minor-1']),
              ':minorId': 'minor-1',
            }),
          }),
        }),
      ]),
    );
    expect(enqueue).toHaveBeenCalledWith({ sub: 'minor-1', closureId: 'minor-closure-1' });
  });

  it('re-reads an empty inbound-link phase on retry before advancing the checkpoint', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'inboundGuardianLinks' } as never,
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await processAccountClosureMessage(deps, {
      sub: 'minor-1',
      closureId: 'minor-closure-1',
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: 'friendMirrors',
    });
  });

  it('durably blocks a self-adult closure that discovers a created link', async () => {
    const enqueue = vi.fn(async () => undefined);
    const deps = closureDeps(enqueue);
    const closure = guardianClosure({
      pk: 'ACCOUNT_CLOSURE#adult-1',
      closureId: 'adult-closure-1',
      kind: 'self_adult',
      actorSub: 'adult-1',
      sub: 'adult-1',
      username: 'adult-1',
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'inboundGuardianLinks' } as never,
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    const drift = createdLink('guardian-1', 'adult-1');
    ddbMock.on(GetCommand).resolves({ Item: closure });
    ddbMock.on(UpdateCommand).resolves({ Attributes: leased });
    ddbMock.on(QueryCommand).resolves({ Items: [drift] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processAccountClosureMessage(deps, {
      sub: 'adult-1',
      closureId: 'adult-closure-1',
    });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const blocked = items.find((item) => item.Update)?.Update;
    expect(blocked).toMatchObject({
      Key: { pk: 'ACCOUNT_CLOSURE#adult-1', sk: 'STATE' },
      ConditionExpression: expect.stringContaining('leaseOwner = :leaseOwner'),
      ExpressionAttributeValues: expect.objectContaining({ ':nextState': 'blocked' }),
    });
    expect(blocked?.UpdateExpression).toContain('REMOVE gsi1pk, gsi1sk, nextAttemptAt');
    expect(items.some((item) => item.Delete)).toBe(false);
    expect(items.find((item) => item.ConditionCheck)?.ConditionCheck?.Key).toEqual(
      K.link('adult-1', 'guardian-1'),
    );
    expect(items.find((item) => item.Put?.TableName === 'roadmap-access-audit-dev')?.Put?.Item)
      .toMatchObject({
        action: 'account_closure.blocked',
        details: expect.objectContaining({ reason: 'created_family_link' }),
      });
    expect(enqueue).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('routes a GUARDIAN record found during generic purge back through the exact leased path', async () => {
    const deps = closureDeps();
    const closure = guardianClosure({
      state: 'purging',
      revision: 8,
      checkpoint: { phase: 'userPartition' },
    });
    const leased = {
      ...closure,
      revision: 9,
      leaseOwner: 'worker-1',
      leaseUntil: NOW + 60_000,
    };
    ddbMock.on(GetCommand).resolves({ Item: closure });
    let updates = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updates += 1;
      return updates === 1 ? { Attributes: leased } : {};
    });
    let queries = 0;
    ddbMock.on(QueryCommand).callsFake(() => {
      queries += 1;
      return { Items: [createdLink(), { ...K.profile('minor-1'), userId: 'minor-1' }] };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await processAccountClosureMessage(deps, {
      sub: 'minor-1',
      closureId: 'minor-closure-1',
    });

    expect(queries).toBe(2);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    const exact = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(exact.find((item) => item.Delete)?.Delete?.Key).toEqual(
      K.link('minor-1', 'guardian-1'),
    );
    expect(exact.find((item) => item.Update)?.Update?.Key).toEqual(K.profile('guardian-1'));
    const checkpoint = ddbMock.commandCalls(UpdateCommand)[1].args[0].input;
    expect(checkpoint.ExpressionAttributeValues?.[':checkpoint']).toEqual({
      phase: 'inboundGuardianLinks',
    });
  });

  it('never swallows a transient Cognito delete failure for guardian-minor closures', async () => {
    const deps = closureDeps();
    ddbMock.on(GetCommand).resolves({
      Item: guardianClosure({ state: 'purgeComplete', revision: 12, checkpoint: undefined }),
    });
    const throttled = new Error('retry');
    throttled.name = 'TooManyRequestsException';
    cognitoMock.on(AdminDeleteUserCommand).rejects(throttled);

    await expect(
      processAccountClosureMessage(deps, { sub: 'minor-1', closureId: 'minor-closure-1' }),
    ).rejects.toBe(throttled);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('closure races and family listings', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('claims a bounded identity lease before resetting a minor password', async () => {
    const guardian = profile('guardian-1', 'adult');
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const ctx = ctxOf(guardian);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      return {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    await resetChildPassword(ctx, 'minor-1', () => 'identity-lease-1');

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    const lease = items.find((item) => item.Update)?.Update;
    expect(lease).toMatchObject({
      Key: K.profile('minor-1'),
      UpdateExpression: expect.stringContaining('identityLeaseOwner = :identityLeaseOwner'),
      ConditionExpression: expect.stringContaining('identityLeaseUntil < :now'),
      ExpressionAttributeValues: expect.objectContaining({
        ':identityLeaseOwner': 'identity-lease-1',
      }),
    });
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
    const release = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(release).toMatchObject({
      Key: K.profile('minor-1'),
      UpdateExpression: 'REMOVE identityLeaseOwner, identityLeaseUntil',
      ConditionExpression: 'identityLeaseOwner = :identityLeaseOwner',
    });
  });

  it('does not call Cognito when closure wins the password-reset transaction', async () => {
    const guardian = profile('guardian-1', 'adult');
    const minor = profile('minor-1', 'minor');
    const link = createdLink();
    const ctx = ctxOf(guardian);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === K.user('guardian-1') && key.sk === 'PROFILE') return { Item: guardian };
      if (key.pk === K.user('minor-1') && key.sk === 'PROFILE') return { Item: minor };
      if (key.pk === 'ACCOUNT_CLOSURE#minor-1') return { Item: guardianClosure() };
      return {};
    });
    const lost = new Error('closure won');
    lost.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteCommand).rejects(lost);

    await expect(
      resetChildPassword(ctx, 'minor-1', () => 'identity-lease-1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  });

  it('hides a closing minor from the guardian family listing before physical purge', async () => {
    const guardian = profile('guardian-1', 'adult');
    const link = createdLink();
    const ctx = ctxOf(guardian);
    ddbMock.on(QueryCommand).callsFake((input) =>
      input.IndexName === 'gsi1' ? { Items: [link] } : { Items: [] },
    );
    ddbMock.on(GetCommand).resolves({
      Item: profile('minor-1', 'minor', { status: 'closing' }),
    });

    await expect(getMe(ctx)).resolves.toMatchObject({
      family: { guardians: [], minors: [] },
    });
    expect(
      ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.ConsistentRead === true),
    ).toBe(true);
  });
});
