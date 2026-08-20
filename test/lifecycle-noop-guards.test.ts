import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Tree } from '@app/db/schema';
import { accountClosureKey } from '../lambda/account-closure';
import type { Ctx } from '../lambda/authz';
import {
  K,
  type Deps,
  type LinkItem,
  type ProfileItem,
  type RecordItem,
} from '../lambda/db';
import {
  exportChild,
  patchChild,
  resetChildPassword,
} from '../lambda/handlers/family';
import { patchMe } from '../lambda/handlers/me';
import { getSyncChanges, pushSync, pushSyncFor } from '../lambda/handlers/sync';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
}

function profile(userId: string, overrides: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId,
    displayName: userId,
    accountType: 'adult',
    socialEnabled: false,
    createdAt: NOW - 10_000,
    status: 'active',
    ...overrides,
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function createdLink(guardianId = 'rocio', minorId = 'nico'): LinkItem {
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

function treeRecord(ownerId = 'nico', id = 'tree-1'): RecordItem {
  const tree: Tree = {
    id,
    name: 'Mi ruta',
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    archivedAt: null,
    heartId: 'root-1',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 500,
    rev: 1,
    deletedAt: null,
  };
  return {
    ...K.rec(ownerId, 'trees', tree.id),
    gsi2pk: K.user(ownerId),
    gsi2sk: `CHG#${NOW}#${tree.id}`,
    owner: ownerId,
    store: 'trees',
    record: tree,
    rev: tree.rev,
    updatedAt: tree.updatedAt,
    syncedAt: NOW,
  };
}

function transactionCanceled(): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
  });
}

function keyOf(input: { Key?: unknown }): { pk: string; sk: string } {
  return input.Key as { pk: string; sk: string };
}

