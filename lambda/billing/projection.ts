import { subscriptionSourceKey, type SubscriptionSourceItem } from '../commercial/model';
import { canReadTestClock, resolveFinancialClock } from './clock';
import { BillingError, billingCatalogPrices, digest, historyPending, individualSourceId, nonterminal, type BillingConfig, type BillingProvider, type BillingRepository, type BillingState, type InvoiceReceipt, type ProviderInvoice, type ProviderSubscription, type ReservedPriceTerms, type StripeEventEnvelope } from './model';

interface Deps { repository: BillingRepository; provider: BillingProvider; config: BillingConfig; now: () => number; nextWorkerId: () => string; refreshAccess?: (ownerSub: string) => Promise<void> }
function receipt(ownerSub: string, inv: ProviderInvoice, sub: ProviderSubscription | undefined, terms: ReservedPriceTerms | undefined, now: number, observedNow: number): InvoiceReceipt | null {
  if (inv.status !== 'paid') return null;
  const reasons: string[] = [];
  const lines = inv.lines.filter((l) => l.recurring);
  const line = lines[0];
  if (!sub || sub.ownerSub !== ownerSub || sub.customerId !== inv.customerId) reasons.push('subscription_mapping');
  if (!sub?.automaticCollection || sub?.trial || sub?.status === 'trialing' || sub?.configurationValid === false) reasons.push('unapproved_subscription');
  if (sub?.quantity !== 1 || sub?.currency !== 'mxn' || sub?.priceId !== terms?.priceId || sub?.productId !== terms?.productId || sub?.interval !== terms?.interval) reasons.push('subscription_configuration');
  if (!terms || lines.length !== 1 || inv.lines.length !== 1 || !line || line.proration || line.quantity !== 1 || line.productId !== terms.productId || line.priceId !== terms.priceId || line.interval !== terms.interval) reasons.push('invoice_line');
  const expected = terms?.amountMinor ?? 0;
  if (!line || !Number.isSafeInteger(line.start) || !Number.isSafeInteger(line.end) || line.end <= line.start || line.amount !== expected) reasons.push('invoice_period_amount');
  if (inv.currency !== 'mxn' || inv.amountDue !== expected || inv.amountPaid !== expected || inv.amountRemaining !== 0 || !inv.automaticCollection || inv.paidOutOfBand || inv.creditApplied || inv.discounted) reasons.push('unapproved_payment');
  if (!inv.taxValid || inv.taxRateIds.length !== 1 || inv.taxRateIds[0] !== terms?.taxRateId) reasons.push('unapproved_tax');
  if (!Number.isSafeInteger(inv.paidAt) || inv.paidAt! <= 0 || inv.paidAt! > now + 60_000) reasons.push('unverified_payment_time');
  const paymentIds = new Set<string>(); let actual = 0;
  for (const payment of inv.payments) {
    if (paymentIds.has(payment.id)) continue;
    paymentIds.add(payment.id);
    if (payment.status !== 'paid' || !payment.captured || !payment.chargeId || payment.currency !== 'mxn' || payment.customerId !== inv.customerId || !Number.isSafeInteger(payment.amountPaid) || payment.amountPaid <= 0) reasons.push('unverified_charge');
    else actual += payment.amountPaid;
  }
  if (actual !== inv.amountPaid || actual !== expected) reasons.push('real_payment_missing');
  const charges = new Set(inv.payments.map((p) => p.chargeId));
  const refundIds = new Set<string>(); let refunded = 0;
  for (const r of inv.refunds) {
    if (refundIds.has(r.id)) continue; refundIds.add(r.id);
    if (!charges.has(r.chargeId) || !Number.isSafeInteger(r.amount) || r.amount < 0) reasons.push('refund_mapping');
    else if (r.status === 'succeeded') refunded += r.amount;
  }
  if (refunded > inv.amountPaid || inv.payments.reduce((sum, p) => sum + p.refunded, 0) !== refunded) reasons.push('refund_amount');
  let suspended = false, lost = false, disputeStatus: string | undefined;
  for (const d of inv.disputes) {
    if (!charges.has(d.chargeId) || !Number.isSafeInteger(d.amount) || d.amount <= 0 || d.amount > inv.amountPaid) { reasons.push('dispute_mapping'); continue; }
    disputeStatus = d.status;
    if (d.status === 'lost') lost = true;
    else if (d.status !== 'won' && d.status !== 'warning_closed') suspended = true;
  }
  return { ownerSub, invoiceId: inv.id, subscriptionId: inv.subscriptionId, customerId: inv.customerId, start: line?.start ?? 0, end: line?.end ?? 0, interval: line?.interval ?? 'month', amountPaid: inv.amountPaid, currency: 'mxn', valid: !reasons.length && refunded < inv.amountPaid && !lost && !suspended, suspended, refunded, ...(disputeStatus ? { disputeStatus } : {}), reviewReasons: reasons, verifiedAt: observedNow, paymentIds: [...paymentIds], paidAt: inv.paidAt ?? 0, priceId: line?.priceId ?? '', productId: line?.productId ?? '', taxRateId: terms?.taxRateId ?? '', chargeIds: [...charges].filter((v): v is string => !!v) };
}
function protectionEnd(firstPaidAt: number): number { const d = new Date(firstPaidAt); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.getTime(); }
export class BillingProjector {
  constructor(readonly deps: Deps) {}
  async reconcileOwner(ownerSub: string, event?: StripeEventEnvelope): Promise<void> {
    const { repository: r, provider: p, config: cfg, now } = this.deps;
    const worker = this.deps.nextWorkerId(), lease = await r.acquireLease(ownerSub, worker, now(), 60_000);
    if (!lease) throw new BillingError('BILLING_OPERATION_PENDING');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let s = await r.load(ownerSub);
        if (!s.customerId) return;
        // Observe before provider facts; commit fences any concurrent publication.
        const clockObserved = canReadTestClock({ownerSub,customerId:s.customerId,stage:cfg.stage,
          accountId:cfg.accountId,liveMode:cfg.liveMode,reference:s.testClock});
        const mirror = clockObserved ? await r.readTestClock(ownerSub) : undefined;
        const [snapshot, actor, previous, projectionRevision] = await Promise.all([p.snapshot(s.customerId, { event, ownerSub, lease }), r.actor(ownerSub), r.receipts(ownerSub), r.projectionRevision(ownerSub)]);
        const reasons = new Set<string>();
        // Checkout collects the first billing address. An unfunded customer can
        // have no country yet; every subscription, invoice or paid history still
        // requires a verified Mexican address before it can authorize access.
        const awaitingBillingAddress = snapshot.customer.country === null
          && !snapshot.subscriptions.length && !snapshot.invoices.length && !previous.length
          && s.paidThrough === null && !s.subscriptionId && !s.priceBindings?.length && s.firstPaidAt === undefined;
        if (snapshot.customer.id !== s.customerId || snapshot.customer.ownerSub !== ownerSub || snapshot.customer.liveMode !== cfg.liveMode || (snapshot.customer.country !== 'MX' && !awaitingBillingAddress)) reasons.add('customer_configuration');
        const mapped = await r.mappedOwner('customer', s.customerId);
        if (mapped && mapped !== ownerSub) reasons.add('customer_mapping');
        const active = snapshot.subscriptions.filter(nonterminal);
        if (active.length > 1) reasons.add('duplicate_subscription');
        const reserved = s.activeCommandId ? await r.command(ownerSub, s.activeCommandId) : null;
        const termsBySub = new Map<string, ReservedPriceTerms>();
        for (const sub of snapshot.subscriptions) {
          const original = s.priceBindings?.find((b) => b.subscriptionId === sub.id);
          const retainedReservation = reserved?.priceTerms && sub.operationId === reserved.operationId ? reserved.priceTerms : undefined;
          const terms: ReservedPriceTerms = original ?? retainedReservation ?? { productId: cfg.productId, priceId: sub.interval === 'year' ? cfg.annualPriceId : cfg.monthlyPriceId, interval: sub.interval, amountMinor: billingCatalogPrices(cfg)[sub.interval].amountMinor, currency: 'mxn', taxRateId: cfg.taxRateId, catalogVersion: cfg.catalogVersion };
          termsBySub.set(sub.id, terms);
          if (sub.ownerSub !== ownerSub || sub.customerId !== s.customerId || sub.productId !== terms.productId || sub.quantity !== 1 || sub.currency !== terms.currency || sub.priceId !== terms.priceId || sub.interval !== terms.interval || !sub.automaticCollection || sub.trial || sub.configurationValid === false) reasons.add('subscription_configuration');
          const owner = await r.mappedOwner('subscription', sub.id);
          if (owner && owner !== ownerSub) reasons.add('subscription_mapping');
        }
        const closed = !actor || actor.status !== 'active' || actor.closing || !!s.closingId || !!s.closedAt;
        if (closed) {
          // A late event only amends financial records; no USER record is recreated.
          for (const sub of active) await p.cancelSubscription(sub.id, `closure:${digest([ownerSub, sub.id])}`);
          await p.closeOutstandingInvoices(s.customerId, `closure-invoices:${digest(ownerSub)}`);
        }
        const clock = resolveFinancialClock({ownerSub,customerId:s.customerId,stage:cfg.stage,accountId:cfg.accountId,
          liveMode:cfg.liveMode,now:now(),reference:s.testClock,providerTestClockId:snapshot.customer.testClockId ?? null}, mirror);
        // No covering period can match NaN; blocked simulation never uses wall time.
        const financialNow = clock.mode === 'blocked' ? Number.NaN : clock.now;
        if (clock.mode === 'blocked') reasons.add('test_clock_unavailable');
        const fresh = snapshot.invoices.map((i) => receipt(ownerSub, i, snapshot.subscriptions.find((sub) => sub.id === i.subscriptionId), termsBySub.get(i.subscriptionId), financialNow, now())).filter((i): i is InvoiceReceipt => !!i);
        if (clock.mode === 'blocked') for (const i of fresh) {i.valid=false;i.reviewReasons.push('test_clock_unavailable');}
        const paymentOwners = new Map<string, string>();
        for (const i of fresh) for (const payment of [...i.paymentIds.map((v) => `payment:${v}`), ...i.chargeIds.map((v) => `charge:${v}`)]) {
          const other = paymentOwners.get(payment);
          if (other && other !== i.invoiceId) {
            i.valid = false; i.reviewReasons.push('payment_reused');
            const first = fresh.find((v) => v.invoiceId === other)!; first.valid = false; first.reviewReasons.push('payment_reused');
          } else paymentOwners.set(payment, i.invoiceId);
        }
        for (const i of fresh) for (const reason of i.reviewReasons) reasons.add(reason);
        const known = new Map(previous.map((i) => [i.invoiceId, i]));
        for (const i of fresh) known.set(i.invoiceId, i);
        const all = [...known.values()];
        // A gap is never filled by adding days to event receipt time.
        const identitySafe = !reasons.has('customer_configuration') && !reasons.has('customer_mapping') && !reasons.has('subscription_mapping');
        const current = identitySafe ? all.filter((i) => i.valid && i.start <= financialNow && i.end > financialNow).sort((a, b) => b.end - a.end)[0] : undefined;
        const last = [...all].filter((i) => i.valid).sort((a, b) => b.end - a.end)[0];
        const disputed = all.find((i) => i.suspended && i.start <= financialNow && i.end > financialNow);
        const selectedSub = active[0] ?? snapshot.subscriptions.find((sub) => sub.id === current?.subscriptionId) ?? snapshot.subscriptions.find((sub) => sub.id === last?.subscriptionId);
        const stops = snapshot.invoices.filter((i) => i.disputes.length > 0).map((i) => ({ subscriptionId: i.subscriptionId, operationId: `dispute:${digest([cfg.stage, cfg.accountId, i.subscriptionId])}`, cancellation: 'immediate' as const, invoiceNow: false as const, prorate: false as const }));
        const renewalStops = [...new Map([...(s.renewalStops ?? []), ...stops].map((v) => [v.subscriptionId, v])).values()];
        const bindings = new Map((s.priceBindings ?? []).map((b) => [b.subscriptionId, b]));
        for (const i of all.filter((v) => v.reviewReasons.length === 0 && v.paidAt > 0).sort((a, b) => a.paidAt - b.paidAt)) if (!bindings.has(i.subscriptionId)) {
          const terms = termsBySub.get(i.subscriptionId);
          if (terms) bindings.set(i.subscriptionId, { ...terms, subscriptionId: i.subscriptionId, firstPaidAt: i.paidAt, protectedPriceUntil: protectionEnd(i.paidAt) });
        }
        const original = bindings.get(selectedSub?.id ?? current?.subscriptionId ?? last?.subscriptionId ?? '');
        const changed = fresh.filter((i) => { const old = previous.find((v) => v.invoiceId === i.invoiceId); return !old || digest({ ...old, verifiedAt: 0 }) !== digest({ ...i, verifiedAt: 0 }); });
        const covering = changed.filter((v) => v.invoiceId === current?.invoiceId);
        const historical = changed.filter((v) => v.invoiceId !== current?.invoiceId);
        const mappings = snapshot.subscriptions.map((sub) => ({ kind: 'subscription' as const, id: sub.id }));
        // A long verified history is checkpointed without touching USER access. The
        // final covering receipt, normalized source, state and audit still commit together.
        while (historical.length + mappings.length + covering.length > 75) {
          const invoices = historical.splice(0, 35), pageMappings = mappings.splice(0, 35);
          const next = { ...s, ...(clock.mode !== 'real' ? {testClock:clock.reference} : {}), revision: s.revision + 1, updatedAt: now(), nextReconcileAt: now() };
          if (!await r.commit({ expectedRevision: s.revision, state: next, guard: 'none', invoices, mappings: pageMappings, ...(clockObserved ? {clockObservation:{item:mirror}} : {}), lease: { ...lease, now: now() }, auditAction: 'billing.history_checkpoint' })) throw new BillingError('BILLING_REVISION_CONFLICT');
          s = next;
        }
        const activeCommandId = active.length || current ? undefined : s.activeCommandId;
        const state: BillingState = { ...s, historyPending: false, revision: Math.max(s.revision, projectionRevision) + 1, state: closed ? 'closed' : reasons.size ? 'payment_review' : current ? selectedSub?.cancelAtPeriodEnd ? 'cancel_at_period_end' : selectedSub?.status === 'past_due' || selectedSub?.status === 'unpaid' ? 'past_due' : 'active' : selectedSub && ['past_due', 'unpaid'].includes(selectedSub.status) ? 'past_due' : all.length ? 'expired' : s.activeCommandId ? 'checkout_pending' : 'none', paidThrough: current?.end ?? last?.end ?? null, interval: current?.interval ?? last?.interval ?? selectedSub?.interval ?? null, cancelAtPeriodEnd: selectedSub?.cancelAtPeriodEnd ?? false, subscriptionId: active[0]?.id, activeCommandId, reviewReasons: [...reasons], nextReconcileAt: now() + (!closed && (activeCommandId || clockObserved) ? 60_000 : 900_000), updatedAt: now(), ...(closed ? { closedAt: s.closedAt ?? now() } : {}), ...(original ? { firstPaidAt: original.firstPaidAt, protectedPriceUntil: original.protectedPriceUntil } : {}), priceBindings: [...bindings.values()], renewalStops };
        const coveredSub = snapshot.subscriptions.find((v) => v.id === current?.subscriptionId);
        const source: SubscriptionSourceItem | undefined = closed ? undefined : { ...subscriptionSourceKey(ownerSub), entityType: 'SubscriptionSource', ownerSub, sourceId: individualSourceId(cfg, ownerSub, current?.subscriptionId ?? disputed?.subscriptionId ?? last?.subscriptionId ?? selectedSub?.id ?? 'unfunded'), state: current ? coveredSub?.cancelAtPeriodEnd ? 'scheduled_end' : 'active' : 'ended', paidThrough: current?.end ?? disputed?.end ?? last?.end ?? 0, graceUntil: null, revision: state.revision, updatedAt: now() };
        if (clock.mode !== 'real') {state.testClock=clock.reference;if (source) Object.assign(source,{testClock:clock.reference});}
        const committed = await r.commit({ expectedRevision: s.revision, state, guard: 'none', source, ...(clockObserved ? {clockObservation:{item:mirror}} : {}), invoices: [...historical, ...covering], mappings, lease: { ...lease, now: now() }, auditAction: closed ? 'billing.closed_event_observed' : reasons.size ? 'billing.payment_review' : 'billing.financial_projected' });
        if (!committed) { if (attempt === 1) throw new BillingError('BILLING_REVISION_CONFLICT'); continue; }
        // Suspension and its exact pending cancellation command are durable before Stripe mutation.
        for (const stop of renewalStops) {
          const sub = snapshot.subscriptions.find((v) => v.id === stop.subscriptionId);
          if (sub) await p.stopRenewals(stop.subscriptionId, stop.operationId);
        }
        if (!closed && this.deps.refreshAccess) await this.deps.refreshAccess(ownerSub);
        return;
      }
    } catch (error) {
      if (historyPending(error)) {
        const current = await r.load(ownerSub);
        await r.commit({ expectedRevision: current.revision, state: { ...current, revision: current.revision + 1, historyPending: true, updatedAt: now(), nextReconcileAt: now() }, guard: 'none', lease: { ...lease, now: now() }, auditAction: 'billing.history_pending' });
      }
      throw error;
    } finally { await r.releaseLease(ownerSub, worker); }
  }
}
