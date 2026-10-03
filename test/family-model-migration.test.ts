import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  householdIdForPrimary as domainHouseholdIdForPrimary,
  supervisionLinkId as domainSupervisionLinkId,
} from '../lambda/family/keys';
import { validateHouseholdSnapshot } from '../lambda/family/model';

async function libraryModule(): Promise<Record<string, unknown>> {
  const url = pathToFileURL(
    join(process.cwd(), 'scripts', 'lib', 'family-model-migration.mjs'),
  ).href;
  return import(url) as Promise<Record<string, unknown>>;
}

async function cliModule(): Promise<Record<string, unknown>> {
  const url = pathToFileURL(
    join(process.cwd(), 'scripts', 'family-model-migration.mjs'),
  ).href;
  return import(url) as Promise<Record<string, unknown>>;
}

function profile(userId: string, accountType: 'adult' | 'minor', createdAt: number) {
  return {
    pk: `USER#${userId}`,
    sk: 'PROFILE',
    userId,
    accountType,
    status: 'active',
    createdAt,
  };
}

function legacyLink(
  guardianId: string,
  minorId: string,
  kind: 'created' | 'invited',
  createdAt: number,
) {
  return {
    pk: `USER#${minorId}`,
    sk: `GUARDIAN#${guardianId}`,
    gsi1pk: `USER#${guardianId}`,
    gsi1sk: `MINOR#${minorId}`,
    linkId: `${guardianId}~${minorId}`,
    kind,
    guardianId,
    minorId,
    createdAt,
  };
}

