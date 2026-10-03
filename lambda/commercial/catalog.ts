import {
  PREPAYMENT_PLAN_CATALOG,
  type PlanCatalog,
  type PlanKey,
} from '@app/api/contracts';

/**
 * Five compiled, public launch offers from the shared frontend contract.
 * Cadences only change price, not seats or capabilities; legacy free/premium
 * plans remain available. No provider IDs or payment activation live here.
 */
export const PREPAYMENT_CATALOG: PlanCatalog = PREPAYMENT_PLAN_CATALOG;

/** Exact pre-family public shape; switching catalogs never grants account access. */
export const LEGACY_PREPAYMENT_CATALOG = Object.freeze({
  version: '2026-08-prepayment-v1',
  pricingVersion: 'launch-2026',
  currency: PREPAYMENT_CATALOG.currency,
  taxInclusive: PREPAYMENT_CATALOG.taxInclusive,
  paymentsEnabled: false,
  plans: PREPAYMENT_CATALOG.plans,
});

export type AdminGrantOfferKey = 'premium_demo';

export interface AdminGrantOffer {
  readonly catalogVersion: PlanCatalog['version'];
  readonly planKey: PlanKey;
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly permanentAllowed: boolean;
}

const DAY_SECONDS = 24 * 60 * 60;

export const ADMIN_GRANT_OFFERS = Object.freeze({
  premium_demo: Object.freeze({
    catalogVersion: PREPAYMENT_CATALOG.version,
    planKey: 'premium',
    minDurationSeconds: DAY_SECONDS,
    maxDurationSeconds: 5 * 365 * DAY_SECONDS,
    permanentAllowed: true,
  }),
}) satisfies Readonly<Record<AdminGrantOfferKey, AdminGrantOffer>>;
