import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../lambda/authz';
import type { AccessItem } from '../lambda/commercial/model';
import type { CodeItem, Deps, FriendRequestItem, LinkItem, ProfileItem } from '../lambda/db';
import { K } from '../lambda/db';
import {
  acceptAdultFriendRequest,
  createAdultFriendRequest,
  removeSocialFriendship,
  removeSocialFriendshipAs,
} from '../lambda/handlers/social';
import {
  acceptFriendRequest,
  createFriendRequest,
  getFriendCode,
  removeFriend,
} from '../lambda/handlers/friends';
import { SK } from '../lambda/social/model';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);

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
    status: 'active',
    createdAt: NOW - 1_000,
    ...over,
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function codeGrant(code: string, userId: string): CodeItem {
  return {
    ...K.codeF(code),
    code,
    kind: 'friend',
    userId,
    expiresAt: NOW + 60_000,
    ttl: Math.ceil((NOW + 60_000) / 1_000),
  };
}

function request(fromId: string, toId: string): FriendRequestItem {
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

function flags() {
  return {
    pk: 'COMMERCIAL#CONFIG',
    sk: 'FLAGS',
    revision: 1,
    quotaMode: 'off',
    capabilityMode: 'off',
    accessCodeIssuanceEnabled: false,
    accessCodeRedemptionEnabled: false,
    premiumPaymentsEnabled: false,
    updatedAt: NOW - 1,
    updatedBy: 'test',
    reason: 'adult friendship fixture',
  };
}

function access(ownerSub: string): AccessItem {
  return {
    pk: K.user(ownerSub),
    sk: 'ACCESS',
    ownerSub,
    effectivePlanKey: 'free',
    catalogVersion: '2026-09-family-v1',
    status: 'active',
    activeSources: [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
    limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
    capabilities: { cloudSync: false, social: false, family: false },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: NOW + 60_000,
    updatedAt: NOW - 1,
  };
}

function installReads(items: readonly unknown[]): void {
  const byKey = new Map(
    items.map((item) => {
      const keyed = item as { pk: string; sk: string };
      return [JSON.stringify({ pk: keyed.pk, sk: keyed.sk }), item] as const;
    }),
  );
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: byKey.get(JSON.stringify(input.Key)),
  }));
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(TransactWriteCommand).resolves({});
}

function transaction(index: number) {
  return ddbMock.commandCalls(TransactWriteCommand)[index]?.args[0].input.TransactItems ?? [];
}

