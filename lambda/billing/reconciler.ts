import type { BillingConfig, BillingProvider, BillingRepository, BillingState, StripeEventEnvelope } from './model';
import type { BillingService } from './service';
import type { BillingEventWorker } from './worker';
import { BillingEventWorker as EventWorker } from './worker';
import type { BillingProjector } from './projection';
import { createBillingRuntime } from './runtime';
import { type BillingMetric } from './metrics';
import { historyPending } from './model';
import { canReadTestClock, resolveFinancialClock } from './clock';

interface Deps { repository: BillingRepository; provider: BillingProvider; service: Pick<BillingService, 'resumeCheckout'>; worker: Pick<BillingEventWorker, 'process'>; projector: Pick<BillingProjector, 'reconcileOwner'>; config?: Pick<BillingConfig, 'stage' | 'accountId' | 'liveMode'>; now: () => number; metric: (name: BillingMetric, value?: number) => void }
export class BillingReconciler {
  constructor(readonly deps: Deps) {}
  async run(mode: 'pending' | 'subscriptions' | 'audit'): Promise<{ processed: number; failed: number }> {
    const { repository: r, provider: p, now } = this.deps;
    let processed = 0, failed = 0; const startedAt = now(), hasBudget = () => now() - startedAt < 40_000;
    if (mode === 'audit') {
      const cursor = await r.readCursor('audit'), page = await p.auditCustomers(typeof cursor?.['stripeCursor'] === 'string' ? cursor['stripeCursor'] : undefined);
      for (const customer of page.customers) {
        if (!hasBudget()) return { processed, failed };
        try {
          const s = await r.load(customer.ownerSub);
          if (s.customerId !== customer.id) { this.deps.metric('MappingConflict'); failed++; }
          else { await this.deps.projector.reconcileOwner(customer.ownerSub); processed++; }
        } catch (error) { if (!historyPending(error)) { failed++; this.deps.metric('StripeError'); } }
        await r.saveCursor('audit', { stripeCursor: customer.id });
      }
      await r.saveCursor('audit', page.cursor ? { stripeCursor: page.cursor } : undefined);
      return { processed, failed };
    }
    const kind = mode === 'pending' ? 'events' : 'owners';
    const cursor = await r.readCursor(kind), page = await r.due(kind, now(), cursor, 25);
    for (const [index, item] of page.items.entries()) {
      if (!hasBudget()) return { processed, failed };
      try {
        if (kind === 'events') await this.deps.worker.process((item as StripeEventEnvelope).eventId);
        else {
          const owner = item as BillingState;
          this.deps.metric('ReconciliationLagSeconds', Math.max(0, (now() - owner.nextReconcileAt) / 1000));
          if (owner.activeCommandId) { const c = await r.command(owner.ownerSub, owner.activeCommandId); if (c) await this.deps.service.resumeCheckout(owner.ownerSub, c); }
          await this.deps.projector.reconcileOwner(owner.ownerSub);
        }
        processed++;
      } catch (error) { if (!historyPending(error)) { failed++; this.deps.metric('StripeError'); } }
      if (page.itemCursors?.[index]) await r.saveCursor(kind, page.itemCursors[index]);
    }
    await r.saveCursor(kind, page.cursor);
    if (mode === 'pending') {
      // Uncertain checkout and expired leases get the one-minute recovery cadence too.
      const owners = await r.due('owners', now(), await r.readCursor('pending-owners'), 25);
      for (const [index, item] of owners.items.entries()) {
        if (!hasBudget()) return { processed, failed };
        const owner = item as BillingState;
        try {
          let clockChanged = false;
          // Missing trusted runtime config closes this optional fast path.
          const cfg = this.deps.config;
          if (!owner.activeCommandId && !owner.historyPending && cfg && owner.customerId && canReadTestClock({ ownerSub: owner.ownerSub, customerId: owner.customerId,
            stage: cfg.stage, accountId: cfg.accountId, liveMode: cfg.liveMode, reference: owner.testClock })) {
            const clock = resolveFinancialClock({ ownerSub: owner.ownerSub, customerId: owner.customerId, stage: cfg.stage,
              accountId: cfg.accountId, liveMode: cfg.liveMode, reference: owner.testClock, now: now() }, await r.readTestClock(owner.ownerSub));
            clockChanged = clock.mode === 'simulation' && (owner.reviewReasons.includes('test_clock_unavailable')
              || owner.testClock?.clockRevision !== clock.reference.clockRevision || owner.testClock?.frozenTimeSeconds !== clock.reference.frozenTimeSeconds);
          }
          if (owner.activeCommandId || owner.historyPending || clockChanged) {
            if (owner.activeCommandId) { const c = await r.command(owner.ownerSub, owner.activeCommandId); if (c) await this.deps.service.resumeCheckout(owner.ownerSub, c); }
            if (owner.historyPending || clockChanged) await this.deps.projector.reconcileOwner(owner.ownerSub);
            processed++;
          }
        } catch (error) { if (!historyPending(error)) { failed++; this.deps.metric('StripeError'); } }
        if (owners.itemCursors?.[index]) await r.saveCursor('pending-owners', owners.itemCursors[index]);
      }
      await r.saveCursor('pending-owners', owners.cursor);
    }
    return { processed, failed };
  }
}
export async function handler(event: { mode?: unknown }): Promise<{ processed: number; failed: number }> {
  if (!['pending', 'subscriptions', 'audit'].includes(String(event.mode))) throw new Error('invalid billing reconciliation mode');
  const runtime = await createBillingRuntime(), worker = new EventWorker(runtime);
  return new BillingReconciler({ ...runtime, worker }).run(event.mode as 'pending' | 'subscriptions' | 'audit');
}
