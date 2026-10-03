import { describe, expect, it } from 'vitest';
import {
  AccessResolver,
  deriveAccessItem,
  type AccessSnapshot,
  type AccessPutProposal,
} from '../lambda/commercial/access-resolver';
import { PREPAYMENT_CATALOG } from '../lambda/commercial/catalog';
import type { GrantItem, SubscriptionSourceItem } from '../lambda/commercial/model';
import { createCoverageAssignment, type CoverageAssignmentItem } from '../lambda/family/model';

const NOW = 1_800_000_000_000;
const OWNER = 'account-a';

function subscription(overrides: Partial<SubscriptionSourceItem> = {}): SubscriptionSourceItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'SUBSCRIPTION#INDIVIDUAL',
    entityType: 'SubscriptionSource',
    ownerSub: OWNER,
    sourceId: 'subscription-a',
    state: 'active',
    paidThrough: NOW + 120_000,
    graceUntil: null,
    revision: 1,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function coverage(overrides: Partial<CoverageAssignmentItem> = {}): CoverageAssignmentItem {
  return {
    ...createCoverageAssignment({
      householdId: 'household-a',
      accountId: OWNER,
      seatType: 'minor',
      paidThrough: NOW + 60_000,
      now: NOW - 1_000,
    }),
    ...overrides,
  };
}

function grant(): GrantItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'GRANT#demo',
    ownerSub: OWNER,
    grantId: 'demo',
    sourceKind: 'sponsored',
    status: 'active',
    catalogVersion: PREPAYMENT_CATALOG.version,
    planKey: 'premium',
    limits: { ...PREPAYMENT_CATALOG.plans.premium.limits },
    capabilities: { ...PREPAYMENT_CATALOG.plans.premium.capabilities },
    startsAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    revision: 1,
    reason: 'test grant',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
  };
}

