import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
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
import { Deps, K, LinkItem, ProfileItem, RecordItem } from '../lambda/db';
import { getForest } from '../lambda/handlers/forests';
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
  return { callerId: caller.userId, caller, deps: deps() };
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
  return { ...newSyncBase(NOW - 100), id, name: id, accent: 'moss', order: 10, currentNodeId: null, archivedAt: null };
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

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

// ── Forest authorization + stripping ─────────────────────────────────────────

function stubForest(owner: ProfileItem, relationLinks: LinkItem[], friends: boolean): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const { pk, sk } = input.Key as { pk: string; sk: string };
    if (sk === 'PROFILE' && pk === K.user(owner.userId)) return { Item: owner };
    const linkHit = relationLinks.find((l) => l.pk === pk && l.sk === sk);
    if (linkHit) return { Item: linkHit };
    if (sk.startsWith('FRIEND#') && friends) {
      return { Item: { pk, sk, friendshipId: 'x~y', userA: 'x', userB: 'y', createdAt: NOW } };
    }
    return { Item: undefined };
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const prefix = (input.ExpressionAttributeValues as Record<string, string>)?.[':prefix'];
    if (prefix === 'REC#trees#') return { Items: [recordItem(owner.userId, 'trees', tree('t1'))] };
    if (prefix === 'REC#nodes#') return { Items: [recordItem(owner.userId, 'nodes', node('n1', 't1'))] };
    return { Items: [] };
  });
}

describe('getForest — permissions matrix', () => {
  it('stranger gets 404, never an existence hint', async () => {
    const nico = profile('nico', { accountType: 'minor', socialEnabled: false });
    stubForest(nico, [], false);
    const stranger = ctxOf(profile('stranger'));
    await expect(getForest(stranger, 'nico')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('guardian gets FULL nodes (co-gardening)', async () => {
    const nico = profile('nico', { accountType: 'minor', socialEnabled: false });
    stubForest(nico, [link('rocio', 'nico', 'created')], false);
    const rocio = ctxOf(profile('rocio'));
    const snapshot = await getForest(rocio, 'nico');
    expect(snapshot.detail).toBe('full');
    expect((snapshot.nodes[0] as TreeNode).note).toBe('private words');
    expect((snapshot.nodes[0] as TreeNode).targetDate).toBe('2026-08-01');
    expect((snapshot.nodes[0] as TreeNode).priority).toBe('sunlit'); // guardians see the light
  });

  it('friend gets the STRIPPED view', async () => {
    const ambar = profile('ambar');
    stubForest(ambar, [], true);
    const val = ctxOf(profile('val', { accountType: 'minor', socialEnabled: true }));
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
    stubForest(ambar, [], true);
    const val = ctxOf(profile('val', { accountType: 'minor', socialEnabled: true }));
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
      if (key.pk === K.profile('rocio').pk && key.sk === K.profile('rocio').sk) {
        return { Item: profile('rocio', { status: 'active' }) };
      }
      return key.pk === winner.pk && key.sk === winner.sk ? { Item: winner } : {};
    });

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
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return { Item: related.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
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
      .map((call) => call.args[0].input.TransactItems?.[0]?.Put?.Item as RecordItem);
    expect(written.map((item) => recordItem('rocio', item.store, item.record).store)).toEqual([
      'harvests',
      'preserves',
    ]);
  });
});

// ── Family rules ─────────────────────────────────────────────────────────────

describe('family', () => {
  it('createChild maps UsernameExistsException to USERNAME_TAKEN', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] }); // no minors yet
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
    ddbMock.on(QueryCommand).resolves({ Items: [link('rocio', 'nico', 'created')] });
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
    ddbMock.on(GetCommand).resolves({}); // rate row absent + code not found
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      acceptFamilyInvite(ctxOf(profile('rocio')), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1); // the bump
  });

  it('the family attempt after 5 bad redemptions is RATE_LIMITED', async () => {
    const rateKey = K.rate('rocio', Math.floor(NOW / 3_600_000));
    ddbMock
      .on(GetCommand, { TableName: 'roadmap', Key: { pk: rateKey.pk, sk: rateKey.sk } })
      .resolves({ Item: { ...rateKey, count: 5, ttl: 0 } });
    await expect(
      acceptFamilyInvite(ctxOf(profile('rocio')), { code: 'WRONGONE' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

// ── Friend codes ─────────────────────────────────────────────────────────────

describe('friend requests', () => {
  // The brake is read-first, bump-on-BAD-attempt (contract law: successful
  // redemptions never count).
  const RATE_KEY = K.rate('val', Math.floor(NOW / 3_600_000));
  function stubRate(count: number): void {
    ddbMock
      .on(GetCommand, { TableName: 'roadmap', Key: { pk: RATE_KEY.pk, sk: RATE_KEY.sk } })
      .resolves({ Item: { ...RATE_KEY, count, ttl: 0 } });
  }

  it('expired codes answer CODE_EXPIRED and count as a bad attempt', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { code: 'MBRD2468', kind: 'friend', userId: 'ambar', expiresAt: NOW - 1, ttl: 0 } });
    stubRate(1);
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      createFriendRequest(ctxOf(profile('val', { accountType: 'minor', socialEnabled: true })), {
        code: 'MBRD2468',
      }),
    ).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1); // the bump
  });

  it('the attempt after 5 bad redemptions in an hour is RATE_LIMITED', async () => {
    stubRate(5);
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
    ['list friends', (ctx: Ctx) => getFriends(ctx)],
    ['get a friend code', (ctx: Ctx) => getFriendCode(ctx)],
    ['rotate a friend code', (ctx: Ctx) => rotateFriendCode(ctx)],
    ['create a request', (ctx: Ctx) => createFriendRequest(ctx, { code: 'MBRD2468' })],
    ['accept a request', (ctx: Ctx) => acceptFriendRequest(ctx, 'r1')],
    ['decline a request', (ctx: Ctx) => declineFriendRequest(ctx, 'r1')],
    ['cancel a request', (ctx: Ctx) => cancelFriendRequest(ctx, 'r1')],
    ['remove a friend', (ctx: Ctx) => removeFriend(ctx, 'nico~val')],
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
    expect(profilePut?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(profilePut?.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    expect(usernamePut?.Item).toMatchObject(K.uniqUsername('rocio'));
    expect(usernamePut?.ConditionExpression).toBe('attribute_not_exists(pk)');
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
    let provisioned = false;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      if (provisioned) {
        throw Object.assign(new Error('username already reserved'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            {
              Code: 'ConditionalCheckFailed',
              Item: { userId: { S: 'sub-rocio' }, username: { S: 'rocio' } },
            },
            {
              Code: 'ConditionalCheckFailed',
              Item: { userId: { S: 'sub-rocio' } },
            },
            { Code: 'None' },
          ],
        });
      }
      provisioned = true;
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
});
