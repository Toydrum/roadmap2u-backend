import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ACCOUNT_ID = '765932874577';
const REGION = 'us-east-1';
const STAGES = new Set(['dev', 'test', 'prod']);
const MODES = new Set(['off', 'observe', 'enforce']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws$/;
const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/([A-Za-z0-9_+=,.@-]{2,64})$/;
const AMBIENT_CREDENTIAL_VARIABLES = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CREDENTIAL_SCOPE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
]);

const COMMAND_OPTIONS = {
  'bootstrap-flags': new Set([]),
  'set-flags': new Set([
    'expected-revision',
    'quota-mode',
    'capability-mode',
    'access-code-issuance-enabled',
    'access-code-redemption-enabled',
  ]),
  'freeze-cutover': new Set(['cutover-at', 'inventory-manifest-hash']),
};
const COMMON_OPTIONS = new Set([
  'stage',
  'url',
  'reason',
  'profile',
  'apply',
  'confirm-stage',
  'confirm-hash',
]);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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

export function buildCutoverEvidenceMirror({
  stage,
  commercialEntitlementsCutoverAt,
  inventoryManifestHash,
} = {}) {
  if (!STAGES.has(stage)) throw new Error('evidence stage must be dev, test, or prod');
  const timestamp = Date.parse(commercialEntitlementsCutoverAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== commercialEntitlementsCutoverAt
  ) {
    throw new Error('evidence cutover timestamp must be canonical UTC ISO-8601');
  }
  if (!HASH_PATTERN.test(inventoryManifestHash)) {
    throw new Error('evidence inventory manifest hash must be lowercase SHA-256');
  }
  const mirror = {
    schemaVersion: 1,
    evidenceKind: 'commercial-cutover',
    stage,
    commercialEntitlementsCutoverAt,
    inventoryManifestHash,
  };
  return { ...mirror, mirrorHash: sha256(canonicalJson(mirror)) };
}

function validateCutoverEvidenceMirror(mirror, stage) {
  if (
    !isObject(mirror) ||
    Object.keys(mirror).length !== 6 ||
    mirror.schemaVersion !== 1 ||
    mirror.evidenceKind !== 'commercial-cutover' ||
    mirror.stage !== stage ||
    !HASH_PATTERN.test(mirror.inventoryManifestHash) ||
    !HASH_PATTERN.test(mirror.mirrorHash)
  ) {
    throw new Error('cutover evidence mirror is invalid');
  }
  const expected = buildCutoverEvidenceMirror({
    stage: mirror.stage,
    commercialEntitlementsCutoverAt: mirror.commercialEntitlementsCutoverAt,
    inventoryManifestHash: mirror.inventoryManifestHash,
  });
  if (canonicalJson(expected) !== canonicalJson(mirror)) {
    throw new Error('cutover evidence mirror hash does not match its contents');
  }
  return mirror;
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
  const segments = root.toLocaleLowerCase('en-US').split(/[\\/]+/);
  if (
    segments.at(-2) !== 'evidence' ||
    segments.at(-1) !== 'commercial-launch'
  ) {
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

export function createCutoverEvidenceWriter({
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
    throw new Error('evidence filesystem seams must be functions');
  }
  return async ({ evidenceRoot, stage, mirror } = {}) => {
    const root = resolveEvidenceRoot(evidenceRoot, cwd);
    validateCutoverEvidenceMirror(mirror, stage);
    const directory = resolve(root, 'cutover', stage);
    const path = resolve(directory, `${mirror.mirrorHash}.json`);
    const content = `${canonicalJson(mirror)}\n`;
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
        throw new Error('cutover evidence mirror could not be written');
      }
      let existing;
      try {
        existing = await readEvidenceFile(path, 'utf8');
      } catch {
        throw new Error('existing cutover evidence mirror is unreadable');
      }
      if (existing !== content) {
        throw new Error('existing cutover evidence mirror has different contents');
      }
      return { path, created: false };
    }
  };
}

