export type BillingMetric = 'PendingEventAgeSeconds' | 'ReconciliationLagSeconds' | 'DuplicateSubscription' | 'MappingConflict' | 'AccountClosureBillingBlocked' | 'StripeError' | 'SignatureError' | 'ConfigurationError';
export function billingMetric(billingMetric: BillingMetric, value = 1): void { console.log(JSON.stringify({ billingMetric, value })); }
