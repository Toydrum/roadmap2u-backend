import { ApiError, ForestSnapshot } from '@app/api/contracts';
import { Tree, TreeNode } from '@app/db/schema';
import { Ctx, profileOf, relationshipTo, toPublic } from '../authz';
import { K, RecordItem, queryPrefix } from '../db';

/**
 * Forest snapshots per the permissions matrix: guardians get FULL nodes
 * (co-gardening needs real notes/dates); friends and minor→guardian get the
 * STRIPPED view. Everyone else gets 404 — never an existence oracle.
 * Check-ins/sessions are NEVER served regardless of relationship.
 */
export async function getForest(ctx: Ctx, userId: string): Promise<ForestSnapshot> {
  const relationship = await relationshipTo(ctx, userId);
  if (!relationship) throw new ApiError('NOT_FOUND');
  const owner = await profileOf(ctx.deps, userId);
  if (!owner) throw new ApiError('NOT_FOUND');

  const detail = relationship === 'self' || relationship === 'guardian' ? 'full' : 'stripped';

  const [treeItems, nodeItems] = await Promise.all([
    queryPrefix<RecordItem>(ctx.deps, K.user(userId), 'REC#trees#'),
    queryPrefix<RecordItem>(ctx.deps, K.user(userId), 'REC#nodes#'),
  ]);

  const trees = treeItems
    .map((i) => i.record as Tree)
    .filter((t) => !t.deletedAt && !t.archivedAt);
  const liveTreeIds = new Set(trees.map((t) => t.id));
  const nodes = nodeItems
    .map((i) => i.record as TreeNode)
    .filter((n) => !n.deletedAt && !n.archivedAt && liveTreeIds.has(n.treeId))
    .map((n) =>
      detail === 'full' ? n : { ...n, note: '', trigger: null, targetDate: null, priority: null, estimateMin: null, repeatsDaily: undefined, repeats: undefined, repeatsSetAt: undefined, remindAt: undefined },
    );

  return {
    owner: toPublic(owner, relationship === 'guardian'),
    detail,
    trees,
    nodes,
    fetchedAt: ctx.deps.now(),
  };
}
