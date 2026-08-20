import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ApiError, LIMITS } from '@app/api/contracts';
import { accountClosureKey } from '../account-closure';
import { WRITABLE_PROFILE_CONDITION } from '../authz';
import { K, type ProfileItem } from '../db';
import type { AccessItem, GrantItem } from './model';
import { createAccessPutProposal, deriveAccessItem } from './access-resolver';
import {
  flagsForCommercialOperation,
  type CommercialConfigResult,
  type CommercialFlags,
} from './flags';
import type { UsageMutationDelta } from './usage';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export interface CommercialMutationSnapshot {
  readonly profile?: ProfileItem;
  readonly closure?: Readonly<Record<string, unknown>>;
  readonly access?: AccessItem;
  readonly grants: readonly GrantItem[];
  readonly flags: CommercialConfigResult;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly usageByTree: Readonly<
    Record<string, Readonly<Record<string, unknown>> | undefined>
  >;
  readonly migration?: Readonly<Record<string, unknown>>;
  readonly deltas: readonly UsageMutationDelta[];
}

export interface MutationCommitProposal {
  readonly ownerSub: string;
  readonly items: readonly TransactItem[];
  readonly deltas: readonly UsageMutationDelta[];
  readonly usage: 'compatible' | 'generation';
}

export interface CommercialDecision {
  readonly kind: 'quota' | 'cloudSync';
  readonly mode: 'off' | 'observe' | 'enforce';
  readonly wouldDeny: boolean;
}

export interface MutationWriteResult {
  readonly outcome: 'committed' | 'stale';
  readonly attempts: number;
  readonly usage: 'compatible' | 'generation';
  readonly deltas: readonly UsageMutationDelta[];
}

export interface MutationWriterDeps<TRequest extends { readonly ownerSub: string }> {
  readonly tableName: string;
  readonly now: () => number;
  readonly readSnapshot: (
    request: TRequest,
    options: { readonly consistentRead: true },
  ) => Promise<CommercialMutationSnapshot>;
  readonly resolveFreshAccess: (ownerSub: string) => Promise<AccessItem>;
  readonly commit: (
    request: TRequest,
    proposal: MutationCommitProposal,
  ) => Promise<'committed' | 'conflict'>;
  readonly emitDecision: (decision: CommercialDecision) => void;
}

export function usageMigrationKey(
  ownerSub: string,
): { pk: string; sk: 'USAGE_MIGRATION' } {
  return { pk: `USER#${ownerSub}`, sk: 'USAGE_MIGRATION' };
}

interface MigratedUsage {
  readonly generation: string;
  readonly activeTrees: number;
}

interface AggregatedTreeDelta {
  readonly treeId: string;
  physicalVisibleBranches: number;
  quotaVisibleBranches: number;
  createsCounter: boolean;
}

