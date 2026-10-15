import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { StripeBillingProvider } from '../lambda/billing/stripe-provider';
import { MemoryBillingRepository } from '../lambda/billing/repository';
import { BillingProjector } from '../lambda/billing/projection';
import { AccessResolver } from '../lambda/commercial/access-resolver';
import { INTEGRATION, STRIPE_API_VERSION } from '../lambda/billing/model';
import { config, fixture, invoice, NOW, request } from './support/billing-fixture';

function rawSubscription(interval: 'month' | 'year' = 'month') {
  const end = Date.UTC(interval === 'month' ? 2026 : 2027, interval === 'month' ? 10 : 9, 11, 12) / 1000;
  return {
    id: 'sub_1', object: 'subscription', customer: 'cus_1', livemode: false,
    metadata: { integration: INTEGRATION, stage: 'dev', owner: 'adult' },
    status: 'active', billing_mode: { type: 'flexible' as 'flexible' | 'classic' },
    cancel_at: end as number | null, cancel_at_period_end: false,
    collection_method: 'charge_automatically', automatic_tax: { enabled: false },
    default_tax_rates: [{ id: config.taxRateId, inclusive: true, country: 'MX' }],
    pause_collection: null, discounts: [], trial_start: null, trial_end: null,
    items: { has_more: false, data: [{ id: 'si_1', quantity: 1, current_period_start: NOW / 1000, current_period_end: end,
      price: { id: interval === 'month' ? config.monthlyPriceId : config.annualPriceId, product: config.productId,
        currency: 'mxn', tax_behavior: 'inclusive', recurring: { interval, interval_count: 1, usage_type: 'licensed' } } }] },
  };
}

// Stub only Stripe's HTTP boundary; normalization and both snapshot paths are real.
async function normalized(raw: ReturnType<typeof rawSubscription>, history = false) {
  const calls: { method: string; version: string | null }[] = [];
  const sdk = new Stripe('sk_test_fixture', {
    apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ method: init?.method ?? 'GET', version: new Headers(init?.headers).get('Stripe-Version') });
      let body: unknown;
      if (path === '/v1/customers/cus_1') body = { id: 'cus_1', object: 'customer', livemode: false, address: { country: 'MX' }, metadata: { integration: INTEGRATION, stage: 'dev', owner: 'adult' } };
      else if (path === '/v1/subscriptions') body = { data: [raw], has_more: false };
      else if (path === '/v1/subscriptions/sub_1') body = raw;
      else if (path === '/v1/invoices') body = { data: [], has_more: false };
      else throw new Error(`Unexpected fixture request: ${path}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } });
    }),
  });
  const provider = new StripeBillingProvider(config, sdk, history ? { repository: new MemoryBillingRepository(), now: () => NOW } : undefined);
  const snapshot = await provider.snapshot('cus_1', { ownerSub: 'adult' });
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(c => c.method === 'GET' && c.version === STRIPE_API_VERSION)).toBe(true);
  return snapshot.subscriptions[0];
}

describe('Portal cancellation in flexible billing mode', () => {
  it.each(['month', 'year'] as const)('normalizes the %s Portal cancellation with a false legacy flag', async interval => {
    const result = await normalized(rawSubscription(interval));
    expect(result).toMatchObject({ status: 'active', interval, cancelAtPeriodEnd: true, configurationValid: true });
  });

  it.each(['month', 'year'] as const)('refreshes a %s Portal cancellation through the history snapshot', async interval => {
    expect(await normalized(rawSubscription(interval), true)).toMatchObject({ cancelAtPeriodEnd: true, configurationValid: true });
  });

  it('keeps an uncancelled flexible subscription renewable', async () => {
    const raw = rawSubscription(); raw.cancel_at = null;
    expect(await normalized(raw)).toMatchObject({ cancelAtPeriodEnd: false, configurationValid: true });
  });

  it('preserves classic Portal cancellations', async () => {
    const raw = rawSubscription(); raw.billing_mode.type = 'classic'; raw.cancel_at_period_end = true;
    expect(await normalized(raw)).toMatchObject({ cancelAtPeriodEnd: true, configurationValid: true });
  });

  it.each([0, -1, 1.5, 'not-a-timestamp', 'off-period'] as const)('does not silently treat an unsupported cancel_at (%s) as renewable', async value => {
    const raw = rawSubscription();
    Object.assign(raw, { cancel_at: value === 'off-period' ? raw.items.data[0].current_period_end - 60 : value });
    expect(await normalized(raw)).toMatchObject({ configurationValid: false });
  });

  it('projects scheduled end, suppresses renewal and retains Premium only through the paid invoice', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    const sub = await normalized(rawSubscription());
    f.provider.subscriptions.set(sub.id, sub); f.provider.invoices.set('in_1', invoice(sub.customerId));
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'portal-worker' });
    await projector.reconcileOwner('adult');
    const paidThrough = Date.UTC(2026, 10, 11, 12);
    expect(await f.service.summary('adult')).toMatchObject({ state: 'cancel_at_period_end', cancelAtPeriodEnd: true, nextRenewalAt: null, paidThrough });
    const source = f.repository.sources.get('adult')!;
    expect(source).toMatchObject({ state: 'scheduled_end', paidThrough, graceUntil: null });
    expect(await f.repository.receipts('adult')).toHaveLength(1);
    const resolver = new AccessResolver({ tableName: 'roadmap', now: f.now,
      readSnapshot: async () => ({ grants: [], subscription: f.repository.sources.get('adult'), ownerProfile: { accountType: 'adult' } }),
      materializeAccess: async () => 'committed' });
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('premium');
    f.setNow(paidThrough);
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('free');
    expect(await f.service.summary('adult')).toMatchObject({ state: 'expired', nextRenewalAt: null, paidThrough });
  });

  it('returns to ordinary renewal after the same scheduled cancellation is removed', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    const raw = rawSubscription(), sub = await normalized(raw);
    f.provider.subscriptions.set(sub.id, sub); f.provider.invoices.set('in_1', invoice(sub.customerId));
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'portal-worker' });
    await projector.reconcileOwner('adult');
    expect((await f.service.summary('adult')).nextRenewalAt).toBeNull();
    raw.cancel_at = null; f.provider.subscriptions.set(sub.id, await normalized(raw));
    await projector.reconcileOwner('adult');
    expect(await f.service.summary('adult')).toMatchObject({ state: 'active', cancelAtPeriodEnd: false, nextRenewalAt: Date.UTC(2026, 10, 11, 12) });
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect(await f.repository.receipts('adult')).toHaveLength(1);
  });
});
