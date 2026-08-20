import {
  PREPAYMENT_PLAN_CATALOG,
  type PlanCatalog,
  type PlanKey,
} from '@app/api/contracts';

/**
 * Compiled, public launch catalog. It deliberately has no runtime billing
 * configuration: both cadences describe the same Premium plan and capabilities.
 */
export const PREPAYMENT_CATALOG: PlanCatalog = PREPAYMENT_PLAN_CATALOG;

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
