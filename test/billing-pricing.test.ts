import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { BillingService } from '../lambda/billing/service';
import { BillingProjector } from '../lambda/billing/projection';
import { StripeBillingProvider } from '../lambda/billing/stripe-provider';
import { purchasesConfigReady } from '../lambda/billing/config';
import { INTEGRATION, initialState, type BillingConfig, type Interval } from '../lambda/billing/model';
import { config, fixture, invoice, request, subscription } from './support/billing-fixture';

const legacyConfig: BillingConfig = { ...config, catalogVersion: 'individual-mx-2026-10-v1' };
const currentConfig: BillingConfig = {
  ...config,
  catalogVersion: 'individual-mx-2026-10-v2',
  monthlyPriceId: 'price_month_v2',
  annualPriceId: 'price_year_v2',
};
function purchase(interval: Interval = 'month') {
  return { ...request(), interval, catalogVersion: currentConfig.catalogVersion };
}
function currentInvoice(customerId: string, interval: Interval, amount: number) {
  const value = invoice(customerId);
  value.amountDue = value.amountPaid = amount;
  value.lines[0] = {
    ...value.lines[0], interval, amount,
    priceId: interval === 'month' ? currentConfig.monthlyPriceId : currentConfig.annualPriceId,
  };
  value.payments[0].amountPaid = amount;
  return value;
}
function preflightProvider(catalogVersion: string, month: number, year: number) {
  let calls = 0;
  const respond = <T>(value: T) => async () => { calls++; return value; };
  const sdk = {
    accounts: { retrieve: respond({ id: config.accountId, country: 'MX', charges_enabled: true, details_submitted: true, requirements: { currently_due: [] } }) },
    products: { retrieve: respond({ id: config.productId, active: true, livemode: false, metadata: { integration: INTEGRATION, stage: 'dev' } }) },
    prices: { retrieve: async (id: string) => {
      calls++;
      const monthly = id === currentConfig.monthlyPriceId;
      return { id, active: true, livemode: false, product: config.productId, currency: 'mxn', unit_amount: monthly ? month : year, type: 'recurring', tax_behavior: 'inclusive', recurring: { interval: monthly ? 'month' : 'year', interval_count: 1, usage_type: 'licensed' } };
    } },
    taxRates: { retrieve: respond({ id: config.taxRateId, active: true, inclusive: true, country: 'MX', percentage: 16, livemode: false }) },
    billingPortal: { configurations: { retrieve: respond({ id: config.portalConfigurationId, active: true, livemode: false, features: {
      invoice_history: { enabled: true }, customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address'] },
      payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' }, subscription_update: { enabled: false },
    } }) } },
  } as unknown as Stripe;
  return { provider: new StripeBillingProvider({ ...currentConfig, catalogVersion, taxRatePercentage: 16 }, sdk), calls: () => calls };
}

