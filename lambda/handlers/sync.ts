import {
  ApiError,
  LIMITS,
  SyncChangesResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncRecord,
  SyncStore,
} from '@app/api/contracts';
import { SCHEMA_VERSION, SyncBase } from '@app/db/schema';
import { Ctx, requireGuardianOf } from '../authz';
import { K, PutCommand, QueryCommand, RecordItem, getItem } from '../db';

const STORES: ReadonlySet<string> = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);

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

async function pushInto(ctx: Ctx, ownerId: string, req: SyncPushRequest): Promise<SyncPushResponse> {
  if (!Array.isArray(req.records)) throw new ApiError('VALIDATION');
  if (req.records.length > LIMITS.syncPushMax) throw new ApiError('LIMIT_EXCEEDED', `max ${LIMITS.syncPushMax} records per push`);
  if (typeof req.schemaVersion !== 'number' || req.schemaVersion > SCHEMA_VERSION) {
    throw new ApiError('SYNC_TOO_OLD');
  }

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
        new PutCommand({
          TableName: ctx.deps.table,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(pk) OR rev < :rev OR (rev = :rev AND updatedAt < :updatedAt)',
          ExpressionAttributeValues: { ':rev': record.rev, ':updatedAt': record.updatedAt },
        }),
      );
      applied.push(record.id);
    } catch (error) {
      if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
      rejected.push({ id: record.id, reason: 'STALE_REV' });
      const winner = await getItem<RecordItem>(ctx.deps, key);
      if (winner) serverRecords.push({ store: winner.store, record: winner.record });
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
  await requireGuardianOf(ctx, minorId);
  return pushInto(ctx, minorId, body);
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
