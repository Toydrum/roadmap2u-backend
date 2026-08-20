import { describe, expect, it } from 'vitest';
import type { Tree, TreeNode } from '../shared/db/schema';
import {
  inspectHeartTransition,
  visibleBranchContribution,
  type OwnedNode,
} from '../lambda/commercial/heart';
import {
  evaluateNodeUsageMutation,
  evaluateTreeUsageMutation,
  hasQuotaGrowth,
  type UsageMutationDelta,
} from '../lambda/commercial/usage';

const NOW = Date.UTC(2026, 7, 19, 18, 0, 0);
const OWNER = 'adult-1';

function tree(id = 'tree-1', overrides: Partial<Tree> = {}): Tree {
  return {
    id,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: `${id}-heart`,
    heartId: `${id}-heart`,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    ...overrides,
  };
}

function node(
  id: string,
  treeId = 'tree-1',
  overrides: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    treeId,
    parentId: null,
    title: id,
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    ...overrides,
  };
}

function owned(record: TreeNode, ownerSub = OWNER): OwnedNode {
  return { ownerSub, record };
}

describe('commercial heart identity', () => {
  it.each([
    ['missing id', tree('tree-1', { heartId: null }), [], 'HEART_ID_MISSING'],
    ['missing record', tree(), [owned(node('another-root'))], 'HEART_NOT_FOUND'],
    [
      'foreign owner',
      tree(),
      [owned(node('tree-1-heart'), 'other-owner')],
      'HEART_OWNER_MISMATCH',
    ],
    [
      'foreign tree',
      tree(),
      [owned(node('tree-1-heart', 'tree-2'))],
      'HEART_TREE_MISMATCH',
    ],
    [
      'non-root node',
      tree(),
      [owned(node('tree-1-heart', 'tree-1', { parentId: 'parent' }))],
      'HEART_NOT_ROOT',
    ],
  ] as const)('rejects a %s and never chooses a replacement root', (_label, item, nodes, reason) => {
    expect(
      inspectHeartTransition({
        kind: 'update',
        ownerSub: OWNER,
        previousTree: item,
        incomingTree: item,
        nodes,
      }),
    ).toEqual({
      valid: false,
      reason,
      treeId: item.id,
      heartId: item.heartId,
    });
  });

  it.each([
    ['tombstoned', { deletedAt: NOW }],
    ['archived', { archivedAt: NOW }],
  ])('preserves a structurally valid %s heart identity on an existing tree', (_label, change) => {
    const heart = node('tree-1-heart', 'tree-1', change);

    expect(
      inspectHeartTransition({
        kind: 'update',
        ownerSub: OWNER,
        previousTree: tree(),
        incomingTree: tree(),
        nodes: [owned(heart)],
      }),
    ).toEqual({
      valid: true,
      heart,
      visible: false,
    });
    expect(
      inspectHeartTransition({
        kind: 'create',
        ownerSub: OWNER,
        incomingTree: tree(),
        nodes: [owned(heart)],
      }),
    ).toEqual({
      valid: false,
      reason: 'HEART_NOT_VISIBLE',
      treeId: 'tree-1',
      heartId: 'tree-1-heart',
    });
  });

  it('excludes exactly heartId while additional visible roots remain branches', () => {
    const heart = node('tree-1-heart');
    const extraRoot = node('extra-root');
    const child = node('child', 'tree-1', { parentId: 'extra-root' });
    const result = inspectHeartTransition({
      kind: 'update',
      ownerSub: OWNER,
      previousTree: tree(),
      incomingTree: tree(),
      nodes: [owned(extraRoot), owned(heart), owned(child)],
    });

    expect(result).toMatchObject({ valid: true, heart: { id: 'tree-1-heart' } });
    expect(visibleBranchContribution(heart, result)).toBe(0);
    expect(visibleBranchContribution(extraRoot, result)).toBe(1);
    expect(visibleBranchContribution(child, result)).toBe(1);
  });

  it.each([
    ['tombstoned branch', { deletedAt: NOW }],
    ['archived branch', { archivedAt: NOW }],
  ])('does not count a %s', (_label, change) => {
    const result = inspectHeartTransition({
      kind: 'update',
      ownerSub: OWNER,
      previousTree: tree(),
      incomingTree: tree(),
      nodes: [owned(node('tree-1-heart'))],
    });

    expect(visibleBranchContribution(node('branch', 'tree-1', change), result)).toBe(0);
  });
});

