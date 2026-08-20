import { isDeepStrictEqual } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ApiError, type AccessSummary } from '@app/api/contracts';
import { accountClosureKey } from './account-closure';
import { WRITABLE_PROFILE_CONDITION } from './authz';
import { K, type DynamoKey, type ProfileItem } from './db';
import { errorResponse, type HttpResponse } from './http';
import {
  AccessResolver,
  type AccessPutProposal,
  type AccessSnapshot,
} from './commercial/access-resolver';
import { accessKey, type AccessItem, type GrantItem } from './commercial/model';
import { instrumentHandler } from './observability';

export type AccessReaderEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface OwnerCommercialSnapshot {
  readonly profile?: ProfileItem;
  readonly closure?: Readonly<Record<string, unknown>>;
  /**
   * Phase-two compatibility seam. TASK-030 will add the generation-aware
   * USAGE#TREE query here; until then only the base activeTrees counter exists.
   */
  readonly usage: AccessSummary['usage'];
}

export interface AccessReaderDeps {
  readonly readOwnerSnapshot: (ownerSub: string) => Promise<OwnerCommercialSnapshot>;
  readonly resolveAccess: (ownerSub: string) => Promise<AccessItem>;
}

export interface DynamoAccessReaderOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
}

const ACCESS_SNAPSHOT_ATTEMPTS = 3;
/**
 * Technical runaway guard, not a product cap. A DynamoDB Query page can be up
 * to 1 MB and may contain any number of grants. TASK-036 still needs a
 * retention/TTL policy for old revoked and expired grant history.
 */
const MAX_GRANT_QUERY_PAGES = 64;
const NO_STORE_HEADERS = Object.freeze({ 'cache-control': 'no-store' });

function projection(attributes: readonly string[]): {
  readonly ProjectionExpression: string;
  readonly ExpressionAttributeNames: Readonly<Record<string, string>>;
} {
  const aliases = attributes.map((attribute, index) => [`#p${index}`, attribute] as const);
  return {
    ProjectionExpression: aliases.map(([alias]) => alias).join(', '),
    ExpressionAttributeNames: Object.fromEntries(aliases),
  };
}

