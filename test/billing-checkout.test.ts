import { describe, expect, it } from 'vitest';
import type { BillingConfig } from '../lambda/billing/model';

const NOW = Date.UTC(2026, 9, 11, 12);
export const config: BillingConfig = {
  stage: 'dev', accountId: 'acct_fixture', liveMode: false, purchaseAdmission: { version: 1, mode: 'cohort', ownerSubs: ['adult'] },
  productId: 'prod_individual', monthlyPriceId: 'price_month', annualPriceId: 'price_year',
  taxRateId: 'txr_fixture', portalConfigurationId: 'bpc_fixture',
  catalogVersion: 'individual-mx-v1', termsVersion: 'individual-terms-v1',
  termsHashes: { es: 'a'.repeat(64), en: 'b'.repeat(64) },
  termsUrls: { es: '/subscription-terms?lang=es', en: '/subscription-terms?lang=en' },
  successUrl: 'https://dev.example.test/account/subscription?billing=return',
  cancelUrl: 'https://dev.example.test/account/subscription?billing=cancel',
  portalReturnUrl: 'https://dev.example.test/account/subscription',
};
export const request = (commandId = 'purchase-1', revision = 0) => ({
  commandId, expectedBillingRevision: revision, interval: 'month' as const,
  catalogVersion: config.catalogVersion, country: 'MX' as const,
  termsAcceptance: { version: config.termsVersion, hash: config.termsHashes.es, language: 'es' as const, accepted: true as const },
});

export async function setup() {
  const domain = await import('../lambda/billing/service').catch(() => null);
  expect(domain, 'durable individual billing domain exists').not.toBeNull();
  const { MemoryBillingRepository } = await import('../lambda/billing/repository');
  const { FakeBillingProvider } = await import('../lambda/billing/fake-provider');
  const repository = new MemoryBillingRepository();
  repository.actors.set('adult', { ownerSub: 'adult', accountType: 'adult', status: 'active', emailVerified: true, adultDeclarationCurrent: true });
  const provider = new FakeBillingProvider(config, () => NOW);
  let now = NOW;
  let enabled = true;
  const service = new domain!.BillingService({ repository, provider, config, now: () => now, purchasesEnabled: async () => enabled });
  return { service, repository, provider, setNow: (v: number) => { now = v; }, setEnabled: (v: boolean) => { enabled = v; } };
}

describe('individual billing purchase journal', () => {
  it('purchases without a household and records exact consent before the provider call', async () => {
    const { service, repository, provider } = await setup();
    const result = await service.checkout('adult', request());
    expect(result.outcome).toBe('redirect');
    expect(provider.customers.size).toBe(1);
    expect(provider.checkouts.size).toBe(1);
    const command = await repository.command('adult', 'purchase-1');
    expect(command?.consent).toMatchObject({ accountId: 'adult', acceptedAt: NOW, version: config.termsVersion, hash: config.termsHashes.es, language: 'es' });
    expect(command?.checkoutParams).toMatchObject({ priceId: config.monthlyPriceId, quantity: 1, mode: 'subscription', expiresAt: NOW + 1_860_000 });
    expect(repository.sources.size).toBe(0);
  });

  it('same command reuses the session and never grants access from a redirect', async () => {
    const { service, provider, repository } = await setup();
    const first = await service.checkout('adult', request());
    expect(await service.checkout('adult', request())).toEqual(first);
    expect(provider.checkouts.size).toBe(1);
    expect(repository.sources.size).toBe(0);
  });

  it('different command in two tabs cannot create another nonterminal checkout', async () => {
    const { service, provider } = await setup();
    const results = await Promise.all([service.checkout('adult', request()), service.checkout('adult', request('purchase-2'))]);
    expect(results.some((r) => r.outcome === 'redirect')).toBe(true);
    expect(results.some((r) => r.outcome === 'pending')).toBe(true);
    expect(provider.customers.size).toBe(1);
    expect(provider.checkouts.size).toBe(1);
  });

  it('rejects reuse of a command with a different interval', async () => {
    const { service } = await setup();
    await service.checkout('adult', request());
    await expect(service.checkout('adult', { ...request(), interval: 'year' })).rejects.toMatchObject({ code: 'BILLING_REVISION_CONFLICT' });
  });

  it.each([
    { accountType: 'minor' }, { status: 'closing' }, { emailVerified: false }, { adultDeclarationCurrent: false }, { privacyMode: 'adolescent_private' },
  ])('rejects canonical ineligible profile even with general privacy mode off: %j', async (change) => {
    const { service, repository, provider } = await setup();
    repository.actors.set('adult', { ...repository.actors.get('adult')!, ...change });
    await expect(service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(provider.checkouts.size).toBe(0);
  });

  it('rejects terms, country, unknown caller-supplied Stripe IDs and stale revisions', async () => {
    const { service, provider } = await setup();
    await expect(service.checkout('adult', { ...request(), customerId: 'cus_other' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(service.checkout('adult', { ...request(), termsAcceptance: { ...request().termsAcceptance, hash: 'c'.repeat(64) } })).rejects.toMatchObject({ code: 'BILLING_TERMS_OUTDATED' });
    await expect(service.checkout('adult', { ...request(), country: 'US' })).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    await expect(service.checkout('adult', request('purchase', 99))).rejects.toMatchObject({ code: 'BILLING_REVISION_CONFLICT' });
    expect(provider.checkouts.size).toBe(0);
  });

  it('recovers a timeout after remote creation using the original key and exact parameters', async () => {
    const { service, provider, repository } = await setup();
    provider.failAfterCheckout = true;
    const pending = await service.checkout('adult', request());
    expect(pending.outcome).toBe('pending');
    const before = structuredClone(await repository.command('adult', 'purchase-1'));
    const recovered = await service.checkout('adult', request());
    expect(recovered.outcome).toBe('redirect');
    expect(provider.checkouts.size).toBe(1);
    const after = await repository.command('adult', 'purchase-1');
    expect(after?.checkoutKey).toBe(before?.checkoutKey);
    expect(after?.checkoutParams).toEqual(before?.checkoutParams);
  });

  it('an uncertain operation older than Stripe idempotency retention is recovered by metadata without creating again', async () => {
    const { service, provider, setNow } = await setup();
    provider.failAfterCheckout = true;
    await service.checkout('adult', request());
    setNow(NOW + 25 * 3_600_000);
    await service.checkout('adult', request());
    expect(provider.checkoutCreateCalls).toBe(1);
    expect(provider.checkouts.size).toBe(1);
  });

  it('local expiry cannot release an actually open remote checkout', async () => {
    const { service, provider, setNow } = await setup();
    await service.checkout('adult', request());
    setNow(NOW + 2_000_000);
    const state = await service.summary('adult');
    const result = await service.checkout('adult', request('purchase-2', state.revision));
    expect(result.outcome).toBe('pending');
    expect(provider.checkouts.size).toBe(1);
  });

  it('Portal remains available when new purchases close and never accepts a caller Customer', async () => {
    const { service, setEnabled, provider } = await setup();
    await service.checkout('adult', request());
    setEnabled(false);
    const summary = await service.summary('adult');
    expect(summary.canCheckout).toBe(false);
    const portal = await service.portal('adult', { commandId: 'portal-1', expectedBillingRevision: summary.revision });
    expect(portal.outcome).toBe('redirect');
    expect(provider.portalCustomers).toEqual([Array.from(provider.customers.keys())[0]]);
    await expect(service.portal('adult', { commandId: 'portal-2', expectedBillingRevision: summary.revision, customerId: 'cus_other' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
