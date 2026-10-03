import { ApiError, type AccessSource } from '@app/api/contracts';
import { LEGACY_PREPAYMENT_CATALOG, PREPAYMENT_CATALOG } from './catalog';
import type { CoverageAssignmentItem } from '../family/model';
import { assertFamilyIdentifier } from '../family/keys';
import {
  ACCESS_OFFLINE_LEASE_MS,
  accessKey,
  type AccessCapabilities,
  type AccessItem,
  type AccessLimits,
  type GrantItem,
  type SubscriptionSourceItem,
} from './model';

export interface PaidAccessSources {
  readonly subscription?: SubscriptionSourceItem;
  readonly coverage?: CoverageAssignmentItem;
  readonly ownerProfile?: { readonly accountType: 'adult' | 'minor'; readonly majorityAt?: string };
}

export interface AccessSnapshot extends PaidAccessSources {
  readonly access?: AccessItem;
  readonly grants: readonly GrantItem[];
}

export interface AccessPutProposal {
  readonly paidSources?: PaidAccessSources;
  readonly ownerProfile?: PaidAccessSources['ownerProfile'];
  readonly Put: {
    readonly TableName: string;
    readonly Item: AccessItem;
    readonly ConditionExpression: string;
    readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
  };
}

export type AccessMaterializationResult =
  | {
      readonly access: AccessItem;
      readonly materialization: 'not-required';
    }
  | {
      readonly access: AccessItem;
      readonly materialization: 'created' | 'refreshed';
      readonly proposal: AccessPutProposal;
    };

export interface AccessResolverDeps {
  readonly tableName: string;
  readonly now: () => number;
  /** Adapter must consistently read ACCESS, GRANT and both paid source items. */
  readonly readSnapshot: (
    ownerSub: string,
    options: { readonly consistentRead: true },
  ) => Promise<AccessSnapshot>;
  /** Adapter executes the conditional Put, normalizing a lost CAS to conflict. */
  readonly materializeAccess: (proposal: AccessPutProposal) => Promise<'committed' | 'conflict'>;
}

interface ActiveEntitlement {
  readonly limits: AccessLimits;
  readonly capabilities: AccessCapabilities;
  readonly source: AccessSource;
}