const writeCutoverEvidence = createCutoverEvidenceWriter();

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function parseOptions(argv, command) {
  const commandOptions = COMMAND_OPTIONS[command];
  if (!commandOptions) throw new Error('Unsupported commercial config command');
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error('Options must use --name value syntax');
    }
    const name = token.slice(2);
    if (!COMMON_OPTIONS.has(name) && !commandOptions.has(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    if (options.has(name)) throw new Error(`Duplicate option --${name}`);
    if (name === 'apply') {
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
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} must be true or false`);
}

function parseShared(options) {
  const stage = required(options, 'stage');
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');

  const rawUrl = required(options, 'url');
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

  const reason = required(options, 'reason');
  if (
    reason !== reason.trim() ||
    reason.length === 0 ||
    Buffer.byteLength(reason, 'utf8') > 256
  ) {
    throw new Error('reason must be trimmed and at most 256 bytes');
  }
  const profile = options.get('profile');
  if (profile !== undefined && (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(profile))) {
    throw new Error('profile has an invalid format');
  }
  return { stage, url: url.href, reason, profile };
}

function buildRequest(command, options) {
  const shared = parseShared(options);
  if (command === 'bootstrap-flags') {
    return { shared, body: { command, stage: shared.stage, reason: shared.reason } };
  }

  if (command === 'set-flags') {
    const revisionText = required(options, 'expected-revision');
    if (!/^[1-9][0-9]*$/.test(revisionText)) {
      throw new Error('expected revision must be a positive integer');
    }
    const expectedRevision = Number(revisionText);
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new Error('expected revision must be a safe integer');
    }
    const changes = {};
    for (const [optionName, fieldName] of [
      ['quota-mode', 'quotaMode'],
      ['capability-mode', 'capabilityMode'],
    ]) {
      const value = options.get(optionName);
      if (value !== undefined) {
        if (typeof value !== 'string' || !MODES.has(value)) {
          throw new Error(`--${optionName} must be off, observe, or enforce`);
        }
        changes[fieldName] = value;
      }
    }
    for (const [optionName, fieldName] of [
      ['access-code-issuance-enabled', 'accessCodeIssuanceEnabled'],
      ['access-code-redemption-enabled', 'accessCodeRedemptionEnabled'],
    ]) {
      const value = options.get(optionName);
      if (value !== undefined) changes[fieldName] = parseBoolean(value, optionName);
    }
    if (Object.keys(changes).length === 0) throw new Error('set-flags requires at least one change');
    return {
      shared,
      body: {
        command,
        stage: shared.stage,
        expectedRevision,
        reason: shared.reason,
        changes,
      },
    };
  }

  const cutoverAt = required(options, 'cutover-at');
  const timestamp = Date.parse(cutoverAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== cutoverAt) {
    throw new Error('cutover timestamp must be canonical UTC ISO-8601');
  }
  const manifestHash = required(options, 'inventory-manifest-hash');
  if (!HASH_PATTERN.test(manifestHash)) {
    throw new Error('inventory manifest hash must be lowercase SHA-256');
  }
  return {
    shared,
    body: {
      command,
      stage: shared.stage,
      commercialEntitlementsCutoverAt: cutoverAt,
      inventoryManifestHash: manifestHash,
      reason: shared.reason,
    },
  };
}

function validateIdentity(identity, command, stage) {
  if (!identity || identity.Account !== ACCOUNT_ID) {
    throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  }
  const match = typeof identity.Arn === 'string' ? ASSUMED_ROLE_ARN.exec(identity.Arn) : null;
  if (!match) throw new Error('caller must use an STS assumed role');
  const [, arnAccount, roleName] = match;
  if (arnAccount !== ACCOUNT_ID) throw new Error(`AWS account must be ${ACCOUNT_ID}`);
  const suffix = command === 'set-flags' ? 'commercial-flag-operator' : 'commercial-migration';
  if (roleName !== `roadmap2u-${stage}-${suffix}`) {
    throw new Error('caller does not match the selected stage role');
  }
}

function amzDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export function signFunctionUrlRequest({ url, body, credentials, now }) {
  if (
    !credentials ||
    typeof credentials.AccessKeyId !== 'string' ||
    typeof credentials.SecretAccessKey !== 'string' ||
    credentials.AccessKeyId.length === 0 ||
    credentials.SecretAccessKey.length === 0
  ) {
    throw new Error('AWS credentials are unavailable');
  }
  const target = new URL(url);
  const payloadHash = sha256(body);
  const timestamp = amzDate(now);
  const date = timestamp.slice(0, 8);
  const headers = {
    'content-type': 'application/json',
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (typeof credentials.SessionToken === 'string' && credentials.SessionToken.length > 0) {
    headers['x-amz-security-token'] = credentials.SessionToken;
  }
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const canonicalRequest = [
    'POST',
    target.pathname,
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${REGION}/lambda/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${credentials.SecretAccessKey}`, date);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, 'lambda');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

