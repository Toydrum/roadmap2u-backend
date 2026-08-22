import { describe, expect, it } from 'vitest';
import {
  ADMIN_GRANT_OFFERS,
  PREPAYMENT_CATALOG,
} from '../lambda/commercial/catalog';
import {
  ACCESS_OFFLINE_LEASE_MS,
  accessKey,
  accountClosureKey,
  type AccessItem,
  type GrantItem,
  type ReservedSubscriptionSource,
} from '../lambda/commercial/model';
import {
  AccessResolver,
  deriveAccessItem,
  type AccessMaterializationResult,
  type AccessPutProposal,
  type AccessSnapshot,
} from '../lambda/commercial/access-resolver';

describe('prepayment commercial catalog', () => {
  it('publishes the exact Free and Premium launch offer without enabling payments', () => {
    expect(PREPAYMENT_CATALOG).toEqual({
      version: '2026-08-prepayment-v1',
      pricingVersion: 'launch-2026',
      currency: 'MXN',
      taxInclusive: true,
      paymentsEnabled: false,
      plans: {
        free: {
          limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
          capabilities: { cloudSync: false, social: false, family: false },
        },
        premium: {
          limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
          capabilities: { cloudSync: true, social: true, family: false },
          prices: {
            month: { amountMinor: 9900 },
            year: { amountMinor: 94900 },
          },
        },
      },
    });

    expect(JSON.stringify(PREPAYMENT_CATALOG)).not.toMatch(
      /priceId|provider|checkout|subscription/i,
    );
  });

  it('allowlists one Premium offer whose cadence never changes capabilities', () => {
    expect(ADMIN_GRANT_OFFERS).toEqual({
      premium_demo: {
        catalogVersion: '2026-08-prepayment-v1',
        planKey: 'premium',
        minDurationSeconds: 86_400,
        maxDurationSeconds: 157_680_000,
        permanentAllowed: true,
      },
    });
    expect(ADMIN_GRANT_OFFERS.premium_demo).not.toHaveProperty('billingCadence');
    expect(ADMIN_GRANT_OFFERS.premium_demo).not.toHaveProperty('price');
  });
});

const NOW = Date.UTC(2026, 7, 19, 18, 0, 0);
const OWNER = 'adult-1';

function grant(overrides: Partial<GrantItem> = {}): GrantItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'GRANT#demo-1',
    ownerSub: OWNER,
    grantId: 'demo-1',
    sourceKind: 'sponsored',
    status: 'active',
    catalogVersion: PREPAYMENT_CATALOG.version,
    planKey: 'premium',
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    startsAt: NOW,
    expiresAt: NOW + 60_000,
    revision: 1,
    reason: 'demo access',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function access(overrides: Partial<AccessItem> = {}): AccessItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'ACCESS',
    ownerSub: OWNER,
    effectivePlanKey: 'free',
    catalogVersion: PREPAYMENT_CATALOG.version,
    status: 'active',
    activeSources: [
      { kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null },
    ],
    limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
    capabilities: { cloudSync: false, social: false, family: false },
    revision: 3,
    nextRecomputeAt: null,
    offlineValidUntil: NOW + ACCESS_OFFLINE_LEASE_MS,
    updatedAt: NOW,
    ...overrides,
  };
}

function corruptAccess(overrides: Record<string, unknown>): AccessItem {
  return { ...access(), ...overrides } as unknown as AccessItem;
}

function corruptGrant(overrides: Record<string, unknown>): GrantItem {
  return { ...grant(), ...overrides } as unknown as GrantItem;
}

describe('commercial access model', () => {
  it('uses additive owner keys and keeps ACCOUNT_CLOSURE compatible with the durable subsystem', () => {
    expect(accessKey('adult-1')).toEqual({ pk: 'USER#adult-1', sk: 'ACCESS' });
    expect(accountClosureKey('adult-1')).toEqual({
      pk: 'ACCOUNT_CLOSURE#adult-1',
      sk: 'STATE',
    });
  });

  it('reserves subscription only as a contract source variant', () => {
    const reserved: ReservedSubscriptionSource = {
      kind: 'subscription',
      sourceId: 'future-only',
      planKey: 'premium',
      validUntil: null,
    };

    expect(reserved.kind).toBe('subscription');
    expect(reserved).not.toHaveProperty('pk');
    expect(reserved).not.toHaveProperty('provider');
  });
});

