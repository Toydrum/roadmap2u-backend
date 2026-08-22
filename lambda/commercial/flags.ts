import { ApiError, type ApiErrorCode } from '@app/api/contracts';

export type CommercialMode = 'off' | 'observe' | 'enforce';

export interface CommercialFlags {
  readonly revision: number;
  readonly quotaMode: CommercialMode;
  readonly capabilityMode: CommercialMode;
  readonly accessCodeIssuanceEnabled: boolean;
  readonly accessCodeRedemptionEnabled: boolean;
  /** Payments cannot be enabled during the prepayment launch. */
  readonly premiumPaymentsEnabled: false;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly reason: string;
}

export type CommercialConfigResult =
  | {
      readonly status: 'available';
      readonly freshness: 'cache' | 'fresh' | 'stale';
      readonly flags: CommercialFlags;
      readonly loadedAt: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'missing' | 'invalid' | 'read-failed' | 'expired';
    };

export type CommercialOperation =
  | { readonly kind: 'read' }
  | { readonly kind: 'cloud-delta'; readonly delta: number }
  | {
      readonly kind: 'social';
      readonly action:
        | 'create'
        | 'accept'
        | 'visit'
        | 'decline'
        | 'cancel'
        | 'remove'
        | 'privacy'
        | 'export';
    };

export type CommercialSwitch = 'issuance' | 'redemption' | 'payments';

export type CommercialMetricName =
  | 'ConfigurationDrift'
  | 'CommercialConfigurationUnavailable'
  | 'CommercialConfigurationStale';

export interface CommercialFlagsResolverDeps {
  /** Reads COMMERCIAL#CONFIG / FLAGS with a consistent Get in the adapter. */
  readonly readItem: () => Promise<unknown>;
  readonly now: () => number;
  readonly emitMetric: (metric: CommercialMetricName) => void;
}

type UnavailableReason = Extract<CommercialConfigResult, { status: 'unavailable' }>['reason'];

interface ParsedFlags {
  readonly flags: CommercialFlags;
  readonly paymentsDrift: boolean;
}

interface GoodSnapshot {
  readonly flags: CommercialFlags;
  readonly loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
const LAST_KNOWN_GOOD_TTL_MS = 15 * 60_000;
const MODES = new Set<CommercialMode>(['off', 'observe', 'enforce']);
const ITEM_KEYS = new Set([
  'pk',
  'sk',
  'revision',
  'quotaMode',
  'capabilityMode',
  'accessCodeIssuanceEnabled',
  'accessCodeRedemptionEnabled',
  'premiumPaymentsEnabled',
  'updatedAt',
  'updatedBy',
  'reason',
]);
const SAFE_SOCIAL_ACTIONS = new Set<Extract<CommercialOperation, { kind: 'social' }>['action']>([
  'decline',
  'cancel',
  'remove',
  'privacy',
  'export',
]);
const CONFIGURATION_UNAVAILABLE_CODE =
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE' as ApiErrorCode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === ITEM_KEYS.size && keys.every((key) => ITEM_KEYS.has(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMode(value: unknown): value is CommercialMode {
  return typeof value === 'string' && MODES.has(value as CommercialMode);
}

function parseFlagsItem(value: unknown): ParsedFlags | null {
  if (!isRecord(value) || !hasExactKeys(value)) return null;
  if (value['pk'] !== 'COMMERCIAL#CONFIG' || value['sk'] !== 'FLAGS') return null;
  if (!isPositiveInteger(value['revision'])) return null;
  if (!isMode(value['quotaMode']) || !isMode(value['capabilityMode'])) return null;
  if (typeof value['accessCodeIssuanceEnabled'] !== 'boolean') return null;
  if (typeof value['accessCodeRedemptionEnabled'] !== 'boolean') return null;
  if (typeof value['premiumPaymentsEnabled'] !== 'boolean') return null;
  if (!isTimestamp(value['updatedAt'])) return null;
  if (!isNonBlank(value['updatedBy']) || !isNonBlank(value['reason'])) return null;

  return {
    flags: Object.freeze({
      revision: value['revision'],
      quotaMode: value['quotaMode'],
      capabilityMode: value['capabilityMode'],
      accessCodeIssuanceEnabled: value['accessCodeIssuanceEnabled'],
      accessCodeRedemptionEnabled: value['accessCodeRedemptionEnabled'],
      premiumPaymentsEnabled: false,
      updatedAt: value['updatedAt'],
      updatedBy: value['updatedBy'],
      reason: value['reason'],
    }),
    paymentsDrift: value['premiumPaymentsEnabled'],
  };
}

function sameFlags(left: CommercialFlags, right: CommercialFlags): boolean {
  return (
    left.revision === right.revision &&
    left.quotaMode === right.quotaMode &&
    left.capabilityMode === right.capabilityMode &&
    left.accessCodeIssuanceEnabled === right.accessCodeIssuanceEnabled &&
    left.accessCodeRedemptionEnabled === right.accessCodeRedemptionEnabled &&
    left.premiumPaymentsEnabled === right.premiumPaymentsEnabled &&
    left.updatedAt === right.updatedAt &&
    left.updatedBy === right.updatedBy &&
    left.reason === right.reason
  );
}

