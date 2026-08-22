import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Ctx } from '../lambda/authz';
import { accountClosureKey } from '../lambda/account-closure';
import type { AccessItem, GrantItem } from '../lambda/commercial/model';
import type { CodeItem, Deps, FriendItem, FriendRequestItem, ProfileItem } from '../lambda/db';
import { K } from '../lambda/db';
import { getForest } from '../lambda/handlers/forests';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
  getFriendCode,
  getFriends,
  removeFriend,
  rotateFriendCode,
} from '../lambda/handlers/friends';

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

function access(ownerSub: string, social: boolean): AccessItem {
  return {
    pk: K.user(ownerSub),
    sk: 'ACCESS',
    ownerSub,
    effectivePlanKey: social ? 'premium' : 'free',
    catalogVersion: '2026-08-prepayment-v1',
    status: 'active',
    activeSources: social
      ? [{ kind: 'sponsored', sourceId: 'premium-test', planKey: 'premium', validUntil: null }]
      : [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
    limits: social
      ? { maxActiveTrees: null, maxVisibleBranchesPerTree: null }
      : { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
    capabilities: { cloudSync: social, social, family: false },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: NOW + 60_000,
    updatedAt: NOW - 1,
  };
}

function premiumGrant(ownerSub: string): GrantItem {
  return {
    pk: K.user(ownerSub),
    sk: 'GRANT#premium-test',
    ownerSub,
    grantId: 'premium-test',
    sourceKind: 'sponsored',
    status: 'active',
    catalogVersion: '2026-08-prepayment-v1',
    planKey: 'premium',
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    startsAt: NOW - 1_000,
    expiresAt: null,
    revision: 1,
    reason: 'test premium access',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1,
  };
}

function flags(capabilityMode: 'off' | 'observe' | 'enforce') {
  return {
    pk: 'COMMERCIAL#CONFIG',
    sk: 'FLAGS',
    revision: 1,
    quotaMode: 'off',
    capabilityMode,
    accessCodeIssuanceEnabled: false,
    accessCodeRedemptionEnabled: false,
    premiumPaymentsEnabled: false,
    updatedAt: NOW - 1,
    updatedBy: 'test',
    reason: 'social capability fixture',
  };
}

function friendCodeGrant(code: string, userId: string): CodeItem {
  return {
    ...K.codeF(code),
    code,
    kind: 'friend',
    userId,
    expiresAt: NOW + 60_000,
    ttl: Math.ceil((NOW + 60_000) / 1_000),
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

function friendship(a: string, b: string): FriendItem {
  const friendshipId = a < b ? `${a}~${b}` : `${b}~${a}`;
  return {
    ...K.friend(a, b),
    friendshipId,
    userA: friendshipId.split('~')[0]!,
    userB: friendshipId.split('~')[1]!,
    createdAt: NOW - 1_000,
  };
}

function transactionCanceled(): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
  });
}

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('commercial social capability', () => {
  it('fails closed when FLAGS are unavailable before minting a friend code', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(getFriendCode(ctxOf(profile('rocio')))).rejects.toMatchObject({
      code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('records a bounded unavailable-config metric for protected social actions', async () => {
    const previousStage = process.env['COMMERCIAL_STAGE'];
    process.env['COMMERCIAL_STAGE'] = 'test';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    ddbMock.on(GetCommand).resolves({});
    try {
      await expect(getFriendCode(ctxOf(profile('rocio')))).rejects.toMatchObject({
        code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
      });
      expect(
        info.mock.calls
          .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
          .some(
            (entry) =>
              entry['stage'] === 'test' && entry['CommercialConfigurationUnavailable'] === 1,
          ),
      ).toBe(true);
    } finally {
      if (previousStage === undefined) delete process.env['COMMERCIAL_STAGE'];
      else process.env['COMMERCIAL_STAGE'] = previousStage;
    }
  });

  it('pins caller ACCESS and socialEnabled while minting a friend code', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const caller = profile('rocio');
    const items = new Map<string, unknown>([
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('off')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await getFriendCode(ctxOf(caller));

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const accessCheck = transaction.TransactItems?.find(
      (item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS',
    )?.ConditionCheck;
    expect(accessCheck?.ExpressionAttributeValues).toMatchObject({
      ':ownerSub': caller.userId,
      ':accessRevision': 1,
    });
    const profileUpdate = transaction.TransactItems?.find(
      (item) => item.Update?.Key?.['sk'] === 'PROFILE',
    )?.Update;
    expect(profileUpdate?.ConditionExpression).toContain('#socialEnabled = :socialEnabled');
    expect(profileUpdate?.ExpressionAttributeValues).toMatchObject({ ':socialEnabled': true });
  });

  it('still enforces social when getFriendCode would return an existing code', async () => {
    const code = 'SAME1234';
    const caller = profile('rocio', { friendCode: code });
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, caller.userId)],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('enforce')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getFriendCode(ctxOf(caller))).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
  });

  it('does not return an existing code after social is disabled concurrently', async () => {
    const code = 'SAME1234';
    const caller = profile('rocio', { friendCode: code });
    const current = profile('rocio', { friendCode: code, socialEnabled: false });
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, caller.userId)],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('off')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify(K.profile(caller.userId)), current],
      [JSON.stringify(accountClosureKey(caller.userId)), undefined],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getFriendCode(ctxOf(caller))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not return a code whose profile pointer changed concurrently', async () => {
    const code = 'SAME1234';
    const caller = profile('rocio', { friendCode: code });
    const current = profile('rocio', { friendCode: 'NEW12345' });
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, caller.userId)],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('off')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify(K.profile(caller.userId)), current],
      [JSON.stringify(accountClosureKey(caller.userId)), undefined],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getFriendCode(ctxOf(caller))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('requires social in enforce before rotating a friend code', async () => {
    const code = 'OLD12345';
    const caller = profile('rocio', { friendCode: code });
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, caller.userId)],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('enforce')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(rotateFriendCode(ctxOf(caller))).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a new friend request in enforce when either participant lacks social', async () => {
    const code = 'AMBAR246';
    const caller = profile('rocio');
    const target = profile('ambar');
    const grant = friendCodeGrant(code, target.userId);
    const items = new Map<string, unknown>([
      [JSON.stringify(K.rate(caller.userId, Math.floor(NOW / 3_600_000))), undefined],
      [JSON.stringify(K.codeF(code)), grant],
      [JSON.stringify(K.profile(target.userId)), target],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('enforce')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify({ pk: K.user(target.userId), sk: 'ACCESS' }), access(target.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: items.get(JSON.stringify(input.Key)),
    }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(createFriendRequest(ctxOf(caller), { code })).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('allows and observes a would-be denial in capability observe mode', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const code = 'OBSRV246';
    const caller = profile('rocio');
    const target = profile('ambar');
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, target.userId)],
      [JSON.stringify(K.profile(target.userId)), target],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('observe')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify({ pk: K.user(target.userId), sk: 'ACCESS' }), access(target.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(createFriendRequest(ctxOf(caller), { code })).resolves.toMatchObject({
      requestId: 'freq-rocio~ambar',
    });
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'commercial.capability-decision',
        kind: 'social',
        action: 'create',
        mode: 'observe',
        wouldDeny: true,
      }),
    );
  });

  it('pins ACCESS revision and socialEnabled for both request participants', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const code = 'GUARD246';
    const caller = profile('rocio');
    const target = profile('ambar');
    const items = new Map<string, unknown>([
      [JSON.stringify(K.codeF(code)), friendCodeGrant(code, target.userId)],
      [JSON.stringify(K.profile(target.userId)), target],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('off')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify({ pk: K.user(target.userId), sk: 'ACCESS' }), access(target.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await createFriendRequest(ctxOf(caller), { code });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    const checks = (transaction.TransactItems ?? []).flatMap((item) =>
      item.ConditionCheck ? [item.ConditionCheck] : [],
    );
    const accessChecks = checks.filter((check) => check.Key?.['sk'] === 'ACCESS');
    expect(accessChecks).toHaveLength(2);
    for (const check of accessChecks) {
      expect(check.ConditionExpression).toContain('revision = :accessRevision');
      expect(check.ConditionExpression).toContain('nextRecomputeAt');
    }
    const profileChecks = checks.filter((check) => check.Key?.['sk'] === 'PROFILE');
    expect(profileChecks).toHaveLength(2);
    for (const check of profileChecks) {
      expect(check.ConditionExpression).toContain('#socialEnabled = :socialEnabled');
      expect(check.ExpressionAttributeValues).toMatchObject({ ':socialEnabled': true });
    }
  });

  it('requires social from both participants before accepting a request', async () => {
    const caller = profile('rocio');
    const sender = profile('ambar');
    const request = friendRequest(sender.userId, caller.userId);
    const items = new Map<string, unknown>([
      [JSON.stringify({ pk: request.pk, sk: request.sk }), request],
      [JSON.stringify(K.profile(sender.userId)), sender],
      [JSON.stringify({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }), flags('enforce')],
      [JSON.stringify({ pk: K.user(caller.userId), sk: 'ACCESS' }), access(caller.userId, false)],
      [JSON.stringify({ pk: K.user(sender.userId), sk: 'ACCESS' }), access(sender.userId, false)],
    ]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: items.get(JSON.stringify(input.Key)) }));
    ddbMock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues?.[':prefix'];
      if (prefix === 'GRANT#' && input.ExpressionAttributeValues?.[':pk'] === K.user(caller.userId)) {
        return { Items: [] };
      }
      return { Items: [] };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(acceptFriendRequest(ctxOf(caller), request.requestId)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('fails a social write when a participant disables social during the transaction', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const code = 'RACE2468';
    const caller = profile('rocio');
    const target = profile('ambar');
    const grant = friendCodeGrant(code, target.userId);
    let targetProfileReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.codeF(code).pk) return { Item: grant };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') {
        targetProfileReads += 1;
        return {
          Item: targetProfileReads === 1
            ? target
            : profile(target.userId, { socialEnabled: false }),
        };
      }
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') {
        return { Item: caller };
      }
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: flags('off') };
      }
      if (key.sk === 'ACCESS') return { Item: access(key.pk.slice('USER#'.length), false) };
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).rejectsOnce(transactionCanceled()).resolves({});

    await expect(createFriendRequest(ctxOf(caller), { code })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('re-resolves ACCESS once after a revision conflict', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const code = 'RETRY246';
    const caller = profile('rocio');
    const target = profile('ambar');
    const grant = friendCodeGrant(code, target.userId);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.codeF(code).pk) return { Item: grant };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') return { Item: caller };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: flags('off') };
      if (key.sk === 'ACCESS') {
        const ownerSub = key.pk.slice('USER#'.length);
        return {
          Item: {
            ...access(ownerSub, false),
            revision: ddbMock.commandCalls(TransactWriteCommand).length === 0 ? 1 : 2,
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).rejectsOnce(transactionCanceled()).resolves({});

    await createFriendRequest(ctxOf(caller), { code });

    const transactions = ddbMock.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    const revisions = transactions.map((call) =>
      (call.args[0].input.TransactItems ?? [])
        .filter((item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS')
        .map((item) => item.ConditionCheck?.ExpressionAttributeValues?.[':accessRevision']),
    );
    expect(revisions).toEqual([[1, 1], [2, 2]]);
  });

  it('declines without consulting social capability or socialEnabled', async () => {
    const caller = profile('rocio', { socialEnabled: false });
    const request = friendRequest('ambar', caller.userId);
    const readKeys: Array<{ pk: string; sk: string }> = [];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      readKeys.push(key);
      return key.pk === request.pk && key.sk === request.sk ? { Item: request } : {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(declineFriendRequest(ctxOf(caller), request.requestId)).resolves.toBeUndefined();
    expect(readKeys).not.toContainEqual({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
    expect(readKeys.some((key) => key.sk === 'ACCESS')).toBe(false);
  });

  it('cancels without consulting social capability or socialEnabled', async () => {
    const caller = profile('rocio', { socialEnabled: false });
    const request = friendRequest(caller.userId, 'ambar');
    ddbMock.on(QueryCommand).resolves({ Items: [request] });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(cancelFriendRequest(ctxOf(caller), request.requestId)).resolves.toBeUndefined();
    const reads = ddbMock.commandCalls(GetCommand).map(
      (call) => call.args[0].input.Key as { pk: string; sk: string },
    );
    expect(reads).not.toContainEqual({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
    expect(reads.some((key) => key.sk === 'ACCESS')).toBe(false);
  });

  it('removes a friendship without consulting social capability or socialEnabled', async () => {
    const caller = profile('rocio', { socialEnabled: false });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(removeFriend(ctxOf(caller), 'ambar~rocio')).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('lists existing social state without consulting capability or socialEnabled', async () => {
    const caller = profile('rocio', { socialEnabled: false });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getFriends(ctxOf(caller))).resolves.toEqual({
      friends: [],
      incoming: [],
      outgoing: [],
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('gates a friend forest visit with the viewer capability only', async () => {
    const caller = profile('rocio');
    const owner = profile('ambar');
    const edge = friendship(caller.userId, owner.userId);
    const accessReads: string[] = [];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === edge.pk && key.sk === edge.sk) return { Item: edge };
      if (key.pk === K.profile(owner.userId).pk && key.sk === 'PROFILE') return { Item: owner };
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') return { Item: caller };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: flags('enforce') };
      if (key.sk === 'ACCESS') {
        accessReads.push(key.pk.slice('USER#'.length));
        return { Item: access(key.pk.slice('USER#'.length), false) };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(caller), owner.userId)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(new Set(accessReads)).toEqual(new Set([caller.userId]));
  });

  it('allows a Premium viewer to visit a Free friend without inheriting or requiring owner Premium', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const caller = profile('rocio');
    const owner = profile('ambar');
    const edge = friendship(caller.userId, owner.userId);
    const accessReads: string[] = [];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === edge.pk && key.sk === edge.sk) return { Item: edge };
      if (key.pk === K.profile(owner.userId).pk && key.sk === 'PROFILE') return { Item: owner };
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') return { Item: caller };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: flags('enforce') };
      if (key.sk === 'ACCESS') {
        const ownerSub = key.pk.slice('USER#'.length);
        accessReads.push(ownerSub);
        return { Item: access(ownerSub, ownerSub === caller.userId) };
      }
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const prefix = input.ExpressionAttributeValues?.[':prefix'];
      const ownerSub = String(input.ExpressionAttributeValues?.[':pk']).slice('USER#'.length);
      return prefix === 'GRANT#' && ownerSub === caller.userId
        ? { Items: [premiumGrant(caller.userId)] }
        : { Items: [] };
    });

    await expect(getForest(ctxOf(caller), owner.userId)).resolves.toMatchObject({
      detail: 'stripped',
      owner: { userId: owner.userId },
    });
    expect(new Set(accessReads)).toEqual(new Set([caller.userId]));
  });

  it('revalidates the friend edge consistently before serving a forest', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const caller = profile('rocio');
    const owner = profile('ambar');
    const edge = friendship(caller.userId, owner.userId);
    let edgeReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === edge.pk && key.sk === edge.sk) {
        edgeReads += 1;
        return edgeReads === 1 ? { Item: edge } : {};
      }
      if (key.pk === K.profile(owner.userId).pk && key.sk === 'PROFILE') return { Item: owner };
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') return { Item: caller };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: flags('off') };
      if (key.sk === 'ACCESS') return { Item: access(caller.userId, false) };
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(caller), owner.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const recordQueries = ddbMock.commandCalls(QueryCommand).filter((call) =>
      String(call.args[0].input.ExpressionAttributeValues?.[':prefix']).startsWith('REC#'),
    );
    expect(recordQueries).toHaveLength(0);
  });

  it('hides an owner closure that starts during a friend forest visit', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const caller = profile('rocio');
    const owner = profile('ambar');
    const edge = friendship(caller.userId, owner.userId);
    let ownerProfileReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === edge.pk && key.sk === edge.sk) return { Item: edge };
      if (key.pk === K.profile(owner.userId).pk && key.sk === 'PROFILE') {
        ownerProfileReads += 1;
        return {
          Item: ownerProfileReads < 3 ? owner : profile(owner.userId, { status: 'closing' }),
        };
      }
      if (key.pk === K.profile(caller.userId).pk && key.sk === 'PROFILE') return { Item: caller };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: flags('off') };
      if (key.sk === 'ACCESS') return { Item: access(caller.userId, false) };
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(caller), owner.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const recordQueries = ddbMock.commandCalls(QueryCommand).filter((call) =>
      String(call.args[0].input.ExpressionAttributeValues?.[':prefix']).startsWith('REC#'),
    );
    expect(recordQueries).toHaveLength(0);
  });
});
