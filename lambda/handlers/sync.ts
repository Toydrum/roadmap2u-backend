import {
  ApiError,
  CONTRACT_VERSION,
  LIMITS,
  SyncChangesResponse,
  SyncPushPayload,
  SyncPushResponse,
  SyncRecord,
  SyncStore,
  lwwBeats,
} from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_VERSION, SyncBase, type Tree, type TreeNode } from '@app/db/schema';
import { createHash } from 'node:crypto';
import {
  Ctx,
  requireGuardianOf,
  requireGuardianOfConsistent,
  requireWritableOwner,
  writableOwnerConditionChecks,
} from '../authz';
import { accountClosureKey } from '../account-closure';
import {
  createDynamoAccessResolver,
  readStableAccessSnapshot,
} from '../access-reader';
import { CommercialFlagsResolver } from '../commercial/flags';
import { inspectHeartTransition, type HeartInspection } from '../commercial/heart';
import {
  CommercialMutationWriter,
  type CommercialMutationSnapshot,
  type MutationCommitProposal,
} from '../commercial/mutation-writer';
import { validateSyncBatch, validateSyncEntryShapes } from '../commercial/sync-validation';
import {
  evaluateNodeUsageMutation,
  evaluateTreeUsageMutation,
  type UsageMutationDelta,
} from '../commercial/usage';
import {
  GetCommand,
  K,
  LinkItem,
  ProfileItem,
  QueryCommand,
  RecordItem,
  TransactWriteCommand,
} from '../db';
import {
  emitCommercialMetric,
  type CommercialMetricStage,
} from '../observability';

const STORES: ReadonlySet<string> = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);
const SAFE_MUTATION_GROUP_ID = /^[A-Za-z0-9:._/-]{1,160}$/;
const MUTATION_MARKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

interface ParsedMutationGroup {
  readonly id: string;
  readonly expectedCount: number;
  readonly records: readonly SyncRecord[];
}

interface MutationMarkerItem {
  readonly pk: string;
  readonly sk: `MUTATION#${string}`;
  readonly requestHash: string;
  readonly expectedCount: number;
  readonly result: { readonly outcome: 'applied'; readonly count: number };
  readonly createdAt: number;
  readonly ttl?: number;
}

interface RetainedMutationMarkerItem extends MutationMarkerItem {
  readonly ttl: number;
}

const PRE_TTL_MUTATION_MARKER_KEYS = [
  'pk',
  'sk',
  'requestHash',
  'expectedCount',
  'result',
  'createdAt',
] as const;
const RETAINED_MUTATION_MARKER_KEYS = [...PRE_TTL_MUTATION_MARKER_KEYS, 'ttl'] as const;

interface CommercialGroupRequest {
  readonly ownerSub: string;
  readonly group: ParsedMutationGroup;
  readonly requestHash: string;
  readonly syncedAt: number;
  readonly legacyClient: boolean;
}

function guardianLinkCondition(ctx: Ctx, link: LinkItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.link(link.minorId, link.guardianId),
      ConditionExpression:
        'attribute_exists(pk) AND linkId = :linkId AND guardianId = :guardianId AND minorId = :minorId AND #kind = :kind AND createdAt = :createdAt',
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':linkId': link.linkId,
        ':guardianId': link.guardianId,
        ':minorId': link.minorId,
        ':kind': link.kind,
        ':createdAt': link.createdAt,
      },
    },
  };
}

function exactWritableOwnerConditionChecks(ctx: Ctx, ownerId: string): TransactItem[] {
  const [profile, closure] = writableOwnerConditionChecks(ctx.deps, ownerId);
  if (!profile?.ConditionCheck || !closure) {
    throw new ApiError('CONFLICT', 'writable-owner guards are incomplete');
  }
  return [
    {
      ConditionCheck: {
        ...profile.ConditionCheck,
        ConditionExpression: `${profile.ConditionCheck.ConditionExpression} AND userId = :ownerSub`,
        ExpressionAttributeValues: {
          ...profile.ConditionCheck.ExpressionAttributeValues,
          ':ownerSub': ownerId,
        },
      },
    },
    closure,
  ];
}

interface TransactionCancellationClassification {
  recheckGuards: boolean;
}

