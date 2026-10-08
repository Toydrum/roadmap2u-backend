import { ApiError } from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Ctx } from '../authz';
import { readStableAccessSnapshot } from '../access-reader';
import { deriveAccessItem } from '../commercial/access-resolver';
import { paidSourceGuards } from '../commercial/paid-source-guards';
import type { AdultPrivacyItem } from './consent';

type Item = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export interface ResponsiblePremiumCloud {
  readonly guardianId: string;
  readonly validUntil: number;
  readonly sourceValidUntil: number | null;
  readonly conditions: readonly Item[];
}

/** Derive capacity from current sources; never write ACCESS or a grant for either account. */
export async function requireResponsiblePremiumCloud(
  ctx: Ctx,
  state: AdultPrivacyItem,
): Promise<ResponsiblePremiumCloud> {
  if (!state.guardianId || state.guardianId === state.userId)
    throw new ApiError('CLOUD_CONSENT_REQUIRED');
  return requireCurrentResponsiblePremium(ctx, state.guardianId);
}

/** Also used to fence capacity when a responsible adult issues or accepts an invitation. */
export async function requireCurrentResponsiblePremium(
  ctx: Ctx,
  guardianId: string,
): Promise<ResponsiblePremiumCloud> {
  const snapshot = await readStableAccessSnapshot(ctx.deps.ddb, ctx.deps.table, guardianId);
  const now = ctx.deps.now();
  const access = deriveAccessItem(guardianId, now, snapshot.access, snapshot.grants, snapshot);
  if (
    snapshot.ownerProfile?.accountType !== 'adult' ||
    access.effectivePlanKey !== 'premium' ||
    !access.capabilities.cloudSync
  )
    throw new ApiError('CAPABILITY_REQUIRED');
  return {
    guardianId,
    validUntil: access.offlineValidUntil,
    sourceValidUntil: access.nextRecomputeAt,
    conditions: [
      {
        ConditionCheck: {
          TableName: ctx.deps.table,
          Key: { pk: `USER#${guardianId}`, sk: 'ACCESS' },
          ConditionExpression: snapshot.access
            ? 'revision = :revision'
            : 'attribute_not_exists(pk)',
          ...(snapshot.access
            ? { ExpressionAttributeValues: { ':revision': snapshot.access.revision } }
            : {}),
        },
      },
      ...paidSourceGuards(ctx.deps.table, guardianId, snapshot),
    ],
  };
}
