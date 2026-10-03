import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createAwsCredentialLoader, createAwsJsonRunner } from './lib/commercial-config-cli.mjs';

const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const STAGES = new Set(['dev', 'test', 'prod']);
const OPS = new Set(['inventory', 'backfill', 'reconcile']);
const GSI_PK = 'FAMILY#MAJORITY';
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function planMajorityBackfill(rows, now) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(now)) throw new Error('invalid inventory');
  const today = new Date(now).toISOString().slice(0, 10);
  const totals = { activeMinors: 0, missingDeclaration: 0, indexed: 0,
    candidates: 0, indexDrift: 0, alreadyDue: 0 };
  const candidates = [];
  for (const row of rows) {
    if (!row || row.sk !== 'PROFILE' || row.accountType !== 'minor' ||
      typeof row.userId !== 'string' || row.pk !== `USER#${row.userId}` ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(row.userId) ||
      (row.status !== undefined && row.status !== 'active')) continue;
    totals.activeMinors += 1;
    if (!validDate(row.majorityAt)) { totals.missingDeclaration += 1; continue; }
    if (row.majorityAt <= today) totals.alreadyDue += 1;
    const expectedSk = `${row.majorityAt}#${row.userId}`;
    if (row.gsi2pk === GSI_PK && row.gsi2sk === expectedSk) {
      totals.indexed += 1;
    } else if (row.gsi2pk === undefined && row.gsi2sk === undefined) {
      totals.candidates += 1;
      candidates.push({ accountId: row.userId, majorityAt: row.majorityAt,
        indexSk: expectedSk });
    } else totals.indexDrift += 1;
  }
  candidates.sort((a, b) => a.accountId.localeCompare(b.accountId));
  return { totals, candidates, planHash: hash(JSON.stringify(candidates)) };
}

export function majorityBackfillTransaction(candidate, stage, now, requestId = randomUUID()) {
  if (!STAGES.has(stage) || !Number.isSafeInteger(now) || !validDate(candidate.majorityAt) ||
    candidate.indexSk !== `${candidate.majorityAt}#${candidate.accountId}`) {
    throw new Error('invalid backfill transaction');
  }
  const table = `roadmap-${stage}`;
  const auditTable = `roadmap-access-audit-${stage}`;
  return new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: table, Key: { pk: `USER#${candidate.accountId}`, sk: 'PROFILE' },
      UpdateExpression: 'SET gsi2pk = :indexPk, gsi2sk = :indexSk',
      ConditionExpression: 'attribute_exists(pk) AND userId = :accountId AND accountType = :minor AND majorityAt = :majorityAt AND (attribute_not_exists(#status) OR #status = :active) AND attribute_not_exists(gsi2pk) AND attribute_not_exists(gsi2sk)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':indexPk': GSI_PK, ':indexSk': candidate.indexSk,
        ':accountId': candidate.accountId, ':minor': 'minor',
        ':majorityAt': candidate.majorityAt, ':active': 'active' },
    } },
    { ConditionCheck: { TableName: table,
      Key: { pk: `ACCOUNT_CLOSURE#${candidate.accountId}`, sk: 'STATE' },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' } },
    { Put: { TableName: auditTable,
      Item: { pk: `TARGET#FAMILY_AGE#${candidate.accountId}`,
        sk: `EVENT#${now}#${requestId}`, targetKind: 'FAMILY_AGE',
        targetId: candidate.accountId, timestamp: now, requestId,
        action: 'majority_index_backfill', actor: `roadmap2u-${stage}-commercial-migration`,
        subject: candidate.accountId,
        details: { majorityAt: candidate.majorityAt } },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' } },
  ] });
}

function parseArgs(argv) {
  const allowed = new Set(['operation', 'stage', 'account', 'profile', 'apply',
    'confirm-stage', 'confirm-account', 'confirm-hash']);
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--') || !allowed.has(token.slice(2)) || args.has(token.slice(2)))
      throw new Error('invalid or duplicate option');
    const key = token.slice(2);
    if (key === 'apply') { args.set(key, true); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing --${key}`);
    args.set(key, value);
  }
  const operation = args.get('operation');
  const stage = args.get('stage');
  const account = args.get('account');
  const apply = args.has('apply');
  if (!OPS.has(operation) || !STAGES.has(stage) || account !== ACCOUNT_ID)
    throw new Error('operation, stage or AWS account is invalid');
  if (args.get('profile') && !/^[A-Za-z0-9_.-]{1,128}$/.test(args.get('profile')))
    throw new Error('profile is invalid');
  if (apply && (operation !== 'backfill' || args.get('confirm-stage') !== stage ||
    args.get('confirm-account') !== account || !HEX64.test(args.get('confirm-hash') ?? '')))
    throw new Error('backfill apply requires exact stage, account and plan hash confirmations');
  if (!apply && ['confirm-stage', 'confirm-account', 'confirm-hash'].some((key) => args.has(key)))
    throw new Error('confirmations require --apply');
  return { operation, stage, account, profile: args.get('profile'), apply,
    confirmHash: args.get('confirm-hash') };
}

async function scan(ddb, stage) {
  const rows = [];
  let cursor;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: `roadmap-${stage}`,
      ConsistentRead: true, Select: 'SPECIFIC_ATTRIBUTES',
      ProjectionExpression: 'pk, sk, userId, accountType, #status, majorityAt, gsi2pk, gsi2sk',
      ExpressionAttributeNames: { '#status': 'status' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    rows.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}

export async function runMajorityBackfillCli(argv = process.argv.slice(2), io = {}) {
  const options = parseArgs(argv);
  const runAwsJson = io.runAwsJson ?? createAwsJsonRunner();
  const loadCredentials = io.loadCredentials ?? createAwsCredentialLoader();
  const identity = await runAwsJson(options.profile, ['sts', 'get-caller-identity',
    '--region', REGION, '--output', 'json']);
  if (identity?.Account !== options.account ||
    !new RegExp(`^arn:aws:sts::${options.account}:assumed-role/roadmap2u-${options.stage}-commercial-migration/[A-Za-z0-9_+=,.@/-]+$`).test(identity?.Arn ?? '')) {
    throw new Error('caller is not the selected stage migration role');
  }
  const credentials = await loadCredentials(options.profile);
  const client = new DynamoDBClient({ region: REGION,
    credentials: { accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      ...(credentials.SessionToken ? { sessionToken: credentials.SessionToken } : {}) } });
  const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  try {
    const now = Date.now();
    const plan = planMajorityBackfill(await scan(ddb, options.stage), now);
    if (options.apply && options.confirmHash !== plan.planHash)
      throw new Error('inventory changed: plan hash mismatch');
    let applied = 0;
    if (options.apply) {
      if (plan.totals.indexDrift)
        throw new Error('index drift must be reconciled before apply');
      for (const candidate of plan.candidates) {
        await ddb.send(majorityBackfillTransaction(candidate, options.stage, Date.now()));
        applied += 1;
      }
    }
    const manifest = { operation: options.operation, stage: options.stage,
      account: options.account, mode: options.apply ? 'apply' : 'dry-run',
      planHash: plan.planHash, totals: plan.totals, applied };
    (io.write ?? console.log)(JSON.stringify(manifest, null, 2));
    return manifest;
  } finally { client.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMajorityBackfillCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