function awsArguments(profile, args) {
  return profile ? [...args, '--profile', profile] : args;
}

function configuredExecutable(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function isMissingExecutable(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ('code' in error ? error.code === 'ENOENT' : false),
  );
}

export function createAwsJsonRunner({
  execute = execFileSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  const awsExecutable = configuredExecutable(
    env.ROADMAP2U_AWS_CLI,
    platform === 'win32' ? 'aws.cmd' : 'aws',
  );
  const pythonExecutable = configuredExecutable(env.ROADMAP2U_PYTHON, 'python');
  const executionOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };

  return (profile, args) => {
    const cliArguments = awsArguments(profile, args);
    let output;
    try {
      output = execute(awsExecutable, cliArguments, executionOptions);
    } catch (error) {
      if (!isMissingExecutable(error)) throw new Error('AWS CLI request failed');
      try {
        output = execute(
          pythonExecutable,
          ['-m', 'awscli', ...cliArguments],
          executionOptions,
        );
      } catch {
        throw new Error('AWS CLI request failed');
      }
    }
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('AWS CLI returned invalid JSON');
    }
  };
}

const runAwsJson = createAwsJsonRunner();

export function createAwsCredentialLoader({
  createClient = (config) => new DynamoDBClient(config),
  env = process.env,
} = {}) {
  return async (profile) => {
    const explicitProfile = profile !== undefined;
    if (
      explicitProfile &&
      AMBIENT_CREDENTIAL_VARIABLES.some(
        (name) => typeof env[name] === 'string' && env[name].trim().length > 0,
      )
    ) {
      throw new Error('Explicit --profile cannot be combined with ambient AWS credential sources');
    }
    const previousProfile = env.AWS_PROFILE;
    const previousImdsDisabled = env.AWS_EC2_METADATA_DISABLED;
    if (explicitProfile) {
      env.AWS_PROFILE = profile;
      env.AWS_EC2_METADATA_DISABLED = 'true';
    }
    let client;
    try {
      client = createClient({
        region: REGION,
        ...(explicitProfile ? { profile } : {}),
      });
      const credentials = await client.config.credentials();
      if (
        !credentials ||
        typeof credentials.accessKeyId !== 'string' ||
        credentials.accessKeyId.length === 0 ||
        typeof credentials.secretAccessKey !== 'string' ||
        credentials.secretAccessKey.length === 0
      ) {
        throw new Error('invalid credentials');
      }
      return {
        AccessKeyId: credentials.accessKeyId,
        SecretAccessKey: credentials.secretAccessKey,
        ...(typeof credentials.sessionToken === 'string' && credentials.sessionToken.length > 0
          ? { SessionToken: credentials.sessionToken }
          : {}),
      };
    } catch {
      throw new Error('AWS credentials are unavailable');
    } finally {
      try {
        client?.destroy();
      } catch {
        // Destruction is best-effort; never replace a credential-resolution result with internals.
      }
      if (explicitProfile) {
        if (previousProfile === undefined) delete env.AWS_PROFILE;
        else env.AWS_PROFILE = previousProfile;
        if (previousImdsDisabled === undefined) delete env.AWS_EC2_METADATA_DISABLED;
        else env.AWS_EC2_METADATA_DISABLED = previousImdsDisabled;
      }
    }
  };
}

const loadAwsCredentials = createAwsCredentialLoader();

async function defaultCallerIdentity(profile) {
  return runAwsJson(profile, ['sts', 'get-caller-identity', '--region', REGION, '--output', 'json']);
}

async function defaultCredentials(profile) {
  return loadAwsCredentials(profile);
}

