import { describe, expect, it, vi } from 'vitest';
import { fixture, config, NOW, request, subscription, invoice } from './support/billing-fixture';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { BillingProjector } from '../lambda/billing/projection';
import { STRIPE_API_VERSION } from '../lambda/billing/model';
import { BillingClosure } from '../lambda/billing/closure';
import { AccessResolver } from '../lambda/commercial/access-resolver';
import { accessSummary } from '../lambda/access-reader';

describe('bounded financial recovery after interrupted consumers', () => {
  it.each([60_000, 120_000, 7_200_000, 25 * 3_600_000])('recovers or durably releases a reservation interrupted before POST after %s ms without changing key or parameters', async (delay) => {
    const f = await fixture(), create = f.provider.createCheckout.bind(f.provider);
    f.provider.createCheckout = async () => { throw new Error('connection interrupted before POST'); };
    await f.service.checkout('adult', request()); const before = (await f.repository.command('adult', 'purchase-1'))!;
    f.provider.createCheckout = create; f.setNow(NOW + delay);
    const result = await f.service.checkout('adult', request()); const after = (await f.repository.command('adult', 'purchase-1'))!;
    expect(after.checkoutParams).toEqual(before.checkoutParams); expect(after.checkoutKey).toBe(before.checkoutKey);
    if (delay === 60_000) expect(result.outcome).toBe('redirect');
    else { expect(after.status).toBe('expired'); expect((await f.service.summary('adult')).canCheckout).toBe(true); expect(f.provider.checkouts.size).toBe(0); }
    expect(await new BillingClosure({ ...f, config, nextWorkerId: () => 'closer' }).resolve('adult', 'close-1')).toBe(true);
  });
  it.each([120_000, 7_200_000, 25 * 3_600_000])('closure resolves a never-sent historical Checkout after %s ms with no new operation', async (delay) => {
    const f = await fixture(), create = f.provider.createCheckout.bind(f.provider);
    f.provider.createCheckout = async () => { throw new Error('connection interrupted before POST'); };
    await f.service.checkout('adult', request()); const before = (await f.repository.command('adult', 'purchase-1'))!;
    f.provider.createCheckout = create; f.setNow(NOW + delay);
    expect(await new BillingClosure({ ...f, config, nextWorkerId: () => 'closer' }).resolve('adult', 'close-1')).toBe(true);
    expect((await f.repository.command('adult', 'purchase-1'))?.checkoutParams).toEqual(before.checkoutParams); expect(f.provider.checkouts.size).toBe(0);
  });
  it('closure can finish an uncertain Customer-only operation because no durable Checkout parameters ever authorized charging', async () => {
    const f = await fixture(); f.provider.createCustomer = async () => { throw new Error('lost before customer creation'); };
    await f.service.checkout('adult', request()); expect((await f.repository.command('adult', 'purchase-1'))?.checkoutParams).toBeUndefined();
    f.setNow(NOW + 25 * 3_600_000);
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(await new BillingClosure({ ...f, config, nextWorkerId: () => 'closer' }).resolve('adult', 'close-1')).toBe(true);
    expect(f.provider.checkouts.size).toBe(0);
  });
  it('persisted event cursors do not skip work when processed entries leave the index', async () => {
    const f = await fixture();
    for (let n = 0; n < 100; n++) await f.repository.putEvent({ eventId: `evt_${String(n).padStart(3, '0')}`, type: 'invoice.paid', objectId: 'in_1', objectType: 'invoice', apiVersion: STRIPE_API_VERSION, liveMode: false, accountId: config.accountId, status: 'pending', attempts: 0, receivedAt: NOW, nextAttemptAt: NOW });
    const seen: string[] = [], worker = { process: async (id: string) => { if (seen.length > 0 && seen.length % 25 !== 0) expect(await f.repository.readCursor('events')).toBeDefined(); seen.push(id); await f.repository.finishEvent(id, 'processed', NOW); } };
    const reconcile = new BillingReconciler({ ...f, worker, projector: { reconcileOwner: async () => {} }, metric: vi.fn() });
    await reconcile.run('pending'); await reconcile.run('pending'); await reconcile.run('pending'); await reconcile.run('pending');
    expect(new Set(seen).size).toBe(100); expect(seen).toHaveLength(100);
  });
  it('a new owner projection advances beyond an already-existing USER source revision after restoring older financial state', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); f.provider.invoices.set('in_1', invoice(customerId));
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' }); await projector.reconcileOwner('adult');
    const source = f.repository.sources.get('adult')!; f.repository.sources.set('adult', { ...source, revision: 100 });
    await projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')!.revision).toBeGreaterThan(100);
  });
  it('durably suspends a dispute before a failed cancellation and retries the same final operation', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); const inv = invoice(customerId); inv.disputes = [{ id: 'dp_1', chargeId: inv.payments[0].chargeId!, amount: 9900, status: 'needs_response' }]; f.provider.invoices.set(inv.id, inv);
    const stop = f.provider.stopRenewals.bind(f.provider), operations: string[] = [];
    f.provider.stopRenewals = async (id, op?: string) => { operations.push(op!); if (operations.length === 1) throw new Error('response unavailable'); await stop(id); };
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' });
    await expect(projector.reconcileOwner('adult')).rejects.toThrow();
    expect(f.repository.sources.get('adult')?.state).toBe('ended'); expect((await f.repository.load('adult')).renewalStops?.[0]).toMatchObject({ cancellation: 'immediate', invoiceNow: false, prorate: false });
    await projector.reconcileOwner('adult'); expect(operations[1]).toBe(operations[0]); expect(f.provider.subscriptions.get('sub_1')?.status).toBe('canceled');
  });
  it('the existing public /access projection contains only an opaque source identity', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); f.provider.invoices.set('in_1', invoice(customerId));
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' }).reconcileOwner('adult');
    const source = f.repository.sources.get('adult')!;
    const resolver = new AccessResolver({ tableName: 'roadmap', now: f.now, readSnapshot: async () => ({ grants: [], subscription: source, ownerProfile: { accountType: 'adult' } }), materializeAccess: async () => 'committed' });
    const response = accessSummary((await resolver.resolveFresh('adult')).access, { activeTrees: 0, visibleBranchesByTree: {} });
    expect(response.effectivePlanKey).toBe('premium'); expect(response.activeSources[0].sourceId).toMatch(/^individual:[a-f0-9]{64}$/);
    expect(JSON.stringify(response)).not.toMatch(/sub_1|cus_1|in_1/);
  });
});
