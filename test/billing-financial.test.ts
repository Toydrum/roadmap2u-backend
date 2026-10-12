import { describe, expect, it } from 'vitest';
import { AccessResolver } from '../lambda/commercial/access-resolver';
import { fixture, NOW, config, request, subscription, invoice } from './support/billing-fixture';
import { individualSourceId } from '../lambda/billing/model';

async function paidFixture() {
  const mod = await import('../lambda/billing/projection').catch(() => null);
  expect(mod, 'financial reconciliation projector exists').not.toBeNull();
  const f = await fixture(); await f.service.checkout('adult', request());
  const customerId = (await f.repository.load('adult')).customerId!;
  f.provider.subscriptions.set('sub_1', subscription(customerId));
  f.provider.invoices.set('in_1', invoice(customerId));
  const projector = new mod!.BillingProjector({ ...f, config, nextWorkerId: () => 'worker-1' });
  return { ...f, projector, customerId };
}
describe('verified financial periods', () => {
  it('projects exactly the paid recurring period and uses the existing access resolver', async () => {
    const f = await paidFixture();
    await f.projector.reconcileOwner('adult');
    const source = f.repository.sources.get('adult')!;
    expect(source).toMatchObject({ sk: 'SUBSCRIPTION#INDIVIDUAL', state: 'active', paidThrough: Date.UTC(2026, 10, 11, 12), graceUntil: null });
    const resolver = new AccessResolver({ tableName: 'roadmap', now: f.now, readSnapshot: async () => ({ grants: [], subscription: source, ownerProfile: { accountType: 'adult' } }), materializeAccess: async () => 'committed' });
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('premium');
    expect((await f.repository.receipts('adult'))[0].paymentIds).toEqual(['ip_in_1']);
  });
  it('duplicates and reversed events converge without granting twice or trusting event timestamps', async () => {
    const f = await paidFixture();
    await f.projector.reconcileOwner('adult'); await f.projector.reconcileOwner('adult');
    const before = await f.repository.load('adult');
    f.provider.subscriptions.get('sub_1')!.cancelAtPeriodEnd = true;
    await f.projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('cancel_at_period_end');
    expect((await f.repository.receipts('adult'))).toHaveLength(1);
    expect((await f.repository.load('adult')).paidThrough).toBe(before.paidThrough);
  });
  it('failed renewal cannot extend access and a recovered invoice grants its actual period only', async () => {
    const f = await paidFixture(); await f.projector.reconcileOwner('adult');
    const end = f.provider.invoices.get('in_1')!.lines[0].end;
    const next = invoice(f.customerId, 'in_2', end, Date.UTC(2026, 11, 11, 12)); next.status = 'open'; next.amountPaid = 0; next.amountRemaining = 9900; next.payments = [];
    f.provider.invoices.set(next.id, next); f.provider.subscriptions.get('sub_1')!.status = 'past_due';
    f.setNow(end); await f.projector.reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
    next.status = 'paid'; next.amountPaid = 9900; next.amountRemaining = 0; next.payments = invoice(f.customerId, 'in_2').payments;
    f.provider.subscriptions.get('sub_1')!.status = 'active';
    f.setNow(end + 2 * 86400000); await f.projector.reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.paidThrough).toBe(next.lines[0].end);
    expect(f.repository.sources.get('adult')?.state).toBe('active');
  });
  it.each([
    ['paidOutOfBand', true], ['creditApplied', true], ['discounted', true], ['currency', 'usd'], ['amountPaid', 0],
  ])('does not grant for unauthorized invoice %s', async (field, value) => {
    const f = await paidFixture(); Object.assign(f.provider.invoices.get('in_1')!, { [field as string]: value });
    await f.projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(f.repository.sources.get('adult')?.state).not.toBe('active');
  });
  it.each(['quantity', 'price', 'product', 'trial', 'customer'])('rejects mismatching financial identity: %s', async (kind) => {
    const f = await paidFixture(), sub = f.provider.subscriptions.get('sub_1')!, inv = f.provider.invoices.get('in_1')!;
    if (kind === 'quantity') inv.lines[0].quantity = 2;
    if (kind === 'price') inv.lines[0].priceId = 'price_unknown';
    if (kind === 'product') inv.lines[0].productId = 'prod_unknown';
    if (kind === 'trial') sub.trial = true;
    if (kind === 'customer') inv.payments[0].customerId = 'cus_other';
    await f.projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(f.repository.sources.get('adult')?.state).not.toBe('active');
  });
  it('partial successful refund preserves access, full successful refund invalidates its own invoice only', async () => {
    const f = await paidFixture(), inv = f.provider.invoices.get('in_1')!;
    inv.refunds = [{ id: 're_1', chargeId: 'ch_in_1', amount: 1000, status: 'succeeded' }]; inv.payments[0].refunded = 1000;
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')?.state).toBe('active');
    inv.refunds[0].amount = 9900; inv.payments[0].refunded = 9900;
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')?.state).toBe('ended');
    const sub2 = subscription(f.customerId, 'sub_2'); f.provider.subscriptions.get('sub_1')!.status = 'canceled'; f.provider.subscriptions.set(sub2.id, sub2);
    f.provider.invoices.set('in_2', invoice(f.customerId, 'in_2', NOW - 1, NOW + 20_000, 'sub_2'));
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')).toMatchObject({ sourceId: individualSourceId(config, 'adult', 'sub_2'), state: 'active', paidThrough: NOW + 20_000 });
  });
  it.each(['pending', 'failed', 'canceled'])('a %s refund does not revoke a paid period', async (status) => {
    const f = await paidFixture(); f.provider.invoices.get('in_1')!.refunds = [{ id: 're_1', chargeId: 'ch_in_1', amount: 9900, status }];
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')?.state).toBe('active');
  });
  it('dispute suspends its period, stops renewals durably, and a win restores only the still-paid period', async () => {
    const f = await paidFixture(), inv = f.provider.invoices.get('in_1')!;
    inv.disputes = [{ id: 'dp_1', chargeId: 'ch_in_1', amount: 9900, status: 'needs_response' }];
    await f.projector.reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
    expect(f.provider.stoppedRenewals).toEqual(['sub_1']);
    inv.disputes[0].status = 'won'; await f.projector.reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect(f.provider.subscriptions.get('sub_1')?.status).toBe('canceled');
  });
  it('lost disputes stay invalid and an old dispute cannot remove another subscription period', async () => {
    const f = await paidFixture(), inv = f.provider.invoices.get('in_1')!;
    inv.disputes = [{ id: 'dp_1', chargeId: 'ch_in_1', amount: 9900, status: 'lost' }];
    f.provider.subscriptions.get('sub_1')!.status = 'canceled'; f.provider.subscriptions.set('sub_2', subscription(f.customerId, 'sub_2')); f.provider.invoices.set('in_2', invoice(f.customerId, 'in_2', NOW - 1, NOW + 20_000, 'sub_2'));
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')).toMatchObject({ sourceId: individualSourceId(config, 'adult', 'sub_2'), state: 'active' });
  });
  it('foreign mappings and duplicate nonterminal subscriptions block new purchases', async () => {
    const f = await paidFixture(); f.provider.subscriptions.set('sub_2', subscription(f.customerId, 'sub_2'));
    await f.projector.reconcileOwner('adult'); expect((await f.repository.load('adult')).state).toBe('payment_review');
    await expect(f.service.checkout('adult', request('again', (await f.repository.load('adult')).revision))).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
  });
  it('a lost worker lease cannot commit financial projection', async () => {
    const f = await paidFixture();
    const original = f.provider.snapshot.bind(f.provider);
    f.provider.snapshot = async (id) => { const snapshot = await original(id); const state = f.repository.states.get('adult')!; f.repository.states.set('adult', { ...state, leaseOwner: 'replacement', leaseRevision: (state.leaseRevision ?? 0) + 1 }); return snapshot; };
    await expect(f.projector.reconcileOwner('adult')).rejects.toThrow();
    expect(f.repository.sources.size).toBe(0);
  });
  it('closed or absent owners retain commercial facts without recreating USER sources', async () => {
    const f = await paidFixture(); f.repository.actors.delete('adult');
    await f.projector.reconcileOwner('adult'); expect(f.repository.sources.size).toBe(0);
    expect((await f.repository.load('adult')).state).toBe('closed');
  });
});
