import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  createAwsCredentialLoader,
  createAwsJsonRunner,
  signFunctionUrlRequest,
} from './lib/commercial-config-cli.mjs';

const STAGES = new Set(['dev', 'test', 'prod']);
const STORES = new Set([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
]);
const ACTIVE_TREE_LIMIT = 2;
const VISIBLE_BRANCH_LIMIT = 10;
const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@/-]{1,128}$/;

export const COMMERCIAL_INVENTORY_EXECUTION_LIMIT = Object.freeze({
  timeoutSeconds: 900,
  durableCheckpoint: false,
  behavior: 'single-invocation-or-fail-without-partial-manifest',
});

const ATTRIBUTE_NAMES = Object.freeze({
  '#pk': 'pk',
  '#sk': 'sk',
  '#gsi2pk': 'gsi2pk',
  '#gsi2sk': 'gsi2sk',
  '#owner': 'owner',
  '#store': 'store',
  '#rev': 'rev',
  '#updatedAt': 'updatedAt',
  '#syncedAt': 'syncedAt',
  '#createdAt': 'createdAt',
  '#timestamp': 'timestamp',
  '#status': 'status',
  '#accountType': 'accountType',
  '#record': 'record',
  '#id': 'id',
  '#deletedAt': 'deletedAt',
  '#treeId': 'treeId',
  '#parentId': 'parentId',
  '#archivedAt': 'archivedAt',
  '#heartId': 'heartId',
});

