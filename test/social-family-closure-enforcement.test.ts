import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  type Ctx,
} from '../lambda/authz';
import { accountClosureKey } from '../lambda/account-closure';
import type {
  CodeItem,
  Deps,
  FriendRequestItem,
  LinkItem,
  ProfileItem,
} from '../lambda/db';
import { K } from '../lambda/db';
import {
  acceptFamilyInvite,
  cancelChildRequest,
  createChild,
  createFamilyInvite,
  deleteFamilyLink,
  patchChild,
  removeChildFriendship,
  resetChildPassword,
  revokeFamilyInvite,
} from '../lambda/handlers/family';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
  getFriendCode,
  removeFriend,
  rotateFriendCode,
} from '../lambda/handlers/friends';
import { guardedWrite } from '../lambda/handlers/guarded-mutation';

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

function profile(userId: string, over: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId,
    displayName: userId,
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 1_000,
    ...over,
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function link(guardianId: string, minorId: string, kind: LinkItem['kind'] = 'created'): LinkItem {
  return {
    ...K.link(minorId, guardianId),
    gsi1pk: K.user(guardianId),
    gsi1sk: `MINOR#${minorId}`,
    linkId: `${guardianId}~${minorId}`,
    kind,
    guardianId,
    minorId,
    createdAt: NOW - 500,
  };
}

function friendRequest(fromId: string, toId: string): FriendRequestItem {
  const requestId = `freq-${fromId}~${toId}`;
  return {
    ...K.freq(toId, requestId),
    gsi1pk: K.user(fromId),
    gsi1sk: `FREQ#${requestId}`,
    requestId,
    fromId,
    toId,
    createdAt: NOW - 100,
    expiresAt: NOW + 60_000,
    ttl: Math.ceil((NOW + 60_000) / 1_000),
  };
}

function invite(code: string, over: Partial<CodeItem> = {}): CodeItem {
  return {
    ...K.codeG(code),
    code,
    kind: 'coGuardian',
    userId: 'rocio',
    minorId: 'nico',
    expiresAt: NOW + 60_000,
    ttl: Math.ceil((NOW + 60_000) / 1_000),
    ...over,
  };
}

function transactionInput(index = 0) {
  return ddbMock.commandCalls(TransactWriteCommand)[index]?.args[0].input;
}

function conditionKeys(index = 0): Array<{ pk: string; sk: string }> {
  return (transactionInput(index)?.TransactItems ?? []).flatMap((item) =>
    item.ConditionCheck ? [item.ConditionCheck.Key as { pk: string; sk: string }] : [],
  );
}

function expectOwnerGuards(ownerIds: string[], index = 0): void {
  const keys = conditionKeys(index);
  for (const ownerId of ownerIds) {
    expect(keys).toContainEqual(K.profile(ownerId));
    expect(keys).toContainEqual(accountClosureKey(ownerId));
  }
}

function transactionCanceled(): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
  });
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

afterEach(() => {
  for (const call of ddbMock.commandCalls(TransactWriteCommand)) {
    const addressed = (call.args[0].input.TransactItems ?? []).map((item) => {
      if (item.Put) {
        return JSON.stringify([item.Put.TableName, item.Put.Item?.['pk'], item.Put.Item?.['sk']]);
      }
      const operation = item.Update ?? item.Delete ?? item.ConditionCheck;
      return JSON.stringify([
        operation?.TableName,
        operation?.Key?.['pk'],
        operation?.Key?.['sk'],
      ]);
    });
    expect(new Set(addressed).size, 'a transaction cannot address the same item twice').toBe(
      addressed.length,
    );
  }
});