describe('independent commercial access sources', () => {
  it.each(['sponsored', 'legacy_beta'] as const)(
    'preserves valid %s grants issued under the legacy catalog',
    (sourceKind) => {
      const oldGrant: GrantItem = {
        ...grant(),
        sourceKind,
        catalogVersion: '2026-08-prepayment-v1',
      };
      const source: GrantItem =
        sourceKind === 'legacy_beta'
          ? {
              ...oldGrant,
              grantId: 'legacy_beta',
              sk: 'GRANT#legacy_beta',
              reason: 'preserve_precommercial_access',
              expiresAt: null,
            }
          : oldGrant;
      const result = deriveAccessItem(OWNER, NOW, undefined, [source]);
      expect(result.effectivePlanKey).toBe('premium');
      expect(result.catalogVersion).toBe(PREPAYMENT_CATALOG.version);
      expect(result.capabilities.family).toBe(false);
      expect(source.catalogVersion).toBe('2026-08-prepayment-v1');
    },
  );

  it('still rejects forged family capabilities in legacy grants', () => {
    const oldGrant = {
      ...grant(),
      catalogVersion: '2026-08-prepayment-v1',
      capabilities: { cloudSync: true, social: true, family: true },
    };
    expect(deriveAccessItem(OWNER, NOW, undefined, [oldGrant]).effectivePlanKey).toBe('free');
  });

  it('combines grants, an individual subscription and family coverage without multiplying capabilities', () => {
    const sources = { subscription: subscription(), coverage: coverage() };
    const snapshot = structuredClone(sources);
    const result = deriveAccessItem(OWNER, NOW, undefined, [grant()], sources);
    expect(result).toMatchObject({
      effectivePlanKey: 'premium',
      capabilities: { cloudSync: true, social: true, family: true },
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      nextRecomputeAt: NOW + 30_000,
      offlineValidUntil: NOW + 30_000,
    });
    expect(result.activeSources).toHaveLength(3);
    expect(result.activeSources).toEqual(
      expect.arrayContaining([
        { kind: 'sponsored', sourceId: 'demo', planKey: 'premium', validUntil: NOW + 30_000 },
        {
          kind: 'subscription',
          scope: 'individual',
          sourceId: 'subscription-a',
          planKey: 'premium',
          validUntil: NOW + 120_000,
        },
        {
          kind: 'subscription',
          scope: 'family_member',
          sourceId: `family:household-a:${OWNER}`,
          householdId: 'household-a',
          seatType: 'minor',
          planKey: 'premium',
          validUntil: NOW + 60_000,
        },
      ]),
    );
    expect(sources).toEqual(snapshot);
  });

  it.each(['primary_responsible', 'minor', 'additional_responsible'] as const)(
    'traces family coverage for the exact %s beneficiary',
    (seatType) => {
      const result = deriveAccessItem(OWNER, NOW, undefined, [], {
        coverage: coverage({ seatType }),
      });
      expect(result.capabilities.family).toBe(true);
      expect(result.activeSources).toEqual([
        expect.objectContaining({ householdId: 'household-a', seatType, scope: 'family_member' }),
      ]);
    },
  );

  it('labels indefinite family pilot coverage as sponsored and removes it when revoked', () => {
    const pilot = createCoverageAssignment({
      householdId: 'household-a',
      accountId: OWNER,
      seatType: 'primary_responsible',
      source: 'sponsored_pilot',
      now: NOW - 1_000,
    });
    const active = deriveAccessItem(OWNER, NOW, undefined, [], { coverage: pilot });
    expect(active.activeSources).toEqual([
      expect.objectContaining({
        kind: 'sponsored',
        scope: 'family_member',
        validUntil: null,
      }),
    ]);
    expect(active.capabilities.family).toBe(true);
    const revoked = deriveAccessItem(OWNER, NOW, active, [], {
      coverage: { ...pilot, state: 'ended', revision: 2 },
    });
    expect(revoked.effectivePlanKey).toBe('free');
    expect(revoked.capabilities.family).toBe(false);
  });

  it('ends a minor pilot source at majority while retaining independent Premium', () => {
    const pilot = createCoverageAssignment({ householdId: 'household-a', accountId: OWNER,
      seatType: 'minor', source: 'sponsored_pilot', now: NOW - 1_000 });
    const majorityAt = new Date(NOW + 86_400_000).toISOString().slice(0, 10);
    const boundary = Date.parse(`${majorityAt}T00:00:00.000Z`);
    const sources = { coverage: pilot, ownerProfile: { accountType: 'minor' as const, majorityAt } };
    const before = deriveAccessItem(OWNER, boundary - 1, undefined, [], sources);
    expect(before.activeSources[0]).toMatchObject({ kind: 'sponsored',
      scope: 'family_member', validUntil: boundary });
    expect(before.nextRecomputeAt).toBe(boundary);
    const after = deriveAccessItem(OWNER, boundary, before, [], {
      ...sources, subscription: subscription({ paidThrough: boundary + 120_000 }),
    });
    expect(after.activeSources).toHaveLength(1);
    expect(after.activeSources[0]).toMatchObject({ scope: 'individual' });
    expect(after.capabilities.family).toBe(false);
    expect(after.effectivePlanKey).toBe('premium');
  });

  it('keeps an individual subscription when the grant and family coverage expire', () => {
    const sources = { subscription: subscription(), coverage: coverage() };
    const result = deriveAccessItem(OWNER, NOW + 60_000, undefined, [grant()], sources);
    expect(result.capabilities).toEqual({ cloudSync: true, social: true, family: false });
    expect(result.activeSources).toHaveLength(1);
    expect(result.activeSources[0]).toMatchObject({ scope: 'individual' });
    expect(result.nextRecomputeAt).toBe(NOW + 120_000);
  });

  it.each(['subscription', 'coverage'] as const)(
    '%s ends exactly at paidThrough without an implicit grace period',
    (kind) => {
      const row =
        kind === 'subscription'
          ? subscription({ paidThrough: NOW })
          : coverage({ paidThrough: NOW });
      const result = deriveAccessItem(OWNER, NOW, undefined, [], { [kind]: row });
      expect(result.effectivePlanKey).toBe('free');
      expect(result.nextRecomputeAt).toBeNull();
    },
  );

  it.each(['subscription', 'coverage'] as const)(
    '%s honors explicit grace and drops it at the exact boundary',
    (kind) => {
      const periods = { state: 'grace' as const, paidThrough: NOW - 1, graceUntil: NOW + 40_000 };
      const row = kind === 'subscription' ? subscription(periods) : coverage(periods);
      const sources = { [kind]: row };
      expect(deriveAccessItem(OWNER, NOW, undefined, [], sources)).toMatchObject({
        effectivePlanKey: 'premium',
        nextRecomputeAt: NOW + 40_000,
        offlineValidUntil: NOW + 40_000,
      });
      expect(deriveAccessItem(OWNER, NOW + 40_000, undefined, [], sources).effectivePlanKey).toBe(
        'free',
      );
    },
  );

  it.each(['subscription', 'coverage'] as const)(
    '%s scheduled cancellation preserves paid access until its boundary',
    (kind) => {
      const periods = { state: 'scheduled_end' as const, paidThrough: NOW + 5_000 };
      const row = kind === 'subscription' ? subscription(periods) : coverage(periods);
      expect(deriveAccessItem(OWNER, NOW, undefined, [], { [kind]: row }).effectivePlanKey).toBe(
        'premium',
      );
      expect(
        deriveAccessItem(OWNER, NOW + 5_000, undefined, [], { [kind]: row }).effectivePlanKey,
      ).toBe('free');
    },
  );

  it.each(['subscription', 'coverage'] as const)(
    'ending %s leaves a sponsored grant unchanged',
    (kind) => {
      const row =
        kind === 'subscription' ? subscription({ state: 'ended' }) : coverage({ state: 'ended' });
      const sponsored = grant();
      const before = structuredClone(sponsored);
      const result = deriveAccessItem(OWNER, NOW, undefined, [sponsored], { [kind]: row });
      expect(result.capabilities).toEqual({ cloudSync: true, social: true, family: false });
      expect(result.activeSources).toEqual([
        {
          kind: 'sponsored',
          sourceId: 'demo',
          planKey: 'premium',
          validUntil: sponsored.expiresAt,
        },
      ]);
      expect(sponsored).toEqual(before);
    },
  );

  it.each([
    { pk: 'USER#other' },
    { sk: 'other' },
    { entityType: 'other' },
    { revision: 0 },
    { paidThrough: Number.NaN },
    { updatedAt: NOW + 1 },
    { state: 'incomplete' },
    { state: 'grace', graceUntil: null },
    { state: 'grace', graceUntil: NOW + 1 },
    { state: 'active', graceUntil: NOW + 200_000 },
  ])('does not trust malformed persisted source fields %j', (overrides) => {
    for (const sources of [
      { subscription: subscription(overrides as Partial<SubscriptionSourceItem>) },
      { coverage: coverage(overrides as Partial<CoverageAssignmentItem>) },
    ]) {
      const result = deriveAccessItem(OWNER, NOW, undefined, [], sources);
      expect(result.effectivePlanKey).toBe('free');
      expect(result.capabilities.family).toBe(false);
      expect(result.nextRecomputeAt).toBeNull();
    }
  });

  it('rejects foreign owners and forged family identities', () => {
    for (const sources of [
      { subscription: subscription({ ownerSub: 'other' }) },
      { subscription: subscription({ sourceId: '' }) },
      { subscription: subscription({ sourceId: ' source with spaces ' }) },
      { coverage: coverage({ accountId: 'other' }) },
      { coverage: coverage({ householdId: '' }) },
      { coverage: coverage({ householdId: 'household#notcanonical' }) },
      { coverage: coverage({ householdId: 'h'.repeat(129) }) },
      { coverage: coverage({ seatType: 'friend' as never }) },
    ])
      expect(deriveAccessItem(OWNER, NOW, undefined, [], sources).effectivePlanKey).toBe('free');
  });

  it('revalidates cached family metadata instead of trusting a substituted household or seat', async () => {
    const covered = coverage();
    const canonical = deriveAccessItem(OWNER, NOW - 1, undefined, [], { coverage: covered });
    const writes: AccessPutProposal[] = [];
    const resolver = new AccessResolver({
      tableName: 'roadmap',
      now: () => NOW,
      readSnapshot: async () => ({
        grants: [],
        coverage: covered,
        access: {
          ...canonical,
          activeSources: canonical.activeSources.map((source) => ({
            ...source,
            householdId: 'foreign',
            seatType: 'additional_responsible',
          })),
        },
      }),
      materializeAccess: async (proposal) => {
        writes.push(proposal);
        return 'committed';
      },
    });
    const resolved = await resolver.resolveFresh(OWNER);
    expect(resolved.materialization).toBe('refreshed');
    expect(resolved.access.activeSources[0]).toMatchObject({
      householdId: 'household-a',
      seatType: 'minor',
    });
    expect(writes).toHaveLength(1);
  });

  it('reuses a current combined snapshot without gratuitous materialization', async () => {
    const snapshot: AccessSnapshot = {
      grants: [grant()],
      subscription: subscription(),
      coverage: coverage(),
    };
    const previous = deriveAccessItem(OWNER, NOW - 1, undefined, snapshot.grants, snapshot);
    const resolver = new AccessResolver({
      tableName: 'roadmap',
      now: () => NOW,
      readSnapshot: async () => ({ ...snapshot, access: previous }),
      materializeAccess: async () => {
        throw new Error('unexpected materialization');
      },
    });
    expect((await resolver.resolveFresh(OWNER)).materialization).toBe('not-required');
    expect(previous.capabilities.family).toBe(true);
  });
});