interface AggregatedUsageDelta {
  physicalActiveTrees: number;
  quotaActiveTrees: number;
  readonly trees: Map<string, AggregatedTreeDelta>;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLimit(value: unknown): value is number | null {
  return value === null || nonNegativeInteger(value);
}

function checkedSum(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new ApiError('VALIDATION', `${field} delta is unsafe`);
  return sum;
}

function aggregateDeltas(deltas: readonly UsageMutationDelta[]): AggregatedUsageDelta {
  const aggregate: AggregatedUsageDelta = {
    physicalActiveTrees: 0,
    quotaActiveTrees: 0,
    trees: new Map(),
  };
  for (const delta of deltas) {
    if (delta.outcome !== 'applied') continue;
    aggregate.physicalActiveTrees = checkedSum(
      aggregate.physicalActiveTrees,
      delta.physical.activeTrees,
      'activeTrees',
    );
    aggregate.quotaActiveTrees = checkedSum(
      aggregate.quotaActiveTrees,
      delta.quota.activeTrees,
      'quota activeTrees',
    );
    const tree = aggregate.trees.get(delta.treeId) ?? {
      treeId: delta.treeId,
      physicalVisibleBranches: 0,
      quotaVisibleBranches: 0,
      createsCounter: false,
    };
    tree.physicalVisibleBranches = checkedSum(
      tree.physicalVisibleBranches,
      delta.physical.visibleBranches,
      'visibleBranches',
    );
    tree.quotaVisibleBranches = checkedSum(
      tree.quotaVisibleBranches,
      delta.quota.visibleBranches,
      'quota visibleBranches',
    );
    tree.createsCounter ||=
      delta.recordWasNew &&
      delta.treeActivity === 'activate' &&
      delta.physical.activeTrees > 0;
    aggregate.trees.set(delta.treeId, tree);
  }
  return aggregate;
}

function migratedUsage(
  value: Readonly<Record<string, unknown>> | undefined,
  ownerSub: string,
): MigratedUsage | null {
  if (value === undefined) return null;

  const activeTrees = value['activeTrees'];
  if (
    value['pk'] !== K.user(ownerSub) ||
    value['sk'] !== 'USAGE' ||
    value['state'] !== 'active' ||
    !nonNegativeInteger(activeTrees)
  ) {
    throw new ApiError('CONFLICT', 'USAGE item is corrupt');
  }

  if (!Object.prototype.hasOwnProperty.call(value, 'activeGeneration')) return null;
  const generation = value['activeGeneration'];
  if (typeof generation !== 'string' || generation.trim().length === 0) {
    throw new ApiError('CONFLICT', 'USAGE activeGeneration is corrupt');
  }

  return { generation, activeTrees };
}

function visibleBranches(
  value: Readonly<Record<string, unknown>> | undefined,
  ownerSub: string,
  treeId: string,
  generation: string,
): number | null {
  const count = value?.['visibleBranches'];
  if (
    value?.['pk'] !== K.user(ownerSub) ||
    value?.['sk'] !== `USAGE#TREE#${treeId}` ||
    value?.['generation'] !== generation ||
    !nonNegativeInteger(count)
  ) {
    return null;
  }
  return count;
}

function assertWritableSnapshot(snapshot: CommercialMutationSnapshot, ownerSub: string): void {
  const profile = snapshot.profile;
  if (
    !profile ||
    profile.pk !== K.user(ownerSub) ||
    profile.sk !== 'PROFILE' ||
    profile.userId !== ownerSub ||
    (profile.status !== undefined && profile.status !== 'active') ||
    snapshot.closure !== undefined
  ) {
    throw new ApiError('CONFLICT', 'account closure is in progress');
  }
}

function profileGuard(tableName: string, ownerSub: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: K.profile(ownerSub),
      ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND userId = :ownerSub`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':ownerSub': ownerSub },
    },
  };
}

function closureGuard(tableName: string, ownerSub: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: accountClosureKey(ownerSub),
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

function migrationGuard(
  tableName: string,
  ownerSub: string,
  value: Readonly<Record<string, unknown>> | undefined,
  now: number,
): TransactItem {
  if (value === undefined) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: usageMigrationKey(ownerSub),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    };
  }

  const state = value['state'];
  const generation = value['generation'];
  const leaseUntil = value['leaseUntil'];
  if (
    value['pk'] !== K.user(ownerSub) ||
    value['sk'] !== 'USAGE_MIGRATION' ||
    typeof state !== 'string' ||
    state.trim().length === 0 ||
    typeof generation !== 'string' ||
    generation.trim().length === 0 ||
    !nonNegativeInteger(leaseUntil)
  ) {
    throw new ApiError(
      'USAGE_MIGRATION_IN_PROGRESS',
      'usage migration fence is malformed',
    );
  }
  if (state === 'migrating' && leaseUntil > now) {
    throw new ApiError('USAGE_MIGRATION_IN_PROGRESS');
  }

  return {
    ConditionCheck: {
      TableName: tableName,
      Key: usageMigrationKey(ownerSub),
      ConditionExpression:
        '#state = :migrationState AND generation = :migrationGeneration AND leaseUntil = :migrationLeaseUntil' +
        (state === 'migrating' ? ' AND leaseUntil <= :now' : ''),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':migrationState': state,
        ':migrationGeneration': generation,
        ':migrationLeaseUntil': leaseUntil,
        ...(state === 'migrating' ? { ':now': now } : {}),
      },
    },
  };
}

function accessGuard(tableName: string, access: AccessItem, now: number): TransactItem {
  const boundary = access.nextRecomputeAt;
  const boundaryCondition =
    boundary === null
      ? 'attribute_type(nextRecomputeAt, :nullType)'
      : 'nextRecomputeAt = :nextRecomputeAt AND nextRecomputeAt > :now';
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: K.user(access.ownerSub), sk: 'ACCESS' },
      ConditionExpression: `ownerSub = :ownerSub AND revision = :accessRevision AND #status = :accessStatus AND ${boundaryCondition}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':ownerSub': access.ownerSub,
        ':accessRevision': access.revision,
        ':accessStatus': 'active',
        ...(boundary === null
          ? { ':nullType': 'NULL' }
          : { ':nextRecomputeAt': boundary, ':now': now }),
      },
    },
  };
}