describe('guarded transaction composition', () => {
  it('omits owner checks only when equivalent profile and closure guards are embedded', async () => {
    const ctx = ctxOf(profile('rocio'));
    ddbMock.on(TransactWriteCommand).resolves({});

    await guardedWrite(
      ctx,
      ['rocio'],
      [
        {
          Update: {
            TableName: ctx.deps.table,
            Key: K.profile('rocio'),
            UpdateExpression: 'SET displayName = :displayName',
            ConditionExpression: WRITABLE_PROFILE_CONDITION,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':active': 'active', ':displayName': 'Rocío' },
          },
        },
        closureAbsenceConditionCheck(ctx.deps, 'rocio'),
      ],
      undefined,
      { rocio: { profile: true, closure: true } },
    );

    expect(transactionInput().TransactItems).toHaveLength(2);
  });

  it('rejects an embedded profile-guard claim when the update has no writable condition', async () => {
    const ctx = ctxOf(profile('rocio'));
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      guardedWrite(
        ctx,
        ['rocio'],
        [
          {
            Update: {
              TableName: ctx.deps.table,
              Key: K.profile('rocio'),
              UpdateExpression: 'SET displayName = :displayName',
              ExpressionAttributeValues: { ':displayName': 'Rocío' },
            },
          },
        ],
        undefined,
        { rocio: { profile: true } },
      ),
    ).rejects.toThrow('equivalent embedded profile guard');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a profile guard weakened by a top-level OR', async () => {
    const ctx = ctxOf(profile('rocio'));
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      guardedWrite(
        ctx,
        ['rocio'],
        [
          {
            Update: {
              TableName: ctx.deps.table,
              Key: K.profile('rocio'),
              UpdateExpression: 'SET displayName = :displayName',
              ConditionExpression: `${WRITABLE_PROFILE_CONDITION} OR attribute_exists(pk)`,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':active': 'active', ':displayName': 'Rocío' },
            },
          },
        ],
        undefined,
        { rocio: { profile: true } },
      ),
    ).rejects.toThrow('equivalent embedded profile guard');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a closure guard weakened by OR', async () => {
    const ctx = ctxOf(profile('rocio'));
    const weakClosure = closureAbsenceConditionCheck(ctx.deps, 'rocio');
    weakClosure.ConditionCheck!.ConditionExpression =
      'attribute_not_exists(pk) OR attribute_not_exists(sk)';
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      guardedWrite(
        ctx,
        ['rocio'],
        [weakClosure],
        undefined,
        { rocio: { closure: true } },
      ),
    ).rejects.toThrow('equivalent embedded closure guard');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('friend mutations serialize with account closure', () => {
  it('mints a friend code and updates its pointer in one guarded transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await getFriendCode(ctxOf(profile('rocio')));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    const items = transactionInput().TransactItems ?? [];
    expect(items.some((item) => item.Put?.Item?.['kind'] === 'friend')).toBe(true);
    expect(items.some((item) => item.Update?.Key?.['sk'] === 'PROFILE')).toBe(true);
    expect(conditionKeys()).toContainEqual(accountClosureKey('rocio'));
  });

  it('rotates a friend code by deleting the exact old grant in the guarded transaction', async () => {
    const oldCode = 'OLDCODE2';
    const oldGrant: CodeItem = {
      ...K.codeF(oldCode),
      code: oldCode,
      kind: 'friend',
      userId: 'rocio',
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1_000),
    };
    ddbMock.on(GetCommand).resolves({ Item: oldGrant });
    ddbMock.on(TransactWriteCommand).resolves({});

    await rotateFriendCode(ctxOf(profile('rocio', { friendCode: oldCode })));

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    const oldDelete = transactionInput().TransactItems?.find(
      (item) => item.Delete?.Key?.['pk'] === oldGrant.pk,
    )?.Delete;
    expect(oldDelete?.ConditionExpression).toContain('#code = :code');
    expect(oldDelete?.ExpressionAttributeValues).toMatchObject({
      ':code': oldCode,
      ':userId': 'rocio',
      ':expiresAt': oldGrant.expiresAt,
    });
  });

  it('creates a request with caller, target, code and reverse-request guards', async () => {
    const code = 'MBRD2468';
    const grant: CodeItem = {
      ...K.codeF(code),
      code,
      kind: 'friend',
      userId: 'ambar',
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1_000),
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.codeF(code).pk) return { Item: grant };
      if (key.pk === K.profile('ambar').pk && key.sk === 'PROFILE') {
        return { Item: profile('ambar') };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await createFriendRequest(ctxOf(profile('rocio')), { code });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio', 'ambar']);
    const checks = transactionInput().TransactItems?.flatMap((item) =>
      item.ConditionCheck ? [item.ConditionCheck] : [],
    );
    expect(checks).toContainEqual(expect.objectContaining({ Key: K.codeF(code) }));
    expect(checks).toContainEqual(
      expect.objectContaining({ Key: K.freq('rocio', 'freq-ambar~rocio') }),
    );
  });

  it('accepts a request only while both owners and the exact request still match', async () => {
    const request = friendRequest('ambar', 'rocio');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === request.pk && key.sk === request.sk) return { Item: request };
      if (key.pk === K.profile('ambar').pk && key.sk === 'PROFILE') {
        return { Item: profile('ambar') };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await acceptFriendRequest(ctxOf(profile('rocio')), request.requestId);

    expectOwnerGuards(['rocio', 'ambar']);
    const requestDelete = transactionInput().TransactItems?.find(
      (item) => item.Delete?.Key?.['pk'] === request.pk,
    )?.Delete;
    expect(requestDelete?.ConditionExpression).toContain('requestId = :requestId');
    expect(requestDelete?.ExpressionAttributeValues).toMatchObject({
      ':requestId': request.requestId,
      ':fromId': 'ambar',
      ':toId': 'rocio',
      ':gsi1pk': K.user('ambar'),
      ':gsi1sk': `FREQ#${request.requestId}`,
      ':expiresAt': request.expiresAt,
    });
  });

  it('declines and cancels requests through exact guarded deletes', async () => {
    const incoming = friendRequest('ambar', 'rocio');
    ddbMock.on(GetCommand).resolves({ Item: incoming });
    ddbMock.on(QueryCommand).resolves({ Items: [incoming] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await declineFriendRequest(ctxOf(profile('rocio')), incoming.requestId);
    await cancelFriendRequest(ctxOf(profile('ambar')), incoming.requestId);

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio', 'ambar'], 0);
    expectOwnerGuards(['ambar', 'rocio'], 1);
    for (const index of [0, 1]) {
      const requestDelete = transactionInput(index).TransactItems?.find((item) => item.Delete)?.Delete;
      expect(requestDelete?.ConditionExpression).toContain('requestId = :requestId');
    }
  });

  it('removes both friendship mirrors only while both accounts remain writable', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await removeFriend(ctxOf(profile('rocio')), 'ambar~rocio');

    expectOwnerGuards(['rocio', 'ambar']);
    expect(transactionInput().TransactItems?.filter((item) => item.Delete)).toHaveLength(2);
  });

  it('records a bad code attempt in the same transaction as the caller guards', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      createFriendRequest(ctxOf(profile('rocio')), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio']);
    expect(transactionInput().TransactItems?.some((item) => item.Update?.Key?.['sk'].startsWith('RATE#'))).toBe(
      true,
    );
  });

  it('rechecks closure consistently and returns CONFLICT after a cancelled friend write', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled());
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile('rocio', { status: 'closing' }) };
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      return {};
    });

    await expect(getFriendCode(ctxOf(profile('rocio')))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      ddbMock.commandCalls(GetCommand).filter((call) => call.args[0].input.ConsistentRead),
    ).toHaveLength(2);
  });

  it('does not mask an unexplained friend transaction cancellation', async () => {
    const cancelled = transactionCanceled();
    ddbMock.on(TransactWriteCommand).rejects(cancelled);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      return {};
    });

    await expect(getFriendCode(ctxOf(profile('rocio')))).rejects.toBe(cancelled);
  });
});

