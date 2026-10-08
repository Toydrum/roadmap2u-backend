import { ApiError, ForestSnapshot } from '@app/api/contracts';
import { Tree, TreeNode } from '@app/db/schema';
import { Ctx, resolveRelationship, requireWritableOwner, toPublic } from '../authz';
import { resolveSocialCapability } from '../commercial/social-policy';
import { K, RecordItem, queryPrefix } from '../db';
import {
  requireCloudConsent,
  recheckCloudConsent,
  assertCloudRecords,
  type CloudConsentGuard,
} from '../privacy/consent';

async function privacyGuard(ctx: Ctx, userId: string): Promise<CloudConsentGuard | undefined> {
  try {
    return await requireCloudConsent(ctx, userId);
  } catch (error) {
    if (userId !== ctx.callerId && error instanceof ApiError) throw new ApiError('NOT_FOUND');
    throw error;
  }
}

async function requireVisibleOwner(ctx: Ctx, ownerId: string) {
  try {
    const owner = await requireWritableOwner(ctx, ownerId);
    const expected = K.profile(ownerId);
    if (owner.pk !== expected.pk || owner.sk !== expected.sk || owner.userId !== ownerId) {
      throw new ApiError('NOT_FOUND');
    }
    return owner;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      throw new ApiError('NOT_FOUND');
    }
    throw error;
  }
}

/**
 * Forest snapshots per the permissions matrix: current primary/additional
 * supervision gets FULL nodes; compatible direct friendships get STRIPPED.
 * Adult↔minor friendship-shaped access and every other relationship get 404.
 * Check-ins/sessions are NEVER served regardless of relationship.
 */
export async function getForest(ctx: Ctx, userId: string): Promise<ForestSnapshot> {
  if (
    ctx.callerId !== userId &&
    (ctx.caller.privacyMode === 'adolescent_private' ||
      (await requireVisibleOwner(ctx, userId)).privacyMode === 'adolescent_private')
  )
    throw new ApiError('NOT_FOUND');
  const relationship = await resolveRelationship(ctx, userId);
  if (!relationship) throw new ApiError('NOT_FOUND');
  let owner = relationship === 'self' ? ctx.caller : await requireVisibleOwner(ctx, userId);

  const friendshipVisit = relationship === 'adult_friend' || relationship === 'minor_friend';
  if (friendshipVisit) {
    await resolveSocialCapability(ctx, 'visit', [ctx.callerId]);
    const [viewer, currentOwner, currentRelationship] = await Promise.all([
      requireVisibleOwner(ctx, ctx.callerId),
      requireVisibleOwner(ctx, userId),
      resolveRelationship(ctx, userId),
    ]);
    if (
      !viewer.socialEnabled ||
      !currentOwner.socialEnabled ||
      currentRelationship !== relationship
    ) {
      throw new ApiError('NOT_FOUND');
    }
    owner = currentOwner;
  } else if (relationship !== 'self') {
    const currentRelationship = await resolveRelationship(ctx, userId);
    if (currentRelationship !== relationship) throw new ApiError('NOT_FOUND');
  }

  const detail =
    relationship === 'self' ||
    relationship === 'primary_supervision' ||
    relationship === 'additional_supervision'
      ? 'full'
      : 'stripped';
  const consent = await privacyGuard(ctx, userId);

  const [treeItems, nodeItems] = await Promise.all([
    queryPrefix<RecordItem>(ctx.deps, K.user(userId), 'REC#trees#'),
    queryPrefix<RecordItem>(ctx.deps, K.user(userId), 'REC#nodes#'),
  ]);
  try {
    assertCloudRecords(consent, [...treeItems, ...nodeItems]);
    await recheckCloudConsent(ctx, consent);
  } catch (error) {
    if (userId !== ctx.callerId && error instanceof ApiError) throw new ApiError('NOT_FOUND');
    throw error;
  }
  if (
    consent &&
    relationship !== 'self' &&
    (await resolveRelationship(ctx, userId)) !== relationship
  ) {
    throw new ApiError('NOT_FOUND');
  }
  if (relationship !== 'self') {
    const [viewer, currentOwner] = await Promise.all([
      requireVisibleOwner(ctx, ctx.callerId),
      requireVisibleOwner(ctx, userId),
    ]);
    if (viewer.privacyMode || currentOwner.privacyMode) throw new ApiError('NOT_FOUND');
  }

  const trees = treeItems.map((i) => i.record as Tree).filter((t) => !t.deletedAt && !t.archivedAt);
  const liveTreeIds = new Set(trees.map((t) => t.id));
  const nodes = nodeItems
    .map((i) => i.record as TreeNode)
    .filter((n) => !n.deletedAt && !n.archivedAt && liveTreeIds.has(n.treeId))
    .map((n) =>
      detail === 'full'
        ? n
        : {
            ...n,
            note: '',
            trigger: null,
            targetDate: null,
            priority: null,
            estimateMin: null,
            repeatsDaily: undefined,
            repeats: undefined,
            repeatsSetAt: undefined,
            remindAt: undefined,
          },
    );

  return {
    owner: toPublic(
      owner,
      relationship === 'primary_supervision' || relationship === 'additional_supervision',
    ),
    detail,
    trees,
    nodes,
    fetchedAt: ctx.deps.now(),
  };
}
