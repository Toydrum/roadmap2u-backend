import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeBillingProvider } from '../lambda/billing/stripe-provider';
import { MemoryBillingRepository } from '../lambda/billing/repository';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingEventWorker } from '../lambda/billing/worker';
import { BillingClosure } from '../lambda/billing/closure';
import { config, fixture, NOW, request } from './support/billing-fixture';
import { INTEGRATION, STRIPE_API_VERSION, type StripeEventEnvelope } from '../lambda/billing/model';

function history(subscriptionCount = 65, testClock = false) {
  let clock = NOW;
  const metadata = { integration: INTEGRATION, stage: 'dev', owner: 'adult', operation: 'op_1' };
  const subscriptions = Array.from({ length: subscriptionCount }, (_, n) => ({ id: n ? `sub_${n}` : 'sub_current', customer: 'cus_1', livemode: false, metadata, status: n ? 'canceled' : 'active', automatic_tax: { enabled: false }, default_tax_rates: [{ id: config.taxRateId, inclusive: true, country: 'MX' }], pause_collection: null, discounts: [], collection_method: 'charge_automatically', cancel_at_period_end: false, trial_start: null, trial_end: null, items: { data: [{ quantity: 1, price: { id: config.monthlyPriceId, product: config.productId, currency: 'mxn', tax_behavior: 'inclusive', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }], has_more: false } }));
  const invoices = Array.from({ length: 135 }, (_, n) => ({ id: `in_${String(n).padStart(3, '0')}`, customer: 'cus_1', livemode: false, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_current' } }, status: n === 0 || n === 134 ? 'paid' : 'void', automatic_tax: { enabled: false }, status_transitions: { paid_at: NOW / 1000 - n * 86400 }, currency: 'mxn', amount_due: 9900, amount_paid: 9900, amount_remaining: 0, collection_method: 'charge_automatically', starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, total_discount_amounts: [], discounts: [], lines: { has_more: false, data: [{ id: `il_${n}`, amount: 9900, currency: 'mxn', quantity: 1, quantity_decimal: '1', period: { start: NOW / 1000 - n * 86400 - 1, end: n === 0 ? NOW / 1000 + 86400 : NOW / 1000 - n * 86400 }, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_current', proration: false } }, pricing: { type: 'price_details', price_details: { price: config.monthlyPriceId, product: config.productId } }, pretax_credit_amounts: [], discount_amounts: [], taxes: [{ tax_behavior: 'inclusive', tax_rate_details: { tax_rate: config.taxRateId } }] }] } }));
  const refunded = new Set<string>();
  const charge = (invoice: string) => ({ id: `ch_${invoice}`, payment_intent: `pi_${invoice}`, paid: true, captured: true, currency: 'mxn', customer: 'cus_1', amount: 9900, amount_captured: 9900, amount_refunded: refunded.has(invoice) ? 9900 : 0, livemode: false, payment_method_details: { type: 'card' } });
  const page = <T extends { id: string }>(all: T[], p: { starting_after?: string; limit?: number; created?: unknown }) => {
    clock += 10;
    if (p.created) return { data: [], has_more: false };
    const from = p.starting_after ? all.findIndex((v) => v.id === p.starting_after) + 1 : 0;
    const data = all.slice(from, from + (p.limit ?? 100)); return { data, has_more: from + data.length < all.length };
  };
  const sdk = {
    customers: { retrieve: vi.fn(async () => ({ id: 'cus_1', livemode: false, address: { country: 'MX' }, metadata, ...(testClock ? {test_clock:'clock_simulated'} : {}) })) },
    subscriptions: { list: vi.fn(async (p) => page(subscriptions, p)), retrieve: vi.fn(async (id: string) => subscriptions.find((v) => v.id === id)) },
    invoices: { list: vi.fn(async (p) => page(invoices, p)), retrieve: vi.fn(async (id: string) => invoices.find((v) => v.id === id)) },
    invoicePayments: { list: vi.fn(async (p) => { const invoice = p.invoice ?? p.payment?.payment_intent?.slice(3); return { data: [{ id: `ip_${invoice}`, invoice, livemode: false, status: 'paid', amount_paid: 9900, currency: 'mxn', payment: { type: 'payment_intent', payment_intent: { id: `pi_${invoice}`, status: 'succeeded', livemode: false, currency: 'mxn', amount_received: 9900, customer: 'cus_1', latest_charge: charge(invoice) } } }], has_more: false }; }) },
    refunds: { list: vi.fn(async (p) => { const invoice = p.charge.slice(3); return { data: refunded.has(invoice) ? [{ id: `re_${invoice}`, charge: p.charge, amount: 9900, status: 'succeeded' }] : [], has_more: false }; }), retrieve: vi.fn(async (id: string) => ({ id, charge: `ch_${id.slice(3)}` })) },
    disputes: { list: vi.fn(async () => ({ data: [], has_more: false })) }, charges: { retrieve: vi.fn(async (id: string) => charge(id.slice(3))) },
  } as unknown as Stripe;
  return { sdk, subscriptions, invoices, refunded, now: () => clock };
}
const envelope = (objectId: string, objectType = 'refund'): StripeEventEnvelope => ({ eventId: 'evt_old', type: 'refund.updated', objectId, objectType, accountId: config.accountId, liveMode: false, apiVersion: STRIPE_API_VERSION, status: 'pending', attempts: 0, receivedAt: NOW, nextAttemptAt: NOW });

