import { ApiError, ForestSnapshot } from '@app/api/contracts';
import { Tree, TreeNode } from '@app/db/schema';
import {
  Ctx,
  profileOf,
  relationshipTo,
  requireWritableOwner,
  toPublic,
} from '../authz';
import { resolveSocialCapability } from '../commercial/social-policy';
import { FriendItem, GetCommand, K, RecordItem, queryPrefix } from '../db';

async function requireVisibleFriendOwner(ctx: Ctx, ownerId: string) {
  try {
    return await requireWritableOwner(ctx, ownerId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      throw new ApiError('NOT_FOUND');
    }
    throw error;
  }
}

/**
 * Forest snapshots per the permissions matrix: guardians get FULL nodes
 * (co-gardening needs real notes/dates); friends and minor→guardian get the
 * STRIPPED view. Everyone else gets 404 — never an existence oracle.
 * Check-ins/sessions are NEVER served regardless of relationship.
 */
export async function getForest(ctx: Ctx, userId: string): Promise<ForestSnapshot> {
  const relationship = await relationshipTo(ctx, userId);
  if (!relationship) throw new ApiError('NOT_FOUND');
  let owner = await profileOf(ctx.deps, userId);
  if (!owner) throw new ApiError('NOT_FOUND');

  if (relationship === 'friend') {
    await resolveSocialCapability(ctx, 'visit', [ctx.callerId]);
    const [viewer, currentOwner, friendship] = await Promise.all([
      requireWritableOwner(ctx, ctx.callerId),
      requireVisibleFriendOwner(ctx, userId),
      ctx.deps.ddb.send(
        new GetCommand({
          TableName: ctx.deps.table,
          Key: K.friend(ctx.callerId, userId),
          ConsistentRead: true,
        }),
      ),
    ]);
    if (
      !viewer.socialEnabled ||
      !currentOwner.socialEnabled ||
      !(friendship.Item as FriendItem | undefined)
    ) {
      throw new ApiError('NOT_FOUND');
    }
    owner = currentOwner;
  }

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