function mockWritableFamily(
  options: {
    caller?: Partial<ProfileItem>;
    child?: Partial<ProfileItem>;
    callerClosure?: boolean;
    childClosure?: boolean;
  } = {},
): LinkItem {
  const link = createdLink();
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = keyOf(input);
    if (key.pk === K.user('rocio') && key.sk === 'PROFILE') {
      return { Item: profile('rocio', options.caller) };
    }
    if (key.pk === K.user('nico') && key.sk === 'PROFILE') {
      return { Item: profile('nico', { accountType: 'minor', ...options.child }) };
    }
    if (key.pk === accountClosureKey('rocio').pk && key.sk === 'STATE') {
      return options.callerClosure ? { Item: { ...key, state: 'requested' } } : {};
    }
    if (key.pk === accountClosureKey('nico').pk && key.sk === 'STATE') {
      return options.childClosure ? { Item: { ...key, state: 'requested' } } : {};
    }
    if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
    return {};
  });
  return link;
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('lifecycle guards for no-op mutations', () => {
  it('blocks an empty PATCH /me when the strong PROFILE read is closing', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'closing' }) };
      }
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...key, state: 'requested' } };
      }
      return {};
    });

    await expect(patchMe(ctxOf(profile('rocio')), {})).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(
      ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.ConsistentRead === true),
    ).toBe(true);
  });

  it('blocks an empty child PATCH when the caller is closing', async () => {
    mockWritableFamily({ caller: { status: 'closing' }, callerClosure: true });

    await expect(patchChild(ctxOf(profile('rocio')), 'nico', {})).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('blocks an empty child PATCH when the child closure exists', async () => {
    mockWritableFamily({ childClosure: true });

    await expect(patchChild(ctxOf(profile('rocio')), 'nico', {})).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('blocks an empty legacy self push after checking lifecycle strongly', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'closing' }) };
      }
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...key, state: 'requested' } };
      }
      return {};
    });

    await expect(
      pushSync(ctxOf(profile('rocio')), { schemaVersion: 13, records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('blocks an empty legacy guardian push when the child is closing', async () => {
    mockWritableFamily({ child: { status: 'closing' }, childClosure: true });

    await expect(
      pushSyncFor(ctxOf(profile('rocio')), 'nico', { schemaVersion: 13, records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('read and export lifecycle matrix', () => {
  it('keeps GET sync/changes available as a read during closing without commercial gates', async () => {
    const stored = treeRecord('rocio');
    ddbMock.on(QueryCommand).resolves({ Items: [stored] });

    await expect(
      getSyncChanges(ctxOf(profile('rocio', { status: 'closing' })), 'CHG#before'),
    ).resolves.toEqual({
      changes: [{ store: 'trees', record: stored.record }],
      cursor: stored.gsi2sk,
      more: false,
    });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: 'gsi2',
      ExpressionAttributeValues: {
        ':pk': K.user('rocio'),
        ':after': 'CHG#before',
      },
    });
  });

  it('exports for a Free family using strong lifecycle, authority and record reads only', async () => {
    mockWritableFamily();
    const stored = treeRecord();
    ddbMock.on(QueryCommand).resolves({ Items: [stored] });

    await expect(exportChild(ctxOf(profile('rocio')), 'nico')).resolves.toMatchObject({
      app: 'roadmap2u',
      data: { trees: [stored.record] },
    });

    const gets = ddbMock.commandCalls(GetCommand);
    expect(gets.length).toBeGreaterThanOrEqual(5);
    expect(gets.every((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: undefined,
      ConsistentRead: true,
      ExpressionAttributeValues: { ':pk': K.user('nico'), ':prefix': 'REC#' },
    });
    const readKeys = gets.map((call) => keyOf(call.args[0].input));
    expect(readKeys).not.toContainEqual({ pk: K.user('rocio'), sk: 'ACCESS' });
    expect(readKeys).not.toContainEqual({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
  });

  it('follows LEK to EOF before rejecting a recreated guardian link in postflight', async () => {
    const expectedLink = createdLink();
    const recreatedLink = { ...expectedLink, createdAt: expectedLink.createdAt + 1 };
    const pageCursor = {
      pk: K.user('nico'),
      sk: 'REC#trees#tree-1',
    };
    let queryCount = 0;
    let reachedEof = false;
    let linkReads = 0;
    ddbMock.on(QueryCommand).callsFake((input) => {
      queryCount += 1;
      if (queryCount === 1) {
        expect(input.ExclusiveStartKey).toBeUndefined();
        return { Items: [treeRecord('nico', 'tree-1')], LastEvaluatedKey: pageCursor };
      }
      expect(input.ExclusiveStartKey).toEqual(pageCursor);
      reachedEof = true;
      return { Items: [treeRecord('nico', 'tree-2')] };
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') return { Item: profile('rocio') };
      if (key.pk === K.user('nico') && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor' }) };
      }
      if (key.pk === expectedLink.pk && key.sk === expectedLink.sk) {
        linkReads += 1;
        if (linkReads === 2) expect(reachedEof).toBe(true);
        return { Item: linkReads === 1 ? expectedLink : recreatedLink };
      }
      return {};
    });

    await expect(exportChild(ctxOf(profile('rocio')), 'nico')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(queryCount).toBe(2);
    expect(linkReads).toBe(2);
  });

  it('keeps child privacy reduction writable without a Premium capability read', async () => {
    mockWritableFamily({ child: { socialEnabled: true } });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      patchChild(ctxOf(profile('rocio')), 'nico', { socialEnabled: false }),
    ).resolves.toMatchObject({ socialEnabled: false });

    const update = ddbMock
      .commandCalls(TransactWriteCommand)[0]
      .args[0].input.TransactItems?.find((item) => item.Update)?.Update;
    expect(update?.ExpressionAttributeValues).toMatchObject({ ':s': false, ':active': 'active' });
    const readKeys = ddbMock.commandCalls(GetCommand).map((call) => keyOf(call.args[0].input));
    expect(readKeys).not.toContainEqual({ pk: K.user('rocio'), sk: 'ACCESS' });
    expect(readKeys).not.toContainEqual({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
  });

  it('does not return a child export when closure starts during the record read', async () => {
    const link = createdLink();
    let recordsRead = false;
    ddbMock.on(QueryCommand).callsFake(() => {
      recordsRead = true;
      return { Items: [treeRecord()] };
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') return { Item: profile('rocio') };
      if (key.pk === K.user('nico') && key.sk === 'PROFILE') {
        return {
          Item: profile('nico', {
            accountType: 'minor',
            ...(recordsRead ? { status: 'closing' as const } : {}),
          }),
        };
      }
      if (key.pk === accountClosureKey('nico').pk && recordsRead) {
        return { Item: { ...key, state: 'requested' } };
      }
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      return {};
    });

    await expect(exportChild(ctxOf(profile('rocio')), 'nico')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('password-reset identity lease cleanup', () => {
  it('releases the lease in a transaction fenced by both writable owners', async () => {
    mockWritableFamily();
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    await resetChildPassword(ctxOf(profile('rocio')), 'nico', () => 'lease-1');

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    const cleanup = ddbMock.commandCalls(TransactWriteCommand)[1].args[0].input.TransactItems ?? [];
    const release = cleanup.find((item) => item.Update)?.Update;
    expect(release).toMatchObject({
      Key: K.profile('nico'),
      UpdateExpression: 'REMOVE identityLeaseOwner, identityLeaseUntil',
      ExpressionAttributeValues: expect.objectContaining({
        ':active': 'active',
        ':identityLeaseOwner': 'lease-1',
      }),
    });
    expect(release?.ConditionExpression).toContain('attribute_not_exists(#status)');
    const checks = cleanup.flatMap((item) =>
      item.ConditionCheck ? [item.ConditionCheck.Key] : [],
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        K.profile('rocio'),
        accountClosureKey('rocio'),
        accountClosureKey('nico'),
        K.link('nico', 'rocio'),
      ]),
    );
    const exactLink = cleanup.find(
      (item) => item.ConditionCheck?.Key?.['sk'] === K.link('nico', 'rocio').sk,
    )?.ConditionCheck;
    expect(exactLink?.ExpressionAttributeValues).toMatchObject({
      ':linkId': 'rocio~nico',
      ':guardianId': 'rocio',
      ':minorId': 'nico',
      ':kind': 'created',
    });
  });

  it('rechecks the exact guardian link consistently when cleanup is cancelled', async () => {
    const link = createdLink();
    let passwordChanged = false;
    let lostLinkReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === link.pk && key.sk === link.sk) {
        if (passwordChanged) {
          lostLinkReads += 1;
          expect(input.ConsistentRead).toBe(true);
          return {};
        }
        return { Item: link };
      }
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') return { Item: profile('rocio') };
      if (key.pk === K.user('nico') && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor' }) };
      }
      return {};
    });
    let transaction = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      transaction += 1;
      if (transaction === 2) throw transactionCanceled();
      return {};
    });
    cognitoMock.on(AdminSetUserPasswordCommand).callsFake(() => {
      passwordChanged = true;
      return {};
    });

    await expect(
      resetChildPassword(ctxOf(profile('rocio')), 'nico', () => 'lease-link-race'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
    expect(lostLinkReads).toBe(1);
  });

  it('surfaces closure if it wins after Cognito but before lease cleanup', async () => {
    const link = createdLink();
    let passwordChanged = false;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = keyOf(input);
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') return { Item: profile('rocio') };
      if (key.pk === K.user('nico') && key.sk === 'PROFILE') {
        return {
          Item: profile('nico', {
            accountType: 'minor',
            ...(passwordChanged ? { status: 'closing' as const } : {}),
          }),
        };
      }
      if (key.pk === accountClosureKey('nico').pk && passwordChanged) {
        return { Item: { ...key, state: 'requested' } };
      }
      return {};
    });
    let transaction = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      transaction += 1;
      if (transaction === 2) throw transactionCanceled();
      return {};
    });
    ddbMock.on(UpdateCommand).resolves({});
    cognitoMock.on(AdminSetUserPasswordCommand).callsFake(() => {
      passwordChanged = true;
      return {};
    });

    await expect(
      resetChildPassword(ctxOf(profile('rocio')), 'nico', () => 'lease-race'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(1);
  });
});