function householdIdFor(primaryId: string): string {
  return domainHouseholdIdForPrimary(primaryId);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashedManifest<T extends Record<string, unknown>>(contents: T): T & { manifestHash: string } {
  return {
    ...contents,
    manifestHash: createHash('sha256').update(canonicalJson(contents), 'utf8').digest('hex'),
  };
}

function migrationManifest({
  operation,
  mode,
  stage,
  writes = 0,
}: {
  operation: 'inventory' | 'backfill' | 'reconcile';
  mode: 'dry-run' | 'apply';
  stage: 'dev' | 'test' | 'prod';
  writes?: number;
}) {
  return hashedManifest({
    schemaVersion: 1,
    operation,
    mode,
    stage,
    accountId: '765932874577',
    resources: {
      primaryTable: `roadmap-${stage}`,
      auditTable: `roadmap-access-audit-${stage}`,
    },
    scan: { pages: 1, scannedItems: 0, returnedItems: 0 },
    totals: {
      profiles: writes,
      adults: writes,
      minors: 0,
      legacyLinks: 0,
      validLegacyLinks: 0,
      households: writes,
    },
    classifications: {
      eligible: writes,
      alreadyBackfilled: 0,
      legacyOverCapacity: 0,
      ambiguousHouseholds: 0,
      minorsWithoutCreatedGuardian: 0,
      invalidLinks: 0,
      orphanedLinks: 0,
      existingDrift: 0,
      closingAccounts: 0,
      closingHouseholds: 0,
      emptyAdultHouseholds: 0,
      invalidProfiles: 0,
    },
    backfill: {
      candidateHouseholds: writes,
      wouldWriteItems: writes,
      appliedHouseholds: writes,
      alreadyAppliedHouseholds: 0,
      conflictedHouseholds: 0,
    },
    safety: {
      deletes: 0,
      coverageWrites: 0,
      flagWrites: 0,
      legacyLinksPreserved: true,
      rollback: 'family flags remain independently reversible',
    },
    planHash: 'b'.repeat(64),
    writes,
  });
}

describe('family model migration', () => {
  it('exposes inert library and CLI seams through an explicit npm command', async () => {
    const library: Record<string, unknown> = await libraryModule().catch(
      (): Record<string, unknown> => ({}),
    );
    const cli: Record<string, unknown> = await cliModule().catch(
      (): Record<string, unknown> => ({}),
    );
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(library['classifyLegacyFamilyModel']).toBeTypeOf('function');
    expect(library['runFamilyModelMigration']).toBeTypeOf('function');
    expect(cli['runFamilyModelMigrationCli']).toBeTypeOf('function');
    expect(packageJson.scripts['commercial:family-model']).toBe(
      'node scripts/family-model-migration.mjs',
    );
  });

  it('classifies the oldest created link by createdAt and guardianId, then assigns one additional adult', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const items = [
      profile('adult-a', 'adult', 10),
      profile('adult-z', 'adult', 11),
      profile('minor-b', 'minor', 20),
      profile('minor-a', 'minor', 21),
      legacyLink('adult-z', 'minor-a', 'created', 100),
      legacyLink('adult-a', 'minor-a', 'created', 100),
      legacyLink('adult-z', 'minor-b', 'invited', 130),
      legacyLink('adult-a', 'minor-b', 'created', 120),
    ];

    const result = classifyLegacyFamilyModel(items);

    expect(result.totals).toMatchObject({
      profiles: 4,
      adults: 2,
      minors: 2,
      legacyLinks: 4,
      validLegacyLinks: 4,
      households: 2,
    });
    expect(result.classifications).toMatchObject({
      eligible: 2,
      legacyOverCapacity: 0,
      ambiguousHouseholds: 0,
      invalidLinks: 0,
      emptyAdultHouseholds: 1,
    });
    expect(result.plans).toHaveLength(2);
    const familyPlan = result.plans.find(
      (plan: any) => plan.primaryResponsibleId === 'adult-a',
    );
    expect(familyPlan).toMatchObject({
      primaryResponsibleId: 'adult-a',
      householdId: householdIdFor('adult-a'),
      state: 'active',
      disposition: 'candidate',
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-z',
      additionalScope: ['minor-a', 'minor-b'],
    });
    const encodedItems = JSON.stringify(familyPlan.items);
    expect(encodedItems).toContain('primary_responsible');
    expect(encodedItems).toContain('additional_responsible');
    expect(encodedItems).not.toContain('CoverageAssignment');
    expect(encodedItems).not.toContain('COVERAGE#FAMILY');
    for (const link of familyPlan.items.filter(
      (item: any) => item.entityType === 'SupervisionLink',
    )) {
      expect(link.linkId).toBe(
        domainSupervisionLinkId(link.householdId, link.minorId, link.adultId),
      );
    }
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('backfills an empty deterministic Household for an adult with no legacy minors', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };

    const result = classifyLegacyFamilyModel([profile('adult-alone', 'adult', 25)]);

    expect(result.classifications).toMatchObject({
      eligible: 1,
      emptyAdultHouseholds: 1,
    });
    expect(result.plans).toEqual([
      expect.objectContaining({
        primaryResponsibleId: 'adult-alone',
        householdId: householdIdFor('adult-alone'),
        state: 'active',
        disposition: 'candidate',
        minorIds: [],
        additionalResponsibleId: null,
        additionalScope: [],
      }),
    ]);
    expect(
      result.plans[0].items.filter((item: any) => item.entityType === 'SeatAssignment'),
    ).toEqual([
      expect.objectContaining({ sk: 'SEAT#MINOR#1', state: 'empty', accountId: null }),
      expect.objectContaining({ sk: 'SEAT#MINOR#2', state: 'empty', accountId: null }),
      expect.objectContaining({ sk: 'SEAT#ADDITIONAL', state: 'empty', accountId: null }),
    ]);
    expect(JSON.stringify(result.plans[0].items)).not.toMatch(
      /SupervisionLink|CoverageAssignment|COVERAGE#FAMILY/,
    );
  });

  it('marks households with more than two minors without inventing v2 seats or supervision', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const items = [
      profile('primary', 'adult', 10),
      profile('additional-a', 'adult', 11),
      profile('additional-b', 'adult', 12),
      ...['minor-1', 'minor-2', 'minor-3'].map((id, index) =>
        profile(id, 'minor', 20 + index),
      ),
      legacyLink('primary', 'minor-1', 'created', 100),
      legacyLink('additional-a', 'minor-1', 'invited', 110),
      legacyLink('primary', 'minor-2', 'created', 120),
      legacyLink('additional-b', 'minor-2', 'invited', 130),
      legacyLink('primary', 'minor-3', 'created', 140),
    ];

    const result = classifyLegacyFamilyModel(items);

    expect(result.classifications).toMatchObject({
      eligible: 3,
      legacyOverCapacity: 1,
      ambiguousHouseholds: 0,
      emptyAdultHouseholds: 2,
    });
    const overCapacityPlan = result.plans.find(
      (plan: any) => plan.primaryResponsibleId === 'primary',
    );
    expect(overCapacityPlan).toMatchObject({
      state: 'legacy_over_capacity',
      disposition: 'candidate',
      minorIds: ['minor-1', 'minor-2', 'minor-3'],
      additionalResponsibleId: null,
      additionalScope: [],
    });
    expect(overCapacityPlan.items[0]).toEqual(
      expect.objectContaining({
        sk: 'META',
        entityType: 'Household',
        state: 'legacy_over_capacity',
      }),
    );
    const seats = overCapacityPlan.items.filter(
      (item: any) => item.entityType === 'SeatAssignment',
    );
    expect(seats).toHaveLength(3);
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sk: 'SEAT#MINOR#1', state: 'empty', accountId: null }),
        expect.objectContaining({ sk: 'SEAT#MINOR#2', state: 'empty', accountId: null }),
        expect.objectContaining({ sk: 'SEAT#ADDITIONAL', state: 'empty', accountId: null }),
      ]),
    );
    expect(JSON.stringify(overCapacityPlan.items)).not.toMatch(
      /SupervisionLink|CoverageAssignment|COVERAGE#FAMILY/,
    );
    expect(() =>
      validateHouseholdSnapshot(
        {
          household: overCapacityPlan.items[0],
          seats,
          supervisionLinks: [],
          coverages: [],
        } as any,
        1_000,
      ),
    ).not.toThrow();
  });

  it('blocks a household when account closure has started instead of racing the closure worker', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const items = [
      profile('closing-primary', 'adult', 10),
      profile('minor-safe', 'minor', 20),
      legacyLink('closing-primary', 'minor-safe', 'created', 100),
      {
        pk: 'ACCOUNT_CLOSURE#closing-primary',
        sk: 'STATE',
        status: 'pending',
      },
    ];

    const result = classifyLegacyFamilyModel(items);

    expect(result.classifications).toMatchObject({
      eligible: 0,
      closingAccounts: 1,
      closingHouseholds: 1,
    });
    expect(result.plans).toEqual([
      expect.objectContaining({
        primaryResponsibleId: 'closing-primary',
        disposition: 'closing',
      }),
    ]);
  });

  it('paginates a consistent inventory into a sanitized stable manifest and performs no writes', async () => {
    const { runFamilyModelMigration } = (await libraryModule()) as {
      runFamilyModelMigration(options: Record<string, unknown>): Promise<any>;
    };
    const pageOne = { pk: 'opaque-cursor', sk: 'opaque-cursor' };
    const pages = [
      {
        Items: [
          profile('adult-sensitive', 'adult', 10),
          profile('minor-sensitive', 'minor', 20),
        ],
        LastEvaluatedKey: pageOne,
        ScannedCount: 8,
      },
      {
        Items: [legacyLink('adult-sensitive', 'minor-sensitive', 'created', 100)],
        ScannedCount: 5,
      },
    ];
    const commands: any[] = [];
    const ddb = {
      send: vi.fn(async (command: any) => {
        commands.push(command);
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`unexpected ${command.constructor.name}`);
        }
        const response = pages.shift();
        if (!response) throw new Error('unexpected scan');
        return response;
      }),
    };
    const saveCheckpoint = vi.fn(async (_checkpoint: unknown) => undefined);

    const manifest = await runFamilyModelMigration({
      operation: 'inventory',
      apply: false,
      stage: 'dev',
      accountId: '765932874577',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      ddb,
      saveCheckpoint,
    });

    expect(commands.map((command) => command.constructor.name)).toEqual([
      'ScanCommand',
      'ScanCommand',
    ]);
    expect(commands[0].input).toMatchObject({
      TableName: 'roadmap-dev',
      ConsistentRead: true,
      Select: 'SPECIFIC_ATTRIBUTES',
    });
    expect(commands[1].input.ExclusiveStartKey).toEqual(pageOne);
    expect(commands[0].input.ProjectionExpression).not.toMatch(
      /email|username|displayName|record/i,
    );
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      operation: 'inventory',
      mode: 'dry-run',
      stage: 'dev',
      accountId: '765932874577',
      scan: { pages: 2, scannedItems: 13, returnedItems: 3 },
      totals: { profiles: 2, adults: 1, minors: 1, households: 1 },
      classifications: { eligible: 1 },
      backfill: { candidateHouseholds: 1, appliedHouseholds: 0 },
      safety: { deletes: 0, coverageWrites: 0, flagWrites: 0 },
      writes: 0,
    });
    expect(manifest.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('adult-sensitive');
    expect(serialized).not.toContain('minor-sensitive');
    expect(serialized).not.toContain('plans');
  });

  it('applies one additive transaction, writes a bound checkpoint, and never creates coverage or deletes data', async () => {
    const { runFamilyModelMigration } = (await libraryModule()) as {
      runFamilyModelMigration(options: Record<string, unknown>): Promise<any>;
    };
    const sourceItems = [
      profile('primary-apply', 'adult', 10),
      profile('minor-apply', 'minor', 20),
      legacyLink('primary-apply', 'minor-apply', 'created', 100),
    ];
    const dryDdb = {
      send: vi.fn(async () => ({ Items: sourceItems, ScannedCount: sourceItems.length })),
    };
    const shared = {
      operation: 'backfill',
      stage: 'test',
      accountId: '765932874577',
      tableName: 'roadmap-test',
      auditTableName: 'roadmap-access-audit-test',
    };
    const preview = await runFamilyModelMigration({
      ...shared,
      apply: false,
      ddb: dryDdb,
    });
    const transactions: any[] = [];
    const applyDdb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          return { Items: sourceItems, ScannedCount: sourceItems.length };
        }
        if (command.constructor.name === 'TransactWriteCommand') {
          transactions.push(command.input);
          return {};
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      }),
    };
    const saveCheckpoint = vi.fn(async (_checkpoint: unknown) => undefined);
    const migrationStartedAt = 1_800_000_000_123;
    const now = vi.fn(() => migrationStartedAt);

    const manifest = await runFamilyModelMigration({
      ...shared,
      apply: true,
      expectedManifestHash: preview.manifestHash,
      ddb: applyDdb,
      loadCheckpoint: vi.fn(async () => null),
      saveCheckpoint,
      now,
    });

    expect(transactions).toHaveLength(1);
    const transactionItems = transactions[0].TransactItems;
    expect(transactionItems.some((item: any) => item.Delete || item.Update)).toBe(false);
    const puts = transactionItems.flatMap((item: any) => (item.Put ? [item.Put] : []));
    expect(puts.some((put: any) => put.Item.entityType === 'Household')).toBe(true);
    expect(puts.filter((put: any) => put.Item.entityType === 'SeatAssignment')).toHaveLength(3);
    expect(puts.filter((put: any) => put.Item.entityType === 'SupervisionLink')).toHaveLength(1);
    expect(JSON.stringify(puts)).not.toMatch(/CoverageAssignment|COVERAGE#FAMILY/);
    const audit = puts.find((put: any) => put.TableName === 'roadmap-access-audit-test');
    expect(audit).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      Item: {
        entityType: 'AuditEvent',
        action: 'family_model_backfill_v2',
        actor: 'commercial-migration',
        timestamp: migrationStartedAt,
        details: expect.objectContaining({ sourceCreatedAt: 10 }),
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/primary-apply|minor-apply/);
    expect(
      transactionItems.filter((item: any) =>
        String(item.ConditionCheck?.Key?.pk).startsWith('ACCOUNT_CLOSURE#'),
      ),
    ).toHaveLength(2);
    expect(saveCheckpoint).toHaveBeenCalledOnce();
    const checkpoint = saveCheckpoint.mock.calls[0][0] as any;
    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      operation: 'backfill',
      stage: 'test',
      accountId: '765932874577',
      planHash: preview.planHash,
      nextIndex: 1,
      complete: true,
      migrationStartedAt,
    });
    expect(checkpoint.checkpointHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest).toMatchObject({
      mode: 'apply',
      backfill: { appliedHouseholds: 1, conflictedHouseholds: 0 },
      safety: { deletes: 0, coverageWrites: 0, flagWrites: 0 },
      writes: 1,
    });
    expect(now).toHaveBeenCalledOnce();
  });

  it('quarantines ambiguous, malformed, and orphaned links instead of manufacturing authority', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const malformed = {
      ...legacyLink('primary-q', 'minor-q', 'invited', 140),
      linkId: 'not-canonical',
    };
    const orphaned = legacyLink('missing-adult', 'minor-q', 'invited', 150);
    const result = classifyLegacyFamilyModel([
      profile('primary-q', 'adult', 10),
      profile('additional-a-q', 'adult', 11),
      profile('additional-b-q', 'adult', 12),
      profile('minor-q', 'minor', 20),
      legacyLink('primary-q', 'minor-q', 'created', 100),
      legacyLink('additional-a-q', 'minor-q', 'invited', 120),
      legacyLink('additional-b-q', 'minor-q', 'invited', 130),
      malformed,
      orphaned,
    ]);

    expect(result.totals).toMatchObject({
      legacyLinks: 5,
      validLegacyLinks: 3,
    });
    expect(result.classifications).toMatchObject({
      eligible: 2,
      ambiguousHouseholds: 1,
      invalidLinks: 1,
      orphanedLinks: 1,
      emptyAdultHouseholds: 2,
    });
    expect(
      result.plans.find((plan: any) => plan.primaryResponsibleId === 'primary-q'),
    ).toEqual(
      expect.objectContaining({
        primaryResponsibleId: 'primary-q',
        disposition: 'ambiguous',
      }),
    );
  });

  it('blocks an otherwise eligible household when a malformed link can be attributed to its minor', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const malformedAdditional = {
      ...legacyLink('possible-additional', 'minor-attributed', 'invited', 120),
      gsi1sk: 'MINOR#different-minor',
    };

    const result = classifyLegacyFamilyModel([
      profile('primary-attributed', 'adult', 10),
      profile('possible-additional', 'adult', 11),
      profile('minor-attributed', 'minor', 20),
      legacyLink('primary-attributed', 'minor-attributed', 'created', 100),
      malformedAdditional,
    ]);

    expect(result.classifications).toMatchObject({
      eligible: 1,
      ambiguousHouseholds: 1,
      invalidLinks: 1,
      emptyAdultHouseholds: 1,
    });
    expect(
      result.plans.find(
        (plan: any) => plan.primaryResponsibleId === 'primary-attributed',
      ).disposition,
    ).toBe('ambiguous');
  });

  it('counts malformed legacy profiles explicitly instead of silently dropping them', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const malformedAdult = {
      pk: 'USER#adult-malformed-profile',
      sk: 'PROFILE',
      userId: 'adult-malformed-profile',
      accountType: 'adult',
      status: 'active',
    };

    const result = classifyLegacyFamilyModel([
      malformedAdult,
      profile('minor-malformed-profile', 'minor', 20),
      legacyLink(
        'adult-malformed-profile',
        'minor-malformed-profile',
        'created',
        100,
      ),
    ]);

    expect(result.classifications).toMatchObject({
      invalidProfiles: 1,
      orphanedLinks: 1,
      minorsWithoutCreatedGuardian: 1,
      eligible: 0,
    });
    expect(result.plans).toEqual([]);
  });

  it('does not treat an adult with an invited-only orphan relationship as an empty eligible household', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };

    const result = classifyLegacyFamilyModel([
      profile('adult-invited-only', 'adult', 10),
      profile('minor-invited-only', 'minor', 20),
      legacyLink('adult-invited-only', 'minor-invited-only', 'invited', 100),
    ]);

    expect(result.classifications).toMatchObject({
      eligible: 0,
      ambiguousHouseholds: 1,
      minorsWithoutCreatedGuardian: 1,
      emptyAdultHouseholds: 1,
    });
    expect(result.plans).toEqual([
      expect.objectContaining({
        primaryResponsibleId: 'adult-invited-only',
        minorIds: [],
        disposition: 'ambiguous',
      }),
    ]);
  });

  it('is idempotent when the exact Household v2 graph already exists', async () => {
    const { classifyLegacyFamilyModel, runFamilyModelMigration } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
      runFamilyModelMigration(options: Record<string, unknown>): Promise<any>;
    };
    const sourceItems = [
      profile('primary-idempotent', 'adult', 10),
      profile('minor-idempotent', 'minor', 20),
      legacyLink('primary-idempotent', 'minor-idempotent', 'created', 100),
    ];
    const firstPlan = classifyLegacyFamilyModel(sourceItems);
    const alreadyBackfilledItems = [...sourceItems, ...firstPlan.plans[0].items];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`unexpected ${command.constructor.name}`);
        }
        return {
          Items: alreadyBackfilledItems,
          ScannedCount: alreadyBackfilledItems.length,
        };
      }),
    };
    const shared = {
      operation: 'backfill',
      stage: 'dev',
      accountId: '765932874577',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
    };
    const preview = await runFamilyModelMigration({ ...shared, apply: false, ddb });
    const saveCheckpoint = vi.fn(async () => undefined);

    const applied = await runFamilyModelMigration({
      ...shared,
      apply: true,
      expectedManifestHash: preview.manifestHash,
      ddb,
      loadCheckpoint: vi.fn(async () => null),
      saveCheckpoint,
    });

    expect(preview.planHash).toBe(firstPlan.planHash);
    expect(preview.classifications.alreadyBackfilled).toBe(1);
    expect(ddb.send.mock.calls.every(([command]) => command.constructor.name === 'ScanCommand')).toBe(
      true,
    );
    expect(applied).toMatchObject({
      backfill: { appliedHouseholds: 0, alreadyAppliedHouseholds: 1 },
      writes: 0,
    });
    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ nextIndex: 1, complete: true }),
    );
  });

  it('rejects a checkpoint bound to another stage before issuing a transaction', async () => {
    const { runFamilyModelMigration } = (await libraryModule()) as {
      runFamilyModelMigration(options: Record<string, unknown>): Promise<any>;
    };
    const source = [profile('adult-checkpoint', 'adult', 10)];
    const shared = {
      operation: 'backfill',
      stage: 'dev',
      accountId: '765932874577',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
    };
    const dryDdb = {
      send: vi.fn(async () => ({ Items: source, ScannedCount: source.length })),
    };
    const preview = await runFamilyModelMigration({ ...shared, apply: false, ddb: dryDdb });
    const checkpointContents = {
      schemaVersion: 1,
      operation: 'backfill',
      stage: 'prod',
      accountId: '765932874577',
      tableName: 'roadmap-dev',
      auditTableName: 'roadmap-access-audit-dev',
      planHash: preview.planHash,
      migrationStartedAt: 1_800_000_000_000,
      nextIndex: 0,
      complete: false,
    };
    const checkpoint = {
      ...checkpointContents,
      checkpointHash: createHash('sha256')
        .update(canonicalJson(checkpointContents), 'utf8')
        .digest('hex'),
    };
    const transaction = vi.fn();
    const applyDdb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name === 'ScanCommand') {
          return { Items: source, ScannedCount: source.length };
        }
        transaction(command);
        return {};
      }),
    };

    await expect(
      runFamilyModelMigration({
        ...shared,
        apply: true,
        expectedManifestHash: preview.manifestHash,
        ddb: applyDdb,
        loadCheckpoint: vi.fn(async () => checkpoint),
        saveCheckpoint: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('checkpoint stage does not match this run');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reconcile reports partial or conflicting v2 state and remains read-only', async () => {
    const { classifyLegacyFamilyModel, runFamilyModelMigration } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
      runFamilyModelMigration(options: Record<string, unknown>): Promise<any>;
    };
    const sourceItems = [
      profile('primary-drift', 'adult', 10),
      profile('minor-drift', 'minor', 20),
      legacyLink('primary-drift', 'minor-drift', 'created', 100),
    ];
    const plan = classifyLegacyFamilyModel(sourceItems).plans[0];
    const conflictingHousehold = {
      ...plan.items[0],
      primaryResponsibleId: 'someone-else',
    };
    const stored = [...sourceItems, conflictingHousehold];
    const ddb = {
      send: vi.fn(async (command: any) => {
        if (command.constructor.name !== 'ScanCommand') {
          throw new Error(`unexpected ${command.constructor.name}`);
        }
        return { Items: stored, ScannedCount: stored.length };
      }),
    };

    const manifest = await runFamilyModelMigration({
      operation: 'reconcile',
      apply: false,
      stage: 'prod',
      accountId: '765932874577',
      tableName: 'roadmap-prod',
      auditTableName: 'roadmap-access-audit-prod',
      ddb,
    });

    expect(manifest).toMatchObject({
      operation: 'reconcile',
      mode: 'dry-run',
      classifications: { eligible: 0, existingDrift: 1 },
      backfill: { candidateHouseholds: 0 },
      writes: 0,
    });
    expect(ddb.send).toHaveBeenCalledOnce();
  });

  it('treats an unexpected active v2 supervision link as drift even when expected items are exact', async () => {
    const { classifyLegacyFamilyModel } = (await libraryModule()) as {
      classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
    };
    const source = [
      profile('primary-extra', 'adult', 10),
      profile('intruder-extra', 'adult', 11),
      profile('minor-extra', 'minor', 20),
      legacyLink('primary-extra', 'minor-extra', 'created', 100),
    ];
    const initial = classifyLegacyFamilyModel(source);
    const familyPlan = initial.plans.find(
      (plan: any) => plan.primaryResponsibleId === 'primary-extra',
    );
    const extraLink = {
      pk: 'USER#minor-extra',
      sk: 'SUPERVISION#intruder-extra',
      gsi1pk: 'USER#intruder-extra',
      gsi1sk: 'SUPERVISION#minor-extra',
      entityType: 'SupervisionLink',
      linkId: 'sl_extra',
      householdId: familyPlan.householdId,
      adultId: 'intruder-extra',
      minorId: 'minor-extra',
      role: 'additional_responsible',
      state: 'active',
      revision: 1,
      validFrom: 101,
      validUntil: null,
      updatedAt: 101,
    };

    const result = classifyLegacyFamilyModel([...source, ...familyPlan.items, extraLink]);
    const reconciledFamily = result.plans.find(
      (plan: any) => plan.primaryResponsibleId === 'primary-extra',
    );

    expect(reconciledFamily.disposition).toBe('drift');
    expect(result.classifications.existingDrift).toBe(1);
  });

  it('CLI defaults to dry-run and validates the exact account plus stage role before connecting', async () => {
    const { runFamilyModelMigrationCli } = (await cliModule()) as {
      runFamilyModelMigrationCli(options: Record<string, unknown>): Promise<number>;
    };
    const manifest = migrationManifest({
      operation: 'inventory',
      mode: 'dry-run',
      stage: 'test',
    });
    const manifestHash = manifest.manifestHash;
    const writes: string[] = [];
    const ddb = { send: vi.fn() };
    const destroy = vi.fn();
    const createDdb = vi.fn(async () => ({ ddb, destroy }));
    const runMigration = vi.fn(async () => manifest);

    const exitCode = await runFamilyModelMigrationCli({
      argv: [
        '--operation',
        'inventory',
        '--stage',
        'test',
        '--account',
        '765932874577',
      ],
      write: (line: string) => writes.push(line),
      getCallerIdentity: vi.fn(async () => ({
        Account: '765932874577',
        Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-test-commercial-migration/session',
      })),
      createDdb,
      runMigration,
    });

    expect(exitCode).toBe(0);
    expect(createDdb).toHaveBeenCalledOnce();
    expect(runMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'inventory',
        apply: false,
        stage: 'test',
        accountId: '765932874577',
        tableName: 'roadmap-test',
        auditTableName: 'roadmap-access-audit-test',
        ddb,
      }),
    );
    expect(writes).toContain('dry-run operation=inventory stage=test account=765932874577');
    expect(writes).toContain(`manifestHash=${manifestHash}`);
    expect(destroy).toHaveBeenCalledOnce();

    const blockedConnection = vi.fn();
    await expect(
      runFamilyModelMigrationCli({
        argv: [
          '--operation',
          'inventory',
          '--stage',
          'prod',
          '--account',
          '765932874577',
        ],
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: blockedConnection,
      }),
    ).rejects.toThrow('caller does not match the selected stage migration role');
    expect(blockedConnection).not.toHaveBeenCalled();
  });

  it('CLI rejects a forged manifest hash before presenting or applying a plan', async () => {
    const { runFamilyModelMigrationCli } = (await cliModule()) as {
      runFamilyModelMigrationCli(options: Record<string, unknown>): Promise<number>;
    };
    const destroy = vi.fn();
    const write = vi.fn();

    await expect(
      runFamilyModelMigrationCli({
        argv: [
          '--operation',
          'inventory',
          '--stage',
          'dev',
          '--account',
          '765932874577',
        ],
        write,
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(async () => ({ ddb: { send: vi.fn() }, destroy })),
        runMigration: vi.fn(async () => ({
          ...migrationManifest({
            operation: 'inventory',
            mode: 'dry-run',
            stage: 'dev',
          }),
          manifestHash: 'f'.repeat(64),
        })),
      }),
    ).rejects.toThrow('manifest hash does not match its contents');
    expect(write).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('CLI rejects a correctly hashed manifest that contains raw migration plans', async () => {
    const { runFamilyModelMigrationCli } = (await cliModule()) as {
      runFamilyModelMigrationCli(options: Record<string, unknown>): Promise<number>;
    };
    const safe = migrationManifest({
      operation: 'inventory',
      mode: 'dry-run',
      stage: 'dev',
    });
    const { manifestHash: _safeHash, ...contents } = safe;
    const unsafe = hashedManifest({
      ...contents,
      plans: [{ primaryResponsibleId: 'adult-private', minorIds: ['minor-private'] }],
    });
    const write = vi.fn();

    await expect(
      runFamilyModelMigrationCli({
        argv: [
          '--operation',
          'inventory',
          '--stage',
          'dev',
          '--account',
          '765932874577',
        ],
        write,
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/session',
        })),
        createDdb: vi.fn(async () => ({ ddb: { send: vi.fn() }, destroy: vi.fn() })),
        runMigration: vi.fn(async () => unsafe),
      }),
    ).rejects.toThrow('migration returned an invalid sanitized manifest');
    expect(write).not.toHaveBeenCalled();
  });

  it('CLI apply requires matching stage, account, and dry-run hash and persists checkpoint separately', async () => {
    const { runFamilyModelMigrationCli } = (await cliModule()) as {
      runFamilyModelMigrationCli(options: Record<string, unknown>): Promise<number>;
    };
    const preview = migrationManifest({
      operation: 'backfill',
      mode: 'dry-run',
      stage: 'test',
    });
    const applied = migrationManifest({
      operation: 'backfill',
      mode: 'apply',
      stage: 'test',
      writes: 1,
    });
    const checkpointPath = 'C:\\migration-state\\checkpoint.json';
    const manifestPath = 'C:\\migration-state\\manifest.json';
    const readJsonFile = vi.fn(async () => ({ saved: 'checkpoint' }));
    const writeJsonFile = vi.fn(async () => undefined);
    const runMigration = vi.fn(async (options: any) => {
      if (!options.apply) return preview;
      expect(await options.loadCheckpoint()).toEqual({ saved: 'checkpoint' });
      await options.saveCheckpoint({ nextIndex: 1 });
      return applied;
    });
    const writes: string[] = [];

    const exitCode = await runFamilyModelMigrationCli({
      argv: [
        '--operation',
        'backfill',
        '--stage',
        'test',
        '--account',
        '765932874577',
        '--apply',
        '--confirm-stage',
        'test',
        '--confirm-account',
        '765932874577',
        '--confirm-hash',
        preview.manifestHash,
        '--checkpoint-file',
        checkpointPath,
        '--manifest-file',
        manifestPath,
      ],
      write: (line: string) => writes.push(line),
      getCallerIdentity: vi.fn(async () => ({
        Account: '765932874577',
        Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-test-commercial-migration/session',
      })),
      createDdb: vi.fn(async () => ({ ddb: { send: vi.fn() }, destroy: vi.fn() })),
      runMigration,
      readJsonFile,
      writeJsonFile,
    });

    expect(exitCode).toBe(0);
    expect(runMigration).toHaveBeenCalledTimes(2);
    expect(runMigration.mock.calls[1][0]).toMatchObject({
      apply: true,
      expectedManifestHash: preview.manifestHash,
    });
    expect(readJsonFile).toHaveBeenCalledWith(checkpointPath);
    expect(writeJsonFile).toHaveBeenNthCalledWith(1, checkpointPath, { nextIndex: 1 });
    expect(writeJsonFile).toHaveBeenNthCalledWith(2, manifestPath, applied);
    expect(writes).toContain(
      'applied operation=backfill stage=test account=765932874577 writes=1',
    );

    const neverApply = vi.fn();
    await expect(
      runFamilyModelMigrationCli({
        argv: [
          '--operation',
          'backfill',
          '--stage',
          'test',
          '--account',
          '765932874577',
          '--apply',
          '--confirm-stage',
          'prod',
          '--confirm-account',
          '765932874577',
          '--confirm-hash',
          preview.manifestHash,
          '--checkpoint-file',
          checkpointPath,
          '--manifest-file',
          manifestPath,
        ],
        getCallerIdentity: vi.fn(async () => ({
          Account: '765932874577',
          Arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-test-commercial-migration/session',
        })),
        createDdb: vi.fn(async () => ({ ddb: { send: vi.fn() }, destroy: vi.fn() })),
        runMigration: vi.fn(async (options: any) => {
          if (options.apply) neverApply();
          return preview;
        }),
      }),
    ).rejects.toThrow('confirm-stage must exactly match stage');
    expect(neverApply).not.toHaveBeenCalled();
  });

  it('proves over-capacity with a bounded transaction even for a very large legacy household', async () => {
    const { classifyLegacyFamilyModel, buildFamilyModelBackfillTransaction } =
      (await libraryModule()) as {
        classifyLegacyFamilyModel(items: readonly Record<string, unknown>[]): any;
        buildFamilyModelBackfillTransaction(options: Record<string, unknown>): any;
      };
    const minorIds = Array.from({ length: 120 }, (_, index) => `minor-large-${index + 1}`);
    const source = [
      profile('primary-large', 'adult', 10),
      ...minorIds.map((minorId, index) => profile(minorId, 'minor', 20 + index)),
      ...minorIds.map((minorId, index) =>
        legacyLink('primary-large', minorId, 'created', 1_000 + index),
      ),
    ];
    const result = classifyLegacyFamilyModel(source);
    const plan = result.plans[0];

    const transaction = buildFamilyModelBackfillTransaction({
      tableName: 'roadmap-prod',
      auditTableName: 'roadmap-access-audit-prod',
      stage: 'prod',
      plan,
      planHash: result.planHash,
      migrationStartedAt: 1_800_000_000_456,
    });

    expect(plan).toMatchObject({
      state: 'legacy_over_capacity',
      disposition: 'candidate',
    });
    expect(transaction.TransactItems.length).toBeLessThanOrEqual(100);
    expect(
      transaction.TransactItems.filter((item: any) =>
        String(item.ConditionCheck?.Key?.sk).startsWith('GUARDIAN#'),
      ),
    ).toHaveLength(3);
    const primaryTablePuts = transaction.TransactItems.filter(
      (item: any) => item.Put?.TableName === 'roadmap-prod',
    );
    expect(primaryTablePuts).toHaveLength(4);
    expect(primaryTablePuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({ state: 'legacy_over_capacity' }),
          }),
        }),
        ...[1, 2].map((seatNumber) =>
          expect.objectContaining({
            Put: expect.objectContaining({
              Item: expect.objectContaining({
                seatType: 'minor',
                seatNumber,
                state: 'empty',
              }),
            }),
          }),
        ),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              seatType: 'additional_responsible',
              state: 'empty',
            }),
          }),
        }),
      ]),
    );
  });
});
