import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@app/api/contracts';
import {
  CommercialFlagsResolver,
  flagsForCommercialOperation,
  isCommercialSwitchEnabled,
  type CommercialConfigResult,
  type CommercialFlags,
  type CommercialMetricName,
} from '../lambda/commercial/flags';

const RAW_FLAGS = Object.freeze({
  pk: 'COMMERCIAL#CONFIG',
  sk: 'FLAGS',
  revision: 7,
  quotaMode: 'observe',
  capabilityMode: 'enforce',
  accessCodeIssuanceEnabled: true,
  accessCodeRedemptionEnabled: false,
  premiumPaymentsEnabled: false,
  updatedAt: 1_724_000_000_000,
  updatedBy: 'arn:aws:iam::111122223333:role/commercial-operator',
  reason: 'exercise the staged rollout',
});

const FLAGS = Object.freeze({
  revision: 7,
  quotaMode: 'observe',
  capabilityMode: 'enforce',
  accessCodeIssuanceEnabled: true,
  accessCodeRedemptionEnabled: false,
  premiumPaymentsEnabled: false,
  updatedAt: 1_724_000_000_000,
  updatedBy: 'arn:aws:iam::111122223333:role/commercial-operator',
  reason: 'exercise the staged rollout',
}) satisfies CommercialFlags;

function createResolver(readItem: () => Promise<unknown>, initialNow = 0) {
  let currentNow = initialNow;
  const metrics: CommercialMetricName[] = [];
  const trackedRead = vi.fn(readItem);
  const resolver = new CommercialFlagsResolver({
    readItem: trackedRead,
    now: () => currentNow,
    emitMetric: (metric) => metrics.push(metric),
  });

  return {
    resolver,
    readItem: trackedRead,
    metrics,
    setNow: (value: number) => {
      currentNow = value;
    },
  };
}

describe('commercial configuration flags — exact parser', () => {
  it('loads the exact DynamoDB item as a fresh immutable snapshot', async () => {
    const { resolver } = createResolver(async () => RAW_FLAGS, 123);

    await expect(resolver.resolve()).resolves.toEqual({
      status: 'available',
      freshness: 'fresh',
      flags: FLAGS,
      loadedAt: 123,
    });
  });

  it.each([
    ['a missing item', undefined, 'missing'],
    ['a null item', null, 'invalid'],
    ['an array', [], 'invalid'],
    ['an extra field', { ...RAW_FLAGS, checkoutEnabled: true }, 'invalid'],
    ['the wrong partition key', { ...RAW_FLAGS, pk: 'USER#someone' }, 'invalid'],
    ['the wrong sort key', { ...RAW_FLAGS, sk: 'CUTOVER' }, 'invalid'],
    ['a missing field', (({ reason: _reason, ...item }) => item)(RAW_FLAGS), 'invalid'],
    ['an unknown quota mode', { ...RAW_FLAGS, quotaMode: 'shadow' }, 'invalid'],
    ['an unknown capability mode', { ...RAW_FLAGS, capabilityMode: 'on' }, 'invalid'],
    ['a zero revision', { ...RAW_FLAGS, revision: 0 }, 'invalid'],
    ['a fractional revision', { ...RAW_FLAGS, revision: 7.5 }, 'invalid'],
    ['an unsafe revision', { ...RAW_FLAGS, revision: Number.MAX_SAFE_INTEGER + 1 }, 'invalid'],
    ['a string boolean', { ...RAW_FLAGS, accessCodeIssuanceEnabled: 'true' }, 'invalid'],
    ['a fractional timestamp', { ...RAW_FLAGS, updatedAt: 1.5 }, 'invalid'],
    ['an unsafe timestamp', { ...RAW_FLAGS, updatedAt: Number.MAX_SAFE_INTEGER + 1 }, 'invalid'],
    ['a blank actor', { ...RAW_FLAGS, updatedBy: '   ' }, 'invalid'],
    ['a blank reason', { ...RAW_FLAGS, reason: '' }, 'invalid'],
  ] as const)('fails closed for %s', async (_label, item, reason) => {
    const { resolver, metrics } = createResolver(async () => item);

    await expect(resolver.resolve()).resolves.toEqual({
      status: 'unavailable',
      reason,
    });
    expect(metrics).toEqual(['CommercialConfigurationUnavailable']);
  });

  it('distinguishes a failed read from missing and invalid configuration', async () => {
    const { resolver, metrics } = createResolver(async () => {
      throw new Error('DynamoDB is unavailable');
    });

    await expect(resolver.resolve()).resolves.toEqual({
      status: 'unavailable',
      reason: 'read-failed',
    });
    expect(metrics).toEqual(['CommercialConfigurationUnavailable']);
  });

  it('forces corrupt premium payments off and emits drift once per fetch', async () => {
    const { resolver, readItem, metrics, setNow } = createResolver(async () => ({
      ...RAW_FLAGS,
      premiumPaymentsEnabled: true,
    }));

    const first = await resolver.resolve();
    setNow(29_999);
    const cached = await resolver.resolve();
    setNow(30_000);
    const refreshed = await resolver.resolve();

    expect(first.status === 'available' && first.flags.premiumPaymentsEnabled).toBe(false);
    expect(cached.status === 'available' && cached.flags.premiumPaymentsEnabled).toBe(false);
    expect(refreshed.status === 'available' && refreshed.flags.premiumPaymentsEnabled).toBe(false);
    expect(readItem).toHaveBeenCalledTimes(2);
    expect(metrics).toEqual(['ConfigurationDrift', 'ConfigurationDrift']);
  });
});

