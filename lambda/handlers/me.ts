import { ApiError, FamilyLinkView, MeResponse, UserProfile } from '@app/api/contracts';
import { Ctx, guardiansOf, minorsOf, profileOf, toPublic } from '../authz';
import { K, ProfileItem, UpdateCommand } from '../db';

export function profileView(item: ProfileItem): UserProfile {
  return {
    userId: item.userId,
    username: item.username,
    displayName: item.displayName,
    accountType: item.accountType,
    socialEnabled: item.socialEnabled,
    createdAt: item.createdAt,
  };
}

export async function getMe(ctx: Ctx): Promise<MeResponse> {
  const [guardianLinks, minorLinks] = await Promise.all([
    guardiansOf(ctx.deps, ctx.callerId),
    minorsOf(ctx.deps, ctx.callerId),
  ]);

  const guardians: FamilyLinkView[] = [];
  for (const link of guardianLinks) {
    const other = await profileOf(ctx.deps, link.guardianId);
    if (!other) continue; // dangling link — deletion cascade raced; hide it
    guardians.push({ linkId: link.linkId, kind: link.kind, user: toPublic(other, false), createdAt: link.createdAt });
  }
  const minors: FamilyLinkView[] = [];
  for (const link of minorLinks) {
    const other = await profileOf(ctx.deps, link.minorId);
    if (!other) continue;
    minors.push({ linkId: link.linkId, kind: link.kind, user: toPublic(other, true), createdAt: link.createdAt });
  }
  return { profile: profileView(ctx.caller), family: { guardians, minors } };
}

export async function patchMe(ctx: Ctx, body: { displayName?: string }): Promise<UserProfile> {
  const displayName = body.displayName?.trim();
  if (displayName === undefined) return profileView(ctx.caller);
  if (!displayName || displayName.length > 40) throw new ApiError('VALIDATION', 'displayName 1-40 chars');
  await ctx.deps.ddb.send(
    new UpdateCommand({
      TableName: ctx.deps.table,
      Key: K.profile(ctx.callerId),
      UpdateExpression: 'SET displayName = :d',
      ExpressionAttributeValues: { ':d': displayName },
    }),
  );
  return profileView({ ...ctx.caller, displayName });
}
