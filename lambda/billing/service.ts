import { randomUUID } from 'node:crypto';
import { individualPurchaseAdmitted } from './admission';
import { purchasesConfigReady } from './config';
import { resolveFinancialClock } from './clock';
import { BillingError, billingCatalogPrices, digest, eligible, historyPending, nonterminal, operationId, rejectedCheckoutExpiry, type BillingActor, type BillingCommand, type BillingConfig, type BillingProvider, type BillingRepository, type BillingState, type Interval, type ProviderCheckout, type ProviderSnapshot } from './model';

type CheckoutRequest = { commandId: string; expectedBillingRevision: number; interval: Interval; catalogVersion: string; country: 'MX'; termsAcceptance: { version: string; hash: string; language: 'es' | 'en'; accepted: true } };
type PortalRequest = { commandId: string; expectedBillingRevision: number };
export type BillingResult = { outcome: 'redirect'; commandId: string; billingRevision: number; url: string; expiresAt: number } | { outcome: 'pending'; commandId: string; billingRevision: number; retryAfterMs: number };
export interface BillingServiceDeps { repository: BillingRepository; provider: BillingProvider; config: BillingConfig; now: () => number; purchasesEnabled: () => Promise<boolean> }

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function exact(x: Record<string, unknown>, keys: string[]) { if (Object.keys(x).some((k) => !keys.includes(k)) || keys.some((k) => !(k in x))) throw new BillingError('BAD_REQUEST'); }
function commandBase(x: unknown, keys: string[]): asserts x is Record<string, unknown> & PortalRequest {
  if (!record(x)) throw new BillingError('BAD_REQUEST'); exact(x, keys);
  if (typeof x['commandId'] !== 'string' || !COMMAND.test(x['commandId']) || !Number.isSafeInteger(x['expectedBillingRevision']) || (x['expectedBillingRevision'] as number) < 0) throw new BillingError('BAD_REQUEST');
}
function parseCheckout(x: unknown): CheckoutRequest {
  commandBase(x, ['commandId', 'expectedBillingRevision', 'interval', 'catalogVersion', 'country', 'termsAcceptance']);
  if (!['month', 'year'].includes(String(x['interval'])) || typeof x['catalogVersion'] !== 'string' || typeof x['country'] !== 'string' || !record(x['termsAcceptance'])) throw new BillingError('BAD_REQUEST');
  exact(x['termsAcceptance'], ['version', 'hash', 'language', 'accepted']);
  const t = x['termsAcceptance']; if (typeof t['version'] !== 'string' || typeof t['hash'] !== 'string' || !['es', 'en'].includes(String(t['language'])) || t['accepted'] !== true) throw new BillingError('BAD_REQUEST');
  return x as unknown as CheckoutRequest;
}
function paramsFingerprint(x: unknown): string { return digest(x); }
function pending(commandId: string, revision: number): BillingResult { return { outcome: 'pending', commandId, billingRevision: revision, retryAfterMs: 3000 }; }
function redirect(c: BillingCommand): BillingResult { return { outcome: 'redirect', commandId: c.commandId, billingRevision: c.resultRevision!, url: c.url!, expiresAt: c.expiresAt! }; }
function safeProviderUrl(url: string, kind: 'checkout' | 'portal'): boolean { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname === (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com'); } catch { return false; } }

export class BillingService {
  constructor(readonly deps: BillingServiceDeps) {}
  async catalog() {
    const c = this.deps.config;
    return { contractVersion: 1 as const, catalogVersion: c.catalogVersion, currency: 'MXN' as const, taxInclusive: true as const, country: 'MX' as const, offerKey: 'premium_individual' as const, planKey: 'premium' as const, prices: billingCatalogPrices(c), purchasesEnabled: purchasesConfigReady(c) && await this.deps.purchasesEnabled() && individualPurchaseAdmitted(c.purchaseAdmission), terms: { version: c.termsVersion, hashes: c.termsHashes, urls: c.termsUrls } };
  }
  async summary(ownerSub: string) {
    const [s, actor, enabled] = await Promise.all([this.deps.repository.load(ownerSub), this.deps.repository.actor(ownerSub), this.deps.purchasesEnabled()]);
    if (!actor) throw new BillingError('UNAUTHENTICATED');
    const cfg = this.deps.config;
    const clock = resolveFinancialClock({ownerSub,customerId:s.customerId ?? '',stage:cfg.stage,accountId:cfg.accountId,
      liveMode:cfg.liveMode,now:this.deps.now(),reference:s.testClock}, await this.deps.repository.readTestClock(ownerSub));
    const state = clock.mode === 'blocked' && s.state !== 'closed' ? 'payment_review'
      : clock.mode !== 'blocked' && s.paidThrough !== null && s.paidThrough <= clock.now && ['active', 'cancel_at_period_end'].includes(s.state) ? 'expired' : s.state;
    const review = state === 'payment_review';
    return { contractVersion: 1 as const, state, interval: s.interval, paidThrough: s.paidThrough, nextRenewalAt: !s.cancelAtPeriodEnd && ['active', 'past_due'].includes(state) ? s.paidThrough : null, cancelAtPeriodEnd: s.cancelAtPeriodEnd, processing: review ? 'review' as const : (s.activeCommandId || s.historyPending) ? 'pending' as const : 'idle' as const, canCheckout: enabled && purchasesConfigReady(this.deps.config) && individualPurchaseAdmitted(this.deps.config.purchaseAdmission, ownerSub) && !s.historyPending && eligible(actor) && !s.closingId && !s.closedAt && !review && !s.activeCommandId && !s.subscriptionId, canOpenPortal: !!s.customerId && !s.closedAt && actor.accountType === 'adult', revision: s.revision };
  }
  async checkout(ownerSub: string, value: unknown): Promise<BillingResult> {
    const req = parseCheckout(value), { repository: r, provider: p, config: cfg } = this.deps;
    const actor = await r.actor(ownerSub); if (!eligible(actor)) throw new BillingError('BILLING_BUYER_INELIGIBLE');
    if (req.country !== 'MX') throw new BillingError('BILLING_BUYER_INELIGIBLE');
    const existing = await r.command(ownerSub, req.commandId);
    if (existing) {
      if (existing.kind !== 'checkout' || existing.fingerprint !== paramsFingerprint(req)) throw new BillingError('BILLING_REVISION_CONFLICT');
      const current = await r.load(ownerSub);
      if (current.closedAt || current.closingId) throw new BillingError('BILLING_BUYER_INELIGIBLE');
      if (existing.status === 'redirect' && existing.expiresAt! > this.deps.now()) return redirect(existing);
      return this.resumeCheckout(ownerSub, existing);
    }
    if (!purchasesConfigReady(cfg) || !await this.deps.purchasesEnabled() || !individualPurchaseAdmitted(cfg.purchaseAdmission, ownerSub)) throw new BillingError('BILLING_DISABLED');
    const prices = billingCatalogPrices(cfg);
    if (req.catalogVersion !== cfg.catalogVersion || req.termsAcceptance.version !== cfg.termsVersion || req.termsAcceptance.hash !== cfg.termsHashes[req.termsAcceptance.language]) throw new BillingError('BILLING_TERMS_OUTDATED');
    let state = await r.load(ownerSub);
    if (state.closedAt || state.closingId) throw new BillingError('BILLING_BUYER_INELIGIBLE');
    if (state.state === 'payment_review') throw new BillingError('BILLING_PAYMENT_REVIEW');
    if (state.historyPending) throw new BillingError('BILLING_OPERATION_PENDING');
    if (state.activeCommandId) return pending(state.activeCommandId, state.revision);
    if (state.subscriptionId) throw new BillingError('BILLING_SUBSCRIPTION_EXISTS');
    if (state.revision !== req.expectedBillingRevision) throw new BillingError('BILLING_REVISION_CONFLICT');
    await p.preflight();
    const now = this.deps.now(), op = operationId(cfg, ownerSub, req.commandId);
    const customerOp = operationId(cfg, ownerSub, 'customer');
    const command: BillingCommand = { ownerSub, commandId: req.commandId, kind: 'checkout', fingerprint: paramsFingerprint(req), operationId: op, createdAt: now, updatedAt: now, status: 'reserved', customerKey: `r2u:customer:${customerOp}`, customerParams: { ownerSub, operationId: customerOp, ...(actor.email ? { email: actor.email } : {}) }, checkoutKey: `r2u:checkout:${op}`, buyerEmailVerified: true, priceTerms: { priceId: req.interval === 'month' ? cfg.monthlyPriceId : cfg.annualPriceId, productId: cfg.productId, amountMinor: prices[req.interval].amountMinor, interval: req.interval, currency: 'mxn', taxRateId: cfg.taxRateId, catalogVersion: cfg.catalogVersion }, consent: { accountId: ownerSub, acceptedAt: now, version: req.termsAcceptance.version, hash: req.termsAcceptance.hash, language: req.termsAcceptance.language }, interval: req.interval };
    const reserved = { ...state, revision: state.revision + 1, state: 'checkout_pending' as const, activeCommandId: command.commandId, updatedAt: now, nextReconcileAt: now };
    if (!await r.commit({ expectedRevision: state.revision, state: reserved, guard: 'adult', actor, command, commandAbsent: true, auditAction: 'billing.checkout_reserved' })) {
      state = await r.load(ownerSub); const same = await r.command(ownerSub, req.commandId);
      if (same && same.fingerprint === command.fingerprint) return this.resumeCheckout(ownerSub, same);
      if (state.activeCommandId) return pending(state.activeCommandId, state.revision);
      throw new BillingError('BILLING_REVISION_CONFLICT');
    }
    return this.resumeCheckout(ownerSub, command);
  }
  async resumeCheckout(ownerSub: string, command: BillingCommand): Promise<BillingResult> {
    const { repository: r, provider: p, config: cfg } = this.deps;
    const worker = randomUUID(), lease = await r.acquireLease(ownerSub, worker, this.deps.now(), 60_000);
    if (!lease) return pending(command.commandId, (await r.load(ownerSub)).revision);
    const fence = () => ({ ...lease, now: this.deps.now() });
    try {
      let s = await r.load(ownerSub);
      const current = await r.command(ownerSub, command.commandId);
      if (!current || current.operationId !== command.operationId || current.kind !== 'checkout') throw new BillingError('BILLING_REVISION_CONFLICT');
      command = current;
      const actor = await r.actor(ownerSub);
      // Background retries use the verified admission recorded at reservation, then recheck
      // the current profile/declaration. HTTP checkout separately requires a verified JWT.
      if (!actor || !eligible({ ...actor, emailVerified: command.buyerEmailVerified === true })) throw new BillingError('BILLING_BUYER_INELIGIBLE');
      if (s.closedAt || s.closingId) throw new BillingError('BILLING_BUYER_INELIGIBLE');
      if (command.status === 'complete' || command.status === 'expired') return pending(command.commandId, s.revision);
      if (!s.customerId) {
        const found = await p.findCustomers(ownerSub);
        if (found.length > 1) return this.review(s, 'duplicate_customer', fence());
        if (!found.length && this.deps.now() - command.createdAt >= 23 * 3_600_000) {
          return this.review(s, 'customer_result_unknown_after_retention', fence());
        }
        const customer = found[0] ?? await p.createCustomer(command.customerParams, command.customerKey);
        if (customer.ownerSub !== ownerSub || customer.liveMode !== cfg.liveMode) return this.review(s, 'customer_mapping', fence());
        const next = { ...s, customerId: customer.id, revision: s.revision + 1, updatedAt: this.deps.now() };
        if (!await r.commit({ expectedRevision: s.revision, state: next, command, guard: 'adult', actor, lease: fence(), mappings: [{ kind: 'customer', id: customer.id }], auditAction: 'billing.customer_bound' })) return pending(command.commandId, (await r.load(ownerSub)).revision);
        s = next;
      }
      if (!command.checkoutParams) {
        if (this.deps.now() - command.createdAt >= 23 * 3_600_000) return this.expireReservation(s, command, actor, fence(), 'no_checkout_authorized', [], []);
        if (!command.priceTerms) return this.review(s, 'missing_reserved_price', fence());
        command = { ...command, checkoutParams: { ownerSub, operationId: command.operationId, customerId: s.customerId!, priceId: command.priceTerms.priceId, quantity: 1, mode: 'subscription', taxRateId: command.priceTerms.taxRateId, expiresAt: this.deps.now() + 1_860_000, successUrl: cfg.successUrl, cancelUrl: cfg.cancelUrl }, updatedAt: this.deps.now() };
        const next = { ...s, revision: s.revision + 1, updatedAt: this.deps.now() };
        if (!await r.commit({ expectedRevision: s.revision, state: next, guard: 'adult', actor, lease: fence(), command, auditAction: 'billing.checkout_parameters_reserved' })) return pending(command.commandId, (await r.load(ownerSub)).revision);
        s = next;
      }
      const remote = command.sessionId ? [await p.retrieveCheckout(command.sessionId)] : await p.findCheckouts(s.customerId!, command.operationId);
      if (remote.length > 1) return this.review(s, 'duplicate_checkout', fence());
      if (!remote.length) {
        const [snapshot, allSessions] = await Promise.all([p.snapshot(s.customerId!, { ownerSub, lease }), p.findCheckouts(s.customerId!)]);
        if (snapshot.customer.ownerSub !== ownerSub || snapshot.customer.liveMode !== cfg.liveMode) return this.review(s, 'customer_mapping', fence());
        if (snapshot.subscriptions.some(nonterminal)) {
          await r.commit({ expectedRevision: s.revision, state: { ...s, revision: s.revision + 1, subscriptionId: snapshot.subscriptions.find(nonterminal)!.id, state: 'payment_review', reviewReasons: ['unmapped_existing_subscription'], nextReconcileAt: this.deps.now(), updatedAt: this.deps.now() }, guard: 'adult', actor, lease: fence(), auditAction: 'billing.remote_subscription_blocked' });
          throw new BillingError('BILLING_SUBSCRIPTION_EXISTS');
        }
        if (allSessions.some((v) => v.status === 'open')) return this.review(s, 'other_open_checkout', fence());
        if (snapshot.invoices.some((v) => v.status === 'open' || v.status === 'draft')) return this.review(s, 'unresolved_remote_invoice', fence());
        if (command.checkoutParams!.expiresAt <= this.deps.now()) return this.expireReservation(s, command, actor, fence(), 'no_remote_after_expiry', allSessions, snapshot.subscriptions, snapshot);
        if (this.deps.now() - command.createdAt >= 23 * 3_600_000) return this.review(s, 'checkout_result_unknown_after_retention', fence());
        const latest = await r.load(ownerSub);
        if (latest.revision !== s.revision || latest.leaseOwner !== lease.owner || latest.leaseRevision !== lease.revision || (latest.leaseUntil ?? 0) <= this.deps.now()) return pending(command.commandId, latest.revision);
      }
      let session = remote[0];
      if (!session) {
        try { session = await p.createCheckout(command.checkoutParams!, command.checkoutKey); }
        catch (error) {
          if (!rejectedCheckoutExpiry(error)) throw error;
          // An exact same-key replay either joins the original operation or returns
          // a definitive expiry rejection. Re-read current objects before releasing.
          const [all, snapshot] = await Promise.all([p.findCheckouts(s.customerId!), p.snapshot(s.customerId!, { ownerSub, lease })]);
          const own = all.filter((v) => v.operationId === command.operationId);
          if (own.length === 1) return this.saveCheckout(s, command, own[0], actor, fence());
          if (own.length || all.some((v) => v.status === 'open') || snapshot.subscriptions.some(nonterminal) || snapshot.invoices.some((v) => v.status === 'open' || v.status === 'draft')) return this.review(s, 'checkout_expiry_not_proven', fence());
          return this.expireReservation(s, command, actor, fence(), 'provider_rejected_expiry', all, snapshot.subscriptions, snapshot);
        }
      }
      return this.saveCheckout(s, command, session, actor, fence());
    } catch (error) {
      if (historyPending(error)) return pending(command.commandId, (await r.load(ownerSub)).revision);
      if (error instanceof BillingError) throw error;
      const s = await r.load(ownerSub), stored = await r.command(ownerSub, command.commandId);
      if (stored && s.activeCommandId === command.commandId) await r.commit({ expectedRevision: s.revision, state: { ...s, revision: s.revision + 1, nextReconcileAt: this.deps.now(), updatedAt: this.deps.now() }, guard: 'none', lease: fence(), command: { ...stored, status: 'uncertain', updatedAt: this.deps.now() }, auditAction: 'billing.checkout_uncertain' });
      return pending(command.commandId, (await r.load(ownerSub)).revision);
    } finally { await r.releaseLease(ownerSub, worker); }
  }
  private async expireReservation(s: BillingState, command: BillingCommand, actor: BillingActor, lease: { owner: string; revision: number; now: number }, reason: string, sessions: { id: string }[], subscriptions: { id: string }[], snapshot?: ProviderSnapshot): Promise<BillingResult> {
    const { repository: r, config, now } = this.deps;
    const state = { ...s, revision: s.revision + 1, activeCommandId: undefined, state: s.paidThrough ? 'expired' as const : 'none' as const, updatedAt: now(), nextReconcileAt: now() };
    const expired: BillingCommand = { ...command, status: 'expired', updatedAt: now(), recoveryEvidence: { checkedAt: now(), accountId: config.accountId, stage: config.stage, reason, sessionIds: sessions.map((v) => v.id), subscriptionIds: subscriptions.map((v) => v.id), invoiceIds: snapshot?.invoices.map((v) => v.id) ?? [] } };
    await r.commit({ expectedRevision: s.revision, state, guard: 'adult', actor, lease, command: expired, auditAction: 'billing.checkout_expiry_verified' });
    return pending(command.commandId, (await r.load(s.ownerSub)).revision);
  }
  private async saveCheckout(s: BillingState, command: BillingCommand, session: ProviderCheckout, actor: BillingActor, lease: { owner: string; revision: number; now: number }): Promise<BillingResult> {
    const { repository: r, now } = this.deps;
    if (session.customerId !== s.customerId || session.ownerSub !== s.ownerSub || session.operationId !== command.operationId || (session.url && !safeProviderUrl(session.url, 'checkout'))) return this.review(s, 'checkout_mapping', lease);
    const state: BillingState = { ...s, revision: s.revision + 1, updatedAt: now(), nextReconcileAt: now() + 60_000, ...(session.subscriptionId ? { subscriptionId: session.subscriptionId } : {}), ...(session.status === 'expired' ? { activeCommandId: undefined, state: s.paidThrough ? 'expired' : 'none' } : {}) };
    const saved: BillingCommand = { ...command, sessionId: session.id, status: session.status === 'open' ? 'redirect' : session.status === 'complete' ? 'complete' : 'expired', url: session.url ?? undefined, expiresAt: session.expiresAt, resultRevision: state.revision, updatedAt: now() };
    if (!await r.commit({ expectedRevision: s.revision, state, guard: 'adult', actor, lease, command: saved, mappings: [{ kind: 'checkout', id: session.id }, ...(session.subscriptionId ? [{ kind: 'subscription' as const, id: session.subscriptionId }] : [])], auditAction: 'billing.checkout_observed' })) return pending(command.commandId, (await r.load(s.ownerSub)).revision);
    return saved.status === 'redirect' && saved.url && saved.expiresAt! > now() ? redirect(saved) : pending(command.commandId, state.revision);
  }
  private async review(s: BillingState, reason: string, lease: { owner: string; revision: number; now: number }): Promise<BillingResult> {
    await this.deps.repository.commit({ expectedRevision: s.revision, state: { ...s, revision: s.revision + 1, state: 'payment_review', reviewReasons: [...new Set([...s.reviewReasons, reason])], updatedAt: this.deps.now(), nextReconcileAt: this.deps.now() + 900_000 }, guard: 'none', lease, auditAction: 'billing.payment_review' });
    throw new BillingError('BILLING_PAYMENT_REVIEW');
  }
  async portal(ownerSub: string, value: unknown): Promise<BillingResult> {
    commandBase(value, ['commandId', 'expectedBillingRevision']); const req = value as PortalRequest;
    const { repository: r, provider: p, config: cfg } = this.deps;
    const actor = await r.actor(ownerSub); if (!actor || actor.status !== 'active' || actor.closing || actor.accountType !== 'adult' || actor.privacyMode === 'adolescent_private') throw new BillingError('BILLING_BUYER_INELIGIBLE');
    let s = await r.load(ownerSub), c = await r.command(ownerSub, req.commandId);
    if (c && (c.kind !== 'portal' || c.fingerprint !== digest(req))) throw new BillingError('BILLING_REVISION_CONFLICT');
    if (!s.customerId || s.closedAt) throw new BillingError('BILLING_BUYER_INELIGIBLE');
    if (c?.status === 'redirect' && c.expiresAt! > this.deps.now()) return redirect(c);
    if (c?.status === 'redirect') return pending(c.commandId, s.revision);
    await p.preflightPortal();
    if (!c) {
      if (s.revision !== req.expectedBillingRevision) throw new BillingError('BILLING_REVISION_CONFLICT');
      const op = operationId(cfg, ownerSub, req.commandId), now = this.deps.now();
      c = { ownerSub, commandId: req.commandId, kind: 'portal', fingerprint: digest(req), operationId: op, createdAt: now, updatedAt: now, status: 'reserved', customerKey: '', customerParams: { ownerSub, operationId: op }, checkoutKey: `r2u:portal:${op}` };
      const next = { ...s, revision: s.revision + 1, updatedAt: now };
      if (!await r.commit({ expectedRevision: s.revision, state: next, guard: 'open', command: c, commandAbsent: true, auditAction: 'billing.portal_reserved' })) return pending(c.commandId, (await r.load(ownerSub)).revision);
      s = next;
    }
    if (this.deps.now() - c.createdAt >= 23 * 3_600_000) return pending(c.commandId, s.revision);
    try {
      const session = await p.createPortal(s.customerId!, cfg.portalReturnUrl, c.operationId, c.checkoutKey);
      if (!safeProviderUrl(session.url, 'portal')) throw new BillingError('BILLING_PAYMENT_REVIEW');
      const next = { ...s, revision: s.revision + 1, updatedAt: this.deps.now() };
      const saved = { ...c, status: 'redirect' as const, url: session.url, expiresAt: session.expiresAt, resultRevision: next.revision };
      if (!await r.commit({ expectedRevision: s.revision, state: next, guard: 'open', command: saved, auditAction: 'billing.portal_created' })) return pending(c.commandId, (await r.load(ownerSub)).revision);
      return redirect(saved);
    } catch (error) { if (error instanceof BillingError) throw error; return pending(c.commandId, s.revision); }
  }
}