const PROFILE_PROJECTION = projection(['pk', 'sk', 'userId', 'status']);
const CLOSURE_PROJECTION = projection(['pk', 'sk']);
const USAGE_PROJECTION = projection(['pk', 'sk', 'state', 'activeTrees']);
const ACCESS_PROJECTION = projection([
  'pk',
  'sk',
  'ownerSub',
  'effectivePlanKey',
  'catalogVersion',
  'status',
  'activeSources',
  'limits',
  'capabilities',
  'revision',
  'nextRecomputeAt',
  'offlineValidUntil',
  'updatedAt',
]);
const GRANT_PROJECTION = projection([
  'pk',
  'sk',
  'ownerSub',
  'grantId',
  'sourceKind',
  'status',
  'catalogVersion',
  'planKey',
  'limits',
  'capabilities',
  'startsAt',
  'expiresAt',
  'revision',
  'reason',
  'createdAt',
  'updatedAt',
  'revokedAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trustedOwnerSub(event: AccessReaderEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.['sub'];
  if (typeof sub !== 'string' || !sub || sub !== sub.trim()) {
    throw new ApiError('UNAUTHENTICATED');
  }
  return sub;
}

function assertReadableOwner(
  snapshot: OwnerCommercialSnapshot,
  ownerSub: string,
): asserts snapshot is OwnerCommercialSnapshot & { profile: ProfileItem } {
  const profile = snapshot.profile;
  if (
    !profile ||
    profile.pk !== K.user(ownerSub) ||
    profile.sk !== 'PROFILE' ||
    profile.userId !== ownerSub
  ) {
    throw new ApiError('UNAUTHENTICATED');
  }
  if (
    (profile.status !== undefined && profile.status !== 'active') ||
    snapshot.closure !== undefined
  ) {
    throw new ApiError('CONFLICT', 'account closure is in progress');
  }
}

function accessSummary(access: AccessItem, usage: AccessSummary['usage']): AccessSummary {
  return {
    effectivePlanKey: access.effectivePlanKey,
    catalogVersion: access.catalogVersion,
    status: access.status,
    activeSources: access.activeSources.map((source) => ({
      kind: source.kind,
      sourceId: source.sourceId,
      planKey: source.planKey,
      validUntil: source.validUntil,
    })),
    limits: {
      maxActiveTrees: access.limits.maxActiveTrees,
      maxVisibleBranchesPerTree: access.limits.maxVisibleBranchesPerTree,
    },
    capabilities: {
      cloudSync: access.capabilities.cloudSync,
      social: access.capabilities.social,
      family: access.capabilities.family,
    },
    usage: {
      activeTrees: usage.activeTrees,
      visibleBranchesByTree: { ...usage.visibleBranchesByTree },
    },
    revision: access.revision,
    nextRecomputeAt: access.nextRecomputeAt,
    offlineValidUntil: access.offlineValidUntil,
  };
}

function noStore(response: HttpResponse): HttpResponse {
  return {
    ...response,
    headers: { ...response.headers, ...NO_STORE_HEADERS },
  };
}

/** Exact JWT route handler. It never accepts an owner id from path, query or body. */
export function createAccessReader(
  deps: AccessReaderDeps,
): (event: AccessReaderEvent) => Promise<HttpResponse> {
  return async (event) => {
    try {
      const ownerSub = trustedOwnerSub(event);
      const before = await deps.readOwnerSnapshot(ownerSub);
      assertReadableOwner(before, ownerSub);

      const access = await deps.resolveAccess(ownerSub);

      // Lifecycle is checked again after a possible ACCESS materialization so
      // a concurrent closure never receives an entitlement response.
      const after = await deps.readOwnerSnapshot(ownerSub);
      assertReadableOwner(after, ownerSub);
      return noStore({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(accessSummary(access, after.usage)),
      });
    } catch (error) {
      return noStore(errorResponse(error));
    }
  };
}

function baseUsage(
  item: unknown,
  ownerSub: string,
): AccessSummary['usage'] {
  if (
    isRecord(item) &&
    item['pk'] === K.user(ownerSub) &&
    item['sk'] === 'USAGE' &&
    item['state'] === 'active' &&
    typeof item['activeTrees'] === 'number' &&
    Number.isSafeInteger(item['activeTrees']) &&
    item['activeTrees'] >= 0
  ) {
    return { activeTrees: item['activeTrees'], visibleBranchesByTree: {} };
  }
  return { activeTrees: 0, visibleBranchesByTree: {} };
}

async function readOwnerSnapshot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ownerSub: string,
): Promise<OwnerCommercialSnapshot> {
  // TransactGet is serializable and strongly consistent; it does not accept a
  // per-item ConsistentRead flag.
  const result = await ddb.send(
    new TransactGetCommand({
      TransactItems: [
        {
          Get: {
            TableName: tableName,
            Key: K.profile(ownerSub),
            ...PROFILE_PROJECTION,
          },
        },
        {
          Get: {
            TableName: tableName,
            Key: accountClosureKey(ownerSub),
            ...CLOSURE_PROJECTION,
          },
        },
        {
          Get: {
            TableName: tableName,
            Key: { pk: K.user(ownerSub), sk: 'USAGE' },
            ...USAGE_PROJECTION,
          },
        },
      ],
    }),
  );
  const [profileResult, closureResult, usageResult] = result.Responses ?? [];
  return {
    ...(profileResult?.Item ? { profile: profileResult.Item as ProfileItem } : {}),
    ...(closureResult?.Item
      ? { closure: closureResult.Item as Readonly<Record<string, unknown>> }
      : {}),
    usage: baseUsage(usageResult?.Item, ownerSub),
  };
}

async function readAccess(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ownerSub: string,
): Promise<AccessItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: accessKey(ownerSub),
      ConsistentRead: true,
      ...ACCESS_PROJECTION,
    }),
  );
  return result.Item as AccessItem | undefined;
}