function assertCurrentAccess(access: AccessItem, ownerSub: string, now: number): void {
  const value: unknown = access;
  if (!isRecord(value)) throw new ApiError('ACCESS_REVISION_CONFLICT');

  const boundary = value['nextRecomputeAt'];
  const limits = value['limits'];
  const capabilities = value['capabilities'];
  const invalid =
    value['pk'] !== K.user(ownerSub) ||
    value['sk'] !== 'ACCESS' ||
    value['ownerSub'] !== ownerSub ||
    value['status'] !== 'active' ||
    !nonNegativeInteger(value['revision']) ||
    value['revision'] === 0 ||
    (boundary !== null && (!nonNegativeInteger(boundary) || boundary <= now)) ||
    !nonNegativeInteger(value['updatedAt']) ||
    value['updatedAt'] > now ||
    !nonNegativeInteger(value['offlineValidUntil']) ||
    value['offlineValidUntil'] <= now ||
    (boundary !== null && value['offlineValidUntil'] > boundary) ||
    !isRecord(limits) ||
    !isLimit(limits['maxActiveTrees']) ||
    !isLimit(limits['maxVisibleBranchesPerTree']) ||
    !isRecord(capabilities) ||
    typeof capabilities['cloudSync'] !== 'boolean' ||
    typeof capabilities['social'] !== 'boolean' ||
    capabilities['family'] !== false;
  if (invalid) {
    throw new ApiError(
      'ACCESS_REVISION_CONFLICT',
      'ACCESS could not be resolved to a current item',
    );
  }
}

function baseUsageGuard(
  tableName: string,
  ownerSub: string,
  usage: MigratedUsage,
): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: K.user(ownerSub), sk: 'USAGE' },
      ConditionExpression:
        '#state = :usageState AND activeGeneration = :activeGeneration AND activeTrees = :expectedActiveTrees',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':usageState': 'active',
        ':activeGeneration': usage.generation,
        ':expectedActiveTrees': usage.activeTrees,
      },
    },
  };
}

function baseUsageMutation(
  tableName: string,
  ownerSub: string,
  usage: MigratedUsage,
  activeTreesDelta: number,
): TransactItem {
  if (activeTreesDelta === 0) {
    return baseUsageGuard(tableName, ownerSub, usage);
  }
  return {
    Update: {
      TableName: tableName,
      Key: { pk: K.user(ownerSub), sk: 'USAGE' },
      UpdateExpression: 'ADD activeTrees :activeTreesDelta',
      ConditionExpression:
        '#state = :usageState AND activeGeneration = :activeGeneration AND activeTrees = :expectedActiveTrees',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':usageState': 'active',
        ':activeGeneration': usage.generation,
        ':expectedActiveTrees': usage.activeTrees,
        ':activeTreesDelta': activeTreesDelta,
      },
    },
  };
}

function quotaWouldDeny(
  access: AccessItem,
  usage: MigratedUsage,
  expectedVisibleBranches: ReadonlyMap<string, number>,
  aggregate: AggregatedUsageDelta,
): boolean {
  const activeTreeLimit = access.limits.maxActiveTrees;
  if (
    aggregate.quotaActiveTrees > 0 &&
    activeTreeLimit !== null &&
    usage.activeTrees + aggregate.quotaActiveTrees > activeTreeLimit
  ) {
    return true;
  }

  const branchLimit = access.limits.maxVisibleBranchesPerTree;
  if (branchLimit === null) return false;
  for (const tree of aggregate.trees.values()) {
    if (tree.quotaVisibleBranches <= 0) continue;
    const expected = expectedVisibleBranches.get(tree.treeId);
    // A restore's quota delta contains the whole latent count, which is
    // already represented by `expected`; only physical branch deltas change
    // the post-mutation per-tree count.
    if (expected !== undefined && expected + tree.physicalVisibleBranches > branchLimit) {
      return true;
    }
  }
  return false;
}