describe('durable Stripe customer history pagination', () => {
  it('refreshes virtual periods and discovers new clock invoices without a wall-time created filter', async () => {
    const h = history(1, true), repository = new MemoryBillingRepository();
    const provider = new StripeBillingProvider(config, h.sdk, {repository,now:h.now});
    expect((await provider.snapshot('cus_1')).customer.testClockId).toBe('clock_simulated');
    h.refunded.add('in_134');
    h.invoices.push({...structuredClone(h.invoices[0]),id:'in_simulated_renewal'});
    const later = await provider.snapshot('cus_1');
    expect(later.invoices.find(i=>i.id === 'in_134')?.refunds).toHaveLength(1);
    expect(later.invoices.some(i=>i.id === 'in_simulated_renewal')).toBe(true);
  });
  it('resumes more than60 objects from persisted pages across new provider instances instead of entering permanent review', async () => {
    const h = history(), repository = new MemoryBillingRepository(); let pending = 0, result;
    for (let n = 0; n < 200; n++) {
      const provider = new StripeBillingProvider(config, h.sdk, { repository, now: h.now, budgetMs: 15 });
      try { result = await provider.snapshot('cus_1'); break; }
      catch (e) { expect(e).toMatchObject({ code: 'BILLING_OPERATION_PENDING', continuation: true }); pending++; expect(repository.cursors.size).toBeGreaterThan(0); }
    }
    expect(pending).toBeGreaterThan(1); expect(result?.subscriptions).toHaveLength(65); expect(result?.invoices).toHaveLength(135);
    expect(h.sdk.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ starting_after: expect.any(String) }));
    expect(h.sdk.invoices.list).toHaveBeenCalledWith(expect.objectContaining({ starting_after: expect.any(String) }));
  });
  it('never expires an existing source from an unfinished history page and later projects the current verified period', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    const h = history(125), source = { pk: 'USER#adult', sk: 'SUBSCRIPTION#INDIVIDUAL', entityType: 'SubscriptionSource', ownerSub: 'adult', sourceId: 'individual:previous', state: 'active', paidThrough: NOW + 1000, graceUntil: null, revision: 20, updatedAt: NOW } as const;
    f.repository.sources.set('adult', source);
    const writes: { source: unknown; count: number; action: string }[] = [], commit = f.repository.commit.bind(f.repository);
    f.repository.commit = async (change) => { writes.push({ source: change.source, count: (change.invoices?.length ?? 0) + (change.mappings?.length ?? 0), action: change.auditAction }); return commit(change); };
    const provider = new StripeBillingProvider(config, h.sdk, { repository: f.repository, now: h.now, budgetMs: 15 });
    const projector = new BillingProjector({ ...f, provider, config, now: h.now, nextWorkerId: () => 'history' });
    let done = false;
    for (let n = 0; n < 200; n++) {
      try { await projector.reconcileOwner('adult'); done = true; break; }
      catch (e) { expect(e).toMatchObject({ continuation: true }); expect(f.repository.sources.get('adult')).toEqual(source); }
    }
    expect(done).toBe(true); expect(f.repository.sources.get('adult')).toMatchObject({ state: 'active', paidThrough: NOW + 86400000 });
    expect(writes.some((v) => v.action === 'billing.history_checkpoint' && !v.source)).toBe(true); expect(writes.every((v) => v.count <= 75)).toBe(true);
  });
  it('re-reads a cached covering invoice and an event targeting an old invoice against Stripe current state', async () => {
    const h = history(), repository = new MemoryBillingRepository(), provider = new StripeBillingProvider(config, h.sdk, { repository, now: h.now });
    await provider.snapshot('cus_1'); h.refunded.add('in_000'); h.refunded.add('in_134');
    const current = await provider.snapshot('cus_1', { event: envelope('re_in_134') });
    expect(current.invoices.find((v) => v.id === 'in_000')?.refunds).toHaveLength(1);
    expect(current.invoices.find((v) => v.id === 'in_134')?.refunds).toHaveLength(1);
    expect((await provider.snapshot('cus_1')).invoices.find((v) => v.id === 'in_134')?.refunds).toHaveLength(1);
    expect(h.sdk.invoicePayments.list).toHaveBeenCalledWith(expect.objectContaining({ payment: { type: 'payment_intent', payment_intent: 'pi_in_134' } }));
  });
  it('leaves an event pending without consuming its failure budget when a durable history page advances', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const event = envelope('in_000', 'invoice');
    f.provider.resolveEvent = async () => (await f.repository.load('adult')).customerId!;
    await f.repository.putEvent(event);
    const error = Object.assign(new Error('history continuation'), { continuation: true });
    const projector = { reconcileOwner: vi.fn(async () => { throw error; }) };
    const worker = new BillingEventWorker({ ...f, config, projector, metric: vi.fn() });
    await worker.process(event.eventId);
    expect(await f.repository.event(event.eventId)).toMatchObject({ status: 'pending', attempts: 0 });
  });
  it('resumes account closure across history pages and verifies every subscription before declaring collection stopped', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const s = await f.repository.load('adult');
    f.repository.states.set('adult', { ...s, activeCommandId: undefined });
    const h = history(), provider = new StripeBillingProvider(config, h.sdk, { repository: f.repository, now: h.now, budgetMs: 15 });
    provider.findCustomers = async () => [await provider.retrieveCustomer('cus_1')]; provider.findCheckouts = async () => [];
    const canceled: string[] = [];
    provider.cancelSubscription = async (id) => { canceled.push(id); h.subscriptions.find((v) => v.id === id)!.status = 'canceled'; };
    const closer = new BillingClosure({ ...f, provider, config, now: h.now, nextWorkerId: () => 'closure-history' });
    let done = false;
    for (let n = 0; n < 200; n++) { done = await closer.resolve('adult', 'close-1'); if (done) break; expect((await f.repository.load('adult')).closedAt).toBeUndefined(); }
    expect(done).toBe(true); expect(canceled).toEqual(['sub_current']);
    expect((await f.repository.load('adult')).closureEvidence?.subscriptionIds).toHaveLength(65);
    expect(h.subscriptions.every((v) => v.status === 'canceled')).toBe(true);
  });
});
