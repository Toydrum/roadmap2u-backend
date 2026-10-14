import { randomUUID } from 'node:crypto';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { digest, historyPending, nonterminal, rejectedCheckoutExpiry, type BillingConfig, type BillingProvider, type BillingRepository, type BillingState } from './model';
import { createBillingRuntime } from './runtime';
import { billingMetric } from './metrics';

interface Deps { repository: BillingRepository; provider: BillingProvider; config: BillingConfig; now: () => number; nextWorkerId: () => string }
/** The closure fence and the exact operation identity survive retries and USER erasure. */
export class BillingClosure {
  constructor(readonly deps: Deps) {}
  async resolve(ownerSub: string, closureId: string): Promise<boolean> {
    const { repository: r, provider: p, now } = this.deps;
    const worker = this.deps.nextWorkerId(), lease = await r.acquireLease(ownerSub, worker, now(), 60_000);
    if (!lease) return false;
    try {
      let s = await r.load(ownerSub);
      if (s.closingId && s.closingId !== closureId) return false;
      const fenced = { ...s, closingId: closureId, revision: s.revision + 1, updatedAt: now(), nextReconcileAt: now() };
      if (!await r.commit({ expectedRevision: s.revision, state: fenced, guard: 'closure', lease: { ...lease, now: now() }, auditAction: 'billing.closure_fenced' })) return false;
      s = fenced;
      const command = s.activeCommandId ? await r.command(ownerSub, s.activeCommandId) : null;
      const customers = await p.findCustomers(ownerSub);
      if (customers.length > 1) return false;
      let customer = customers[0];
      if (!customer && s.customerId) return false;
      if (!customer && command?.checkoutParams) customer = (await p.snapshot(command.checkoutParams.customerId, { ownerSub, lease })).customer;
      if (!customer && command?.sessionId) customer = (await p.snapshot((await p.retrieveCheckout(command.sessionId)).customerId, { ownerSub, lease })).customer;
      const evidence: NonNullable<BillingState['closureEvidence']> = { checkedAt: now(), sessionIds: [], subscriptionIds: [], invoiceIds: [], customerOnlyUncertain: !customer && !!command };
      if (!customer && command && (command.checkoutParams || command.sessionId)) return false;
      if (!customer && command) {
        // No Checkout POST is permitted before its parameters are durably reserved.
        // An uncertain Customer creation alone cannot charge, even after key expiry.
        evidence.customerOnlyUncertain = true;
      }
      if (customer) {
        if (customer.ownerSub !== ownerSub || customer.liveMode !== this.deps.config.liveMode || (s.customerId && s.customerId !== customer.id)) return false;
        if (!s.customerId) {
          const next = { ...s, customerId: customer.id, revision: s.revision + 1, updatedAt: now() };
          if (!await r.commit({ expectedRevision: s.revision, state: next, guard: 'closure', lease: { ...lease, now: now() }, mappings: [{ kind: 'customer', id: customer.id }], auditAction: 'billing.closure_customer_bound' })) return false;
          s = next;
        }
        if (command) {
          let sessions = command.sessionId ? [await p.retrieveCheckout(command.sessionId)] : await p.findCheckouts(customer.id, command.operationId);
          if (!sessions.length && command.checkoutParams) {
            if (command.checkoutParams.expiresAt > now()) {
              if (now() - command.createdAt >= 23 * 3_600_000) return false;
              // Join a possibly in-flight request using its exact original key/body.
              try { sessions = [await p.createCheckout(command.checkoutParams, command.checkoutKey)]; }
              catch (error) { if (!rejectedCheckoutExpiry(error)) throw error; }
            }
          }
          for (const session of sessions) await p.expireCheckout(session.id, `close:${closureId}`);
          for (const session of sessions) if ((await p.retrieveCheckout(session.id)).status === 'open') return false;
        }
        // Covers restored state or a delivery race whose current operation is no longer active.
        const allSessions = await p.findCheckouts(customer.id);
        evidence.sessionIds = allSessions.map((v) => v.id);
        for (const session of allSessions.filter((v) => v.status === 'open')) await p.expireCheckout(session.id, `close:${closureId}`);
        if ((await p.findCheckouts(customer.id)).some((v) => v.status === 'open')) return false;
        const snapshot = await p.snapshot(customer.id, { ownerSub, lease });
        for (const sub of snapshot.subscriptions.filter(nonterminal)) await p.cancelSubscription(sub.id, `close:${digest([closureId, sub.id])}`);
        await p.closeOutstandingInvoices(customer.id, `close-invoices:${digest(closureId)}`);
        const verified = await p.snapshot(customer.id, { ownerSub, lease });
        if (verified.subscriptions.some(nonterminal) || verified.invoices.some((i) => i.status === 'open' || i.status === 'draft')) return false;
        evidence.subscriptionIds = verified.subscriptions.map((v) => v.id); evidence.invoiceIds = verified.invoices.map((v) => v.id);
      }
      const next = { ...s, revision: s.revision + 1, state: 'closed' as const, closedAt: now(), updatedAt: now(), activeCommandId: undefined, subscriptionId: undefined, cancelAtPeriodEnd: false, nextReconcileAt: now() + 900_000, closureEvidence: { ...evidence, checkedAt: now() } };
      // The final financial write must finish before finally releases its lease.
      return await r.commit({ expectedRevision: s.revision, state: next, guard: 'closure', lease: { ...lease, now: now() }, ...(command ? { command: { ...command, status: 'expired' as const, updatedAt: now(), recoveryEvidence: { checkedAt: now(), accountId: this.deps.config.accountId, stage: this.deps.config.stage, reason: evidence.customerOnlyUncertain ? 'no_checkout_authorized' : 'closure_no_future_collection', sessionIds: evidence.sessionIds, subscriptionIds: evidence.subscriptionIds, invoiceIds: evidence.invoiceIds } } } : {}), auditAction: 'billing.closure_verified' });
    } catch (error) { if (!historyPending(error)) billingMetric('AccountClosureBillingBlocked'); return false; }
    finally { await r.releaseLease(ownerSub, worker); }
  }
}
/** Existing Free/sponsored accounts never require Stripe credentials to close. */
export async function resolveAccountBillingBeforePurge(
  deps: { ddb: DynamoDBDocumentClient; table: string },
  closure: { sub: string; closureId: string },
  runtimeFactory: () => Promise<{ repository: BillingRepository; provider: BillingProvider; config: BillingConfig; now: () => number }> = createBillingRuntime,
): Promise<boolean> {
  // STATE and every financial command are reserved atomically. The already-present
  // canonical closure fence prevents a new reservation racing this strong absence read.
  const state = await deps.ddb.send(new GetCommand({ TableName: deps.table, Key: { pk: `BILLING#${closure.sub}`, sk: 'STATE' }, ConsistentRead: true }));
  if (!state.Item) return true;
  try {
    const runtime = await runtimeFactory();
    return await new BillingClosure({ ...runtime, nextWorkerId: randomUUID }).resolve(closure.sub, closure.closureId);
  } catch (error) { if (!historyPending(error)) billingMetric('AccountClosureBillingBlocked'); return false; }
}
