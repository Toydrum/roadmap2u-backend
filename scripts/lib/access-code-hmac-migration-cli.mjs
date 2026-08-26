import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COMMANDS = new Set(['plan', 'apply']);
const MODES = new Set(['migrate', 'initialize']);
const STAGES = new Set(['dev', 'test', 'prod']);
const FORBIDDEN_ENVIRONMENT = new Set(['ACCESS_CODE_HMAC_VALUE']);
const FORBIDDEN_OPTIONS = new Set(['value', 'secret', 'secret-file']);
const ALLOWED_OPTIONS = new Set(['stage', 'mode', 'confirm-stage', 'confirm-hash']);
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const KEY_MATERIAL = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const AWS_ACCOUNT_ID = '765932874577';
const STANDARD_PARAMETER_MAX_BYTES = 4096;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertNoPlaintextInputs(argv, env) {
  for (const name of FORBIDDEN_ENVIRONMENT) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(`Plaintext input channels are forbidden (${name})`);
    }
  }
  for (const token of argv) {
    if (typeof token !== 'string') continue;
    const name = token.startsWith('--') ? token.slice(2).split('=', 1)[0] : '';
    if (FORBIDDEN_OPTIONS.has(name)) {
      throw new Error(`Plaintext input channels are forbidden (--${name})`);
    }
  }
}

function parseArguments(argv, env) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array');
  assertNoPlaintextInputs(argv, env);
  const command = argv[0];
  if (typeof command !== 'string' || !COMMANDS.has(command)) {
    throw new Error('First argument must be plan or apply');
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error('Options must use --name value syntax');
    }
    const name = token.slice(2);
    if (!ALLOWED_OPTIONS.has(name)) throw new Error(`Unknown option --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option --${name}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, value);
    index += 1;
  }

  const stage = values.get('stage');
  if (typeof stage !== 'string' || stage.length === 0) {
    throw new Error('Missing required --stage');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  const mode = values.get('mode');
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new Error('mode must be migrate or initialize');
  }
  if (mode === 'initialize' && stage === 'dev') {
    throw new Error('initialize mode is restricted to test and prod');
  }
  if (command === 'plan' && (values.has('confirm-stage') || values.has('confirm-hash'))) {
    throw new Error('confirmation options are only valid for apply');
  }
  if (command === 'apply') {
    const confirmedStage = values.get('confirm-stage');
    if (confirmedStage !== stage) {
      throw new Error('--confirm-stage must exactly match --stage');
    }
    const confirmationHash = values.get('confirm-hash');
    if (typeof confirmationHash !== 'string' || !SHA256.test(confirmationHash)) {
      throw new Error('confirmation hash must be a lowercase SHA-256 value');
    }
  }
  return {
    command,
    stage,
    mode,
    confirmationHash: values.get('confirm-hash'),
  };
}

function parseKeyring(raw, label) {
  if (Buffer.byteLength(raw, 'utf8') > STANDARD_PARAMETER_MAX_BYTES) {
    throw new Error(
      `access-code HMAC keyring exceeds the SSM Standard parameter 4 KiB limit (${label})`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid access-code HMAC keyring (${label})`);
  }
  if (!isRecord(value) || typeof value.activeVersion !== 'string') {
    throw new Error(`invalid access-code HMAC keyring (${label})`);
  }
  const entries = Object.entries(value).filter(([name]) => name !== 'activeVersion');
  if (
    !KEY_VERSION.test(value.activeVersion) ||
    entries.length === 0 ||
    !entries.every(
      ([version, key]) =>
        KEY_VERSION.test(version) && typeof key === 'string' && KEY_MATERIAL.test(key),
    ) ||
    typeof value[value.activeVersion] !== 'string'
  ) {
    throw new Error(`invalid access-code HMAC keyring (${label})`);
  }
  return {
    activeVersion: value.activeVersion,
    keyVersions: entries.map(([version]) => version).sort(),
  };
}

async function readTarget(getParameter, parameterName) {
  let result;
  try {
    result = await getParameter({ Name: parameterName, WithDecryption: true });
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return undefined;
    throw error;
  }
  if (result === undefined) return undefined;
  if (result?.Parameter?.Type !== 'SecureString') {
    throw new Error('target parameter must be a SecureString');
  }
  const raw = result?.Parameter?.Value;
  if (typeof raw !== 'string') {
    throw new Error('invalid access-code HMAC keyring (target)');
  }
  parseKeyring(raw, 'target');
  return { raw, fingerprint: sha256(raw) };
}

function confirmationHash(context) {
  return sha256(
    canonicalJson({
      schema: 'roadmap2u-access-code-hmac-migration/v1',
      mode: context.mode,
      stage: context.stage,
      sourceFingerprint: context.source?.fingerprint ?? 'generated-at-apply',
      parameterName: context.parameterName,
      targetStatus: context.targetStatus,
      targetFingerprint: context.target?.fingerprint ?? null,
    }),
  );
}

