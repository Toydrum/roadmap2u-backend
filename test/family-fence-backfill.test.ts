import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

async function migrationModule(): Promise<Record<string, unknown>> {
  const url = pathToFileURL(
    join(process.cwd(), 'scripts', 'family-fence-backfill.mjs'),
  ).href;
  return import(url) as Promise<Record<string, unknown>>;
}

describe('family fence backfill', () => {
  it('exposes a testable migration runner without executing the CLI on import', async () => {
    const module: Record<string, unknown> = await migrationModule().catch(
      (): Record<string, unknown> => ({}),
    );

    expect(module['runFamilyFenceMigration']).toBeTypeOf('function');
  });

  it('is exposed as an explicit operational npm command', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts['commercial:family-fence']).toBe(
      'node scripts/family-fence-backfill.mjs',
    );
  });

  it('paginates both consistent scans and dry-run performs zero writes or checkpoints', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'adult-sensitive-id';
    const minorId = 'minor-sensitive-id';
    const createdLink = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const adultProfile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
    };
    const pageOne = { pk: 'opaque-page-one', sk: 'CURSOR' };
    const responses = [
      { Items: [createdLink], LastEvaluatedKey: pageOne, ScannedCount: 11 },
      { Items: [adultProfile], ScannedCount: 7 },
      { Items: [createdLink], LastEvaluatedKey: pageOne, ScannedCount: 11 },
      { Items: [adultProfile], ScannedCount: 7 },
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
    const saveCheckpoint = vi.fn(async () => undefined);

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: false,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint,
    });

    expect(commands.map(({ name }) => name)).toEqual([
      'ScanCommand',
      'ScanCommand',
      'ScanCommand',
      'ScanCommand',
    ]);
    expect(commands.map(({ input }) => input)).toEqual([
      expect.objectContaining({
        TableName: 'roadmap-dev',
        ConsistentRead: true,
      }),
      expect.objectContaining({
        TableName: 'roadmap-dev',
        ConsistentRead: true,
        ExclusiveStartKey: pageOne,
      }),
      expect.objectContaining({
        TableName: 'roadmap-dev',
        ConsistentRead: true,
      }),
      expect.objectContaining({
        TableName: 'roadmap-dev',
        ConsistentRead: true,
        ExclusiveStartKey: pageOne,
      }),
    ]);
    for (const { input } of commands) {
      expect(input.ProjectionExpression).toEqual(
        expect.stringContaining('familyFenceVersion'),
      );
      expect(input.ProjectionExpression).toEqual(
        expect.stringContaining('createdMinorIds'),
      );
      expect(input.Select).toBe('SPECIFIC_ATTRIBUTES');
      expect(String(input.ProjectionExpression)).not.toContain('email');
      expect(String(input.ProjectionExpression)).not.toContain('username');
      expect(String(input.ProjectionExpression)).not.toContain('record');
      expect(input.ExpressionAttributeNames).toMatchObject({
        '#kind': 'kind',
        '#status': 'status',
      });
    }
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      operation: 'backfill',
      mode: 'dry-run',
      scannedPages: 4,
      scannedItems: 36,
      seed: { candidates: 1, wouldApply: 1, applied: 0 },
      finalize: { eligible: 1, wouldApply: 1, applied: 0 },
      drift: { total: 0 },
      writes: 0,
    });
  });

  it('seeds each exact created link and finalizes the exact set with closure guards and append-only audit', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-apply';
    const minorId = 'minor-apply';
    const migrationStartedAt = 1_800_000_000_123;
    const now = vi.fn(() => migrationStartedAt);
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
      createdMinorIds: new Set([minorId]),
    };
    const scanResponses = [
      { Items: [link], ScannedCount: 2 },
      { Items: [link, profile], ScannedCount: 2 },
    ];
    const transactions: any[] = [];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          const response = scanResponses.shift();
          if (!response) throw new Error('unexpected scan');
          return response;
        }
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input);
          return {};
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      now,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(transactions).toHaveLength(2);
    expect(
      transactions.filter((transaction) =>
        transaction.TransactItems.some(
          (item: any) => item.Put?.Item?.action === 'family_fence_finalize',
        ),
      ),
    ).toHaveLength(1);
    expect(now).toHaveBeenCalledOnce();
    const seedItems = transactions[0].TransactItems;
    expect(seedItems).toHaveLength(4);
    expect(seedItems[0].ConditionCheck).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: link.pk, sk: link.sk },
      ExpressionAttributeValues: expect.objectContaining({
        ':kind': 'created',
        ':guardianId': guardianId,
        ':minorId': minorId,
        ':linkId': link.linkId,
        ':createdAt': link.createdAt,
        ':gsi1pk': link.gsi1pk,
        ':gsi1sk': link.gsi1sk,
      }),
    });
    expect(seedItems[0].ConditionCheck.ConditionExpression).toContain('gsi1sk = :gsi1sk');
    expect(seedItems[1].ConditionCheck).toEqual({
      TableName: 'roadmap-dev',
      Key: { pk: `ACCOUNT_CLOSURE#${guardianId}`, sk: 'STATE' },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(seedItems[2].Update).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: `USER#${guardianId}`, sk: 'PROFILE' },
      UpdateExpression: 'ADD createdMinorIds :createdMinorIds',
      ExpressionAttributeValues: expect.objectContaining({
        ':adult': 'adult',
        ':active': 'active',
        ':createdMinorIds': new Set([minorId]),
      }),
    });
    expect(seedItems[2].Update.ConditionExpression).toContain(
      'attribute_not_exists(familyFenceVersion)',
    );
    expect(seedItems[2].Update.ConditionExpression).toContain(
      'NOT contains(createdMinorIds, :minorId)',
    );
    expect(seedItems[3].Put).toMatchObject({
      TableName: 'roadmap-access-audit-dev',
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(JSON.stringify(seedItems[3].Put.Item)).not.toContain(guardianId);
    expect(JSON.stringify(seedItems[3].Put.Item)).not.toContain(minorId);
    expect(seedItems[3].Put.Item).toMatchObject({
      timestamp: migrationStartedAt,
      action: 'family_fence_seed',
    });
    expect(seedItems[3].Put.Item.sk).toContain(`EVENT#${migrationStartedAt}#`);
    expect(seedItems[3].Put.Item.timestamp).not.toBe(link.createdAt);

    const finalizeItems = transactions[1].TransactItems;
    expect(finalizeItems).toHaveLength(4);
    expect(finalizeItems[0].ConditionCheck.Key).toEqual({
      pk: `ACCOUNT_CLOSURE#${guardianId}`,
      sk: 'STATE',
    });
    expect(finalizeItems[1].ConditionCheck.Key).toEqual({ pk: link.pk, sk: link.sk });
    expect(finalizeItems[2].Update).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: `USER#${guardianId}`, sk: 'PROFILE' },
      UpdateExpression: 'SET familyFenceVersion = :familyFenceVersion',
      ExpressionAttributeValues: expect.objectContaining({
        ':familyFenceVersion': 1,
        ':expectedSize': 1,
        ':minor0': minorId,
      }),
    });
    expect(finalizeItems[2].Update.ConditionExpression).toContain(
      'size(createdMinorIds) = :expectedSize',
    );
    expect(finalizeItems[2].Update.ConditionExpression).toContain(
      'contains(createdMinorIds, :minor0)',
    );
    expect(finalizeItems[2].Update.ConditionExpression).toContain(
      'attribute_type(createdMinorIds, :stringSetType)',
    );
    expect(finalizeItems[2].Update.ExpressionAttributeValues).toMatchObject({
      ':stringSetType': 'SS',
    });
    expect(finalizeItems[3].Put.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
    expect(finalizeItems[3].Put.Item).toMatchObject({
      timestamp: migrationStartedAt,
      action: 'family_fence_finalize',
    });
    expect(finalizeItems[3].Put.Item.sk).toContain(`EVENT#${migrationStartedAt}#`);
    expect(finalizeItems[3].Put.Item.timestamp).not.toBe(profile.createdAt);
    expect(manifest).toMatchObject({
      seed: { candidates: 1, applied: 1 },
      finalize: { eligible: 1, applied: 1 },
      drift: { total: 0 },
      writes: 2,
    });
  });

  it('treats conditional losses to another backfill runner as idempotent after strong exact reads', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-concurrent';
    const minorId = 'minor-concurrent';
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const legacyProfile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      createdAt: 50,
      createdMinorIds: new Set([minorId]),
    };
    const authoritativeProfile = { ...legacyProfile, familyFenceVersion: 1 };
    const scans = [
      { Items: [link], ScannedCount: 2 },
      { Items: [link, legacyProfile], ScannedCount: 2 },
    ];
    let transactionNumber = 0;
    let profileReadNumber = 0;
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          transactionNumber += 1;
          throw Object.assign(new Error('lost conditional race'), {
            name: 'TransactionCanceledException',
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          expect(command.input.ConsistentRead).toBe(true);
          expect(command.input.ProjectionExpression).toEqual(
            expect.stringContaining('familyFenceVersion'),
          );
          expect(String(command.input.ProjectionExpression)).not.toContain('email');
          if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
          if (key.pk === `USER#${guardianId}` && key.sk === 'PROFILE') {
            profileReadNumber += 1;
            return {
              Item: profileReadNumber === 1 ? legacyProfile : authoritativeProfile,
            };
          }
          if (key.pk === `ACCOUNT_CLOSURE#${guardianId}`) return {};
          throw new Error(`unexpected get ${JSON.stringify(key)}`);
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(transactionNumber).toBe(2);
    expect(manifest).toMatchObject({
      seed: { candidates: 1, applied: 0, alreadyApplied: 1 },
      finalize: { eligible: 1, applied: 0, alreadyApplied: 1 },
      drift: { total: 0 },
      writes: 0,
    });
  });

  it('does not publish a fence when a created link changes during the final CAS', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-race';
    const minorId = 'minor-race';
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      createdAt: 50,
      createdMinorIds: new Set([minorId]),
    };
    const scans = [
      { Items: [link], ScannedCount: 2 },
      { Items: [link, profile], ScannedCount: 2 },
    ];
    let transactionNumber = 0;
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          transactionNumber += 1;
          if (transactionNumber === 1) return {};
          throw Object.assign(new Error('link was deleted'), {
            name: 'TransactionCanceledException',
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          expect(command.input.ConsistentRead).toBe(true);
          if (key.pk === `USER#${guardianId}` && key.sk === 'PROFILE') {
            return { Item: { ...profile, createdMinorIds: undefined } };
          }
          if (key.pk === link.pk && key.sk === link.sk) return {};
          if (key.pk === `ACCOUNT_CLOSURE#${guardianId}`) return {};
          throw new Error(`unexpected get ${JSON.stringify(key)}`);
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest).toMatchObject({
      finalize: { applied: 0, alreadyApplied: 0 },
      drift: { total: 1, reasons: { link_changed: 1 } },
      writes: 1,
    });
  });

  it('does not publish a fence when account closure starts after the exact snapshot', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-finalize-closure';
    const minorId = 'minor-finalize-closure';
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
      createdMinorIds: new Set([minorId]),
    };
    const closure = { pk: `ACCOUNT_CLOSURE#${guardianId}`, sk: 'STATE' };
    const scans = [
      { Items: [link], ScannedCount: 1 },
      { Items: [link, profile], ScannedCount: 2 },
    ];
    let transactionNumber = 0;
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          transactionNumber += 1;
          if (transactionNumber === 1) return {};
          throw Object.assign(new Error('closure guard won'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          expect(command.input.ConsistentRead).toBe(true);
          if (key.pk === closure.pk) return { Item: closure };
          if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
          if (key.sk === 'PROFILE') return { Item: profile };
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest).toMatchObject({
      finalize: { applied: 0, alreadyApplied: 0 },
      drift: { total: 1, reasons: { closure_present: 1 } },
      writes: 1,
    });
  });

  it('resumes the seed scan from a validated checkpoint and always restarts the exact snapshot', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-resume';
    const minorId = 'minor-resume';
    const cursor = { pk: 'USER#private-checkpoint', sk: 'GUARDIAN#private-checkpoint' };
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      createdAt: 50,
      createdMinorIds: new Set([minorId]),
    };
    const scanInputs: any[] = [];
    const scans = [
      { Items: [link], ScannedCount: 1 },
      { Items: [link, profile], ScannedCount: 2 },
    ];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          scanInputs.push(command.input);
          return scans.shift();
        }
        if (command.constructor.name === 'TransactWriteCommand') return {};
        throw new Error(`unexpected ${command.constructor.name}`);
      }),
    };
    const loadCheckpoint = vi.fn(async () => ({
      schemaVersion: 1,
      operation: 'backfill',
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      phase: 'seed',
      cursor,
    }));
    const checkpoints: any[] = [];

    await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      loadCheckpoint,
      saveCheckpoint: vi.fn(async (checkpoint: any) => checkpoints.push(checkpoint)),
    });

    expect(loadCheckpoint).toHaveBeenCalledOnce();
    expect(scanInputs).toEqual([
      expect.objectContaining({
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }),
      expect.objectContaining({ ConsistentRead: true }),
    ]);
    expect(scanInputs[1]).not.toHaveProperty('ExclusiveStartKey');
    expect(checkpoints.at(-2)).toMatchObject({ phase: 'snapshot' });
    expect(checkpoints.at(-1)).toMatchObject({ phase: 'complete' });
  });

  it('returns a stable aggregate manifest hash without ids, cursors, or PII', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    async function run(guardianId: string, minorId: string) {
      const link = {
        pk: `USER#${minorId}`,
        sk: `GUARDIAN#${guardianId}`,
        gsi1pk: `USER#${guardianId}`,
        gsi1sk: `MINOR#${minorId}`,
        linkId: `${guardianId}~${minorId}`,
        kind: 'created',
        guardianId,
        minorId,
        createdAt: 100,
      };
      const profile = {
        pk: `USER#${guardianId}`,
        sk: 'PROFILE',
        userId: guardianId,
        accountType: 'adult',
        createdAt: 50,
      };
      const scans = [
        { Items: [link], ScannedCount: 2 },
        { Items: [link, profile], ScannedCount: 2 },
      ];
      return runFamilyFenceMigration({
        operation: 'backfill',
        apply: false,
        stage: 'dev',
        tableName: 'roadmap-dev',
        auditTableName: 'roadmap-access-audit-dev',
        ddb: {
          send: vi.fn(async (command: any) => {
            if (command.constructor.name !== 'ScanCommand') {
              throw new Error(`unexpected ${command.constructor.name}`);
            }
            return scans.shift();
          }),
        },
      });
    }

    const first = await run('guardian-private-one', 'minor-private-one');
    const second = await run('guardian-private-two', 'minor-private-two');

    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifestHash).toBe(second.manifestHash);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('guardian-private-one');
    expect(serialized).not.toContain('minor-private-one');
    expect(serialized).not.toContain('USER#');
    expect(serialized).not.toContain('CURSOR');
    expect(first).toMatchObject({
      stage: 'dev',
      resources: {
        primaryTable: 'roadmap-dev',
        auditTable: 'roadmap-access-audit-dev',
      },
    });
  });

  it('reconcile reports authoritative, legacy, unknown, missing, and closing drift without correcting it', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const correctLink = {
      pk: 'USER#minor-correct',
      sk: 'GUARDIAN#guardian-correct',
      gsi1pk: 'USER#guardian-correct',
      gsi1sk: 'MINOR#minor-correct',
      linkId: 'guardian-correct~minor-correct',
      kind: 'created',
      guardianId: 'guardian-correct',
      minorId: 'minor-correct',
      createdAt: 100,
    };
    const orphanLink = {
      ...correctLink,
      pk: 'USER#minor-orphan',
      sk: 'GUARDIAN#guardian-missing',
      gsi1pk: 'USER#guardian-missing',
      gsi1sk: 'MINOR#minor-orphan',
      linkId: 'guardian-missing~minor-orphan',
      guardianId: 'guardian-missing',
      minorId: 'minor-orphan',
    };
    const closingLink = {
      ...correctLink,
      pk: 'USER#minor-closing',
      sk: 'GUARDIAN#guardian-closing',
      gsi1pk: 'USER#guardian-closing',
      gsi1sk: 'MINOR#minor-closing',
      linkId: 'guardian-closing~minor-closing',
      guardianId: 'guardian-closing',
      minorId: 'minor-closing',
    };
    const profiles = [
      {
        pk: 'USER#guardian-correct',
        sk: 'PROFILE',
        userId: 'guardian-correct',
        accountType: 'adult',
        createdAt: 1,
        familyFenceVersion: 1,
        createdMinorIds: new Set(['minor-correct']),
      },
      {
        pk: 'USER#guardian-mismatch',
        sk: 'PROFILE',
        userId: 'guardian-mismatch',
        accountType: 'adult',
        createdAt: 1,
        familyFenceVersion: 1,
        createdMinorIds: new Set(['minor-not-present']),
      },
      {
        pk: 'USER#guardian-legacy',
        sk: 'PROFILE',
        userId: 'guardian-legacy',
        accountType: 'adult',
        createdAt: 1,
      },
      {
        pk: 'USER#guardian-unknown',
        sk: 'PROFILE',
        userId: 'guardian-unknown',
        accountType: 'adult',
        createdAt: 1,
        familyFenceVersion: 2,
      },
      {
        pk: 'USER#guardian-closing',
        sk: 'PROFILE',
        userId: 'guardian-closing',
        accountType: 'adult',
        status: 'closing',
        createdAt: 1,
        createdMinorIds: new Set(['minor-closing']),
      },
    ];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`reconcile attempted ${command.constructor.name}`);
        }
        return {
          Items: [correctLink, orphanLink, closingLink, ...profiles],
          ScannedCount: 8,
        };
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'reconcile',
      apply: false,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
    });

    expect(manifest.drift).toMatchObject({
      total: 5,
      reasons: {
        authoritative_set_mismatch: 1,
        unmigrated_profile: 1,
        unknown_fence_version: 1,
        guardian_profile_missing: 1,
        guardian_profile_unwritable: 1,
      },
    });
    expect(manifest.writes).toBe(0);
    expect(ddb.send).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined, undefined, 'guardian_profile_missing'],
    [
      'closing',
      {
        pk: 'USER#guardian-guarded',
        sk: 'PROFILE',
        userId: 'guardian-guarded',
        accountType: 'adult',
        status: 'closing',
        createdAt: 1,
      },
      undefined,
      'guardian_profile_unwritable',
    ],
    [
      'closure',
      {
        pk: 'USER#guardian-guarded',
        sk: 'PROFILE',
        userId: 'guardian-guarded',
        accountType: 'adult',
        createdAt: 1,
      },
      { pk: 'ACCOUNT_CLOSURE#guardian-guarded', sk: 'STATE' },
      'closure_present',
    ],
  ])('continues safely when the guardian is %s during seed', async (_case, profile, closure, reason) => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const link = {
      pk: 'USER#minor-guarded',
      sk: 'GUARDIAN#guardian-guarded',
      gsi1pk: 'USER#guardian-guarded',
      gsi1sk: 'MINOR#minor-guarded',
      linkId: 'guardian-guarded~minor-guarded',
      kind: 'created',
      guardianId: 'guardian-guarded',
      minorId: 'minor-guarded',
      createdAt: 100,
    };
    const snapshotItems = [link, ...(profile ? [profile] : []), ...(closure ? [closure] : [])];
    const scans = [
      { Items: [link], ScannedCount: 1 },
      { Items: snapshotItems, ScannedCount: snapshotItems.length },
    ];
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          throw Object.assign(new Error('guard won'), {
            name: 'TransactionCanceledException',
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
          if (key.sk === 'PROFILE') return { Item: profile };
          if (key.pk.startsWith('ACCOUNT_CLOSURE#')) return { Item: closure };
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest.drift.reasons).toMatchObject({ [reason]: 1 });
    expect(manifest.writes).toBe(0);
  });

  it.each([
    [
      'unknown stage',
      {
        operation: 'backfill',
        apply: false,
        stage: 'staging',
        tableName: 'roadmap-staging',
        auditTableName: 'roadmap-access-audit-staging',
      },
      'stage must be dev, test, or prod',
    ],
    [
      'cross-stage primary table',
      {
        operation: 'backfill',
        apply: false,
        stage: 'dev',
        tableName: 'roadmap-prod',
        auditTableName: 'roadmap-access-audit-dev',
      },
      'primary table must exactly match the selected stage',
    ],
    [
      'cross-stage audit table',
      {
        operation: 'backfill',
        apply: false,
        stage: 'dev',
        tableName: 'roadmap-dev',
        auditTableName: 'roadmap-access-audit-prod',
      },
      'audit table must exactly match the selected stage',
    ],
    [
      'mutating reconcile',
      {
        operation: 'reconcile',
        apply: true,
        stage: 'dev',
        tableName: 'roadmap-dev',
        auditTableName: 'roadmap-access-audit-dev',
      },
      'reconcile is read-only',
    ],
  ])('fails closed for %s before reading DynamoDB', async (_case, options, message) => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const ddb = { send: vi.fn() };

    await expect(runFamilyFenceMigration({ ...options, ddb })).rejects.toThrow(message);
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid migration clock value %s before reading DynamoDB',
    async (clockValue) => {
      const { runFamilyFenceMigration } = (await migrationModule()) as {
        runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
      };
      const ddb = { send: vi.fn() };

      await expect(
        runFamilyFenceMigration({
          operation: 'backfill',
          apply: false,
          stage: 'dev',
          tableName: 'roadmap-dev',
          auditTableName: 'roadmap-access-audit-dev',
          ddb,
          now: () => clockValue,
        }),
      ).rejects.toThrow('migration clock must return a non-negative safe integer');
      expect(ddb.send).not.toHaveBeenCalled();
    },
  );

  it('CLI dry-run validates the migration identity, emits only the aggregate manifest, and writes no files', async () => {
    const { runFamilyFenceCli } = (await migrationModule()) as {
      runFamilyFenceCli(options: Record<string, unknown>): Promise<number>;
    };
    const output: string[] = [];
    const runMigration = vi.fn(async (options: any) => {
      expect(options).toMatchObject({
        operation: 'backfill',
        apply: false,
        stage: 'dev',
        tableName: 'roadmap-dev',
        auditTableName: 'roadmap-access-audit-dev',
      });
      return {
        schemaVersion: 1,
        operation: 'backfill',
        mode: 'dry-run',
        stage: 'dev',
        writes: 0,
        manifestHash: 'a'.repeat(64),
      };
    });
    const readJsonFile = vi.fn();
    const writeJsonFile = vi.fn();
    const destroy = vi.fn();

    await expect(
      runFamilyFenceCli({
        argv: ['--operation', 'backfill', '--stage', 'dev'],
        write: (line: string) => output.push(line),
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(() => ({ ddb: { send: vi.fn() }, destroy })),
        runMigration,
        readJsonFile,
        writeJsonFile,
      }),
    ).resolves.toBe(0);

    expect(runMigration).toHaveBeenCalledOnce();
    expect(readJsonFile).not.toHaveBeenCalled();
    expect(writeJsonFile).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(output).toContain('manifestHash=' + 'a'.repeat(64));
    expect(output.join('\n')).not.toContain('session');
  });

  it('CLI apply requires the matching dry-run hash and wires durable checkpoint plus aggregate manifest files', async () => {
    const { runFamilyFenceCli } = (await migrationModule()) as {
      runFamilyFenceCli(options: Record<string, unknown>): Promise<number>;
    };
    const dryHash = 'b'.repeat(64);
    const checkpointPath = 'C:\\secure\\family-fence.checkpoint.json';
    const manifestPath = 'C:\\evidence\\family-fence.manifest.json';
    const savedCheckpoint = {
      schemaVersion: 1,
      operation: 'backfill',
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      phase: 'seed',
      cursor: { pk: 'USER#private', sk: 'PROFILE' },
    };
    const nextCheckpoint = { ...savedCheckpoint, phase: 'snapshot', cursor: undefined };
    const appliedManifest = {
      schemaVersion: 1,
      operation: 'backfill',
      mode: 'apply',
      stage: 'dev',
      writes: 2,
      manifestHash: 'c'.repeat(64),
    };
    const runMigration = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        operation: 'backfill',
        mode: 'dry-run',
        stage: 'dev',
        writes: 0,
        manifestHash: dryHash,
      })
      .mockImplementationOnce(async (options: any) => {
        expect(options.apply).toBe(true);
        await expect(options.loadCheckpoint()).resolves.toEqual(savedCheckpoint);
        await options.saveCheckpoint(nextCheckpoint);
        return appliedManifest;
      });
    const readJsonFile = vi.fn(async (path: string) => {
      expect(path).toBe(checkpointPath);
      return savedCheckpoint;
    });
    const writeJsonFile = vi.fn(async () => undefined);

    await expect(
      runFamilyFenceCli({
        argv: [
          '--operation',
          'backfill',
          '--stage',
          'dev',
          '--apply',
          '--confirm-stage',
          'dev',
          '--confirm-hash',
          dryHash,
          '--checkpoint-file',
          checkpointPath,
          '--manifest-file',
          manifestPath,
        ],
        write: vi.fn(),
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(() => ({ ddb: { send: vi.fn() }, destroy: vi.fn() })),
        runMigration,
        readJsonFile,
        writeJsonFile,
      }),
    ).resolves.toBe(0);

    expect(runMigration).toHaveBeenCalledTimes(2);
    expect(writeJsonFile).toHaveBeenNthCalledWith(1, checkpointPath, nextCheckpoint);
    expect(writeJsonFile).toHaveBeenNthCalledWith(2, manifestPath, appliedManifest);
  });

  it('CLI never starts apply when stage or dry-run hash confirmation differs', async () => {
    const { runFamilyFenceCli } = (await migrationModule()) as {
      runFamilyFenceCli(options: Record<string, unknown>): Promise<number>;
    };
    const runMigration = vi.fn(async () => ({ manifestHash: 'd'.repeat(64) }));
    const writeJsonFile = vi.fn();

    await expect(
      runFamilyFenceCli({
        argv: [
          '--operation',
          'backfill',
          '--stage',
          'dev',
          '--apply',
          '--confirm-stage',
          'test',
          '--confirm-hash',
          'e'.repeat(64),
          '--checkpoint-file',
          'C:\\secure\\checkpoint.json',
          '--manifest-file',
          'C:\\secure\\manifest.json',
        ],
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(() => ({ ddb: { send: vi.fn() }, destroy: vi.fn() })),
        runMigration,
        writeJsonFile,
      }),
    ).rejects.toThrow('confirm-stage must exactly match stage');

    expect(runMigration).toHaveBeenCalledOnce();
    expect(writeJsonFile).not.toHaveBeenCalled();
  });

  it('rechecks a completed checkpoint instead of trusting stale completion', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const link = {
      pk: 'USER#minor-complete',
      sk: 'GUARDIAN#guardian-complete',
      gsi1pk: 'USER#guardian-complete',
      gsi1sk: 'MINOR#minor-complete',
      linkId: 'guardian-complete~minor-complete',
      kind: 'created',
      guardianId: 'guardian-complete',
      minorId: 'minor-complete',
      createdAt: 100,
    };
    const profile = {
      pk: 'USER#guardian-complete',
      sk: 'PROFILE',
      userId: 'guardian-complete',
      accountType: 'adult',
      createdAt: 50,
      familyFenceVersion: 1,
      createdMinorIds: new Set(['minor-complete']),
    };
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`completed rerun attempted ${command.constructor.name}`);
        }
        return { Items: [link, profile], ScannedCount: 2 };
      }),
    };
    const saveCheckpoint = vi.fn(async () => undefined);

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      loadCheckpoint: vi.fn(async () => ({
        schemaVersion: 1,
        operation: 'backfill',
        stage: 'dev',
        tableName: 'roadmap-dev',
        auditTableName: 'roadmap-access-audit-dev',
        phase: 'complete',
      })),
      saveCheckpoint,
    });

    expect(ddb.send).toHaveBeenCalledOnce();
    expect(manifest).toMatchObject({
      scannedPages: 1,
      writes: 0,
      drift: { total: 0 },
    });
    expect(saveCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete' }),
    );
  });

  it('leaves the checkpoint restartable from seed whenever drift remains', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const profile = {
      pk: 'USER#guardian-drift-checkpoint',
      sk: 'PROFILE',
      userId: 'guardian-drift-checkpoint',
      accountType: 'adult',
      createdAt: 50,
      familyFenceVersion: 1,
      createdMinorIds: new Set(['missing-minor']),
    };
    const scans = [
      { Items: [], ScannedCount: 1 },
      { Items: [profile], ScannedCount: 1 },
    ];
    const checkpoints: any[] = [];

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb: {
        send: vi.fn(async (command: any) => {
          if (command.constructor.name !== 'ScanCommand') {
            throw new Error(`unexpected ${command.constructor.name}`);
          }
          return scans.shift();
        }),
      },
      saveCheckpoint: vi.fn(async (checkpoint: any) => checkpoints.push(checkpoint)),
    });

    expect(manifest.drift.total).toBe(1);
    expect(checkpoints.at(-1)).toMatchObject({ phase: 'seed' });
    expect(checkpoints.at(-1)).not.toHaveProperty('cursor');
  });

  it('reports a concurrent created-link addition and never publishes the stale snapshot', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const oldLink = {
      pk: 'USER#minor-old',
      sk: 'GUARDIAN#guardian-add-race',
      gsi1pk: 'USER#guardian-add-race',
      gsi1sk: 'MINOR#minor-old',
      linkId: 'guardian-add-race~minor-old',
      kind: 'created',
      guardianId: 'guardian-add-race',
      minorId: 'minor-old',
      createdAt: 100,
    };
    const profile = {
      pk: 'USER#guardian-add-race',
      sk: 'PROFILE',
      userId: 'guardian-add-race',
      accountType: 'adult',
      createdAt: 50,
      createdMinorIds: new Set(['minor-old']),
    };
    const scans = [
      { Items: [oldLink], ScannedCount: 1 },
      { Items: [oldLink, profile], ScannedCount: 2 },
    ];
    let transactionNumber = 0;
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          transactionNumber += 1;
          if (transactionNumber === 1) return {};
          throw Object.assign(new Error('new link won'), {
            name: 'TransactionCanceledException',
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          if (key.pk === oldLink.pk && key.sk === oldLink.sk) return { Item: oldLink };
          if (key.sk === 'PROFILE') {
            return {
              Item: {
                ...profile,
                createdMinorIds: new Set(['minor-old', 'minor-new']),
              },
            };
          }
          if (key.pk.startsWith('ACCOUNT_CLOSURE#')) return {};
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest).toMatchObject({
      finalize: { applied: 0 },
      drift: { total: 1, reasons: { profile_changed: 1 } },
      writes: 1,
    });
  });

  it('classifies an append-only audit collision and continues without a partial seed', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-audit-collision';
    const minorId = 'minor-audit-collision';
    const link = {
      pk: `USER#${minorId}`,
      sk: `GUARDIAN#${guardianId}`,
      gsi1pk: `USER#${guardianId}`,
      gsi1sk: `MINOR#${minorId}`,
      linkId: `${guardianId}~${minorId}`,
      kind: 'created',
      guardianId,
      minorId,
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
    };
    const scans = [
      { Items: [link], ScannedCount: 1 },
      { Items: [link, profile], ScannedCount: 2 },
    ];
    const ddb = {
      send: vi.fn(async (command: any) => {
        const name = command.constructor.name;
        if (name === 'ScanCommand') return scans.shift();
        if (name === 'TransactWriteCommand') {
          throw Object.assign(new Error('audit key already exists'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'None' },
              { Code: 'ConditionalCheckFailed' },
            ],
          });
        }
        if (name === 'GetCommand') {
          const key = command.input.Key;
          if (key.pk === link.pk && key.sk === link.sk) return { Item: link };
          if (key.sk === 'PROFILE') return { Item: profile };
          if (key.pk === `ACCOUNT_CLOSURE#${guardianId}`) return {};
        }
        throw new Error(`unexpected ${name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest.seed).toMatchObject({ applied: 0, alreadyApplied: 0 });
    expect(manifest.drift.reasons).toMatchObject({
      audit_conflict: 1,
      legacy_set_mismatch: 1,
    });
    expect(manifest.writes).toBe(0);
  });

  it('surfaces malformed created links as aggregate drift instead of omitting them', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const malformed = {
      pk: 'USER#minor-invalid',
      sk: 'GUARDIAN#guardian-invalid',
      kind: 'created',
      guardianId: 'guardian-invalid',
      minorId: 'minor-invalid',
      createdAt: 100,
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'reconcile',
      apply: false,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb: {
        send: vi.fn(async () => ({ Items: [malformed], ScannedCount: 1 })),
      },
    });

    expect(manifest.drift).toMatchObject({
      total: 1,
      reasons: { invalid_created_link: 1 },
    });
  });

  it('blocks finalize for an identifiable guardian when its created link is malformed', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const guardianId = 'guardian-malformed';
    const malformed = {
      pk: 'USER#minor-malformed',
      sk: `GUARDIAN#${guardianId}`,
      kind: 'created',
      guardianId,
      minorId: 'minor-malformed',
      createdAt: 100,
    };
    const profile = {
      pk: `USER#${guardianId}`,
      sk: 'PROFILE',
      userId: guardianId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
    };
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          return { Items: [profile, malformed], ScannedCount: 2 };
        }
        if (command.constructor.name === 'TransactWriteCommand') return {};
        throw new Error(`unexpected ${command.constructor.name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      now: () => 1_800_000_000_456,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest.drift.reasons).toMatchObject({ invalid_created_link: 1 });
    expect(manifest.finalize).toMatchObject({ eligible: 0, applied: 0 });
    expect(manifest.writes).toBe(0);
    expect(
      ddb.send.mock.calls.filter(
        ([command]) => command.constructor.name === 'TransactWriteCommand',
      ),
    ).toHaveLength(0);
  });

  it('blocks every finalize when a malformed created link has ambiguous guardian identity', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const profiles = ['guardian-from-field', 'guardian-from-key'].map((userId) => ({
      pk: `USER#${userId}`,
      sk: 'PROFILE',
      userId,
      accountType: 'adult',
      status: 'active',
      createdAt: 50,
    }));
    const malformed = {
      pk: 'USER#minor-ambiguous',
      sk: 'GUARDIAN#guardian-from-key',
      gsi1pk: 'USER#guardian-from-field',
      kind: 'created',
      guardianId: 'guardian-from-field',
      minorId: 'minor-ambiguous',
      createdAt: 100,
    };
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          return { Items: [...profiles, malformed], ScannedCount: 3 };
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      }),
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: true,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      now: () => 1_800_000_000_789,
      saveCheckpoint: vi.fn(async () => undefined),
    });

    expect(manifest.drift.reasons).toMatchObject({
      invalid_created_link: 1,
      ambiguous_created_link_identity: 1,
    });
    expect(manifest.finalize).toMatchObject({ eligible: 0, applied: 0 });
    expect(manifest.writes).toBe(0);
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it('reconcile fails closed when an otherwise authoritative active profile has a closure tombstone', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const profile = {
      pk: 'USER#guardian-closure-drift',
      sk: 'PROFILE',
      userId: 'guardian-closure-drift',
      accountType: 'adult',
      createdAt: 50,
      familyFenceVersion: 1,
    };
    const closure = {
      pk: 'ACCOUNT_CLOSURE#guardian-closure-drift',
      sk: 'STATE',
    };

    const manifest = await runFamilyFenceMigration({
      operation: 'reconcile',
      apply: false,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb: {
        send: vi.fn(async () => ({ Items: [profile, closure], ScannedCount: 2 })),
      },
    });

    expect(manifest.drift).toMatchObject({
      total: 1,
      reasons: { closure_present: 1 },
    });
  });

  it('CLI rejects using one file for both resumable state and the aggregate manifest', async () => {
    const { runFamilyFenceCli } = (await migrationModule()) as {
      runFamilyFenceCli(options: Record<string, unknown>): Promise<number>;
    };
    const getCallerIdentity = vi.fn();

    await expect(
      runFamilyFenceCli({
        argv: [
          '--operation',
          'backfill',
          '--stage',
          'dev',
          '--apply',
          '--confirm-stage',
          'dev',
          '--confirm-hash',
          'a'.repeat(64),
          '--checkpoint-file',
          'C:\\secure\\family-fence.json',
          '--manifest-file',
          'C:\\secure\\family-fence.json',
        ],
        getCallerIdentity,
      }),
    ).rejects.toThrow('checkpoint and manifest files must differ');
    expect(getCallerIdentity).not.toHaveBeenCalled();
  });

  it('does not replace a successful dry-run with best-effort client destruction internals', async () => {
    const { runFamilyFenceCli } = (await migrationModule()) as {
      runFamilyFenceCli(options: Record<string, unknown>): Promise<number>;
    };

    await expect(
      runFamilyFenceCli({
        argv: ['--operation', 'reconcile', '--stage', 'dev'],
        write: vi.fn(),
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(() => ({
          ddb: { send: vi.fn() },
          destroy: vi.fn(() => {
            throw new Error('private provider internals');
          }),
        })),
        runMigration: vi.fn(async () => ({
          manifestHash: 'f'.repeat(64),
          writes: 0,
        })),
      }),
    ).resolves.toBe(0);
  });

  it('dry-run never virtually repairs drift on an already authoritative profile', async () => {
    const { runFamilyFenceMigration } = (await migrationModule()) as {
      runFamilyFenceMigration(options: Record<string, unknown>): Promise<any>;
    };
    const link = {
      pk: 'USER#minor-authoritative-drift',
      sk: 'GUARDIAN#guardian-authoritative-drift',
      gsi1pk: 'USER#guardian-authoritative-drift',
      gsi1sk: 'MINOR#minor-authoritative-drift',
      linkId: 'guardian-authoritative-drift~minor-authoritative-drift',
      kind: 'created',
      guardianId: 'guardian-authoritative-drift',
      minorId: 'minor-authoritative-drift',
      createdAt: 100,
    };
    const profile = {
      pk: 'USER#guardian-authoritative-drift',
      sk: 'PROFILE',
      userId: 'guardian-authoritative-drift',
      accountType: 'adult',
      createdAt: 50,
      familyFenceVersion: 1,
    };
    const scans = [
      { Items: [link], ScannedCount: 1 },
      { Items: [link, profile], ScannedCount: 2 },
    ];

    const manifest = await runFamilyFenceMigration({
      operation: 'backfill',
      apply: false,
      stage: 'dev',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb: {
        send: vi.fn(async () => scans.shift()),
      },
    });

    expect(manifest.seed.wouldApply).toBe(0);
    expect(manifest.drift).toMatchObject({
      total: 1,
      reasons: { authoritative_set_mismatch: 1 },
    });
  });
});
