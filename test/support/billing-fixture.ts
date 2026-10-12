import { BillingService } from '../../lambda/billing/service';
import { MemoryBillingRepository } from '../../lambda/billing/repository';
import { FakeBillingProvider } from '../../lambda/billing/fake-provider';
import type { BillingConfig, ProviderInvoice, ProviderSubscription } from '../../lambda/billing/model';

export const NOW = Date.UTC(2026, 9, 11, 12);
export const config: BillingConfig = {
  stage: 'dev', purchaseAdmission: { version: 1, mode: 'cohort', ownerSubs: ['adult'] }, accountId: 'acct_fixture', liveMode: false, productId: 'prod_individual',
  monthlyPriceId: 'price_month', annualPriceId: 'price_year', taxRateId: 'txr_fixture', portalConfigurationId: 'bpc_fixture',
  catalogVersion: 'individual-mx-v1', termsVersion: 'individual-terms-v1', termsHashes: { es: 'a'.repeat(64), en: 'b'.repeat(64) },
  termsUrls: { es: '/subscription-terms?lang=es', en: '/subscription-terms?lang=en' },
  successUrl: 'https://dev.example.test/account/subscription?billing=return', cancelUrl: 'https://dev.example.test/account/subscription?billing=cancel', portalReturnUrl: 'https://dev.example.test/account/subscription',
};
export const request = (commandId = 'purchase-1', revision = 0) => ({ commandId, expectedBillingRevision: revision, interval: 'month' as const, catalogVersion: config.catalogVersion, country: 'MX' as const, termsAcceptance: { version: config.termsVersion, hash: config.termsHashes.es, language: 'es' as const, accepted: true as const } });
export async function fixture() {
  const repository = new MemoryBillingRepository();
  repository.actors.set('adult', { ownerSub: 'adult', accountType: 'adult', status: 'active', emailVerified: true, adultDeclarationCurrent: true });
  let now = NOW, enabled = true;
  const provider = new FakeBillingProvider(config, () => now);
  const service = new BillingService({ repository, provider, config, now: () => now, purchasesEnabled: async () => enabled });
  return { service, repository, provider, now: () => now, setNow: (v: number) => { now = v; }, setEnabled: (v: boolean) => { enabled = v; } };
}
export function subscription(customerId: string, id = 'sub_1'): ProviderSubscription { return { id, customerId, ownerSub: 'adult', status: 'active', interval: 'month', priceId: config.monthlyPriceId, productId: config.productId, currency: 'mxn', quantity: 1, cancelAtPeriodEnd: false, trial: false, automaticCollection: true }; }
export function invoice(customerId: string, id = 'in_1', start = NOW - 1000, end = Date.UTC(2026, 10, 11, 12), subscriptionId = 'sub_1'): ProviderInvoice {
  return { id, customerId, subscriptionId, status: 'paid', currency: 'mxn', amountDue: 9900, amountPaid: 9900, amountRemaining: 0, automaticCollection: true, paidOutOfBand: false, creditApplied: false, discounted: false, paidAt: NOW, taxValid: true, taxRateIds: [config.taxRateId], lines: [{ priceId: config.monthlyPriceId, productId: config.productId, quantity: 1, interval: 'month', start, end, amount: 9900, recurring: true, proration: false }], payments: [{ id: `ip_${id}`, amountPaid: 9900, status: 'paid', chargeId: `ch_${id}`, captured: true, currency: 'mxn', customerId, refunded: 0 }], refunds: [], disputes: [] };
}
