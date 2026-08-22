import type { Tree, TreeNode } from '@app/db/schema';

export interface OwnedNode {
  readonly ownerSub: string;
  readonly record: TreeNode;
}

export type HeartInvalidReason =
  | 'HEART_ID_MISSING'
  | 'HEART_NOT_FOUND'
  | 'HEART_OWNER_MISMATCH'
  | 'HEART_TREE_MISMATCH'
  | 'HEART_NOT_ROOT'
  | 'HEART_NOT_VISIBLE'
  | 'HEART_ID_CHANGED'
  | 'HEART_ID_REMOVED'
  | 'HEART_ID_LATE_ASSIGNMENT';

export type HeartInspection =
  | {
      readonly valid: true;
      readonly heart: TreeNode;
      readonly visible: boolean;
    }
  | {
      readonly valid: false;
      readonly reason: HeartInvalidReason;
      readonly treeId: string;
      readonly heartId: string | null;
    };

interface InspectHeartIdentityInput {
  readonly ownerSub: string;
  readonly tree: Tree;
  readonly nodes: readonly OwnedNode[];
  /** New active trees require a live heart; existing identity survives archive/tombstone. */
  readonly visibility?: 'identity' | 'required';
}

interface HeartTransitionBase {
  readonly ownerSub: string;
  readonly incomingTree: Tree;
  /** Exact owner-scoped node set resolved for this logical mutation. */
  readonly nodes: readonly OwnedNode[];
}

export type InspectHeartTransitionInput =
  | (HeartTransitionBase & {
      readonly kind: 'create';
    })
  | (HeartTransitionBase & {
      readonly kind: 'update';
      readonly previousTree: Tree;
    });

export function isVisibleNode(node: TreeNode): boolean {
  return node.deletedAt === null && node.archivedAt === null;
}

function invalid(
  input: InspectHeartIdentityInput,
  reason: HeartInvalidReason,
): HeartInspection {
  return {
    valid: false,
    reason,
    treeId: input.tree.id,
    heartId: input.tree.heartId ?? null,
  };
}

/**
 * Validates the immutable technical identity only; it never elects or repairs
 * a heart. Backfill selection remains a separate, one-time operation.
 */
function inspectHeartIdentity(input: InspectHeartIdentityInput): HeartInspection {
  const heartId = input.tree.heartId;
  if (typeof heartId !== 'string' || heartId.length === 0) {
    return invalid(input, 'HEART_ID_MISSING');
  }

  const candidates = input.nodes.filter(({ record }) => record.id === heartId);
  if (candidates.length === 0) return invalid(input, 'HEART_NOT_FOUND');
  const candidate = candidates.find(({ ownerSub }) => ownerSub === input.ownerSub);
  if (!candidate) return invalid(input, 'HEART_OWNER_MISMATCH');
  const heart = candidate.record;
  if (heart.treeId !== input.tree.id) return invalid(input, 'HEART_TREE_MISMATCH');
  if (heart.parentId !== null) return invalid(input, 'HEART_NOT_ROOT');

  const visible = isVisibleNode(heart);
  if (input.visibility === 'required' && !visible) {
    return invalid(input, 'HEART_NOT_VISIBLE');
  }
  return { valid: true, heart, visible };
}

/**
 * The sole mutation-facing heart authority. Creation proves a visible heart
 * is in the same logical set. Every later write proves the assigned id is
 * unchanged before accepting the same structural identity, even when that
 * heart is currently archived or tombstoned.
 */
export function inspectHeartTransition(
  input: InspectHeartTransitionInput,
): HeartInspection {
  const identityInput: InspectHeartIdentityInput = {
    ownerSub: input.ownerSub,
    tree: input.incomingTree,
    nodes: input.nodes,
    visibility: input.kind === 'create' ? 'required' : 'identity',
  };
  if (input.kind === 'create') return inspectHeartIdentity(identityInput);

  if (input.previousTree.id !== input.incomingTree.id) {
    throw new Error('previous and incoming trees must have the same id');
  }
  const previousHeartId = input.previousTree.heartId;
  const incomingHeartId = input.incomingTree.heartId;
  const previousAssigned =
    typeof previousHeartId === 'string' && previousHeartId.length > 0;
  const incomingAssigned =
    typeof incomingHeartId === 'string' && incomingHeartId.length > 0;

  if (!previousAssigned) {
    if (incomingAssigned) return invalid(identityInput, 'HEART_ID_LATE_ASSIGNMENT');
    return inspectHeartIdentity(identityInput);
  }
  if (!incomingAssigned) return invalid(identityInput, 'HEART_ID_REMOVED');
  if (incomingHeartId !== previousHeartId) {
    return invalid(identityInput, 'HEART_ID_CHANGED');
  }
  return inspectHeartIdentity(identityInput);
}

/** Exact node contribution to the latent per-tree counter. */
export function visibleBranchContribution(
  node: TreeNode,
  heart: HeartInspection,
): 0 | 1 {
  if (!isVisibleNode(node)) return 0;
  if (heart.valid && node.id === heart.heart.id) return 0;
  return 1;
}