function hashesMatch(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function buildContext(parsed, dependencies) {
  const parameterName = `/roadmap2u/${parsed.stage}/access-code-hmac/v1`;
  const secretId = `roadmap2u/${parsed.stage}/access-code-hmac/v1`;
  let source;
  if (parsed.mode === 'migrate') {
    const result = await dependencies.getSecretValue({ SecretId: secretId });
    const raw = result?.SecretString;
    if (typeof raw !== 'string') {
      throw new Error('invalid access-code HMAC keyring (source)');
    }
    const keyring = parseKeyring(raw, 'source');
    source = {
      raw,
      secretId,
      fingerprint: sha256(raw),
      ...keyring,
    };
  } else {
    let sourceExists = true;
    try {
      await dependencies.describeSecret({ SecretId: secretId });
    } catch (error) {
      if (error?.name === 'ResourceNotFoundException') sourceExists = false;
      else throw error;
    }
    if (sourceExists) {
      throw new Error('source secret already exists; use migrate to preserve its keyring');
    }
  }
  const target = await readTarget(dependencies.getParameter, parameterName);
  const targetStatus =
    target === undefined
      ? 'absent'
      : source && target.fingerprint === source.fingerprint
        ? 'already-migrated'
        : 'different';
  return {
    mode: parsed.mode,
    stage: parsed.stage,
    parameterName,
    source,
    target,
    targetStatus,
  };
}

function publicPlan(context) {
  const result = {
    command: 'plan',
    mode: context.mode,
    stage: context.stage,
    source:
      context.mode === 'migrate'
        ? {
            provider: 'secretsmanager',
            secretId: context.source.secretId,
            activeVersion: context.source.activeVersion,
            keyVersions: context.source.keyVersions,
            fingerprint: context.source.fingerprint,
          }
        : { provider: 'generated-at-apply' },
    target: {
      provider: 'ssm',
      parameterName: context.parameterName,
      status: context.targetStatus,
      ...(context.target ? { fingerprint: context.target.fingerprint } : {}),
    },
    confirmationHash: confirmationHash(context),
  };
  return result;
}

function writePublicResult(write, result) {
  write(JSON.stringify(result));
  return result;
}

function putInput(stage, parameterName, value) {
  return {
    Name: parameterName,
    Description: `RoadMap2U ${stage} sponsored access code HMAC keys`,
    Value: value,
    Type: 'SecureString',
    Tier: 'Standard',
    KeyId: 'alias/aws/ssm',
    Overwrite: false,
    Tags: [
      { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
      { Key: 'roadmap2u-stage', Value: stage },
      { Key: 'roadmap2u-purpose', Value: 'sponsored-access-hmac' },
    ],
  };
}

export async function runAccessCodeHmacMigrationCli(options) {
  const argv = options?.argv ?? [];
  const env = options?.env ?? {};
  const write = options?.write ?? (() => undefined);
  const parsed = parseArguments(argv, env);
  for (const dependency of [
    'getCallerIdentity',
    'describeSecret',
    'getSecretValue',
    'getParameter',
    'putParameter',
  ]) {
    if (typeof options?.[dependency] !== 'function') {
      throw new Error(`Missing migration dependency ${dependency}`);
    }
  }
  const identity = await options.getCallerIdentity({});
  if (identity?.Account !== AWS_ACCOUNT_ID) {
    throw new Error(`AWS account must be ${AWS_ACCOUNT_ID}`);
  }
  const context = await buildContext(parsed, options);
  const plan = publicPlan(context);
  if (parsed.command === 'plan') return writePublicResult(write, plan);
  if (!hashesMatch(parsed.confirmationHash, plan.confirmationHash)) {
    throw new Error('confirmation hash does not match the current migration plan');
  }

  if (parsed.mode === 'migrate') {
    if (context.targetStatus === 'different') {
      throw new Error('target parameter differs from the source keyring');
    }
    if (context.targetStatus === 'already-migrated') {
      return writePublicResult(write, {
        command: 'apply',
        mode: parsed.mode,
        stage: parsed.stage,
        status: 'already-migrated',
        changed: false,
        fingerprint: context.source.fingerprint,
      });
    }
    await options.putParameter(
      putInput(parsed.stage, context.parameterName, context.source.raw),
    );
    return writePublicResult(write, {
      command: 'apply',
      mode: parsed.mode,
      stage: parsed.stage,
      status: 'created',
      changed: true,
      fingerprint: context.source.fingerprint,
    });
  }

  if (context.targetStatus !== 'absent') {
    throw new Error('target parameter already exists; initialize refuses to replace it');
  }
  if (typeof options.generateSecretMaterial !== 'function') {
    throw new Error('Missing migration dependency generateSecretMaterial');
  }
  const material = options.generateSecretMaterial();
  if (typeof material !== 'string' || !KEY_MATERIAL.test(material)) {
    throw new Error('generated access-code HMAC material is invalid');
  }
  const value = JSON.stringify({ activeVersion: 'v1', v1: material });
  parseKeyring(value, 'generated');
  await options.putParameter(putInput(parsed.stage, context.parameterName, value));
  return writePublicResult(write, {
    command: 'apply',
    mode: parsed.mode,
    stage: parsed.stage,
    status: 'created',
    changed: true,
    fingerprint: sha256(value),
  });
}

export function generateAccessCodeHmacMaterial() {
  return randomBytes(48).toString('base64url');
}
