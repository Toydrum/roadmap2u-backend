import { describe, expect, it } from 'vitest';
import { LIMITS } from '@app/api/contracts';
import type { ProfileItem } from '../lambda/db';
import { K } from '../lambda/db';
import { accountClosureKey } from '../lambda/account-closure';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import type { CommercialConfigResult, CommercialFlags } from '../lambda/commercial/flags';
import type { UsageMutationDelta } from '../lambda/commercial/usage';
import {
  CommercialMutationWriter,
  usageMigrationKey,
  type CommercialMutationSnapshot,
  type MutationCommitProposal,
  type MutationWriterDeps,
} from '../lambda/commercial/mutation-writer';

const NOW = Date.UTC(2026, 7, 19, 21, 0, 0);
const OWNER = 'adult-1';
const GENERATION = 'generation-7';

interface Request {
  readonly ownerSub: string;
  readonly mutationId: string;
}

function profile(overrides: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(OWNER),
    userId: OWNER,
    username: 'adult_1',
    displayName: 'Adult 1',
    accountType: 'adult',
    socialEnabled: true,
    status: 'active',
    familyFenceVersion: 1,
    createdAt: NOW - 100_000,
    ...overrides,
  };
}

function flags(overrides: Partial<CommercialFlags> = {}): CommercialConfigResult {
  return {
    status: 'available',
    freshness: 'fresh',
    loadedAt: NOW,
    flags: {
      revision: 1,
      quotaMode: 'off',
      capabilityMode: 'off',
      accessCodeIssuanceEnabled: false,
      accessCodeRedemptionEnabled: false,
      premiumPaymentsEnabled: false,
      updatedAt: NOW,
      updatedBy: 'bootstrap',
      reason: 'commercial launch bootstrap',
      ...overrides,
    },
  };
}

function unavailableFlags(): CommercialConfigResult {
  return { status: 'unavailable', reason: 'read-failed' };
}

function premiumAccess(revision = 1): ReturnType<typeof deriveAccessItem> {
  return {
    ...deriveAccessItem(OWNER, NOW, undefined, []),
    effectivePlanKey: 'premium',
    activeSources: [
      {
        kind: 'sponsored',
        sourceId: 'premium-demo',
        planKey: 'premium',
        validUntil: null,
      },
    ],
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    revision,
  };
}

function branchGrowth(): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId: 'tree-1',
    recordWasNew: true,
    treeCounter: 'existing',
    physical: { activeTrees: 0, visibleBranches: 1 },
    quota: { activeTrees: 0, visibleBranches: 1 },
    treeActivity: 'unchanged',
  };
}

function branchReduction(): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId: 'tree-1',
    recordWasNew: false,
    treeCounter: 'existing',
    physical: { activeTrees: 0, visibleBranches: -1 },
    quota: { activeTrees: 0, visibleBranches: -1 },
    treeActivity: 'unchanged',
  };
}

function treeGrowth(): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId: 'tree-2',
    recordWasNew: true,
    treeCounter: 'create',
    physical: { activeTrees: 1, visibleBranches: 0 },
    quota: { activeTrees: 1, visibleBranches: 0 },
    treeActivity: 'activate',
  };
}

function restoreTree(latentVisibleBranches: number): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId: 'tree-1',
    recordWasNew: false,
    treeCounter: 'existing',
    physical: { activeTrees: 1, visibleBranches: 0 },
    quota: { activeTrees: 1, visibleBranches: latentVisibleBranches },
    treeActivity: 'activate',
  };
}

function neutralEdit(): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId: 'tree-1',
    recordWasNew: false,
    treeCounter: 'existing',
    physical: { activeTrees: 0, visibleBranches: 0 },
    quota: { activeTrees: 0, visibleBranches: 0 },
    treeActivity: 'unchanged',
  };
}

function stale(treeId = 'tree-1'): UsageMutationDelta {
  return {
    outcome: 'stale',
    treeId,
    recordWasNew: false,
    physical: { activeTrees: 0, visibleBranches: 0 },
    quota: { activeTrees: 0, visibleBranches: 0 },
    treeActivity: 'unchanged',
  };
}

function newHeart(treeId = 'tree-2'): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId,
    recordWasNew: true,
    treeCounter: 'existing',
    physical: { activeTrees: 0, visibleBranches: 0 },
    quota: { activeTrees: 0, visibleBranches: 0 },
    treeActivity: 'unchanged',
  };
}

