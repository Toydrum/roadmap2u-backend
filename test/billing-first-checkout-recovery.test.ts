import { describe, expect, it } from 'vitest';
import { fixture, config, NOW, request, subscription, invoice } from './support/billing-fixture';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { AccessResolver } from '../lambda/commercial/access-resolver';

async function initialCheckout() {
  const f = await fixture();
  await f.service.checkout('adult', request());
  const customerId = (await f.repository.load('adult')).customerId!;
  f.provider.customers.get(customerId)!.country = null;
  return { ...f, customerId, projector: new BillingProjector({ ...f, config, nextWorkerId: () => 'review-worker' }) };
}

describe('customer billing country before the first financial object', () => {
  it('keeps an unsubmitted Checkout pending and Free while its new customer has no billing address', async () => {
    const f = await initialCheckout();
    await f.projector.reconcileOwner('adult');
    expect(await f.repository.load('adult')).toMatchObject({ state: 'checkout_pending', paidThrough: null, reviewReasons: [] });
    expect(await f.service.summary('adult')).toMatchObject({ state: 'checkout_pending', processing: 'pending', canCheckout: false });
    const source = f.repository.sources.get('adult')!;
    expect(source).toMatchObject({ state: 'ended', paidThrough: 0 });
    const resolver = new AccessResolver({ tableName: 'synthetic', now: f.now, readSnapshot: async () => ({ grants: [], subscription: source, ownerProfile: { accountType: 'adult' } }), materializeAccess: async () => 'committed' });
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('free');
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });

  it('releases an expired unpaid Checkout and clears the prior country review through normal reconciliation', async () => {
    const f = await initialCheckout();
    const state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, state: 'payment_review', reviewReasons: ['customer_configuration'] });
    for (const session of f.provider.checkouts.values()) session.status = 'expired';
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    await f.service.resumeCheckout('adult', command);
    await f.projector.reconcileOwner('adult');
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'expired' });
    expect(await f.repository.load('adult')).toMatchObject({ state: 'none', paidThrough: null, reviewReasons: [] });
    expect((await f.repository.load('adult')).activeCommandId).toBeUndefined();
    expect(await f.service.summary('adult')).toMatchObject({ state: 'none', canCheckout: true });
    expect(f.provider.checkoutCreateCalls).toBe(1);
    expect(f.provider.subscriptions.size).toBe(0);
    expect(f.provider.invoices.size).toBe(0);
  });

  it('recovers a pending same-command result after losing the lease at the provider boundary without another session', async () => {
    const f = await fixture();
    const create = f.provider.createCheckout.bind(f.provider);
    f.provider.createCheckout = async (...args) => {
      const session = await create(...args);
      const state = await f.repository.load('adult');
      f.repository.states.set('adult', { ...state, leaseOwner: 'replacement-worker', leaseRevision: (state.leaseRevision ?? 0) + 1, leaseUntil: NOW + 60_000 });
      f.provider.customers.get(state.customerId!)!.country = null;
      return session;
    };
    expect(await f.service.checkout('adult', request())).toMatchObject({ outcome: 'pending', commandId: 'purchase-1', billingRevision: 3 });
    const before = (await f.repository.command('adult', 'purchase-1'))!;
    expect(before.sessionId).toBeUndefined();
    f.setNow(NOW + 60_001);
    f.provider.createCheckout = create;
    expect((await f.service.resumeCheckout('adult', before)).outcome).toBe('redirect');
    expect(f.provider.checkoutCreateCalls).toBe(1);
    expect(f.provider.checkouts.size).toBe(1);
    const after = (await f.repository.command('adult', 'purchase-1'))!;
    expect(after.checkoutKey).toBe(before.checkoutKey);
    expect(after.checkoutParams).toEqual(before.checkoutParams);
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'reconciler' }).reconcileOwner('adult');
    expect(await f.repository.load('adult')).toMatchObject({ state: 'checkout_pending', paidThrough: null, reviewReasons: [] });
  });

  it('keeps uncertain Checkout recovery due after one minute when the projector also runs', async () => {
    const f = await fixture();
    f.provider.failAfterCheckout = true;
    expect((await f.service.checkout('adult', request())).outcome).toBe('pending');
    const before = (await f.repository.command('adult', 'purchase-1'))!;
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'projector' });
    await projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).nextReconcileAt).toBe(NOW + 60_000);
    f.setNow(NOW + 60_000);
    const reconciler = new BillingReconciler({ ...f, projector, worker: { process: async () => {} }, metric: () => {} });
    expect((await reconciler.run('pending')).failed).toBe(0);
    const after = (await f.repository.command('adult', 'purchase-1'))!;
    expect(after.status).toBe('redirect');
    expect(after.sessionId).toBeDefined();
    expect(after.checkoutKey).toBe(before.checkoutKey);
    expect(after.checkoutParams).toEqual(before.checkoutParams);
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });

  it('grants the verified paid period only after Checkout supplies a Mexican address', async () => {
    const f = await initialCheckout();
    await f.projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('checkout_pending');
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
    f.provider.customers.get(f.customerId)!.country = 'MX';
    f.provider.subscriptions.set('sub_1', subscription(f.customerId));
    f.provider.invoices.set('in_1', invoice(f.customerId));
    await f.projector.reconcileOwner('adult');
    expect(await f.repository.load('adult')).toMatchObject({ state: 'active', reviewReasons: [], nextReconcileAt: NOW + 900_000 });
    expect(f.repository.sources.get('adult')).toMatchObject({ state: 'active', paidThrough: Date.UTC(2026, 10, 11, 12) });
  });

  it.each(['null_subscription', 'null_invoice', 'null_prior_receipt', 'null_paid_state', 'null_known_subscription', 'null_price_binding', 'null_first_payment', 'foreign_empty', 'foreign_paid'])('retains customer-country rejection for %s', async (kind) => {
    const f = await initialCheckout();
    if (kind.includes('foreign')) f.provider.customers.get(f.customerId)!.country = 'US';
    if (kind === 'null_subscription' || kind === 'foreign_paid') f.provider.subscriptions.set('sub_1', subscription(f.customerId));
    if (kind === 'null_invoice' || kind === 'foreign_paid') f.provider.invoices.set('in_1', invoice(f.customerId));
    if (kind === 'null_prior_receipt') f.repository.invoices.set('adult/in_1', { ownerSub: 'adult', invoiceId: 'in_1', subscriptionId: 'sub_previous', customerId: f.customerId, start: NOW - 1000, end: NOW + 1000, interval: 'month', amountPaid: 9900, currency: 'mxn', valid: true, suspended: false, refunded: 0, reviewReasons: [], verifiedAt: NOW, paymentIds: ['ip_prior'], paidAt: NOW, priceId: config.monthlyPriceId, productId: config.productId, taxRateId: config.taxRateId, chargeIds: ['ch_prior'] });
    if (['null_paid_state', 'null_known_subscription', 'null_price_binding', 'null_first_payment'].includes(kind)) {
      const state = await f.repository.load('adult');
      f.repository.states.set('adult', { ...state, ...(kind === 'null_paid_state' ? { paidThrough: NOW + 1000 } : kind === 'null_known_subscription' ? { subscriptionId: 'sub_previous' } : kind === 'null_first_payment' ? { firstPaidAt: NOW } : { priceBindings: [{ subscriptionId: 'sub_previous' }] as never }) });
    }
    await f.projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).reviewReasons).toContain('customer_configuration');
    expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
  });
});
