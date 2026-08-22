import { ApiError } from '@app/api/contracts';
import { createDynamoAccessResolver } from '../access-reader';
import { WRITABLE_PROFILE_CONDITION, type Ctx } from '../authz';
import { GetCommand, K, type ProfileItem } from '../db';
import {
  guardedWrite,
  isTransactionCanceled,
  type EmbeddedOwnerGuards,
  type TransactItem,
} from '../handlers/guarded-mutation';
import { emitCommercialMetric, type CommercialMetricStage } from '../observability';
import type { AccessItem } from './model';
import {
  CommercialFlagsResolver,
  flagsForCommercialOperation,
  type CommercialMode,
} from './flags';

export type ProtectedSocialAction = 'create' | 'accept' | 'visit';

export interface SocialCapabilityDecision {
  readonly kind: 'social';
  readonly action: ProtectedSocialAction;
  readonly mode: CommercialMode;
  readonly wouldDeny: boolean;
}

export interface SocialCapabilityResolution {
  readonly accesses: ReadonlyMap<string, AccessItem>;
  readonly decision: SocialCapabilityDecision;
}

const MAX_SOCIAL_WRITE_ATTEMPTS = 2;

const flagResolvers = new WeakMap<Ctx['deps'], CommercialFlagsResolver>();

function emitSocialDecision(decision: SocialCapabilityDecision): void {
  console.info(JSON.stringify({ event: 'commercial.capability-decision', ...decision }));
}

function commercialMetricStage(): CommercialMetricStage | undefined {
  const explicit = process.env['COMMERCIAL_STAGE'];
  if (explicit === 'dev' || explicit === 'test' || explicit === 'prod') return explicit;
  const inferred = /-(dev|test|prod)$/.exec(
    process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? '',
  )?.[1];
  return inferred === 'dev' || inferred === 'test' || inferred === 'prod'
    ? inferred
    : undefined;
}

function flagsResolver(ctx: Ctx): CommercialFlagsResolver {
  let resolver = flagResolvers.get(ctx.deps);
  if (!resolver) {
    resolver = new CommercialFlagsResolver({
      now: ctx.deps.now,
      readItem: async () => {
        const result = await ctx.deps.ddb.send(
          new GetCommand({
            TableName: ctx.deps.table,
            Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' },
            ConsistentRead: true,
          }),
        );
        return result.Item;
      },
      emitMetric: (metric) => {
        const stage = commercialMetricStage();
        if (stage) emitCommercialMetric(metric, stage);
      },
    });
    flagResolvers.set(ctx.deps, resolver);
  }
  return resolver;
}

export async function resolveSocialCapability(
  ctx: Ctx,
  action: ProtectedSocialAction,
  participantIds: readonly string[],
  emitDecision: (decision: SocialCapabilityDecision) => void = emitSocialDecision,
): Promise<SocialCapabilityResolution> {
  const flagsResult = await flagsResolver(ctx).resolve();
  const flags = flagsForCommercialOperation(flagsResult, { kind: 'social', action });
  if (!flags) throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');

  const ownerIds = [...new Set(participantIds)];
  const accessResolver = createDynamoAccessResolver({
    ddb: ctx.deps.ddb,
    tableName: ctx.deps.table,
    now: ctx.deps.now,
  });
  const entries = await Promise.all(
    ownerIds.map(async (ownerId) => [
      ownerId,
      (await accessResolver.resolveFresh(ownerId)).access,
    ] as const),
  );
  const accesses = new Map(entries);
  const decision: SocialCapabilityDecision = {
    kind: 'social',
    action,
    mode: flags.capabilityMode,
    wouldDeny: entries.some(([, access]) => !access.capabilities.social),
  };
  emitDecision(decision);
  if (decision.mode === 'enforce' && decision.wouldDeny) {
    throw new ApiError('CAPABILITY_REQUIRED');
  }
  return { accesses, decision };
}

