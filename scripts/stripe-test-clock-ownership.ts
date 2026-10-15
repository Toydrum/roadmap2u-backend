import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AwsCredentialIdentity } from '@smithy/types';
import { readClockCallerAuthority, claimClockOwnershipAuthority, reserveDurableClockCallerAttempt, assertDurableClockCallerAttempt, type ClockCallerAuthority, type DurableClockCallerAttempt } from './stripe-test-clock-authority';
import { assertDurableClockJournal, type DurableClockJournal } from './stripe-test-clock-durable-store';

export type ClockOwnershipReadKind = 'identity' | 'stack' | 'app' | 'privacy' | 'pool' | 'stack_after';
interface CliOptions { env: NodeJS.ProcessEnv; timeout: number; signal: AbortSignal }
export type ClockOwnershipCli = (args: readonly string[], options: CliOptions) => Promise<Uint8Array>;
export interface ClockOwnershipOptions {
  authority: ClockCallerAuthority; credentials: AwsCredentialIdentity; cliConfigPath: string; cliCredentialsPath: string;
  caBundlePath: string; caBundleSha256: string; now: () => number; reserveWire: (kind: ClockOwnershipReadKind) => void;
  runCli?: ClockOwnershipCli; requestTimeoutMs?: number;
}
const nativeExec = promisify(execFile);
const nativeCli: ClockOwnershipCli = async (args, options) => {
  const result = await nativeExec('aws', [...args], { ...options, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return result.stdout;
};
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw Error('CLOCK_OWNERSHIP_' + reason); }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
const stable = (v: unknown) => ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(v as string);
const digest = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
function regular(file: string) {
  const s = lstatSync(file); requireCondition(s.isFile() && !s.isSymbolicLink() && s.size <= 256 * 1024, 'CLI_FILE_REJECTED');
  return readFileSync(file);
}
/** Native CLI reader only. Explicit temporary credentials remain in child memory;
 * there is no profile discovery, secret lookup, role assumption or write command. */
export function prepareClockOwnershipObserver(options: ClockOwnershipOptions) {
  try {
    const authority = options.authority, now = options.now, reserve = options.reserveWire, run = options.runCli ?? nativeCli;
    requireCondition(typeof now === 'function' && typeof reserve === 'function' && typeof run === 'function', 'DEPENDENCIES_REQUIRED');
    const preparedAt = now(), manifest = readClockCallerAuthority(authority, preparedAt), supplied = options.credentials;
    requireCondition(supplied && typeof supplied.accessKeyId === 'string' && /^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId) &&
      typeof supplied.secretAccessKey === 'string' && supplied.secretAccessKey.length > 0 && typeof supplied.sessionToken === 'string' && supplied.sessionToken.length > 0 &&
      supplied.expiration instanceof Date && supplied.expiration.getTime() > preparedAt + 120000, 'CREDENTIAL_SNAPSHOT_REQUIRED');
    const credentials = { accessKeyId: supplied.accessKeyId, secretAccessKey: supplied.secretAccessKey, sessionToken: supplied.sessionToken,
      expiration: new Date(supplied.expiration.getTime()) };
    const config = realpathSync(options.cliConfigPath), emptyCredentials = realpathSync(options.cliCredentialsPath), ca = realpathSync(options.caBundlePath), caHash = options.caBundleSha256;
    requireCondition(/^[a-f0-9]{64}$/.test(caHash), 'CA_PIN_REQUIRED');
    function files() {
      requireCondition(regular(config).length === 0 && regular(emptyCredentials).length === 0 && digest(regular(ca)) === caHash, 'CLI_FILES_CHANGED');
    }
    files(); const timeout = options.requestTimeoutMs ?? 20000;
    requireCondition(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 20000, 'TIMEOUT_REJECTED');
    let previous = preparedAt, consumed = false;
    function fresh() {
      const value = now(); readClockCallerAuthority(authority, value);
      requireCondition(Number.isSafeInteger(value) && value >= previous && credentials.expiration.getTime() > value + 30000, 'CONTEXT_EXPIRED');
      previous = value; files(); return value;
    }
    const cloud = manifest.cloudformation;
    const env = Object.freeze({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:AWS|STRIPE)_/i.test(k))),
      AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_SESSION_TOKEN: credentials.sessionToken,
      AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: emptyCredentials, AWS_CA_BUNDLE: ca, AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_EC2_METADATA_DISABLED: 'true', AWS_CLI_AUTO_PROMPT: 'off', AWS_PAGER: '', PYTHONUTF8: '1' });
    const counters = { identity: 0, stack: 0, app: 0, privacy: 0, pool: 0, stack_after: 0 };
    const delegated = { ...counters };
    async function read(kind: ClockOwnershipReadKind, operation: string[]) {
      fresh(); requireCondition(counters[kind] === 0, 'REQUEST_BOUND'); counters[kind]++;
      const host = kind === 'identity' ? 'https://sts.us-east-1.amazonaws.com' : 'https://cloudformation.us-east-1.amazonaws.com';
      const args = Object.freeze([...operation, '--region', 'us-east-1', '--endpoint-url', host, '--output', 'json', '--no-cli-pager',
        '--no-cli-auto-prompt', '--no-paginate', '--cli-connect-timeout', '5', '--cli-read-timeout', String(Math.ceil(timeout / 1000))]);
      const reservation: unknown = reserve(kind);
      if (reservation && typeof (reservation as { then?: unknown }).then === 'function') {
        void Promise.resolve(reservation).catch(() => undefined);
        throw Error('CLOCK_OWNERSHIP_ASYNC_RESERVATION_REJECTED');
      }
      fresh(); delegated[kind]++;
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('CLOCK_OWNERSHIP_REQUEST_TIMEOUT')); }, timeout); });
        const bytes = await Promise.race([run(args, { env, timeout, signal: controller.signal }), deadline]);
        requireCondition(bytes instanceof Uint8Array && bytes.byteLength <= 2 * 1024 * 1024, 'RESPONSE_BOUND');
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        requireCondition(record(value), 'RESPONSE_INVALID'); fresh(); return value;
      } finally { clearTimeout(timer); }
    }
    function stack(value: Record<string, unknown>) {
      requireCondition(!value.NextToken && Array.isArray(value.Stacks) && value.Stacks.length === 1 && record(value.Stacks[0]), 'STACK_RESPONSE_REJECTED');
      const s = value.Stacks[0];
      requireCondition(s.StackName === cloud.stackName && s.StackId === cloud.stackId && stable(s.StackStatus) &&
        typeof s.CreationTime === 'string' && Number.isFinite(Date.parse(s.CreationTime)) &&
        (s.LastUpdatedTime === undefined || typeof s.LastUpdatedTime === 'string' && Number.isFinite(Date.parse(s.LastUpdatedTime))), 'STACK_MISMATCH');
      return { StackName: s.StackName, StackId: s.StackId, StackStatus: s.StackStatus, CreationTime: s.CreationTime, LastUpdatedTime: s.LastUpdatedTime };
    }
    return {
      preview: Object.freeze({ stage: manifest.clock.scope.stage, ownerSub: manifest.clock.ownerSub, operationId: manifest.operationId,
        sourceSha: manifest.sourceSha, stackId: cloud.stackId, maximumReadRequests: 6, sourceShaVerified: true,
        authorizationReceiptBound: true, stackOwnershipVerified: false, physicalExecutionAllowed: false }),
      counts: () => ({ reservations: { ...counters }, delegations: { ...delegated } }),
      async observe() {
        requireCondition(!consumed, 'ALREADY_CONSUMED'); consumed = true;
        try {
          fresh(); claimClockOwnershipAuthority(authority, previous); const startedAt = previous;
          const identity = await read('identity', ['sts', 'get-caller-identity']);
          requireCondition(identity.Account === manifest.storage.awsAccountId && identity.Arn === manifest.expectedCallerArn && typeof identity.UserId === 'string' && identity.UserId.length > 0, 'IDENTITY_MISMATCH');
          const before = stack(await read('stack', ['cloudformation', 'describe-stacks', '--stack-name', cloud.stackId]));
          const resources = [];
          for (const r of cloud.resources) {
            const response = await read(r.kind, ['cloudformation', 'describe-stack-resource', '--stack-name', cloud.stackId, '--logical-resource-id', r.logicalId]);
            const detail = response.StackResourceDetail;
            requireCondition(record(detail) && detail.StackId === cloud.stackId && detail.StackName === cloud.stackName && detail.LogicalResourceId === r.logicalId &&
              detail.PhysicalResourceId === r.physicalId && detail.ResourceType === r.resourceType && stable(detail.ResourceStatus), 'RESOURCE_MISMATCH');
            resources.push({ ...r, status: detail.ResourceStatus });
          }
          const after = stack(await read('stack_after', ['cloudformation', 'describe-stacks', '--stack-name', cloud.stackId]));
          requireCondition(JSON.stringify(before) === JSON.stringify(after), 'STACK_CHANGED');
          const completedAt = fresh();
          return { status: 'ownership_verified' as const, stage: manifest.clock.scope.stage, ownerSub: manifest.clock.ownerSub, operationId: manifest.operationId,
            sourceSha: manifest.sourceSha, manifestSha256: authority.manifestSha256, requestSha256: authority.requestSha256,
            transactionSha256: authority.transactionSha256, readbackSha256: authority.readbackSha256, stackId: cloud.stackId, resources, startedAt, completedAt,
            sourceShaVerified: true, authorizationReceiptBound: true, stackOwnershipVerified: true, physicalExecutionAllowed: false,
            counts: { reservations: { ...counters }, delegations: { ...delegated } } };
        } catch { throw Error('CLOCK_OWNERSHIP_OBSERVATION_FAILED'); }
      },
    };
  } catch (error) {
    const code = error instanceof Error && /^CLOCK_(?:OWNERSHIP|AUTHORITY)_[A-Z_]+$/.test(error.message) ? error.message : 'CLOCK_OWNERSHIP_PREPARATION_FAILED';
    throw Error(code);
  }
}
/** Composition boundary for a future physical caller. No credential discovery,
 * automatic continuation or writes are introduced by this wrapper. */
export function prepareDurableClockOwnershipObserver(options: ClockOwnershipOptions & { journalDirectory: DurableClockJournal }) {
  const journal = options.journalDirectory, authority = options.authority, now = options.now, reserve = options.reserveWire;
  assertDurableClockJournal(journal);
  let attempt: DurableClockCallerAttempt | undefined;
  const reader = prepareClockOwnershipObserver({ ...options, reserveWire: kind => {
    requireCondition(attempt, 'DURABLE_ATTEMPT_REQUIRED');
    assertDurableClockCallerAttempt(attempt, authority, journal, now());
    return reserve(kind);
  } });
  let consumed = false;
  return { preview: reader.preview, counts: reader.counts, async observe() {
    requireCondition(!consumed, 'ALREADY_CONSUMED'); consumed = true;
    attempt = reserveDurableClockCallerAttempt(authority, journal, now());
    assertDurableClockCallerAttempt(attempt, authority, journal, now());
    const result = await reader.observe();
    assertDurableClockCallerAttempt(attempt, authority, journal, now());
    return result;
  } };
}
