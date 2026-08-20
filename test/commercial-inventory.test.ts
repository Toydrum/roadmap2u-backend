import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

async function inventoryModule(): Promise<Record<string, unknown>> {
  const url = pathToFileURL(
    join(process.cwd(), 'scripts', 'commercial-inventory.mjs'),
  ).href;
  return import(url) as Promise<Record<string, unknown>>;
}

const OWNER = 'owner-sensitive-a';

function syncRecord(
  store: string,
  record: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const owner = typeof overrides.owner === 'string' ? overrides.owner : OWNER;
  const id = String(record.id ?? 'malformed');
  return {
    pk: `USER#${owner}`,
    sk: `REC#${store}#${id}`,
    gsi2pk: `USER#${owner}`,
    gsi2sk: `CHG#00000000000200#${id}`,
    owner,
    store,
    record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt: 200,
    ...overrides,
  };
}

function tree(id: string, heartId: string | null): Record<string, unknown> {
  return {
    id,
    createdAt: 10,
    updatedAt: 20,
    rev: 1,
    deletedAt: null,
    archivedAt: null,
    heartId,
    name: `private tree ${id}`,
  };
}

function node(
  id: string,
  treeId: string,
  parentId: string | null,
): Record<string, unknown> {
  return {
    id,
    createdAt: 10,
    updatedAt: 20,
    rev: 1,
    deletedAt: null,
    archivedAt: null,
    treeId,
    parentId,
    title: `private title ${id}`,
    note: `private note ${id}`,
  };
}