function snapshot(
  overrides: Partial<CommercialMutationSnapshot> = {},
): CommercialMutationSnapshot {
  return {
    profile: profile(),
    grants: [],
    access: deriveAccessItem(OWNER, NOW, undefined, []),
    flags: flags(),
    usage: {
      pk: K.user(OWNER),
      sk: 'USAGE',
      state: 'active',
      activeGeneration: GENERATION,
      activeTrees: 1,
    },
    usageByTree: {
      'tree-1': {
        pk: K.user(OWNER),
        sk: 'USAGE#TREE#tree-1',
        generation: GENERATION,
        visibleBranches: 9,
      },
    },
    deltas: [branchGrowth()],
    ...overrides,
  };
}

function harness(
  snapshots: CommercialMutationSnapshot[],
  options: {
    commitOutcomes?: Array<'committed' | 'conflict'>;
    resolvedAccess?: ReturnType<typeof deriveAccessItem>[];
  } = {},
) {
  const reads: Array<{ request: Request; consistentRead: true }> = [];
  const commits: MutationCommitProposal[] = [];
  const decisions: unknown[] = [];
  const accessResolutions: string[] = [];
  const queue = [...snapshots];
  const commitOutcomes = [...(options.commitOutcomes ?? [])];
  const resolvedAccess = [...(options.resolvedAccess ?? [])];
  const deps: MutationWriterDeps<Request> = {
    tableName: 'roadmap-dev',
    now: () => NOW,
    readSnapshot: async (request, options) => {
      reads.push({ request, ...options });
      const next = queue.shift();
      if (!next) throw new Error('missing snapshot');
      return next;
    },
    resolveFreshAccess: async (ownerSub) => {
      accessResolutions.push(ownerSub);
      return resolvedAccess.shift() ?? deriveAccessItem(OWNER, NOW, undefined, []);
    },
    commit: async (_request, proposal) => {
      commits.push(proposal);
      return commitOutcomes.shift() ?? 'committed';
    },
    emitDecision: (decision) => decisions.push(decision),
  };
  return {
    writer: new CommercialMutationWriter(deps),
    reads,
    commits,
    decisions,
    accessResolutions,
    deps,
  };
}

