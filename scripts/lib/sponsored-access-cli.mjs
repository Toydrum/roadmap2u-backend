import { createHash } from 'node:crypto';
import {
  createAwsCredentialLoader,
  createAwsJsonRunner,
  signFunctionUrlRequest,
} from './commercial-config-cli.mjs';

const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const STAGES = new Set(['dev', 'test', 'prod']);
const COMMANDS = new Set(['issue-code', 'revoke-code', 'extend-grant', 'revoke-grant', 'metadata']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@/-]{1,128}$/;
const MUTATION_OPTIONS = new Set([
  'command-id',
  'reason',
  'apply',
  'confirm-stage',
  'confirm-hash',
]);
const COMMON_OPTIONS = new Set(['stage', 'url', 'profile']);
const COMMAND_OPTIONS = {
  'issue-code': new Set([
    ...MUTATION_OPTIONS,
    'permanent',
    'confirm-permanent',
    'duration-seconds',
    'redeem-window-seconds',
  ]),
  'revoke-code': new Set([...MUTATION_OPTIONS, 'issuance-id']),
  'extend-grant': new Set([...MUTATION_OPTIONS, 'issuance-id', 'new-expires-at']),
  'revoke-grant': new Set([...MUTATION_OPTIONS, 'issuance-id']),
  metadata: new Set(['issuance-id', 'apply', 'confirm-stage', 'confirm-hash']),
};
const FLAG_OPTIONS = new Set(['apply', 'permanent', 'confirm-permanent']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseOptions(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !COMMANDS.has(argv[0])) {
    throw new Error('First argument must be a sponsored access command');
  }
  const command = argv[0];
  const allowed = COMMAND_OPTIONS[command];
  const options = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error('Options must use --name value syntax');
    }
    const name = token.slice(2);
    if (!COMMON_OPTIONS.has(name) && !allowed.has(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    if (options.has(name)) throw new Error(`Duplicate option --${name}`);
    if (FLAG_OPTIONS.has(name)) {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function boundedReason(options) {
  const reason = required(options, 'reason');
  if (reason !== reason.trim() || reason.length === 0 || Buffer.byteLength(reason, 'utf8') > 256) {
    throw new Error('reason must be trimmed and at most 256 bytes');
  }
  return reason;
}

function positiveInteger(options, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = required(options, name);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range`);
  }
  return value;
}

function sharedOptions(options) {
  const stage = required(options, 'stage');
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  let url;
  try {
    url = new URL(required(options, 'url'));
  } catch {
    throw new Error('URL must be an AWS Lambda Function URL');
  }
  if (
    url.protocol !== 'https:' ||
    !FUNCTION_URL_HOST.test(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('URL must be an AWS Lambda Function URL in us-east-1');
  }
  const profile = options.get('profile');
  if (
    profile !== undefined &&
    (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(profile))
  ) {
    throw new Error('profile has an invalid format');
  }
  return { stage, url: url.href, profile };
}

function mutationBase(command, options, stage) {
  const commandId = required(options, 'command-id');
  if (!UUID_V4.test(commandId)) throw new Error('command-id must be a UUID v4');
  return { command, stage, commandId, reason: boundedReason(options) };
}

function issuanceId(options) {
  const value = required(options, 'issuance-id');
  if (!UUID_V4.test(value)) throw new Error('issuance-id must be a UUID v4');
  return value;
}

function buildUnsignedBody(command, options, stage) {
  if (command === 'metadata') {
    return { command, stage, issuanceId: issuanceId(options) };
  }
  const base = mutationBase(command, options, stage);
  if (command === 'issue-code') {
    const permanent = options.has('permanent');
    const confirmPermanent = options.has('confirm-permanent');
    if (permanent !== confirmPermanent) {
      throw new Error('permanent access requires --permanent and --confirm-permanent');
    }
    if (permanent && options.has('duration-seconds')) {
      throw new Error('permanent access cannot include duration-seconds');
    }
    const body = { ...base, grantOfferKey: 'premium_demo' };
    if (permanent) {
      body.permanent = true;
      body.confirmPermanent = true;
    }
    if (options.has('duration-seconds')) {
      body.durationSeconds = positiveInteger(options, 'duration-seconds', {
        minimum: 86_400,
        maximum: 157_680_000,
      });
    }
    if (options.has('redeem-window-seconds')) {
      body.redeemWindowSeconds = positiveInteger(options, 'redeem-window-seconds', {
        minimum: 3_600,
        maximum: 2_592_000,
      });
    }
    return body;
  }
  const body = { ...base, issuanceId: issuanceId(options) };
  if (command === 'extend-grant') {
    body.newExpiresAt = positiveInteger(options, 'new-expires-at');
  }
  return body;
}

function validateIdentity(identity, stage) {
  if (!identity || identity.Account !== ACCOUNT_ID) {
    throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  }
  const match = typeof identity.Arn === 'string' ? ASSUMED_ROLE_ARN.exec(identity.Arn) : null;
  if (!match || match[1] !== ACCOUNT_ID) throw new Error('caller must use an STS assumed role');
  if (match[2] !== `roadmap2u-${stage}-sponsored-access-operator`) {
    throw new Error('caller does not match the selected stage role');
  }
}

function outputResult(response, payload, write, command, stage) {
  if (!response.ok) {
    const code =
      isObject(payload) && typeof payload.error === 'string' && /^[A-Z_]{2,64}$/.test(payload.error)
        ? payload.error
        : 'BROKER_ERROR';
    throw new Error(`broker rejected ${command} with status ${response.status} (${code})`);
  }
  if (!isObject(payload) || payload.command !== command) {
    throw new Error('broker returned an invalid sponsored access response');
  }
  write(`applied command=${command} stage=${stage} status=${response.status}`);
  if (typeof payload.idempotent === 'boolean') write(`idempotent=${payload.idempotent}`);
  if (isObject(payload.metadata)) {
    if (
      typeof payload.metadata.issuanceId === 'string' &&
      UUID_V4.test(payload.metadata.issuanceId)
    ) {
      write(`issuanceId=${payload.metadata.issuanceId}`);
    }
    if (
      typeof payload.metadata.status === 'string' &&
      /^[a-z-]{2,32}$/.test(payload.metadata.status)
    ) {
      write(`status=${payload.metadata.status}`);
    }
    if (
      typeof payload.metadata.expiresAt === 'number' &&
      Number.isSafeInteger(payload.metadata.expiresAt)
    ) {
      write(`expiresAt=${payload.metadata.expiresAt}`);
    }
  }
  if (command === 'issue-code') {
    const reveal =
      payload.idempotent === false &&
      payload.plaintextUnavailable === false &&
      typeof payload.plaintext === 'string' &&
      /^RM2U1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{22,86}$/.test(payload.plaintext);
    if (reveal) write(`accessCode=${payload.plaintext}`);
    else write('plaintextUnavailable=true');
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

export async function runSponsoredAccessCli({
  argv,
  write = (line) => console.log(line),
  getCallerIdentity = defaultCallerIdentity,
  getCredentials = loadAwsCredentials,
  fetch: fetchRequest = globalThis.fetch,
  now = () => new Date(),
  isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
}) {
  const { command, options } = parseOptions(argv);
  const shared = sharedOptions(options);
  const unsignedBody = buildUnsignedBody(command, options, shared.stage);
  const confirmationHash = sha256(canonicalJson(unsignedBody));

  const identity = await getCallerIdentity(shared.profile);
  validateIdentity(identity, shared.stage);

  if (!options.has('apply')) {
    write(`dry-run command=${command} stage=${shared.stage}`);
    write(`confirmHash=${confirmationHash}`);
    return 0;
  }
  if (!isInteractive) throw new Error('apply requires an interactive terminal');
  if (options.get('confirm-stage') !== shared.stage) {
    throw new Error('confirm-stage must exactly match stage');
  }
  const suppliedHash = options.get('confirm-hash');
  if (
    typeof suppliedHash !== 'string' ||
    !HASH.test(suppliedHash) ||
    suppliedHash !== confirmationHash
  ) {
    throw new Error('confirmation hash does not match dry-run hash');
  }

  const body = JSON.stringify(
    command === 'metadata' ? unsignedBody : { ...unsignedBody, confirmHash: confirmationHash },
  );
  const credentials = await getCredentials(shared.profile);
  const headers = signFunctionUrlRequest({
    url: shared.url,
    body,
    credentials,
    now: now(),
  });
  const response = await fetchRequest(shared.url, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
  });
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error(`broker returned invalid JSON with status ${response.status}`);
  }
  outputResult(response, payload, write, command, shared.stage);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runSponsoredAccessCli({ argv });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'sponsored access command failed';
    console.error(`error=${message}`);
    process.exitCode = 1;
  }
}