describe('commercial heart transition authority', () => {
  it.each([
    ['missing id', tree('tree-1', { heartId: null }), [], 'HEART_ID_MISSING'],
    ['missing candidate', tree(), [owned(node('another-root'))], 'HEART_NOT_FOUND'],
    [
      'foreign owner',
      tree(),
      [owned(node('tree-1-heart'), 'other-owner')],
      'HEART_OWNER_MISMATCH',
    ],
    [
      'foreign tree',
      tree(),
      [owned(node('tree-1-heart', 'tree-2'))],
      'HEART_TREE_MISMATCH',
    ],
    [
      'non-root candidate',
      tree(),
      [owned(node('tree-1-heart', 'tree-1', { parentId: 'parent' }))],
      'HEART_NOT_ROOT',
    ],
    [
      'tombstoned candidate',
      tree(),
      [owned(node('tree-1-heart', 'tree-1', { deletedAt: NOW }))],
      'HEART_NOT_VISIBLE',
    ],
    [
      'archived candidate',
      tree(),
      [owned(node('tree-1-heart', 'tree-1', { archivedAt: NOW }))],
      'HEART_NOT_VISIBLE',
    ],
  ] as const)(
    'rejects creation with a %s',
    (_label, incomingTree, nodes, reason) => {
      expect(
        inspectHeartTransition({ kind: 'create', ownerSub: OWNER, incomingTree, nodes }),
      ).toEqual({
        valid: false,
        reason,
        treeId: incomingTree.id,
        heartId: incomingTree.heartId,
      });
    },
  );

  it('accepts creation only when the visible heart is present in the supplied set', () => {
    const heart = node('tree-1-heart');

    expect(
      inspectHeartTransition({
        kind: 'create',
        ownerSub: OWNER,
        incomingTree: tree(),
        nodes: [owned(heart), owned(node('extra-root'))],
      }),
    ).toEqual({ valid: true, heart, visible: true });
  });

  it.each([
    [
      'change',
      tree('tree-1', { heartId: 'old-heart' }),
      tree('tree-1', { heartId: 'new-heart', rev: 2, updatedAt: NOW + 1 }),
      'HEART_ID_CHANGED',
    ],
    [
      'removal',
      tree('tree-1', { heartId: 'old-heart' }),
      tree('tree-1', { heartId: null, rev: 2, updatedAt: NOW + 1 }),
      'HEART_ID_REMOVED',
    ],
    [
      'late assignment after cutover',
      tree('tree-1', { heartId: null }),
      tree('tree-1', { heartId: 'new-heart', rev: 2, updatedAt: NOW + 1 }),
      'HEART_ID_LATE_ASSIGNMENT',
    ],
  ] as const)(
    'rejects heartId %s before considering a replacement candidate',
    (_label, previousTree, incomingTree, reason) => {
      expect(
        inspectHeartTransition({
          kind: 'update',
          ownerSub: OWNER,
          previousTree,
          incomingTree,
          nodes: [owned(node('new-heart'))],
        }),
      ).toEqual({
        valid: false,
        reason,
        treeId: 'tree-1',
        heartId: incomingTree.heartId,
      });
    },
  );

  it.each([
    ['tombstoned', { deletedAt: NOW }],
    ['archived', { archivedAt: NOW }],
  ])('keeps the same %s heart valid on a later write', (_label, change) => {
    const heart = node('tree-1-heart', 'tree-1', change);

    expect(
      inspectHeartTransition({
        kind: 'update',
        ownerSub: OWNER,
        previousTree: tree(),
        incomingTree: tree('tree-1', { rev: 2, updatedAt: NOW + 1 }),
        nodes: [owned(heart)],
      }),
    ).toEqual({ valid: true, heart, visible: false });
  });
});

function applied(
  treeId: string,
  physicalActiveTrees: number,
  physicalVisibleBranches: number,
  quotaActiveTrees: number,
  quotaVisibleBranches: number,
  treeActivity: 'activate' | 'deactivate' | 'unchanged',
  recordWasNew = false,
): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId,
    recordWasNew,
    physical: {
      activeTrees: physicalActiveTrees,
      visibleBranches: physicalVisibleBranches,
    },
    quota: {
      activeTrees: quotaActiveTrees,
      visibleBranches: quotaVisibleBranches,
    },
    treeActivity,
  };
}