function emitQuotaDecision(
  emit: (decision: CommercialDecision) => void,
  flags: CommercialFlags,
  wouldDeny: boolean,
): void {
  emit({ kind: 'quota', mode: flags.quotaMode, wouldDeny });
  if (flags.quotaMode === 'enforce' && wouldDeny) {
    throw new ApiError('QUOTA_EXCEEDED');
  }
}

function hasCloudGrowth(deltas: readonly UsageMutationDelta[]): boolean {
  return deltas.some(
    (delta) =>
      delta.outcome === 'applied' &&
      (delta.recordWasNew ||
        delta.physical.activeTrees > 0 ||
        delta.physical.visibleBranches > 0 ||
        delta.quota.activeTrees > 0 ||
        delta.quota.visibleBranches > 0),
  );
}

function cloudDelta(deltas: readonly UsageMutationDelta[]): number {
  if (hasCloudGrowth(deltas)) return 1;
  return Math.min(
    0,
    deltas.reduce(
      (sum, delta) =>
        sum + delta.physical.activeTrees + delta.physical.visibleBranches,
      0,
    ),
  );
}

function applyCapabilityPolicy(
  emit: (decision: CommercialDecision) => void,
  result: CommercialConfigResult,
  access: AccessItem,
  deltas: readonly UsageMutationDelta[],
): CommercialFlags | null {
  const flags = flagsForCommercialOperation(result, {
    kind: 'cloud-delta',
    delta: cloudDelta(deltas),
  });
  if (!flags) return null;

  const wouldDeny = hasCloudGrowth(deltas) && !access.capabilities.cloudSync;
  emit({ kind: 'cloudSync', mode: flags.capabilityMode, wouldDeny });
  if (flags.capabilityMode === 'enforce' && wouldDeny) {
    throw new ApiError('CAPABILITY_REQUIRED');
  }
  return flags;
}

function treeUsageUpdate(
  tableName: string,
  ownerSub: string,
  tree: AggregatedTreeDelta,
  usage: MigratedUsage,
  expectedVisibleBranches: number,
): TransactItem {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: K.user(ownerSub), sk: `USAGE#TREE#${tree.treeId}` },
      UpdateExpression: 'ADD visibleBranches :visibleBranchesDelta',
      ConditionExpression:
        'generation = :activeGeneration AND visibleBranches = :expectedVisibleBranches',
      ExpressionAttributeValues: {
        ':activeGeneration': usage.generation,
        ':expectedVisibleBranches': expectedVisibleBranches,
        ':visibleBranchesDelta': tree.physicalVisibleBranches,
      },
    },
  };
}

function treeUsageGuard(
  tableName: string,
  ownerSub: string,
  treeId: string,
  usage: MigratedUsage,
  expectedVisibleBranches: number,
): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: K.user(ownerSub), sk: `USAGE#TREE#${treeId}` },
      ConditionExpression:
        'generation = :activeGeneration AND visibleBranches = :expectedVisibleBranches',
      ExpressionAttributeValues: {
        ':activeGeneration': usage.generation,
        ':expectedVisibleBranches': expectedVisibleBranches,
      },
    },
  };
}

