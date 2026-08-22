import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createAwsCredentialLoader,
  createAwsJsonRunner,
} from './lib/commercial-config-cli.mjs';

const STAGES = new Set(['dev', 'test', 'prod']);
const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@/-]{1,128}$/;
const SAFE_READ_PROJECTION =
  'pk, sk, userId, accountType, #status, familyFenceVersion, createdMinorIds, #kind, guardianId, minorId, linkId, createdAt, gsi1pk, gsi1sk';
const SAFE_READ_NAMES = Object.freeze({ '#status': 'status', '#kind': 'kind' });

/**
 * Backfills the adult family-ownership fence used by durable account closure.
 *
 * The runner is exported so the migration protocol can be proven without AWS.
 * The executable CLI is added only after the protocol itself is covered.
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCreatedLink(item) {
  if (!isObject(item) || item.kind !== 'created') return false;
  const fields = [
    'pk',
    'sk',
    'gsi1pk',
    'gsi1sk',
    'linkId',
    'guardianId',
    'minorId',
  ];
  if (fields.some((field) => typeof item[field] !== 'string' || item[field].length === 0)) {
    return false;
  }
  return (
    Number.isSafeInteger(item.createdAt) &&
    item.createdAt >= 0 &&
    item.pk === `USER#${item.minorId}` &&
    item.sk === `GUARDIAN#${item.guardianId}` &&
    item.gsi1pk === `USER#${item.guardianId}` &&
    item.gsi1sk === `MINOR#${item.minorId}` &&
    item.linkId === `${item.guardianId}~${item.minorId}`
  );
}

function malformedCreatedLinkGuardians(item) {
  const guardianIds = new Set();
  if (typeof item?.guardianId === 'string' && item.guardianId.length > 0) {
    guardianIds.add(item.guardianId);
  }
  for (const [field, prefix] of [
    ['sk', 'GUARDIAN#'],
    ['gsi1pk', 'USER#'],
  ]) {
    const value = item?.[field];
    if (typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length) {
      guardianIds.add(value.slice(prefix.length));
    }
  }
  return { guardianIds, ambiguous: guardianIds.size !== 1 };
}

function sameCreatedLink(left, right) {
  return (
    isCreatedLink(left) &&
    isCreatedLink(right) &&
    left.pk === right.pk &&
    left.sk === right.sk &&
    left.gsi1pk === right.gsi1pk &&
    left.gsi1sk === right.gsi1sk &&
    left.linkId === right.linkId &&
    left.guardianId === right.guardianId &&
    left.minorId === right.minorId &&
    left.createdAt === right.createdAt
  );
}

function isProfile(item) {
  return (
    isObject(item) &&
    item.sk === 'PROFILE' &&
    typeof item.userId === 'string' &&
    item.userId.length > 0 &&
    item.pk === `USER#${item.userId}`
  );
}

function isWritableAdult(profile) {
  return (
    isProfile(profile) &&
    profile.accountType === 'adult' &&
    (profile.status === undefined || profile.status === 'active')
  );
}

function setFromAttribute(value) {
  if (value === undefined) return new Set();
  if (!(value instanceof Set) || [...value].some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return new Set(value);
}

function addToMapSet(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function addLinkItem(map, link) {
  const links = map.get(link.guardianId) ?? new Map();
  links.set(link.minorId, link);
  map.set(link.guardianId, links);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

const driftKeysByManifest = new WeakMap();

function addDrift(manifest, reason, identity) {
  const keys = driftKeysByManifest.get(manifest);
  if (keys && identity !== undefined) {
    const key = `${reason}\0${identity}`;
    if (keys.has(key)) return;
    keys.add(key);
  }
  manifest.drift.total += 1;
  manifest.drift.reasons[reason] = (manifest.drift.reasons[reason] ?? 0) + 1;
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

export function withStableManifestHash(manifest) {
  return { ...manifest, manifestHash: sha256(canonicalJson(manifest)) };
}

function closureAbsent(tableName, guardianId) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: `ACCOUNT_CLOSURE#${guardianId}`, sk: 'STATE' },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

function exactCreatedLink(tableName, link) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: link.pk, sk: link.sk },
      ConditionExpression: [
        'attribute_exists(pk)',
        '#kind = :kind',
        'guardianId = :guardianId',
        'minorId = :minorId',
        'linkId = :linkId',
        'createdAt = :createdAt',
        'gsi1pk = :gsi1pk',
        'gsi1sk = :gsi1sk',
      ].join(' AND '),
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':kind': 'created',
        ':guardianId': link.guardianId,
        ':minorId': link.minorId,
        ':linkId': link.linkId,
        ':createdAt': link.createdAt,
        ':gsi1pk': link.gsi1pk,
        ':gsi1sk': link.gsi1sk,
      },
    },
  };
}

function auditPut({ auditTableName, stage, action, timestamp, identity }) {
  const targetId = sha256(identity);
  const requestId = `${action}-v1-${targetId.slice(0, 16)}`;
  return {
    Put: {
      TableName: auditTableName,
      Item: {
        pk: `TARGET#FAMILY_FENCE#${targetId}`,
        sk: `EVENT#${timestamp}#${requestId}`,
        targetKind: 'FAMILY_FENCE',
        targetId,
        timestamp,
        requestId,
        action,
        actor: 'commercial-migration',
        subject: sha256(`subject\0${identity.split('\0')[0]}`),
        details: { stage, familyFenceVersion: 1 },
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export function buildFamilyFenceSeedTransaction({
  tableName,
  auditTableName,
  stage,
  link,
  migrationStartedAt,
}) {
  return {
    TransactItems: [
      exactCreatedLink(tableName, link),
      closureAbsent(tableName, link.guardianId),
      {
        Update: {
          TableName: tableName,
          Key: { pk: `USER#${link.guardianId}`, sk: 'PROFILE' },
          UpdateExpression: 'ADD createdMinorIds :createdMinorIds',
          ConditionExpression: [
            'attribute_exists(pk)',
            'userId = :guardianId',
            'accountType = :adult',
            '(attribute_not_exists(#status) OR #status = :active)',
            'attribute_not_exists(familyFenceVersion)',
            '(attribute_not_exists(createdMinorIds) OR NOT contains(createdMinorIds, :minorId))',
          ].join(' AND '),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':guardianId': link.guardianId,
            ':adult': 'adult',
            ':active': 'active',
            ':createdMinorIds': new Set([link.minorId]),
            ':minorId': link.minorId,
          },
        },
      },
      auditPut({
        auditTableName,
        stage,
        action: 'family_fence_seed',
        timestamp: migrationStartedAt,
        identity: `${link.guardianId}\0${link.minorId}\0${link.createdAt}`,
      }),
    ],
  };
}

export function buildFamilyFenceFinalizeTransaction({
  tableName,
  auditTableName,
  stage,
  profile,
  links,
  migrationStartedAt,
}) {
  const orderedLinks = [...links].sort((left, right) =>
    left.minorId.localeCompare(right.minorId),
  );
  const values = {
    ':guardianId': profile.userId,
    ':adult': 'adult',
    ':active': 'active',
    ':familyFenceVersion': 1,
  };
  const setConditions = [];
  if (orderedLinks.length === 0) {
    setConditions.push('attribute_not_exists(createdMinorIds)');
  } else {
    values[':expectedSize'] = orderedLinks.length;
    values[':stringSetType'] = 'SS';
    setConditions.push('attribute_type(createdMinorIds, :stringSetType)');
    setConditions.push('size(createdMinorIds) = :expectedSize');
    orderedLinks.forEach((link, index) => {
      values[`:minor${index}`] = link.minorId;
      setConditions.push(`contains(createdMinorIds, :minor${index})`);
    });
  }
  return {
    TransactItems: [
      closureAbsent(tableName, profile.userId),
      ...orderedLinks.map((link) => exactCreatedLink(tableName, link)),
      {
        Update: {
          TableName: tableName,
          Key: { pk: `USER#${profile.userId}`, sk: 'PROFILE' },
          UpdateExpression: 'SET familyFenceVersion = :familyFenceVersion',
          ConditionExpression: [
            'attribute_exists(pk)',
            'userId = :guardianId',
            'accountType = :adult',
            '(attribute_not_exists(#status) OR #status = :active)',
            'attribute_not_exists(familyFenceVersion)',
            ...setConditions,
          ].join(' AND '),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
        },
      },
      auditPut({
        auditTableName,
        stage,
        action: 'family_fence_finalize',
        timestamp: migrationStartedAt,
        identity: `${profile.userId}\0finalize`,
      }),
    ],
  };
}

async function scanAll({ ddb, tableName, startKey, onPage }) {
  let cursor = startKey;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: SAFE_READ_PROJECTION,
        ExpressionAttributeNames: SAFE_READ_NAMES,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    await onPage(response.Items ?? [], response.ScannedCount ?? 0, response.LastEvaluatedKey);
    cursor = response.LastEvaluatedKey;
  } while (cursor);
}

async function getStrong(ddb, tableName, key) {
  const response = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: key,
      ConsistentRead: true,
      ProjectionExpression: SAFE_READ_PROJECTION,
      ExpressionAttributeNames: SAFE_READ_NAMES,
    }),
  );
  return response.Item;
}

function isConditionalCancellation(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'TransactionCanceledException' ||
        error.name === 'ConditionalCheckFailedException'),
  );
}

function failedConditionIndexes(error) {
  if (!Array.isArray(error?.CancellationReasons)) return new Set();
  return new Set(
    error.CancellationReasons.flatMap((reason, index) =>
      reason?.Code === 'ConditionalCheckFailed' ? [index] : [],
    ),
  );
}

async function classifySeedCancellation({ ddb, tableName, link, error }) {
  const [currentLink, profile, closure] = await Promise.all([
    getStrong(ddb, tableName, { pk: link.pk, sk: link.sk }),
    getStrong(ddb, tableName, { pk: `USER#${link.guardianId}`, sk: 'PROFILE' }),
    getStrong(ddb, tableName, {
      pk: `ACCOUNT_CLOSURE#${link.guardianId}`,
      sk: 'STATE',
    }),
  ]);
  const failures = failedConditionIndexes(error);
  const stored = setFromAttribute(profile?.createdMinorIds);
  if (closure !== undefined) return 'closure_present';
  if (!sameCreatedLink(currentLink, link)) return 'link_changed';
  if (profile === undefined) return 'guardian_profile_missing';
  if (!isWritableAdult(profile)) return 'guardian_profile_unwritable';
  if (
    (profile.familyFenceVersion === undefined || profile.familyFenceVersion === 1) &&
    stored?.has(link.minorId)
  ) {
    return 'already';
  }
  if (failures.has(3)) return 'audit_conflict';
  if (failures.has(1)) return 'closure_race';
  if (failures.has(0)) return 'link_race';
  if (failures.has(2)) return 'profile_changed';
  return 'concurrent_change';
}

async function classifyFinalizeCancellation({ ddb, tableName, profile, links, error }) {
  const [currentProfile, closure, ...currentLinks] = await Promise.all([
    getStrong(ddb, tableName, { pk: `USER#${profile.userId}`, sk: 'PROFILE' }),
    getStrong(ddb, tableName, {
      pk: `ACCOUNT_CLOSURE#${profile.userId}`,
      sk: 'STATE',
    }),
    ...links.map((link) => getStrong(ddb, tableName, { pk: link.pk, sk: link.sk })),
  ]);
  const failures = failedConditionIndexes(error);
  if (closure !== undefined) return 'closure_present';
  if (currentProfile === undefined) return 'guardian_profile_missing';
  if (!isWritableAdult(currentProfile)) return 'guardian_profile_unwritable';
  if (!currentLinks.every((link, index) => sameCreatedLink(link, links[index]))) {
    return 'link_changed';
  }
  const stored = setFromAttribute(currentProfile?.createdMinorIds);
  const expected = new Set(links.map((link) => link.minorId));
  if (
    currentProfile.familyFenceVersion === 1 &&
    stored !== null &&
    sameSet(stored, expected)
  ) {
    return 'already';
  }
  const profileIndex = links.length + 1;
  const auditIndex = links.length + 2;
  if (failures.has(auditIndex)) return 'audit_conflict';
  if (failures.has(0)) return 'closure_race';
  if (links.some((_, index) => failures.has(index + 1))) return 'link_race';
  if (
    failures.has(profileIndex) ||
    stored === null ||
    !sameSet(stored, expected) ||
    currentProfile.familyFenceVersion !== profile.familyFenceVersion
  ) {
    return 'profile_changed';
  }
  return 'concurrent_change';
}

function baseManifest({ operation, apply, stage, tableName, auditTableName }) {
  const manifest = {
    schemaVersion: 1,
    operation,
    mode: apply ? 'apply' : 'dry-run',
    stage,
    resources: {
      primaryTable: tableName,
      auditTable: auditTableName,
    },
    scannedPages: 0,
    scannedItems: 0,
    seed: { candidates: 0, wouldApply: 0, applied: 0, alreadyApplied: 0 },
    finalize: { eligible: 0, wouldApply: 0, applied: 0, alreadyApplied: 0 },
    drift: { total: 0, reasons: {} },
    writes: 0,
  };
  driftKeysByManifest.set(manifest, new Set());
  return manifest;
}

function checkpointFor(options, phase, cursor) {
  return {
    schemaVersion: 1,
    operation: options.operation,
    stage: options.stage,
    tableName: options.tableName,
    auditTableName: options.auditTableName,
    phase,
    ...(cursor ? { cursor } : {}),
  };
}

function validateCheckpoint(checkpoint, options) {
  if (checkpoint === null || checkpoint === undefined) return null;
  if (!isObject(checkpoint)) throw new Error('checkpoint must be an object');
  for (const field of ['schemaVersion', 'operation', 'stage', 'tableName', 'auditTableName']) {
    if (checkpoint[field] !== options[field]) {
      throw new Error(`checkpoint ${field} does not match this run`);
    }
  }
  if (!['seed', 'snapshot', 'complete'].includes(checkpoint.phase)) {
    throw new Error('checkpoint phase is invalid');
  }
  if (
    checkpoint.cursor !== undefined &&
    (!isObject(checkpoint.cursor) || Object.keys(checkpoint.cursor).length === 0)
  ) {
    throw new Error('checkpoint cursor is invalid');
  }
  return checkpoint;
}

export async function runFamilyFenceMigration(options = {}) {
  const {
    operation = 'backfill',
    apply = false,
    stage,
    ddb,
    tableName,
    auditTableName,
    loadCheckpoint = async () => null,
    saveCheckpoint = async () => undefined,
    now = Date.now,
  } = options;
  if (operation !== 'backfill' && operation !== 'reconcile') {
    throw new Error('operation must be backfill or reconcile');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  if (tableName !== `roadmap-${stage}`) {
    throw new Error('primary table must exactly match the selected stage');
  }
  if (auditTableName !== `roadmap-access-audit-${stage}`) {
    throw new Error('audit table must exactly match the selected stage');
  }
  if (operation === 'reconcile' && apply) throw new Error('reconcile is read-only');
  if (!ddb || typeof ddb.send !== 'function') throw new Error('ddb is required');
  if (typeof now !== 'function') throw new Error('now must be a function');
  const migrationStartedAt = now();
  if (!Number.isSafeInteger(migrationStartedAt) || migrationStartedAt < 0) {
    throw new Error('migration clock must return a non-negative safe integer');
  }

  const manifest = baseManifest({ operation, apply, stage, tableName, auditTableName });
  const virtualSeeds = new Map();
  const checkpointOptions = {
    schemaVersion: 1,
    operation,
    stage,
    tableName,
    auditTableName,
  };
  const checkpoint = apply
    ? validateCheckpoint(await loadCheckpoint(), checkpointOptions)
    : null;
  if (
    operation === 'backfill' &&
    checkpoint?.phase !== 'snapshot' &&
    checkpoint?.phase !== 'complete'
  ) {
    await scanAll({
      ddb,
      tableName,
      startKey: checkpoint?.phase === 'seed' ? checkpoint.cursor : undefined,
      onPage: async (items, scannedCount, cursor) => {
        manifest.scannedPages += 1;
        manifest.scannedItems += scannedCount;
        for (const item of items) {
          if (!isCreatedLink(item)) continue;
          manifest.seed.candidates += 1;
          addToMapSet(virtualSeeds, item.guardianId, item.minorId);
          if (apply) {
            try {
              await ddb.send(
                new TransactWriteCommand(
                  buildFamilyFenceSeedTransaction({
                    tableName,
                    auditTableName,
                    stage,
                    link: item,
                    migrationStartedAt,
                  }),
                ),
              );
              manifest.seed.applied += 1;
              manifest.writes += 1;
            } catch (error) {
              if (!isConditionalCancellation(error)) throw error;
              const classification = await classifySeedCancellation({
                ddb,
                tableName,
                link: item,
                error,
              });
              if (classification === 'already') manifest.seed.alreadyApplied += 1;
              else addDrift(manifest, classification, item.guardianId);
            }
          }
        }
        if (apply) {
          await saveCheckpoint(
            checkpointFor(
              checkpointOptions,
              cursor ? 'seed' : 'snapshot',
              cursor,
            ),
          );
        }
      },
    });
  }

  const profiles = new Map();
  const links = new Map();
  const linkItems = new Map();
  const closures = new Set();
  const blockedGuardianIds = new Set();
  let blockAllFinalize = false;
  await scanAll({
    ddb,
    tableName,
    onPage: async (items, scannedCount) => {
      manifest.scannedPages += 1;
      manifest.scannedItems += scannedCount;
      for (const item of items) {
        if (isProfile(item)) profiles.set(item.userId, item);
        if (isCreatedLink(item)) {
          addToMapSet(links, item.guardianId, item.minorId);
          addLinkItem(linkItems, item);
        } else if (isObject(item) && item.kind === 'created') {
          const attribution = malformedCreatedLinkGuardians(item);
          for (const guardianId of attribution.guardianIds) {
            blockedGuardianIds.add(guardianId);
          }
          if (attribution.ambiguous) {
            blockAllFinalize = true;
            addDrift(
              manifest,
              'ambiguous_created_link_identity',
              sha256(`${String(item.pk)}\0${String(item.sk)}\0${String(item.gsi1pk)}`),
            );
          }
          addDrift(
            manifest,
            'invalid_created_link',
            sha256(`${String(item.pk)}\0${String(item.sk)}`),
          );
        }
        if (
          isObject(item) &&
          typeof item.pk === 'string' &&
          item.pk.startsWith('ACCOUNT_CLOSURE#') &&
          item.sk === 'STATE'
        ) {
          closures.add(item.pk.slice('ACCOUNT_CLOSURE#'.length));
        }
      }
    },
  });

  if (!apply && operation === 'backfill') {
    for (const [guardianId, minors] of virtualSeeds) {
      const profile = profiles.get(guardianId);
      if (
        isWritableAdult(profile) &&
        profile.familyFenceVersion === undefined &&
        !closures.has(guardianId)
      ) {
        manifest.seed.wouldApply += minors.size;
      }
    }
  }

  for (const guardianId of links.keys()) {
    const guardian = profiles.get(guardianId);
    if (guardian === undefined) {
      addDrift(manifest, 'guardian_profile_missing', guardianId);
    } else if (!isWritableAdult(guardian)) {
      addDrift(manifest, 'guardian_profile_unwritable', guardianId);
    }
  }

  for (const profile of profiles.values()) {
    if (!isWritableAdult(profile)) continue;
    const actual = links.get(profile.userId) ?? new Set();
    const stored = setFromAttribute(profile.createdMinorIds);
    if (stored === null) {
      addDrift(manifest, 'invalid_created_minor_set', profile.userId);
      continue;
    }
    const effective = new Set(stored);
    if (
      !apply &&
      operation === 'backfill' &&
      profile.familyFenceVersion === undefined
    ) {
      for (const minorId of virtualSeeds.get(profile.userId) ?? []) effective.add(minorId);
    }

    if (closures.has(profile.userId)) {
      addDrift(manifest, 'closure_present', profile.userId);
      continue;
    }

    if (profile.familyFenceVersion === 1) {
      if (!sameSet(effective, actual)) {
        addDrift(manifest, 'authoritative_set_mismatch', profile.userId);
      }
      continue;
    }
    if (profile.familyFenceVersion !== undefined) {
      addDrift(manifest, 'unknown_fence_version', profile.userId);
      continue;
    }
    if (operation === 'reconcile') {
      addDrift(manifest, 'unmigrated_profile', profile.userId);
      continue;
    }
    if (blockAllFinalize || blockedGuardianIds.has(profile.userId)) continue;
    manifest.finalize.eligible += 1;
    if (!sameSet(effective, actual)) {
      addDrift(manifest, 'legacy_set_mismatch', profile.userId);
      continue;
    }
    manifest.finalize.wouldApply += 1;
    if (apply) {
      const exactLinks = [...(linkItems.get(profile.userId)?.values() ?? [])];
      try {
        await ddb.send(
          new TransactWriteCommand(
            buildFamilyFenceFinalizeTransaction({
              tableName,
              auditTableName,
              stage,
              profile,
              links: exactLinks,
              migrationStartedAt,
            }),
          ),
        );
        manifest.finalize.applied += 1;
        manifest.writes += 1;
      } catch (error) {
        if (!isConditionalCancellation(error)) throw error;
        const classification = await classifyFinalizeCancellation({
          ddb,
          tableName,
          profile,
          links: exactLinks,
          error,
        });
        if (classification === 'already') manifest.finalize.alreadyApplied += 1;
        else addDrift(manifest, classification, profile.userId);
      }
    }
  }

  if (apply) {
    await saveCheckpoint(
      checkpointFor(checkpointOptions, manifest.drift.total === 0 ? 'complete' : 'seed'),
    );
  }

  return withStableManifestHash(manifest);
}

const CLI_OPTIONS = new Set([
  'operation',
  'stage',
  'profile',
  'apply',
  'confirm-stage',
  'confirm-hash',
  'checkpoint-file',
  'manifest-file',
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
    if (name === 'apply') {
      values.set(name, true);
      continue;
    }
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
  const operation = required('operation');
  const stage = required('stage');
  if (operation !== 'backfill' && operation !== 'reconcile') {
    throw new Error('operation must be backfill or reconcile');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  const profile = values.get('profile');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(profile)) {
    throw new Error('profile has an invalid format');
  }
  const apply = values.has('apply');
  if (operation === 'reconcile' && apply) throw new Error('reconcile is read-only');
  if (!apply) {
    for (const name of ['confirm-stage', 'confirm-hash', 'checkpoint-file', 'manifest-file']) {
      if (values.has(name)) throw new Error(`--${name} requires --apply`);
    }
  }
  const checkpointFile = apply ? required('checkpoint-file') : undefined;
  const manifestFile = apply ? required('manifest-file') : undefined;
  if (
    apply &&
    resolve(checkpointFile).toLocaleLowerCase('en-US') ===
      resolve(manifestFile).toLocaleLowerCase('en-US')
  ) {
    throw new Error('checkpoint and manifest files must differ');
  }
  return {
    operation,
    stage,
    profile,
    apply,
    confirmStage: apply ? required('confirm-stage') : undefined,
    confirmHash: apply ? required('confirm-hash') : undefined,
    checkpointFile,
    manifestFile,
  };
}

function validateMigrationIdentity(identity, stage) {
  if (!isObject(identity) || identity.Account !== ACCOUNT_ID) {
    throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  }
  const match = typeof identity.Arn === 'string' ? ASSUMED_ROLE_ARN.exec(identity.Arn) : null;
  if (
    !match ||
    match[1] !== ACCOUNT_ID ||
    match[2] !== `roadmap2u-${stage}-commercial-migration`
  ) {
    throw new Error('caller does not match the selected stage migration role');
  }
}

const runAwsJson = createAwsJsonRunner();
const loadAwsCredentials = createAwsCredentialLoader();

async function defaultCallerIdentity(profile) {
  return runAwsJson(profile, [
    'sts',
    'get-caller-identity',
    '--region',
    REGION,
    '--output',
    'json',
  ]);
}

async function defaultCreateDdb(profile) {
  const credentials = await loadAwsCredentials(profile);
  const client = new DynamoDBClient({
    region: REGION,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      ...(credentials.SessionToken ? { sessionToken: credentials.SessionToken } : {}),
    },
  });
  return {
    ddb: DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    destroy: () => client.destroy(),
  };
}

async function defaultReadJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw new Error('checkpoint file is unreadable or invalid');
  }
}

async function defaultWriteJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${sha256(path).slice(0, 12)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  });
  await rename(temporary, path);
}

export async function runFamilyFenceCli({
  argv,
  write = (line) => console.log(line),
  getCallerIdentity = defaultCallerIdentity,
  createDdb = defaultCreateDdb,
  runMigration = runFamilyFenceMigration,
  readJsonFile = defaultReadJsonFile,
  writeJsonFile = defaultWriteJsonFile,
} = {}) {
  const options = parseCliOptions(argv);
  const identity = await getCallerIdentity(options.profile);
  validateMigrationIdentity(identity, options.stage);
  const resources = {
    stage: options.stage,
    tableName: `roadmap-${options.stage}`,
    auditTableName: `roadmap-access-audit-${options.stage}`,
  };
  const connection = await createDdb(options.profile);
  if (!connection?.ddb || typeof connection.ddb.send !== 'function') {
    throw new Error('DynamoDB client is unavailable');
  }
  try {
    const preview = await runMigration({
      operation: options.operation,
      apply: false,
      ...resources,
      ddb: connection.ddb,
    });
    if (!HASH_PATTERN.test(preview?.manifestHash)) {
      throw new Error('dry-run returned an invalid manifest hash');
    }
    write(`dry-run operation=${options.operation} stage=${options.stage}`);
    write(`manifestHash=${preview.manifestHash}`);
    write(`manifest=${JSON.stringify(preview)}`);
    if (!options.apply) return 0;
    if (options.confirmStage !== options.stage) {
      throw new Error('confirm-stage must exactly match stage');
    }
    if (options.confirmHash !== preview.manifestHash) {
      throw new Error('confirmation hash does not match dry-run manifest');
    }
    const applied = await runMigration({
      operation: options.operation,
      apply: true,
      ...resources,
      ddb: connection.ddb,
      loadCheckpoint: () => readJsonFile(options.checkpointFile),
      saveCheckpoint: (checkpoint) => writeJsonFile(options.checkpointFile, checkpoint),
    });
    await writeJsonFile(options.manifestFile, applied);
    write(`applied operation=${options.operation} stage=${options.stage} writes=${applied.writes}`);
    write(`appliedManifestHash=${applied.manifestHash}`);
    return 0;
  } finally {
    try {
      await Promise.resolve(connection.destroy?.());
    } catch {
      // Best-effort cleanup must not replace the migration result with SDK internals.
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runFamilyFenceCli({ argv });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'family fence migration failed';
    console.error(`error=${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