const STALE: UsageMutationDelta = {
  outcome: 'stale',
  treeId: 'tree-1',
  recordWasNew: false,
  physical: { activeTrees: 0, visibleBranches: 0 },
  quota: { activeTrees: 0, visibleBranches: 0 },
  treeActivity: 'unchanged',
};

describe('tree usage delta table', () => {
  it.each([
    [
      'create active',
      undefined,
      tree(),
      0,
      applied('tree-1', 1, 0, 1, 0, 'activate', true),
    ],
    [
      'create archived',
      undefined,
      tree('tree-1', { archivedAt: NOW }),
      4,
      applied('tree-1', 0, 0, 0, 0, 'unchanged', true),
    ],
    [
      'archive active',
      tree(),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1, archivedAt: NOW + 1 }),
      7,
      applied('tree-1', -1, 0, -1, -7, 'deactivate'),
    ],
    [
      'tombstone active',
      tree(),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1, deletedAt: NOW + 1 }),
      7,
      applied('tree-1', -1, 0, -1, -7, 'deactivate'),
    ],
    [
      'restore archived',
      tree('tree-1', { archivedAt: NOW }),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1 }),
      7,
      applied('tree-1', 1, 0, 1, 7, 'activate'),
    ],
    [
      'restore tombstoned',
      tree('tree-1', { deletedAt: NOW }),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1 }),
      7,
      applied('tree-1', 1, 0, 1, 7, 'activate'),
    ],
    [
      'edit active',
      tree(),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1, name: 'renamed' }),
      7,
      applied('tree-1', 0, 0, 0, 0, 'unchanged'),
    ],
    [
      'inactive state change',
      tree('tree-1', { archivedAt: NOW }),
      tree('tree-1', { rev: 2, updatedAt: NOW + 1, archivedAt: NOW, deletedAt: NOW + 1 }),
      7,
      applied('tree-1', 0, 0, 0, 0, 'unchanged'),
    ],
  ] as const)(
    '%s produces separate physical and active-quota effects',
    (_label, previous, incoming, latentVisibleBranches, expected) => {
      expect(
        evaluateTreeUsageMutation({ previous, incoming, latentVisibleBranches }),
      ).toEqual(expected);
    },
  );

  it.each([
    [
      'lower revision with newer timestamp',
      tree('tree-1', { rev: 3, updatedAt: NOW }),
      tree('tree-1', { rev: 2, updatedAt: NOW + 10, archivedAt: NOW + 10 }),
    ],
    [
      'same revision and timestamp',
      tree(),
      tree('tree-1', { archivedAt: NOW }),
    ],
    [
      'same revision with older timestamp',
      tree('tree-1', { updatedAt: NOW + 10 }),
      tree('tree-1', { updatedAt: NOW, archivedAt: NOW }),
    ],
  ])('returns an exact zero delta for stale LWW: %s', (_label, previous, incoming) => {
    expect(
      evaluateTreeUsageMutation({ previous, incoming, latentVisibleBranches: 10 }),
    ).toEqual(STALE);
  });

  it('lets a higher revision win even when its timestamp is older', () => {
    const previous = tree('tree-1', { rev: 2, updatedAt: NOW + 10 });
    const incoming = tree('tree-1', { rev: 3, updatedAt: NOW, archivedAt: NOW });

    expect(
      evaluateTreeUsageMutation({ previous, incoming, latentVisibleBranches: 3 }),
    ).toEqual(applied('tree-1', -1, 0, -1, -3, 'deactivate'));
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the invalid latent branch count %s instead of corrupting counters',
    (latentVisibleBranches) => {
      expect(() =>
        evaluateTreeUsageMutation({
          previous: tree('tree-1', { archivedAt: NOW }),
          incoming: tree('tree-1', { rev: 2, updatedAt: NOW + 1 }),
          latentVisibleBranches,
        }),
      ).toThrow('latentVisibleBranches must be a non-negative safe integer');
    },
  );

  it('does not inspect an invalid latent counter when the LWW write is stale', () => {
    expect(
      evaluateTreeUsageMutation({
        previous: tree('tree-1', { rev: 2 }),
        incoming: tree('tree-1', { rev: 1, archivedAt: NOW }),
        latentVisibleBranches: -1,
      }),
    ).toEqual(STALE);
  });

  it('rejects a mismatched record pair before deriving counters', () => {
    expect(() =>
      evaluateTreeUsageMutation({
        previous: tree('tree-1'),
        incoming: tree('tree-2', { rev: 2, updatedAt: NOW + 1 }),
        latentVisibleBranches: 0,
      }),
    ).toThrow('previous and incoming must describe the same record');
  });
});