describe('CommercialMutationWriter', () => {
  it('keeps migrated generation counters exact while quota and capability flags are off', async () => {
    const h = harness([snapshot()]);
    const request = { ownerSub: OWNER, mutationId: 'mutation-1' };

    await expect(h.writer.write(request)).resolves.toMatchObject({
      outcome: 'committed',
      attempts: 1,
      usage: 'generation',
      deltas: [branchGrowth()],
    });

    expect(h.reads).toEqual([{ request, consistentRead: true }]);
    expect(h.commits).toHaveLength(1);
    const items = h.commits[0].items;
    expect(items).toEqual(
      expect.arrayContaining([
        {
          ConditionCheck: expect.objectContaining({
            Key: K.profile(OWNER),
          }),
        },
        {
          ConditionCheck: expect.objectContaining({
            Key: accountClosureKey(OWNER),
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          }),
        },
        {
          ConditionCheck: expect.objectContaining({
            Key: usageMigrationKey(OWNER),
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          }),
        },
        {
          ConditionCheck: expect.objectContaining({
            Key: { pk: K.user(OWNER), sk: 'USAGE' },
            ConditionExpression: expect.stringContaining('activeGeneration = :activeGeneration'),
            ExpressionAttributeValues: expect.objectContaining({
              ':activeGeneration': GENERATION,
              ':expectedActiveTrees': 1,
            }),
          }),
        },
        {
          Update: expect.objectContaining({
            Key: { pk: K.user(OWNER), sk: 'USAGE#TREE#tree-1' },
            UpdateExpression: 'ADD visibleBranches :visibleBranchesDelta',
            ConditionExpression: expect.stringContaining('generation = :activeGeneration'),
            ExpressionAttributeValues: expect.objectContaining({
              ':activeGeneration': GENERATION,
              ':expectedVisibleBranches': 9,
              ':visibleBranchesDelta': 1,
            }),
          }),
        },
      ]),
    );
    const accessGuard = items.find(
      (item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS',
    )?.ConditionCheck;
    expect(accessGuard?.ConditionExpression).toContain('revision = :accessRevision');
    expect(accessGuard?.ConditionExpression).toContain('nextRecomputeAt');
    expect(accessGuard?.ExpressionAttributeValues).toMatchObject({ ':accessRevision': 1 });
    expect(JSON.stringify(items)).not.toContain('maxVisibleBranchesPerTree');
  });

  it('guards the PROFILE owner identity as well as its writable lifecycle state', async () => {
    const h = harness([snapshot({ deltas: [neutralEdit()] })]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'profile-race' });

    const guard = h.commits[0].items.find(
      (item) => item.ConditionCheck?.Key?.['sk'] === 'PROFILE',
    )?.ConditionCheck;
    expect(guard?.ConditionExpression).toContain('userId = :ownerSub');
    expect(guard?.ExpressionAttributeValues).toMatchObject({ ':ownerSub': OWNER });
  });

  it('guards an existing tree counter even when its branch delta is zero', async () => {
    const h = harness([
      snapshot({
        deltas: [{ ...neutralEdit(), treeCounter: 'existing' as const }],
      }),
    ]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'zero-tree-delta' });

    expect(
      h.commits[0].items.find(
        (item) => item.ConditionCheck?.Key?.['sk'] === 'USAGE#TREE#tree-1',
      )?.ConditionCheck,
    ).toMatchObject({
      ConditionExpression:
        'generation = :activeGeneration AND visibleBranches = :expectedVisibleBranches',
      ExpressionAttributeValues: {
        ':activeGeneration': GENERATION,
        ':expectedVisibleBranches': 9,
      },
    });
  });

  it.each([
    {
      label: 'PROFILE is closing',
      overrides: { profile: profile({ status: 'closing' }) },
    },
    {
      label: 'ACCOUNT_CLOSURE exists',
      overrides: {
        closure: {
          ...accountClosureKey(OWNER),
          state: 'requested',
        },
      },
    },
  ])('rejects before entitlement work when $label', async ({ overrides }) => {
    const h = harness([snapshot({ ...overrides, deltas: [neutralEdit()] })]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'closing-account' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('rejects an atomic third active tree under Free when quota mode enforces', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'enforce' }),
        usage: {
          pk: K.user(OWNER),
          sk: 'USAGE',
          state: 'active',
          activeGeneration: GENERATION,
          activeTrees: 2,
        },
        usageByTree: {},
        deltas: [treeGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'third-tree' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    expect(h.commits).toHaveLength(0);
    expect(h.decisions).toContainEqual({
      kind: 'quota',
      mode: 'enforce',
      wouldDeny: true,
    });
  });

  it('rejects the eleventh visible branch under Free when quota mode enforces', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'enforce' }),
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 10,
          },
        },
        deltas: [branchGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'eleventh-branch' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(h.commits).toEqual([]);
  });

  it('re-evaluates quota from the winning counter after a concurrent conflict', async () => {
    const h = harness(
      [
        snapshot({ flags: flags({ quotaMode: 'enforce' }) }),
        snapshot({
          flags: flags({ quotaMode: 'enforce' }),
          usageByTree: {
            'tree-1': {
              pk: K.user(OWNER),
              sk: 'USAGE#TREE#tree-1',
              generation: GENERATION,
              visibleBranches: 10,
            },
          },
        }),
      ],
      { commitOutcomes: ['conflict'] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'concurrent-eleventh' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    expect(h.reads).toHaveLength(2);
    expect(h.commits).toHaveLength(1);
  });

  it('does not impose numeric quotas when the resolved plan limits are null', async () => {
    const access = premiumAccess();
    const h = harness(
      [
        snapshot({
          access,
          flags: flags({ quotaMode: 'enforce', capabilityMode: 'enforce' }),
          usage: {
            pk: K.user(OWNER),
            sk: 'USAGE',
            state: 'active',
            activeGeneration: GENERATION,
            activeTrees: 50,
          },
          usageByTree: {},
          deltas: [treeGrowth()],
        }),
      ],
      { resolvedAccess: [access] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'premium-growth' }),
    ).resolves.toMatchObject({ outcome: 'committed' });
    expect(h.decisions).toEqual(
      expect.arrayContaining([
        { kind: 'cloudSync', mode: 'enforce', wouldDeny: false },
        { kind: 'quota', mode: 'enforce', wouldDeny: false },
      ]),
    );
  });

  it('observes an over-quota tree growth but still commits exact counters', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'observe' }),
        usage: {
          pk: K.user(OWNER),
          sk: 'USAGE',
          state: 'active',
          activeGeneration: GENERATION,
          activeTrees: 2,
        },
        usageByTree: {},
        deltas: [treeGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'observe-third-tree' }),
    ).resolves.toMatchObject({ outcome: 'committed' });

    expect(h.decisions).toContainEqual({
      kind: 'quota',
      mode: 'observe',
      wouldDeny: true,
    });
    expect(
      h.commits[0].items.find((item) => item.Update?.Key?.['sk'] === 'USAGE')
        ?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':expectedActiveTrees': 2, ':activeTreesDelta': 1 });
  });

  it('allows a reduction while already above the Free branch limit', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'enforce' }),
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 11,
          },
        },
        deltas: [branchReduction()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'reduce-over-limit' }),
    ).resolves.toMatchObject({ outcome: 'committed' });
    expect(h.decisions).toContainEqual({
      kind: 'quota',
      mode: 'enforce',
      wouldDeny: false,
    });
  });

  it('does not double-count latent branches when restoring a tree within quota', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'enforce' }),
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 6,
          },
        },
        deltas: [restoreTree(6)],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'restore-six-branches' }),
    ).resolves.toMatchObject({ outcome: 'committed' });
    expect(h.decisions).toContainEqual({
      kind: 'quota',
      mode: 'enforce',
      wouldDeny: false,
    });
  });

  it('rejects restoring a tree whose latent count already exceeds Free', async () => {
    const h = harness([
      snapshot({
        flags: flags({ quotaMode: 'enforce' }),
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 11,
          },
        },
        deltas: [restoreTree(11)],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'restore-eleven-branches' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(h.commits).toEqual([]);
  });

  it('enforces cloudSync independently for a new record on not-yet-migrated USAGE', async () => {
    const h = harness([
      snapshot({
        flags: flags({ capabilityMode: 'enforce' }),
        usage: {
          pk: K.user(OWNER),
          sk: 'USAGE',
          state: 'active',
          activeTrees: 0,
        },
        usageByTree: {},
        deltas: [branchGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'new-cloud-record' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });

    expect(h.commits).toHaveLength(0);
    expect(h.decisions).toContainEqual({
      kind: 'cloudSync',
      mode: 'enforce',
      wouldDeny: true,
    });
  });

  it('observes missing cloudSync capability without blocking the group', async () => {
    const h = harness([
      snapshot({ flags: flags({ capabilityMode: 'observe' }) }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'observe-cloud-sync' }),
    ).resolves.toMatchObject({ outcome: 'committed' });
    expect(h.decisions).toContainEqual({
      kind: 'cloudSync',
      mode: 'observe',
      wouldDeny: true,
    });
  });

  it('does not net cloud growth against a reduction for capability enforcement', async () => {
    const h = harness([
      snapshot({
        flags: flags({ capabilityMode: 'enforce' }),
        deltas: [branchGrowth(), branchReduction()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'mixed-cloud-growth' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(h.commits).toEqual([]);
  });

  it.each([
    {
      label: 'USAGE is absent',
      usage: undefined,
    },
    {
      label: 'USAGE is the exact pre-generation shape',
      usage: {
        pk: K.user(OWNER),
        sk: 'USAGE',
        state: 'active',
        activeTrees: 0,
      },
    },
  ])('keeps the compatible path when $label', async ({ usage }) => {
    const h = harness([
      snapshot({ usage, usageByTree: {}, deltas: [branchGrowth()] }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'compatible-usage' }),
    ).resolves.toMatchObject({ outcome: 'committed', usage: 'compatible' });

    expect(
      h.commits[0].items.some((item) => {
        const key = item.Update?.Key ?? item.ConditionCheck?.Key ?? item.Put?.Item;
        return key?.['sk'] === 'USAGE' || key?.['sk']?.toString().startsWith('USAGE#TREE#');
      }),
    ).toBe(false);
  });

  it('fails unavailable configuration on any growth without netting a reduction', async () => {
    const h = harness([
      snapshot({
        flags: unavailableFlags(),
        deltas: [branchGrowth(), branchReduction()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'unavailable-mixed-growth' }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
    expect(h.commits).toEqual([]);
  });

  it('allows and counts a reduction while configuration is unavailable', async () => {
    const h = harness([
      snapshot({ flags: unavailableFlags(), deltas: [branchReduction()] }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'unavailable-reduction' }),
    ).resolves.toMatchObject({ outcome: 'committed', usage: 'generation' });

    expect(h.decisions).toEqual([]);
    expect(
      h.commits[0].items.find(
        (item) => item.Update?.Key?.['sk'] === 'USAGE#TREE#tree-1',
      )?.Update?.ExpressionAttributeValues,
    ).toMatchObject({ ':visibleBranchesDelta': -1 });
    expect(JSON.stringify(h.commits[0].items)).not.toContain('quotaMode');
    expect(JSON.stringify(h.commits[0].items)).not.toContain('capabilityMode');
  });

  it.each([
    {
      label: 'a negative activeTrees counter',
      usage: {
        pk: K.user(OWNER),
        sk: 'USAGE',
        state: 'active',
        activeTrees: -1,
      },
    },
    {
      label: 'a malformed activeGeneration',
      usage: {
        pk: K.user(OWNER),
        sk: 'USAGE',
        state: 'active',
        activeGeneration: '',
        activeTrees: 0,
      },
    },
  ])('fails closed for present USAGE with $label', async ({ usage }) => {
    const h = harness([
      snapshot({ usage, usageByTree: {}, deltas: [neutralEdit()] }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'corrupt-usage' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('materializes missing Free ACCESS inside the same mutation transaction', async () => {
    const h = harness([
      snapshot({
        access: undefined,
        usage: { pk: K.user(OWNER), sk: 'USAGE', state: 'active', activeTrees: 0 },
        usageByTree: {},
        deltas: [neutralEdit()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'missing-access' }),
    ).resolves.toMatchObject({ outcome: 'committed', usage: 'compatible' });

    expect(h.accessResolutions).toEqual([]);
    const items = h.commits[0].items;
    expect(items).toContainEqual({
      Put: {
        TableName: 'roadmap-dev',
        Item: deriveAccessItem(OWNER, NOW, undefined, []),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
    expect(items.some((item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS')).toBe(false);
  });

  it('re-reads and re-evaluates when a missing ACCESS Put loses to backfill', async () => {
    const winner = { ...deriveAccessItem(OWNER, NOW, undefined, []), revision: 7 };
    const compatibleUsage = {
      pk: K.user(OWNER),
      sk: 'USAGE',
      state: 'active',
      activeTrees: 0,
    };
    const h = harness(
      [
        snapshot({
          access: undefined,
          usage: compatibleUsage,
          usageByTree: {},
          deltas: [neutralEdit()],
        }),
        snapshot({
          access: winner,
          usage: compatibleUsage,
          usageByTree: {},
          deltas: [neutralEdit()],
        }),
      ],
      { commitOutcomes: ['conflict', 'committed'], resolvedAccess: [winner] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'access-race' }),
    ).resolves.toMatchObject({ outcome: 'committed', attempts: 2 });

    expect(h.reads).toHaveLength(2);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[0].items.some((item) => item.Put?.Item?.['sk'] === 'ACCESS')).toBe(true);
    expect(
      h.commits[1].items.find((item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS')
        ?.ConditionCheck?.ExpressionAttributeValues,
    ).toMatchObject({ ':accessRevision': 7 });
  });

  it.each([
    {
      label: 'still expired after refresh',
      resolved: {
        ...deriveAccessItem(OWNER, NOW, undefined, []),
        nextRecomputeAt: NOW,
      },
    },
    {
      label: 'bound to another owner',
      resolved: deriveAccessItem('adult-2', NOW, undefined, []),
    },
  ])('never commits when resolved ACCESS is $label', async ({ resolved }) => {
    const h = harness(
      [snapshot({ deltas: [neutralEdit()] })],
      { resolvedAccess: [resolved] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'invalid-access' }),
    ).rejects.toMatchObject({ code: 'ACCESS_REVISION_CONFLICT' });
    expect(h.commits).toEqual([]);
  });

  it('conditions the refreshed ACCESS revision after an expired snapshot', async () => {
    const expired = {
      ...deriveAccessItem(OWNER, NOW - 100, undefined, []),
      nextRecomputeAt: NOW - 1,
      offlineValidUntil: NOW - 1,
    };
    const refreshed = deriveAccessItem(OWNER, NOW, expired, []);
    const h = harness(
      [snapshot({ access: expired, deltas: [neutralEdit()] })],
      { resolvedAccess: [refreshed] },
    );

    await h.writer.write({ ownerSub: OWNER, mutationId: 'refresh-access' });

    expect(
      h.commits[0].items.find((item) => item.ConditionCheck?.Key?.['sk'] === 'ACCESS')
        ?.ConditionCheck?.ExpressionAttributeValues,
    ).toMatchObject({ ':accessRevision': 2, ':nullType': 'NULL' });
  });

  it('re-reads lifecycle state after a transaction conflict and never writes after closure wins', async () => {
    const h = harness(
      [
        snapshot({ deltas: [neutralEdit()] }),
        snapshot({
          closure: { ...accountClosureKey(OWNER), state: 'requested' },
          deltas: [neutralEdit()],
        }),
      ],
      { commitOutcomes: ['conflict'] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'closure-race' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(h.reads).toHaveLength(2);
    expect(h.commits).toHaveLength(1);
    expect(h.accessResolutions).toEqual([OWNER]);
  });

  it('bounds transaction conflict retries to two complete snapshots', async () => {
    const h = harness(
      [
        snapshot({ deltas: [neutralEdit()] }),
        snapshot({ deltas: [neutralEdit()] }),
      ],
      { commitOutcomes: ['conflict', 'conflict'] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'two-conflicts' }),
    ).rejects.toMatchObject({ code: 'ACCESS_REVISION_CONFLICT' });

    expect(h.reads).toHaveLength(2);
    expect(h.commits).toHaveLength(2);
  });

  it('aggregates two branch records for one tree into one +2 counter update', async () => {
    const h = harness([
      snapshot({
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 8,
          },
        },
        deltas: [branchGrowth(), branchGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'two-branches' }),
    ).resolves.toMatchObject({ outcome: 'committed', usage: 'generation' });

    const treeUpdates = h.commits[0].items.flatMap((item) =>
      item.Update?.Key?.['sk'] === 'USAGE#TREE#tree-1' ? [item.Update] : [],
    );
    expect(treeUpdates).toHaveLength(1);
    expect(treeUpdates[0].ExpressionAttributeValues).toMatchObject({
      ':expectedVisibleBranches': 8,
      ':visibleBranchesDelta': 2,
    });
  });

  it('updates counters for two different trees in the same transaction proposal', async () => {
    const otherTreeGrowth = { ...branchGrowth(), treeId: 'tree-2' };
    const h = harness([
      snapshot({
        usageByTree: {
          'tree-1': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-1',
            generation: GENERATION,
            visibleBranches: 3,
          },
          'tree-2': {
            pk: K.user(OWNER),
            sk: 'USAGE#TREE#tree-2',
            generation: GENERATION,
            visibleBranches: 4,
          },
        },
        deltas: [branchGrowth(), otherTreeGrowth],
      }),
    ]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'two-trees' });

    const treeKeys = h.commits[0].items
      .flatMap((item) => (item.Update?.Key?.['sk']?.toString().startsWith('USAGE#TREE#') ? [item.Update.Key] : []))
      .map((key) => key?.['sk'])
      .sort();
    expect(treeKeys).toEqual(['USAGE#TREE#tree-1', 'USAGE#TREE#tree-2']);
  });

  it('rejects more deltas than one mutation group can contain before entitlement work', async () => {
    const deltas = Array.from(
      { length: LIMITS.syncMutationGroupMax + 1 },
      (_, index) => ({ ...neutralEdit(), treeId: `tree-${index}` }),
    );
    const h = harness([snapshot({ deltas })]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'oversized-group' }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });
    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('keeps the maximum commercial block to 25 items for TASK-032 transaction headroom', async () => {
    const deltas = Array.from(
      { length: LIMITS.syncMutationGroupMax },
      (_, index) => ({ ...branchGrowth(), treeId: `tree-${index}` }),
    );
    const usageByTree = Object.fromEntries(
      deltas.map((delta, index) => [
        delta.treeId,
        {
          pk: K.user(OWNER),
          sk: `USAGE#TREE#${delta.treeId}`,
          generation: GENERATION,
          visibleBranches: index,
        },
      ]),
    );
    const h = harness([snapshot({ deltas, usageByTree })]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'maximum-group' });

    expect(h.commits[0].items).toHaveLength(25);
    const keys = h.commits[0].items.map((item) => {
      const key = item.ConditionCheck?.Key ?? item.Update?.Key ?? item.Put?.Item;
      return `${key?.['pk']}|${key?.['sk']}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(25 + LIMITS.syncMutationGroupMax + 1).toBeLessThanOrEqual(100);
  });

  it('returns stale for the whole group and never commits when any member is stale', async () => {
    const h = harness([
      snapshot({ deltas: [stale(), branchGrowth()] }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'mixed-stale' }),
    ).resolves.toMatchObject({ outcome: 'stale', attempts: 1 });
    expect(h.commits).toHaveLength(0);
  });

  it('lets whole-group stale precedence avoid an otherwise active migration fence', async () => {
    const h = harness([
      snapshot({
        migration: {
          ...usageMigrationKey(OWNER),
          state: 'migrating',
          generation: GENERATION,
          leaseUntil: NOW + 10_000,
        },
        deltas: [stale(), branchGrowth()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'stale-before-fence' }),
    ).resolves.toMatchObject({ outcome: 'stale' });
    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('creates the generation counter atomically for a new tree plus its heart', async () => {
    const h = harness([
      snapshot({
        usageByTree: {},
        deltas: [treeGrowth(), newHeart()],
      }),
    ]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'tree-and-heart' });

    expect(h.commits[0].items).toContainEqual({
      Put: {
        TableName: 'roadmap-dev',
        Item: {
          pk: K.user(OWNER),
          sk: 'USAGE#TREE#tree-2',
          generation: GENERATION,
          visibleBranches: 0,
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('rejects an active migration fence before resolving ACCESS or committing', async () => {
    const h = harness([
      snapshot({
        migration: {
          ...usageMigrationKey(OWNER),
          state: 'migrating',
          generation: GENERATION,
          leaseUntil: NOW + 1,
        },
        deltas: [neutralEdit()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'active-fence' }),
    ).rejects.toMatchObject({ code: 'USAGE_MIGRATION_IN_PROGRESS' });

    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('conditions an expired migration fence on the exact state, generation and lease', async () => {
    const h = harness([
      snapshot({
        migration: {
          ...usageMigrationKey(OWNER),
          state: 'migrating',
          generation: GENERATION,
          leaseUntil: NOW - 1,
        },
        deltas: [neutralEdit()],
      }),
    ]);

    await h.writer.write({ ownerSub: OWNER, mutationId: 'expired-fence' });

    const guard = h.commits[0].items.find(
      (item) => item.ConditionCheck?.Key?.['sk'] === 'USAGE_MIGRATION',
    )?.ConditionCheck;
    expect(guard).toMatchObject({
      Key: usageMigrationKey(OWNER),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':migrationState': 'migrating',
        ':migrationGeneration': GENERATION,
        ':migrationLeaseUntil': NOW - 1,
        ':now': NOW,
      },
    });
    expect(guard?.ConditionExpression).toContain('#state = :migrationState');
    expect(guard?.ConditionExpression).toContain('generation = :migrationGeneration');
    expect(guard?.ConditionExpression).toContain('leaseUntil = :migrationLeaseUntil');
    expect(guard?.ConditionExpression).toContain('leaseUntil <= :now');
  });

  it('rechecks the migration fence after a transaction conflict and stops the retry', async () => {
    const h = harness(
      [
        snapshot({ deltas: [neutralEdit()] }),
        snapshot({
          migration: {
            ...usageMigrationKey(OWNER),
            state: 'migrating',
            generation: 'generation-8',
            leaseUntil: NOW + 10_000,
          },
          deltas: [neutralEdit()],
        }),
      ],
      { commitOutcomes: ['conflict'] },
    );

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'fence-after-conflict' }),
    ).rejects.toMatchObject({ code: 'USAGE_MIGRATION_IN_PROGRESS' });

    expect(h.reads).toHaveLength(2);
    expect(h.commits).toHaveLength(1);
    expect(h.accessResolutions).toEqual([OWNER]);
  });

  it('fails closed on a malformed migration item without resolving ACCESS', async () => {
    const h = harness([
      snapshot({
        migration: {
          ...usageMigrationKey(OWNER),
          state: 'migrating',
          generation: GENERATION,
        },
        deltas: [neutralEdit()],
      }),
    ]);

    await expect(
      h.writer.write({ ownerSub: OWNER, mutationId: 'malformed-fence' }),
    ).rejects.toMatchObject({ code: 'USAGE_MIGRATION_IN_PROGRESS' });
    expect(h.accessResolutions).toEqual([]);
    expect(h.commits).toEqual([]);
  });
});