beforeEach(() => {
  ddbMock.reset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adult friendship handler v2', () => {
  it('creates an adult-only request and pins both account types in the transaction', async () => {
    const caller = profile('adult-a');
    const target = profile('adult-b');
    const code = 'ADULT246';
    installReads([
      codeGrant(code, target.userId),
      target,
      flags(),
      access(caller.userId),
      access(target.userId),
    ]);

    await expect(createAdultFriendRequest(ctxOf(caller), { code })).resolves.toMatchObject({
      requestId: 'freq-adult-a~adult-b',
    });

    const requestWrite = transaction(1);
    expect(requestWrite).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({ Key: SK.friendship(caller.userId, target.userId) }),
      }),
    );
    const profileChecks = requestWrite.flatMap((item) =>
      item.ConditionCheck?.Key?.['sk'] === 'PROFILE' ? [item.ConditionCheck] : [],
    );
    expect(profileChecks).toHaveLength(2);
    for (const check of profileChecks) {
      expect(check.ConditionExpression).toContain('#accountType = :adult');
      expect(check.ConditionExpression).toContain('#userId = :ownerId');
      expect(check.ExpressionAttributeValues).toMatchObject({
        ':adult': 'adult',
        ':ownerId': expect.stringMatching(/^adult-/),
      });
    }
    const codeCheck = requestWrite.find(
      (item) => item.ConditionCheck?.Key?.['pk'] === K.codeF(code).pk,
    )?.ConditionCheck;
    expect(codeCheck?.ConditionExpression).toContain('expiresAt > :now');
    expect(codeCheck?.ExpressionAttributeValues).toMatchObject({ ':now': NOW });
  });

  it('treats a minor target code as invalid without creating a request', async () => {
    const caller = profile('adult-a');
    const target = profile('minor-b', { accountType: 'minor' });
    const code = 'MINOR246';
    installReads([codeGrant(code, target.userId), target]);

    await expect(createAdultFriendRequest(ctxOf(caller), { code })).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rejects a code row whose addressed profile claims another identity', async () => {
    const caller = profile('adult-a');
    const mismatchedTarget = profile('adult-b', { userId: 'adult-c' });
    const code = 'ADULT246';
    installReads([codeGrant(code, 'adult-b'), mismatchedTarget]);

    await expect(createAdultFriendRequest(ctxOf(caller), { code })).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rejects a non-string code as validation instead of leaking a runtime error', async () => {
    const caller = profile('adult-a');

    await expect(
      createAdultFriendRequest(ctxOf(caller), { code: 42 } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each([
    ['v2', (ctx: Ctx) => createAdultFriendRequest(ctx, { code: 'ADULT246' })],
    ['legacy', (ctx: Ctx) => createFriendRequest(ctx, { code: 'ADULT246' })],
    ['legacy code', (ctx: Ctx) => getFriendCode(ctx)],
  ])('blocks a minor caller from the %s adult mutation path', async (_label, invoke) => {
    const caller = profile('minor-a', { accountType: 'minor' });

    await expect(invoke(ctxOf(caller))).rejects.toMatchObject({
      code: 'ACCOUNT_TYPE_INCOMPATIBLE',
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('accepts only adult requests and materializes one canonical META plus legacy mirrors', async () => {
    const caller = profile('adult-b');
    const sender = profile('adult-a');
    const pending = request(sender.userId, caller.userId);
    installReads([
      pending,
      sender,
      flags(),
      access(caller.userId),
      access(sender.userId),
    ]);

    await expect(acceptAdultFriendRequest(ctxOf(caller), pending.requestId)).resolves.toMatchObject({
      friendshipId: 'adult-a~adult-b',
    });

    const writes = transaction(0);
    const meta = writes.find((item) => item.Put?.Item?.['entityType'] === 'Friendship')?.Put?.Item;
    expect(meta).toMatchObject({
      ...SK.friendship(caller.userId, sender.userId),
      friendshipClass: 'adult_adult',
      state: 'active',
      userA: 'adult-a',
      userB: 'adult-b',
    });
    expect(writes.filter((item) => item.Put?.Item?.['sk']?.startsWith('FRIEND#'))).toHaveLength(2);
    const requestDelete = writes.find((item) => item.Delete?.Key?.['pk'] === pending.pk)?.Delete;
    expect(requestDelete?.ConditionExpression).toContain('expiresAt > :now');
    expect(requestDelete?.ExpressionAttributeValues).toMatchObject({ ':now': NOW });
  });

  it('hides an incompatible legacy sender when accepting through v2 or legacy', async () => {
    const caller = profile('adult-b');
    const sender = profile('minor-a', { accountType: 'minor' });
    const pending = request(sender.userId, caller.userId);
    installReads([pending, sender]);

    await expect(acceptAdultFriendRequest(ctxOf(caller), pending.requestId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(acceptFriendRequest(ctxOf(caller), pending.requestId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a structurally forged self-request before materializing friendship state', async () => {
    const caller = profile('adult-a');
    const forged = request(caller.userId, caller.userId);
    installReads([forged, caller]);

    await expect(acceptAdultFriendRequest(ctxOf(caller), forged.requestId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('removes canonical and legacy rows even when social is disabled', async () => {
    const caller = profile('adult-a', { socialEnabled: false });
    ddbMock.on(TransactWriteCommand).resolves({});

    await removeSocialFriendship(ctxOf(caller), 'adult-a~adult-b');
    await removeFriend(ctxOf(caller), 'adult-a~adult-b');

    for (const index of [0, 1]) {
      const deletedKeys = transaction(index).flatMap((item) =>
        item.Delete ? [item.Delete.Key] : [],
      );
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          SK.friendship('adult-a', 'adult-b'),
          K.friend('adult-a', 'adult-b'),
          K.friend('adult-b', 'adult-a'),
        ]),
      );
    }
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('keeps v2 removal adult-only while legacy removal cleans incompatible minor state', async () => {
    const caller = profile('minor-a', { accountType: 'minor', socialEnabled: false });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      removeSocialFriendship(ctxOf(caller), 'minor-a~minor-b'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_TYPE_INCOMPATIBLE' });
    await expect(removeFriend(ctxOf(caller), 'minor-a~minor-b')).resolves.toBeUndefined();

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(transaction(0).flatMap((item) => (item.Delete ? [item.Delete.Key] : []))).toEqual(
      expect.arrayContaining([
        SK.friendship('minor-a', 'minor-b'),
        K.friend('minor-a', 'minor-b'),
        K.friend('minor-b', 'minor-a'),
      ]),
    );
  });

  it('rejects malformed or foreign friendship ids without writing', async () => {
    const caller = profile('adult-a', { socialEnabled: false });

    await expect(removeSocialFriendship(ctxOf(caller), 'adult-a~adult-b~adult-c')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(removeSocialFriendship(ctxOf(caller), 'adult-b~adult-c')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires a guardian cleanup link to authorize this caller and exact minor', async () => {
    const caller = profile('adult-guardian');
    const unrelatedLink: LinkItem = {
      ...K.link('minor-other', caller.userId),
      gsi1pk: K.user(caller.userId),
      gsi1sk: 'MINOR#minor-other',
      linkId: `${caller.userId}~minor-other`,
      kind: 'created',
      guardianId: caller.userId,
      minorId: 'minor-other',
      createdAt: NOW - 1_000,
    };

    await expect(
      removeSocialFriendshipAs(
        ctxOf(caller),
        'minor-a',
        'minor-a~minor-b',
        unrelatedLink,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