describe('commercial configuration flags — cache and last-known-good', () => {
  it('uses cache below 30 seconds and refreshes at the boundary', async () => {
    const { resolver, readItem, setNow } = createResolver(async () => RAW_FLAGS);

    expect(await resolver.resolve()).toMatchObject({ freshness: 'fresh', loadedAt: 0 });
    setNow(29_999);
    expect(await resolver.resolve()).toMatchObject({ freshness: 'cache', loadedAt: 0 });
    setNow(30_000);
    expect(await resolver.resolve()).toMatchObject({ freshness: 'fresh', loadedAt: 30_000 });
    expect(readItem).toHaveBeenCalledTimes(2);
  });

  it('uses a last-known-good snapshot after a failed refresh and throttles retries', async () => {
    let reads = 0;
    const { resolver, readItem, metrics, setNow } = createResolver(async () => {
      reads += 1;
      if (reads === 1) return RAW_FLAGS;
      throw new Error('temporary read failure');
    });

    await resolver.resolve();
    setNow(30_000);
    await expect(resolver.resolve()).resolves.toEqual({
      status: 'available',
      freshness: 'stale',
      flags: FLAGS,
      loadedAt: 0,
    });
    setNow(59_999);
    await expect(resolver.resolve()).resolves.toMatchObject({ freshness: 'stale' });

    expect(readItem).toHaveBeenCalledTimes(2);
    expect(metrics).toEqual(['CommercialConfigurationStale']);
  });

  it('accepts last-known-good through 15 minutes and expires it immediately after', async () => {
    let reads = 0;
    const { resolver, metrics, setNow } = createResolver(async () => {
      reads += 1;
      if (reads === 1) return RAW_FLAGS;
      throw new Error('persistent read failure');
    });

    await resolver.resolve();
    setNow(15 * 60_000);
    await expect(resolver.resolve()).resolves.toMatchObject({
      status: 'available',
      freshness: 'stale',
      loadedAt: 0,
    });
    setNow(15 * 60_000 + 1);
    await expect(resolver.resolve()).resolves.toEqual({
      status: 'unavailable',
      reason: 'expired',
    });
    expect(metrics).toEqual([
      'CommercialConfigurationStale',
      'CommercialConfigurationUnavailable',
    ]);
  });

  it('keeps the last-known-good snapshot for missing and invalid refreshes', async () => {
    for (const failedValue of [undefined, { ...RAW_FLAGS, quotaMode: 'bad' }]) {
      let reads = 0;
      const { resolver, setNow } = createResolver(async () => {
        reads += 1;
        return reads === 1 ? RAW_FLAGS : failedValue;
      });

      await resolver.resolve();
      setNow(30_000);
      await expect(resolver.resolve()).resolves.toMatchObject({
        status: 'available',
        freshness: 'stale',
        flags: FLAGS,
      });
    }
  });

  it('rejects a revision rollback instead of replacing the last-known-good snapshot', async () => {
    let reads = 0;
    const { resolver, metrics, setNow } = createResolver(async () => {
      reads += 1;
      return reads === 1 ? RAW_FLAGS : { ...RAW_FLAGS, revision: RAW_FLAGS.revision - 1 };
    });

    await resolver.resolve();
    setNow(30_000);
    await expect(resolver.resolve()).resolves.toMatchObject({
      status: 'available',
      freshness: 'stale',
      flags: FLAGS,
    });
    expect(metrics).toEqual(['ConfigurationDrift', 'CommercialConfigurationStale']);
  });

  it('rejects changed values that reuse a revision', async () => {
    let reads = 0;
    const { resolver, metrics, setNow } = createResolver(async () => {
      reads += 1;
      return reads === 1
        ? RAW_FLAGS
        : { ...RAW_FLAGS, accessCodeRedemptionEnabled: true };
    });

    await resolver.resolve();
    setNow(30_000);
    await expect(resolver.resolve()).resolves.toMatchObject({
      status: 'available',
      freshness: 'stale',
      flags: FLAGS,
    });
    expect(metrics).toEqual(['ConfigurationDrift', 'CommercialConfigurationStale']);
  });
});