describe('node usage delta table', () => {
  function heartInspection(treeRecord = tree()) {
    return inspectHeartTransition({
      kind: 'update',
      ownerSub: OWNER,
      previousTree: treeRecord,
      incomingTree: treeRecord,
      nodes: [owned(node('tree-1-heart'))],
    });
  }

  it.each([
    [
      'create visible branch on active tree',
      undefined,
      node('branch'),
      tree(),
      applied('tree-1', 0, 1, 0, 1, 'unchanged', true),
    ],
    [
      'create additional root on active tree',
      undefined,
      node('extra-root'),
      tree(),
      applied('tree-1', 0, 1, 0, 1, 'unchanged', true),
    ],
    [
      'create exact heart',
      undefined,
      node('tree-1-heart'),
      tree(),
      applied('tree-1', 0, 0, 0, 0, 'unchanged', true),
    ],
    [
      'create branch while tree inactive',
      undefined,
      node('branch'),
      tree('tree-1', { archivedAt: NOW }),
      applied('tree-1', 0, 1, 0, 0, 'unchanged', true),
    ],
    [
      'archive visible branch',
      node('branch'),
      node('branch', 'tree-1', { rev: 2, updatedAt: NOW + 1, archivedAt: NOW + 1 }),
      tree(),
      applied('tree-1', 0, -1, 0, -1, 'unchanged'),
    ],
    [
      'tombstone visible branch',
      node('branch'),
      node('branch', 'tree-1', { rev: 2, updatedAt: NOW + 1, deletedAt: NOW + 1 }),
      tree(),
      applied('tree-1', 0, -1, 0, -1, 'unchanged'),
    ],
    [
      'restore archived branch',
      node('branch', 'tree-1', { archivedAt: NOW }),
      node('branch', 'tree-1', { rev: 2, updatedAt: NOW + 1 }),
      tree(),
      applied('tree-1', 0, 1, 0, 1, 'unchanged'),
    ],
    [
      'restore branch while tree inactive',
      node('branch', 'tree-1', { archivedAt: NOW }),
      node('branch', 'tree-1', { rev: 2, updatedAt: NOW + 1 }),
      tree('tree-1', { archivedAt: NOW }),
      applied('tree-1', 0, 1, 0, 0, 'unchanged'),
    ],
    [
      'edit title and status',
      node('branch'),
      node('branch', 'tree-1', {
        rev: 2,
        updatedAt: NOW + 1,
        title: 'renamed',
        status: 'achieved',
      }),
      tree(),
      applied('tree-1', 0, 0, 0, 0, 'unchanged'),
    ],
    [
      'tombstone exact heart',
      node('tree-1-heart'),
      node('tree-1-heart', 'tree-1', {
        rev: 2,
        updatedAt: NOW + 1,
        deletedAt: NOW + 1,
      }),
      tree(),
      applied('tree-1', 0, 0, 0, 0, 'unchanged'),
    ],
    [
      'restore exact heart',
      node('tree-1-heart', 'tree-1', { deletedAt: NOW }),
      node('tree-1-heart', 'tree-1', { rev: 2, updatedAt: NOW + 1 }),
      tree(),
      applied('tree-1', 0, 0, 0, 0, 'unchanged'),
    ],
  ] as const)(
    '%s updates latent storage separately from active quota consumption',
    (_label, previous, incoming, owningTree, expected) => {
      expect(
        evaluateNodeUsageMutation({
          previous,
          incoming,
          tree: owningTree,
          heart: heartInspection(owningTree),
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    [
      'lower revision',
      node('branch', 'tree-1', { rev: 3 }),
      node('branch', 'tree-1', { rev: 2, updatedAt: NOW + 10, deletedAt: NOW + 10 }),
    ],
    [
      'exact tie',
      node('branch'),
      node('branch', 'tree-1', { deletedAt: NOW }),
    ],
  ])('does not move either counter for a stale node write: %s', (_label, previous, incoming) => {
    expect(
      evaluateNodeUsageMutation({
        previous,
        incoming,
        tree: tree(),
        heart: heartInspection(),
      }),
    ).toEqual(STALE);
  });

  it('reports heart drift and conservatively counts every visible root', () => {
    const badHeart = inspectHeartTransition({
      kind: 'update',
      ownerSub: OWNER,
      previousTree: tree(),
      incomingTree: tree(),
      nodes: [],
    });

    expect(
      evaluateNodeUsageMutation({
        incoming: node('extra-root'),
        tree: tree(),
        heart: badHeart,
      }),
    ).toEqual({
      ...applied('tree-1', 0, 1, 0, 1, 'unchanged', true),
      heartDrift: 'HEART_NOT_FOUND',
    });
  });

  it('still computes a conservative reduction while heart drift is present', () => {
    const badHeart = inspectHeartTransition({
      kind: 'update',
      ownerSub: OWNER,
      previousTree: tree(),
      incomingTree: tree(),
      nodes: [],
    });

    expect(
      evaluateNodeUsageMutation({
        previous: node('branch'),
        incoming: node('branch', 'tree-1', {
          rev: 2,
          updatedAt: NOW + 1,
          deletedAt: NOW + 1,
        }),
        tree: tree(),
        heart: badHeart,
      }),
    ).toEqual({
      ...applied('tree-1', 0, -1, 0, -1, 'unchanged'),
      heartDrift: 'HEART_NOT_FOUND',
    });
  });

  it('classifies positive quota consumption independently from physical growth', () => {
    const latentOnly = evaluateNodeUsageMutation({
      incoming: node('branch'),
      tree: tree('tree-1', { archivedAt: NOW }),
      heart: heartInspection(tree('tree-1', { archivedAt: NOW })),
    });
    const activeGrowth = evaluateNodeUsageMutation({
      incoming: node('branch'),
      tree: tree(),
      heart: heartInspection(),
    });

    expect(latentOnly).toMatchObject({
      physical: { visibleBranches: 1 },
      quota: { visibleBranches: 0 },
    });
    expect(hasQuotaGrowth(latentOnly)).toBe(false);
    expect(hasQuotaGrowth(activeGrowth)).toBe(true);
    expect(hasQuotaGrowth(STALE)).toBe(false);
  });

  it('classifies tree reactivation, but never deactivation, as quota growth', () => {
    const restored = evaluateTreeUsageMutation({
      previous: tree('tree-1', { archivedAt: NOW }),
      incoming: tree('tree-1', { rev: 2, updatedAt: NOW + 1 }),
      latentVisibleBranches: 4,
    });
    const archived = evaluateTreeUsageMutation({
      previous: tree(),
      incoming: tree('tree-1', { rev: 2, updatedAt: NOW + 1, archivedAt: NOW + 1 }),
      latentVisibleBranches: 4,
    });

    expect(hasQuotaGrowth(restored)).toBe(true);
    expect(hasQuotaGrowth(archived)).toBe(false);
  });

  it('rejects a node move or a mismatched supplied tree', () => {
    expect(() =>
      evaluateNodeUsageMutation({
        previous: node('branch', 'tree-1'),
        incoming: node('branch', 'tree-2', { rev: 2, updatedAt: NOW + 1 }),
        tree: tree('tree-2'),
        heart: inspectHeartTransition({
          kind: 'update',
          ownerSub: OWNER,
          previousTree: tree('tree-2'),
          incomingTree: tree('tree-2'),
          nodes: [owned(node('tree-2-heart', 'tree-2'))],
        }),
      }),
    ).toThrow('node treeId is immutable');

    expect(() =>
      evaluateNodeUsageMutation({
        incoming: node('branch', 'tree-1'),
        tree: tree('tree-2'),
        heart: inspectHeartTransition({
          kind: 'update',
          ownerSub: OWNER,
          previousTree: tree('tree-2'),
          incomingTree: tree('tree-2'),
          nodes: [owned(node('tree-2-heart', 'tree-2'))],
        }),
      }),
    ).toThrow('incoming node must belong to the supplied tree');
  });
});