/**
 * Caches one validated config snapshot for 30 seconds and preserves it for at
 * most 15 minutes after its successful read. Invalid data is never translated
 * into `off`, because callers must be able to distinguish outage from policy.
 */
export class CommercialFlagsResolver {
  private lastGood: GoodSnapshot | undefined;
  private lastAttempt:
    | { readonly at: number; readonly result: CommercialConfigResult }
    | undefined;

  constructor(private readonly deps: CommercialFlagsResolverDeps) {}

  async resolve(): Promise<CommercialConfigResult> {
    const now = this.deps.now();
    const attemptAge = this.lastAttempt ? now - this.lastAttempt.at : Number.POSITIVE_INFINITY;

    if (this.lastAttempt && attemptAge >= 0 && attemptAge < CACHE_TTL_MS) {
      return this.resolveCached(now);
    }

    return this.refresh(now);
  }

  private resolveCached(now: number): CommercialConfigResult {
    if (
      this.lastGood &&
      now - this.lastGood.loadedAt > LAST_KNOWN_GOOD_TTL_MS
    ) {
      const expired: CommercialConfigResult = { status: 'unavailable', reason: 'expired' };
      if (
        this.lastAttempt?.result.status !== 'unavailable' ||
        this.lastAttempt.result.reason !== 'expired'
      ) {
        this.deps.emitMetric('CommercialConfigurationUnavailable');
      }
      this.lastAttempt = { at: now, result: expired };
      return expired;
    }

    const previous = this.lastAttempt!.result;
    if (previous.status === 'unavailable') return previous;
    if (previous.freshness === 'stale') return previous;

    return {
      status: 'available',
      freshness: 'cache',
      flags: previous.flags,
      loadedAt: previous.loadedAt,
    };
  }

  private async refresh(now: number): Promise<CommercialConfigResult> {
    let rawItem: unknown;
    try {
      rawItem = await this.deps.readItem();
    } catch {
      return this.useFallback(now, 'read-failed');
    }

    if (rawItem === undefined) return this.useFallback(now, 'missing');

    const parsed = parseFlagsItem(rawItem);
    if (!parsed) return this.useFallback(now, 'invalid');

    let driftDetected = parsed.paymentsDrift;
    if (this.lastGood) {
      const previous = this.lastGood.flags;
      const revisionRollback = parsed.flags.revision < previous.revision;
      const revisionReuse =
        parsed.flags.revision === previous.revision && !sameFlags(parsed.flags, previous);
      driftDetected ||= revisionRollback || revisionReuse;

      if (revisionRollback || revisionReuse) {
        if (driftDetected) this.deps.emitMetric('ConfigurationDrift');
        return this.useFallback(now, 'invalid');
      }
    }

    if (driftDetected) this.deps.emitMetric('ConfigurationDrift');

    const snapshot: GoodSnapshot = { flags: parsed.flags, loadedAt: now };
    const result: CommercialConfigResult = {
      status: 'available',
      freshness: 'fresh',
      flags: snapshot.flags,
      loadedAt: snapshot.loadedAt,
    };
    this.lastGood = snapshot;
    this.lastAttempt = { at: now, result };
    return result;
  }

  private useFallback(now: number, reason: Exclude<UnavailableReason, 'expired'>): CommercialConfigResult {
    if (this.lastGood && now - this.lastGood.loadedAt <= LAST_KNOWN_GOOD_TTL_MS) {
      const stale: CommercialConfigResult = {
        status: 'available',
        freshness: 'stale',
        flags: this.lastGood.flags,
        loadedAt: this.lastGood.loadedAt,
      };
      this.deps.emitMetric('CommercialConfigurationStale');
      this.lastAttempt = { at: now, result: stale };
      return stale;
    }

    const unavailable: CommercialConfigResult = {
      status: 'unavailable',
      reason: this.lastGood ? 'expired' : reason,
    };
    this.deps.emitMetric('CommercialConfigurationUnavailable');
    this.lastAttempt = { at: now, result: unavailable };
    return unavailable;
  }
}

/**
 * Returns null only for operations explicitly permitted during a config
 * outage. A null is not an `off` snapshot and must never be persisted as one.
 */
export function flagsForCommercialOperation(
  result: CommercialConfigResult,
  operation: CommercialOperation,
): CommercialFlags | null {
  if (result.status === 'available') return result.flags;

  const safe =
    operation.kind === 'read' ||
    (operation.kind === 'cloud-delta' &&
      Number.isFinite(operation.delta) &&
      operation.delta <= 0) ||
    (operation.kind === 'social' && SAFE_SOCIAL_ACTIONS.has(operation.action));

  if (safe) return null;
  throw new ApiError(CONFIGURATION_UNAVAILABLE_CODE);
}

/** Commercial kill switches always resolve false when config is unavailable. */
export function isCommercialSwitchEnabled(
  result: CommercialConfigResult,
  commercialSwitch: CommercialSwitch,
): boolean {
  if (result.status === 'unavailable') return false;
  if (commercialSwitch === 'issuance') return result.flags.accessCodeIssuanceEnabled;
  if (commercialSwitch === 'redemption') return result.flags.accessCodeRedemptionEnabled;
  return false;
}