describe('commercial configuration flags — fail-closed operation matrix', () => {
  const unavailable = Object.freeze({
    status: 'unavailable',
    reason: 'read-failed',
  }) satisfies CommercialConfigResult;

  const available = Object.freeze({
    status: 'available',
    freshness: 'fresh',
    flags: FLAGS,
    loadedAt: 0,
  }) satisfies CommercialConfigResult;

  it('returns flags to every operation when configuration is available', () => {
    expect(flagsForCommercialOperation(available, { kind: 'read' })).toBe(FLAGS);
    expect(flagsForCommercialOperation(available, { kind: 'cloud-delta', delta: 1 })).toBe(
      FLAGS,
    );
    expect(
      flagsForCommercialOperation(available, { kind: 'social', action: 'create' }),
    ).toBe(FLAGS);
  });

  it.each([
    { kind: 'read' } as const,
    { kind: 'cloud-delta', delta: -2 } as const,
    { kind: 'cloud-delta', delta: 0 } as const,
    { kind: 'social', action: 'decline' } as const,
    { kind: 'social', action: 'cancel' } as const,
    { kind: 'social', action: 'remove' } as const,
    { kind: 'social', action: 'privacy' } as const,
    { kind: 'social', action: 'export' } as const,
  ])('allows safe operation $kind/$action without inventing off flags', (operation) => {
    expect(flagsForCommercialOperation(unavailable, operation)).toBeNull();
  });

  it.each([
    { kind: 'cloud-delta', delta: 1 } as const,
    { kind: 'cloud-delta', delta: Number.NaN } as const,
    { kind: 'social', action: 'create' } as const,
    { kind: 'social', action: 'accept' } as const,
    { kind: 'social', action: 'visit' } as const,
  ])('rejects sensitive operation $kind/$action while unavailable', (operation) => {
    expect(() => flagsForCommercialOperation(unavailable, operation)).toThrowError(ApiError);
    try {
      flagsForCommercialOperation(unavailable, operation);
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
    }
  });

  it.each(['issuance', 'redemption', 'payments'] as const)(
    'forces %s off while configuration is unavailable',
    (commercialSwitch) => {
      expect(isCommercialSwitchEnabled(unavailable, commercialSwitch)).toBe(false);
    },
  );

  it('maps available issuance/redemption flags while payments remain impossible', () => {
    expect(isCommercialSwitchEnabled(available, 'issuance')).toBe(true);
    expect(isCommercialSwitchEnabled(available, 'redemption')).toBe(false);
    expect(isCommercialSwitchEnabled(available, 'payments')).toBe(false);
  });
});