const SAFE_STRUCTURAL_PROJECTION = [
  '#pk',
  '#sk',
  '#gsi2pk',
  '#gsi2sk',
  '#owner',
  '#store',
  '#rev',
  '#updatedAt',
  '#syncedAt',
  '#createdAt',
  '#timestamp',
  '#status',
  '#accountType',
  '#record.#id',
  '#record.#createdAt',
  '#record.#updatedAt',
  '#record.#rev',
  '#record.#deletedAt',
  '#record.#treeId',
  '#record.#parentId',
  '#record.#archivedAt',
  '#record.#heartId',
].join(', ');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonBlank(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function withStableInventoryManifestHash(manifest) {
  return { ...manifest, manifestHash: sha256(canonicalJson(manifest)) };
}

function ownerKey(owner) {
  return sha256(`commercial-inventory-owner-v1\0${owner}`);
}

function treeKey(owner, treeId) {
  return sha256(`commercial-inventory-tree-v1\0${owner}\0${treeId}`);
}

function nodeKey(owner, nodeId) {
  return sha256(`commercial-inventory-node-v1\0${owner}\0${nodeId}`);
}

function emptyState() {
  return {
    scan: { pages: 0, scannedItems: 0, returnedItems: 0 },
    profiles: 0,
    recordItems: 0,
    validRecords: 0,
    profileWithoutCreationTimestamp: 0,
    invalidRecordShape: 0,
    owners: {},
    trees: {},
  };
}

function ensureOwner(state, key) {
  state.owners[key] ??= true;
}

function profileOwner(item) {
  if (!isObject(item) || item.sk !== 'PROFILE' || !isNonBlank(item.pk)) return null;
  if (!item.pk.startsWith('USER#') || item.pk.length === 'USER#'.length) return null;
  return item.pk.slice('USER#'.length);
}

function isPotentialRecord(item) {
  return (
    isObject(item) &&
    ((typeof item.sk === 'string' && item.sk.startsWith('REC#')) ||
      typeof item.store === 'string' ||
      isObject(item.record))
  );
}

function validBaseRecord(record) {
  return (
    isObject(record) &&
    isNonBlank(record.id) &&
    isTimestamp(record.createdAt) &&
    isTimestamp(record.updatedAt) &&
    Number.isSafeInteger(record.rev) &&
    record.rev >= 1 &&
    has(record, 'deletedAt') &&
    isNullableTimestamp(record.deletedAt)
  );
}

function parseStructuralRecord(item) {
  if (!isObject(item) || !isNonBlank(item.owner) || !STORES.has(item.store)) return null;
  if (item.pk !== `USER#${item.owner}` || !validBaseRecord(item.record)) return null;
  const record = item.record;
  if (item.sk !== `REC#${item.store}#${record.id}`) return null;
  if (item.gsi2pk !== item.pk || !isTimestamp(item.syncedAt)) return null;
  if (item.gsi2sk !== `CHG#${String(item.syncedAt).padStart(14, '0')}#${record.id}`) {
    return null;
  }
  if (item.rev !== record.rev || item.updatedAt !== record.updatedAt) return null;
  if (item.store === 'trees') {
    if (!has(record, 'archivedAt') || !isNullableTimestamp(record.archivedAt)) return null;
    if (
      has(record, 'heartId') &&
      record.heartId !== null &&
      !isNonBlank(record.heartId)
    ) {
      return null;
    }
  }
  if (item.store === 'nodes') {
    if (!isNonBlank(record.treeId)) return null;
    if (record.parentId !== null && !isNonBlank(record.parentId)) return null;
    if (!has(record, 'archivedAt') || !isNullableTimestamp(record.archivedAt)) return null;
  }
  return { owner: item.owner, store: item.store, record };
}

function isVisible(record) {
  return record.deletedAt === null && record.archivedAt === null;
}

function processStructureItem(state, item) {
  const profile = profileOwner(item);
  if (profile !== null) {
    state.profiles += 1;
    ensureOwner(state, ownerKey(profile));
    if (!isTimestamp(item.createdAt) && !isTimestamp(item.timestamp)) {
      state.profileWithoutCreationTimestamp += 1;
    }
    return;
  }
  if (!isPotentialRecord(item)) return;
  state.recordItems += 1;
  const parsed = parseStructuralRecord(item);
  if (!parsed) {
    state.invalidRecordShape += 1;
    return;
  }
  state.validRecords += 1;
  const hashedOwner = ownerKey(parsed.owner);
  ensureOwner(state, hashedOwner);
  if (parsed.store !== 'trees') return;
  const record = parsed.record;
  const restorable = record.deletedAt === null;
  state.trees[treeKey(parsed.owner, record.id)] = {
    owner: hashedOwner,
    restorable,
    active: restorable && record.archivedAt === null,
    heart: isNonBlank(record.heartId)
      ? nodeKey(parsed.owner, record.heartId)
      : null,
    visibleNodes: 0,
    heartSeen: false,
    heartRoot: false,
    heartVisible: false,
  };
}

function processNodeItem(state, item) {
  const parsed = parseStructuralRecord(item);
  if (!parsed || parsed.store !== 'nodes') return;
  const record = parsed.record;
  const tree = state.trees[treeKey(parsed.owner, record.treeId)];
  if (!tree || !tree.restorable) return;
  const visible = isVisible(record);
  if (tree.active && visible) tree.visibleNodes += 1;
  if (tree.heart !== nodeKey(parsed.owner, record.id)) return;
  tree.heartSeen = true;
  tree.heartRoot = record.parentId === null;
  tree.heartVisible = visible;
}

function addScanTotals(state, result) {
  const items = Array.isArray(result.Items) ? result.Items : [];
  state.scan.pages += 1;
  state.scan.scannedItems += Number.isSafeInteger(result.ScannedCount)
    ? result.ScannedCount
    : items.length;
  state.scan.returnedItems += items.length;
  return items;
}

function scanInput(tableName, phase, cursor) {
  return {
    TableName: tableName,
    ConsistentRead: true,
    Select: 'SPECIFIC_ATTRIBUTES',
    ProjectionExpression: SAFE_STRUCTURAL_PROJECTION,
    ExpressionAttributeNames: ATTRIBUTE_NAMES,
    ...(phase === 'nodes'
      ? {
          FilterExpression: '#store = :nodes',
          ExpressionAttributeValues: { ':nodes': 'nodes' },
        }
      : {}),
    ...(cursor ? { ExclusiveStartKey: cursor } : {}),
  };
}

function checkpointFor(stage, tableName, phase, state, cursor) {
  const checkpoint = structuredClone({
    schemaVersion: 1,
    operation: 'commercial-inventory',
    stage,
    tableName,
    phase,
    ...(cursor ? { cursor } : {}),
    state,
  });
  return {
    ...checkpoint,
    checkpointHash: sha256(canonicalJson(checkpoint)),
  };
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value, allowed) {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    [...allowed].every((key) => has(value, key))
  );
}

