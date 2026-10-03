import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { ApiError, SyncRecord, SyncStore } from '@app/api/contracts';
import { Harvest, Preserve, SCHEMA_VERSION, Tree, TreeNode, newSyncBase } from '@app/db/schema';
import { Ctx } from '../lambda/authz';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { Deps, K, LinkItem, ProfileItem, RecordItem } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import { getForest } from '../lambda/handlers/forests';
import { createActiveAdultFriendship, type FriendshipItem } from '../lambda/social/model';
import { pushSync } from '../lambda/handlers/sync';
import {
  acceptFamilyInvite,
  createChild,
  createFamilyInvite,
  deleteFamilyLink,
} from '../lambda/handlers/family';
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
import { handleEvent as handlePostConfirmation } from '../lambda/post-confirmation';
import { errorResponse } from '../lambda/http';
import { familyV2Fixture, type FamilyV2Fixture } from './support/family-v2-fixture';

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
    createdAt: NOW - 1000,
    ...over,
  } as ProfileItem;
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, authenticatedAt: NOW - 60_000, deps: deps() };
}

function link(guardianId: string, minorId: string, kind: LinkItem['kind']): LinkItem {
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

function tree(id: string): Tree {
  return {
    ...newSyncBase(NOW - 100),
    id,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
  };
}

function node(id: string, treeId: string): TreeNode {
  return {
    ...newSyncBase(NOW - 100),
    id,
    treeId,
    parentId: null,
    title: id,
    note: 'private words',
    status: 'growing',
    order: 10,
    targetDate: '2026-08-01',
    priority: 'sunlit',
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    trigger: 'when-then',
  };
}

function recordItem(owner: string, store: SyncStore, record: SyncRecord['record']): RecordItem {
  return {
    ...K.rec(owner, store, record.id),
    gsi2pk: K.user(owner),
    gsi2sk: K.chg(NOW - 100, record.id),
    owner,
    store,
    record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt: NOW - 100,
  };
}

function harvest(id: string): Harvest {
  return {
    ...newSyncBase(NOW - 100),
    id,
    nodeId: 'n1',
    treeId: 't1',
    treeName: 'Tree',
    accent: 'moss',
    title: 'Fruit',
    harvestedAt: NOW - 100,
  };
}

function preserve(id: string): Preserve {
  return {
    ...newSyncBase(NOW - 100),
    id,
    kind: 'mermelada',
    name: 'Jam',
    madeAt: NOW - 100,
    accent: 'moss',
    tint: '#123456',
    tintEdge: '#012345',
  };
}

function syncFlags() {
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
    reason: 'handler fixture',
  };
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

// ── Forest authorization + stripping ─────────────────────────────────────────

function stubForest(
  owner: ProfileItem,
  options: { family?: FamilyV2Fixture; friendship?: FriendshipItem } = {},
): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const { pk, sk } = input.Key as { pk: string; sk: string };
    if (pk === 'COMMERCIAL#CONFIG' && sk === 'FLAGS') return { Item: syncFlags() };
    if (sk === 'ACCESS' && pk.startsWith('USER#')) {
      const ownerSub = pk.slice('USER#'.length);
      return { Item: deriveAccessItem(ownerSub, NOW, undefined, []) };
    }
    if (sk === 'PROFILE') {
      return { Item: pk === K.user(owner.userId) ? owner : profile(pk.slice('USER#'.length)) };
    }
    if (options.friendship?.pk === pk && options.friendship.sk === sk) {
      return { Item: options.friendship };
    }
    const coverage = options.family?.coverages.find((item) => item.pk === pk && item.sk === sk);
    if (coverage) return { Item: coverage };
    return { Item: undefined };
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = (input.ExpressionAttributeValues as Record<string, string>)?.[':pk'];
    const prefix = (input.ExpressionAttributeValues as Record<string, string>)?.[':prefix'];
    if (prefix === 'REC#trees#') return { Items: [recordItem(owner.userId, 'trees', tree('t1'))] };
    if (prefix === 'REC#nodes#') return { Items: [recordItem(owner.userId, 'nodes', node('n1', 't1'))] };
    if (options.family && pk === FK.household(options.family.household.householdId).pk) {
      return { Items: [options.family.household, ...options.family.seats] };
    }
    if (prefix === 'SUPERVISION#') {
      return {
        Items: (options.family?.supervisionLinks ?? []).filter(
          (current) => current.pk === pk && current.sk.startsWith(prefix),
        ),
      };
    }
    return { Items: [] };
  });
  ddbMock.on(BatchGetCommand).resolves({
    Responses: { roadmap: options.family?.coverages ?? [] },
  });
}

