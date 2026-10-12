import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { config, NOW } from './support/billing-fixture';
import { INTEGRATION, STRIPE_API_VERSION } from '../lambda/billing/model';

async function adapter(client?: Stripe) {
  const mod = await import('../lambda/billing/stripe-provider').catch(() => null);
  expect(mod, 'pinned Stripe adapter exists').not.toBeNull();
  return new mod!.StripeBillingProvider(config, client ?? new Stripe('sk_test_fixture', { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0 }));
}
describe('Stripe23 / Endive adapter', () => {
  it('uses pinned API and server-only Checkout parameters on the actual SDK transport', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const sdk = new Stripe('sk_test_fixture', { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'cs_1', object: 'checkout.session', customer: 'cus_1', client_reference_id: 'adult', metadata: { integration: INTEGRATION, stage: 'dev', owner: 'adult', operation: 'op_1' }, status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: NOW / 1000 + 1800, subscription: null, livemode: false }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } });
    }) });
    const provider = await adapter(sdk);
    const result = await provider.createCheckout({ ownerSub: 'adult', operationId: 'op_1', customerId: 'cus_1', priceId: 'price_month', mode: 'subscription', quantity: 1, taxRateId: 'txr_fixture', expiresAt: NOW + 1_800_000, successUrl: config.successUrl, cancelUrl: config.cancelUrl }, 'stable-key');
    expect(result.status).toBe('open');
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Stripe-Version')).toBe(STRIPE_API_VERSION);
    expect(headers.get('Idempotency-Key')).toBe('stable-key');
    const body = decodeURIComponent(String(calls[0].init?.body));
    expect(body).toContain('allowed_payment_method_types[0]=card');
    expect(body).toContain('subscription_data[default_tax_rates][0]=txr_fixture');
    expect(body).toContain('allow_promotion_codes=false');
    expect(body).not.toContain('trial');
  });
  it('reads Endive invoice.parent, line.pricing and invoice_payments instead of legacy fields', async () => {
    const charge = { id: 'ch_1', paid: true, captured: true, currency: 'mxn', customer: 'cus_1', amount: 9900, amount_captured: 9900, amount_refunded: 0, livemode: false, payment_method_details: { type: 'card' } };
    const sdk = {
      customers: { retrieve: vi.fn(async () => ({ id: 'cus_1', livemode: false, address: { country: 'MX' }, metadata: { integration: INTEGRATION, stage: 'dev', owner: 'adult', operation: 'op_1' } })) },
      subscriptions: { list: vi.fn(async () => ({ data: [{ id: 'sub_1', customer: 'cus_1', livemode: false, metadata: { integration: INTEGRATION, stage: 'dev', owner: 'adult' }, status: 'active', automatic_tax: { enabled: false }, default_tax_rates: [{ id: 'txr_fixture', inclusive: true, country: 'MX' }], pause_collection: null, discounts: [], collection_method: 'charge_automatically', cancel_at_period_end: false, trial_start: null, trial_end: null, items: { data: [{ quantity: 1, price: { id: 'price_month', product: 'prod_individual', currency: 'mxn', tax_behavior: 'inclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }], has_more: false } }], has_more: false })) },
      invoices: { list: vi.fn(async () => ({ data: [{ id: 'in_1', customer: 'cus_1', livemode: false, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } }, status: 'paid', automatic_tax: { enabled: false }, status_transitions: { paid_at: NOW / 1000 }, currency: 'mxn', amount_due: 9900, amount_paid: 9900, amount_remaining: 0, collection_method: 'charge_automatically', starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, total_discount_amounts: [], discounts: [], lines: { has_more: false, data: [{ id: 'il_1', amount: 9900, currency: 'mxn', quantity: 1, quantity_decimal: '1', period: { start: NOW / 1000 - 1, end: NOW / 1000 + 500 }, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1', proration: false } }, pricing: { type: 'price_details', price_details: { price: 'price_month', product: 'prod_individual' } }, pretax_credit_amounts: [], discount_amounts: [], taxes: [{ tax_behavior: 'inclusive', tax_rate_details: { tax_rate: 'txr_fixture' } }] }] } }], has_more: false })) },
      invoicePayments: { list: vi.fn(async () => ({ data: [{ id: 'ip_1', invoice: 'in_1', livemode: false, status: 'paid', amount_paid: 9900, currency: 'mxn', payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', status: 'succeeded', livemode: false, currency: 'mxn', amount_received: 9900, customer: 'cus_1', latest_charge: charge } } }], has_more: false })) },
      refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) }, disputes: { list: vi.fn(async () => ({ data: [], has_more: false })) },
    } as unknown as Stripe;
    const snapshot = await (await adapter(sdk)).snapshot('cus_1');
    expect(snapshot.invoices[0]).toMatchObject({ subscriptionId: 'sub_1', paidOutOfBand: false, creditApplied: false, lines: [{ priceId: 'price_month', productId: 'prod_individual', start: NOW - 1000, end: NOW + 500_000, recurring: true }], payments: [{ id: 'ip_1', chargeId: 'ch_1', captured: true, amountPaid: 9900 }] });
  });
  it('preflight rejects an incompatible tax, amount, mode or Portal configuration', async () => {
    const product = { id: config.productId, active: true, livemode: false, metadata: { integration: INTEGRATION, stage: 'dev' } };
    const features = { invoice_history: { enabled: true }, customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address'] }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' }, subscription_update: { enabled: false } };
    const sdk = { accounts: { retrieve: vi.fn(async () => ({ id: config.accountId, country: 'MX', charges_enabled: true, details_submitted: true })) }, products: { retrieve: vi.fn(async () => product) }, prices: { retrieve: vi.fn(async (id: string) => ({ id, active: true, livemode: false, product: config.productId, currency: 'mxn', unit_amount: id === config.monthlyPriceId ? 9900 : 94900, type: 'recurring', tax_behavior: 'inclusive', recurring: { interval: id === config.monthlyPriceId ? 'month' : 'year', interval_count: 1, usage_type: 'licensed' } })) }, taxRates: { retrieve: vi.fn(async () => ({ id: config.taxRateId, active: true, inclusive: true, country: 'MX', percentage: 7.25, livemode: false })) }, billingPortal: { configurations: { retrieve: vi.fn(async () => ({ id: config.portalConfigurationId, active: true, livemode: false, features })) } } } as unknown as Stripe;
    const provider = await adapter(sdk); await provider.preflight();
    features.subscription_update.enabled = true;
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    features.subscription_update.enabled = false; product.livemode = true;
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });
  it('requires versioned private config and refuses cross-origin return URLs', async () => {
    const mod = await import('../lambda/billing/config');
    expect(() => mod.parsePrivateConfig({ ...config, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'sk_test_fixture', taxRatePercentage: 7.25, fiscalApprovalReference: 'synthetic-only' })).not.toThrow();
    expect(() => mod.parsePrivateConfig({ ...config, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'sk_test_fixture', taxRatePercentage: 7.25, fiscalApprovalReference: 'synthetic-only', cancelUrl: 'https://evil.test/' })).toThrow();
    expect(() => mod.parsePrivateConfig({ ...config, version: 1, apiVersion: 'old', apiKey: 'sk_test_fixture' })).toThrow();
  });
});
