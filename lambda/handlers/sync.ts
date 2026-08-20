import {
  ApiError,
  LIMITS,
  SyncChangesResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncRecord,
  SyncStore,
  lwwBeats,
} from '@app/api/contracts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { SCHEMA_VERSION, SyncBase } from '@app/db/schema';
import {
  Ctx,
  requireGuardianOf,
  requireGuardianOfConsistent,
  requireWritableOwner,
  writableOwnerConditionChecks,
} from '../authz';
import { validateSyncBatch } from '../commercial/sync-validation';
import {
  GetCommand,
  K,
  LinkItem,
  QueryCommand,
  RecordItem,
  TransactWriteCommand,
  getItem,
} from '../db';

const STORES: ReadonlySet<string> = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function guardianLinkCondition(ctx: Ctx, link: LinkItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.link(link.minorId, link.guardianId),
      ConditionExpression:
        'attribute_exists(pk) AND guardianId = :guardianId AND minorId = :minorId AND #kind = :kind AND createdAt = :createdAt',
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':guardianId': link.guardianId,
        ':minorId': link.minorId,
        ':kind': link.kind,
        ':createdAt': link.createdAt,
      },
    },
  };
}

function writeGuards(ctx: Ctx, ownerId: string, link?: LinkItem): TransactItem[] {
  const guards = writableOwnerConditionChecks(ctx.deps, ctx.callerId);
  if (ownerId !== ctx.callerId) guards.push(...writableOwnerConditionChecks(ctx.deps, ownerId));
  if (link) guards.push(guardianLinkCondition(ctx, link));
  return guards;
}

interface TransactionCancellationClassification {
  recheckGuards: boolean;
  canBeStale: boolean;
}

function classifyTransactionCancellation(
  error: unknown,
): TransactionCancellationClassification | null {
  const cancellation = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  if (cancellation?.name !== 'TransactionCanceledException') return null;
  const reasons = cancellation.CancellationReasons;
  if (!Array.isArray(reasons)) return { recheckGuards: true, canBeStale: false };
  const onlyConditions = reasons.every(
    (reason) => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed',
  );
  return {
    recheckGuards: onlyConditions,
    canBeStale:
      onlyConditions && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed'),
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
  await requireWritableOwner(ctx, ctx.callerId);
  if (ownerId !== ctx.callerId) await requireWritableOwner(ctx, ownerId);
  if (expectedLink) {
    const currentLink = await requireGuardianOfConsistent(ctx, ownerId);
    if (!sameGuardianLink(expectedLink, currentLink)) throw new ApiError('NOT_FOUND');
  }
}

async function getConsistentRecord(
  ctx: Ctx,
  key: ReturnType<typeof K.rec>,
): Promise<RecordItem | null> {
  const result = await ctx.deps.ddb.send(
    new GetCommand({
      TableName: ctx.deps.table,
      Key: key,
      ConsistentRead: true,
    }),
  );
  return (result.Item as RecordItem | undefined) ?? null;
}

function isValidWinner(
  winner: RecordItem,
  ownerId: string,
  store: SyncStore,
  recordId: string,
): boolean {
  const winnerRecord = winner.record as Partial<SyncBase>;
  return (
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

async function pushInto(
  ctx: Ctx,
  ownerId: string,
  req: SyncPushRequest,
  expectedGuardianLink?: LinkItem,
): Promise<SyncPushResponse> {
  if (!Array.isArray(req.records)) throw new ApiError('VALIDATION');
  if (req.records.length > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED', `max ${LIMITS.syncPushMax} records per push`);
  if (typeof req.schemaVersion !== 'number' || req.schemaVersion > SCHEMA_VERSION) {
    throw new ApiError('SYNC_TOO_OLD');
  }

  await validateSyncBatch({
    ownerId,
    entries: req.records,
    heartPolicy: 'compatible',
    loadRecord: async (validatedOwnerId, store, id) => {
      const stored = await getItem<RecordItem>(ctx.deps, K.rec(validatedOwnerId, store, id));
      if (!stored) return undefined;
      return {
        owner: stored.owner,
        store: stored.store,
        record: stored.record as unknown as Record<string, unknown>,
      };
    },
  });

  const applied: string[] = [];
  const rejected: { id: string; reason: 'STALE_REV' }[] = [];
  const serverRecords: SyncRecord[] = [];
  const syncedAt = ctx.deps.now();

  for (const entry of req.records) {
    const record = validateRecord(entry);
    const key = K.rec(ownerId, entry.store, record.id);
    const item: RecordItem = {
      ...key,
      gsi2pk: K.user(ownerId),
      gsi2sk: K.chg(syncedAt, record.id),
      owner: ownerId,
      store: entry.store,
      record: entry.record,
      rev: record.rev,
      updatedAt: record.updatedAt,
      syncedAt,
    };
    try {
      // contracts.lwwBeats as a condition expression: rev first, updatedAt
      // breaks equal revs, exact ties keep the stored copy (reject).
      await ctx.deps.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: ctx.deps.table,
                Item: item,
                ConditionExpression:
                  'attribute_not_exists(pk) OR rev < :rev OR (rev = :rev AND updatedAt < :updatedAt)',
                ExpressionAttributeValues: { ':rev': record.rev, ':updatedAt': record.updatedAt },
              },
            },
            ...writeGuards(ctx, ownerId, expectedGuardianLink),
          ],
        }),
      );
      applied.push(record.id);
    } catch (error) {
      const cancellation = classifyTransactionCancellation(error);
      if (!cancellation?.recheckGuards) throw error;
      await recheckWriteGuards(ctx, ownerId, expectedGuardianLink);
      if (!cancellation.canBeStale) throw error;
      const winner = await getConsistentRecord(ctx, key);
      if (
        !winner ||
        !isValidWinner(winner, ownerId, entry.store, record.id) ||
        lwwBeats(record, winner)
      ) {
        throw error;
      }
      rejected.push({ id: record.id, reason: 'STALE_REV' });
      serverRecords.push({ store: winner.store, record: winner.record });
    }
  }
  return { applied, rejected, serverRecords };
}

export async function pushSync(ctx: Ctx, body: SyncPushRequest): Promise<SyncPushResponse> {
  return pushInto(ctx, ctx.callerId, body);
}

/** Guardian write-through (co-gardening) — either link kind may edit. */
export async function pushSyncFor(
  ctx: Ctx,
  minorId: string,
  body: SyncPushRequest,
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