async function readAllGrants(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ownerSub: string,
): Promise<GrantItem[]> {
  const grants: GrantItem[] = [];
  let exclusiveStartKey: DynamoKey | undefined;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_GRANT_QUERY_PAGES) {
      throw new ApiError(
        'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
        'Grant history exceeded the technical query-page bound',
      );
    }
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': K.user(ownerSub),
          ':prefix': 'GRANT#',
        },
        ConsistentRead: true,
        Select: 'SPECIFIC_ATTRIBUTES',
        ...GRANT_PROJECTION,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    grants.push(...((result.Items ?? []) as GrantItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return grants;
}

/**
 * A strong Query can paginate, so it is not by itself a cross-page snapshot.
 * ACCESS is the fence: every GRANT mutation must update ACCESS in the same
 * TransactWrite. Reading the fence before and after all pages detects a race.
 */
async function readStableAccessSnapshot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ownerSub: string,
): Promise<AccessSnapshot> {
  for (let attempt = 0; attempt < ACCESS_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await readAccess(ddb, tableName, ownerSub);
    const grants = await readAllGrants(ddb, tableName, ownerSub);
    const after = await readAccess(ddb, tableName, ownerSub);
    if (isDeepStrictEqual(before, after)) {
      return { ...(after ? { access: after } : {}), grants };
    }
  }
  throw new ApiError(
    'ACCESS_REVISION_CONFLICT',
    'Access changed while its grant snapshot was being read',
  );
}

function isTransactionCanceled(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'TransactionCanceledException';
}

async function materializeAccess(
  options: DynamoAccessReaderOptions,
  proposal: AccessPutProposal,
): Promise<'committed' | 'conflict'> {
  const ownerSub = proposal.Put.Item.ownerSub;
  const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      ConditionCheck: {
        TableName: options.tableName,
        Key: K.profile(ownerSub),
        ConditionExpression: `${WRITABLE_PROFILE_CONDITION} AND userId = :ownerSub`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':ownerSub': ownerSub },
      },
    },
    {
      ConditionCheck: {
        TableName: options.tableName,
        Key: accountClosureKey(ownerSub),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    },
    { Put: proposal.Put },
  ];
  try {
    await options.ddb.send(new TransactWriteCommand({ TransactItems: items }));
    return 'committed';
  } catch (error) {
    if (!isTransactionCanceled(error)) throw error;

    // Cancellation reasons are not guaranteed in every runtime response. A
    // serializable re-read distinguishes lifecycle loss from the ACCESS CAS.
    const lifecycle = await readOwnerSnapshot(options.ddb, options.tableName, ownerSub);
    try {
      assertReadableOwner(lifecycle, ownerSub);
    } catch {
      throw new ApiError('CONFLICT', 'account closure is in progress');
    }
    return 'conflict';
  }
}

export function createDynamoAccessResolver(
  options: DynamoAccessReaderOptions,
): AccessResolver {
  return new AccessResolver({
    tableName: options.tableName,
    now: options.now,
    readSnapshot: (ownerSub, _readOptions) =>
      readStableAccessSnapshot(options.ddb, options.tableName, ownerSub),
    materializeAccess: (proposal) => materializeAccess(options, proposal),
  });
}

export function createDynamoAccessReaderDeps(
  options: DynamoAccessReaderOptions,
): AccessReaderDeps {
  const resolver = createDynamoAccessResolver(options);
  return {
    readOwnerSnapshot: (ownerSub) =>
      readOwnerSnapshot(options.ddb, options.tableName, ownerSub),
    resolveAccess: async (ownerSub) => (await resolver.resolveFresh(ownerSub)).access,
  };
}

let realReader: ((event: AccessReaderEvent) => Promise<HttpResponse>) | undefined;

function productionReader(): (event: AccessReaderEvent) => Promise<HttpResponse> {
  if (realReader) return realReader;
  const tableName = process.env['TABLE_NAME'];
  if (!tableName) throw new Error('TABLE_NAME is required');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  realReader = createAccessReader(
    createDynamoAccessReaderDeps({ ddb, tableName, now: Date.now }),
  );
  return realReader;
}

export const handler = instrumentHandler(
  'access-reader',
  (event: AccessReaderEvent, _context?: unknown): Promise<HttpResponse> =>
    productionReader()(event),
);