function newTreeUsagePut(
  tableName: string,
  ownerSub: string,
  tree: AggregatedTreeDelta,
  usage: MigratedUsage,
): TransactItem {
  if (tree.physicalVisibleBranches < 0) {
    throw new ApiError('CONFLICT', 'new tree usage cannot be negative');
  }
  return {
    Put: {
      TableName: tableName,
      Item: {
        pk: K.user(ownerSub),
        sk: `USAGE#TREE#${tree.treeId}`,
        generation: usage.generation,
        visibleBranches: tree.physicalVisibleBranches,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export class CommercialMutationWriter<TRequest extends { readonly ownerSub: string }> {
  constructor(private readonly deps: MutationWriterDeps<TRequest>) {}

  async write(request: TRequest): Promise<MutationWriteResult> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await this.deps.readSnapshot(request, { consistentRead: true });
      assertWritableSnapshot(snapshot, request.ownerSub);
      if (
        snapshot.deltas.length === 0 ||
        snapshot.deltas.length > LIMITS.syncMutationGroupMax
      ) {
        throw new ApiError('MUTATION_GROUP_INVALID', 'mutation group size is invalid');
      }
      // LWW stale invalidates the entire atomic group, so no mutation remains
      // for a migration fence to serialize and no entitlement read is needed.
      if (snapshot.deltas.some((delta) => delta.outcome === 'stale')) {
        return {
          outcome: 'stale',
          attempts: attempt,
          usage: 'compatible',
          deltas: snapshot.deltas,
        };
      }
      const aggregate = aggregateDeltas(snapshot.deltas);

      const now = this.deps.now();
      const currentMigrationGuard = migrationGuard(
        this.deps.tableName,
        request.ownerSub,
        snapshot.migration,
        now,
      );
      const usage = migratedUsage(snapshot.usage, request.ownerSub);
      const access = snapshot.access
        ? await this.deps.resolveFreshAccess(request.ownerSub)
        : deriveAccessItem(request.ownerSub, now, undefined, snapshot.grants);
      assertCurrentAccess(access, request.ownerSub, now);
      const resolvedFlags = applyCapabilityPolicy(
        this.deps.emitDecision,
        snapshot.flags,
        access,
        snapshot.deltas,
      );

      const items: TransactItem[] = [
        profileGuard(this.deps.tableName, request.ownerSub),
        closureGuard(this.deps.tableName, request.ownerSub),
        currentMigrationGuard,
        ...(snapshot.access
          ? [accessGuard(this.deps.tableName, access, now)]
          : [createAccessPutProposal(this.deps.tableName, access, undefined)]),
      ];
      if (usage) {
        if (usage.activeTrees + aggregate.physicalActiveTrees < 0) {
          throw new ApiError('CONFLICT', 'active tree usage would become negative');
        }
        const expectedVisibleBranches = new Map<string, number>();
        const trees = [...aggregate.trees.values()].sort((left, right) =>
          left.treeId.localeCompare(right.treeId),
        );
        for (const tree of trees) {
          const expected = visibleBranches(
            snapshot.usageByTree[tree.treeId],
            request.ownerSub,
            tree.treeId,
            usage.generation,
          );
          if (tree.createsCounter) {
            expectedVisibleBranches.set(tree.treeId, 0);
          } else if (
            tree.physicalVisibleBranches !== 0 ||
            tree.quotaVisibleBranches !== 0
          ) {
            if (expected === null) throw new ApiError('CONFLICT', 'usage drift');
            expectedVisibleBranches.set(tree.treeId, expected);
          }
        }
        if (resolvedFlags) {
          emitQuotaDecision(
            this.deps.emitDecision,
            resolvedFlags,
            quotaWouldDeny(access, usage, expectedVisibleBranches, aggregate),
          );
        }
        items.push(
          baseUsageMutation(
            this.deps.tableName,
            request.ownerSub,
            usage,
            aggregate.physicalActiveTrees,
          ),
        );
        for (const tree of trees) {
          if (tree.createsCounter) {
            items.push(newTreeUsagePut(this.deps.tableName, request.ownerSub, tree, usage));
            continue;
          }
          const expected = expectedVisibleBranches.get(tree.treeId);
          if (tree.physicalVisibleBranches !== 0) {
            if (expected === undefined || expected + tree.physicalVisibleBranches < 0) {
              throw new ApiError('CONFLICT', 'tree usage would become invalid');
            }
            items.push(
              treeUsageUpdate(
                this.deps.tableName,
                request.ownerSub,
                tree,
                usage,
                expected,
              ),
            );
          } else if (tree.quotaVisibleBranches !== 0) {
            if (expected === undefined) throw new ApiError('CONFLICT', 'usage drift');
            items.push(
              treeUsageGuard(
                this.deps.tableName,
                request.ownerSub,
                tree.treeId,
                usage,
                expected,
              ),
            );
          }
        }
      }

      const proposal: MutationCommitProposal = {
        ownerSub: request.ownerSub,
        items,
        deltas: snapshot.deltas,
        usage: usage ? 'generation' : 'compatible',
      };
      const outcome = await this.deps.commit(request, proposal);
      if (outcome === 'committed') {
        return {
          outcome: 'committed',
          attempts: attempt,
          usage: proposal.usage,
          deltas: snapshot.deltas,
        };
      }
    }

    throw new ApiError('ACCESS_REVISION_CONFLICT');
  }
}
