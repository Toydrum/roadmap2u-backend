import Stripe from 'stripe';
import { BillingError, BillingHistoryPending, INTEGRATION, STRIPE_API_VERSION, billingCatalogPrices, digest, nonterminal, type BillingCommand, type BillingConfig, type BillingProvider, type CheckoutParams, type ProviderCheckout, type ProviderCustomer, type ProviderInvoice, type ProviderSubscription, type ProviderSnapshotOptions, type StripeEventEnvelope } from './model';
import { collectStripeHistory, type StripeHistoryOptions } from './history';

function id(value: string | { id: string } | null | undefined): string { return typeof value === 'string' ? value : value?.id ?? ''; }
function reject(): never { throw new BillingError('BILLING_PAYMENT_REVIEW'); }
async function pages<T extends { id: string }>(fetch: (starting_after?: string) => Promise<{ data: T[]; has_more: boolean }>, maximum = Infinity): Promise<T[]> {
  const result: T[] = []; let cursor: string | undefined;
  do { const page = await fetch(cursor); result.push(...page.data); if (result.length > maximum || (page.has_more && !page.data.length)) reject(); cursor = page.has_more ? page.data.at(-1)?.id : undefined; } while (cursor);
  return result;
}
/** All remote objects are re-read under one pinned API and normalized before domain use. */
export class StripeBillingProvider implements BillingProvider {
  constructor(readonly config: BillingConfig, readonly stripe: Stripe, readonly historyOptions?: StripeHistoryOptions) {}
  static create(config: BillingConfig, apiKey: string, historyOptions?: StripeHistoryOptions) { return new StripeBillingProvider(config, new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 10_000, appInfo: { name: 'RoadMap2U Individual Billing', version: '1' } }), historyOptions); }
  private metadata(owner: string, operation: string) { return { integration: INTEGRATION, stage: this.config.stage, owner, operation }; }
  private own(metadata: Stripe.Metadata | null | undefined): boolean { return metadata?.['integration'] === INTEGRATION && metadata['stage'] === this.config.stage; }
  private customer(c: Stripe.Customer | Stripe.DeletedCustomer): ProviderCustomer {
    if (c.deleted || !this.own(c.metadata) || c.livemode !== this.config.liveMode) reject();
    return { id: c.id, ownerSub: c.metadata['owner'] ?? '', operationId: c.metadata['operation'] ?? '', liveMode: c.livemode, country: c.address?.country ?? null,
      ...(c.test_clock ? {testClockId:id(c.test_clock)} : {}) };
  }
  private checkout(c: Stripe.Checkout.Session): ProviderCheckout {
    if (!this.own(c.metadata) || c.livemode !== this.config.liveMode || !['open', 'complete', 'expired'].includes(c.status ?? '')) reject();
    return { id: c.id, customerId: id(c.customer), ownerSub: c.metadata?.['owner'] ?? '', operationId: c.metadata?.['operation'] ?? '', status: c.status as ProviderCheckout['status'], url: c.url, expiresAt: c.expires_at * 1000, subscriptionId: id(c.subscription) || null };
  }
  async preflight(): Promise<void> {
    const c = this.config;
    const prices = billingCatalogPrices(c);
    const [account, product, month, year, tax, portal] = await Promise.all([this.stripe.accounts.retrieve(null), this.stripe.products.retrieve(c.productId), this.stripe.prices.retrieve(c.monthlyPriceId), this.stripe.prices.retrieve(c.annualPriceId), this.stripe.taxRates.retrieve(c.taxRateId), this.stripe.billingPortal.configurations.retrieve(c.portalConfigurationId)]);
    // Sandbox simulations do not require activating services on a live account.
    if (account.id !== c.accountId || account.country !== 'MX' || (c.liveMode && (!account.charges_enabled || !account.details_submitted || account.requirements?.currently_due?.length))) reject();
    if ('deleted' in product || !product.active || product.livemode !== c.liveMode || !this.own(product.metadata)) reject();
    for (const [price, interval, amount] of [[month, 'month', prices.month.amountMinor], [year, 'year', prices.year.amountMinor]] as const) if (!price.active || price.livemode !== c.liveMode || id(price.product) !== c.productId || price.currency !== 'mxn' || price.unit_amount !== amount || price.tax_behavior !== 'inclusive' || price.type !== 'recurring' || price.recurring?.interval !== interval || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed') reject();
    if (!tax.active || !tax.inclusive || tax.country !== 'MX' || tax.livemode !== c.liveMode || (c.taxRatePercentage !== undefined && tax.percentage !== c.taxRatePercentage)) reject();
    this.assertPortal(portal);
  }
  private assertPortal(portal: Stripe.BillingPortal.Configuration) {
    const f = portal.features;
    if (!portal.active || portal.livemode !== this.config.liveMode || !f.invoice_history.enabled || !f.customer_update.enabled || [...f.customer_update.allowed_updates].sort().join(',') !== 'address,email,name' || !f.payment_method_update.enabled || !f.subscription_cancel.enabled || f.subscription_cancel.mode !== 'at_period_end' || f.subscription_cancel.proration_behavior !== 'none' || ('retention' in f.subscription_cancel && f.subscription_cancel.retention) || f.subscription_update.enabled) reject();
  }
  async preflightPortal(): Promise<void> { this.assertPortal(await this.stripe.billingPortal.configurations.retrieve(this.config.portalConfigurationId)); }
  async createCustomer(params: BillingCommand['customerParams'], key: string) {
    return this.customer(await this.stripe.customers.create({ metadata: this.metadata(params.ownerSub, params.operationId), ...(params.email ? { email: params.email } : {}) }, { idempotencyKey: key }));
  }
  async findCustomers(ownerSub: string): Promise<ProviderCustomer[]> {
    const escaped = ownerSub.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await this.stripe.customers.search({ query: `metadata['integration']:'${INTEGRATION}' AND metadata['stage']:'${this.config.stage}' AND metadata['owner']:'${escaped}'`, limit: 100 });
    if (result.has_more) reject();
    return result.data.map((c) => this.customer(c));
  }
  async retrieveCustomer(customerId: string) { return this.customer(await this.stripe.customers.retrieve(customerId)); }
  async createCheckout(p: CheckoutParams, key: string) {
    const metadata = this.metadata(p.ownerSub, p.operationId);
    return this.checkout(await this.stripe.checkout.sessions.create({ mode: 'subscription', customer: p.customerId, client_reference_id: p.ownerSub, metadata, line_items: [{ price: p.priceId, quantity: 1 }], allowed_payment_method_types: ['card'], allow_promotion_codes: false, automatic_tax: { enabled: false }, billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' }, tax_id_collection: { enabled: false }, subscription_data: { metadata, default_tax_rates: [p.taxRateId], billing_mode: { type: 'flexible' } }, expires_at: Math.floor(p.expiresAt / 1000), success_url: p.successUrl, cancel_url: p.cancelUrl }, { idempotencyKey: key }));
  }
  async findCheckouts(customerId: string, operationId?: string) {
    const sessions = await pages((starting_after) => this.stripe.checkout.sessions.list({ customer: customerId, limit: 100, ...(starting_after ? { starting_after } : {}) }));
    return sessions.filter((s) => this.own(s.metadata) && (operationId === undefined || s.metadata?.['operation'] === operationId)).map((s) => this.checkout(s));
  }
  async retrieveCheckout(sessionId: string) { return this.checkout(await this.stripe.checkout.sessions.retrieve(sessionId)); }
  async createPortal(customerId: string, returnUrl: string, _operationId: string, key: string) {
    const session = await this.stripe.billingPortal.sessions.create({ customer: customerId, configuration: this.config.portalConfigurationId, return_url: returnUrl }, { idempotencyKey: key });
    return { url: session.url, expiresAt: session.created * 1000 + 300_000 };
  }
  private subscription(s: Stripe.Subscription): ProviderSubscription {
    const item = s.items.data[0], price = item?.price;
    if (!this.own(s.metadata) || s.livemode !== this.config.liveMode || s.items.has_more || s.items.data.length !== 1 || !price || (price.recurring?.interval !== 'month' && price.recurring?.interval !== 'year')) reject();
    const rates = item.tax_rates?.length ? item.tax_rates : s.default_tax_rates;
    // Flexible Portal cancellation sets cancel_at and leaves the legacy flag false.
    // Only the supported end of this single item's period represents our contract.
    const scheduledCancellation = s.billing_mode?.type === 'flexible' && s.cancel_at != null;
    const cancellationAtPeriodEnd = Number.isSafeInteger(s.cancel_at) && (s.cancel_at ?? 0) > 0 && s.cancel_at === item.current_period_end;
    const cancelAtPeriodEnd = s.cancel_at_period_end || (scheduledCancellation && cancellationAtPeriodEnd);
    const configurationValid = price.tax_behavior === 'inclusive' && price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed' && s.automatic_tax?.enabled === false && !s.pause_collection && !(s.discounts?.length) && !(item.discounts?.length) && rates?.length === 1 && rates[0]?.inclusive === true && rates[0]?.country === 'MX' && (!scheduledCancellation || cancellationAtPeriodEnd);
    return { id: s.id, customerId: id(s.customer), ownerSub: s.metadata['owner'] ?? '', operationId: s.metadata['operation'] ?? '', status: s.status, interval: price.recurring.interval as 'month' | 'year', priceId: price.id, productId: id(price.product), currency: price.currency, quantity: item.quantity ?? 0, cancelAtPeriodEnd, trial: !!s.trial_start || !!s.trial_end || s.status === 'trialing', automaticCollection: s.collection_method === 'charge_automatically', configurationValid };
  }
  private async invoice(i: Stripe.Invoice, subs: ProviderSubscription[], checkBudget: () => void = () => {}): Promise<ProviderInvoice> {
    checkBudget();
    if (i.livemode !== this.config.liveMode) reject();
    const subscriptionId = id(i.parent?.subscription_details?.subscription);
    const sub = subs.find((s) => s.id === subscriptionId);
    const rawLines = i.lines.has_more ? await pages((starting_after) => this.stripe.invoices.listLineItems(i.id, { limit: 100, ...(starting_after ? { starting_after } : {}) }), 50) : i.lines.data;
    const rawPayments = i.status === 'paid' ? await pages((starting_after) => this.stripe.invoicePayments.list({ invoice: i.id, limit: 100, expand: ['data.payment.payment_intent.latest_charge'], ...(starting_after ? { starting_after } : {}) }), 50) : [];
    const payments: ProviderInvoice['payments'] = [], refunds: ProviderInvoice['refunds'] = [], disputes: ProviderInvoice['disputes'] = [];
    for (const payment of rawPayments) {
      checkBudget();
      if (payment.status !== 'paid') continue;
      if (payment.livemode !== this.config.liveMode || id(payment.invoice) !== i.id || payment.payment.type !== 'payment_intent') {
        payments.push({ id: payment.id, amountPaid: payment.amount_paid ?? 0, status: payment.status, chargeId: null, captured: false, currency: payment.currency, customerId: '', refunded: 0 }); continue;
      }
      const raw = payment.payment.payment_intent;
      const pi = typeof raw === 'string' ? await this.stripe.paymentIntents.retrieve(raw, { expand: ['latest_charge'] }) : raw;
      checkBudget();
      const charge = typeof pi?.latest_charge === 'string' ? await this.stripe.charges.retrieve(pi.latest_charge) : pi?.latest_charge;
      const captured = !!charge && pi?.status === 'succeeded' && pi.livemode === this.config.liveMode && pi.currency === payment.currency && pi.amount_received === payment.amount_paid && charge.paid && charge.captured && charge.amount === payment.amount_paid && charge.amount_captured === payment.amount_paid && charge.livemode === this.config.liveMode && charge.payment_method_details?.type === 'card' && id(pi.customer) === id(i.customer);
      payments.push({ id: payment.id, amountPaid: payment.amount_paid ?? 0, status: payment.status, chargeId: charge?.id ?? null, captured, currency: charge?.currency ?? payment.currency, customerId: id(charge?.customer), refunded: charge?.amount_refunded ?? 0 });
      if (charge) {
        checkBudget();
        const [rs, ds] = await Promise.all([pages((starting_after) => this.stripe.refunds.list({ charge: charge.id, limit: 100, ...(starting_after ? { starting_after } : {}) }), 50), pages((starting_after) => this.stripe.disputes.list({ charge: charge.id, limit: 100, ...(starting_after ? { starting_after } : {}) }), 50)]);
        refunds.push(...rs.map((r) => ({ id: r.id, chargeId: id(r.charge), amount: r.amount, status: r.status ?? 'unknown' })));
        disputes.push(...ds.map((d) => ({ id: d.id, chargeId: id(d.charge), amount: d.amount, status: d.status })));
      }
    }
    const taxRateIds = [...new Set(rawLines.flatMap((l) => (l.taxes ?? []).map((t) => id(t.tax_rate_details?.tax_rate))).filter(Boolean))];
    const taxValid = i.automatic_tax?.enabled === false && rawLines.length > 0 && rawLines.every((l) => l.taxes?.length === 1 && l.taxes[0]?.tax_behavior === 'inclusive' && !!l.taxes[0].tax_rate_details?.tax_rate);
    return { id: i.id, customerId: id(i.customer), subscriptionId, status: i.status ?? 'unknown', currency: i.currency, amountDue: i.amount_due, amountPaid: i.amount_paid, amountRemaining: i.amount_remaining, automaticCollection: i.collection_method === 'charge_automatically', paidOutOfBand: i.status === 'paid' && payments.length === 0, paidAt: i.status_transitions?.paid_at ? i.status_transitions.paid_at * 1000 : null, taxValid, taxRateIds, creditApplied: i.starting_balance !== 0 || (i.ending_balance ?? 0) !== 0 || i.pre_payment_credit_notes_amount !== 0 || i.post_payment_credit_notes_amount !== 0 || rawLines.some((l) => l.pretax_credit_amounts?.some((c) => c.amount > 0)), discounted: !!i.discounts?.length || !!i.total_discount_amounts?.some((d) => d.amount !== 0) || rawLines.some((l) => l.discounts?.length || l.discount_amounts?.some((d) => d.amount !== 0)), lines: rawLines.map((l) => ({ priceId: id(l.pricing?.price_details?.price), productId: id(l.pricing?.price_details?.product), quantity: l.quantity_decimal !== null && l.quantity_decimal !== undefined && String(l.quantity_decimal) !== '1' ? 0 : l.quantity ?? 0, interval: sub?.interval ?? 'month', start: l.period.start * 1000, end: l.period.end * 1000, amount: l.amount, recurring: l.parent?.type === 'subscription_item_details' && l.parent.subscription_item_details?.subscription === subscriptionId && l.currency === i.currency, proration: l.parent?.subscription_item_details?.proration ?? true })), payments, refunds, disputes };
  }
  private async eventInvoices(event?: StripeEventEnvelope): Promise<string[]> {
    if (!event) return [];
    if (event.objectType === 'invoice') return [event.objectId];
    let chargeId = event.objectType === 'charge' ? event.objectId : '';
    if (event.objectType === 'refund') chargeId = id((await this.stripe.refunds.retrieve(event.objectId)).charge);
    if (event.objectType === 'dispute') chargeId = id((await this.stripe.disputes.retrieve(event.objectId)).charge);
    if (!chargeId) return [];
    const charge = await this.stripe.charges.retrieve(chargeId), pi = id(charge.payment_intent);
    if (!pi) reject();
    const payments = await pages((starting_after) => this.stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: pi }, limit: 100, ...(starting_after ? { starting_after } : {}) }), 50);
    return [...new Set(payments.map((p) => id(p.invoice)))];
  }
  async snapshot(customerId: string, options?: ProviderSnapshotOptions) {
    const customer = await this.retrieveCustomer(customerId);
    if (options?.ownerSub && customer.ownerSub !== options.ownerSub) reject();
    if (!this.historyOptions) {
      const rawSubscriptions = await pages((starting_after) => this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(starting_after ? { starting_after } : {}) }));
      const subscriptions = rawSubscriptions.map((s) => this.subscription(s));
      const invoices = await pages((starting_after) => this.stripe.invoices.list({ customer: customerId, limit: 100, ...(starting_after ? { starting_after } : {}) }));
      const normalized = []; for (const i of invoices) normalized.push(await this.invoice(i, subscriptions));
      return { customer, subscriptions, invoices: normalized };
    }
    const clock = this.historyOptions.now ?? Date.now, deadline = clock() + (this.historyOptions.budgetMs ?? 25_000);
    const checkBudget = () => { if (clock() >= deadline) throw new BillingHistoryPending(); };
    const r = this.historyOptions.repository;
    if (this.historyOptions.requireLease && (!options?.ownerSub || !options.lease)) throw new BillingHistoryPending();
    const historyOptions = options?.ownerSub && options.lease ? { ...this.historyOptions, repository: { readCursor: r.readCursor.bind(r), saveHistoryCursor: r.saveHistoryCursor.bind(r), saveCursor: (name: string, cursor?: Record<string, unknown>) => r.saveHistoryCursor(name, cursor ?? {}, { ownerSub: options.ownerSub!, ...options.lease!, now: clock() }) } } : this.historyOptions;
    const history = await collectStripeHistory(this.config, customerId, historyOptions, {
      subscriptions: async (after) => { const p = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 50, ...(after ? { starting_after: after } : {}) }); return { data: p.data.map((s) => this.subscription(s)), has_more: p.has_more }; },
      invoices: async (subs, after) => { const p = await this.stripe.invoices.list({ customer: customerId, limit: 1, ...(after ? { starting_after: after } : {}) }); const normalized = []; for (const i of p.data) normalized.push(await this.invoice(i, subs, checkBudget)); return { data: normalized, has_more: p.has_more }; },
    });
    const now = (this.historyOptions.now ?? Date.now)();
    // Cached historical facts never authorize current access. Every covering period,
    // collectible invoice, nonterminal subscription and event target is read again.
    const subs = new Map(history.subscriptions.map((s) => [s.id, s])), invoices = new Map(history.invoices.map((i) => [i.id, i]));
    const [newSubs, newInvoices, targets] = await Promise.all([
      pages((starting_after) => {if (customer.testClockId) checkBudget();return this.stripe.subscriptions.list({ customer: customerId, status: 'all', ...(customer.testClockId ? {} : {created: { gte: Math.floor(history.startedAt / 1000) }}), limit: 100, ...(starting_after ? { starting_after } : {}) });}),
      pages((starting_after) => {if (customer.testClockId) checkBudget();return this.stripe.invoices.list({ customer: customerId, ...(customer.testClockId ? {} : {created: { gte: Math.floor(history.startedAt / 1000) }}), limit: 100, ...(starting_after ? { starting_after } : {}) });}),
      this.eventInvoices(options?.event),
    ]);
    for (const sub of newSubs) subs.set(sub.id, this.subscription(sub));
    // A simulated period may lie on either side of wall time. Re-read its full
    // small QA history rather than trusting a real-time covering/created filter.
    const refreshInvoices = new Set([...targets, ...newInvoices.map((i) => i.id), ...history.invoices.filter((i) => customer.testClockId || ['open', 'draft'].includes(i.status) || i.lines.some((l) => l.start <= now && l.end > now)).map((i) => i.id)]);
    const rawInvoices = []; for (const invoiceId of refreshInvoices) { if (customer.testClockId) checkBudget(); const raw = await this.stripe.invoices.retrieve(invoiceId); if (id(raw.customer) !== customerId) reject(); rawInvoices.push(raw); }
    const refreshSubs = new Set([...subs.values()].filter(nonterminal).map((s) => s.id));
    for (const raw of rawInvoices) { const subId = id(raw.parent?.subscription_details?.subscription); if (subId) refreshSubs.add(subId); }
    if (options?.event?.objectType === 'subscription') refreshSubs.add(options.event.objectId);
    for (const subId of refreshSubs) { const sub = this.subscription(await this.stripe.subscriptions.retrieve(subId)); if (sub.customerId !== customerId) reject(); subs.set(subId, sub); }
    for (const raw of rawInvoices) invoices.set(raw.id, await this.invoice(raw, [...subs.values()]));
    await history.update('subscriptions', [...subs.values()]);
    await history.update('invoices', [...invoices.values()]);
    return { customer, subscriptions: [...subs.values()], invoices: [...invoices.values()] };
  }
  async resolveEvent(e: StripeEventEnvelope): Promise<string | null> {
    switch (e.objectType) {
      case 'checkout.session': return id((await this.stripe.checkout.sessions.retrieve(e.objectId)).customer) || null;
      case 'subscription': return id((await this.stripe.subscriptions.retrieve(e.objectId)).customer) || null;
      case 'invoice': return id((await this.stripe.invoices.retrieve(e.objectId)).customer) || null;
      case 'charge': return id((await this.stripe.charges.retrieve(e.objectId)).customer) || null;
      case 'refund': { const r = await this.stripe.refunds.retrieve(e.objectId); return id((await this.stripe.charges.retrieve(id(r.charge))).customer) || null; }
      case 'dispute': { const d = await this.stripe.disputes.retrieve(e.objectId); return id((await this.stripe.charges.retrieve(id(d.charge))).customer) || null; }
      default: return null;
    }
  }
  async stopRenewals(subscriptionId: string, operationId: string) {
    // A disputed subscription is technically final: Portal cannot resume it. A win
    // restores its remaining financial period without reactivating remote billing.
    await this.cancelSubscription(subscriptionId, operationId);
    const invoices = await pages((starting_after) => this.stripe.invoices.list({ subscription: subscriptionId, limit: 100, ...(starting_after ? { starting_after } : {}) }));
    for (const i of invoices) {
      if (id(i.parent?.subscription_details?.subscription) !== subscriptionId) reject();
      if (i.status === 'draft') await this.stripe.invoices.del(i.id);
      else if (i.status === 'open') await this.stripe.invoices.voidInvoice(i.id, {}, { idempotencyKey: `r2u:${operationId}:${i.id}` });
    }
  }
  async expireCheckout(sessionId: string, operationId: string) { const s = await this.stripe.checkout.sessions.retrieve(sessionId); if (s.status === 'open') await this.stripe.checkout.sessions.expire(sessionId, {}, { idempotencyKey: `r2u:${operationId}:${sessionId}` }); }
  async cancelSubscription(subscriptionId: string, operationId: string) { const sub = await this.stripe.subscriptions.retrieve(subscriptionId); if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') await this.stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false }, { idempotencyKey: `r2u:${operationId}:${subscriptionId}` }); }
  async closeOutstandingInvoices(customerId: string, operationId: string) {
    const invoices = await pages((starting_after) => this.stripe.invoices.list({ customer: customerId, limit: 100, ...(starting_after ? { starting_after } : {}) }));
    for (const i of invoices) {
      if (i.parent?.type !== 'subscription_details') continue;
      if (i.status === 'draft') await this.stripe.invoices.del(i.id);
      else if (i.status === 'open') await this.stripe.invoices.voidInvoice(i.id, {}, { idempotencyKey: `r2u:${operationId}:${i.id}` });
    }
  }
  async auditCustomers(cursor?: string) {
    const result = await this.stripe.customers.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    return { customers: result.data.filter((c) => this.own(c.metadata)).map((c) => this.customer(c)), ...(result.has_more ? { cursor: result.data.at(-1)?.id } : {}) };
  }
}
