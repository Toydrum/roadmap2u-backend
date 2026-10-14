import { createHash } from 'node:crypto';
import { individualBillingPrices } from '../../shared/api/contracts';
import type { SubscriptionSourceItem } from '../commercial/model';
import type { PurchaseAdmission } from './admission';
import type { BillingClockReference } from './clock';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
export const INTEGRATION = 'roadmap2u_individual_v1';
export type Interval = 'month' | 'year';
export type BillingStateName = 'none' | 'checkout_pending' | 'active' | 'cancel_at_period_end' | 'past_due' | 'expired' | 'payment_review' | 'closed';
export interface BillingConfig {
  stage: string; accountId: string; liveMode: boolean; productId: string;
  monthlyPriceId: string; annualPriceId: string; taxRateId: string; portalConfigurationId: string;
  catalogVersion: string; termsVersion: string; termsHashes: { es: string; en: string };
  termsUrls: { es: string; en: string }; successUrl: string; cancelUrl: string; portalReturnUrl: string;
  taxRatePercentage?: number; fiscalApprovalReference?: string;
  commercialTermsApprovalReference?: string; generalCommercialTermsApprovalReference?: string;
  purchaseAdmission?: PurchaseAdmission;
}
export interface BillingActor {
  ownerSub: string; accountType: string; status: string; emailVerified: boolean;
  adultDeclarationCurrent: boolean; privacyMode?: string; privacyRevision?: number;
  declarationHash?: string; email?: string; closing?: boolean;
}
export interface BillingState {
  testClock?: BillingClockReference;
  ownerSub: string; revision: number; state: BillingStateName; interval: Interval | null;
  paidThrough: number | null; cancelAtPeriodEnd: boolean; customerId?: string;
  subscriptionId?: string; activeCommandId?: string; reviewReasons: string[];
  nextReconcileAt: number; updatedAt: number; closingId?: string; closedAt?: number;
  leaseOwner?: string; leaseUntil?: number; leaseRevision?: number;
  firstPaidAt?: number; protectedPriceUntil?: number;
  priceBindings?: SubscriptionPriceBinding[];
  closureEvidence?: { checkedAt: number; sessionIds: string[]; subscriptionIds: string[]; invoiceIds: string[]; customerOnlyUncertain: boolean };
  renewalStops?: { subscriptionId: string; operationId: string; cancellation: 'immediate'; invoiceNow: false; prorate: false }[];
  historyPending?: boolean;
}
/** Immutable for the lifetime of this subscription; this MVP never updates Stripe prices. */
export interface SubscriptionPriceBinding {
  subscriptionId: string; priceId: string; productId: string; interval: Interval;
  amountMinor: number; currency: 'mxn'; taxRateId: string; catalogVersion: string;
  firstPaidAt: number; protectedPriceUntil: number;
}
export type ReservedPriceTerms = Omit<SubscriptionPriceBinding, 'subscriptionId' | 'firstPaidAt' | 'protectedPriceUntil'>;
export interface CheckoutParams {
  ownerSub: string; operationId: string; customerId: string; priceId: string;
  quantity: 1; mode: 'subscription'; expiresAt: number; successUrl: string; cancelUrl: string;
  taxRateId: string;
}
export interface BillingCommand {
  ownerSub: string; commandId: string; kind: 'checkout' | 'portal'; fingerprint: string;
  operationId: string; createdAt: number; updatedAt: number; status: 'reserved' | 'uncertain' | 'redirect' | 'complete' | 'expired';
  customerKey: string; customerParams: { ownerSub: string; operationId: string; email?: string };
  checkoutKey: string; checkoutParams?: CheckoutParams; sessionId?: string;
  url?: string; expiresAt?: number;
  consent?: { accountId: string; acceptedAt: number; version: string; hash: string; language: 'es' | 'en' };
  interval?: Interval; resultRevision?: number;
  buyerEmailVerified?: true;
  priceTerms?: ReservedPriceTerms;
  recoveryEvidence?: { checkedAt: number; accountId: string; stage: string; reason: string; sessionIds: string[]; subscriptionIds: string[]; invoiceIds: string[] };
}
export interface ProviderCustomer { id: string; ownerSub: string; operationId: string; liveMode: boolean; country: string | null; testClockId?: string }
export interface ProviderCheckout {
  id: string; customerId: string; operationId: string; ownerSub: string;
  url: string | null; status: 'open' | 'complete' | 'expired'; expiresAt: number; subscriptionId: string | null;
}
export interface ProviderSubscription {
  id: string; customerId: string; ownerSub: string; status: string;
  interval: Interval; priceId: string; productId: string; currency: string; quantity: number;
  cancelAtPeriodEnd: boolean; trial: boolean; automaticCollection: boolean;
  operationId?: string;
  configurationValid?: boolean;
}
export interface ProviderInvoice {
  id: string; customerId: string; subscriptionId: string; status: string;
  currency: string; amountDue: number; amountPaid: number; amountRemaining: number;
  automaticCollection: boolean; paidOutOfBand: boolean; creditApplied: boolean; discounted: boolean;
  paidAt: number | null; taxValid: boolean; taxRateIds: string[];
  lines: { priceId: string; productId: string; quantity: number; interval: Interval; start: number; end: number; amount: number; recurring: boolean; proration: boolean }[];
  payments: { id: string; amountPaid: number; status: string; chargeId: string | null; captured: boolean; currency: string; customerId: string; refunded: number }[];
  refunds: { id: string; chargeId: string; amount: number; status: string }[];
  disputes: { id: string; chargeId: string; amount: number; status: string }[];
}
export interface ProviderSnapshot {
  customer: ProviderCustomer; subscriptions: ProviderSubscription[]; invoices: ProviderInvoice[];
}
export interface ProviderSnapshotOptions { event?: StripeEventEnvelope; ownerSub?: string; lease?: { owner: string; revision: number } }
export interface InvoiceReceipt {
  ownerSub: string; invoiceId: string; subscriptionId: string; customerId: string;
  start: number; end: number; interval: Interval; amountPaid: number; currency: 'mxn';
  valid: boolean; suspended: boolean; refunded: number; disputeStatus?: string;
  reviewReasons: string[]; verifiedAt: number; paymentIds: string[];
  paidAt: number; priceId: string; productId: string; taxRateId: string;
  chargeIds: string[];
}
export interface StripeEventEnvelope {
  eventId: string; type: string; objectId: string; objectType: string;
  apiVersion: string | null; liveMode: boolean; accountId: string;
  status: 'pending' | 'processed' | 'ignored' | 'review'; attempts: number;
  receivedAt: number; nextAttemptAt: number; processedAt?: number;
}
export interface BillingCommit {
  clockObservation?: { item: unknown };
  expectedRevision: number; state: BillingState; guard: 'adult' | 'open' | 'closure' | 'none';
  actor?: BillingActor; command?: BillingCommand; commandAbsent?: boolean;
  invoices?: InvoiceReceipt[]; source?: SubscriptionSourceItem;
  mappings?: { kind: 'customer' | 'subscription' | 'checkout'; id: string }[];
  lease?: { owner: string; revision: number; now: number };
  auditAction: string;
}
export interface BillingPage<T> { items: T[]; cursor?: Record<string, unknown>; itemCursors?: Record<string, unknown>[] }
export interface BillingRepository {
  readTestClock(ownerSub: string): Promise<unknown>;
  actor(ownerSub: string, emailVerified?: boolean): Promise<BillingActor | null>;
  load(ownerSub: string): Promise<BillingState>;
  command(ownerSub: string, commandId: string): Promise<BillingCommand | null>;
  receipts(ownerSub: string): Promise<InvoiceReceipt[]>;
  projectionRevision(ownerSub: string): Promise<number>;
  mappedOwner(kind: 'customer' | 'subscription' | 'checkout', id: string): Promise<string | null>;
  commit(change: BillingCommit): Promise<boolean>;
  acquireLease(ownerSub: string, owner: string, now: number, duration: number): Promise<{ owner: string; revision: number; now: number } | null>;
  releaseLease(ownerSub: string, owner: string): Promise<void>;
  putEvent(event: StripeEventEnvelope): Promise<boolean>;
  event(eventId: string): Promise<StripeEventEnvelope | null>;
  finishEvent(eventId: string, status: 'processed' | 'ignored' | 'review', now: number): Promise<void>;
  retryEvent(eventId: string, now: number): Promise<void>;
  due(kind: 'events' | 'owners', now: number, cursor?: Record<string, unknown>, limit?: number): Promise<BillingPage<StripeEventEnvelope | BillingState>>;
  readCursor(name: string): Promise<Record<string, unknown> | undefined>;
  saveCursor(name: string, cursor?: Record<string, unknown>): Promise<void>;
  saveHistoryCursor(name: string, cursor: Record<string, unknown>, guard: { ownerSub: string; owner: string; revision: number; now: number }): Promise<void>;
}
export interface BillingProvider {
  preflight(): Promise<void>;
  preflightPortal(): Promise<void>;
  createCustomer(params: BillingCommand['customerParams'], key: string): Promise<ProviderCustomer>;
  findCustomers(ownerSub: string): Promise<ProviderCustomer[]>;
  retrieveCustomer(customerId: string): Promise<ProviderCustomer>;
  createCheckout(params: CheckoutParams, key: string): Promise<ProviderCheckout>;
  findCheckouts(customerId: string, operationId?: string): Promise<ProviderCheckout[]>;
  retrieveCheckout(id: string): Promise<ProviderCheckout>;
  createPortal(customerId: string, returnUrl: string, operationId: string, key: string): Promise<{ url: string; expiresAt: number }>;
  snapshot(customerId: string, options?: ProviderSnapshotOptions): Promise<ProviderSnapshot>;
  resolveEvent(event: StripeEventEnvelope): Promise<string | null>;
  stopRenewals(subscriptionId: string, operationId: string): Promise<void>;
  expireCheckout(id: string, operationId: string): Promise<void>;
  cancelSubscription(id: string, operationId: string): Promise<void>;
  closeOutstandingInvoices(customerId: string, operationId: string): Promise<void>;
  auditCustomers(cursor?: string): Promise<{ customers: ProviderCustomer[]; cursor?: string }>;
}
export class BillingError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'BillingError'; }
}
/** Select exact inclusive totals without changing stored subscription terms. */
export function billingCatalogPrices(config: BillingConfig) {
  const prices = individualBillingPrices(config.catalogVersion);
  if (!prices) throw new BillingError('BILLING_PAYMENT_REVIEW');
  return prices;
}
export class BillingHistoryPending extends BillingError {
  readonly continuation = true;
  constructor() { super('BILLING_OPERATION_PENDING'); }
}
export function historyPending(e: unknown): boolean { return !!e && typeof e === 'object' && 'continuation' in e && e.continuation === true; }
export function initialState(ownerSub: string): BillingState {
  return { ownerSub, revision: 0, state: 'none', interval: null, paidThrough: null, cancelAtPeriodEnd: false, reviewReasons: [], nextReconcileAt: 0, updatedAt: 0 };
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function operationId(config: BillingConfig, ownerSub: string, commandId: string): string {
  return digest([INTEGRATION, config.accountId, config.stage, ownerSub, commandId]);
}
export function nonterminal(s: ProviderSubscription): boolean { return s.status !== 'canceled' && s.status !== 'incomplete_expired'; }
export function individualSourceId(config: BillingConfig, ownerSub: string, subscriptionId: string): string { return `individual:${digest([INTEGRATION, config.accountId, config.stage, ownerSub, subscriptionId])}`; }
export function rejectedCheckoutExpiry(error: unknown): boolean {
  const e = error as { type?: string; param?: string };
  return e?.type === 'StripeInvalidRequestError' && e.param === 'expires_at';
}
export function eligible(actor: BillingActor | null): actor is BillingActor {
  return !!actor && actor.accountType === 'adult' && actor.status === 'active' && !actor.closing && actor.privacyMode !== 'adolescent_private' && actor.emailVerified === true && actor.adultDeclarationCurrent === true;
}