function validateCheckpointState(state) {
  if (
    !hasExactKeys(
      state,
      new Set([
        'scan',
        'profiles',
        'recordItems',
        'validRecords',
        'profileWithoutCreationTimestamp',
        'invalidRecordShape',
        'owners',
        'trees',
      ]),
    ) ||
    !hasExactKeys(state.scan, new Set(['pages', 'scannedItems', 'returnedItems']))
  ) {
    throw new Error('checkpoint state is invalid');
  }
  for (const field of ['pages', 'scannedItems', 'returnedItems']) {
    if (!isCounter(state.scan[field])) throw new Error('checkpoint scan state is invalid');
  }
  for (const field of [
    'profiles',
    'recordItems',
    'validRecords',
    'profileWithoutCreationTimestamp',
    'invalidRecordShape',
  ]) {
    if (!isCounter(state[field])) throw new Error('checkpoint aggregate state is invalid');
  }
  if (!isObject(state.owners) || !isObject(state.trees)) {
    throw new Error('checkpoint aggregate state is invalid');
  }
  const hashPattern = /^[a-f0-9]{64}$/;
  for (const [key, value] of Object.entries(state.owners)) {
    if (!hashPattern.test(key) || value !== true) {
      throw new Error('checkpoint owner state is invalid');
    }
  }
  for (const [key, tree] of Object.entries(state.trees)) {
    if (
      !hashPattern.test(key) ||
      !hasExactKeys(
        tree,
        new Set([
          'owner',
          'restorable',
          'active',
          'heart',
          'visibleNodes',
          'heartSeen',
          'heartRoot',
          'heartVisible',
        ]),
      ) ||
      !hashPattern.test(tree.owner) ||
      state.owners[tree.owner] !== true ||
      typeof tree.restorable !== 'boolean' ||
      typeof tree.active !== 'boolean' ||
      (tree.heart !== null && !hashPattern.test(tree.heart)) ||
      !isCounter(tree.visibleNodes) ||
      typeof tree.heartSeen !== 'boolean' ||
      typeof tree.heartRoot !== 'boolean' ||
      typeof tree.heartVisible !== 'boolean'
    ) {
      throw new Error('checkpoint tree state is invalid');
    }
  }
  return structuredClone(state);
}