const MAX_MATERIALIZATION_ATTEMPTS = 2;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOpaqueIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    assertFamilyIdentifier(value, 'source identifier');
    return true;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRevision(value: unknown): value is number {
  return isTimestamp(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
}

function isLimit(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function hasExactLimits(value: unknown, expected: AccessLimits): value is AccessLimits {
  return (
    isRecord(value) &&
    isLimit(value['maxActiveTrees']) &&
    isLimit(value['maxVisibleBranchesPerTree']) &&
    value['maxActiveTrees'] === expected.maxActiveTrees &&
    value['maxVisibleBranchesPerTree'] === expected.maxVisibleBranchesPerTree
  );
}

function hasExactCapabilities(
  value: unknown,
  expected: AccessCapabilities,
): value is AccessCapabilities {
  return (
    isRecord(value) &&
    typeof value['cloudSync'] === 'boolean' &&
    typeof value['social'] === 'boolean' &&
    typeof value['family'] === 'boolean' &&
    value['cloudSync'] === expected.cloudSync &&
    value['social'] === expected.social &&
    value['family'] === expected.family
  );
}

function grantPlan(value: unknown): 'free' | 'premium' | null {
  return value === 'free' || value === 'premium' ? value : null;
}

function belongsToOwner(grant: GrantItem, ownerSub: string): boolean {
  return (
    grant.ownerSub === ownerSub &&
    grant.pk === `USER#${ownerSub}` &&
    grant.sk === `GRANT#${grant.grantId}`
  );
}

function isValidGrantItem(grant: GrantItem, ownerSub: string, now: number): boolean {
  if (!isRecord(grant)) return false;
  const planKey = grantPlan(grant.planKey);
  if (!planKey) return false;
  const catalog =
    grant.catalogVersion === PREPAYMENT_CATALOG.version
      ? PREPAYMENT_CATALOG
      : grant.catalogVersion === LEGACY_PREPAYMENT_CATALOG.version
        ? LEGACY_PREPAYMENT_CATALOG
        : null;
  if (!catalog) return false;
  const plan = catalog.plans[planKey];
  if (
    !belongsToOwner(grant, ownerSub) ||
    !isNonBlank(grant.grantId) ||
    (grant.sourceKind !== 'sponsored' && grant.sourceKind !== 'legacy_beta') ||
    (grant.status !== 'active' && grant.status !== 'revoked') ||
    !isRevision(grant.revision) ||
    !isNonBlank(grant.reason) ||
    !isTimestamp(grant.createdAt) ||
    !isTimestamp(grant.updatedAt) ||
    grant.createdAt > grant.updatedAt ||
    grant.updatedAt > now ||
    !hasExactLimits(grant.limits, plan.limits) ||
    !hasExactCapabilities(grant.capabilities, plan.capabilities)
  ) {
    return false;
  }

  if (
    grant.sourceKind === 'legacy_beta' &&
    (grant.grantId !== 'legacy_beta' ||
      grant.planKey !== 'premium' ||
      grant.expiresAt !== null ||
      grant.reason !== 'preserve_precommercial_access')
  ) {
    return false;
  }

  if (grant.status === 'active' && grant.revokedAt !== undefined) return false;
  if (
    grant.status === 'revoked' &&
    (!isTimestamp(grant.revokedAt) || grant.revokedAt < grant.createdAt || grant.revokedAt > now)
  ) {
    return false;
  }

  return (
    isTimestamp(grant.startsAt) &&
    (grant.expiresAt === null || (isTimestamp(grant.expiresAt) && grant.expiresAt > grant.startsAt))
  );
}

function isActiveGrant(grant: GrantItem, ownerSub: string, now: number): boolean {
  return (
    isValidGrantItem(grant, ownerSub, now) &&
    grant.status === 'active' &&
    grant.startsAt <= now &&
    (grant.expiresAt === null || now < grant.expiresAt)
  );
}

function nextBoundary(grants: readonly GrantItem[], ownerSub: string, now: number): number | null {
  let boundary: number | null = null;
  for (const grant of grants) {
    if (!isValidGrantItem(grant, ownerSub, now) || grant.status !== 'active') {
      continue;
    }

    const candidate = grant.startsAt > now ? grant.startsAt : grant.expiresAt;
    if (candidate !== null && candidate > now && (boundary === null || candidate < boundary)) {
      boundary = candidate;
    }
  }
  return boundary;
}

function maximumLimit(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.max(left, right);
}

function combineLimits(active: readonly ActiveEntitlement[]): AccessLimits {
  const [first, ...rest] = active;
  if (!first) return { ...PREPAYMENT_CATALOG.plans.free.limits };

  return rest.reduce<AccessLimits>(
    (combined, entry) => ({
      maxActiveTrees: maximumLimit(combined.maxActiveTrees, entry.limits.maxActiveTrees),
      maxVisibleBranchesPerTree: maximumLimit(
        combined.maxVisibleBranchesPerTree,
        entry.limits.maxVisibleBranchesPerTree,
      ),
    }),
    { ...first.limits },
  );
}

function combineCapabilities(active: readonly ActiveEntitlement[]): AccessCapabilities {
  if (active.length === 0) return { ...PREPAYMENT_CATALOG.plans.free.capabilities };

  return active.reduce<AccessCapabilities>(
    (combined, entry) => ({
      cloudSync: combined.cloudSync || entry.capabilities.cloudSync,
      social: combined.social || entry.capabilities.social,
      family: combined.family || entry.capabilities.family,
    }),
    { cloudSync: false, social: false, family: false },
  );
}

/** No inferred grace: only a persisted grace state can extend paidThrough. */
function paidBoundary(value: unknown, now: number): number | null {
  if (
    !isRecord(value) ||
    !isRevision(value['revision']) ||
    !isTimestamp(value['updatedAt']) ||
    value['updatedAt'] > now ||
    !isTimestamp(value['paidThrough'])
  )
    return null;
  if (value['state'] === 'grace') {
    return isTimestamp(value['graceUntil']) &&
      value['graceUntil'] > value['paidThrough'] &&
      value['graceUntil'] > now
      ? value['graceUntil']
      : null;
  }
  return (value['state'] === 'active' || value['state'] === 'scheduled_end') &&
    value['graceUntil'] === null &&
    value['paidThrough'] > now
    ? value['paidThrough']
    : null;
}

function paidEntitlements(
  ownerSub: string,
  now: number,
  sources: PaidAccessSources,
): ActiveEntitlement[] {
  const active: ActiveEntitlement[] = [];
  const plan = PREPAYMENT_CATALOG.plans.premium;
  const individual = sources.subscription;
  const individualUntil = paidBoundary(individual, now);
  if (
    individualUntil !== null &&
    individual &&
    individual.pk === `USER#${ownerSub}` &&
    individual.sk === 'SUBSCRIPTION#INDIVIDUAL' &&
    individual.entityType === 'SubscriptionSource' &&
    individual.ownerSub === ownerSub &&
    isOpaqueIdentifier(individual.sourceId)
  ) {
    active.push({
      ...plan,
      source: {
        kind: 'subscription',
        scope: 'individual',
        sourceId: individual.sourceId,
        planKey: 'premium',
        validUntil: individualUntil,
      },
    });
  }
  const family = sources.coverage;
  const pilotMajority = family?.seatType === 'minor' && sources.ownerProfile?.accountType === 'minor'
    && typeof sources.ownerProfile.majorityAt === 'string'
    ? Date.parse(`${sources.ownerProfile.majorityAt}T00:00:00.000Z`) : null;
  const pilot = family?.source === 'sponsored_pilot' &&
    family.state === 'active' && family.paidThrough === null &&
    (family.seatType !== 'minor' ||
      (pilotMajority !== null && Number.isFinite(pilotMajority) && pilotMajority > now));
  const familyUntil = family?.source === 'sponsored_pilot' ? null : paidBoundary(family, now);
  if (
    (pilot || familyUntil !== null) &&
    family &&
    family.pk === `USER#${ownerSub}` &&
    family.sk === 'COVERAGE#FAMILY' &&
    family.entityType === 'CoverageAssignment' &&
    family.accountId === ownerSub &&
    isOpaqueIdentifier(family.householdId) &&
    ['primary_responsible', 'minor', 'additional_responsible'].includes(family.seatType)
  ) {
    active.push({
      limits: plan.limits,
      capabilities: { ...plan.capabilities, family: true },
      source: {
        kind: pilot ? 'sponsored' : 'subscription',
        scope: 'family_member',
        sourceId: `family:${family.householdId}:${ownerSub}`,
        householdId: family.householdId,
        seatType: family.seatType,
        planKey: 'premium',
        validUntil: pilot ? pilotMajority : familyUntil,
      },
    });
  }
  return active;
}

/** Pure derivation used by readers, backfill and conditional writers. */
export function deriveAccessItem(
  ownerSub: string,
  now: number,
  previous: AccessItem | undefined,
  grants: readonly GrantItem[],
  sources: PaidAccessSources = {},
): AccessItem {
  const key = accessKey(ownerSub);
  const active: ActiveEntitlement[] = grants
    .filter((grant) => isActiveGrant(grant, ownerSub, now))
    .map<ActiveEntitlement>((grant) => ({
      limits: grant.limits,
      capabilities: grant.capabilities,
      source: {
        kind: 'sponsored',
        sourceId: grant.grantId,
        planKey: grant.planKey,
        validUntil: grant.expiresAt,
      },
    }));
  active.push(...paidEntitlements(ownerSub, now, sources));
  active.sort(
    (left, right) =>
      left.source.kind.localeCompare(right.source.kind) ||
      left.source.sourceId.localeCompare(right.source.sourceId),
  );
  const boundaries = [
    nextBoundary(grants, ownerSub, now),
    ...active.map(({ source }) => source.validUntil),
  ].filter((value): value is number => value !== null && value > now);
  const boundary = boundaries.length ? Math.min(...boundaries) : null;
  const activeSources: AccessSource[] = active.length
    ? active.map(({ source }) => source)
    : [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }];
  const effectivePlanKey = active.some(({ source }) => source.planKey === 'premium')
    ? 'premium'
    : 'free';
  const previousRevision =
    isRecord(previous) &&
    previous.ownerSub === ownerSub &&
    previous.pk === key.pk &&
    previous.sk === key.sk &&
    isRevision(previous.revision)
      ? previous.revision
      : 0;

  return {
    ...key,
    ownerSub,
    effectivePlanKey,
    catalogVersion: PREPAYMENT_CATALOG.version,
    status: 'active',
    activeSources,
    limits: combineLimits(active),
    capabilities: combineCapabilities(active),
    revision: previousRevision + 1,
    nextRecomputeAt: boundary,
    offlineValidUntil: Math.min(
      now + ACCESS_OFFLINE_LEASE_MS,
      boundary ?? Number.POSITIVE_INFINITY,
    ),
    updatedAt: now,
  };
}

function sameSources(left: unknown, right: readonly AccessSource[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((source, index) => {
    if (!isRecord(source)) return false;
    const expected = right[index];
    return (
      source['kind'] === expected.kind &&
      source['sourceId'] === expected.sourceId &&
      source['planKey'] === expected.planKey &&
      source['validUntil'] === expected.validUntil &&
      source['scope'] === expected.scope &&
      source['householdId'] === expected.householdId &&
      source['seatType'] === expected.seatType
    );
  });
}

function isFresh(
  access: AccessItem | undefined,
  ownerSub: string,
  now: number,
  grants: readonly GrantItem[],
  sources: PaidAccessSources,
): access is AccessItem {
  if (!isRecord(access)) return false;
  const key = accessKey(ownerSub);
  if (
    access.ownerSub !== ownerSub ||
    access.pk !== key.pk ||
    access.sk !== key.sk ||
    access.catalogVersion !== PREPAYMENT_CATALOG.version ||
    access.status !== 'active' ||
    !isRevision(access.revision) ||
    !isTimestamp(access.updatedAt) ||
    access.updatedAt > now ||
    (access.nextRecomputeAt !== null &&
      (!isTimestamp(access.nextRecomputeAt) || access.nextRecomputeAt <= now)) ||
    !isTimestamp(access.offlineValidUntil) ||
    access.offlineValidUntil <= now ||
    access.offlineValidUntil > access.updatedAt + ACCESS_OFFLINE_LEASE_MS ||
    (access.nextRecomputeAt !== null && access.offlineValidUntil > access.nextRecomputeAt)
  ) {
    return false;
  }

  const canonical = deriveAccessItem(ownerSub, now, access, grants, sources);
  return (
    access.effectivePlanKey === canonical.effectivePlanKey &&
    access.nextRecomputeAt === canonical.nextRecomputeAt &&
    sameSources(access.activeSources, canonical.activeSources) &&
    hasExactLimits(access.limits, canonical.limits) &&
    hasExactCapabilities(access.capabilities, canonical.capabilities)
  );
}

export function createAccessPutProposal(
  tableName: string,
  item: AccessItem,
  previous: AccessItem | undefined,
  sources?: PaidAccessSources,
): AccessPutProposal {
  const metadata = sources
    ? {
        paidSources: {
          ...(sources.subscription ? { subscription: sources.subscription } : {}),
          ...(sources.coverage ? { coverage: sources.coverage } : {}),
        },
        ...(sources.ownerProfile ? { ownerProfile: sources.ownerProfile } : {}),
      }
    : {};
  if (!previous) {
    return {
      ...metadata,
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    };
  }

  const previousRecord = isRecord(previous) ? previous : undefined;
  if (!previousRecord || !Object.prototype.hasOwnProperty.call(previousRecord, 'revision')) {
    return {
      ...metadata,
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression:
          'attribute_exists(pk) AND attribute_exists(sk) AND attribute_not_exists(revision)',
      },
    };
  }

  return {
    ...metadata,
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': previousRecord['revision'] },
    },
  };
}

export class AccessResolver {
  constructor(private readonly deps: AccessResolverDeps) {}

  async resolveFresh(ownerSub: string): Promise<AccessMaterializationResult> {
    for (let attempt = 0; attempt < MAX_MATERIALIZATION_ATTEMPTS; attempt += 1) {
      const now = this.deps.now();
      const snapshot = await this.deps.readSnapshot(ownerSub, { consistentRead: true });
      if (isFresh(snapshot.access, ownerSub, now, snapshot.grants, snapshot)) {
        return { access: snapshot.access, materialization: 'not-required' };
      }

      const previous = snapshot.access;
      const access = deriveAccessItem(ownerSub, now, previous, snapshot.grants, snapshot);
      const proposal = createAccessPutProposal(this.deps.tableName, access, previous, snapshot);
      const outcome = await this.deps.materializeAccess(proposal);
      if (outcome === 'committed') {
        return {
          access,
          materialization: previous ? 'refreshed' : 'created',
          proposal,
        };
      }
    }

    throw new ApiError('ACCESS_REVISION_CONFLICT', 'Access changed while it was being refreshed');
  }
}
