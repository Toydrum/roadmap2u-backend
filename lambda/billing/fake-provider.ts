import { BillingError, type BillingCommand, type BillingConfig, type BillingProvider, type CheckoutParams, type ProviderCheckout, type ProviderCustomer, type ProviderInvoice, type ProviderSnapshot, type ProviderSubscription, type StripeEventEnvelope } from './model';

/** Synthetic-only provider; never selected by a production environment variable. */
export class FakeBillingProvider implements BillingProvider {
  readonly customers = new Map<string, ProviderCustomer>();
  readonly checkouts = new Map<string, ProviderCheckout>();
  readonly subscriptions = new Map<string, ProviderSubscription>();
  readonly invoices = new Map<string, ProviderInvoice>();
  readonly portalCustomers: string[] = [];
  readonly stoppedRenewals: string[] = [];
  readonly cancelledSubscriptions: string[] = [];
  readonly keys = new Map<string, { params: string; value: unknown }>();
  failAfterCheckout = false;
  failAfterCustomer = false;
  unavailable = false;
  checkoutCreateCalls = 0;
  preflightValid = true;
  constructor(readonly config: BillingConfig, readonly now: () => number) {}
  private ensure() { if (this.unavailable) throw new Error('synthetic provider unavailable'); }
  async preflight() { this.ensure(); if (!this.preflightValid) throw new BillingError('BILLING_PAYMENT_REVIEW'); }
  async preflightPortal() { return this.preflight(); }
  private once<T>(key: string, params: unknown, make: () => T): T {
    this.ensure(); const encoded = JSON.stringify(params), old = this.keys.get(key);
    if (old && old.params !== encoded) throw new Error('idempotency parameters changed');
    if (old) return structuredClone(old.value as T);
    const value = make(); this.keys.set(key, { params: encoded, value: structuredClone(value) }); return structuredClone(value);
  }
  async createCustomer(params: BillingCommand['customerParams'], key: string) {
    const c = this.once(key, params, () => { const item = { id: `cus_${this.customers.size + 1}`, ownerSub: params.ownerSub, operationId: params.operationId, liveMode: this.config.liveMode, country: 'MX' }; this.customers.set(item.id, item); return item; });
    if (this.failAfterCustomer) { this.failAfterCustomer = false; throw new Error('lost customer response'); } return c;
  }
  async findCustomers(ownerSub: string) { this.ensure(); return structuredClone([...this.customers.values()].filter((c) => c.ownerSub === ownerSub)); }
  async retrieveCustomer(customerId: string) { this.ensure(); const c = this.customers.get(customerId); if (!c) throw new Error('customer missing'); return structuredClone(c); }
  async createCheckout(params: CheckoutParams, key: string) {
    this.checkoutCreateCalls++;
    const s = this.once(key, params, () => {
      if (params.expiresAt < this.now() + 1_800_000) throw Object.assign(new Error('synthetic expires_at rejected'), { type: 'StripeInvalidRequestError', param: 'expires_at' });
      const id = `cs_${this.checkouts.size + 1}`; const item: ProviderCheckout = { id, customerId: params.customerId, ownerSub: params.ownerSub, operationId: params.operationId, status: 'open', expiresAt: params.expiresAt, url: `https://checkout.stripe.com/c/pay/${id}`, subscriptionId: null }; this.checkouts.set(id, item); return item;
    });
    if (this.failAfterCheckout) { this.failAfterCheckout = false; throw new Error('lost checkout response'); } return s;
  }
  async findCheckouts(customerId: string, operationId?: string) { this.ensure(); return structuredClone([...this.checkouts.values()].filter((s) => s.customerId === customerId && (operationId === undefined || s.operationId === operationId))); }
  async retrieveCheckout(id: string) { this.ensure(); const c = this.checkouts.get(id); if (!c) throw new Error('session missing'); return structuredClone(c); }
  async createPortal(customerId: string, returnUrl: string, operationId: string, key: string) {
    return this.once(key, { customerId, returnUrl, operationId }, () => { this.portalCustomers.push(customerId); return { url: 'https://billing.stripe.com/p/session/synthetic', expiresAt: this.now() + 300_000 }; });
  }
  async snapshot(customerId: string): Promise<ProviderSnapshot> {
    this.ensure(); const customer = this.customers.get(customerId); if (!customer) throw new Error('customer missing');
    return structuredClone({ customer, subscriptions: [...this.subscriptions.values()].filter((s) => s.customerId === customerId), invoices: [...this.invoices.values()].filter((i) => i.customerId === customerId) });
  }
  async resolveEvent(e: StripeEventEnvelope) {
    this.ensure();
    if (e.objectType === 'customer') return e.objectId;
    if (e.objectType === 'checkout.session') return this.checkouts.get(e.objectId)?.customerId ?? null;
    if (e.objectType === 'subscription') return this.subscriptions.get(e.objectId)?.customerId ?? null;
    if (e.objectType === 'invoice') return this.invoices.get(e.objectId)?.customerId ?? null;
    return [...this.invoices.values()].find((i) => i.refunds.some((r) => r.id === e.objectId) || i.disputes.some((d) => d.id === e.objectId) || i.payments.some((p) => p.chargeId === e.objectId))?.customerId ?? null;
  }
  async stopRenewals(id: string) { this.ensure(); const s = this.subscriptions.get(id); if (s) { s.status = 'canceled'; s.cancelAtPeriodEnd = false; if (!this.stoppedRenewals.includes(id)) this.stoppedRenewals.push(id); for (const i of this.invoices.values()) if (i.subscriptionId === id && ['draft', 'open'].includes(i.status)) i.status = 'void'; } }
  async expireCheckout(id: string) { this.ensure(); const s = this.checkouts.get(id); if (s?.status === 'open') s.status = 'expired'; }
  async cancelSubscription(id: string) { this.ensure(); const s = this.subscriptions.get(id); if (s) { s.status = 'canceled'; s.cancelAtPeriodEnd = false; if (!this.cancelledSubscriptions.includes(id)) this.cancelledSubscriptions.push(id); } }
  async closeOutstandingInvoices(customerId: string) { this.ensure(); for (const i of this.invoices.values()) if (i.customerId === customerId && ['draft', 'open'].includes(i.status)) i.status = 'void'; }
  async auditCustomers(cursor?: string) { this.ensure(); const all = [...this.customers.values()]; const start = Number(cursor ?? 0); return { customers: structuredClone(all.slice(start, start + 25)), ...(start + 25 < all.length ? { cursor: String(start + 25) } : {}) }; }
}