function validateCheckpoint(checkpoint, stage, tableName) {
  if (checkpoint === null || checkpoint === undefined) return null;
  if (!isObject(checkpoint)) throw new Error('checkpoint must be an object');
  if (checkpoint.schemaVersion !== 1) {
    throw new Error('checkpoint schemaVersion does not match this run');
  }
  if (checkpoint.operation !== 'commercial-inventory') {
    throw new Error('checkpoint operation does not match this run');
  }
  if (checkpoint.stage !== stage) {
    throw new Error('checkpoint stage does not match this run');
  }
  if (checkpoint.tableName !== tableName) {
    throw new Error('checkpoint tableName does not match this run');
  }
  const expectedKeys = new Set([
    'schemaVersion',
    'operation',
    'stage',
    'tableName',
    'phase',
    'state',
    'checkpointHash',
    ...(checkpoint.cursor === undefined ? [] : ['cursor']),
  ]);
  if (!hasExactKeys(checkpoint, expectedKeys)) {
    throw new Error('checkpoint shape is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.checkpointHash)) {
    throw new Error('checkpoint hash is invalid');
  }
  const { checkpointHash, ...checkpointContents } = checkpoint;
  if (sha256(canonicalJson(checkpointContents)) !== checkpointHash) {
    throw new Error('checkpoint hash does not match its contents');
  }
  if (!['structure', 'nodes', 'complete'].includes(checkpoint.phase)) {
    throw new Error('checkpoint phase is invalid');
  }
  if (checkpoint.cursor !== undefined) {
    if (
      !isObject(checkpoint.cursor) ||
      !isNonBlank(checkpoint.cursor.pk) ||
      !isNonBlank(checkpoint.cursor.sk) ||
      Object.keys(checkpoint.cursor).some((key) => key !== 'pk' && key !== 'sk')
    ) {
      throw new Error('checkpoint cursor is invalid');
    }
  }
  if (checkpoint.phase === 'structure' && checkpoint.cursor === undefined) {
    throw new Error('structure checkpoint requires a cursor');
  }
  if (checkpoint.phase === 'complete' && checkpoint.cursor !== undefined) {
    throw new Error('complete checkpoint cannot contain a cursor');
  }
  return {
    phase: checkpoint.phase,
    ...(checkpoint.cursor ? { cursor: structuredClone(checkpoint.cursor) } : {}),
    state: validateCheckpointState(checkpoint.state),
  };
}

function buildManifest(stage, tableName, state) {
  const ownerUsage = Object.fromEntries(
    Object.keys(state.owners).map((owner) => [
      owner,
      { activeTrees: 0, visibleBranches: 0, branchLimitExceeded: false },
    ]),
  );
  let missingHeart = 0;
  let treeCount = 0;
  let restorableTrees = 0;
  let treesOverVisibleBranchLimit = 0;
  for (const tree of Object.values(state.trees)) {
    treeCount += 1;
    if (!tree.restorable) continue;
    restorableTrees += 1;
    const validHeart = tree.heart !== null && tree.heartSeen && tree.heartRoot;
    if (!validHeart) missingHeart += 1;
    if (!tree.active) continue;
    const usage = ownerUsage[tree.owner] ??= {
      activeTrees: 0,
      visibleBranches: 0,
      branchLimitExceeded: false,
    };
    usage.activeTrees += 1;
    const treeBranches = Math.max(
      0,
      tree.visibleNodes - (validHeart && tree.heartVisible ? 1 : 0),
    );
    usage.visibleBranches += treeBranches;
    if (treeBranches > VISIBLE_BRANCH_LIMIT) {
      treesOverVisibleBranchLimit += 1;
      usage.branchLimitExceeded = true;
    }
  }

  let activeTrees = 0;
  let visibleBranches = 0;
  let overOwners = 0;
  let treesOnly = 0;
  let branchesOnly = 0;
  let both = 0;
  let ownersOverActiveTreeLimit = 0;
  let ownersOverBranchLimit = 0;
  for (const usage of Object.values(ownerUsage)) {
    activeTrees += usage.activeTrees;
    visibleBranches += usage.visibleBranches;
    const treesOver = usage.activeTrees > ACTIVE_TREE_LIMIT;
    const branchesOver = usage.branchLimitExceeded;
    if (treesOver) ownersOverActiveTreeLimit += 1;
    if (branchesOver) ownersOverBranchLimit += 1;
    if (!treesOver && !branchesOver) continue;
    overOwners += 1;
    if (treesOver && branchesOver) both += 1;
    else if (treesOver) treesOnly += 1;
    else branchesOnly += 1;
  }

  return withStableInventoryManifestHash({
    schemaVersion: 1,
    operation: 'commercial-inventory',
    mode: 'dry-run',
    stage,
    resources: { primaryTable: tableName },
    scan: { passes: 2, ...state.scan },
    totals: {
      profiles: state.profiles,
      recordItems: state.recordItems,
      validRecords: state.validRecords,
      ownersEvaluated: Object.keys(ownerUsage).length,
      trees: treeCount,
      restorableTrees,
      activeTrees,
      visibleBranches,
    },
    classifications: {
      missingHeart: { trees: missingHeart },
      invalidRecordShape: { records: state.invalidRecordShape },
      profileWithoutCreationTimestamp: {
        profiles: state.profileWithoutCreationTimestamp,
      },
      overQuota: {
        activeTreeLimit: ACTIVE_TREE_LIMIT,
        visibleBranchLimit: VISIBLE_BRANCH_LIMIT,
        owners: overOwners,
        ownersOverActiveTreeLimit,
        ownersOverBranchLimit,
        treesOverVisibleBranchLimit,
        treesOnly,
        branchesOnly,
        both,
      },
    },
  });
}

/**
 * Read-only by construction: the module imports and issues ScanCommand only.
 * Checkpoints are local persistence seams, never DynamoDB mutations.
 */
export async function runCommercialInventory(options = {}) {
  const {
    stage,
    tableName,
    ddb,
    loadCheckpoint = async () => null,
    saveCheckpoint = async () => undefined,
    beforePage = async () => undefined,
  } = options;
  if (has(options, 'apply') || has(options, 'repair')) {
    throw new Error('commercial inventory is always read-only');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  if (tableName !== `roadmap-${stage}`) {
    throw new Error('primary table must exactly match the selected stage');
  }
  if (!ddb || typeof ddb.send !== 'function') throw new Error('ddb is required');
  if (
    typeof loadCheckpoint !== 'function' ||
    typeof saveCheckpoint !== 'function' ||
    typeof beforePage !== 'function'
  ) {
    throw new Error('inventory lifecycle seams must be functions');
  }

  const checkpoint = validateCheckpoint(await loadCheckpoint(), stage, tableName);
  const phase = checkpoint?.phase ?? 'structure';
  const state = checkpoint?.state ?? emptyState();
  let cursor = checkpoint?.cursor;

  if (phase === 'complete') return buildManifest(stage, tableName, state);

  if (phase === 'structure') {
    do {
      await beforePage();
      const result = await ddb.send(
        new ScanCommand(scanInput(tableName, 'structure', cursor)),
      );
      for (const item of addScanTotals(state, result)) {
        processStructureItem(state, item);
      }
      cursor = result.LastEvaluatedKey;
      await saveCheckpoint(
        checkpointFor(
          stage,
          tableName,
          cursor ? 'structure' : 'nodes',
          state,
          cursor,
        ),
      );
    } while (cursor);
    cursor = undefined;
  }

  do {
    await beforePage();
    const result = await ddb.send(
      new ScanCommand(scanInput(tableName, 'nodes', cursor)),
    );
    for (const item of addScanTotals(state, result)) processNodeItem(state, item);
    cursor = result.LastEvaluatedKey;
    if (cursor) {
      await saveCheckpoint(
        checkpointFor(stage, tableName, 'nodes', state, cursor),
      );
    }
  } while (cursor);

  await saveCheckpoint(checkpointFor(stage, tableName, 'complete', state));
  return buildManifest(stage, tableName, state);
}

const CLI_OPTIONS = new Set([
  'stage',
  'profile',
  'url',
]);

function parseCliOptions(argv) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error('options must use --name value syntax');
    }
    const name = token.slice(2);
    if (!CLI_OPTIONS.has(name)) throw new Error(`unknown option --${name}`);
    if (values.has(name)) throw new Error(`duplicate option --${name}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  const required = (name) => {
    const value = values.get(name);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`missing required --${name}`);
    }
    return value;
  };
  const stage = required('stage');
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  const profile = values.get('profile');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(profile)) {
    throw new Error('profile has an invalid format');
  }
  const rawUrl = required('url');
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL must be an AWS Lambda Function URL');
  }
  if (
    url.protocol !== 'https:' ||
    !FUNCTION_URL_HOST.test(url.hostname) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    throw new Error('URL must be an AWS Lambda Function URL in us-east-1');
  }
  return { stage, profile, url: url.href };
}

function validateInventoryIdentity(identity, stage) {
  if (!isObject(identity) || identity.Account !== ACCOUNT_ID) {
    throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  }
  const match = typeof identity.Arn === 'string'
    ? ASSUMED_ROLE_ARN.exec(identity.Arn)
    : null;
  if (
    !match ||
    match[1] !== ACCOUNT_ID ||
    match[2] !== `roadmap2u-${stage}-commercial-migration`
  ) {
    throw new Error('caller does not match the selected stage migration role');
  }
}

export function validateCommercialInventoryManifest(manifest, stage, tableName) {
  if (
    !hasExactKeys(
      manifest,
      new Set([
        'schemaVersion',
        'operation',
        'mode',
        'stage',
        'resources',
        'scan',
        'totals',
        'classifications',
        'manifestHash',
      ]),
    ) ||
    manifest.schemaVersion !== 1 ||
    manifest.operation !== 'commercial-inventory' ||
    manifest.mode !== 'dry-run' ||
    manifest.stage !== stage ||
    !hasExactKeys(manifest.resources, new Set(['primaryTable'])) ||
    manifest.resources.primaryTable !== tableName ||
    !hasExactKeys(
      manifest.scan,
      new Set(['passes', 'pages', 'scannedItems', 'returnedItems']),
    ) ||
    manifest.scan.passes !== 2 ||
    !['pages', 'scannedItems', 'returnedItems'].every((field) =>
      isCounter(manifest.scan[field]),
    ) ||
    !hasExactKeys(
      manifest.totals,
      new Set([
        'profiles',
        'recordItems',
        'validRecords',
        'ownersEvaluated',
        'trees',
        'restorableTrees',
        'activeTrees',
        'visibleBranches',
      ]),
    ) ||
    !Object.values(manifest.totals).every(isCounter) ||
    !hasExactKeys(
      manifest.classifications,
      new Set([
        'missingHeart',
        'invalidRecordShape',
        'profileWithoutCreationTimestamp',
        'overQuota',
      ]),
    ) ||
    !hasExactKeys(manifest.classifications.missingHeart, new Set(['trees'])) ||
    !isCounter(manifest.classifications.missingHeart.trees) ||
    !hasExactKeys(
      manifest.classifications.invalidRecordShape,
      new Set(['records']),
    ) ||
    !isCounter(manifest.classifications.invalidRecordShape.records) ||
    !hasExactKeys(
      manifest.classifications.profileWithoutCreationTimestamp,
      new Set(['profiles']),
    ) ||
    !isCounter(manifest.classifications.profileWithoutCreationTimestamp.profiles) ||
    !hasExactKeys(
      manifest.classifications.overQuota,
      new Set([
        'activeTreeLimit',
        'visibleBranchLimit',
        'owners',
        'ownersOverActiveTreeLimit',
        'ownersOverBranchLimit',
        'treesOverVisibleBranchLimit',
        'treesOnly',
        'branchesOnly',
        'both',
      ]),
    ) ||
    !Object.values(manifest.classifications.overQuota).every(isCounter) ||
    manifest.classifications.overQuota.activeTreeLimit !== ACTIVE_TREE_LIMIT ||
    manifest.classifications.overQuota.visibleBranchLimit !== VISIBLE_BRANCH_LIMIT ||
    !HASH_PATTERN.test(manifest.manifestHash)
  ) {
    throw new Error('inventory returned an invalid sanitized manifest');
  }
  const { manifestHash, ...contents } = manifest;
  if (sha256(canonicalJson(contents)) !== manifestHash) {
    throw new Error('inventory manifest hash does not match its contents');
  }
  const totals = manifest.totals;
  const classifications = manifest.classifications;
  const over = classifications.overQuota;
  if (
    totals.validRecords > totals.recordItems ||
    totals.restorableTrees > totals.trees ||
    totals.activeTrees > totals.restorableTrees ||
    classifications.missingHeart.trees > totals.restorableTrees ||
    classifications.invalidRecordShape.records > totals.recordItems ||
    classifications.profileWithoutCreationTimestamp.profiles > totals.profiles ||
    over.owners > totals.ownersEvaluated ||
    over.owners !== over.treesOnly + over.branchesOnly + over.both ||
    over.ownersOverActiveTreeLimit !== over.treesOnly + over.both ||
    over.ownersOverBranchLimit !== over.branchesOnly + over.both ||
    over.treesOverVisibleBranchLimit > totals.activeTrees
  ) {
    throw new Error('inventory returned inconsistent aggregate totals');
  }
  return manifest;
}

const runAwsJson = createAwsJsonRunner();
const loadAwsCredentials = createAwsCredentialLoader();

async function defaultCallerIdentity(profile, region) {
  if (region !== REGION) throw new Error(`STS region must be ${REGION}`);
  return runAwsJson(profile, [
    'sts',
    'get-caller-identity',
    '--region',
    REGION,
    '--output',
    'json',
  ]);
}

async function defaultCredentials(profile) {
  return loadAwsCredentials(profile);
}

function resolveEvidenceRoot(evidenceRoot, cwd) {
  if (
    typeof evidenceRoot !== 'string' ||
    evidenceRoot.length === 0 ||
    evidenceRoot !== evidenceRoot.trim() ||
    !isAbsolute(evidenceRoot)
  ) {
    throw new Error('EVIDENCE_ROOT must be an absolute path');
  }
  const root = resolve(evidenceRoot);
  const segments = root.toLowerCase().split(/[\\/]+/);
  if (segments.at(-2) !== 'evidence' || segments.at(-1) !== 'commercial-launch') {
    throw new Error('EVIDENCE_ROOT must end with evidence/commercial-launch');
  }
  const checkout = resolve(cwd);
  const fromCheckout = relative(checkout, root);
  if (
    fromCheckout === '' ||
    (!fromCheckout.startsWith(`..${sep}`) &&
      fromCheckout !== '..' &&
      !isAbsolute(fromCheckout))
  ) {
    throw new Error('EVIDENCE_ROOT must remain outside the backend checkout');
  }
  return root;
}

export function createCommercialInventoryEvidenceWriter({
  makeDirectory = mkdir,
  writeFile: writeEvidenceFile = writeFile,
  readFile: readEvidenceFile = readFile,
  cwd = process.cwd(),
} = {}) {
  if (
    typeof makeDirectory !== 'function' ||
    typeof writeEvidenceFile !== 'function' ||
    typeof readEvidenceFile !== 'function'
  ) {
    throw new Error('inventory evidence filesystem seams must be functions');
  }
  return async ({ evidenceRoot, stage, manifest } = {}) => {
    const root = resolveEvidenceRoot(evidenceRoot, cwd);
    validateCommercialInventoryManifest(manifest, stage, `roadmap-${stage}`);
    const directory = resolve(root, 'inventory', stage);
    const path = resolve(directory, `${manifest.manifestHash}.json`);
    const content = `${canonicalJson(manifest)}\n`;
    await makeDirectory(directory, { recursive: true });
    try {
      await writeEvidenceFile(path, content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return { path, created: true };
    } catch (error) {
      if (!isObject(error) || error.code !== 'EEXIST') {
        throw new Error('commercial inventory evidence could not be written');
      }
      let existing;
      try {
        existing = await readEvidenceFile(path, 'utf8');
      } catch {
        throw new Error('existing commercial inventory evidence is unreadable');
      }
      if (existing !== content) {
        throw new Error('existing commercial inventory evidence has different contents');
      }
      return { path, created: false };
    }
  };
}

const writeInventoryEvidence = createCommercialInventoryEvidenceWriter();

export async function runCommercialInventoryCli({
  argv = process.argv.slice(2),
  write = (line) => console.log(line),
  getCallerIdentity = defaultCallerIdentity,
  getCredentials = defaultCredentials,
  fetch: fetchRequest = globalThis.fetch,
  writeManifestEvidence = writeInventoryEvidence,
  evidenceRoot = process.env.EVIDENCE_ROOT,
  now = () => new Date(),
} = {}) {
  const options = parseCliOptions(argv);
  if (typeof write !== 'function') throw new Error('write must be a function');
  const identity = await getCallerIdentity(options.profile, REGION);
  validateInventoryIdentity(identity, options.stage);
  const resolvedEvidenceRoot = resolveEvidenceRoot(evidenceRoot, process.cwd());
  if (
    typeof getCredentials !== 'function' ||
    typeof fetchRequest !== 'function' ||
    typeof writeManifestEvidence !== 'function'
  ) {
    throw new Error('inventory executor dependencies are unavailable');
  }
  const body = JSON.stringify({
    command: 'commercial-inventory',
    stage: options.stage,
  });
  const credentials = await getCredentials(options.profile);
  const headers = signFunctionUrlRequest({
    url: options.url,
    body,
    credentials,
    now: now(),
  });
  const response = await fetchRequest(options.url, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`inventory executor rejected request with status ${response.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('inventory executor returned invalid JSON');
  }
  const manifest = validateCommercialInventoryManifest(
    payload,
    options.stage,
    `roadmap-${options.stage}`,
  );
  await writeManifestEvidence({
    evidenceRoot: resolvedEvidenceRoot,
    stage: options.stage,
    manifest,
  });
  write(
    `commercial-inventory mode=dry-run stage=${options.stage} region=${REGION}`,
  );
  write(
    `executionLimit=single-invocation-no-checkpoint timeoutSeconds=${COMMERCIAL_INVENTORY_EXECUTION_LIMIT.timeoutSeconds}`,
  );
  write(`manifestHash=${manifest.manifestHash}`);
  write(
    [
      'totals',
      `profiles=${manifest.totals.profiles}`,
      `records=${manifest.totals.recordItems}`,
      `activeTrees=${manifest.totals.activeTrees}`,
      `visibleBranches=${manifest.totals.visibleBranches}`,
    ].join(' '),
  );
  write(
    [
      'classifications',
      `missingHeart=${manifest.classifications.missingHeart.trees}`,
      `invalidRecordShape=${manifest.classifications.invalidRecordShape.records}`,
      `profileWithoutCreationTimestamp=${manifest.classifications.profileWithoutCreationTimestamp.profiles}`,
      `overQuotaOwners=${manifest.classifications.overQuota.owners}`,
    ].join(' '),
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runCommercialInventoryCli({ argv });
  } catch {
    console.error('error=commercial inventory failed');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (!process.env.AWS_LAMBDA_FUNCTION_NAME && invokedPath === import.meta.url) {
  await main();
}