function classifyTransactionCancellation(
  error: unknown,
): TransactionCancellationClassification | null {
  const cancellation = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  if (cancellation?.name === 'TransactionConflictException') {
    return { recheckGuards: true };
  }
  if (cancellation?.name !== 'TransactionCanceledException') return null;
  const reasons = cancellation.CancellationReasons;
  if (!Array.isArray(reasons)) return { recheckGuards: true };
  const retryableRace = reasons.every(
    (reason) =>
      reason.Code === 'None' ||
      reason.Code === 'ConditionalCheckFailed' ||
      reason.Code === 'TransactionConflict',
  );
  return {
    recheckGuards: retryableRace,
  };
}

function sameGuardianLink(expected: LinkItem, current: LinkItem): boolean {
  return (
    expected.linkId === current.linkId &&
    expected.guardianId === current.guardianId &&
    expected.minorId === current.minorId &&
    expected.kind === current.kind &&
    expected.createdAt === current.createdAt
  );
}

async function recheckWriteGuards(
  ctx: Ctx,
  ownerId: string,
  expectedLink?: LinkItem,
): Promise<void> {
  const caller = await requireWritableOwner(ctx, ctx.callerId);
  if (caller.userId !== ctx.callerId) throw new ApiError('CONFLICT');
  if (ownerId !== ctx.callerId) {
    const owner = await requireWritableOwner(ctx, ownerId);
    if (owner.userId !== ownerId) throw new ApiError('CONFLICT');
  }
  if (expectedLink) {
    const currentLink = await requireGuardianOfConsistent(ctx, ownerId);
    if (!sameGuardianLink(expectedLink, currentLink)) throw new ApiError('NOT_FOUND');
  }
}

function isValidWinner(
  winner: RecordItem,
  ownerId: string,
  store: SyncStore,
  recordId: string,
): boolean {
  const winnerRecord = winner.record as Partial<SyncBase>;
  return (
    winner.pk === K.user(ownerId) &&
    winner.sk === `REC#${store}#${recordId}` &&
    winner.owner === ownerId &&
    winner.store === store &&
    Number.isSafeInteger(winner.rev) &&
    Number.isSafeInteger(winner.updatedAt) &&
    winnerRecord.id === recordId &&
    winnerRecord.rev === winner.rev &&
    winnerRecord.updatedAt === winner.updatedAt
  );
}

function validateRecord(entry: SyncRecord): SyncBase {
  if (!entry || !STORES.has(entry.store)) throw new ApiError('VALIDATION', 'unknown store');
  const record = entry.record as SyncBase;
  if (
    typeof record?.id !== 'string' ||
    typeof record.rev !== 'number' ||
    typeof record.updatedAt !== 'number' ||
    typeof record.createdAt !== 'number'
  ) {
    throw new ApiError('VALIDATION', 'record is not SyncBase-shaped');
  }
  return record;
}

function validateV2Record(entry: SyncRecord): SyncBase {
  try {
    return validateRecord(entry);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VALIDATION') {
      throw new ApiError('SYNC_SCHEMA_INVALID', error.message);
    }
    throw error;
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function mutationKey(ownerId: string, groupId: string) {
  return { pk: K.user(ownerId), sk: `MUTATION#${groupId}` as const };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError('MUTATION_GROUP_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new ApiError('MUTATION_GROUP_INVALID');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function mutationHash(
  ownerId: string,
  group: ParsedMutationGroup,
  legacyClient: boolean,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: legacyClient
          ? 'roadmap2u.sync-mutation.v1-compat'
          : 'roadmap2u.sync-mutation.v2',
        ownerId,
        id: group.id,
        expectedCount: group.expectedCount,
        records: group.records,
      }),
    )
    .digest('hex');
}

function legacyMutationGroup(ownerId: string, entry: SyncRecord): ParsedMutationGroup {
  const record = validateRecord(entry);
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'roadmap2u.sync-mutation.v1-id',
        ownerId,
        store: entry.store,
        id: record.id,
        rev: record.rev,
        updatedAt: record.updatedAt,
      }),
    )
    .digest('hex');
  return { id: `legacy-${digest}`, expectedCount: 1, records: [entry] };
}