function socialProfileGuard(ctx: Ctx, ownerId: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.profile(ownerId),
      ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND (#socialEnabled = :socialEnabled)`,
      ExpressionAttributeNames: { '#status': 'status', '#socialEnabled': 'socialEnabled' },
      ExpressionAttributeValues: { ':active': 'active', ':socialEnabled': true },
    },
  };
}

function accessGuard(ctx: Ctx, access: AccessItem): TransactItem {
  const boundary = access.nextRecomputeAt;
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: { pk: K.user(access.ownerSub), sk: 'ACCESS' },
      ConditionExpression:
        'ownerSub = :ownerSub AND revision = :accessRevision AND #status = :accessStatus AND ' +
        (boundary === null
          ? 'attribute_type(nextRecomputeAt, :nullType)'
          : 'nextRecomputeAt = :nextRecomputeAt AND nextRecomputeAt > :now'),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':ownerSub': access.ownerSub,
        ':accessRevision': access.revision,
        ':accessStatus': 'active',
        ...(boundary === null
          ? { ':nullType': 'NULL' }
          : { ':nextRecomputeAt': boundary, ':now': ctx.deps.now() }),
      },
    },
  };
}

function sameAccessFence(left: AccessItem | undefined, right: AccessItem | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.ownerSub === right.ownerSub &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.nextRecomputeAt === right.nextRecomputeAt
  );
}

async function recheckSocialProfiles(ctx: Ctx, ownerIds: readonly string[]): Promise<void> {
  const profiles = await Promise.all(
    ownerIds.map(async (ownerId) => {
      const result = await ctx.deps.ddb.send(
        new GetCommand({
          TableName: ctx.deps.table,
          Key: K.profile(ownerId),
          ConsistentRead: true,
        }),
      );
      return result.Item as ProfileItem | undefined;
    }),
  );
  if (profiles.some((profile) => !profile?.socialEnabled)) {
    throw new ApiError('FORBIDDEN', 'social features are off');
  }
}

/** Protected social mutations re-resolve ACCESS and retry a lost revision once. */
export async function guardedSocialWrite(
  ctx: Ctx,
  action: Exclude<ProtectedSocialAction, 'visit'>,
  participantIds: readonly string[],
  writes: readonly TransactItem[],
  classifyCancellation?: () => Promise<void>,
  embedded: EmbeddedOwnerGuards = {},
): Promise<void> {
  const ownerIds = [...new Set(participantIds)];
  for (let attempt = 0; attempt < MAX_SOCIAL_WRITE_ATTEMPTS; attempt += 1) {
    const resolution = await resolveSocialCapability(ctx, action, ownerIds);
    const socialProfiles = ownerIds
      .filter((ownerId) => !embedded[ownerId]?.profile)
      .map((ownerId) => socialProfileGuard(ctx, ownerId));
    const declaredProfiles = Object.fromEntries(
      ownerIds.map((ownerId) => [
        ownerId,
        { ...embedded[ownerId], profile: true as const },
      ]),
    );
    try {
      await guardedWrite(
        ctx,
        ownerIds,
        [
          ...writes,
          ...socialProfiles,
          ...[...resolution.accesses.values()].map((access) => accessGuard(ctx, access)),
        ],
        classifyCancellation,
        declaredProfiles,
      );
      return;
    } catch (error) {
      if (!isTransactionCanceled(error)) throw error;
      await recheckSocialProfiles(ctx, ownerIds);
      const refreshed = await resolveSocialCapability(ctx, action, ownerIds);
      const accessChanged = ownerIds.some(
        (ownerId) =>
          !sameAccessFence(
            resolution.accesses.get(ownerId),
            refreshed.accesses.get(ownerId),
          ),
      );
      if (!accessChanged) {
        throw new ApiError('CONFLICT', 'social state changed; retry');
      }
      if (attempt + 1 === MAX_SOCIAL_WRITE_ATTEMPTS) {
        throw new ApiError('ACCESS_REVISION_CONFLICT');
      }
    }
  }
}
