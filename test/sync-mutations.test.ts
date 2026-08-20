import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CONTRACT_VERSION, type SyncPushPayload } from '@app/api/contracts';
import { newSyncBase, type Tree, type TreeNode } from '@app/db/schema';
import type { Ctx } from '../lambda/authz';
import {
  K,
  type Deps,
  type LinkItem,
  type ProfileItem,
  type RecordItem,
} from '../lambda/db';
import { accountClosureKey } from '../lambda/account-closure';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { pushSync, pushSyncFor } from '../lambda/handlers/sync';

const NOW = 1_800_000_000_000;
const OWNER = 'rocio';
const ddbMock = mockClient(DynamoDBDocumentClient);

function transactionCanceled(codes: readonly string[]): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
}

function profile(): ProfileItem {
  return {
    ...K.profile(OWNER),
    userId: OWNER,
    username: OWNER,
    displayName: 'Rocío',
    accountType: 'adult',
    socialEnabled: true,
    status: 'active',
    familyFenceVersion: 1,
    createdAt: NOW - 1_000,
  };
}

function ctx(): Ctx {
  return { callerId: OWNER, caller: profile(), deps: deps() };
}

function tree(id: string): Tree {
  return {
    ...newSyncBase(NOW - 100),
    id,
    name: id,
    accent: 'moss',
    order: 0,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
  };
}

function archivedTreeUpdate(id: string): { before: Tree; archived: Tree } {
  const before = tree(id);
  return {
    before,
    archived: {
      ...before,
      rev: before.rev + 1,
      updatedAt: before.updatedAt + 1,
      archivedAt: NOW - 1,
    },
  };
}

function node(id: string, treeId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    ...newSyncBase(NOW - 100),
    id,
    treeId,
    parentId: null,
    title: id,
    note: '',
    status: 'seed',
    order: 0,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    ...overrides,
  };
}

function recordItem(record: Tree, owner = OWNER): RecordItem {
  return {
    ...K.rec(owner, 'trees', record.id),
    gsi2pk: K.user(owner),
    gsi2sk: K.chg(NOW - 1_000, record.id),
    owner,
    store: 'trees',
    record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt: NOW - 1_000,
  };
}

function nodeItem(record: TreeNode, owner = OWNER): RecordItem {
  return {
    ...K.rec(owner, 'nodes', record.id),
    gsi2pk: K.user(owner),
    gsi2sk: K.chg(NOW - 1_000, record.id),
    owner,
    store: 'nodes',
    record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt: NOW - 1_000,
  };
}

function rawFlags(
  overrides: Partial<{
    quotaMode: 'off' | 'observe' | 'enforce';
    capabilityMode: 'off' | 'observe' | 'enforce';
  }> = {},
) {
  return {
    pk: 'COMMERCIAL#CONFIG',
    sk: 'FLAGS',
    revision: 1,
    quotaMode: 'off',
    capabilityMode: 'off',
    accessCodeIssuanceEnabled: false,
    accessCodeRedemptionEnabled: false,
    premiumPaymentsEnabled: false,
    updatedAt: NOW - 1_000,
    updatedBy: 'bootstrap',
    reason: 'commercial launch bootstrap',
    ...overrides,
  };
}

function stubCommercialReads(
  previous: readonly RecordItem[],
  marker?: Readonly<Record<string, unknown>>,
): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
      return { Item: rawFlags() };
    }
    if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
    if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
      return { Item: { ...key, state: 'active', activeTrees: 1 } };
    }
    if (marker && key.pk === marker['pk'] && key.sk === marker['sk']) {
      return { Item: marker };
    }
    return { Item: previous.find((item) => item.pk === key.pk && item.sk === key.sk) };
  });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
}