function legacyDependencyOrder(records: readonly SyncRecord[]): SyncRecord[] {
  const hearts = new Set(
    records.flatMap((entry) =>
      entry.store === 'trees' && typeof (entry.record as Tree).heartId === 'string'
        ? [(entry.record as Tree).heartId as string]
        : [],
    ),
  );
  const stagedNodes = new Map(
    records.flatMap((entry) =>
      entry.store === 'nodes'
        ? [[(entry.record as TreeNode).id, entry.record as TreeNode] as const]
        : [],
    ),
  );
  const depthMemo = new Map<string, number>();
  const nodeDepth = (node: TreeNode, path = new Set<string>()): number => {
    const cached = depthMemo.get(node.id);
    if (cached !== undefined) return cached;
    if (path.has(node.id)) return records.length + 1;
    if (node.parentId === null) return 0;
    const parent = stagedNodes.get(node.parentId);
    if (!parent) return 0;
    const nextPath = new Set(path).add(node.id);
    const depth = 1 + nodeDepth(parent, nextPath);
    depthMemo.set(node.id, depth);
    return depth;
  };
  const rank = (entry: SyncRecord): number => {
    if (entry.store === 'trees') return 0;
    if (entry.store === 'nodes') {
      const node = entry.record as TreeNode;
      return hearts.has(node.id) ? 1 : 2 + nodeDepth(node);
    }
    if (entry.store === 'preserves') return records.length + 3;
    if (entry.store === 'harvests') return records.length + 5;
    return records.length + 4;
  };
  return records
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ entry }) => entry);
}

function hasCommercialGrowth(delta: UsageMutationDelta): boolean {
  return (
    delta.outcome === 'applied' &&
    (delta.recordWasNew ||
      delta.physical.activeTrees > 0 ||
      delta.physical.visibleBranches > 0 ||
      delta.quota.activeTrees > 0 ||
      delta.quota.visibleBranches > 0)
  );
}

function markerPut(tableName: string, request: CommercialGroupRequest): TransactItem {
  const item: RetainedMutationMarkerItem = {
    ...mutationKey(request.ownerSub, request.group.id),
    requestHash: request.requestHash,
    expectedCount: request.group.expectedCount,
    result: { outcome: 'applied', count: request.group.records.length },
    createdAt: request.syncedAt,
    ttl: Math.ceil((request.syncedAt + MUTATION_MARKER_RETENTION_MS) / 1_000),
  };
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

function mutationMarkerFormat(
  marker: MutationMarkerItem,
): 'pre-ttl' | 'retained' | null {
  // Previously deployed pre-TTL writers may have produced six-field markers.
  // They remain retry receipts only; every new write uses the retained form.
  if (hasExactKeys(marker, PRE_TTL_MUTATION_MARKER_KEYS)) return 'pre-ttl';
  if (!hasExactKeys(marker, RETAINED_MUTATION_MARKER_KEYS)) return null;
  return Number.isSafeInteger(marker.ttl) &&
    marker.ttl === Math.ceil((marker.createdAt + MUTATION_MARKER_RETENTION_MS) / 1_000)
    ? 'retained'
    : null;
}

function isCanonicalMarker(
  marker: MutationMarkerItem,
  request: CommercialGroupRequest,
): boolean {
  return (
    mutationMarkerFormat(marker) !== null &&
    marker.pk === K.user(request.ownerSub) &&
    marker.sk === `MUTATION#${request.group.id}` &&
    marker.requestHash === request.requestHash &&
    marker.expectedCount === request.group.expectedCount &&
    hasExactKeys(marker.result, ['outcome', 'count']) &&
    marker.result.outcome === 'applied' &&
    marker.result.count === request.group.records.length &&
    Number.isSafeInteger(marker.createdAt) &&
    marker.createdAt >= 0
  );
}

function recordPut(
  tableName: string,
  ownerId: string,
  entry: SyncRecord,
  syncedAt: number,
): TransactItem {
  const record = validateRecord(entry);
  const item: RecordItem = {
    ...K.rec(ownerId, entry.store, record.id),
    gsi2pk: K.user(ownerId),
    gsi2sk: K.chg(syncedAt, record.id),
    owner: ownerId,
    store: entry.store,
    record: entry.record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt,
  };
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(pk) OR rev < :rev OR (rev = :rev AND updatedAt < :updatedAt)',
      ExpressionAttributeValues: { ':rev': record.rev, ':updatedAt': record.updatedAt },
    },
  };
}

function transactItemKey(item: TransactItem): string {
  const operation = item.Put ?? item.Update ?? item.ConditionCheck;
  const key = operation && ('Key' in operation ? operation.Key : operation.Item);
  const pk = key?.['pk'];
  const sk = key?.['sk'];
  if (typeof pk !== 'string' || typeof sk !== 'string') {
    throw new ApiError('CONFLICT', 'mutation transaction contains an invalid key');
  }
  return `${pk}\u0000${sk}`;
}

