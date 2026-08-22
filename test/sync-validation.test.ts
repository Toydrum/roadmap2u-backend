import { describe, expect, it } from 'vitest';
import type { SyncStore } from '@app/api/contracts';
import {
  SYNC_VALIDATION_LIMITS,
  StoredSyncRecord,
  SyncValidationLookup,
  validateSyncBatch,
} from '../lambda/commercial/sync-validation';

const OWNER = 'owner-1';
const OTHER_OWNER = 'owner-2';
const BASE = Object.freeze({
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100,
  rev: 1,
  deletedAt: null,
});

type RawRecord = Record<string, unknown>;

function tree(id = 'tree-1', heartId?: string | null): RawRecord {
  return {
    ...BASE,
    id,
    name: 'Mi camino',
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    archivedAt: null,
    ...(heartId === undefined ? {} : { heartId }),
  };
}

function node(
  id = 'node-1',
  treeId = 'tree-1',
  parentId: string | null = null,
): RawRecord {
  return {
    ...BASE,
    id,
    treeId,
    parentId,
    title: 'Primer paso',
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
  };
}

function checkin(id = 'checkin-1'): RawRecord {
  return {
    ...BASE,
    id,
    feeling: 'calm',
    note: 'Hoy voy con calma.',
    treeId: 'tree-1',
    nodeId: 'node-1',
    energy: 'media',
  };
}

function session(id = 'session-1'): RawRecord {
  return {
    ...BASE,
    id,
    nodeId: 'node-1',
    startedAt: 1_700_000_000_000,
    plannedMinutes: 10,
    endedAt: null,
    note: '',
    pausedAt: null,
    pausedMs: 0,
  };
}

function harvest(id = 'h:node-1'): RawRecord {
  return {
    ...BASE,
    id,
    nodeId: 'node-1',
    treeId: 'tree-1',
    treeName: 'Mi camino',
    accent: 'moss',
    title: 'Primer paso',
    harvestedAt: 1_700_000_000_100,
    preserveId: null,
  };
}

function preserve(id = 'preserve-1'): RawRecord {
  return {
    ...BASE,
    id,
    kind: 'elixir',
    name: 'Lo que me llevo',
    madeAt: 1_700_000_000_100,
    accent: 'moss',
    tint: '#aabbcc',
    tintEdge: '#778899',
    size: 'frasco',
    premio: null,
    savedFor: null,
    openedAt: null,
    plannedAt: null,
    sealedAt: null,
    carry: 'Paciencia',
    treeId: 'tree-1',
  };
}

function entry(store: SyncStore, record: RawRecord): unknown {
  return { store, record };
}

function snapshot(owner: string, store: SyncStore, record: RawRecord): StoredSyncRecord {
  return { owner, store, record };
}

function lookup(records: StoredSyncRecord[] = []): SyncValidationLookup {
  return async (_ownerId, store, id) =>
    records.find((item) => item.store === store && item.record.id === id);
}

const RELATED = [
  snapshot(OWNER, 'trees', tree()),
  snapshot(OWNER, 'nodes', node()),
];

async function validate(
  entries: unknown[],
  records: StoredSyncRecord[] = RELATED,
  heartPolicy: 'compatible' | 'required' = 'compatible',
): Promise<void> {
  return validateSyncBatch({
    ownerId: OWNER,
    entries,
    loadRecord: lookup(records),
    heartPolicy,
  });
}