describe('AccessResolver source derivation', () => {
  it('uses [startsAt, expiresAt): active at start and expired at the exact end', () => {
    const bounded = grant({ startsAt: NOW, expiresAt: NOW + 1_000 });

    expect(deriveAccessItem(OWNER, NOW, undefined, [bounded])).toMatchObject({
      effectivePlanKey: 'premium',
      activeSources: [
        {
          kind: 'sponsored',
          sourceId: 'demo-1',
          planKey: 'premium',
          validUntil: NOW + 1_000,
        },
      ],
      nextRecomputeAt: NOW + 1_000,
      offlineValidUntil: NOW + 1_000,
    });
    expect(deriveAccessItem(OWNER, NOW + 1_000, undefined, [bounded])).toMatchObject({
      effectivePlanKey: 'free',
      activeSources: [
        { kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null },
      ],
      nextRecomputeAt: null,
    });
  });

  it('keeps a future grant inactive and recomputes exactly when it starts', () => {
    const future = grant({ startsAt: NOW + 5_000, expiresAt: NOW + 10_000 });

    expect(deriveAccessItem(OWNER, NOW, undefined, [future])).toMatchObject({
      effectivePlanKey: 'free',
      nextRecomputeAt: NOW + 5_000,
      offlineValidUntil: NOW + 5_000,
    });
    expect(deriveAccessItem(OWNER, NOW + 5_000, undefined, [future])).toMatchObject({
      effectivePlanKey: 'premium',
      nextRecomputeAt: NOW + 10_000,
    });
  });

  it('combines exact catalog sources with null dominance and boolean union', () => {
    const free = grant({
      grantId: 'free',
      sk: 'GRANT#free',
      planKey: 'free',
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    });

    const withNull = deriveAccessItem(OWNER, NOW, undefined, [free, grant()]);
    expect(withNull.limits).toEqual({
      maxActiveTrees: null,
      maxVisibleBranchesPerTree: null,
    });
    expect(withNull.capabilities).toEqual({ cloudSync: true, social: true, family: false });
    expect(withNull.effectivePlanKey).toBe('premium');
  });

  it.each([
    ['reserved source kind', { sourceKind: 'subscription' }],
    ['foreign catalog', { catalogVersion: 'other-catalog' }],
    ['unknown plan', { planKey: 'enterprise' }],
    [
      'plan snapshot mismatch',
      { limits: { maxActiveTrees: 3, maxVisibleBranchesPerTree: 10 } },
    ],
    [
      'negative limit',
      { limits: { maxActiveTrees: -1, maxVisibleBranchesPerTree: 10 } },
    ],
    [
      'fractional limit',
      { limits: { maxActiveTrees: 2.5, maxVisibleBranchesPerTree: 10 } },
    ],
    [
      'non-boolean capability',
      { capabilities: { cloudSync: 'yes', social: true, family: false } },
    ],
    [
      'family capability',
      { capabilities: { cloudSync: true, social: true, family: true } },
    ],
    ['zero revision', { revision: 0 }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER }],
    ['unsafe createdAt', { createdAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['future updatedAt', { updatedAt: NOW + 1 }],
    ['unsafe startsAt', { startsAt: Number.NaN }],
    ['unsafe expiresAt', { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'malformed legacy grant',
      { sourceKind: 'legacy_beta', grantId: 'not-legacy', sk: 'GRANT#not-legacy' },
    ],
  ])('ignores a malformed grant with %s', (_label, overrides) => {
    const result = deriveAccessItem(OWNER, NOW, undefined, [corruptGrant(overrides)]);

    expect(result).toMatchObject({
      effectivePlanKey: 'free',
      activeSources: [
        { kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null },
      ],
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    });
  });

  it('ignores revoked, expired and foreign-owner grants and never inherits guardian Premium', () => {
    const result = deriveAccessItem('minor-1', NOW, undefined, [
      grant({
        ownerSub: 'minor-1',
        pk: 'USER#minor-1',
        status: 'revoked',
        startsAt: NOW - 100,
        createdAt: NOW - 100,
        revokedAt: NOW - 1,
      }),
      grant({ ownerSub: 'minor-1', pk: 'USER#minor-1', expiresAt: NOW }),
      grant({ ownerSub: 'guardian-1', pk: 'USER#guardian-1', expiresAt: null }),
    ]);

    expect(result).toMatchObject({
      pk: 'USER#minor-1',
      ownerSub: 'minor-1',
      effectivePlanKey: 'free',
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    });
  });

  it('maps legacy_beta to a permanent revocable sponsored source', () => {
    const legacy = grant({
      grantId: 'legacy_beta',
      sk: 'GRANT#legacy_beta',
      sourceKind: 'legacy_beta',
      expiresAt: null,
      reason: 'preserve_precommercial_access',
    });

    expect(deriveAccessItem(OWNER, NOW, undefined, [legacy])).toMatchObject({
      effectivePlanKey: 'premium',
      activeSources: [
        {
          kind: 'sponsored',
          sourceId: 'legacy_beta',
          planKey: 'premium',
          validUntil: null,
        },
      ],
      nextRecomputeAt: null,
      offlineValidUntil: NOW + ACCESS_OFFLINE_LEASE_MS,
    });
  });

  it('falls back to bounded Free when no valid or legacy source exists', () => {
    expect(deriveAccessItem(OWNER, NOW, undefined, [])).toMatchObject({
      effectivePlanKey: 'free',
      revision: 1,
      nextRecomputeAt: null,
      offlineValidUntil: NOW + ACCESS_OFFLINE_LEASE_MS,
    });
  });
});

describe('AccessResolver materialization', () => {
  function resolverHarness(snapshots: AccessSnapshot[]) {
    const reads: Array<{ ownerSub: string; consistentRead: boolean }> = [];
    const proposals: AccessPutProposal[] = [];
    const outcomes: Array<'committed' | 'conflict'> = [];
    let cursor = 0;
    const resolver = new AccessResolver({
      tableName: 'roadmap-dev',
      now: () => NOW,
      async readSnapshot(ownerSub, options) {
        reads.push({ ownerSub, consistentRead: options.consistentRead });
        const snapshot = snapshots[Math.min(cursor, snapshots.length - 1)];
        cursor += 1;
        return snapshot;
      },
      async materializeAccess(proposal) {
        proposals.push(proposal);
        return outcomes.shift() ?? 'committed';
      },
    });
    return { resolver, reads, proposals, outcomes };
  }

  it('returns a fresh ACCESS without proposing a write', async () => {
    const current = access();
    const harness = resolverHarness([{ access: current, grants: [] }]);

    await expect(harness.resolver.resolveFresh(OWNER)).resolves.toEqual({
      access: current,
      materialization: 'not-required',
    } satisfies AccessMaterializationResult);
    expect(harness.reads).toEqual([{ ownerSub: OWNER, consistentRead: true }]);
    expect(harness.proposals).toEqual([]);
  });

  it.each([
    ['foreign catalog', { catalogVersion: 'other-catalog' }],
    ['expired status', { status: 'expired' }],
    ['zero revision', { revision: 0 }],
    [
      'negative limit',
      { limits: { maxActiveTrees: -1, maxVisibleBranchesPerTree: 10 } },
    ],
    [
      'non-boolean capability',
      { capabilities: { cloudSync: 'yes', social: false, family: false } },
    ],
    [
      'family capability',
      { capabilities: { cloudSync: false, social: false, family: true } },
    ],
    ['unsafe next boundary', { nextRecomputeAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe offline lease', { offlineValidUntil: Number.MAX_SAFE_INTEGER + 1 }],
    ['expired offline lease', { offlineValidUntil: NOW }],
    ['future updatedAt', { updatedAt: NOW + 1 }],
    [
      'forged Premium source',
      {
        effectivePlanKey: 'premium',
        activeSources: [
          { kind: 'sponsored', sourceId: 'forged', planKey: 'premium', validUntil: null },
        ],
        limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
        capabilities: { cloudSync: true, social: true, family: false },
      },
    ],
  ])('repairs ACCESS with %s instead of trusting it', async (_label, overrides) => {
    const invalid = corruptAccess(overrides);
    const harness = resolverHarness([{ access: invalid, grants: [] }]);

    const result = await harness.resolver.resolveFresh(OWNER);

    expect(result).toMatchObject({
      materialization: 'refreshed',
      access: {
        effectivePlanKey: 'free',
        activeSources: [
          { kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null },
        ],
        limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
        capabilities: { cloudSync: false, social: false, family: false },
      },
    });
    expect(harness.proposals).toHaveLength(1);
  });

  it('repairs an invalid revision with an exact-value CAS and restarts at revision 1', async () => {
    const invalid = corruptAccess({ revision: 'broken' });
    const harness = resolverHarness([{ access: invalid, grants: [] }]);

    const result = await harness.resolver.resolveFresh(OWNER);

    expect(result).toMatchObject({
      materialization: 'refreshed',
      access: { effectivePlanKey: 'free', revision: 1 },
    });
    expect(harness.proposals[0]?.Put).toMatchObject({
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': 'broken' },
    });
  });

  it('repairs a missing revision only while that same malformed item still exists', async () => {
    const raw = { ...access() } as Record<string, unknown>;
    delete raw['revision'];
    const harness = resolverHarness([{ access: raw as unknown as AccessItem, grants: [] }]);

    const result = await harness.resolver.resolveFresh(OWNER);

    expect(result.access.revision).toBe(1);
    expect(harness.proposals[0]?.Put).toMatchObject({
      ConditionExpression:
        'attribute_exists(pk) AND attribute_exists(sk) AND attribute_not_exists(revision)',
    });
    expect(harness.proposals[0]?.Put.ExpressionAttributeValues).toBeUndefined();
  });

  it('materializes missing ACCESS with revision 1 and an absence CAS', async () => {
    const harness = resolverHarness([{ grants: [] }]);

    const result = await harness.resolver.resolveFresh(OWNER);

    expect(result.materialization).toBe('created');
    expect(result.access).toMatchObject({
      pk: 'USER#adult-1',
      sk: 'ACCESS',
      ownerSub: OWNER,
      effectivePlanKey: 'free',
      revision: 1,
    });
    expect(harness.proposals).toEqual([
      {
        Put: {
          TableName: 'roadmap-dev',
          Item: result.access,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
    ]);
  });

  it('refreshes stale ACCESS with a monotonic revision and revision CAS', async () => {
    const stale = access({ revision: 7, nextRecomputeAt: NOW });
    const harness = resolverHarness([{ access: stale, grants: [grant({ expiresAt: null })] }]);

    const result = await harness.resolver.resolveFresh(OWNER);

    expect(result).toMatchObject({
      materialization: 'refreshed',
      access: { effectivePlanKey: 'premium', revision: 8 },
    });
    expect(harness.proposals[0]?.Put).toMatchObject({
      Item: result.access,
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': 7 },
    });
  });

  it('re-reads after an absence CAS race and returns the winner without overwriting it', async () => {
    const winner = access({
      revision: 1,
      effectivePlanKey: 'premium',
      activeSources: [
        { kind: 'sponsored', sourceId: 'winner', planKey: 'premium', validUntil: null },
      ],
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
    });
    const winningGrant = grant({
      grantId: 'winner',
      sk: 'GRANT#winner',
      expiresAt: null,
    });
    const harness = resolverHarness([
      { grants: [] },
      { access: winner, grants: [winningGrant] },
    ]);
    harness.outcomes.push('conflict');

    await expect(harness.resolver.resolveFresh(OWNER)).resolves.toEqual({
      access: winner,
      materialization: 'not-required',
    });
    expect(harness.reads).toEqual([
      { ownerSub: OWNER, consistentRead: true },
      { ownerSub: OWNER, consistentRead: true },
    ]);
    expect(harness.proposals).toHaveLength(1);
  });

  it('fails with ACCESS_REVISION_CONFLICT after two consecutive CAS losses', async () => {
    const harness = resolverHarness([{ grants: [] }, { grants: [] }]);
    harness.outcomes.push('conflict', 'conflict');

    await expect(harness.resolver.resolveFresh(OWNER)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'ACCESS_REVISION_CONFLICT',
      retryable: true,
    });
    expect(harness.proposals).toHaveLength(2);
  });
});