describe('family mutations serialize with account closure', () => {
  it('does not create a Cognito child when the guardian is already closing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'closing' }) };
      }
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      return {};
    });

    await expect(
      createChild(ctxOf(profile('rocio')), { username: 'nico', displayName: 'Nico' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('creates the child profile/link only while the guardian remains writable', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.pk === K.profile('rocio').pk && key.sk === 'PROFILE'
        ? { Item: profile('rocio', { status: 'active' }) }
        : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'nico-sub' }] },
    });

    await createChild(ctxOf(profile('rocio')), { username: 'nico', displayName: 'Nico' });

    expectOwnerGuards(['rocio']);
    expect(conditionKeys()).toContainEqual(accountClosureKey('nico-sub'));
    const childPut = transactionInput().TransactItems?.find(
      (item) => item.Put?.Item?.['userId'] === 'nico-sub' && item.Put?.Item?.['sk'] === 'PROFILE',
    )?.Put;
    expect(childPut?.Item).toMatchObject({ status: 'active' });
  });

  it('patches a child with caller, child and exact created-link guards', async () => {
    const guardianLink = link('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === guardianLink.pk && key.sk === guardianLink.sk) return { Item: guardianLink };
      if (key.pk === K.profile('nico').pk && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor' }) };
      }
      return {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await patchChild(ctxOf(profile('rocio')), 'nico', { displayName: 'Nicolás' });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(conditionKeys()).toContainEqual(K.profile('rocio'));
    expect(conditionKeys()).toContainEqual(accountClosureKey('rocio'));
    expect(conditionKeys()).toContainEqual(accountClosureKey('nico'));
    expect(conditionKeys()).toContainEqual(K.link('nico', 'rocio'));
    const childUpdate = transactionInput().TransactItems?.find((item) => item.Update)?.Update;
    expect(childUpdate?.ConditionExpression).toContain('#status = :active');
  });

  it('checks caller and child closure before a non-transactional password reset', async () => {
    const guardianLink = link('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'closing' }) };
      }
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      if (key.pk === guardianLink.pk && key.sk === guardianLink.sk) return { Item: guardianLink };
      if (key.pk === K.profile('nico').pk && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor' }) };
      }
      return {};
    });
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});

    await expect(resetChildPassword(ctxOf(profile('rocio')), 'nico')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(cognitoMock.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
  });

  it('creates and revokes family invites with exact guarded transactions', async () => {
    const guardianLink = link('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === guardianLink.pk && key.sk === guardianLink.sk) return { Item: guardianLink };
      if (key.pk.startsWith('CODE#G#')) {
        const code = key.pk.replace('CODE#G#', '');
        return { Item: invite(code) };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [guardianLink] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const grant = await createFamilyInvite(ctxOf(profile('rocio')), {
      kind: 'coGuardian',
      minorId: 'nico',
    });
    await revokeFamilyInvite(ctxOf(profile('rocio')), grant.code);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio', 'nico'], 0);
    expect(conditionKeys(0)).toContainEqual(K.link('nico', 'rocio'));
    expectOwnerGuards(['rocio', 'nico'], 1);
    const revokeDelete = transactionInput(1).TransactItems?.find((item) => item.Delete)?.Delete;
    expect(revokeDelete?.ConditionExpression).toContain('userId = :userId');
  });

  it('accepts a co-guardian invite with all three owners and both read artifacts guarded', async () => {
    const code = 'FAMILY12';
    const familyInvite = invite(code);
    const issuerLink = link('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.rate('abuela', Math.floor(NOW / 3_600_000)).pk) return {};
      if (key.pk === familyInvite.pk && key.sk === familyInvite.sk) return { Item: familyInvite };
      if (key.pk === issuerLink.pk && key.sk === issuerLink.sk) return { Item: issuerLink };
      if (key.pk === K.profile('nico').pk && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor' }) };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [issuerLink] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await acceptFamilyInvite(ctxOf(profile('abuela')), { code });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expectOwnerGuards(['abuela', 'rocio', 'nico']);
    expect(conditionKeys()).toContainEqual(K.link('nico', 'rocio'));
    const inviteDelete = transactionInput().TransactItems?.find(
      (item) => item.Delete?.Key?.['pk'] === familyInvite.pk,
    )?.Delete;
    expect(inviteDelete?.ConditionExpression).toContain('expiresAt = :expiresAt');
  });

  it('accepts linkExisting with caller and issuer guards plus an exact single-use invite delete', async () => {
    const code = 'LINK1234';
    const familyInvite = invite(code, { kind: 'linkExisting', minorId: undefined });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.rate('nico', Math.floor(NOW / 3_600_000)).pk) return {};
      if (key.pk === familyInvite.pk && key.sk === familyInvite.sk) return { Item: familyInvite };
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio') };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await acceptFamilyInvite(
      ctxOf(profile('nico', { accountType: 'minor', socialEnabled: false })),
      { code },
    );

    expectOwnerGuards(['nico', 'rocio']);
    const linkPut = transactionInput().TransactItems?.find(
      (item) => item.Put?.Item?.['linkId'] === 'rocio~nico',
    )?.Put;
    expect(linkPut?.ConditionExpression).toBe('attribute_not_exists(pk)');
    const inviteDelete = transactionInput().TransactItems?.find(
      (item) => item.Delete?.Key?.['pk'] === familyInvite.pk,
    )?.Delete;
    expect(inviteDelete?.ConditionExpression).toContain('attribute_not_exists(#minorId)');
  });

  it('deletes a family link only while both owners and the exact link still match', async () => {
    const leaving = link('rocio', 'nico');
    const staying = link('abuela', 'nico');
    ddbMock.on(GetCommand).resolves({ Item: leaving });
    ddbMock.on(QueryCommand).resolves({ Items: [leaving, staying] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await deleteFamilyLink(ctxOf(profile('rocio')), leaving.linkId);

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio', 'nico']);
    expect(conditionKeys()).toContainEqual(K.link('nico', 'abuela'));
    const deletion = transactionInput().TransactItems?.find((item) => item.Delete)?.Delete;
    expect(deletion?.ConditionExpression).toContain('linkId = :linkId');
  });

  it('guards child friendship removal with the exact guardian link and every affected owner', async () => {
    const guardianLink = link('rocio', 'nico');
    ddbMock.on(GetCommand).resolves({ Item: guardianLink });
    ddbMock.on(TransactWriteCommand).resolves({});

    await removeChildFriendship(ctxOf(profile('rocio')), 'nico', 'ambar~nico');

    expectOwnerGuards(['rocio', 'nico', 'ambar']);
    expect(conditionKeys()).toContainEqual(K.link('nico', 'rocio'));
  });

  it('cancels a child request with guardian-link, request and all-owner guards', async () => {
    const guardianLink = link('rocio', 'nico');
    const request = friendRequest('nico', 'ambar');
    ddbMock.on(GetCommand).resolves({ Item: guardianLink });
    ddbMock.on(QueryCommand).resolves({ Items: [request] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await cancelChildRequest(ctxOf(profile('rocio')), 'nico', request.requestId);

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expectOwnerGuards(['rocio', 'nico', 'ambar']);
    expect(conditionKeys()).toContainEqual(K.link('nico', 'rocio'));
    const deletion = transactionInput().TransactItems?.find((item) => item.Delete)?.Delete;
    expect(deletion?.ConditionExpression).toContain('requestId = :requestId');
  });

  it('preserves an unexplained Dynamo cancellation instead of inventing a domain error', async () => {
    const guardianLink = link('rocio', 'nico');
    const cancelled = transactionCanceled();
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === guardianLink.pk && key.sk === guardianLink.sk) return { Item: guardianLink };
      if (key.pk === K.profile('nico').pk && key.sk === 'PROFILE') {
        return { Item: profile('nico', { accountType: 'minor', status: 'active' }) };
      }
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      return {};
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);

    await expect(
      patchChild(ctxOf(profile('rocio')), 'nico', { displayName: 'Nicolás' }),
    ).rejects.toBe(cancelled);
  });
});
