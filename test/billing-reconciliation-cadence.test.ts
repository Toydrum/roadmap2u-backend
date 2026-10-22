import { describe, expect, it, vi } from 'vitest';
import { AccessResolver } from '../lambda/commercial/access-resolver';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { config, fixture, invoice, request, subscription } from './support/billing-fixture';

async function paidOwner() {
  const f = await fixture();
  await f.service.checkout('adult', request());
  const customer = (await f.repository.load('adult')).customerId!;
  f.provider.subscriptions.set('sub_1', subscription(customer));
  const first = invoice(customer);
  f.provider.invoices.set(first.id, first);
  const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'cadence-worker' });
  f.setNow(first.lines[0].end - 1000);
  await projector.reconcileOwner('adult');
  return { ...f, customer, first, projector };
}

describe('scheduled recovery of a paid renewal without its webhook', () => {
  it.each([2000, 49000, 240000, 840000])('recovers within sixteen minutes at scheduler phase %s with forty seconds of provider work', async (phase) => {
    const f = await paidOwner();
    const observedAt = f.now();
    const schedulerOrigin = observedAt - phase;
    const paidAt = f.first.lines[0].end + 1000;
    const next = invoice(f.customer, 'in_renewal', f.first.lines[0].end, Date.UTC(2026, 11, 11, 12));
    next.paidAt = paidAt;
    const snapshot = f.provider.snapshot.bind(f.provider);
    f.provider.snapshot = async (...args) => {
      const value = await snapshot(...args);
      f.setNow(f.now() + 40_000);
      return value;
    };
    const worker = { process: vi.fn() };
    const reconciler = new BillingReconciler({ ...f, config, worker, metric: vi.fn() });
    let recoveredAt: number | undefined;
    for (let tick = Math.floor(phase / 60_000) + 1; schedulerOrigin + tick * 60_000 <= paidAt + 16 * 60_000; tick++) {
      const time = schedulerOrigin + tick * 60_000;
      f.setNow(time);
      if (time >= paidAt) f.provider.invoices.set(next.id, next);
      await reconciler.run('pending');
      if (tick % 15 === 0) await reconciler.run('subscriptions');
      if ((await f.repository.load('adult')).paidThrough === next.lines[0].end) {
        recoveredAt = f.now();
        break;
      }
    }
    expect(recoveredAt, 'one-minute recovery must not leave an ordinary due owner to miss another subscription sweep').toBeDefined();
    expect(recoveredAt! - paidAt).toBeLessThanOrEqual(16 * 60_000);
    expect(worker.process).not.toHaveBeenCalled();
    expect((await f.repository.receipts('adult')).find(item => item.invoiceId === next.id)).toMatchObject({ valid: true, end: next.lines[0].end });
    const resolver = new AccessResolver({
      tableName: 'roadmap', now: f.now,
      readSnapshot: async () => ({ grants: [], subscription: f.repository.sources.get('adult'), ownerProfile: { accountType: 'adult' } }),
      materializeAccess: async () => 'committed',
    });
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('premium');
  });

  it.each(['pending', 'subscriptions'] as const)('defers an occupied projection lease in %s without reporting a Stripe failure', async (mode) => {
    const f = await paidOwner();
    f.setNow((await f.repository.load('adult')).nextReconcileAt);
    await f.repository.acquireLease('adult', 'other-worker', f.now(), 60_000);
    const metric = vi.fn();
    const reconciler = new BillingReconciler({ ...f, config, worker: { process: vi.fn() }, metric });
    const result = await reconciler.run(mode);
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(metric).not.toHaveBeenCalledWith('StripeError');
    expect((await f.repository.load('adult')).leaseOwner).toBe('other-worker');
  });
});
