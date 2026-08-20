import { ApiError, SyncStore } from '@app/api/contracts';

/** Technical storage-safety caps. These are independent from Free/Premium quota. */
export const SYNC_VALIDATION_LIMITS = Object.freeze({
  maxRecordBytes: 32 * 1024,
  maxIdBytes: 256,
  maxShortTextBytes: 1024,
  maxLongTextBytes: 16 * 1024,
  maxArrayItems: 7,
});

export interface StoredSyncRecord {
  owner: string;
  store: SyncStore;
  record: Record<string, unknown>;
}

export type SyncValidationLookup = (
  ownerId: string,
  store: SyncStore,
  id: string,
) => Promise<StoredSyncRecord | undefined>;

export interface SyncValidationRequest {
  /** Server-derived owner. It must never come from the sync payload. */
  ownerId: string;
  /** The complete mutation batch, so staged tree/node references can be checked together. */
  entries: readonly unknown[];
  /** Loads only from the requested owner's partition; results are checked defensively. */
  loadRecord: SyncValidationLookup;
  /** `required` requires a visible heart for each newly-created active tree. */
  heartPolicy?: 'compatible' | 'required';
}

type RawRecord = Record<string, unknown>;

const STORES = new Set<SyncStore>([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);
const BASE_FIELDS = ['id', 'createdAt', 'updatedAt', 'rev', 'deletedAt'] as const;
const ACCENTS = new Set(['moss', 'sage', 'sky', 'clay', 'lavender', 'sand', 'rose', 'pine']);
const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const SHAPES: Record<SyncStore, { required: readonly string[]; optional: readonly string[] }> = {
  trees: {
    required: [...BASE_FIELDS, 'name', 'accent', 'order', 'currentNodeId', 'archivedAt'],
    optional: ['heartId'],
  },
  nodes: {
    required: [
      ...BASE_FIELDS,
      'treeId',
      'parentId',
      'title',
      'note',
      'status',
      'order',
      'targetDate',
      'achievedAt',
      'branchedAt',
      'origin',
      'archivedAt',
    ],
    optional: [
      'trigger',
      'estimateMin',
      'flow',
      'repeatsDaily',
      'repeats',
      'repeatsSetAt',
      'remindAt',
      'priority',
    ],
  },
  checkins: {
    required: [...BASE_FIELDS, 'feeling', 'note', 'treeId', 'nodeId'],
    optional: ['energy'],
  },
  sessions: {
    required: [...BASE_FIELDS, 'nodeId', 'startedAt', 'plannedMinutes', 'endedAt', 'note'],
    optional: ['pausedAt', 'pausedMs'],
  },
  harvests: {
    required: [
      ...BASE_FIELDS,
      'nodeId',
      'treeId',
      'treeName',
      'accent',
      'title',
      'harvestedAt',
    ],
    optional: ['preserveId'],
  },
  preserves: {
    required: [...BASE_FIELDS, 'name', 'madeAt', 'accent', 'tint', 'tintEdge'],
    // kind is optional for pre-v9 records; the other fields are additive too.
    optional: [
      'kind',
      'size',
      'premio',
      'savedFor',
      'openedAt',
      'plannedAt',
      'sealedAt',
      'carry',
      'treeId',
    ],
  },
};

function invalid(message: string): never {
  throw new ApiError('VALIDATION', message);
}

function isPlainRecord(value: unknown): value is RawRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(record: RawRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function stringField(
  record: RawRecord,
  field: string,
  maxBytes: number,
  options: { nullable?: boolean; optional?: boolean; nonEmpty?: boolean } = {},
): string | null | undefined {
  if (!has(record, field)) {
    if (options.optional) return undefined;
    return invalid(`${field} is required`);
  }
  const value = record[field];
  if (value === null && options.nullable) return null;
  if (typeof value !== 'string') return invalid(`${field} must be a string`);
  if (options.nonEmpty && value.length === 0) return invalid(`${field} must not be empty`);
  if (byteLength(value) > maxBytes) return invalid(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function enumField(
  record: RawRecord,
  field: string,
  values: ReadonlySet<string>,
  options: { nullable?: boolean; optional?: boolean } = {},
): string | null | undefined {
  const value = stringField(record, field, SYNC_VALIDATION_LIMITS.maxShortTextBytes, options);
  if (value === undefined || value === null) return value;
  if (!values.has(value)) return invalid(`${field} has an unsupported value`);
  return value;
}

function integerField(
  record: RawRecord,
  field: string,
  options: { nullable?: boolean; optional?: boolean; min?: number } = {},
): number | null | undefined {
  if (!has(record, field)) {
    if (options.optional) return undefined;
    return invalid(`${field} is required`);
  }
  const value = record[field];
  if (value === null && options.nullable) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalid(`${field} must be a safe integer`);
  }
  if (options.min !== undefined && value < options.min) return invalid(`${field} is below its minimum`);
  return value;
}

function booleanField(record: RawRecord, field: string, optional = false): boolean | undefined {
  if (!has(record, field)) {
    if (optional) return undefined;
    return invalid(`${field} is required`);
  }
  if (typeof record[field] !== 'boolean') return invalid(`${field} must be boolean`);
  return record[field] as boolean;
}

function nullableTimestamp(record: RawRecord, field: string, optional = false): void {
  integerField(record, field, { nullable: true, optional, min: 0 });
}

function validateBase(record: RawRecord): void {
  stringField(record, 'id', SYNC_VALIDATION_LIMITS.maxIdBytes, { nonEmpty: true });
  integerField(record, 'createdAt', { min: 0 });
  integerField(record, 'updatedAt', { min: 0 });
  integerField(record, 'rev', { min: 1 });
  nullableTimestamp(record, 'deletedAt');
}

function exactShape(store: SyncStore, record: RawRecord): void {
  const shape = SHAPES[store];
  const allowed = new Set([...shape.required, ...shape.optional]);
  for (const field of shape.required) {
    if (!has(record, field)) invalid(`${store}.${field} is required`);
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) invalid(`${store}.${field} is not allowed`);
  }
}

function validateTree(record: RawRecord): void {
  stringField(record, 'name', SYNC_VALIDATION_LIMITS.maxShortTextBytes);
  enumField(record, 'accent', ACCENTS);
  integerField(record, 'order');
  stringField(record, 'currentNodeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nullable: true });
  nullableTimestamp(record, 'archivedAt');
  stringField(record, 'heartId', SYNC_VALIDATION_LIMITS.maxIdBytes, {
    nullable: true,
    optional: true,
    nonEmpty: true,
  });
}

function validateRepeats(record: RawRecord): void {
  if (!has(record, 'repeats')) return;
  const repeats = record.repeats;
  if (repeats === null || repeats === 'daily' || repeats === 'weekly') return;
  if (!Array.isArray(repeats)) invalid('repeats must be a cadence or weekday array');
  if (repeats.length === 0 || repeats.length > SYNC_VALIDATION_LIMITS.maxArrayItems) {
    invalid('repeats must contain 1 to 7 weekdays');
  }
  if (repeats.some((day) => typeof day !== 'string' || !WEEKDAYS.has(day))) {
    invalid('repeats contains an unsupported weekday');
  }
  if (new Set(repeats).size !== repeats.length) invalid('repeats contains duplicate weekdays');
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysByMonth[month - 1];
}

function validateNode(record: RawRecord): void {
  stringField(record, 'treeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nonEmpty: true });
  stringField(record, 'parentId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nullable: true, nonEmpty: true });
  stringField(record, 'title', SYNC_VALIDATION_LIMITS.maxShortTextBytes);
  stringField(record, 'note', SYNC_VALIDATION_LIMITS.maxLongTextBytes);
  enumField(record, 'status', new Set(['seed', 'growing', 'resting', 'achieved', 'branched']));
  integerField(record, 'order');
  const targetDate = stringField(record, 'targetDate', 10, { nullable: true });
  if (typeof targetDate === 'string' && !isCalendarDate(targetDate)) {
    invalid('targetDate must be a real YYYY-MM-DD calendar date');
  }
  nullableTimestamp(record, 'achievedAt');
  nullableTimestamp(record, 'branchedAt');
  enumField(record, 'origin', new Set(['planned', 'branch']));
  nullableTimestamp(record, 'archivedAt');
  stringField(record, 'trigger', SYNC_VALIDATION_LIMITS.maxLongTextBytes, { nullable: true, optional: true });
  if (has(record, 'estimateMin')) {
    const estimate = integerField(record, 'estimateMin', { nullable: true, optional: true, min: 0 });
    if (estimate !== null && estimate !== undefined && ![2, 10, 30, 60, 1440, 10080].includes(estimate)) {
      invalid('estimateMin has an unsupported value');
    }
  }
  enumField(record, 'flow', new Set(['free', 'steps']), { optional: true });
  booleanField(record, 'repeatsDaily', true);
  validateRepeats(record);
  nullableTimestamp(record, 'repeatsSetAt', true);
  const remindAt = stringField(record, 'remindAt', 5, { nullable: true, optional: true });
  if (remindAt !== null && remindAt !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(remindAt)) {
    invalid('remindAt must use HH:MM');
  }
  enumField(record, 'priority', new Set(['sunlit', 'shade']), { nullable: true, optional: true });
}

function validateCheckin(record: RawRecord): void {
  enumField(record, 'feeling', new Set(['sunny', 'calm', 'foggy', 'heavy', 'stormy']));
  stringField(record, 'note', SYNC_VALIDATION_LIMITS.maxLongTextBytes);
  stringField(record, 'treeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nullable: true, nonEmpty: true });
  stringField(record, 'nodeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nullable: true, nonEmpty: true });
  enumField(record, 'energy', new Set(['llena', 'media', 'bajita']), { nullable: true, optional: true });
}

function validateSession(record: RawRecord): void {
  stringField(record, 'nodeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nullable: true, nonEmpty: true });
  integerField(record, 'startedAt', { min: 0 });
  integerField(record, 'plannedMinutes', { min: 1 });
  nullableTimestamp(record, 'endedAt');
  stringField(record, 'note', SYNC_VALIDATION_LIMITS.maxLongTextBytes);
  nullableTimestamp(record, 'pausedAt', true);
  integerField(record, 'pausedMs', { optional: true, min: 0 });
}

function validateHarvest(record: RawRecord): void {
  stringField(record, 'nodeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nonEmpty: true });
  stringField(record, 'treeId', SYNC_VALIDATION_LIMITS.maxIdBytes, { nonEmpty: true });
  stringField(record, 'treeName', SYNC_VALIDATION_LIMITS.maxShortTextBytes);
  enumField(record, 'accent', ACCENTS);
  stringField(record, 'title', SYNC_VALIDATION_LIMITS.maxShortTextBytes);
  integerField(record, 'harvestedAt', { min: 0 });
  stringField(record, 'preserveId', SYNC_VALIDATION_LIMITS.maxIdBytes, {
    nullable: true,
    optional: true,
    nonEmpty: true,
  });
}

function validatePreserve(record: RawRecord): void {
  enumField(record, 'kind', new Set(['mermelada', 'elixir']), { optional: true });
  stringField(record, 'name', SYNC_VALIDATION_LIMITS.maxShortTextBytes);
  integerField(record, 'madeAt', { min: 0 });
  enumField(record, 'accent', ACCENTS, { nullable: true });
  for (const field of ['tint', 'tintEdge']) {
    const color = stringField(record, field, 7);
    if (typeof color !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
      invalid(`${field} must be an opaque #RGB or #RRGGBB color`);
    }
  }
  enumField(record, 'size', new Set(['frasquito', 'frasco', 'frascote']), { optional: true });
  for (const field of ['premio', 'savedFor', 'carry']) {
    stringField(record, field, SYNC_VALIDATION_LIMITS.maxLongTextBytes, {
      nullable: true,
      optional: true,
    });
  }
  for (const field of ['openedAt', 'plannedAt', 'sealedAt']) nullableTimestamp(record, field, true);
  stringField(record, 'treeId', SYNC_VALIDATION_LIMITS.maxIdBytes, {
    nullable: true,
    optional: true,
    nonEmpty: true,
  });
}

function parseEntry(value: unknown): { store: SyncStore; record: RawRecord } {
  if (!isPlainRecord(value)) invalid('sync entry must be a plain object');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('store') || !keys.includes('record')) {
    invalid('sync entry must contain only store and record');
  }
  if (typeof value.store !== 'string' || !STORES.has(value.store as SyncStore)) {
    invalid('unknown sync store');
  }
  if (!isPlainRecord(value.record)) invalid('sync record must be a plain object');
  const store = value.store as SyncStore;
  const record = value.record;
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return invalid('sync record is not JSON serializable');
  }
  if (byteLength(serialized) > SYNC_VALIDATION_LIMITS.maxRecordBytes) {
    invalid(`sync record exceeds ${SYNC_VALIDATION_LIMITS.maxRecordBytes} UTF-8 bytes`);
  }
  exactShape(store, record);
  validateBase(record);
  ({
    trees: validateTree,
    nodes: validateNode,
    checkins: validateCheckin,
    sessions: validateSession,
    harvests: validateHarvest,
    preserves: validatePreserve,
  } satisfies Record<SyncStore, (record: RawRecord) => void>)[store](record);
  return { store, record };
}

type ParsedEntry = ReturnType<typeof parseEntry>;

function recordKey(store: SyncStore, id: string): string {
  return `${store}\u0000${id}`;
}

function immutableValue(record: RawRecord, field: string): unknown {
  if (field === 'kind') return record.kind ?? 'mermelada';
  if (field === 'treeId' && !has(record, field)) return null;
  return record[field];
}

function validateImmutables(store: SyncStore, incoming: RawRecord, stored: RawRecord): void {
  const storeFields: Record<SyncStore, readonly string[]> = {
    trees: ['createdAt'],
    nodes: ['createdAt', 'treeId', 'parentId', 'origin'],
    checkins: ['createdAt', 'treeId', 'nodeId'],
    sessions: ['createdAt', 'nodeId', 'startedAt'],
    harvests: ['createdAt', 'nodeId', 'treeId'],
    preserves: ['createdAt', 'kind', 'treeId'],
  };
  for (const field of storeFields[store]) {
    if (!Object.is(immutableValue(incoming, field), immutableValue(stored, field))) {
      invalid(`${store}.${field} is immutable`);
    }
  }
  if (store === 'trees') {
    const storedHeart = stored.heartId;
    if (typeof storedHeart === 'string' && incoming.heartId !== storedHeart) {
      invalid('trees.heartId is immutable once assigned');
    }
  }
}

function requireRelated(
  snapshot: StoredSyncRecord | undefined,
  store: SyncStore,
  id: string,
  relation: string,
): StoredSyncRecord {
  if (!snapshot) invalid(`${relation} references missing ${store}/${id}`);
  return snapshot;
}

/**
 * Rejects malformed or cross-owner sync data before a caller performs writes.
 * Resolves with no value; this function never normalizes, persists or mutates input.
 */
export async function validateSyncBatch(
  request: SyncValidationRequest,
): Promise<void> {
  if (typeof request.ownerId !== 'string' || request.ownerId.length === 0) {
    invalid('ownerId is required');
  }
  if (byteLength(request.ownerId) > SYNC_VALIDATION_LIMITS.maxIdBytes) {
    invalid(`ownerId exceeds ${SYNC_VALIDATION_LIMITS.maxIdBytes} UTF-8 bytes`);
  }
  if (!Array.isArray(request.entries)) invalid('entries must be an array');
  if (typeof request.loadRecord !== 'function') invalid('loadRecord is required');

  const entries = request.entries.map(parseEntry);
  const incoming = new Map<string, ParsedEntry>();
  for (const item of entries) {
    const key = recordKey(item.store, item.record.id as string);
    if (incoming.has(key)) invalid(`duplicate sync record ${item.store}/${item.record.id as string}`);
    incoming.set(key, item);
  }

  const storedCache = new Map<string, Promise<StoredSyncRecord | undefined>>();
  const loadStored = async (store: SyncStore, id: string): Promise<StoredSyncRecord | undefined> => {
    const key = recordKey(store, id);
    let pending = storedCache.get(key);
    if (!pending) {
      pending = request.loadRecord(request.ownerId, store, id).then((snapshot) => {
        if (!snapshot) return undefined;
        if (snapshot.owner !== request.ownerId) {
          invalid(`${store}/${id} escaped owner partition`);
        }
        if (snapshot.store !== store) invalid(`${store}/${id} resolved from the wrong store`);
        if (!isPlainRecord(snapshot.record) || snapshot.record.id !== id) {
          invalid(`${store}/${id} resolved to a malformed record`);
        }
        return snapshot;
      });
      storedCache.set(key, pending);
    }
    return pending;
  };
  const resolve = async (store: SyncStore, id: string): Promise<StoredSyncRecord | undefined> => {
    const staged = incoming.get(recordKey(store, id));
    if (staged) return { owner: request.ownerId, store, record: staged.record };
    return loadStored(store, id);
  };

  const previousByEntry = new Map<ParsedEntry, StoredSyncRecord | undefined>();
  for (const item of entries) {
    const previous = await loadStored(item.store, item.record.id as string);
    previousByEntry.set(item, previous);
    if (previous) validateImmutables(item.store, item.record, previous.record);
  }

  for (const item of entries) {
    const record = item.record;
    if (item.store === 'nodes') {
      const treeId = record.treeId as string;
      const owningTree = requireRelated(await resolve('trees', treeId), 'trees', treeId, 'nodes.treeId');
      const parentId = record.parentId as string | null;
      if (parentId !== null) {
        if (parentId === record.id) invalid('nodes.parentId cannot reference the node itself');
        const parent = requireRelated(
          await resolve('nodes', parentId),
          'nodes',
          parentId,
          'nodes.parentId',
        );
        if (parent.record.treeId !== treeId) invalid('nodes.parentId must belong to the same tree');
      }
      if (owningTree.record.heartId === record.id && record.parentId !== null) {
        invalid('heart node must remain a root');
      }
      continue;
    }

    if (item.store === 'trees') {
      const treeId = record.id as string;
      const currentNodeId = record.currentNodeId as string | null;
      if (currentNodeId !== null) {
        const currentNode = requireRelated(
          await resolve('nodes', currentNodeId),
          'nodes',
          currentNodeId,
          'trees.currentNodeId',
        );
        if (currentNode.record.treeId !== treeId) {
          invalid('trees.currentNodeId must belong to the same tree');
        }
      }

      const previous = previousByEntry.get(item);
      const isNew = previous === undefined;
      const heartId = record.heartId;
      if (
        request.heartPolicy === 'required' &&
        isNew &&
        (typeof heartId !== 'string' || heartId.length === 0)
      ) {
        invalid('new tree requires heartId');
      }
      if (typeof heartId === 'string') {
        const heart = requireRelated(
          await resolve('nodes', heartId),
          'nodes',
          heartId,
          'trees.heartId',
        );
        if (heart.record.treeId !== treeId) invalid('trees.heartId must belong to the same tree');
        if (heart.record.parentId !== null) invalid('trees.heartId must reference a root node');
        if (isNew && (heart.record.deletedAt !== null || heart.record.archivedAt !== null)) {
          invalid('new tree heart must be visible');
        }
      }
      continue;
    }

    if (item.store === 'checkins') {
      const treeId = record.treeId as string | null;
      const nodeId = record.nodeId as string | null;
      if (treeId !== null) {
        requireRelated(await resolve('trees', treeId), 'trees', treeId, 'checkins.treeId');
      }
      if (nodeId !== null) {
        const relatedNode = requireRelated(
          await resolve('nodes', nodeId),
          'nodes',
          nodeId,
          'checkins.nodeId',
        );
        if (treeId !== null && relatedNode.record.treeId !== treeId) {
          invalid('checkins.nodeId must belong to checkins.treeId');
        }
      }
      continue;
    }

    if (item.store === 'sessions') {
      const nodeId = record.nodeId as string | null;
      if (nodeId !== null) {
        requireRelated(await resolve('nodes', nodeId), 'nodes', nodeId, 'sessions.nodeId');
      }
      continue;
    }

    if (item.store === 'harvests') {
      const treeId = record.treeId as string;
      const nodeId = record.nodeId as string;
      requireRelated(await resolve('trees', treeId), 'trees', treeId, 'harvests.treeId');
      const relatedNode = requireRelated(
        await resolve('nodes', nodeId),
        'nodes',
        nodeId,
        'harvests.nodeId',
      );
      if (relatedNode.record.treeId !== treeId) {
        invalid('harvests.nodeId must belong to harvests.treeId');
      }
      if (typeof record.preserveId === 'string') {
        requireRelated(
          await resolve('preserves', record.preserveId),
          'preserves',
          record.preserveId,
          'harvests.preserveId',
        );
      }
      continue;
    }

    const treeId = record.treeId;
    if (typeof treeId === 'string') {
      requireRelated(await resolve('trees', treeId), 'trees', treeId, 'preserves.treeId');
    }
  }

  // Validation is deliberately side-effect free. The caller keeps its already
  // typed request and may write only after this promise resolves.
}
