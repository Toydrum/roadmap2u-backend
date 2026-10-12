import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeBillingProvider } from '../lambda/billing/stripe-provider';
import { INTEGRATION, type BillingConfig } from '../lambda/billing/model';
import { config } from './support/billing-fixture';

function scenario(stage: BillingConfig['stage']) {
  const c: BillingConfig = { ...config, stage, liveMode: stage === 'prod' };
  const account = { id: c.accountId, country: 'MX', charges_enabled: true, details_submitted: true, requirements: { currently_due: [] as string[] } };
  const product = { id: c.productId, active: true, livemode: c.liveMode, metadata: { integration: INTEGRATION, stage } };
  const sdk = {
    accounts: { retrieve: vi.fn(async () => account) },
    products: { retrieve: vi.fn(async () => product) },
    prices: { retrieve: vi.fn(async (id: string) => ({ id, active: true, livemode: c.liveMode, product: c.productId, currency: 'mxn', unit_amount: id === c.monthlyPriceId ? 9900 : 94900, type: 'recurring', tax_behavior: 'inclusive', recurring: { interval: id === c.monthlyPriceId ? 'month' : 'year', interval_count: 1, usage_type: 'licensed' } })) },
    taxRates: { retrieve: vi.fn(async () => ({ id: c.taxRateId, active: true, inclusive: true, country: 'MX', percentage: 7.25, livemode: c.liveMode })) },
    billingPortal: { configurations: { retrieve: vi.fn(async () => ({ id: c.portalConfigurationId, active: true, livemode: c.liveMode, features: { invoice_history: { enabled: true }, customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address'] }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' }, subscription_update: { enabled: false } } })) } },
  };
  return { account, product, sdk, provider: new StripeBillingProvider(c, sdk as unknown as Stripe) };
}

describe('Sandbox preflight without live service activation', () => {
  it.each(['dev', 'test'])('accepts matching %s test resources before live activation', async (stage) => {
    const { account, sdk, provider } = scenario(stage);
    // The DEV API readback returned charges_enabled=false. Sandboxes support
    // simulated testing before activating services on a live account.
    account.charges_enabled = false;
    account.details_submitted = false;
    account.requirements.currently_due = ['business_profile.url'];
    await expect(provider.preflight()).resolves.toBeUndefined();
    expect(sdk.accounts.retrieve).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each(['dev', 'test', 'prod'])('still rejects a different %s account', async (stage) => {
    const { account, provider } = scenario(stage);
    account.id = 'acct_other';
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it.each(['dev', 'test', 'prod'])('still rejects a non-MX %s account', async (stage) => {
    const { account, provider } = scenario(stage);
    account.country = 'US';
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it('still rejects live resources in a sandbox', async () => {
    const { account, product, provider } = scenario('dev');
    account.charges_enabled = false;
    product.livemode = true;
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it('requires charges enabled for live mode', async () => {
    const { account, provider } = scenario('prod');
    account.charges_enabled = false;
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it('requires details submitted for live mode', async () => {
    const { account, provider } = scenario('prod');
    account.details_submitted = false;
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it('rejects outstanding live verification requirements', async () => {
    const { account, provider } = scenario('prod');
    account.requirements.currently_due = ['business_profile.url'];
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });

  it('accepts an enabled live account with matching live resources', async () => {
    await expect(scenario('prod').provider.preflight()).resolves.toBeUndefined();
  });
});