function safeResult(response, payload, write, command, stage) {
  if (!response.ok) {
    const code = payload && typeof payload.error === 'string' ? payload.error : 'BROKER_ERROR';
    throw new Error(`broker rejected ${command} with status ${response.status} (${code})`);
  }
  write(`applied command=${command} stage=${stage} status=${response.status}`);
  if (Number.isSafeInteger(payload?.revision)) write(`revision=${payload.revision}`);
  if (typeof payload?.idempotent === 'boolean') write(`idempotent=${payload.idempotent}`);
  if (typeof payload?.commercialEntitlementsCutoverAt === 'string') {
    write(`cutoverAt=${payload.commercialEntitlementsCutoverAt}`);
  }
  if (typeof payload?.inventoryManifestHash === 'string' && HASH_PATTERN.test(payload.inventoryManifestHash)) {
    write(`inventoryManifestHash=${payload.inventoryManifestHash}`);
  }
}

function validateFreezeResponse(response, payload, requestBody) {
  const expectedKeys = [
    'command',
    'commercialEntitlementsCutoverAt',
    'idempotent',
    'inventoryManifestHash',
  ];
  if (
    !isObject(payload) ||
    canonicalJson(Object.keys(payload).sort()) !== canonicalJson(expectedKeys) ||
    payload.command !== 'freeze-cutover' ||
    payload.commercialEntitlementsCutoverAt !==
      requestBody.commercialEntitlementsCutoverAt ||
    payload.inventoryManifestHash !== requestBody.inventoryManifestHash ||
    typeof payload.idempotent !== 'boolean' ||
    (payload.idempotent ? response.status !== 200 : response.status !== 201)
  ) {
    throw new Error('broker freeze response does not exactly match the request');
  }
}

export async function runCommercialConfigCli({
  command,
  argv,
  write = (line) => console.log(line),
  getCallerIdentity = defaultCallerIdentity,
  getCredentials = defaultCredentials,
  fetch: fetchRequest = globalThis.fetch,
  now = () => new Date(),
  evidenceRoot = process.env.EVIDENCE_ROOT,
  writeEvidenceMirror = writeCutoverEvidence,
}) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array');
  const options = parseOptions(argv, command);
  const { shared, body } = buildRequest(command, options);
  const canonicalBody = JSON.stringify(body);
  const dryRunHash = sha256(canonicalBody);

  const identity = await getCallerIdentity(shared.profile);
  validateIdentity(identity, command, shared.stage);

  if (!options.has('apply')) {
    write(`dry-run command=${command} stage=${shared.stage}`);
    write(`dryRunHash=${dryRunHash}`);
    return 0;
  }
  if (options.get('confirm-stage') !== shared.stage) {
    throw new Error('confirm-stage must exactly match stage');
  }
  const confirmationHash = options.get('confirm-hash');
  if (typeof confirmationHash !== 'string' || confirmationHash !== dryRunHash) {
    throw new Error('confirmation hash does not match dry-run hash');
  }

  let cutoverEvidence;
  let resolvedEvidenceRoot;
  if (command === 'freeze-cutover') {
    if (typeof writeEvidenceMirror !== 'function') {
      throw new Error('cutover evidence writer is unavailable');
    }
    resolvedEvidenceRoot = resolveEvidenceRoot(evidenceRoot, process.cwd());
    cutoverEvidence = buildCutoverEvidenceMirror({
      stage: shared.stage,
      commercialEntitlementsCutoverAt: body.commercialEntitlementsCutoverAt,
      inventoryManifestHash: body.inventoryManifestHash,
    });
  }

  const credentials = await getCredentials(shared.profile);
  const headers = signFunctionUrlRequest({
    url: shared.url,
    body: canonicalBody,
    credentials,
    now: now(),
  });
  const response = await fetchRequest(shared.url, {
    method: 'POST',
    headers,
    body: canonicalBody,
    redirect: 'error',
  });
  const rawResponse = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawResponse);
  } catch {
    throw new Error(`broker returned invalid JSON with status ${response.status}`);
  }
  if (!response.ok) {
    safeResult(response, payload, write, command, shared.stage);
  }
  if (command === 'freeze-cutover') {
    validateFreezeResponse(response, payload, body);
    await writeEvidenceMirror({
      evidenceRoot: resolvedEvidenceRoot,
      stage: shared.stage,
      mirror: cutoverEvidence,
    });
    write(`evidenceMirrorHash=${cutoverEvidence.mirrorHash}`);
  }
  safeResult(response, payload, write, command, shared.stage);
  return 0;
}

export async function main(command, argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runCommercialConfigCli({ command, argv });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'commercial config command failed';
    console.error(`error=${message}`);
    process.exitCode = 1;
  }
}