function assertMutationTransaction(
  items: readonly TransactItem[],
  guardianWrite: boolean,
): void {
  const maximum = guardianWrite ? 49 : 46;
  if (items.length > maximum || items.length > 100) {
    throw new ApiError('LIMIT_EXCEEDED', 'mutation transaction is too large');
  }
  const keys = items.map(transactItemKey);
  if (new Set(keys).size !== keys.length) {
    throw new ApiError('CONFLICT', 'mutation transaction contains duplicate keys');
  }
}

async function getStrong<T>(
  ctx: Ctx,
  key: { readonly pk: string; readonly sk: string },
): Promise<T | undefined> {
  const result = await ctx.deps.ddb.send(
    new GetCommand({ TableName: ctx.deps.table, Key: key, ConsistentRead: true }),
  );
  return result.Item as T | undefined;
}

const flagResolvers = new WeakMap<Ctx['deps'], CommercialFlagsResolver>();

function commercialMetricStage(): CommercialMetricStage | undefined {
  const explicit = process.env['COMMERCIAL_STAGE'];
  if (explicit === 'dev' || explicit === 'test' || explicit === 'prod') return explicit;
  const functionName = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  const inferred = /-(dev|test|prod)$/.exec(functionName ?? '')?.[1];
  return inferred === 'dev' || inferred === 'test' || inferred === 'prod'
    ? inferred
    : undefined;
}

async function readFlags(ctx: Ctx) {
  let resolver = flagResolvers.get(ctx.deps);
  if (!resolver) {
    resolver = new CommercialFlagsResolver({
      now: ctx.deps.now,
      readItem: () =>
        getStrong<Record<string, unknown>>(ctx, {
          pk: 'COMMERCIAL#CONFIG',
          sk: 'FLAGS',
        }),
      emitMetric: (metric) => {
        const stage = commercialMetricStage();
        if (stage) emitCommercialMetric(metric, stage);
      },
    });
    flagResolvers.set(ctx.deps, resolver);
  }
  return resolver.resolve();
}

function neutralDelta(treeId: string, recordWasNew: boolean): UsageMutationDelta {
  return {
    outcome: 'applied',
    treeId,
    recordWasNew,
    physical: { activeTrees: 0, visibleBranches: 0 },
    quota: { activeTrees: 0, visibleBranches: 0 },
    treeActivity: 'unchanged',
  };
}

function isCanonicalTreeUsage(
  value: Readonly<Record<string, unknown>> | undefined,
  ownerSub: string,
  treeId: string,
  generation: string,
): boolean {
  return (
    value?.['pk'] === K.user(ownerSub) &&
    value['sk'] === `USAGE#TREE#${treeId}` &&
    value['generation'] === generation &&
    typeof value['visibleBranches'] === 'number' &&
    Number.isSafeInteger(value['visibleBranches']) &&
    value['visibleBranches'] >= 0
  );
}

