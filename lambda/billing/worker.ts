import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { BillingError, historyPending, type BillingConfig, type BillingProvider, type BillingRepository } from './model';
import type { BillingProjector } from './projection';
import { createBillingRuntime } from './runtime';
import { type BillingMetric } from './metrics';

export const SUPPORTED_EVENTS = new Set(['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalization_failed', 'charge.refunded', 'refund.created', 'refund.updated', 'refund.failed', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);
interface Deps { repository: BillingRepository; provider: BillingProvider; projector: Pick<BillingProjector, 'reconcileOwner'>; config: BillingConfig; now: () => number; metric: (name: BillingMetric, value?: number) => void }
export class BillingEventWorker {
  constructor(readonly deps: Deps) {}
  async process(eventId: string): Promise<void> {
    const { repository: r, provider: p, config, now } = this.deps;
    const event = await r.event(eventId); if (!event || event.status !== 'pending') return;
    this.deps.metric('PendingEventAgeSeconds', Math.max(0, (now() - event.receivedAt) / 1000));
    if (!SUPPORTED_EVENTS.has(event.type)) return r.finishEvent(eventId, 'ignored', now());
    if (event.accountId !== config.accountId || event.liveMode !== config.liveMode) throw new BillingError('BILLING_PAYMENT_REVIEW');
    try {
      const customerId = await p.resolveEvent(event);
      if (!customerId) return r.finishEvent(eventId, 'ignored', now());
      let ownerSub = await r.mappedOwner('customer', customerId);
      if (!ownerSub) {
        const customer = await p.retrieveCustomer(customerId); ownerSub = customer.ownerSub;
        const s = await r.load(ownerSub);
        // Response-loss race: the durable reserved command, not metadata alone, authorizes binding.
        const command = s.activeCommandId ? await r.command(ownerSub, s.activeCommandId) : null;
        if (!command || command.customerParams.operationId !== customer.operationId || (s.customerId && s.customerId !== customerId)) { this.deps.metric('MappingConflict'); throw new BillingError('BILLING_PAYMENT_REVIEW'); }
        const bound = { ...s, customerId, revision: s.revision + 1, updatedAt: now(), nextReconcileAt: now() };
        if (!await r.commit({ expectedRevision: s.revision, state: bound, guard: 'none', mappings: [{ kind: 'customer', id: customerId }], auditAction: 'billing.event_customer_bound' })) throw new BillingError('BILLING_REVISION_CONFLICT');
      }
      await this.deps.projector.reconcileOwner(ownerSub, event);
      const s = await r.load(ownerSub);
      if (s.reviewReasons.includes('duplicate_subscription')) this.deps.metric('DuplicateSubscription');
      if (s.reviewReasons.some((reason) => reason.includes('mapping'))) this.deps.metric('MappingConflict');
      await r.finishEvent(eventId, s.state === 'payment_review' ? 'review' : 'processed', now());
    } catch (error) { if (historyPending(error)) return; this.deps.metric('StripeError'); await r.retryEvent(eventId, now()); throw error; }
  }
  async handle(event: Pick<SQSEvent, 'Records'>): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        const ref = JSON.parse(record.body) as { eventId?: unknown };
        if (typeof ref.eventId !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(ref.eventId) || Object.keys(ref).length !== 1) throw new Error();
        await this.process(ref.eventId);
      } catch { batchItemFailures.push({ itemIdentifier: record.messageId }); }
    }
    return { batchItemFailures };
  }
}
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  try { return await new BillingEventWorker(await createBillingRuntime()).handle(event); }
  catch { return { batchItemFailures: event.Records.map((r) => ({ itemIdentifier: r.messageId })) }; }
}
