import { createHash } from 'node:crypto';
import { createAwsCredentialLoader, createAwsJsonRunner,
  signFunctionUrlRequest } from './lib/commercial-config-cli.mjs';

const ACCOUNT_ID = '765932874577';
const STAGES = new Set(['dev', 'test', 'prod']);
const FUNCTION_URL_HOST = /^[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const OPTIONS = new Set(['stage', 'url', 'adult-id', 'household-id',
  'expected-household-revision', 'expected-entitlement-revision', 'command-id',
  'reason', 'profile', 'apply', 'confirm-stage', 'confirm-hash']);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--') || !OPTIONS.has(token.slice(2)) || options.has(token.slice(2))) {
      throw new Error(`Invalid or duplicate option ${token}`);
    }
    const name = token.slice(2);
    if (name === 'apply') { options.set(name, true); continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options.set(name, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
}

function revision(options, name, minimum) {
  const raw = required(options, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) {
    throw new Error(`Invalid --${name}`);
  }
  return Number(raw);
}

export function buildFamilyPilotRequest(command, argv) {
  if (command !== 'grant' && command !== 'revoke') throw new Error('Command must be grant or revoke');
  const options = parseOptions(argv);
  const stage = required(options, 'stage');
  if (!STAGES.has(stage)) throw new Error('Stage must be dev, test, or prod');
  const parsedUrl = new URL(required(options, 'url'));
  if (parsedUrl.protocol !== 'https:' || !FUNCTION_URL_HOST.test(parsedUrl.hostname) ||
    parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash || parsedUrl.username ||
    parsedUrl.password || parsedUrl.port) throw new Error('URL must be a us-east-1 Lambda Function URL');
  const adultId = required(options, 'adult-id');
  const householdId = required(options, 'household-id');
  if (!IDENTIFIER.test(adultId) || !IDENTIFIER.test(householdId)) {
    throw new Error('Adult and household IDs must be exact opaque identifiers');
  }
  const reason = required(options, 'reason');
  if (reason !== reason.trim() || Buffer.byteLength(reason, 'utf8') < 4 ||
    Buffer.byteLength(reason, 'utf8') > 256) throw new Error('Reason must be 4–256 trimmed bytes');
  const commandId = required(options, 'command-id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(commandId)) {
    throw new Error('Command ID must be a UUID v4');
  }
  const body = {
    command, stage, adultId, householdId,
    expectedHouseholdRevision: revision(options, 'expected-household-revision', 1),
    expectedEntitlementRevision: revision(options, 'expected-entitlement-revision', 0),
    commandId, reason,
  };
  const profile = options.get('profile');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(profile)) {
    throw new Error('Invalid AWS profile');
  }
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { options, body, hash, url: parsedUrl.href, profile };
}

export async function runFamilyPilotCli(command, argv, {
  write = console.log,
  runAwsJson = createAwsJsonRunner(),
  getCredentials = createAwsCredentialLoader(),
  fetchRequest = fetch,
} = {}) {
  const request = buildFamilyPilotRequest(command, argv);
  const identity = runAwsJson(request.profile,
    ['sts', 'get-caller-identity', '--region', 'us-east-1', '--output', 'json']);
  const expectedArn = new RegExp(`^arn:aws:sts::${ACCOUNT_ID}:assumed-role/roadmap2u-${request.body.stage}-family-pilot-operator/[A-Za-z0-9_+=,.@-]{2,64}$`);
  if (identity.Account !== ACCOUNT_ID || !expectedArn.test(identity.Arn ?? '')) {
    throw new Error('Assume the exact MFA family pilot operator role for this stage');
  }
  write(`commandId=${request.body.commandId}`);
  write(`stage=${request.body.stage} command=${command} adultId=${request.body.adultId} householdId=${request.body.householdId}`);
  write(`dryRunHash=${request.hash}`);
  if (!request.options.has('apply')) return { applied: false, hash: request.hash };
  if (request.options.get('confirm-stage') !== request.body.stage ||
    request.options.get('confirm-hash') !== request.hash) {
    throw new Error('Confirmation stage and hash must match the dry run');
  }
  const credentials = await getCredentials(request.profile);
  const payload = JSON.stringify(request.body);
  const headers = signFunctionUrlRequest({ url: request.url, body: payload,
    credentials, now: new Date() });
  const response = await fetchRequest(request.url, { method: 'POST', headers, body: payload });
  let result;
  try { result = await response.json(); } catch { throw new Error('Broker returned invalid JSON'); }
  if (!response.ok) throw new Error(`Broker rejected ${command}: ${response.status} ${result?.error ?? ''}`);
  write(`applied=${command} participantCount=${result.participantCount} idempotent=${result.idempotent}`);
  return { applied: true, result };
}

if (process.argv[1]?.endsWith('family-pilot.mjs')) {
  runFamilyPilotCli(process.argv[2], process.argv.slice(3)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