async function readCommercialGroupSnapshot(
  ctx: Ctx,
  request: CommercialGroupRequest,
): Promise<CommercialMutationSnapshot> {
  const recordCache = new Map<string, Promise<RecordItem | undefined>>();
  const loadStored = (store: SyncStore, id: string): Promise<RecordItem | undefined> => {
    const ref = `${store}\u0000${id}`;
    let pending = recordCache.get(ref);
    if (!pending) {
      pending = getStrong<RecordItem>(
        ctx,
        K.rec(request.ownerSub, store, id),
      );
      recordCache.set(ref, pending);
    }
    return pending;
  };
  const staged = new Map<string, SyncRecord>();
  for (const entry of request.group.records) {
    const record = validateRecord(entry);
    staged.set(`${entry.store}\u0000${record.id}`, entry);
  }
  const effectiveRecord = async <T extends SyncBase>(
    store: SyncStore,
    id: string,
  ): Promise<T | undefined> => {
    const incoming = staged.get(`${store}\u0000${id}`);
    if (incoming) return incoming.record as unknown as T;
    return (await loadStored(store, id))?.record as T | undefined;
  };

  const previous = new Map<string, RecordItem | undefined>();
  for (const entry of request.group.records) {
    const record = validateRecord(entry);
    previous.set(
      `${entry.store}\u0000${record.id}`,
      await loadStored(entry.store, record.id),
    );
  }

  if (!request.legacyClient) {
    try {
      await validateSyncBatch({
        ownerId: request.ownerSub,
        entries: request.group.records,
        heartPolicy: 'required',
        loadRecord: async (ownerId, store, id) => {
          if (ownerId !== request.ownerSub) throw new ApiError('CONFLICT');
          const item = await loadStored(store, id);
          if (!item) return undefined;
          return {
            owner: item.owner,
            store: item.store,
            record: item.record as unknown as Record<string, unknown>,
          };
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION') {
        throw new ApiError('SYNC_SCHEMA_INVALID', error.message);
      }
      throw error;
    }
  }

  const lwwOutcomes = request.group.records.map((entry) => {
    const incoming = validateRecord(entry);
    const winner = previous.get(`${entry.store}\u0000${incoming.id}`);
    if (winner && !isValidWinner(winner, request.ownerSub, entry.store, incoming.id)) {
      throw new ApiError('CONFLICT', 'stored sync winner is malformed');
    }
    return winner !== undefined && !lwwBeats(incoming, winner) ? 'stale' : 'applied';
  });
  if (lwwOutcomes.includes('stale')) {
    const [profile, closure] = await Promise.all([
      getStrong<ProfileItem>(ctx, K.profile(request.ownerSub)),
      getStrong<Record<string, unknown>>(ctx, accountClosureKey(request.ownerSub)),
    ]);
    return {
      profile,
      closure,
      grants: [],
      flags: { status: 'unavailable', reason: 'missing' },
      usageByTree: {},
      deltas: request.group.records.map((entry, index) => {
        const record = validateRecord(entry);
        const treeId =
          entry.store === 'trees'
            ? record.id
            : entry.store === 'nodes'
              ? (entry.record as TreeNode).treeId
              : `${entry.store}:${record.id}`;
        return {
          ...neutralDelta(
            treeId,
            previous.get(`${entry.store}\u0000${record.id}`) === undefined,
          ),
          outcome: lwwOutcomes[index],
        };
      }),
    };
  }

  const [profile, closure, accessSnapshot, usage, migration, flags] = await Promise.all([
    getStrong<ProfileItem>(ctx, K.profile(request.ownerSub)),
    getStrong<Record<string, unknown>>(ctx, accountClosureKey(request.ownerSub)),
    readStableAccessSnapshot(ctx.deps.ddb, ctx.deps.table, request.ownerSub),
    getStrong<Record<string, unknown>>(ctx, { pk: K.user(request.ownerSub), sk: 'USAGE' }),
    getStrong<Record<string, unknown>>(ctx, {
      pk: K.user(request.ownerSub),
      sk: 'USAGE_MIGRATION',
    }),
    readFlags(ctx),
  ]);

  const affectedTreeIds = new Set<string>();
  for (const entry of request.group.records) {
    if (entry.store === 'trees') affectedTreeIds.add((entry.record as Tree).id);
    if (entry.store === 'nodes') affectedTreeIds.add((entry.record as TreeNode).treeId);
  }
  const usageByTree: Record<string, Readonly<Record<string, unknown>> | undefined> = {};
  const generation = usage?.['activeGeneration'];
  if (typeof generation === 'string' && generation.trim().length > 0) {
    await Promise.all(
      [...affectedTreeIds].map(async (treeId) => {
        usageByTree[treeId] = await getStrong<Record<string, unknown>>(ctx, {
          pk: K.user(request.ownerSub),
          sk: `USAGE#TREE#${treeId}`,
        });
      }),
    );
  }

  const treeContexts = new Map<
    string,
    { tree: Tree; previous?: Tree; heart: HeartInspection }
  >();
  for (const treeId of affectedTreeIds) {
    const tree = await effectiveRecord<Tree>('trees', treeId);
    if (!tree) throw new ApiError('CONFLICT', 'owning tree disappeared');
    const previousTree = (await loadStored('trees', treeId))?.record as Tree | undefined;
    if (typeof generation === 'string' && generation.trim().length > 0) {
      const counter = usageByTree[treeId];
      if (previousTree) {
        if (!isCanonicalTreeUsage(counter, request.ownerSub, treeId, generation)) {
          throw new ApiError('CONFLICT', 'usage drift');
        }
      } else if (counter !== undefined) {
        throw new ApiError('CONFLICT', 'new tree usage counter already exists');
      }
    }
    const heartNode =
      typeof tree.heartId === 'string'
        ? await effectiveRecord<TreeNode>('nodes', tree.heartId)
        : undefined;
    const nodes = heartNode
      ? [{ ownerSub: request.ownerSub, record: heartNode }]
      : [];
    const heart = previousTree
      ? inspectHeartTransition({
          kind: 'update',
          ownerSub: request.ownerSub,
          previousTree,
          incomingTree: tree,
          nodes,
        })
      : inspectHeartTransition({
          kind: 'create',
          ownerSub: request.ownerSub,
          incomingTree: tree,
          nodes,
        });
    treeContexts.set(treeId, { tree, previous: previousTree, heart });
  }

  const deltas = request.group.records.map((entry) => {
    const incoming = validateRecord(entry);
    const stored = previous.get(`${entry.store}\u0000${incoming.id}`);
    if (entry.store === 'nodes') {
      const node = entry.record as TreeNode;
      const context = treeContexts.get(node.treeId);
      if (!context) throw new ApiError('CONFLICT', 'owning tree disappeared');
      return {
        ...evaluateNodeUsageMutation({
          previous: stored?.record as TreeNode | undefined,
          incoming: node,
          tree: context.tree,
          heart: context.heart,
        }),
        treeCounter: 'existing' as const,
      };
    }
    if (entry.store !== 'trees') {
      return neutralDelta(`${entry.store}:${incoming.id}`, stored === undefined);
    }
    const counter = usageByTree[incoming.id];
    const latentVisibleBranches =
      counter !== undefined &&
      counter['generation'] === generation &&
      typeof counter['visibleBranches'] === 'number' &&
      Number.isSafeInteger(counter['visibleBranches']) &&
      counter['visibleBranches'] >= 0
        ? counter['visibleBranches']
        : 0;
    return {
      ...evaluateTreeUsageMutation({
        previous: stored?.record as Tree | undefined,
        incoming: entry.record as Tree,
        latentVisibleBranches,
      }),
      treeCounter: stored === undefined ? ('create' as const) : ('existing' as const),
    };
  });
  if (
    request.legacyClient &&
    !deltas.some((delta) => delta.outcome === 'stale') &&
    deltas.some(hasCommercialGrowth) &&
    flags.status === 'available' &&
    (flags.flags.quotaMode === 'enforce' || flags.flags.capabilityMode === 'enforce')
  ) {
    throw new ApiError('SYNC_CLIENT_UPGRADE_REQUIRED');
  }

  return {
    profile,
    closure,
    access: accessSnapshot.access,
    grants: accessSnapshot.grants,
    flags,
    usage,
    usageByTree,
    migration,
    deltas,
  };
}

async function applyV2Group(
  ctx: Ctx,
  ownerId: string,
  group: ParsedMutationGroup,
  expectedGuardianLink?: LinkItem,
  legacyClient = false,
): Promise<SyncPushResponse> {
  const request: CommercialGroupRequest = {
    ownerSub: ownerId,
    group,
    requestHash: mutationHash(ownerId, group, legacyClient),
    syncedAt: ctx.deps.now(),
    legacyClient,
  };
  const existingMarker = await getStrong<MutationMarkerItem>(
    ctx,
    mutationKey(ownerId, group.id),
  );
  if (existingMarker) {
    if (!isCanonicalMarker(existingMarker, request)) {
      throw new ApiError('MUTATION_GROUP_INVALID');
    }
    await recheckWriteGuards(ctx, ownerId, expectedGuardianLink);
    return {
      applied: group.records.map((entry) => validateRecord(entry).id),
      rejected: [],
      serverRecords: [],
    };
  }
  const accessResolver = createDynamoAccessResolver({
    ddb: ctx.deps.ddb,
    tableName: ctx.deps.table,
    now: ctx.deps.now,
  });
  const writer = new CommercialMutationWriter<CommercialGroupRequest>({
    tableName: ctx.deps.table,
    now: ctx.deps.now,
    readSnapshot: (current) => readCommercialGroupSnapshot(ctx, current),
    resolveFreshAccess: async (ownerSub) =>
      (await accessResolver.resolveFresh(ownerSub)).access,
    commit: async (current, proposal: MutationCommitProposal) => {
      const guardianWrite = current.ownerSub !== ctx.callerId;
      if (guardianWrite && !expectedGuardianLink) throw new ApiError('NOT_FOUND');
      const items: TransactItem[] = [
        markerPut(ctx.deps.table, current),
        ...current.group.records.map((entry) =>
          recordPut(ctx.deps.table, current.ownerSub, entry, current.syncedAt),
        ),
        ...proposal.items,
        ...(guardianWrite
          ? [
              ...exactWritableOwnerConditionChecks(ctx, ctx.callerId),
              ...(expectedGuardianLink
                ? [guardianLinkCondition(ctx, expectedGuardianLink)]
                : []),
            ]
          : []),
      ];
      assertMutationTransaction(items, guardianWrite);
      try {
        await ctx.deps.ddb.send(
          new TransactWriteCommand({
            TransactItems: items,
          }),
        );
        return 'committed';
      } catch (error) {
        const cancellation = classifyTransactionCancellation(error);
        if (!cancellation?.recheckGuards) throw error;
        const concurrentMarker = await getStrong<MutationMarkerItem>(
          ctx,
          mutationKey(current.ownerSub, current.group.id),
        );
        if (concurrentMarker) {
          if (!isCanonicalMarker(concurrentMarker, current)) {
            throw new ApiError('MUTATION_GROUP_INVALID');
          }
          await recheckWriteGuards(ctx, current.ownerSub, expectedGuardianLink);
          return 'committed';
        }
        await recheckWriteGuards(ctx, current.ownerSub, expectedGuardianLink);
        return 'conflict';
      }
    },
    emitDecision: () => undefined,
  });

  const result = await writer.write(request);
  if (result.outcome === 'stale') {
    const latestWinners = await Promise.all(
      group.records.map((entry) => {
        const record = validateRecord(entry);
        return getStrong<RecordItem>(ctx, K.rec(ownerId, entry.store, record.id));
      }),
    );
    if (ownerId !== ctx.callerId) {
      await recheckWriteGuards(ctx, ownerId, expectedGuardianLink);
    }
    const serverRecords: SyncRecord[] = [];
    result.deltas.forEach((delta, index) => {
      const entry = group.records[index];
      const record = validateRecord(entry);
      const winner = latestWinners[index];
      if (winner) {
        if (!isValidWinner(winner, ownerId, entry.store, record.id)) {
          throw new ApiError('CONFLICT', 'stored sync winner is malformed');
        }
        serverRecords.push({ store: winner.store, record: winner.record });
      }
      if (delta.outcome === 'stale') {
        if (!winner || lwwBeats(record, winner)) {
          throw new ApiError('CONFLICT', 'stale winner changed during evaluation');
        }
      }
    });
    return {
      applied: [],
      rejected: group.records.map((entry) => ({
        id: validateRecord(entry).id,
        reason: 'STALE_REV' as const,
      })),
      serverRecords,
    };
  }
  return {
    applied: group.records.map((entry) => validateRecord(entry).id),
    rejected: [],
    serverRecords: [],
  };
}

async function pushInto(
  ctx: Ctx,
  ownerId: string,
  req: SyncPushPayload,
  expectedGuardianLink?: LinkItem,
): Promise<SyncPushResponse> {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new ApiError('VALIDATION');
  }
  if (!Number.isSafeInteger(req.schemaVersion) || req.schemaVersion < 0) {
    throw new ApiError('VALIDATION');
  }
  if (req.schemaVersion > SCHEMA_VERSION) {
    throw new ApiError('SYNC_TOO_OLD');
  }
  if ('contractVersion' in req || 'mutationGroups' in req) {
    if (
      !hasExactKeys(req, ['schemaVersion', 'contractVersion', 'mutationGroups']) ||
      (req as { contractVersion?: unknown }).contractVersion !== CONTRACT_VERSION ||
      !Array.isArray(req.mutationGroups) ||
      req.mutationGroups.length === 0
    ) {
      throw new ApiError('MUTATION_GROUP_INVALID');
    }
    const groupIds = new Set<string>();
    const responseIds = new Set<string>();
    let totalRecords = 0;
    for (const group of req.mutationGroups) {
      if (
        !hasExactKeys(group, ['id', 'expectedCount', 'records']) ||
        typeof group?.id !== 'string' ||
        !SAFE_MUTATION_GROUP_ID.test(group.id) ||
        groupIds.has(group.id) ||
        !Number.isSafeInteger(group?.expectedCount) ||
        group.expectedCount < 1 ||
        group.expectedCount > LIMITS.syncMutationGroupMax ||
        !Array.isArray(group?.records) ||
        group.records.length !== group.expectedCount
      ) {
        throw new ApiError('MUTATION_GROUP_INVALID');
      }
      groupIds.add(group.id);
      totalRecords += group.records.length;
      for (const entry of group.records) {
        const record = validateV2Record(entry);
        if (responseIds.has(record.id)) throw new ApiError('MUTATION_GROUP_INVALID');
        responseIds.add(record.id);
      }
    }
    if (totalRecords > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED');
    try {
      validateSyncEntryShapes(req.mutationGroups.flatMap((group) => group.records));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION') {
        throw new ApiError('SYNC_SCHEMA_INVALID', error.message);
      }
      throw error;
    }
    const response: SyncPushResponse = { applied: [], rejected: [], serverRecords: [] };
    for (const group of req.mutationGroups) {
      const result = await applyV2Group(ctx, ownerId, group, expectedGuardianLink);
      response.applied.push(...result.applied);
      response.rejected.push(...result.rejected);
      response.serverRecords.push(...result.serverRecords);
    }
    return response;
  }
  if (!Array.isArray(req.records)) throw new ApiError('VALIDATION');
  if (req.records.length > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED', `max ${LIMITS.syncPushMax} records per push`);
  if (req.records.length === 0) {
    await recheckWriteGuards(ctx, ownerId, expectedGuardianLink);
    return { applied: [], rejected: [], serverRecords: [] };
  }

  await validateSyncBatch({
    ownerId,
    entries: req.records,
    heartPolicy: 'compatible',
    loadRecord: async (validatedOwnerId, store, id) => {
      const stored = await getStrong<RecordItem>(ctx, K.rec(validatedOwnerId, store, id));
      if (!stored) return undefined;
      return {
        owner: stored.owner,
        store: stored.store,
        record: stored.record as unknown as Record<string, unknown>,
      };
    },
  });
  const results = new Map<string, SyncPushResponse>();
  for (const entry of legacyDependencyOrder(req.records)) {
    const record = validateRecord(entry);
    const result = await applyV2Group(
      ctx,
      ownerId,
      legacyMutationGroup(ownerId, entry),
      expectedGuardianLink,
      true,
    );
    results.set(`${entry.store}\u0000${record.id}`, result);
  }
  const response: SyncPushResponse = { applied: [], rejected: [], serverRecords: [] };
  for (const entry of req.records) {
    const record = validateRecord(entry);
    const result = results.get(`${entry.store}\u0000${record.id}`);
    if (!result) throw new ApiError('CONFLICT', 'legacy mutation result is missing');
    response.applied.push(...result.applied);
    response.rejected.push(...result.rejected);
    response.serverRecords.push(...result.serverRecords);
  }
  return response;
}

export async function pushSync(ctx: Ctx, body: SyncPushPayload): Promise<SyncPushResponse> {
  return pushInto(ctx, ctx.callerId, body);
}

/** Guardian write-through (co-gardening) — either link kind may edit. */
export async function pushSyncFor(
  ctx: Ctx,
  minorId: string,
  body: SyncPushPayload,
): Promise<SyncPushResponse> {
  const link = await requireGuardianOf(ctx, minorId);
  return pushInto(ctx, minorId, body, link);
}

export async function getSyncChanges(ctx: Ctx, cursor?: string): Promise<SyncChangesResponse> {
  const page = 200;
  const out = await ctx.deps.ddb.send(
    new QueryCommand({
      TableName: ctx.deps.table,
      IndexName: 'gsi2',
      KeyConditionExpression: cursor
        ? 'gsi2pk = :pk AND gsi2sk > :after'
        : 'gsi2pk = :pk AND begins_with(gsi2sk, :prefix)',
      ExpressionAttributeValues: cursor
        ? { ':pk': K.user(ctx.callerId), ':after': cursor }
        : { ':pk': K.user(ctx.callerId), ':prefix': 'CHG#' },
      Limit: page,
    }),
  );
  const items = (out.Items ?? []) as RecordItem[];
  return {
    changes: items.map((i) => ({ store: i.store, record: i.record })),
    cursor: items.length ? items[items.length - 1].gsi2sk : (cursor ?? ''),
    more: !!out.LastEvaluatedKey,
  };
}
