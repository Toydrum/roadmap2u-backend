import type {
  AccessSource,
  AccessSummary,
  PlanKey,
  CoverageState,
} from '@app/api/contracts';
import { ACCESS_OFFLINE_LEASE_MS } from '@app/api/contracts';
import type { AccountClosureItem as DurableAccountClosureItem } from '../account-closure';

export { ACCESS_OFFLINE_LEASE_MS };

export type AccessLimits = AccessSummary['limits'];
export type AccessCapabilities = AccessSummary['capabilities'];
export type AccessEntitlement = Omit<AccessSummary, 'usage'>;

/** Materialized, derivable entitlement state. Usage remains in USAGE items. */
export interface AccessItem extends AccessEntitlement {
  readonly pk: string;
  readonly sk: 'ACCESS';
  readonly ownerSub: string;
  readonly updatedAt: number;
}

export type GrantSourceKind = 'sponsored' | 'legacy_beta';
export type GrantStatus = 'active' | 'revoked';

/**
 * A server-created grant source. The normalized entitlement snapshot is kept
 * with the grant so a future catalog revision does not reinterpret history.
 */
export interface GrantItem {
  readonly pk: string;
  readonly sk: `GRANT#${string}`;
  readonly ownerSub: string;
  readonly grantId: string;
  readonly sourceKind: GrantSourceKind;
  readonly status: GrantStatus;
  readonly catalogVersion: string;
  readonly planKey: PlanKey;
  readonly limits: AccessLimits;
  readonly capabilities: AccessCapabilities;
  readonly startsAt: number;
  readonly expiresAt: number | null;
  readonly revision: number;
  readonly reason: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt?: number;
}

/** Public subscription trace, independent of provider-specific billing records. */
export interface ReservedSubscriptionSource extends AccessSource {
  readonly kind: 'subscription';
}

/** Normalized individual paid-access source; only a trusted billing writer creates it. */
export interface SubscriptionSourceItem {
  readonly pk: string;
  readonly sk: 'SUBSCRIPTION#INDIVIDUAL';
  readonly entityType: 'SubscriptionSource';
  readonly ownerSub: string;
  readonly sourceId: string;
  readonly state: CoverageState;
  readonly paidThrough: number;
  readonly graceUntil: number | null;
  readonly revision: number;
  readonly updatedAt: number;
}

export function subscriptionSourceKey(ownerSub: string): { pk: string; sk: 'SUBSCRIPTION#INDIVIDUAL' } {
  return { pk: `USER#${ownerSub}`, sk: 'SUBSCRIPTION#INDIVIDUAL' };
}

/** Keep commercial guards structurally identical to the durable closure item. */
export type AccountClosureItem = DurableAccountClosureItem;

export function accessKey(ownerSub: string): { pk: string; sk: 'ACCESS' } {
  return { pk: `USER#${ownerSub}`, sk: 'ACCESS' };
}

export function grantKey(
  ownerSub: string,
  grantId: string,
): { pk: string; sk: `GRANT#${string}` } {
  return { pk: `USER#${ownerSub}`, sk: `GRANT#${grantId}` };
}

export function accountClosureKey(ownerSub: string): { pk: string; sk: 'STATE' } {
  return { pk: `ACCOUNT_CLOSURE#${ownerSub}`, sk: 'STATE' };
}
