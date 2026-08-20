import { lwwBeats } from '@app/api/contracts';
import type { Tree, TreeNode } from '@app/db/schema';
import {
  visibleBranchContribution,
  type HeartInspection,
  type HeartInvalidReason,
} from './heart';

export interface UsageCounterDelta {
  /** Physical delta applied to USER#owner / USAGE.activeTrees. */
  readonly activeTrees: number;
  /** Physical or consumed delta for USER#owner / USAGE#TREE#treeId. */
  readonly visibleBranches: number;
}

export type TreeActivityDelta = 'activate' | 'deactivate' | 'unchanged';

/**
 * `physical` keeps materialized counters exact. `quota` describes only the
 * active usage consumed by the same mutation. They intentionally differ for
 * node mutations under inactive trees and for tree archive/restore.
 */
export interface UsageMutationDelta {
  readonly outcome: 'applied' | 'stale';
  readonly treeId: string;
  readonly recordWasNew: boolean;
  /** Set by the persistence adapter; avoids inferring counter ownership from deltas. */
  readonly treeCounter?: 'create' | 'existing';
  readonly physical: UsageCounterDelta;
  readonly quota: UsageCounterDelta;
  readonly treeActivity: TreeActivityDelta;
  /** Invalid identity never causes an arbitrary root to be excluded. */
  readonly heartDrift?: HeartInvalidReason;
}

export interface TreeUsageMutationInput {
  readonly previous?: Tree;
  readonly incoming: Tree;
  /** Latent per-tree count; retained while the tree is inactive. */
  readonly latentVisibleBranches: number;
}

export interface NodeUsageMutationInput {
  readonly previous?: TreeNode;
  readonly incoming: TreeNode;
  readonly tree: Tree;
  readonly heart: HeartInspection;
}

const ZERO = Object.freeze({ activeTrees: 0, visibleBranches: 0 });

export function isActiveTree(tree: Tree): boolean {
  return tree.deletedAt === null && tree.archivedAt === null;
}

function stale(treeId: string): UsageMutationDelta {
  return {
    outcome: 'stale',
    treeId,
    recordWasNew: false,
    physical: { ...ZERO },
    quota: { ...ZERO },
    treeActivity: 'unchanged',
  };
}

function ensureSameRecord(
  previous: { readonly id: string } | undefined,
  incoming: { readonly id: string },
): void {
  if (previous && previous.id !== incoming.id) {
    throw new Error('previous and incoming must describe the same record');
  }
}

function shouldApply(
  previous: { readonly rev: number; readonly updatedAt: number } | undefined,
  incoming: { readonly rev: number; readonly updatedAt: number },
): boolean {
  return previous === undefined || lwwBeats(incoming, previous);
}

function checkedLatentCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('latentVisibleBranches must be a non-negative safe integer');
  }
  return value;
}

export function evaluateTreeUsageMutation(
  input: TreeUsageMutationInput,
): UsageMutationDelta {
  ensureSameRecord(input.previous, input.incoming);
  if (!shouldApply(input.previous, input.incoming)) return stale(input.incoming.id);

  const latentVisibleBranches = checkedLatentCount(input.latentVisibleBranches);
  const beforeActive = input.previous ? isActiveTree(input.previous) : false;
  const afterActive = isActiveTree(input.incoming);
  const activityDelta = Number(afterActive) - Number(beforeActive);
  const treeActivity: TreeActivityDelta =
    activityDelta > 0 ? 'activate' : activityDelta < 0 ? 'deactivate' : 'unchanged';

  return {
    outcome: 'applied',
    treeId: input.incoming.id,
    recordWasNew: input.previous === undefined,
    physical: { activeTrees: activityDelta, visibleBranches: 0 },
    quota: {
      activeTrees: activityDelta,
      visibleBranches: activityDelta * latentVisibleBranches,
    },
    treeActivity,
  };
}

export function evaluateNodeUsageMutation(
  input: NodeUsageMutationInput,
): UsageMutationDelta {
  ensureSameRecord(input.previous, input.incoming);
  if (input.incoming.treeId !== input.tree.id) {
    throw new Error('incoming node must belong to the supplied tree');
  }
  if (input.previous && input.previous.treeId !== input.incoming.treeId) {
    throw new Error('node treeId is immutable');
  }
  if (!shouldApply(input.previous, input.incoming)) return stale(input.incoming.treeId);

  const before = input.previous
    ? visibleBranchContribution(input.previous, input.heart)
    : 0;
  const after = visibleBranchContribution(input.incoming, input.heart);
  const visibleBranches = after - before;
  const delta: UsageMutationDelta = {
    outcome: 'applied',
    treeId: input.incoming.treeId,
    recordWasNew: input.previous === undefined,
    physical: { activeTrees: 0, visibleBranches },
    quota: {
      activeTrees: 0,
      visibleBranches: isActiveTree(input.tree) ? visibleBranches : 0,
    },
    treeActivity: 'unchanged',
    ...(!input.heart.valid ? { heartDrift: input.heart.reason } : {}),
  };
  return delta;
}

export function hasQuotaGrowth(delta: UsageMutationDelta): boolean {
  return delta.quota.activeTrees > 0 || delta.quota.visibleBranches > 0;
}