describe('versioned individual pricing with VAT included', () => {
  it('publishes the approved inclusive totals while leaving the v1 offer unchanged', async () => {
    const f = await fixture();
    const current = new BillingService({ ...f, config: currentConfig, purchasesEnabled: async () => false });
    expect(await current.catalog()).toMatchObject({ catalogVersion: currentConfig.catalogVersion, prices: { month: { amountMinor: 11484 }, year: { amountMinor: 110084 } }, purchasesEnabled: false });
    const legacy = new BillingService({ ...f, config: legacyConfig, purchasesEnabled: async () => false });
    expect((await legacy.catalog()).prices).toEqual({ month: { amountMinor: 9900 }, year: { amountMinor: 94900 } });
  });
  it.each([['month', 11484], ['year', 110084]] as const)('reserves the approved %s amount before Checkout', async (interval, amount) => {
    const f = await fixture();
    const service = new BillingService({ ...f, config: currentConfig, purchasesEnabled: async () => true });
    expect((await service.checkout('adult', purchase(interval))).outcome).toBe('redirect');
    const saved = await f.repository.command('adult', 'purchase-1');
    expect(saved?.priceTerms).toMatchObject({ amountMinor: amount, interval, catalogVersion: currentConfig.catalogVersion, priceId: interval === 'month' ? currentConfig.monthlyPriceId : currentConfig.annualPriceId });
  });
  it.each([['month', 11484], ['year', 110084]] as const)('projects a verified %s payment with current terms', async (interval, amount) => {
    const f = await fixture();
    const customer = await f.provider.createCustomer({ ownerSub: 'adult', operationId: 'restored-customer' }, 'restored-customer');
    f.repository.states.set('adult', { ...initialState('adult'), customerId: customer.id });
    f.provider.subscriptions.set('sub_1', { ...subscription(customer.id), interval, priceId: interval === 'month' ? currentConfig.monthlyPriceId : currentConfig.annualPriceId });
    f.provider.invoices.set('in_1', currentInvoice(customer.id, interval, amount));
    await new BillingProjector({ ...f, config: currentConfig, nextWorkerId: () => 'pricing-worker' }).reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect((await f.repository.load('adult')).priceBindings?.[0]).toMatchObject({ amountMinor: amount, catalogVersion: currentConfig.catalogVersion });
  });
  it('rejects an old amount presented as a new-version payment', async () => {
    const f = await fixture();
    const customer = await f.provider.createCustomer({ ownerSub: 'adult', operationId: 'restored-customer' }, 'restored-customer');
    f.repository.states.set('adult', { ...initialState('adult'), customerId: customer.id });
    f.provider.subscriptions.set('sub_1', { ...subscription(customer.id), priceId: currentConfig.monthlyPriceId });
    f.provider.invoices.set('in_1', currentInvoice(customer.id, 'month', 9900));
    await new BillingProjector({ ...f, config: currentConfig, nextWorkerId: () => 'pricing-worker' }).reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
    expect((await f.repository.load('adult')).state).toBe('payment_review');
  });
  it('retains an original reservation when v2 becomes current before the first payment', async () => {
    const f = await fixture();
    const oldService = new BillingService({ ...f, config: legacyConfig, purchasesEnabled: async () => true });
    await oldService.checkout('adult', { ...request(), catalogVersion: legacyConfig.catalogVersion });
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', { ...subscription(customerId), operationId: command.operationId });
    f.provider.invoices.set('in_1', invoice(customerId));
    await new BillingProjector({ ...f, config: currentConfig, nextWorkerId: () => 'pricing-worker' }).reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect((await f.repository.load('adult')).priceBindings?.[0]).toMatchObject({ amountMinor: 9900, catalogVersion: legacyConfig.catalogVersion, priceId: legacyConfig.monthlyPriceId });
  });
  it('preflights the new inclusive pair using the actual provider validator', async () => {
    await expect(preflightProvider(currentConfig.catalogVersion, 11484, 110084).provider.preflight()).resolves.toBeUndefined();
  });
  it('rejects a crossed catalog version and price pair', async () => {
    await expect(preflightProvider(currentConfig.catalogVersion, 9900, 94900).provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });
  it('rejects an unknown catalog before any Stripe read', async () => {
    const f = preflightProvider('unknown-catalog', 9900, 94900);
    await expect(f.provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect(f.calls()).toBe(0);
    expect(purchasesConfigReady({ ...currentConfig, catalogVersion: 'unknown-catalog' })).toBe(false);
  });
  it('keeps Portal available when the new purchase catalog is unavailable', async () => {
    const f = await fixture();
    const customer = await f.provider.createCustomer({ ownerSub: 'adult', operationId: 'existing-customer' }, 'existing-customer');
    f.repository.states.set('adult', { ...initialState('adult'), customerId: customer.id });
    const service = new BillingService({ ...f, config: { ...currentConfig, catalogVersion: 'unknown-catalog' }, purchasesEnabled: async () => false });
    expect((await service.portal('adult', { commandId: 'manage-existing', expectedBillingRevision: 0 })).outcome).toBe('redirect');
  });
});
