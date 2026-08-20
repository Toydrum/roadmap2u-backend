import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

async function executorModule(): Promise<Record<string, any>> {
  return import(
    pathToFileURL(
      join(process.cwd(), 'lambda', 'commercial-inventory-executor.mjs'),
    ).href
  );
}

async function sanitizedManifest(): Promise<Record<string, any>> {
  const inventory = (await import(
    pathToFileURL(
      join(process.cwd(), 'scripts', 'commercial-inventory.mjs'),
    ).href
  )) as Record<string, any>;
  return inventory.withStableInventoryManifestHash({
    schemaVersion: 1,
    operation: 'commercial-inventory',
    mode: 'dry-run',
    stage: 'dev',
    resources: { primaryTable: 'roadmap-dev' },
    scan: { passes: 2, pages: 4, scannedItems: 30, returnedItems: 18 },
    totals: {
      profiles: 2,
      recordItems: 16,
      validRecords: 15,
      ownersEvaluated: 2,
      trees: 3,
      restorableTrees: 3,
      activeTrees: 2,
      visibleBranches: 9,
    },
    classifications: {
      missingHeart: { trees: 1 },
      invalidRecordShape: { records: 1 },
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
}

const ACCOUNT = '765932874577';
const ROLE = 'roadmap2u-dev-commercial-migration';
const ACTOR = `arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/private-session`;

function event(
  body: Record<string, unknown> = {
    command: 'commercial-inventory',
    stage: 'dev',
  },
  actor = ACTOR,
  method = 'POST',
): Record<string, unknown> {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'inventory-request-1',
      http: { method },
      authorizer: { iam: { userArn: actor } },
    },
  };
}

describe('commercial inventory executor', () => {
  it('runs the fixed inventory once for an exact IAM actor/request and returns only the aggregate manifest', async () => {
    const { createCommercialInventoryExecutor } = await executorModule();
    const manifest = await sanitizedManifest();
    const ddb = { send: vi.fn() };
    const runInventory = vi.fn(async (options: Record<string, any>) => {
      expect(options).toMatchObject({
        stage: 'dev',
        tableName: 'roadmap-dev',
        ddb,
      });
      expect(options).not.toHaveProperty('cursor');
      expect(options).not.toHaveProperty('checkpoint');
      await options.beforePage();
      return manifest;
    });
    const execute = createCommercialInventoryExecutor({
      stage: 'dev',
      tableName: 'roadmap-dev',
      accountId: ACCOUNT,
      roleName: ROLE,
      ddb,
      runInventory,
    });

    const response = await execute(event(), {
      getRemainingTimeInMillis: () => 120_000,
    });

    expect(runInventory).toHaveBeenCalledOnce();
    expect(response).toEqual({
      statusCode: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json',
      },
      body: JSON.stringify(manifest),
    });
    expect(response.body).not.toMatch(
      /private-session|treeId|record\.id|title|note|email|displayName|username/i,
    );
    expect(response.body).not.toMatch(/"owner"\s*:/i);
  });

  it.each([
    ['wrong actor', event(undefined, `arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}-evil/session`), 403],
    ['missing actor', event(undefined, ''), 401],
    ['wrong method', event(undefined, ACTOR, 'GET'), 405],
    ['wrong stage', event({ command: 'commercial-inventory', stage: 'prod' }), 400],
    ['wrong command', event({ command: 'scan', stage: 'dev' }), 400],
    ['cursor injection', event({ command: 'commercial-inventory', stage: 'dev', cursor: {} }), 400],
    ['extra data', event({ command: 'commercial-inventory', stage: 'dev', data: 'private' }), 400],
  ])('rejects %s before scanning', async (_name, request, statusCode) => {
    const { createCommercialInventoryExecutor } = await executorModule();
    const runInventory = vi.fn();
    const execute = createCommercialInventoryExecutor({
      stage: 'dev',
      tableName: 'roadmap-dev',
      accountId: ACCOUNT,
      roleName: ROLE,
      ddb: { send: vi.fn() },
      runInventory,
    });

    await expect(
      execute(request, { getRemainingTimeInMillis: () => 120_000 }),
    ).resolves.toMatchObject({ statusCode });
    expect(runInventory).not.toHaveBeenCalled();
  });

  it('fails without returning a partial manifest when the single-invocation deadline is unsafe', async () => {
    const { createCommercialInventoryExecutor } = await executorModule();
    const runInventory = vi.fn(async (options: Record<string, any>) => {
      await options.beforePage();
      return sanitizedManifest();
    });
    const execute = createCommercialInventoryExecutor({
      stage: 'dev',
      tableName: 'roadmap-dev',
      accountId: ACCOUNT,
      roleName: ROLE,
      ddb: { send: vi.fn() },
      runInventory,
    });

    await expect(
      execute(event(), { getRemainingTimeInMillis: () => 29_999 }),
    ).rejects.toThrow('single-invocation deadline');
  });

  it('keeps the executor fixed to the runner and the shared redacted instrumentation', () => {
    const source = readFileSync(
      join(process.cwd(), 'lambda', 'commercial-inventory-executor.mjs'),
      'utf8',
    );

    expect(source).toContain("runCommercialInventory");
    expect(source).toContain("instrumentHandler('commercial-inventory-executor'");
    expect(source).not.toMatch(
      /\b(?:Put|Update|Delete|Query|Get|BatchWrite|TransactWrite)Command\b/,
    );
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
  });
});
