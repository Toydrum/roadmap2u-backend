import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  runCommercialInventory,
  validateCommercialInventoryManifest,
} from '../scripts/commercial-inventory.mjs';
import { instrumentHandler } from './observability.ts';

const STAGES = new Set(['dev', 'test', 'prod']);
const ACCOUNT_PATTERN = /^[0-9]{12}$/;
const ROLE_PATTERN = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@\/-]{1,128}$/;
const DEADLINE_MARGIN_MILLISECONDS = 30_000;
const MAX_BODY_BYTES = 256;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}

function actorStatus(event, accountId, roleName) {
  const actor = event?.requestContext?.authorizer?.iam?.userArn;
  if (typeof actor !== 'string' || actor.length === 0) return 401;
  const match = ASSUMED_ROLE_ARN.exec(actor);
  return match?.[1] === accountId && match?.[2] === roleName ? 200 : 403;
}

function parseRequest(event, stage) {
  if (
    event?.isBase64Encoded === true ||
    typeof event?.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    return null;
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return null;
  }
  if (
    !hasExactKeys(body, ['command', 'stage']) ||
    body.command !== 'commercial-inventory' ||
    body.stage !== stage
  ) {
    return null;
  }
  return body;
}

export function createCommercialInventoryExecutor({
  stage,
  tableName,
  accountId,
  roleName,
  ddb,
  runInventory = runCommercialInventory,
} = {}) {
  if (!STAGES.has(stage)) throw new Error('commercial inventory stage is invalid');
  if (tableName !== `roadmap-${stage}`) {
    throw new Error('commercial inventory table does not match stage');
  }
  if (!ACCOUNT_PATTERN.test(accountId)) {
    throw new Error('commercial inventory account allowlist is invalid');
  }
  if (
    !ROLE_PATTERN.test(roleName) ||
    roleName !== `roadmap2u-${stage}-commercial-migration`
  ) {
    throw new Error('commercial inventory role allowlist is invalid');
  }
  if (!ddb || typeof ddb.send !== 'function' || typeof runInventory !== 'function') {
    throw new Error('commercial inventory dependencies are unavailable');
  }

  return async (event, context) => {
    if (event?.requestContext?.http?.method !== 'POST') {
      return respond(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    const authorization = actorStatus(event, accountId, roleName);
    if (authorization === 401) return respond(401, { error: 'UNAUTHENTICATED' });
    if (authorization === 403) return respond(403, { error: 'FORBIDDEN' });
    if (!parseRequest(event, stage)) {
      return respond(400, { error: 'INVALID_REQUEST' });
    }
    if (typeof context?.getRemainingTimeInMillis !== 'function') {
      throw new Error('commercial inventory single-invocation deadline is unavailable');
    }
    const manifest = await runInventory({
      stage,
      tableName,
      ddb,
      beforePage: async () => {
        if (context.getRemainingTimeInMillis() <= DEADLINE_MARGIN_MILLISECONDS) {
          throw new Error('commercial inventory single-invocation deadline exceeded');
        }
      },
    });
    return respond(
      200,
      validateCommercialInventoryManifest(manifest, stage, tableName),
    );
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required ${name}`);
  return value.trim();
}

function parseAllowlist(raw, stage) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('COMMERCIAL_INVENTORY_ALLOWLIST must be valid JSON');
  }
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !hasExactKeys(value[0], ['accountId', 'roleName', 'stage']) ||
    !ACCOUNT_PATTERN.test(value[0].accountId) ||
    !ROLE_PATTERN.test(value[0].roleName) ||
    value[0].stage !== stage ||
    value[0].roleName !== `roadmap2u-${stage}-commercial-migration`
  ) {
    throw new Error('COMMERCIAL_INVENTORY_ALLOWLIST is invalid');
  }
  return value[0];
}

let runtimeExecutor;

function getRuntimeExecutor() {
  if (runtimeExecutor) return runtimeExecutor;
  const stage = requiredEnvironment('COMMERCIAL_STAGE');
  if (!STAGES.has(stage)) throw new Error('COMMERCIAL_STAGE must be dev, test, or prod');
  const tableName = requiredEnvironment('TABLE_NAME');
  const allowlist = parseAllowlist(
    requiredEnvironment('COMMERCIAL_INVENTORY_ALLOWLIST'),
    stage,
  );
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  runtimeExecutor = createCommercialInventoryExecutor({
    stage,
    tableName,
    accountId: allowlist.accountId,
    roleName: allowlist.roleName,
    ddb,
  });
  return runtimeExecutor;
}

export const handler = instrumentHandler('commercial-inventory-executor', async (event, context) =>
  getRuntimeExecutor()(event, context),
);