describe('sync validation — exact store shapes', () => {
  const exactFixtures: [SyncStore, () => RawRecord][] = [
    ['trees', tree],
    ['nodes', node],
    ['checkins', checkin],
    ['sessions', session],
    ['harvests', harvest],
    ['preserves', preserve],
  ];

  it.each(exactFixtures)('accepts the exact %s shape', async (store, fixture) => {
    await expect(validate([entry(store, fixture())])).resolves.toBeUndefined();
  });

  it.each(exactFixtures)('rejects an unknown field in %s', async (store, fixture) => {
    await expect(
      validate([entry(store, { ...fixture(), injectedOwner: OTHER_OWNER })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects unknown stores and non-plain records', async () => {
    await expect(validate([{ store: 'settings', record: tree() }])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(validate([{ store: 'trees', record: [] }])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('sync validation — strings, arrays and bytes', () => {
  it('publishes the technical safety caps independently from commercial quota', () => {
    expect(SYNC_VALIDATION_LIMITS).toEqual({
      maxRecordBytes: 32 * 1024,
      maxIdBytes: 256,
      maxShortTextBytes: 1024,
      maxLongTextBytes: 16 * 1024,
      maxArrayItems: 7,
    });
  });

  it('counts UTF-8 bytes, not JavaScript code units, for identifiers', async () => {
    const oversizedUtf8Id = '🌱'.repeat(65); // 260 UTF-8 bytes, 130 code units.
    await expect(validate([entry('trees', tree(oversizedUtf8Id))])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects an individually oversized long string', async () => {
    await expect(
      validate([entry('nodes', { ...node(), note: 'x'.repeat(16 * 1024 + 1) })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a record over 32 KiB even when each string is below its own cap', async () => {
    await expect(
      validate([
        entry('preserves', {
          ...preserve(),
          premio: 'a'.repeat(12_000),
          savedFor: 'b'.repeat(12_000),
          carry: 'c'.repeat(12_000),
        }),
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('accepts a unique weekday cadence and rejects empty, duplicate or foreign arrays', async () => {
    await expect(
      validate([entry('nodes', { ...node(), repeats: ['mon', 'wed', 'fri'] })]),
    ).resolves.toBeUndefined();

    for (const repeats of [[], ['mon', 'mon'], ['mon', 'funday'], Array(8).fill('mon')]) {
      await expect(validate([entry('nodes', { ...node(), repeats })])).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
  });

  it('accepts real calendar dates and rejects impossible YYYY-MM-DD values', async () => {
    await expect(
      validate([entry('nodes', { ...node(), targetDate: '2024-02-29' })]),
    ).resolves.toBeUndefined();

    for (const targetDate of ['2026-02-30', '2026-99-10', '2026-04-31']) {
      await expect(
        validate([entry('nodes', { ...node(), targetDate })]),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });

  it('allows only existing opaque SVG hex tints and rejects CSS or alpha payloads', async () => {
    for (const [tint, tintEdge] of [
      ['#abc', '#DEF'],
      ['#a1B2c3', '#778899'],
    ]) {
      await expect(
        validate([entry('preserves', { ...preserve(), tint, tintEdge })]),
      ).resolves.toBeUndefined();
    }

    for (const tint of [
      'url(#paint)',
      'var(--surface)',
      'red',
      '#abcd',
      '#11223344',
      '#ggg',
    ]) {
      await expect(
        validate([entry('preserves', { ...preserve(), tint })]),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        validate([entry('preserves', { ...preserve(), tintEdge: tint })]),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });
});

describe('sync validation — owner and relationship integrity', () => {
  it('rejects a lookup result that escaped the requested owner partition', async () => {
    await expect(
      validate([entry('nodes', node())], [snapshot(OTHER_OWNER, 'trees', tree())]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('requires every node treeId to resolve under the owner', async () => {
    await expect(validate([entry('nodes', node())], [])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects a treeId change on an existing node', async () => {
    await expect(
      validate(
        [entry('nodes', node('node-1', 'tree-2'))],
        [snapshot(OWNER, 'nodes', node()), snapshot(OWNER, 'trees', tree('tree-2'))],
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a missing, self or cross-tree parent', async () => {
    await expect(
      validate([entry('nodes', node('child', 'tree-1', 'missing'))]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate([entry('nodes', node('child', 'tree-1', 'child'))]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate(
        [entry('nodes', node('child', 'tree-1', 'other-parent'))],
        [...RELATED, snapshot(OWNER, 'nodes', node('other-parent', 'tree-2'))],
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a parentId change on an existing node', async () => {
    await expect(
      validate(
        [entry('nodes', node('child', 'tree-1', 'parent-2'))],
        [
          ...RELATED,
          snapshot(OWNER, 'nodes', node('parent-1')),
          snapshot(OWNER, 'nodes', node('parent-2')),
          snapshot(OWNER, 'nodes', node('child', 'tree-1', 'parent-1')),
        ],
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('checks check-in, session, harvest and preserve references under the owner', async () => {
    await expect(
      validate([entry('checkins', { ...checkin(), nodeId: 'missing' })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      validate([entry('sessions', { ...session(), nodeId: 'missing' })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      validate([entry('harvests', { ...harvest(), treeId: 'tree-2' })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      validate([entry('preserves', { ...preserve(), treeId: 'missing' })]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('sync validation — heart integrity', () => {
  it('accepts a new tree and its visible root heart in the same batch', async () => {
    await expect(
      validate(
        [entry('trees', tree('new-tree', 'new-heart')), entry('nodes', node('new-heart', 'new-tree'))],
        [],
        'required',
      ),
    ).resolves.toBeUndefined();
  });

  it('allows a legacy heartless tree only in compatible mode', async () => {
    await expect(validate([entry('trees', tree('legacy-tree'))], [])).resolves.toBeUndefined();
    await expect(
      validate([entry('trees', tree('new-tree'))], [], 'required'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a missing, foreign-tree, non-root or initially tombstoned heart', async () => {
    await expect(
      validate([entry('trees', tree('new-tree', 'missing'))], [], 'required'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate(
        [entry('trees', tree('new-tree', 'heart')), entry('nodes', node('heart', 'other-tree'))],
        [snapshot(OWNER, 'trees', tree('other-tree'))],
        'required',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate(
        [
          entry('trees', tree('new-tree', 'heart')),
          entry('nodes', node('heart', 'new-tree', 'parent')),
          entry('nodes', node('parent', 'new-tree')),
        ],
        [],
        'required',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate(
        [
          entry('trees', tree('new-tree', 'heart')),
          entry('nodes', { ...node('heart', 'new-tree'), deletedAt: 1_700_000_000_200 }),
        ],
        [],
        'required',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('keeps heartId immutable but permits a stored heart tombstone', async () => {
    const oldTree = tree('tree-1', 'heart-1');
    const oldHeart = node('heart-1', 'tree-1');

    await expect(
      validate(
        [entry('trees', tree('tree-1', 'heart-2'))],
        [snapshot(OWNER, 'trees', oldTree), snapshot(OWNER, 'nodes', oldHeart)],
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      validate(
        [entry('nodes', { ...oldHeart, rev: 2, updatedAt: BASE.updatedAt + 1, deletedAt: BASE.updatedAt + 1 })],
        [snapshot(OWNER, 'trees', oldTree), snapshot(OWNER, 'nodes', oldHeart)],
      ),
    ).resolves.toBeUndefined();
  });
});

describe('sync validation — immutable fields', () => {
  it.each([
    ['trees', tree(), { ...tree(), createdAt: BASE.createdAt + 1 }],
    ['nodes', node(), { ...node(), origin: 'branch' }],
    ['checkins', checkin(), { ...checkin(), nodeId: null }],
    ['sessions', session(), { ...session(), startedAt: BASE.createdAt + 1 }],
    ['harvests', harvest(), { ...harvest(), nodeId: 'node-2', id: 'h:node-1' }],
    ['preserves', preserve(), { ...preserve(), kind: 'mermelada' }],
  ] as [SyncStore, RawRecord, RawRecord][])('rejects immutable changes in %s', async (store, before, after) => {
    const records = [
      ...RELATED,
      snapshot(OWNER, 'nodes', node('node-2')),
      snapshot(OWNER, store, before),
    ];
    await expect(validate([entry(store, after)], records)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});
