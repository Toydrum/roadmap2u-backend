import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createAwsCredentialLoader,
  createAwsJsonRunner,
} from './lib/commercial-config-cli.mjs';
import {
  runFamilyModelMigration,
  validateFamilyModelManifest,
} from './lib/family-model-migration.mjs';

const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const STAGES = new Set(['dev', 'test', 'prod']);
const OPERATIONS = new Set(['inventory', 'backfill', 'reconcile']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@/-]{1,128}$/;
const CLI_OPTIONS = new Set([
  'operation',
  'stage',
  'account',
  'profile',
  'apply',
  'confirm-stage',
  'confirm-account',
  'confirm-hash',
  'checkpoint-file',
  'manifest-file',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
  const accountId = required('account');
  if (!OPERATIONS.has(operation)) {
    throw new Error('operation must be inventory, backfill, or reconcile');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  if (accountId !== ACCOUNT_ID) throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  const profile = values.get('profile');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(profile)) {
    throw new Error('profile has an invalid format');
  }
  const apply = values.has('apply');
  if (apply && operation !== 'backfill') throw new Error('only backfill supports --apply');
  const guardedOptions = [
    'confirm-stage',
    'confirm-account',
    'confirm-hash',
    'checkpoint-file',
    'manifest-file',
  ];
  if (!apply && guardedOptions.some((name) => values.has(name))) {
    throw new Error('confirmation and output options require --apply');
  }
  const confirmStage = apply ? required('confirm-stage') : undefined;
  const confirmAccount = apply ? required('confirm-account') : undefined;
  const confirmHash = apply ? required('confirm-hash') : undefined;
  const checkpointFile = apply ? required('checkpoint-file') : undefined;
  const manifestFile = apply ? required('manifest-file') : undefined;
  if (apply && !HASH_PATTERN.test(confirmHash)) {
    throw new Error('confirm-hash must be lowercase SHA-256');
  }
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
    accountId,
    profile,
    apply,
    confirmStage,
    confirmAccount,
    confirmHash,
    checkpointFile,
    manifestFile,
  };
}

function validateIdentity(identity, stage, accountId) {
  if (!isObject(identity) || identity.Account !== accountId) {
    throw new Error(`AWS account must be ${accountId}`);
  }
  const match = typeof identity.Arn === 'string' ? ASSUMED_ROLE_ARN.exec(identity.Arn) : null;
  if (
    !match ||
    match[1] !== accountId ||
    match[2] !== `roadmap2u-${stage}-commercial-migration`
  ) {
    throw new Error('caller does not match the selected stage migration role');
  }
}

function validateManifest(manifest, operation, stage, accountId, mode) {
  return validateFamilyModelManifest(manifest, { operation, stage, accountId, mode });
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
    if (isObject(error) && error.code === 'ENOENT') return null;
    throw new Error('checkpoint file is unreadable or invalid');
  }
}

async function defaultWriteJsonFile(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${resolve(path)}.${process.pid}.${sha256(resolve(path)).slice(0, 12)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  });
  await rename(temporary, resolve(path));
}

export async function runFamilyModelMigrationCli({
  argv = process.argv.slice(2),
  write = (line) => console.log(line),
  getCallerIdentity = defaultCallerIdentity,
  createDdb = defaultCreateDdb,
  runMigration = runFamilyModelMigration,
  readJsonFile = defaultReadJsonFile,
  writeJsonFile = defaultWriteJsonFile,
} = {}) {
  const options = parseCliOptions(argv);
  const identity = await getCallerIdentity(options.profile);
  validateIdentity(identity, options.stage, options.accountId);
  const connection = await createDdb(options.profile);
  if (!connection?.ddb || typeof connection.ddb.send !== 'function') {
    throw new Error('DynamoDB client is unavailable');
  }
  const resources = {
    operation: options.operation,
    stage: options.stage,
    accountId: options.accountId,
    tableName: `roadmap-${options.stage}`,
    auditTableName: `roadmap-access-audit-${options.stage}`,
    ddb: connection.ddb,
  };
  try {
    const preview = validateManifest(
      await runMigration({ ...resources, apply: false }),
      options.operation,
      options.stage,
      options.accountId,
      'dry-run',
    );
    write(
      `dry-run operation=${options.operation} stage=${options.stage} account=${options.accountId}`,
    );
    write(`manifestHash=${preview.manifestHash}`);
    write(`manifest=${JSON.stringify(preview)}`);
    if (!options.apply) return 0;
    if (options.confirmStage !== options.stage) {
      throw new Error('confirm-stage must exactly match stage');
    }
    if (options.confirmAccount !== options.accountId) {
      throw new Error('confirm-account must exactly match account');
    }
    if (options.confirmHash !== preview.manifestHash) {
      throw new Error('confirmation hash does not match dry-run manifest');
    }
    const applied = validateManifest(
      await runMigration({
        ...resources,
        apply: true,
        expectedManifestHash: preview.manifestHash,
        loadCheckpoint: () => readJsonFile(options.checkpointFile),
        saveCheckpoint: (checkpoint) => writeJsonFile(options.checkpointFile, checkpoint),
      }),
      options.operation,
      options.stage,
      options.accountId,
      'apply',
    );
    await writeJsonFile(options.manifestFile, applied);
    write(
      `applied operation=${options.operation} stage=${options.stage} account=${options.accountId} writes=${applied.writes}`,
    );
    write(`appliedManifestHash=${applied.manifestHash}`);
    return 0;
  } finally {
    try {
      await Promise.resolve(connection.destroy?.());
    } catch {
      // Best-effort SDK cleanup must not replace the migration result.
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runFamilyModelMigrationCli({ argv });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'family model migration failed';
    console.error(`error=${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
