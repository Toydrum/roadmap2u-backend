import { describe, expect, it, vi } from 'vitest';
import * as Flags from '../lambda/commercial/flags';
import { errorResponse } from '../lambda/http';
import { ApiError } from '@app/api/contracts';
const legacy = { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', ...Flags.FAMILY_BILLING_FLAG_DEFAULTS, revision: 7, quotaMode: 'enforce', capabilityMode: 'enforce', accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: true, premiumPaymentsEnabled: false, updatedAt: 1, updatedBy: 'synthetic-operator', reason: 'explicit individual rollout' };
const individual = { ...legacy, schemaVersion: 2, paymentScope: 'individual', premiumPaymentsEnabled: true, individualCheckoutEnabled: true };
function enabled(value: unknown): boolean {
  const fn = (Flags as unknown as Record<string, unknown>)['individualPurchasesEnabled'];
  expect(fn).toBeTypeOf('function');
  return (fn as (value: unknown) => boolean)(value);
}
function resolver(read: () => Promise<unknown>, now: () => number = () => 0) {
  return new Flags.CommercialFlagsResolver({ readItem: read, now, emitMetric: vi.fn() });
}
describe('individual commercial configuration version 2', () => {
  it('keeps legacy activation attempts closed and requires explicit versioned individual scope', async () => {
    expect(enabled(await resolver(async () => ({ ...legacy, premiumPaymentsEnabled: true })).resolve())).toBe(false);
    const result = await resolver(async () => individual).resolve();
    expect(result).toMatchObject({ status: 'available', freshness: 'fresh', flags: { schemaVersion: 2, paymentScope: 'individual', premiumPaymentsEnabled: true, individualCheckoutEnabled: true } });
    expect(enabled(result)).toBe(true);
  });
  it.each([{ schemaVersion: 1 }, { paymentScope: 'family' }, { checkoutEnabled: true }, { familyCatalogEnabled: true }, { subscriptionChangesEnabled: true }, { extra: true }])('blocks malformed or family configuration %j', async (patch) => {
    const result = await resolver(async () => ({ ...individual, ...patch })).resolve();
    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    expect(enabled(result)).toBe(false);
  });
  it('blocks missing and stale configuration; closing sales only changes the individual purchase predicate', async () => {
    expect(enabled(await resolver(async () => undefined).resolve())).toBe(false);
    let now = 0; let failure = false;
    const source = resolver(async () => { if (failure) throw Error('unavailable'); return individual; }, () => now);
    expect(enabled(await source.resolve())).toBe(true); failure = true; now = 30000;
    const stale = await source.resolve(); expect(stale).toMatchObject({ freshness: 'stale' }); expect(enabled(stale)).toBe(false);
    expect(enabled(await resolver(async () => ({ ...individual, individualCheckoutEnabled: false })).resolve())).toBe(false);
  });
  it('maps the six individual billing failures without exposing internal financial records', () => {
    for (const [code, status] of [['BILLING_REVISION_CONFLICT',409],['BILLING_OPERATION_PENDING',409],['BILLING_TERMS_OUTDATED',409],['BILLING_BUYER_INELIGIBLE',403],['BILLING_SUBSCRIPTION_EXISTS',409],['BILLING_PAYMENT_REVIEW',409]] as const)
      expect(errorResponse(new ApiError(code))).toMatchObject({ statusCode: status });
  });
});