describe('commercial inventory', () => {
  it('exposes an injectable read-only runner without executing the CLI on import', async () => {
    const module = await inventoryModule().catch(
      (): Record<string, unknown> => ({}),
    );

    expect(module['runCommercialInventory']).toBeTypeOf('function');
  });

  it('is exposed as an explicit operational npm command', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts['commercial:inventory']).toBe(
      'node scripts/commercial-inventory.mjs',
    );
  });

  it('paginates structural scans, stays read-only and emits only aggregate drift', async () => {
    const { runCommercialInventory } = (await inventoryModule()) as {
      runCommercialInventory(options: Record<string, unknown>): Promise<any>;
    };
    const heartOne = syncRecord('nodes', node('heart-1', 'tree-1', null));
    const heartThree = syncRecord('nodes', node('heart-3', 'tree-3', null));
    const branches = Array.from({ length: 11 }, (_, index) =>
      syncRecord('nodes', node(`branch-${index}`, 'tree-1', 'heart-1')),
    );
    const profile = {
      pk: `USER#${OWNER}`,
      sk: 'PROFILE',
      status: 'active',
      accountType: 'adult',
      email: 'private@example.test',
      displayName: 'Private Person',
      username: 'private-user',
    };
    const malformed = syncRecord(
      'trees',
      {
        createdAt: 10,
        updatedAt: 20,
        rev: 1,
        deletedAt: null,
        archivedAt: null,
        heartId: null,
        name: 'must never leak',
      },
      { sk: 'REC#trees#wrong-id' },
    );
    const structureItems = [
      profile,
      syncRecord('trees', tree('tree-1', 'heart-1')),
      syncRecord('trees', tree('tree-2', null)),
      syncRecord('trees', tree('tree-3', 'heart-3')),
      malformed,
      heartOne,
      heartThree,
      ...branches,
    ];
    const structureCursor = { pk: 'opaque-structure-page', sk: 'CURSOR' };
    const nodeCursor = { pk: 'opaque-node-page', sk: 'CURSOR' };
    const responses = [
      {
        Items: structureItems.slice(0, 9),
        LastEvaluatedKey: structureCursor,
        ScannedCount: 9,
      },
      { Items: structureItems.slice(9), ScannedCount: 9 },
      {
        Items: [heartOne, ...branches.slice(0, 5)],
        LastEvaluatedKey: nodeCursor,
        ScannedCount: 6,
      },
      { Items: [...branches.slice(5), heartThree], ScannedCount: 7 },
    ];
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        commands.push({ name, input: command.input });
        if (name !== 'ScanCommand') throw new Error(`unexpected ${name}`);
        const response = responses.shift();
        if (!response) throw new Error('unexpected extra scan');
        return response;
      }),
    };
    const checkpoints: unknown[] = [];

    const manifest = await runCommercialInventory({
      stage: 'dev',
      tableName: 'roadmap-dev',
      ddb,
      loadCheckpoint: vi.fn(async () => null),
      saveCheckpoint: vi.fn(async (checkpoint) => checkpoints.push(checkpoint)),
    });

    expect(commands.map(({ name }) => name)).toEqual([
      'ScanCommand',
      'ScanCommand',
      'ScanCommand',
      'ScanCommand',
    ]);
    expect(commands[1].input.ExclusiveStartKey).toEqual(structureCursor);
    expect(commands[3].input.ExclusiveStartKey).toEqual(nodeCursor);
    for (const { input } of commands) {
      expect(input).toMatchObject({
        TableName: 'roadmap-dev',
        ConsistentRead: true,
        Select: 'SPECIFIC_ATTRIBUTES',
      });
      expect(input.ProjectionExpression).toBeTypeOf('string');
      expect(input.ExpressionAttributeNames).toMatchObject({
        '#record': 'record',
        '#id': 'id',
        '#heartId': 'heartId',
        '#treeId': 'treeId',
        '#parentId': 'parentId',
      });
      expect(
        JSON.stringify({
          projection: input.ProjectionExpression,
          names: input.ExpressionAttributeNames,
        }),
      ).not.toMatch(/title|note|email|displayName|username|trigger/i);
      expect(Object.values(input.ExpressionAttributeNames as object)).not.toContain(
        'name',
      );
    }
    expect(commands[2].input.FilterExpression).toBe('#store = :nodes');
    expect(commands[2].input.ExpressionAttributeValues).toEqual({ ':nodes': 'nodes' });
    expect(checkpoints.length).toBeGreaterThanOrEqual(4);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      operation: 'commercial-inventory',
      mode: 'dry-run',
      stage: 'dev',
      resources: { primaryTable: 'roadmap-dev' },
      scan: { passes: 2, pages: 4, scannedItems: 31, returnedItems: 31 },
      totals: {
        profiles: 1,
        recordItems: 17,
        validRecords: 16,
        ownersEvaluated: 1,
        activeTrees: 3,
        visibleBranches: 11,
      },
      classifications: {
        missingHeart: { trees: 1 },
        invalidRecordShape: { records: 1 },
        profileWithoutCreationTimestamp: { profiles: 1 },
        overQuota: {
          activeTreeLimit: 2,
          visibleBranchLimit: 10,
          owners: 1,
          treesOnly: 0,
          branchesOnly: 0,
          both: 1,
        },
      },
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /owner-sensitive|tree-[123]|heart-[13]|branch-|private|@example|wrong-id/i,
    );
  });

  it('rejects a checkpoint from another stage before issuing a scan', async () => {
    const { runCommercialInventory } = (await inventoryModule()) as {
      runCommercialInventory(options: Record<string, unknown>): Promise<any>;
    };
    const ddb = { send: vi.fn() };
    const foreignCheckpoint = {
      schemaVersion: 1,
      operation: 'commercial-inventory',
      stage: 'prod',
      tableName: 'roadmap-prod',
      phase: 'complete',
      state: {
        scan: { pages: 0, scannedItems: 0, returnedItems: 0 },
        profiles: 0,
        recordItems: 0,
        validRecords: 0,
        profileWithoutCreationTimestamp: 0,
        invalidRecordShape: 0,
        owners: {},
        trees: {},
      },
    };

    await expect(
      runCommercialInventory({
        stage: 'dev',
        tableName: 'roadmap-dev',
        ddb,
        loadCheckpoint: async () => foreignCheckpoint,
      }),
    ).rejects.toThrow('checkpoint stage does not match this run');
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('resumes deterministically from the saved cursor and aggregate state', async () => {
    const { runCommercialInventory } = (await inventoryModule()) as {
      runCommercialInventory(options: Record<string, unknown>): Promise<any>;
    };
    const cursor = { pk: 'opaque-page', sk: 'CURSOR' };
    const profile = {
      pk: `USER#${OWNER}`,
      sk: 'PROFILE',
      createdAt: 1,
      username: 'never-persist-me',
    };
    const storedTree = syncRecord('trees', tree('resume-tree', 'resume-heart'));
    const storedHeart = syncRecord(
      'nodes',
      node('resume-heart', 'resume-tree', null),
    );
    const structurePageOne = {
      Items: [profile, storedTree],
      LastEvaluatedKey: cursor,
      ScannedCount: 2,
    };
    const structurePageTwo = { Items: [storedHeart], ScannedCount: 1 };
    const nodePage = { Items: [storedHeart], ScannedCount: 1 };

    function ddbWith(responses: Array<Record<string, unknown> | Error>) {
      return {
        send: vi.fn(async (command: any) => {
          if (command.constructor.name !== 'ScanCommand') {
            throw new Error(`unexpected ${command.constructor.name}`);
          }
          const response = responses.shift();
          if (response instanceof Error) throw response;
          if (!response) throw new Error('unexpected extra scan');
          return response;
        }),
      };
    }

    const clean = await runCommercialInventory({
      stage: 'dev',
      tableName: 'roadmap-dev',
      ddb: ddbWith([structurePageOne, structurePageTwo, nodePage]),
    });

    let savedCheckpoint: any;
    await expect(
      runCommercialInventory({
        stage: 'dev',
        tableName: 'roadmap-dev',
        ddb: ddbWith([structurePageOne, new Error('simulated interruption')]),
        saveCheckpoint: async (checkpoint: unknown) => {
          savedCheckpoint = checkpoint;
        },
      }),
    ).rejects.toThrow('simulated interruption');
    expect(savedCheckpoint).toMatchObject({
      schemaVersion: 1,
      operation: 'commercial-inventory',
      stage: 'dev',
      tableName: 'roadmap-dev',
      phase: 'structure',
      cursor,
      checkpointHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(savedCheckpoint.state)).not.toMatch(
      /owner-sensitive|resume-tree|resume-heart|never-persist/i,
    );

    const tampered = structuredClone(savedCheckpoint);
    tampered.state.profiles += 1;
    const mustNotScan = { send: vi.fn() };
    await expect(
      runCommercialInventory({
        stage: 'dev',
        tableName: 'roadmap-dev',
        ddb: mustNotScan,
        loadCheckpoint: async () => tampered,
      }),
    ).rejects.toThrow('checkpoint hash does not match its contents');
    expect(mustNotScan.send).not.toHaveBeenCalled();

    const resumedDdb = ddbWith([structurePageTwo, nodePage]);
    const resumed = await runCommercialInventory({
      stage: 'dev',
      tableName: 'roadmap-dev',
      ddb: resumedDdb,
      loadCheckpoint: async () => savedCheckpoint,
    });

    expect(resumed).toEqual(clean);
    expect((resumedDdb.send.mock.calls[0][0] as any).input.ExclusiveStartKey).toEqual(
      cursor,
    );
  });

  it('applies the branch limit per tree and inventories missing hearts on restorable archives', async () => {
    const { runCommercialInventory } = (await inventoryModule()) as {
      runCommercialInventory(options: Record<string, unknown>): Promise<any>;
    };
    const activeTrees = [
      syncRecord('trees', tree('quota-tree-a', 'quota-heart-a')),
      syncRecord('trees', tree('quota-tree-b', 'quota-heart-b')),
    ];
    const archived = syncRecord('trees', {
      ...tree('archived-tree', null),
      archivedAt: 100,
    });
    const tombstoned = syncRecord('trees', {
      ...tree('deleted-tree', null),
      deletedAt: 100,
    });
    const nodes = [
      syncRecord('nodes', node('quota-heart-a', 'quota-tree-a', null)),
      syncRecord('nodes', node('quota-heart-b', 'quota-tree-b', null)),
      ...Array.from({ length: 6 }, (_, index) =>
        syncRecord(
          'nodes',
          node(`quota-a-${index}`, 'quota-tree-a', 'quota-heart-a'),
        ),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        syncRecord(
          'nodes',
          node(`quota-b-${index}`, 'quota-tree-b', 'quota-heart-b'),
        ),
      ),
    ];
    const responses = [
      {
        Items: [...activeTrees, archived, tombstoned, ...nodes],
        ScannedCount: 18,
      },
      { Items: nodes, ScannedCount: 14 },
    ];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`unexpected ${command.constructor.name}`);
        }
        const response = responses.shift();
        if (!response) throw new Error('unexpected extra scan');
        return response;
      }),
    };

    const manifest = await runCommercialInventory({
      stage: 'dev',
      tableName: 'roadmap-dev',
      ddb,
    });

    expect(manifest).toMatchObject({
      totals: {
        trees: 4,
        restorableTrees: 3,
        activeTrees: 2,
        visibleBranches: 12,
      },
      classifications: {
        missingHeart: { trees: 1 },
        overQuota: {
          owners: 0,
          ownersOverActiveTreeLimit: 0,
          ownersOverBranchLimit: 0,
          treesOverVisibleBranchLimit: 0,
          treesOnly: 0,
          branchesOnly: 0,
          both: 0,
        },
      },
    });
  });

  it('runs the operational CLI only under the exact account, stage role and region', async () => {
    const {
      COMMERCIAL_INVENTORY_AUTHORIZATION_BLOCKER,
      runCommercialInventoryCli,
      withStableInventoryManifestHash,
    } = (await inventoryModule()) as {
      COMMERCIAL_INVENTORY_AUTHORIZATION_BLOCKER: {
        code: string;
        resolution: string;
      };
      runCommercialInventoryCli(options: Record<string, unknown>): Promise<number>;
      withStableInventoryManifestHash(manifest: Record<string, unknown>): any;
    };
    const checkpointPath = join(process.cwd(), '.local', 'inventory-checkpoint.json');
    const manifestPath = join(process.cwd(), '.local', 'inventory-manifest.json');
    const profile = 'private-operator-profile';
    const manifest = withStableInventoryManifestHash({
      schemaVersion: 1,
      operation: 'commercial-inventory',
      mode: 'dry-run',
      stage: 'dev',
      resources: { primaryTable: 'roadmap-dev' },
      scan: { passes: 2, pages: 2, scannedItems: 12, returnedItems: 4 },
      totals: {
        profiles: 1,
        recordItems: 3,
        validRecords: 3,
        ownersEvaluated: 1,
        trees: 1,
        restorableTrees: 1,
        activeTrees: 1,
        visibleBranches: 2,
      },
      classifications: {
        missingHeart: { trees: 0 },
        invalidRecordShape: { records: 0 },
        profileWithoutCreationTimestamp: { profiles: 0 },
        overQuota: {
          activeTreeLimit: 2,
          visibleBranchLimit: 10,
          owners: 0,
          ownersOverActiveTreeLimit: 0,
          ownersOverBranchLimit: 0,
          treesOverVisibleBranchLimit: 0,
          treesOnly: 0,
          branchesOnly: 0,
          both: 0,
        },
      },
    });
    const storedCheckpoint = { checkpointHash: 'b'.repeat(64) };
    const writtenCheckpoint = { checkpointHash: 'c'.repeat(64) };
    const ddb = { send: vi.fn() };
    const destroy = vi.fn();
    const getCallerIdentity = vi.fn(async () => ({
      Account: '765932874577',
      Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/private-session',
    }));
    const createDdb = vi.fn(async () => ({
      ddb,
      region: 'us-east-1',
      destroy,
    }));
    const readJsonFile = vi.fn(async () => storedCheckpoint);
    const writeJsonFile = vi.fn(async () => undefined);
    const runInventory = vi.fn(async (options: any) => {
      expect(options).toMatchObject({
        stage: 'dev',
        tableName: 'roadmap-dev',
        ddb,
      });
      expect(await options.loadCheckpoint()).toBe(storedCheckpoint);
      await options.saveCheckpoint(writtenCheckpoint);
      return manifest;
    });
    const lines: string[] = [];

    await expect(
      runCommercialInventoryCli({
        argv: [
          '--stage', 'dev',
          '--profile', profile,
          '--checkpoint-file', checkpointPath,
          '--manifest-file', manifestPath,
        ],
        write: (line: string) => lines.push(line),
        getCallerIdentity,
        createDdb,
        runInventory,
        readJsonFile,
        writeJsonFile,
      }),
    ).resolves.toBe(0);

    expect(getCallerIdentity).toHaveBeenCalledWith(profile, 'us-east-1');
    expect(createDdb).toHaveBeenCalledWith(profile, 'us-east-1');
    expect(readJsonFile).toHaveBeenCalledWith(checkpointPath);
    expect(writeJsonFile).toHaveBeenCalledWith(checkpointPath, writtenCheckpoint);
    expect(writeJsonFile).toHaveBeenCalledWith(manifestPath, manifest);
    expect(destroy).toHaveBeenCalledOnce();
    expect(lines).toEqual([
      'commercial-inventory mode=dry-run stage=dev region=us-east-1',
      `authorizationBlocker=${COMMERCIAL_INVENTORY_AUTHORIZATION_BLOCKER.code}`,
      `manifestHash=${manifest.manifestHash}`,
      'totals profiles=1 records=3 activeTrees=1 visibleBranches=2',
      'classifications missingHeart=0 invalidRecordShape=0 profileWithoutCreationTimestamp=0 overQuotaOwners=0',
    ]);
    expect(lines.join('\n')).not.toMatch(
      /private|assumed-role|checkpoint|manifest\.json|treeId|record\.id/i,
    );
  });

  it('rejects mutation flags, wrong identities and a non-us-east-1 connection before inventory', async () => {
    const { runCommercialInventoryCli } = (await inventoryModule()) as {
      runCommercialInventoryCli(options: Record<string, unknown>): Promise<number>;
    };
    const baseArgv = [
      '--stage', 'test',
      '--checkpoint-file', join(process.cwd(), '.local', 'checkpoint.json'),
      '--manifest-file', join(process.cwd(), '.local', 'manifest.json'),
    ];
    const getCallerIdentity = vi.fn();

    await expect(
      runCommercialInventoryCli({
        argv: [...baseArgv, '--apply'],
        getCallerIdentity,
      }),
    ).rejects.toThrow('unknown option --apply');
    expect(getCallerIdentity).not.toHaveBeenCalled();

    const createDdb = vi.fn();
    await expect(
      runCommercialInventoryCli({
        argv: baseArgv,
        getCallerIdentity: async () => ({
          Account: '000000000000',
          Arn: 'arn:aws:sts::000000000000:assumed-role/roadmap2u-test-commercial-migration/session',
        }),
        createDdb,
      }),
    ).rejects.toThrow('AWS account must be 765932874577');
    expect(createDdb).not.toHaveBeenCalled();

    await expect(
      runCommercialInventoryCli({
        argv: baseArgv,
        getCallerIdentity: async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        }),
        createDdb,
      }),
    ).rejects.toThrow('caller does not match the selected stage migration role');
    expect(createDdb).not.toHaveBeenCalled();

    const destroy = vi.fn();
    const runInventory = vi.fn();
    await expect(
      runCommercialInventoryCli({
        argv: baseArgv,
        getCallerIdentity: async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-test-commercial-migration/session',
        }),
        createDdb: async () => ({
          ddb: { send: vi.fn() },
          region: 'us-west-2',
          destroy,
        }),
        runInventory,
      }),
    ).rejects.toThrow('DynamoDB region must be us-east-1');
    expect(runInventory).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('contains no DynamoDB mutation command and documents the nested-map IAM blocker', async () => {
    const module = (await inventoryModule()) as Record<string, any>;
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'commercial-inventory.mjs'),
      'utf8',
    );

    expect(source).not.toMatch(
      /\b(?:Put|Update|Delete|TransactWrite|BatchWrite)Command\b/,
    );
    expect(module.COMMERCIAL_INVENTORY_AUTHORIZATION_BLOCKER).toEqual({
      code: 'NESTED_RECORD_PROJECTION_REQUIRES_TOP_LEVEL_RECORD_AUTHORIZATION',
      resolution: 'broker-or-explicit-record-map-exception-required-before-live-use',
    });
  });
});