describe('getForest — permissions matrix', () => {
  it('stranger gets 404, never an existence hint', async () => {
    const nico = profile('nico', { accountType: 'minor', socialEnabled: false });
    stubForest(nico);
    const stranger = ctxOf(profile('stranger'));
    await expect(getForest(stranger, 'nico')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('primary responsible gets FULL nodes for the seated minor', async () => {
    const nico = profile('nico', {
      accountType: 'minor',
      socialEnabled: false,
      majorityAt: '2030-01-01',
    });
    const family = familyV2Fixture({ now: NOW, primaryId: 'rocio', minorIds: ['nico'] });
    stubForest(nico, { family });
    const rocio = ctxOf(profile('rocio'));
    const snapshot = await getForest(rocio, 'nico');
    expect(snapshot.detail).toBe('full');
    expect((snapshot.nodes[0] as TreeNode).note).toBe('private words');
    expect((snapshot.nodes[0] as TreeNode).targetDate).toBe('2026-08-01');
    expect((snapshot.nodes[0] as TreeNode).priority).toBe('sunlit'); // guardians see the light
  });

  it('friend gets the STRIPPED view', async () => {
    const ambar = profile('ambar');
    const friendship = createActiveAdultFriendship({
      leftAccountId: 'val',
      rightAccountId: ambar.userId,
      now: NOW - 1_000,
    });
    stubForest(ambar, { friendship });
    const val = ctxOf(profile('val', { socialEnabled: true }));
    const snapshot = await getForest(val, 'ambar');
    expect(snapshot.detail).toBe('stripped');
    const first = snapshot.nodes[0] as TreeNode;
    expect(first.note).toBe('');
    expect(first.trigger).toBeNull();
    expect(first.targetDate).toBeNull();
    expect(first.estimateMin ?? null).toBeNull(); // time guesses are intimate too (0.0.79)
    expect(first.repeatsDaily ?? undefined).toBeUndefined();
    expect(first.repeats ?? undefined).toBeUndefined(); // routines are intimate (0.0.103)
    expect(first.repeatsSetAt ?? undefined).toBeUndefined(); // freeze boundary travels with the cadence (0.0.106)
    expect(first.remindAt ?? undefined).toBeUndefined(); // reminder hours are as intimate as the trigger (0.0.111)
    expect(first.priority).toBeNull(); // «la luz» is private — never travels to friends
  });

  it('friend visits are blocked when social is off on either side', async () => {
    const ambar = profile('ambar', { socialEnabled: false });
    const friendship = createActiveAdultFriendship({
      leftAccountId: 'val',
      rightAccountId: ambar.userId,
      now: NOW - 1_000,
    });
    stubForest(ambar, { friendship });
    const val = ctxOf(profile('val', { socialEnabled: true }));
    await expect(getForest(val, 'ambar')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── Sync LWW ─────────────────────────────────────────────────────────────────

describe('pushSync — rev LWW', () => {
  it('applies newer revs, rejects stale ones and returns the winner', async () => {
    const fresh = tree('t-fresh');
    const stale = { ...tree('t-stale'), rev: 1 };
    const winner = recordItem('rocio', 'trees', { ...tree('t-stale'), rev: 5 });

    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      const item = input.TransactItems?.[0]?.Put?.Item as RecordItem;
      if (item.record && (item.record as Tree).id === 't-stale') {
        throw Object.assign(new Error('conditional'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        });
      }
      return {};
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: syncFlags() };
      }
      if (key.pk === K.profile('rocio').pk && key.sk === K.profile('rocio').sk) {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      if (key.pk === K.user('rocio') && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      return key.pk === winner.pk && key.sk === winner.sk ? { Item: winner } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await pushSync(ctxOf(profile('rocio')), {
      schemaVersion: 3,
      records: [
        { store: 'trees', record: fresh },
        { store: 'trees', record: stale },
      ],
    });
    expect(result.applied).toEqual(['t-fresh']);
    expect(result.rejected).toEqual([{ id: 't-stale', reason: 'STALE_REV' }]);
    expect((result.serverRecords[0].record as Tree).rev).toBe(5);
  });

  it('caps the batch at LIMITS.syncPushMax', async () => {
    const records = Array.from({ length: 101 }, (_, i) => ({
      store: 'trees' as const,
      record: tree(`t${i}`),
    }));
    await expect(
      pushSync(ctxOf(profile('rocio')), { schemaVersion: 3, records }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects an invalid commercial record before the first DynamoDB write', async () => {
    ddbMock.on(PutCommand).resolves({});
    const injectedTree = { ...tree('t-injected'), injectedOwner: 'another-user' };

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: SCHEMA_VERSION,
        records: [
          {
            store: 'trees',
            record: injectedTree,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects clients newer than the server schema', async () => {
    await expect(
      pushSync(ctxOf(profile('rocio')), { schemaVersion: SCHEMA_VERSION + 1, records: [] }),
    ).rejects.toMatchObject({ code: 'SYNC_TOO_OLD' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('accepts harvest and preserve records as first-class sync stores', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const related = [
      recordItem('rocio', 'trees', tree('t1')),
      recordItem('rocio', 'nodes', node('n1', 't1')),
    ];
    const access = deriveAccessItem('rocio', NOW, undefined, []);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: syncFlags() };
      }
      if (key.pk === K.user('rocio') && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      if (key.pk === K.user('rocio') && key.sk === 'ACCESS') return { Item: access };
      if (key.pk === K.user('rocio') && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      return { Item: related.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const records: SyncRecord[] = [
      { store: 'harvests', record: harvest('h:n1') },
      { store: 'preserves', record: preserve('p1') },
    ];

    const result = await pushSync(ctxOf(profile('rocio')), {
      schemaVersion: SCHEMA_VERSION,
      records,
    });

    expect(result.applied).toEqual(['h:n1', 'p1']);
    const written = ddbMock
      .commandCalls(TransactWriteCommand)
      .map(
        (call) =>
          call.args[0].input.TransactItems?.find((item) =>
            String(item.Put?.Item?.['sk']).startsWith('REC#'),
          )?.Put?.Item as RecordItem,
      );
    expect(written.map((item) => recordItem('rocio', item.store, item.record).store)).toEqual([
      'preserves',
      'harvests',
    ]);
  });
});

// ── Family rules ─────────────────────────────────────────────────────────────

describe('family', () => {
  it('createChild maps UsernameExistsException to USERNAME_TAKEN', async () => {
    const home = familyV2Fixture({ now: NOW, primaryId: 'rocio' });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile('rocio').pk && key.sk === 'PROFILE') {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      const coverage = home.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
      if (coverage) return { Item: coverage };
      if (
        key.pk === FK.familyEntitlement(home.household.householdId).pk &&
        key.sk === FK.familyEntitlement(home.household.householdId).sk
      ) {
        return { Item: home.entitlement };
      }
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk = (input.ExpressionAttributeValues as Record<string, string>)?.[':pk'];
      return pk === FK.household(home.household.householdId).pk
        ? { Items: [home.household, ...home.seats] }
        : { Items: [] };
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { roadmap: home.coverages },
    });
    const taken = new Error('exists');
    taken.name = 'UsernameExistsException';
    cognitoMock.on(AdminCreateUserCommand).rejects(taken);
    await expect(
      createChild(ctxOf(profile('rocio')), { username: 'nico', displayName: 'Nico' }),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('the last created-guardian link cannot be removed', async () => {
    const theLink = link('rocio', 'nico', 'created');
    ddbMock.on(GetCommand).resolves({ Item: theLink });
    ddbMock.on(QueryCommand).resolves({ Items: [theLink] }); // guardiansOf → only rocio
    await expect(
      deleteFamilyLink(ctxOf(profile('rocio')), 'rocio~nico'),
    ).rejects.toMatchObject({ code: 'LAST_GUARDIAN' });
  });

  it('a co-guardian can leave while another remains', async () => {
    const leaving = link('rocio', 'nico', 'created');
    const staying = link('abuela', 'nico', 'created');
    ddbMock.on(GetCommand).resolves({ Item: leaving });
    ddbMock.on(QueryCommand).resolves({ Items: [leaving, staying] });
    await expect(deleteFamilyLink(ctxOf(profile('rocio')), 'rocio~nico')).resolves.toBeUndefined();
  });

  it('an invited guardian cannot promote another adult to a created guardian', async () => {
    const invitedGuardian = link('rocio', 'nico', 'invited');
    ddbMock.on(GetCommand).resolves({ Item: invitedGuardian });
    ddbMock.on(QueryCommand).resolves({ Items: [invitedGuardian] });
    ddbMock.on(PutCommand).resolves({});

    await expect(
      createFamilyInvite(ctxOf(profile('rocio')), { kind: 'coGuardian', minorId: 'nico' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects a co-guardian invite when its issuer is no longer a created guardian', async () => {
    const inviteCode = 'FAMILY12';
    const inviteKey = K.codeG(inviteCode);
    const issuerLinkKey = K.link('nico', 'rocio');
    const redeemerLinkKey = K.link('nico', 'abuela');
    const rateKey = K.rate('abuela', Math.floor(NOW / 3_600_000));
    const minor = profile('nico', { accountType: 'minor', socialEnabled: false });

    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === rateKey.pk && key.sk === rateKey.sk) return {};
      if (key.pk === inviteKey.pk && key.sk === inviteKey.sk) {
        return {
          Item: {
            ...inviteKey,
            code: inviteCode,
            kind: 'coGuardian',
            userId: 'rocio',
            minorId: 'nico',
            expiresAt: NOW + 60_000,
            ttl: Math.ceil((NOW + 60_000) / 1000),
          },
        };
      }
      if (key.pk === K.profile('nico').pk && key.sk === K.profile('nico').sk) {
        return { Item: minor };
      }
      if (key.pk === issuerLinkKey.pk && key.sk === issuerLinkKey.sk) return {};
      if (key.pk === redeemerLinkKey.pk && key.sk === redeemerLinkKey.sk) return {};
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await expect(
      acceptFamilyInvite(ctxOf(profile('abuela')), { code: inviteCode }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // Family invites share the friend-code guessing brake (0.0.115 S1 —
  // this door used to have none): same bucket, same 5-per-hour law.
  it('a bad family code counts as a bad attempt and CODE_INVALID answers', async () => {
    const rateKey = K.rate('rocio', Math.floor(NOW / 3_600_000));
    ddbMock.on(GetCommand).resolves({}); // rate row absent + code not found
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      acceptFamilyInvite(ctxOf(profile('rocio')), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });
    const bump = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.find(
      (item) => item.Update?.Key?.['sk'] === rateKey.sk,
    );
    expect(bump?.Update).toBeDefined(); // guarded bump
  });

  it('the family attempt after 5 bad redemptions is RATE_LIMITED', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.pk === K.profile('rocio').pk && key.sk === 'PROFILE'
        ? { Item: profile('rocio') }
        : {};
    });
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('rate limit reached'), {
      name: 'TransactionCanceledException',
    }));
    await expect(
      acceptFamilyInvite(ctxOf(profile('rocio')), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

// ── Friend codes ─────────────────────────────────────────────────────────────

describe('friend requests', () => {
  // Every bearer-code lookup atomically reserves one of five hourly attempts.
  const RATE_KEY = K.rate('val', Math.floor(NOW / 3_600_000));

  it.each([null, undefined, [], 42, 'code', { code: 42 }, { code: null }])(
    'the legacy adapter rejects malformed body %j without writes',
    async (body) => {
      await expect(createFriendRequest(ctxOf(profile('val')), body as never))
        .rejects.toMatchObject({ code: 'VALIDATION' });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('expired codes answer CODE_EXPIRED and count as a bad attempt', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { code: 'MBRD2468', kind: 'friend', userId: 'ambar', expiresAt: NOW - 1, ttl: 0 } });
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      createFriendRequest(ctxOf(profile('val', { accountType: 'adult', socialEnabled: true })), {
        code: 'MBRD2468',
      }),
    ).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    const bump = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.find(
      (item) => item.Update?.Key?.['sk'] === RATE_KEY.sk,
    );
    expect(bump?.Update).toBeDefined(); // guarded bump
  });

  it('the attempt after 5 bad redemptions in an hour is RATE_LIMITED', async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.pk === K.profile('val').pk && key.sk === 'PROFILE'
        ? { Item: profile('val', { socialEnabled: true }) }
        : {};
    });
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('rate limit reached'), {
      name: 'TransactionCanceledException',
    }));
    await expect(
      createFriendRequest(ctxOf(profile('val', { socialEnabled: true })), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('social-off callers cannot touch friend surfaces', async () => {
    await expect(
      createFriendRequest(ctxOf(profile('nico', { accountType: 'minor', socialEnabled: false })), {
        code: 'MBRD2468',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['get a friend code', (ctx: Ctx) => getFriendCode(ctx)],
    ['rotate a friend code', (ctx: Ctx) => rotateFriendCode(ctx)],
    ['create a request', (ctx: Ctx) => createFriendRequest(ctx, { code: 'MBRD2468' })],
    ['accept a request', (ctx: Ctx) => acceptFriendRequest(ctx, 'r1')],
  ])('blocks social-off callers before they can %s', async (_label, invoke) => {
    const socialOff = ctxOf(profile('nico', { accountType: 'minor', socialEnabled: false }));

    await expect(invoke(socialOff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('rejects a request when the other user already has the reverse request pending', async () => {
    const reverseRequestId = 'freq-ambar~val';
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.codeF('MBRD2468').pk) {
        return {
          Item: {
            ...K.codeF('MBRD2468'),
            code: 'MBRD2468',
            kind: 'friend',
            userId: 'ambar',
            expiresAt: NOW + 1000,
            ttl: 0,
          },
        };
      }
      if (key.pk === K.user('ambar') && key.sk === 'PROFILE') return { Item: profile('ambar') };
      if (key.pk === K.user('val') && key.sk === `FREQ#${reverseRequestId}`) {
        return {
          Item: {
            ...K.freq('val', reverseRequestId),
            gsi1pk: K.user('ambar'),
            gsi1sk: `FREQ#${reverseRequestId}`,
            requestId: reverseRequestId,
            fromId: 'ambar',
            toId: 'val',
            createdAt: NOW - 100,
            expiresAt: NOW + 1000,
            ttl: 0,
          },
        };
      }
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await expect(
      createFriendRequest(ctxOf(profile('val')), { code: 'MBRD2468' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('username reservation', () => {
  it('conditionally reserves a self-signup username in the profile transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'Rocio',
      userPoolId: 'pool-1',
      request: { userAttributes: { sub: 'sub-rocio', name: 'Rocio', email: 'r@example.com' } },
    } as unknown as Parameters<typeof handlePostConfirmation>[0];

    await handlePostConfirmation(event, deps());

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const profilePut = transaction.TransactItems?.[0]?.Put;
    const usernamePut = transaction.TransactItems?.[1]?.Put;
    expect(profilePut?.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
    expect(profilePut?.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(usernamePut?.Item).toMatchObject(K.uniqUsername('rocio'));
    expect(usernamePut?.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
    expect(usernamePut?.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  it('does not require DynamoDB reads from the write-only trigger role', async () => {
    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'Rocio',
      userPoolId: 'pool-1',
      request: { userAttributes: { sub: 'sub-rocio', name: 'Rocio', email: 'r@example.com' } },
    } as unknown as Parameters<typeof handlePostConfirmation>[0];
    const denied = new Error('GetItem is not allowed');
    denied.name = 'AccessDeniedException';
    ddbMock.on(GetCommand).rejects(denied);
    ddbMock.on(TransactWriteCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    await expect(handlePostConfirmation(event, deps())).resolves.toBe(event);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('treats a same-sub cancellation as provisioned and retries the Cognito update', async () => {
    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'Rocio',
      userPoolId: 'pool-1',
      request: { userAttributes: { sub: 'sub-rocio', name: 'Rocio', email: 'r@example.com' } },
    } as unknown as Parameters<typeof handlePostConfirmation>[0];
    let provisionedItems: Record<string, unknown>[] | undefined;
    ddbMock
      .on(TransactWriteCommand)
      .callsFake((input: ConstructorParameters<typeof TransactWriteCommand>[0]) => {
        if (provisionedItems) {
          throw Object.assign(new Error('username already reserved'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              ...provisionedItems.map((Item) => ({ Code: 'ConditionalCheckFailed', Item })),
              { Code: 'None' },
            ],
          });
        }
        provisionedItems = (input.TransactItems ?? []).flatMap((item) =>
          item.Put?.Item ? [item.Put.Item] : [],
        );
        return {};
      });
    let attributeUpdates = 0;
    cognitoMock.on(AdminUpdateUserAttributesCommand).callsFake(() => {
      attributeUpdates += 1;
      if (attributeUpdates === 1) throw new Error('Cognito attribute update failed');
      return {};
    });

    await expect(handlePostConfirmation(event, deps())).rejects.toThrow(
      'Cognito attribute update failed',
    );
    await expect(handlePostConfirmation(event, deps())).resolves.toBe(event);

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(2);
  });

  it('keeps failing when the username reservation belongs to another user', async () => {
    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'Rocio',
      userPoolId: 'pool-1',
      request: { userAttributes: { sub: 'sub-rocio', name: 'Rocio', email: 'r@example.com' } },
    } as unknown as Parameters<typeof handlePostConfirmation>[0];
    const conflict = Object.assign(new Error('username already reserved'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        {
          Code: 'ConditionalCheckFailed',
          Item: { userId: { S: 'sub-rocio' }, username: { S: 'rocio' } },
        },
        {
          Code: 'ConditionalCheckFailed',
          Item: { userId: { S: 'sub-other' } },
        },
        { Code: 'None' },
      ],
    });
    ddbMock.on(TransactWriteCommand).rejects(conflict);

    await expect(handlePostConfirmation(event, deps())).rejects.toBe(conflict);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });
});

// ── Error envelope sanity ────────────────────────────────────────────────────

describe('ApiError', () => {
  it('keeps its code through instanceof (shared class with the client)', () => {
    const error = new ApiError('LAST_GUARDIAN', 'x');
    expect(error instanceof ApiError).toBe(true);
    expect(error.code).toBe('LAST_GUARDIAN');
  });

  it.each([
    ['QUOTA_EXCEEDED', 409],
    ['CAPABILITY_REQUIRED', 403],
    ['MUTATION_GROUP_INVALID', 400],
    ['ACCESS_REVISION_CONFLICT', 409],
    ['ACCESS_CODE_INVALID', 400],
    ['ACCESS_CODE_RATE_LIMITED', 429],
    ['ACCESS_CODE_ALREADY_REDEEMED', 409],
    ['SYNC_SCHEMA_INVALID', 400],
    ['SYNC_CLIENT_UPGRADE_REQUIRED', 426],
    ['USAGE_MIGRATION_IN_PROGRESS', 409],
    ['COMMERCIAL_CONFIGURATION_UNAVAILABLE', 503],
    ['ADULT_MINOR_FRIENDSHIP_FORBIDDEN', 400],
    ['ACCOUNT_TYPE_INCOMPATIBLE', 409],
    ['RESPONSIBLE_SCOPE_REQUIRED', 403],
    ['CONSENT_INCOMPLETE', 409],
    ['MINOR_ALREADY_COVERED', 409],
    ['HOUSEHOLD_CAPACITY_EXCEEDED', 409],
    ['CURRENT_PRIMARY_APPROVAL_REQUIRED', 403],
    ['LEGAL_REGION_UNSUPPORTED', 422],
    ['OFFER_NOT_ALLOWED', 400],
    ['CHECKOUT_IN_PROGRESS', 409],
    ['SUBSCRIPTION_CONFLICT', 409],
    ['PAYMENT_REQUIRED', 402],
    ['REAUTHENTICATION_REQUIRED', 401],
    ['STALE_REVISION', 409],
  ] as const)('maps server error %s to HTTP %i', (code, status) => {
    expect(errorResponse(new ApiError(code)).statusCode).toBe(status);
  });
});
