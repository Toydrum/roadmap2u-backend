import { describe, expect, it } from 'vitest';
import { BillingProjector } from '../lambda/billing/projection';
import { AccessResolver } from '../lambda/commercial/access-resolver';
import { config, fixture, invoice, request, subscription } from './support/billing-fixture';

async function paid() {
  const f = await fixture();
  await f.service.checkout('adult', request());
  const customerId = (await f.repository.load('adult')).customerId!;
  f.provider.subscriptions.set('sub_1', subscription(customerId));
  const inv = invoice(customerId);
  f.provider.invoices.set(inv.id, inv);
  const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'refund-worker' });
  const reconcile = () => projector.reconcileOwner('adult');
  const access = async () => (await new AccessResolver({
    tableName: 'roadmap', now: f.now,
    readSnapshot: async () => ({ grants: [], subscription: f.repository.sources.get('adult'), ownerProfile: { accountType: 'adult' } }),
    materializeAccess: async () => 'committed',
  }).resolveFresh('adult')).access.effectivePlanKey;
  await reconcile();
  return { ...f, inv, reconcile, access, end: inv.lines[0].end };
}

describe('refund status and the Charge aggregate', () => {
  it('preserves the paid period when the Charge already includes a pending refund', async () => {
    const f = await paid();
    f.inv.refunds = [{ id: 're_pending', chargeId: 'ch_in_1', amount: 9900, status: 'pending' }];
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect(await f.repository.load('adult')).toMatchObject({ state: 'active', paidThrough: f.end, reviewReasons: [] });
    expect((await f.repository.receipts('adult'))[0]).toMatchObject({ valid: true, refunded: 0 });
    expect(await f.access()).toBe('premium');
  });

  it('removes only the original paid period after that refund succeeds', async () => {
    const f = await paid();
    f.inv.refunds = [{ id: 're_pending', chargeId: 'ch_in_1', amount: 9900, status: 'pending' }];
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect(await f.access()).toBe('premium');
    f.inv.refunds[0].status = 'succeeded';
    await f.reconcile();
    expect((await f.repository.receipts('adult'))[0]).toMatchObject({ valid: false, refunded: 9900 });
    expect(await f.access()).toBe('free');
  });

  it('restores the original paid period when a successful refund later fails', async () => {
    const f = await paid();
    f.inv.refunds = [{ id: 're_failed', chargeId: 'ch_in_1', amount: 9900, status: 'succeeded' }];
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect(await f.access()).toBe('free');
    f.inv.refunds[0].status = 'failed';
    f.inv.payments[0].refunded = 0;
    await f.reconcile();
    expect(await f.repository.load('adult')).toMatchObject({ state: 'active', paidThrough: f.end });
    expect(await f.access()).toBe('premium');
    f.setNow(f.end);
    expect(await f.access()).toBe('free');
  });

  it('does not revoke for a partial success plus the remaining pending refund', async () => {
    const f = await paid();
    f.inv.refunds = [
      { id: 're_partial', chargeId: 'ch_in_1', amount: 1000, status: 'succeeded' },
      { id: 're_pending', chargeId: 'ch_in_1', amount: 8900, status: 'pending' },
    ];
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect((await f.repository.receipts('adult'))[0]).toMatchObject({ valid: true, refunded: 1000 });
    expect(await f.access()).toBe('premium');
  });

  it('keeps unexplained Charge refunds under review', async () => {
    const f = await paid();
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect((await f.repository.load('adult')).reviewReasons).toContain('refund_amount');
    expect(await f.access()).toBe('free');
  });

  it('does not use a refund belonging to another charge to explain the aggregate', async () => {
    const f = await paid();
    f.inv.refunds = [{ id: 're_foreign', chargeId: 'ch_other', amount: 9900, status: 'pending' }];
    f.inv.payments[0].refunded = 9900;
    await f.reconcile();
    expect((await f.repository.load('adult')).reviewReasons).toContain('refund_mapping');
    expect(await f.access()).toBe('free');
  });
});