describe('sync mutation groups v2', () => {
  beforeEach(() => ddbMock.reset());

  it.each([null, [], 'payload', 42])(
    'rejects a non-object payload before DynamoDB access: %j',
    async (payload) => {
      await expect(pushSync(ctx(), payload as never)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it.each([Number.NaN, 1.5, -1])(
    'rejects unsafe schemaVersion %s before DynamoDB access',
    async (schemaVersion) => {
      await expect(
        pushSync(ctx(), {
          schemaVersion,
          contractVersion: CONTRACT_VERSION,
          mutationGroups: [
            {
              id: 'mg-bad-schema',
              expectedCount: 1,
              records: [{ store: 'trees', record: tree('bad-schema-tree') }],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    },
  );

  it('rejects an incomplete expectedCount before any write', async () => {
    const payload: SyncPushPayload = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-incomplete',
          expectedCount: 2,
          records: [{ store: 'trees', record: tree('tree-1') }],
        },
      ],
    };

    await expect(pushSync(ctx(), payload)).rejects.toMatchObject({
      code: 'MUTATION_GROUP_INVALID',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects duplicate group ids for the whole request before processing group one', async () => {
    const entry = { store: 'trees' as const, record: tree('tree-1') };

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          { id: 'mg-duplicate', expectedCount: 1, records: [entry] },
          { id: 'mg-duplicate', expectedCount: 1, records: [entry] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects duplicate store/id references across groups before any read or write', async () => {
    const entry = { store: 'trees' as const, record: tree('tree-shared') };

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          { id: 'mg-one', expectedCount: 1, records: [entry] },
          { id: 'mg-two', expectedCount: 1, records: [entry] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects the same response id across different stores before any read', async () => {
    const shared = tree('ambiguous-id');

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-ambiguous-response',
            expectedCount: 2,
            records: [
              { store: 'trees', record: shared },
              { store: 'nodes', record: shared as never },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    {
      label: 'request',
      payload: {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-exact-root',
            expectedCount: 1,
            records: [{ store: 'trees', record: tree('tree-root') }],
          },
        ],
        records: [],
      },
    },
    {
      label: 'group',
      payload: {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-exact-group',
            expectedCount: 1,
            records: [{ store: 'trees', record: tree('tree-group') }],
            ttl: NOW,
          },
        ],
      },
    },
  ])('rejects an extra property on the v2 $label shape', async ({ payload }) => {
    await expect(pushSync(ctx(), payload as never)).rejects.toMatchObject({
      code: 'MUTATION_GROUP_INVALID',
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    { label: 'no groups', id: 'unused', expectedCount: 1, records: [], noGroups: true },
    {
      label: 'a blank id',
      id: ' ',
      expectedCount: 1,
      records: [{ store: 'trees' as const, record: tree('tree-blank') }],
    },
    { label: 'zero members', id: 'mg-empty', expectedCount: 0, records: [] },
    {
      label: 'twenty-one members',
      id: 'mg-too-large',
      expectedCount: 21,
      records: Array.from({ length: 21 }, (_, index) => ({
        store: 'trees' as const,
        record: tree(`tree-${index}`),
      })),
    },
  ])('rejects a v2 request with $label before DynamoDB reads', async (testCase) => {
    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: testCase.noGroups
          ? []
          : [
              {
                id: testCase.id,
                expectedCount: testCase.expectedCount,
                records: testCase.records,
              },
            ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects more than 100 total records before processing the first group', async () => {
    const mutationGroups = Array.from({ length: 6 }, (_, groupIndex) => {
      const count = groupIndex === 5 ? 1 : 20;
      return {
        id: `mg-${groupIndex}`,
        expectedCount: count,
        records: Array.from({ length: count }, (_, recordIndex) => ({
          store: 'trees' as const,
          record: tree(`tree-${groupIndex}-${recordIndex}`),
        })),
      };
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('maps a malformed v2 record to SYNC_SCHEMA_INVALID before DynamoDB reads', async () => {
    const malformed = {
      store: 'trees',
      record: { ...tree('tree-malformed'), rev: '2' },
    };

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-malformed',
            expectedCount: 1,
            records: [malformed as never],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('maps a deep v2 field-shape failure to SYNC_SCHEMA_INVALID', async () => {
    const malformed = { ...tree('tree-extra-field'), unexpected: true };
    ddbMock.on(GetCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-extra-record-field',
            expectedCount: 1,
            records: [{ store: 'trees', record: malformed as never }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects an adversarially nested unknown field before hashing or DynamoDB access', async () => {
    const nestedRoot: Record<string, unknown> = {};
    let nested = nestedRoot;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {};
      nested['next'] = next;
      nested = next;
    }
    const malformed = { ...tree('tree-deep-unknown'), unexpected: nestedRoot };

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-deep-unknown',
            expectedCount: 1,
            records: [{ store: 'trees', record: malformed as never }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('maps a cross-tree parent relation to SYNC_SCHEMA_INVALID without masking it as conflict', async () => {
    const owningTree = tree('tree-owning');
    const foreignParent = node('foreign-parent', 'tree-foreign');
    const incoming = node('cross-tree-child', owningTree.id, {
      parentId: foreignParent.id,
    });
    const stored = [recordItem(owningTree), nodeItem(foreignParent)];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-cross-tree-parent',
            expectedCount: 1,
            records: [{ store: 'nodes', record: incoming }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('writes every record and one insert-only marker in one v2 transaction', async () => {
    const beforeA = tree('tree-a');
    const beforeB = tree('tree-b');
    const incomingA = { ...beforeA, rev: 2, updatedAt: beforeA.updatedAt + 10 };
    const incomingB = { ...beforeB, rev: 2, updatedAt: beforeB.updatedAt + 10 };
    stubCommercialReads([recordItem(beforeA), recordItem(beforeB)]);
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-two-trees',
            expectedCount: 2,
            records: [
              { store: 'trees', record: incomingA },
              { store: 'trees', record: incomingB },
            ],
          },
        ],
      }),
    ).resolves.toEqual({
      applied: ['tree-a', 'tree-b'],
      rejected: [],
      serverRecords: [],
    });

    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const puts = calls[0].args[0].input.TransactItems?.flatMap((item) =>
      item.Put ? [item.Put] : [],
    ) ?? [];
    expect(
      puts.filter((put) => String(put.Item?.['sk']).startsWith('REC#')),
    ).toHaveLength(2);
    expect(puts).toContainEqual(
      expect.objectContaining({
        Item: expect.objectContaining({
          pk: K.user(OWNER),
          sk: 'MUTATION#mg-two-trees',
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          result: { outcome: 'applied', count: 2 },
        }),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    const recordPuts = puts.filter((put) => String(put.Item?.['sk']).startsWith('REC#'));
    expect(new Set(recordPuts.map((put) => put.Item?.['syncedAt']))).toEqual(new Set([NOW]));
    expect(recordPuts.every((put) => String(put.Item?.['gsi2sk']).startsWith('CHG#'))).toBe(true);
  });

  it('creates a migrated tree and its heart with one zeroed tree counter', async () => {
    const treeRecord = {
      ...tree('tree-new-heart'),
      heartId: 'heart-new',
      currentNodeId: 'heart-new',
    };
    const heart = node('heart-new', treeRecord.id);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 0,
            activeGeneration: 'generation-1',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-tree-heart',
            expectedCount: 2,
            records: [
              { store: 'trees', record: treeRecord },
              { store: 'nodes', record: heart },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: [treeRecord.id, heart.id] });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const counterPut = transaction.TransactItems?.find(
      (item) => item.Put?.Item?.['sk'] === `USAGE#TREE#${treeRecord.id}`,
    )?.Put;
    expect(counterPut).toEqual({
      TableName: 'roadmap',
      Item: {
        pk: K.user(OWNER),
        sk: `USAGE#TREE#${treeRecord.id}`,
        generation: 'generation-1',
        visibleBranches: 0,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(
      transaction.TransactItems?.find(
        (item) => item.Update?.Key?.['sk'] === 'USAGE',
      )?.Update,
    ).toMatchObject({
      UpdateExpression: 'ADD activeTrees :activeTreesDelta',
      ExpressionAttributeValues: expect.objectContaining({ ':activeTreesDelta': 1 }),
    });
  });

  it('creates a zeroed generation counter for a new archived tree', async () => {
    const archived = {
      ...tree('tree-new-archived'),
      archivedAt: NOW - 1,
      heartId: 'heart-new-archived',
      currentNodeId: 'heart-new-archived',
    };
    const heart = node('heart-new-archived', archived.id);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 0,
            activeGeneration: 'generation-1',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSync(ctx(), {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-new-archived-tree',
          expectedCount: 2,
          records: [
            { store: 'trees', record: archived },
            { store: 'nodes', record: heart },
          ],
        },
      ],
    });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(
      transaction.TransactItems?.find(
        (item) => item.Put?.Item?.['sk'] === `USAGE#TREE#${archived.id}`,
      )?.Put,
    ).toEqual({
      TableName: 'roadmap',
      Item: {
        pk: K.user(OWNER),
        sk: `USAGE#TREE#${archived.id}`,
        generation: 'generation-1',
        visibleBranches: 0,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
  });

  it.each([
    {
      label: 'archived without heartId',
      records: [
        {
          store: 'trees' as const,
          record: { ...tree('tree-archived-no-heart'), archivedAt: NOW - 1 },
        },
      ],
    },
    {
      label: 'tombstoned with a hidden heart',
      records: (() => {
        const tombstoned = {
          ...tree('tree-tombstoned-hidden-heart'),
          deletedAt: NOW - 1,
          heartId: 'heart-hidden',
          currentNodeId: 'heart-hidden',
        };
        return [
          { store: 'trees' as const, record: tombstoned },
          {
            store: 'nodes' as const,
            record: node('heart-hidden', tombstoned.id, { archivedAt: NOW - 1 }),
          },
        ];
      })(),
    },
  ])('rejects a new $label as SYNC_SCHEMA_INVALID', async ({ records }) => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: `mg-invalid-new-tree-${records.length}`,
            expectedCount: records.length,
            records,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('reuses an archived tree counter across restore and later branch growth', async () => {
    const archived = {
      ...tree('tree-archived-lifecycle'),
      archivedAt: NOW - 1,
      heartId: 'heart-archived-lifecycle',
      currentNodeId: 'heart-archived-lifecycle',
    };
    const heart = node('heart-archived-lifecycle', archived.id);
    const restored = {
      ...archived,
      rev: archived.rev + 1,
      updatedAt: archived.updatedAt + 1,
      archivedAt: null,
    };
    const branch = node('branch-after-restore', archived.id, { parentId: heart.id });
    const access = deriveAccessItem(OWNER, NOW, undefined, []);
    let phase: 'create' | 'restore' | 'branch' = 'create';
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') {
        return phase === 'create' ? {} : { Item: access };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: phase === 'branch' ? 1 : 0,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk === `USAGE#TREE#${archived.id}`) {
        return phase === 'create'
          ? {}
          : { Item: { ...key, generation: 'generation-1', visibleBranches: 0 } };
      }
      const stored =
        phase === 'create'
          ? []
          : [recordItem(phase === 'restore' ? archived : restored), nodeItem(heart)];
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    const context = ctx();

    await pushSync(context, {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-archived-lifecycle-create',
          expectedCount: 2,
          records: [
            { store: 'trees', record: archived },
            { store: 'nodes', record: heart },
          ],
        },
      ],
    });
    phase = 'restore';
    await pushSync(context, {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-archived-lifecycle-restore',
          expectedCount: 1,
          records: [{ store: 'trees', record: restored }],
        },
      ],
    });
    phase = 'branch';
    await pushSync(context, {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-archived-lifecycle-branch',
          expectedCount: 1,
          records: [{ store: 'nodes', record: branch }],
        },
      ],
    });

    const transactions = ddbMock.commandCalls(TransactWriteCommand).map(
      (call) => call.args[0].input.TransactItems ?? [],
    );
    expect(transactions).toHaveLength(3);
    expect(
      transactions[0].filter(
        (item) => item.Put?.Item?.['sk'] === `USAGE#TREE#${archived.id}`,
      ),
    ).toHaveLength(1);
    expect(
      transactions[1].find(
        (item) => item.ConditionCheck?.Key?.['sk'] === `USAGE#TREE#${archived.id}`,
      )?.ConditionCheck?.ExpressionAttributeValues,
    ).toMatchObject({ ':expectedVisibleBranches': 0 });
    expect(
      transactions[2].find(
        (item) => item.Update?.Key?.['sk'] === `USAGE#TREE#${archived.id}`,
      )?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':expectedVisibleBranches': 0, ':visibleBranchesDelta': 1 });
    expect(
      transactions.slice(1).flatMap((items) =>
        items.filter((item) => item.Put?.Item?.['sk'] === `USAGE#TREE#${archived.id}`),
      ),
    ).toHaveLength(0);
    for (const items of transactions) {
      const keys = items.map((item) => {
        const operation = item.Put ?? item.Update ?? item.ConditionCheck;
        const key = operation && ('Key' in operation ? operation.Key : operation.Item);
        return `${String(key?.['pk'])}\u0000${String(key?.['sk'])}`;
      });
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('aggregates two new branches of one migrated tree into one +2 update', async () => {
    const existingTree = {
      ...tree('tree-branches'),
      heartId: 'heart-existing',
      currentNodeId: 'heart-existing',
    };
    const heart = node('heart-existing', existingTree.id);
    const branches = [
      node('branch-a', existingTree.id, { parentId: heart.id }),
      node('branch-b', existingTree.id, { parentId: heart.id }),
    ];
    const stored = [recordItem(existingTree), nodeItem(heart)];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 1,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk === `USAGE#TREE#${existingTree.id}`) {
        return {
          Item: { ...key, generation: 'generation-1', visibleBranches: 0 },
        };
      }
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSync(ctx(), {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-two-branches',
          expectedCount: 2,
          records: branches.map((record) => ({ store: 'nodes' as const, record })),
        },
      ],
    });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const counterUpdates = transaction.TransactItems?.flatMap((item) =>
      item.Update?.Key?.['sk'] === `USAGE#TREE#${existingTree.id}` ? [item.Update] : [],
    ) ?? [];
    expect(counterUpdates).toHaveLength(1);
    expect(counterUpdates[0]).toMatchObject({
      ExpressionAttributeValues: expect.objectContaining({
        ':expectedVisibleBranches': 0,
        ':visibleBranchesDelta': 2,
      }),
    });
  });

  it('keeps the maximum self group at 46 unique transaction keys', async () => {
    const stored: RecordItem[] = [];
    const records = Array.from({ length: 20 }, (_, index) => {
      const treeId = `max-tree-${index}`;
      const heartId = `max-heart-${index}`;
      stored.push(
        recordItem({ ...tree(treeId), heartId, currentNodeId: heartId }),
        nodeItem(node(heartId, treeId)),
      );
      return {
        store: 'nodes' as const,
        record: node(`max-branch-${index}`, treeId, { parentId: heartId }),
      };
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 20,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk.startsWith('USAGE#TREE#max-tree-')) {
        return { Item: { ...key, generation: 'generation-1', visibleBranches: 0 } };
      }
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSync(ctx(), {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [{ id: 'mg-max-self', expectedCount: 20, records }],
    });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(46);
    const keys = items.map((item) => {
      const operation = item.Put ?? item.Update ?? item.ConditionCheck;
      const key = operation && ('Key' in operation ? operation.Key : operation.Item);
      return `${String(key?.['pk'])}\u0000${String(key?.['sk'])}`;
    });
    expect(new Set(keys).size).toBe(46);
    expect(
      items.filter((item) =>
        String(item.Update?.Key?.['sk']).startsWith('USAGE#TREE#'),
      ),
    ).toHaveLength(20);
  });

  it.each([
    ['missing', undefined],
    [
      'corrupt',
      {
        pk: K.user(OWNER),
        sk: 'USAGE#TREE#tree-counter-drift',
        generation: 'wrong-generation',
        visibleBranches: -1,
      },
    ],
  ])('fails closed when an existing migrated tree counter is %s', async (_label, counter) => {
    const before = {
      ...tree('tree-counter-drift'),
      heartId: 'heart-counter-drift',
      currentNodeId: 'heart-counter-drift',
    };
    const heart = node('heart-counter-drift', before.id);
    const incoming = {
      ...before,
      rev: before.rev + 1,
      updatedAt: before.updatedAt + 1,
      archivedAt: NOW - 1,
    };
    const stored = [recordItem(before), nodeItem(heart)];
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 1,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk === `USAGE#TREE#${before.id}`) {
        return { Item: counter };
      }
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: `mg-counter-${_label}`,
            expectedCount: 1,
            records: [{ store: 'trees', record: incoming }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('reads every consistent GRANT page before deriving ACCESS', async () => {
    const { before, archived } = archivedTreeUpdate('tree-paginated-grants');
    stubCommercialReads([recordItem(before)]);
    ddbMock.on(QueryCommand).callsFake((input) =>
      input.ExclusiveStartKey
        ? { Items: [] }
        : {
            Items: [],
            LastEvaluatedKey: { pk: K.user(OWNER), sk: 'GRANT#cursor' },
          },
    );
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSync(ctx(), {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-grant-pages',
          expectedCount: 1,
          records: [{ store: 'trees', record: archived }],
        },
      ],
    });

    const queries = ddbMock.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries.every((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
    expect(queries[1].args[0].input.ExclusiveStartKey).toEqual({
      pk: K.user(OWNER),
      sk: 'GRANT#cursor',
    });
  });

  it('uses the warm last-known-good FLAGS snapshot and emits a bounded stale metric', async () => {
    let clock = NOW;
    const sharedDeps = { ...deps(), now: () => clock };
    const sharedCtx: Ctx = { callerId: OWNER, caller: profile(), deps: sharedDeps };
    const previousStage = process.env['COMMERCIAL_STAGE'];
    const updates = ['flags-first', 'flags-fallback'].map(archivedTreeUpdate);
    const stored = updates.map(({ before }) => recordItem(before));
    process.env['COMMERCIAL_STAGE'] = 'test';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        if (clock > NOW) throw new Error('ddb unavailable');
        return { Item: rawFlags() };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    try {
      for (const { archived } of updates) {
        await pushSync(sharedCtx, {
          schemaVersion: 13,
          contractVersion: CONTRACT_VERSION,
          mutationGroups: [
            {
              id: `mg-${archived.id}`,
              expectedCount: 1,
              records: [{ store: 'trees', record: archived }],
            },
          ],
        });
        clock += 31_000;
      }
      expect(
        info.mock.calls.some(([line]) =>
          String(line).includes('"CommercialConfigurationStale":1'),
        ),
      ).toBe(true);
    } finally {
      info.mockRestore();
      if (previousStage === undefined) delete process.env['COMMERCIAL_STAGE'];
      else process.env['COMMERCIAL_STAGE'] = previousStage;
    }
  });

  it('uses a fresh canonical ACCESS revision as a transaction guard', async () => {
    const { before, archived } = archivedTreeUpdate('tree-fresh-access');
    const access = deriveAccessItem(OWNER, NOW, undefined, []);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') return { Item: access };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-fresh-access',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: [archived.id] });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(
      transaction.TransactItems?.find(
        (item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS',
      )?.ConditionCheck,
    ).toMatchObject({
      ExpressionAttributeValues: expect.objectContaining({ ':accessRevision': 1 }),
    });
  });

  it('materializes an expired ACCESS before committing the mutation group', async () => {
    const { before, archived } = archivedTreeUpdate('tree-expired-access');
    let access = deriveAccessItem(OWNER, NOW - 2 * 24 * 60 * 60 * 1_000, undefined, []);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') return { Item: access };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      const accessPut = input.TransactItems?.find(
        (item: { Put?: { Item?: Record<string, unknown> } }) =>
          item.Put?.Item?.['sk'] === 'ACCESS',
      )?.Put?.Item;
      const marker = input.TransactItems?.some(
        (item: { Put?: { Item?: Record<string, unknown> } }) =>
          String(item.Put?.Item?.['sk']).startsWith('MUTATION#'),
      );
      if (accessPut && !marker) access = accessPut as unknown as typeof access;
      return {};
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-expired-access',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: [archived.id] });

    const transactions = ddbMock.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(
      transactions[0].args[0].input.TransactItems?.some(
        (item) => item.Put?.Item?.['sk'] === 'ACCESS',
      ),
    ).toBe(true);
    expect(
      transactions[1].args[0].input.TransactItems?.some(
        (item) => item.Put?.Item?.['sk'] === 'MUTATION#mg-expired-access',
      ),
    ).toBe(true);
  });

  it('writes no records when closure wins during ACCESS materialization', async () => {
    const { before, archived } = archivedTreeUpdate('tree-access-closure');
    const expired = deriveAccessItem(OWNER, NOW - 2 * 24 * 60 * 60 * 1_000, undefined, []);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') return { Item: expired };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactGetCommand).resolves({
      Responses: [
        { Item: profile() },
        { Item: { ...accountClosureKey(OWNER), state: 'requested' } },
        { Item: { pk: K.user(OWNER), sk: 'USAGE', state: 'active', activeTrees: 0 } },
      ],
    });
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['ConditionalCheckFailed']));

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-access-closure',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const transactions = ddbMock.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    expect(
      transactions[0].args[0].input.TransactItems?.some(
        (item) => item.Put?.Item?.['sk'] === `REC#trees#${archived.id}`,
      ),
    ).toBe(false);
  });

  it('classifies a concurrent identical marker insert as idempotent success', async () => {
    const { before, archived } = archivedTreeUpdate('tree-marker-race');
    let racedMarker: Record<string, unknown> | undefined;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      if (key.sk === 'MUTATION#mg-marker-race') return { Item: racedMarker };
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      racedMarker = input.TransactItems?.find(
        (item: { Put?: { Item?: Record<string, unknown> } }) =>
          item.Put?.Item?.['sk'] === 'MUTATION#mg-marker-race',
      )?.Put?.Item as Record<string, unknown>;
      throw transactionCanceled(['ConditionalCheckFailed']);
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-marker-race',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toEqual({
      applied: [archived.id],
      rejected: [],
      serverRecords: [],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rechecks the guardian link before accepting a concurrent identical marker', async () => {
    const minorId = 'nico-concurrent-marker';
    const link: LinkItem = {
      ...K.link(minorId, OWNER),
      gsi1pk: K.user(OWNER),
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${OWNER}~${minorId}`,
      kind: 'created',
      guardianId: OWNER,
      minorId,
      createdAt: NOW - 2_000,
    };
    const minorProfile: ProfileItem = {
      ...profile(),
      ...K.profile(minorId),
      userId: minorId,
      username: minorId,
      displayName: 'Nico',
      accountType: 'minor',
    };
    const { before, archived } = archivedTreeUpdate('minor-concurrent-marker-tree');
    const stored = recordItem(before, minorId);
    let racedMarker: Record<string, unknown> | undefined;
    let linkCurrent = true;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) {
        return input.ConsistentRead && !linkCurrent ? {} : { Item: link };
      }
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(minorId) && key.sk === 'PROFILE') return { Item: minorProfile };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(minorId) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 1 } };
      }
      if (key.sk === 'MUTATION#mg-guardian-concurrent-marker') {
        return { Item: racedMarker };
      }
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      racedMarker = input.TransactItems?.find(
        (item: { Put?: { Item?: Record<string, unknown> } }) =>
          item.Put?.Item?.['sk'] === 'MUTATION#mg-guardian-concurrent-marker',
      )?.Put?.Item as Record<string, unknown>;
      linkCurrent = false;
      throw transactionCanceled(['ConditionalCheckFailed']);
    });

    await expect(
      pushSyncFor(ctx(), minorId, {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-guardian-concurrent-marker',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('re-reads an LWW winner after cancellation and keeps the whole group pending', async () => {
    const before = tree('tree-lww-race');
    const incoming = { ...before, rev: 2, updatedAt: before.updatedAt + 1 };
    const winner = { ...before, rev: 3, updatedAt: before.updatedAt + 2 };
    let current = recordItem(before);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 1 } };
      }
      if (key.pk === current.pk && key.sk === current.sk) return { Item: current };
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      current = recordItem(winner);
      throw transactionCanceled(['ConditionalCheckFailed']);
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-lww-race',
            expectedCount: 1,
            records: [{ store: 'trees', record: incoming }],
          },
        ],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [{ id: incoming.id, reason: 'STALE_REV' }],
      serverRecords: [{ store: 'trees', record: winner }],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('re-reads the latest strong winner before returning a stale group', async () => {
    const incoming = tree('tree-stale-refresh');
    const winnerRev2 = {
      ...incoming,
      rev: incoming.rev + 1,
      updatedAt: incoming.updatedAt + 1,
    };
    const winnerRev3 = {
      ...incoming,
      rev: incoming.rev + 2,
      updatedAt: incoming.updatedAt + 2,
    };
    let current = recordItem(winnerRev2);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === current.pk && key.sk === current.sk) return { Item: current };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') {
        current = recordItem(winnerRev3);
        return { Item: profile() };
      }
      return {};
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-stale-refresh',
            expectedCount: 1,
            records: [{ store: 'trees', record: incoming }],
          },
        ],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [{ id: incoming.id, reason: 'STALE_REV' }],
      serverRecords: [{ store: 'trees', record: winnerRev3 }],
    });
    const recordReads = ddbMock.commandCalls(GetCommand).filter(
      (call) => call.args[0].input.Key?.['sk'] === `REC#trees#${incoming.id}`,
    );
    expect(recordReads).toHaveLength(2);
    expect(recordReads.every((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a concurrent marker that reuses the group id with another hash', async () => {
    const { before, archived } = archivedTreeUpdate('tree-marker-mismatch');
    let racedMarker: Record<string, unknown> | undefined;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      if (key.sk === 'MUTATION#mg-marker-mismatch') return { Item: racedMarker };
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      const marker = input.TransactItems?.find(
        (item: { Put?: { Item?: Record<string, unknown> } }) =>
          item.Put?.Item?.['sk'] === 'MUTATION#mg-marker-mismatch',
      )?.Put?.Item as Record<string, unknown>;
      racedMarker = { ...marker, requestHash: '0'.repeat(64) };
      throw transactionCanceled(['ConditionalCheckFailed']);
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-marker-mismatch',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it.each([
    [
      'TransactionCanceled reason',
      transactionCanceled(['TransactionConflict', 'None']),
    ],
    [
      'direct exception',
      Object.assign(new Error('transaction conflict'), {
        name: 'TransactionConflictException',
      }),
    ],
  ])('retries a Dynamo %s at most once after lifecycle recheck', async (_label, conflict) => {
    const { before, archived } = archivedTreeUpdate(`tree-conflict-${_label}`);
    stubCommercialReads([recordItem(before)]);
    let attempts = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      attempts += 1;
      if (attempts === 1) throw conflict;
      return {};
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: `mg-conflict-${attempts}-${_label.replace(/\s+/g, '-')}`,
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: [archived.id] });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it('re-evaluates a raced ACCESS revision before the one allowed retry', async () => {
    const { before, archived } = archivedTreeUpdate('tree-access-race');
    let access = deriveAccessItem(OWNER, NOW, undefined, []);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') return { Item: access };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    let attempts = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      attempts += 1;
      if (attempts === 1) {
        access = deriveAccessItem(OWNER, NOW, access, []);
        throw transactionCanceled(['ConditionalCheckFailed']);
      }
      return {};
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-access-race',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: [archived.id] });

    const second = ddbMock.commandCalls(TransactWriteCommand)[1].args[0].input;
    expect(
      second.TransactItems?.find((item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS')
        ?.ConditionCheck?.ExpressionAttributeValues,
    ).toMatchObject({ ':accessRevision': 2 });
  });

  it('lets a migration fence win after a conditional transaction race', async () => {
    const { before, archived } = archivedTreeUpdate('tree-fence-race');
    let migration: Record<string, unknown> | undefined;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE_MIGRATION') {
        return { Item: migration };
      }
      const stored = recordItem(before);
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      migration = {
        pk: K.user(OWNER),
        sk: 'USAGE_MIGRATION',
        state: 'migrating',
        generation: 'generation-race',
        leaseUntil: NOW + 60_000,
      };
      throw transactionCanceled(['ConditionalCheckFailed']);
    });

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-fence-race',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'USAGE_MIGRATION_IN_PROGRESS' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('treats the same marker hash as success and rejects reuse with another payload', async () => {
    const before = tree('tree-idempotent');
    const incoming = { ...before, rev: 2, updatedAt: before.updatedAt + 10 };
    const payload = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-idempotent',
          expectedCount: 1,
          records: [{ store: 'trees' as const, record: incoming }],
        },
      ],
    } as const;
    stubCommercialReads([recordItem(before)]);
    ddbMock.on(TransactWriteCommand).resolves({});
    await pushSync(ctx(), payload as never);
    const firstTransaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const marker = firstTransaction.TransactItems?.find(
      (item) => item.Put?.Item?.['sk'] === 'MUTATION#mg-idempotent',
    )?.Put?.Item as Record<string, unknown>;

    stubCommercialReads([recordItem(incoming)], marker);
    await expect(pushSync(ctx(), payload as never)).resolves.toEqual({
      applied: ['tree-idempotent'],
      rejected: [],
      serverRecords: [],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);

    const changedPayload = {
      ...payload,
      mutationGroups: [
        {
          ...payload.mutationGroups[0],
          records: [
            {
              store: 'trees' as const,
              record: { ...incoming, name: 'different payload' },
            },
          ],
        },
      ],
    };
    await expect(pushSync(ctx(), changedPayload as never)).rejects.toMatchObject({
      code: 'MUTATION_GROUP_INVALID',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('accepts an exact pre-TTL marker retry after revalidating guards without reapplying records', async () => {
    const before = tree('tree-legacy-marker');
    const incoming = { ...before, rev: 2, updatedAt: before.updatedAt + 10 };
    const payload = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-legacy-marker',
          expectedCount: 1,
          records: [{ store: 'trees' as const, record: incoming }],
        },
      ],
    } as const;
    stubCommercialReads([recordItem(before)]);
    ddbMock.on(TransactWriteCommand).resolves({});
    await pushSync(ctx(), payload as never);

    const firstTransaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const retainedMarker = firstTransaction.TransactItems?.find(
      (item) => item.Put?.Item?.['sk'] === 'MUTATION#mg-legacy-marker',
    )?.Put?.Item as Record<string, unknown>;
    const { ttl: removedTtl, ...historicalMarker } = retainedMarker;
    expect(removedTtl).toBeDefined();
    expect(Object.keys(historicalMarker).sort()).toEqual(
      ['pk', 'sk', 'requestHash', 'expectedCount', 'result', 'createdAt'].sort(),
    );

    stubCommercialReads([recordItem(incoming)], historicalMarker);
    const readsBeforeRetry = ddbMock.commandCalls(GetCommand).length;
    await expect(pushSync(ctx(), payload as never)).resolves.toEqual({
      applied: ['tree-legacy-marker'],
      rejected: [],
      serverRecords: [],
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const retryReads = ddbMock
      .commandCalls(GetCommand)
      .slice(readsBeforeRetry)
      .map((call) => call.args[0].input.Key);
    expect(retryReads).toHaveLength(3);
    expect(retryReads).toEqual(
      expect.arrayContaining([
        { pk: K.user(OWNER), sk: 'MUTATION#mg-legacy-marker' },
        K.profile(OWNER),
        accountClosureKey(OWNER),
      ]),
    );
    expect(retryReads.some((key) => String(key?.['sk']).startsWith('REC#'))).toBe(false);
  });

  it.each([
    {
      label: 'an incorrect ttl',
      caseId: 'wrong-ttl',
      tamper: (marker: Record<string, unknown>) => ({
        ...marker,
        ttl: Number(marker['ttl']) + 1,
      }),
    },
    {
      label: 'an extra field',
      caseId: 'extra-field',
      tamper: (marker: Record<string, unknown>) => ({ ...marker, unexpected: true }),
    },
  ])('rejects a marker with $label without reapplying records', async ({ caseId, tamper }) => {
    const before = tree(`tree-marker-${caseId}`);
    const incoming = { ...before, rev: 2, updatedAt: before.updatedAt + 10 };
    const groupId = `mg-marker-${caseId}`;
    const payload = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: groupId,
          expectedCount: 1,
          records: [{ store: 'trees' as const, record: incoming }],
        },
      ],
    } as const;
    stubCommercialReads([recordItem(before)]);
    ddbMock.on(TransactWriteCommand).resolves({});
    await pushSync(ctx(), payload as never);

    const firstTransaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const marker = firstTransaction.TransactItems?.find(
      (item) => item.Put?.Item?.['sk'] === `MUTATION#${groupId}`,
    )?.Put?.Item as Record<string, unknown>;
    stubCommercialReads([recordItem(incoming)], tamper(marker));

    await expect(pushSync(ctx(), payload as never)).rejects.toMatchObject({
      code: 'MUTATION_GROUP_INVALID',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('gives every mutation marker a bounded thirty-day DynamoDB retention', async () => {
    const { before, archived } = archivedTreeUpdate('tree-marker-retention');
    stubCommercialReads([recordItem(before)]);
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSync(ctx(), {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-marker-retention',
          expectedCount: 1,
          records: [{ store: 'trees', record: archived }],
        },
      ],
    });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const marker = transaction.TransactItems?.find(
      (item) => item.Put?.Item?.['sk'] === 'MUTATION#mg-marker-retention',
    )?.Put?.Item;

    expect(marker).toMatchObject({
      createdAt: NOW,
      ttl: Math.ceil(NOW / 1_000) + 30 * 24 * 60 * 60,
    });
  });

  it('keeps a mixed stale and new group wholly pending and returns only available winners', async () => {
    const staleIncoming = tree('tree-stale');
    const staleWinner = {
      ...staleIncoming,
      rev: staleIncoming.rev + 5,
      updatedAt: staleIncoming.updatedAt + 5,
    };
    const newArchived = {
      ...tree('tree-new'),
      archivedAt: NOW - 1,
      heartId: 'heart-tree-new',
      currentNodeId: 'heart-tree-new',
    };
    const newHeart = node('heart-tree-new', newArchived.id);
    stubCommercialReads([recordItem(staleWinner)]);

    await expect(
      pushSync(ctx(), {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-stale-new',
            expectedCount: 3,
            records: [
              { store: 'trees', record: newArchived },
              { store: 'nodes', record: newHeart },
              { store: 'trees', record: staleIncoming },
            ],
          },
        ],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [
        { id: 'tree-new', reason: 'STALE_REV' },
        { id: 'heart-tree-new', reason: 'STALE_REV' },
        { id: 'tree-stale', reason: 'STALE_REV' },
      ],
      serverRecords: [{ store: 'trees', record: staleWinner }],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    const readKeys = ddbMock.commandCalls(GetCommand).map(
      (call) => call.args[0].input.Key as { pk: string; sk: string },
    );
    expect(readKeys).not.toContainEqual({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
    expect(readKeys).not.toContainEqual({ pk: K.user(OWNER), sk: 'ACCESS' });
    expect(readKeys).not.toContainEqual({ pk: K.user(OWNER), sk: 'USAGE' });
    expect(readKeys).not.toContainEqual({ pk: K.user(OWNER), sk: 'USAGE_MIGRATION' });
  });

  it('guards caller, minor and the exact guardian link in the v2 transaction', async () => {
    const minorId = 'nico';
    const link: LinkItem = {
      ...K.link(minorId, OWNER),
      gsi1pk: K.user(OWNER),
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${OWNER}~${minorId}`,
      kind: 'created',
      guardianId: OWNER,
      minorId,
      createdAt: NOW - 2_000,
    };
    const { before, archived } = archivedTreeUpdate('minor-tree');
    const stored = recordItem(before, minorId);
    const minorProfile: ProfileItem = {
      ...profile(),
      ...K.profile(minorId),
      userId: minorId,
      username: minorId,
      displayName: 'Nico',
      accountType: 'minor',
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(minorId) && key.sk === 'PROFILE') return { Item: minorProfile };
      if (key.pk === K.user(minorId) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 1 } };
      }
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSyncFor(ctx(), minorId, {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-guardian',
            expectedCount: 1,
            records: [{ store: 'trees', record: archived }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: ['minor-tree'] });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const checks = transaction.TransactItems?.flatMap((item) =>
      item.ConditionCheck ? [item.ConditionCheck] : [],
    ) ?? [];
    expect(checks.map((check) => check.Key)).toEqual([
      K.profile(minorId),
      accountClosureKey(minorId),
      { pk: K.user(minorId), sk: 'USAGE_MIGRATION' },
      K.profile(OWNER),
      accountClosureKey(OWNER),
      K.link(minorId, OWNER),
    ]);
    expect(checks.at(-1)).toMatchObject({
      ConditionExpression: expect.stringContaining('linkId = :linkId'),
      ExpressionAttributeValues: expect.objectContaining({ ':linkId': link.linkId }),
    });
    const keys = transaction.TransactItems?.map((item) => {
      const operation = item.Put ?? item.Update ?? item.ConditionCheck;
      const key = operation && ('Key' in operation ? operation.Key : operation.Item);
      return `${String(key?.['pk'])}\u0000${String(key?.['sk'])}`;
    });
    expect(new Set(keys).size).toBe(keys?.length);
  });

  it('returns no stale minor winner after the guardian link disappears', async () => {
    const minorId = 'nico-stale';
    const link: LinkItem = {
      ...K.link(minorId, OWNER),
      gsi1pk: K.user(OWNER),
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${OWNER}~${minorId}`,
      kind: 'created',
      guardianId: OWNER,
      minorId,
      createdAt: NOW - 2_000,
    };
    const incoming = tree('minor-stale-tree');
    const winner = {
      ...incoming,
      rev: incoming.rev + 1,
      updatedAt: incoming.updatedAt + 1,
    };
    const stored = recordItem(winner, minorId);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) {
        return input.ConsistentRead ? {} : { Item: link };
      }
      if (key.sk === 'PROFILE') {
        const userId = key.pk.replace('USER#', '');
        return {
          Item: {
            ...profile(),
            ...K.profile(userId),
            userId,
            username: userId,
            accountType: userId === minorId ? 'minor' : 'adult',
          },
        };
      }
      if (key.pk === stored.pk && key.sk === stored.sk) return { Item: stored };
      return {};
    });

    await expect(
      pushSyncFor(ctx(), minorId, {
        schemaVersion: 13,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'mg-guardian-stale-race',
            expectedCount: 1,
            records: [{ store: 'trees', record: incoming }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('does not accept an idempotent guardian marker after the link disappears', async () => {
    const minorId = 'nico-marker-race';
    const link: LinkItem = {
      ...K.link(minorId, OWNER),
      gsi1pk: K.user(OWNER),
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${OWNER}~${minorId}`,
      kind: 'created',
      guardianId: OWNER,
      minorId,
      createdAt: NOW - 2_000,
    };
    const minorProfile: ProfileItem = {
      ...profile(),
      ...K.profile(minorId),
      userId: minorId,
      username: minorId,
      displayName: 'Nico',
      accountType: 'minor',
    };
    const { before, archived } = archivedTreeUpdate('minor-marker-tree');
    const stored = recordItem(before, minorId);
    const payload = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-guardian-marker-race',
          expectedCount: 1,
          records: [{ store: 'trees' as const, record: archived }],
        },
      ],
    } as const;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(minorId) && key.sk === 'PROFILE') return { Item: minorProfile };
      if (key.pk === K.user(minorId) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 1 } };
      }
      return key.pk === stored.pk && key.sk === stored.sk ? { Item: stored } : {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    await pushSyncFor(ctx(), minorId, payload as never);
    const marker = ddbMock
      .commandCalls(TransactWriteCommand)[0]
      .args[0].input.TransactItems?.find(
        (item) => item.Put?.Item?.['sk'] === 'MUTATION#mg-guardian-marker-race',
      )?.Put?.Item as Record<string, unknown>;

    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) {
        return input.ConsistentRead ? {} : { Item: link };
      }
      if (key.pk === marker['pk'] && key.sk === marker['sk']) return { Item: marker };
      if (key.sk === 'PROFILE') {
        const userId = key.pk.replace('USER#', '');
        return {
          Item: {
            ...profile(),
            ...K.profile(userId),
            userId,
            username: userId,
            accountType: userId === minorId ? 'minor' : 'adult',
          },
        };
      }
      return {};
    });

    await expect(pushSyncFor(ctx(), minorId, payload as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('keeps the maximum guardian group at 49 unique transaction keys', async () => {
    const minorId = 'nico-max';
    const link: LinkItem = {
      ...K.link(minorId, OWNER),
      gsi1pk: K.user(OWNER),
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${OWNER}~${minorId}`,
      kind: 'created',
      guardianId: OWNER,
      minorId,
      createdAt: NOW - 2_000,
    };
    const minorProfile: ProfileItem = {
      ...profile(),
      ...K.profile(minorId),
      userId: minorId,
      username: minorId,
      displayName: 'Nico',
      accountType: 'minor',
    };
    const stored: RecordItem[] = [];
    const records = Array.from({ length: 20 }, (_, index) => {
      const treeId = `guardian-tree-${index}`;
      const heartId = `guardian-heart-${index}`;
      stored.push(
        recordItem({ ...tree(treeId), heartId, currentNodeId: heartId }, minorId),
        nodeItem(node(heartId, treeId), minorId),
      );
      return {
        store: 'nodes' as const,
        record: node(`guardian-branch-${index}`, treeId, { parentId: heartId }),
      };
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') return { Item: rawFlags() };
      if (key.pk === K.user(minorId) && key.sk === 'PROFILE') return { Item: minorProfile };
      if (key.pk === K.user(minorId) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 20,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (
        key.pk === K.user(minorId) &&
        key.sk.startsWith('USAGE#TREE#guardian-tree-')
      ) {
        return { Item: { ...key, generation: 'generation-1', visibleBranches: 0 } };
      }
      return { Item: stored.find((item) => item.pk === key.pk && item.sk === key.sk) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await pushSyncFor(ctx(), minorId, {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [{ id: 'mg-max-guardian', expectedCount: 20, records }],
    });

    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(49);
    const keys = items.map((item) => {
      const operation = item.Put ?? item.Update ?? item.ConditionCheck;
      const key = operation && ('Key' in operation ? operation.Key : operation.Item);
      return `${String(key?.['pk'])}\u0000${String(key?.['sk'])}`;
    });
    expect(new Set(keys).size).toBe(49);
  });
});

describe('legacy flat sync commercial compatibility', () => {
  beforeEach(() => ddbMock.reset());

  it('requires a v2 client for any growth while commercial policy enforces', async () => {
    const archived = { ...tree('legacy-growth'), archivedAt: NOW - 1 };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: rawFlags({ capabilityMode: 'enforce' }) };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'ACCESS') {
        return {
          Item: {
            ...deriveAccessItem(OWNER, NOW, undefined, []),
            effectivePlanKey: 'premium',
            capabilities: { cloudSync: true, social: true, family: false },
            limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return { Item: { ...key, state: 'active', activeTrees: 0 } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 12,
        records: [{ store: 'trees', record: archived }],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_CLIENT_UPGRADE_REQUIRED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['tree-first', 'heart-first', 'branch-first'] as const)(
    'applies a legacy staged tree/heart pair dependency-safely: %s',
    async (order) => {
    const treeRecord = {
      ...tree('legacy-tree-heart'),
      heartId: 'legacy-heart',
      currentNodeId: 'legacy-heart',
    };
    const heart = node('legacy-heart', treeRecord.id);
    const branch = node('legacy-branch', treeRecord.id, { parentId: heart.id });
    const items = new Map<string, Record<string, unknown>>();
    let usage: Record<string, unknown> = {
      pk: K.user(OWNER),
      sk: 'USAGE',
      state: 'active',
      activeTrees: 0,
      activeGeneration: 'generation-1',
    };
    const itemKey = (pk: unknown, sk: unknown) => `${String(pk)}\u0000${String(sk)}`;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: rawFlags({ quotaMode: 'observe', capabilityMode: 'observe' }) };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') return { Item: usage };
      return { Item: items.get(itemKey(key.pk, key.sk)) };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      for (const operation of input.TransactItems ?? []) {
        if (operation.Put?.Item) {
          const item = operation.Put.Item as Record<string, unknown>;
          items.set(itemKey(item['pk'], item['sk']), item);
        }
        if (operation.Update?.Key?.['sk'] === 'USAGE') {
          const delta = operation.Update.ExpressionAttributeValues?.[':activeTreesDelta'];
          usage = {
            ...usage,
            activeTrees: Number(usage['activeTrees']) + Number(delta),
          };
        } else if (String(operation.Update?.Key?.['sk']).startsWith('USAGE#TREE#')) {
          const key = operation.Update!.Key as { pk: string; sk: string };
          const current = items.get(itemKey(key.pk, key.sk));
          const delta = operation.Update!.ExpressionAttributeValues?.[
            ':visibleBranchesDelta'
          ];
          items.set(itemKey(key.pk, key.sk), {
            ...current,
            visibleBranches: Number(current?.['visibleBranches']) + Number(delta),
          });
        }
      }
      return {};
    });

    const records =
      order === 'branch-first'
        ? [
            { store: 'nodes' as const, record: branch },
            { store: 'trees' as const, record: treeRecord },
            { store: 'nodes' as const, record: heart },
          ]
        : order === 'tree-first'
        ? [
            { store: 'trees' as const, record: treeRecord },
            { store: 'nodes' as const, record: heart },
          ]
        : [
            { store: 'nodes' as const, record: heart },
            { store: 'trees' as const, record: treeRecord },
          ];
    await expect(
      pushSync(ctx(), {
        schemaVersion: 12,
        records,
      }),
    ).resolves.toEqual({
      applied: records.map((entry) => entry.record.id),
      rejected: [],
      serverRecords: [],
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(records.length);
    expect(
      ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.find(
        (item) => String(item.Put?.Item?.['sk']).startsWith('REC#'),
      )?.Put?.Item?.['sk'],
    ).toBe(`REC#trees#${treeRecord.id}`);
    expect(usage['activeTrees']).toBe(1);
    expect(items.get(itemKey(K.user(OWNER), `USAGE#TREE#${treeRecord.id}`))).toMatchObject({
      generation: 'generation-1',
      visibleBranches: order === 'branch-first' ? 1 : 0,
    });
    },
  );

  it('accepts and counts legacy growth in observe mode with a deterministic marker', async () => {
    const active = tree('legacy-observe-growth');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: rawFlags({ quotaMode: 'observe', capabilityMode: 'observe' }) };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 0,
            activeGeneration: 'generation-1',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 12,
        records: [{ store: 'trees', record: active }],
      }),
    ).resolves.toMatchObject({ applied: [active.id] });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const marker = transaction.TransactItems?.find(
      (item) => String(item.Put?.Item?.['sk']).startsWith('MUTATION#legacy-'),
    )?.Put?.Item;
    expect(marker?.['sk']).toMatch(/^MUTATION#legacy-[0-9a-f]{64}$/);
    expect(
      transaction.TransactItems?.find((item) => item.Update?.Key?.['sk'] === 'USAGE')
        ?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':activeTreesDelta': 1 });
  });

  it('allows a legacy reduction while policy enforces', async () => {
    const before = tree('legacy-reduction');
    const incoming = {
      ...before,
      rev: before.rev + 1,
      updatedAt: before.updatedAt + 1,
      archivedAt: NOW - 1,
    };
    const stored = recordItem(before);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return { Item: rawFlags({ quotaMode: 'enforce', capabilityMode: 'enforce' }) };
      }
      if (key.pk === K.user(OWNER) && key.sk === 'PROFILE') return { Item: profile() };
      if (key.pk === K.user(OWNER) && key.sk === 'USAGE') {
        return {
          Item: {
            ...key,
            state: 'active',
            activeTrees: 1,
            activeGeneration: 'generation-1',
          },
        };
      }
      if (key.pk === K.user(OWNER) && key.sk === `USAGE#TREE#${before.id}`) {
        return { Item: { ...key, generation: 'generation-1', visibleBranches: 0 } };
      }
      if (key.pk === stored.pk && key.sk === stored.sk) return { Item: stored };
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSync(ctx(), {
        schemaVersion: 12,
        records: [{ store: 'trees', record: incoming }],
      }),
    ).resolves.toMatchObject({ applied: [incoming.id] });
    expect(
      ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.find(
        (item) => item.Update?.Key?.['sk'] === 'USAGE',
      )?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':activeTreesDelta': -1 });
  });
});
