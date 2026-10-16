import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { selectClockPublisherFixture, type ClockPublisherContext } from './stripe-test-clock-evidence';
import type { ClockStorageScope } from './stripe-test-clock-install';
import { prepareClockJournal, type ClockJournalRequest, type PreparedClockJournal } from './stripe-test-clock-journal';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { assertDurableClockJournal, writeDurableClockJournalFile, readDurableClockJournalFile, type DurableClockJournal } from './stripe-test-clock-durable-store';

export interface ClockOwnershipResource {
  kind: 'app' | 'privacy' | 'pool'; logicalId: string; physicalId: string; resourceType: string;
}
export interface ClockCallerManifest {
  schemaVersion: 1; sourceSha: string; operationId: string; phase: 'install' | 'advance_fence' | 'ready' | 'refresh';
  requestSha256: string; targetFrozenTimeSeconds: number | null;
  clock: Pick<ClockPublisherContext, 'ownerSub' | 'scope'>; storage: ClockStorageScope; expectedCallerArn: string;
  cloudformation: { stackName: string; stackId: string; resources: ClockOwnershipResource[] };
  journal?: { directory: string; directoryId: string; aclSha256: string };
  runtime?: { powershellExecutable: string; powershellSha256: string; caBundleSha256: string };
}
export interface ClockCallerAuthority {
  readonly stage: string; readonly sourceSha: string; readonly manifestSha256: string; readonly operationId: string;
  readonly requestSha256: string; readonly phase: ClockCallerManifest['phase'];
  readonly transactionSha256: string; readonly readbackSha256: string;
  readonly sourceShaVerified: true; readonly authorizationReceiptBound: true; readonly stackOwnershipVerified: false;
  readonly physicalExecutionAllowed: false; readonly verifiedAt: number; readonly expiresAt: number;
}
interface BoundAuthority { manifest: ClockCallerManifest; plan: PreparedClockJournal; verifiedAt: number; expiresAt: number; consumptionKey: string;
  attemptReservationId: string; callIdSha256: string; issuedAt: number; approvedRootCommit: string; request: ClockJournalRequest;
  source: { sourceRoot: string; selfFile: string; selfPath: string; reviewRoot: string; manifestPath: string } }
export interface DurableClockCallerAttempt {
  readonly sourceSha: string; readonly manifestSha256: string; readonly operationId: string;
  readonly reservedAt: number; readonly physicalExecutionAllowed: false;
}
const authorities = new WeakMap<object, BoundAuthority>();
const attempts = new WeakMap<object, { authority: ClockCallerAuthority; journal: DurableClockJournal; receipt: Record<string, unknown> }>();
const ownershipUses = new Set<string>();
const MAX_BYTES = 256 * 1024;
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw Error('CLOCK_AUTHORITY_' + reason); }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function keys(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  requireCondition(record(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k)), 'SHAPE_REJECTED');
}
function stamp(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
const digest = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function parse(raw: unknown) {
  requireCondition(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= MAX_BYTES, 'INPUT_REJECTED');
  try { return JSON.parse(raw) as unknown; } catch { throw Error('CLOCK_AUTHORITY_JSON_REJECTED'); }
}
function inside(root: string, target: string) {
  const rel = relative(root, target);
  requireCondition(rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'PATH_REJECTED');
  return rel.replaceAll('\\', '/');
}
/** Read the actual descriptor with a finite bound; paths and arbitrary parser errors stay private. */
function regularBytes(file: string, maximum = MAX_BYTES) {
  requireCondition(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'REGULAR_FILE_REQUIRED');
  const fd = openSync(file, 'r');
  try {
    const before = fstatSync(fd); requireCondition(before.isFile() && before.size <= maximum, 'FILE_BOUND');
    const buffer = Buffer.alloc(maximum + 1); let count = 0;
    while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; }
    const after = fstatSync(fd);
    requireCondition(count <= maximum && before.size === after.size && before.mtimeMs === after.mtimeMs, 'FILE_CHANGED');
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}
function git(root: string, args: string[], bytes = false): string | Buffer {
  const out = execFileSync('git', ['--no-pager', '--no-optional-locks', '-c', 'safe.directory=' + root.replaceAll('\\', '/'), '-C', root, ...args],
    { timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return bytes ? out : out.toString('utf8').trim();
}
function validateManifest(raw: unknown, now: number): ClockCallerManifest {
  const m = parse(raw);
  const nativeJournal = record(m) && Object.hasOwn(m, 'journal');
  const runtime = record(m) && Object.hasOwn(m, 'runtime');
  keys(m, ['schemaVersion', 'sourceSha', 'operationId', 'phase', 'clock', 'storage', 'expectedCallerArn', 'cloudformation', 'requestSha256', 'targetFrozenTimeSeconds', ...(nativeJournal ? ['journal'] : []), ...(runtime ? ['runtime'] : [])]);
  if (runtime) {
    keys(m.runtime, ['powershellExecutable', 'powershellSha256', 'caBundleSha256']);
    requireCondition(typeof m.runtime.powershellExecutable === 'string' && /^[A-Za-z]:[\\/]/.test(m.runtime.powershellExecutable) &&
      m.runtime.powershellExecutable.length <= 240 && !/[<>:"|?*\x00-\x1f]/.test(m.runtime.powershellExecutable.slice(2)) &&
      typeof m.runtime.powershellSha256 === 'string' && /^[a-f0-9]{64}$/.test(m.runtime.powershellSha256) &&
      typeof m.runtime.caBundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(m.runtime.caBundleSha256), 'RUNTIME_BINDING_REJECTED');
  }
  if (nativeJournal) {
    keys(m.journal, ['directory', 'directoryId', 'aclSha256']);
    requireCondition(typeof m.journal.directory === 'string' && /^[A-Za-z]:[\\/]/.test(m.journal.directory) &&
      m.journal.directory.length <= 240 && !/[<>:"|?*\x00-\x1f]/.test(m.journal.directory.slice(2)) &&
      typeof m.journal.directoryId === 'string' && /^[a-f0-9]{64}$/.test(m.journal.directoryId) &&
      typeof m.journal.aclSha256 === 'string' && /^[a-f0-9]{64}$/.test(m.journal.aclSha256), 'JOURNAL_BINDING_REJECTED');
  }
  requireCondition(m.schemaVersion === 1 && typeof m.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(m.sourceSha), 'SOURCE_REQUIRED');
  requireCondition(typeof m.operationId === 'string' && /^[A-Za-z0-9:_-]{8,128}$/.test(m.operationId) &&
    ['install', 'advance_fence', 'ready', 'refresh'].includes(m.phase as string), 'OPERATION_REJECTED');
  requireCondition(typeof m.requestSha256 === 'string' && /^[a-f0-9]{64}$/.test(m.requestSha256), 'REQUEST_DIGEST_REQUIRED');
  requireCondition(m.phase === 'advance_fence' ? stamp(m.targetFrozenTimeSeconds) : m.targetFrozenTimeSeconds === null, 'ADVANCE_TARGET_REJECTED');
  keys(m.clock, ['ownerSub', 'scope']);
  keys(m.clock.scope, ['tableName', 'stage', 'stripeAccountId', 'liveMode', 'fixtures']);
  requireCondition(Array.isArray(m.clock.scope.fixtures), 'FIXTURES_REQUIRED');
  for (const fixture of m.clock.scope.fixtures) keys(fixture, ['ownerSub', 'customerId', 'testClockId', 'bindingId', 'stage', 'stripeAccountId', 'syntheticFixture']);
  // Reuse the production clock reader's isolation and historical-owner fences.
  try { selectClockPublisherFixture({ ...(m.clock as unknown as ClockCallerManifest['clock']), realNow: now }); }
  catch { throw Error('CLOCK_AUTHORITY_FIXTURE_SCOPE_REJECTED'); }
  keys(m.storage, ['stage', 'awsAccountId', 'region', 'appTableArn', 'privacyTableName', 'privacyTableArn']);
  const stage = m.clock.scope.stage;
  requireCondition(m.storage.stage === stage && m.storage.awsAccountId === '765932874577' && m.storage.region === 'us-east-1' &&
    m.clock.scope.tableName === `roadmap-${stage}` && m.storage.privacyTableName === `roadmap-privacy-${stage}` &&
    m.storage.appTableArn === `arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-${stage}` &&
    m.storage.privacyTableArn === `arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-privacy-${stage}`, 'STORAGE_REJECTED');
  requireCondition(typeof m.expectedCallerArn === 'string' && /^arn:aws:(?:sts::765932874577:assumed-role|iam::765932874577:user)\/[A-Za-z0-9_+=,.@/-]+$/.test(m.expectedCallerArn), 'CALLER_REQUIRED');
  keys(m.cloudformation, ['stackName', 'stackId', 'resources']);
  const c = m.cloudformation;
  requireCondition(c.stackName === `Roadmap-${stage}-Backend` && typeof c.stackId === 'string' &&
    new RegExp(`^arn:aws:cloudformation:us-east-1:765932874577:stack/Roadmap-${stage}-Backend/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(c.stackId), 'STACK_REJECTED');
  requireCondition(Array.isArray(c.resources) && c.resources.length === 3, 'RESOURCES_REQUIRED');
  for (const r of c.resources) {
    keys(r, ['kind', 'logicalId', 'physicalId', 'resourceType']);
    requireCondition(['app', 'privacy', 'pool'].includes(r.kind as string) && typeof r.logicalId === 'string' && /^[A-Za-z][A-Za-z0-9]{0,254}$/.test(r.logicalId), 'RESOURCE_REJECTED');
    requireCondition(r.kind === 'pool' ? r.resourceType === 'AWS::Cognito::UserPool' && typeof r.physicalId === 'string' && /^us-east-1_[A-Za-z0-9]+$/.test(r.physicalId)
      : r.resourceType === 'AWS::DynamoDB::Table' && r.physicalId === (r.kind === 'app' ? m.clock.scope.tableName : m.storage.privacyTableName), 'RESOURCE_BINDING_REJECTED');
  }
  requireCondition(new Set(c.resources.map(r => r.kind)).size === 3 && new Set(c.resources.map(r => r.logicalId)).size === 3, 'DUPLICATE_RESOURCE');
  return structuredClone(m) as unknown as ClockCallerManifest;
}
async function boundRequest(m:ClockCallerManifest,requestRaw:string,now:number) {
  const request=parse(requestRaw);
  requireCondition(digest(requestRaw)===m.requestSha256&&record(request)&&record(request.clock)&&
    request.operationId===m.operationId&&request.clock.ownerSub===m.clock.ownerSub&&isDeepStrictEqual(request.clock.scope,m.clock.scope)&&
    isDeepStrictEqual(request.storage,m.storage)&&stamp(request.clock.realNow)&&request.clock.realNow<=now&&now-request.clock.realNow<TEST_CLOCK_EVIDENCE_MAX_AGE_MS&&
    (m.phase==='install'?!Object.hasOwn(request,'kind'):request.kind===m.phase)&&
    (m.phase==='advance_fence'?request.targetFrozenTimeSeconds===m.targetFrozenTimeSeconds:!Object.hasOwn(request,'targetFrozenTimeSeconds')),'REQUEST_BINDING_REJECTED');
  let plan:PreparedClockJournal;
  try{plan=await prepareClockJournal(request as unknown as ClockJournalRequest,m.sourceSha);}
  catch{throw Error('CLOCK_AUTHORITY_REQUEST_PLAN_REJECTED');}
  requireCondition(plan.intent.operationId===m.operationId&&plan.intent.phase===m.phase&&plan.intent.sourceSha===m.sourceSha,'REQUEST_PLAN_REJECTED');
  return {request:request as unknown as ClockJournalRequest,plan};
}
/** Pure review data. It neither reads credentials/files nor mints authority;
 * execute still requires a fresh direct-human receipt and actual source binding. */
export async function previewClockCallerPlan(options:{manifestRaw:string;requestRaw:string;now:()=>number}) {
  try{
    const now=options.now();requireCondition(stamp(now),'TIME_REJECTED');
    const m=validateManifest(options.manifestRaw,now),{plan}=await boundRequest(m,options.requestRaw,now);
    return Object.freeze({status:'preview' as const,stage:m.clock.scope.stage,sourceSha:m.sourceSha,operationId:m.operationId,phase:m.phase,
      manifestSha256:digest(options.manifestRaw),requestSha256:m.requestSha256,
      transactionSha256:plan.intent.transactionSha256,readbackSha256:plan.intent.readbackSha256,
      maximumRequests:m.phase==='install'?17:m.phase==='advance_fence'?20:16,maximumWrites:1,maximumProviderAdvances:m.phase==='advance_fence'?1:0,
      sourceShaVerified:false,authorizationReceiptBound:false,physicalExecutionAllowed:false});
  }catch(error){throw Error(error instanceof Error&&/^CLOCK_AUTHORITY_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_AUTHORITY_PREVIEW_FAILED');}
}
/** Checks a local direct-human receipt, not the identity of the person who produced it.
 * Durable ownership use also requires reserveDurableClockCallerAttempt. */
export async function verifyClockCallerAuthority(options: {
  manifestRaw: string; requestRaw: string; authorizationRaw: string; sourceRoot: string; reviewRoot: string; manifestPath: string; now: () => number;
}): Promise<ClockCallerAuthority> {
  try {
    const clockNow = options.now, manifestRaw = options.manifestRaw, requestRaw = options.requestRaw, authorizationRaw = options.authorizationRaw;
    const sourceArgument = options.sourceRoot, reviewArgument = options.reviewRoot, manifestPath = options.manifestPath;
    const now = clockNow(); requireCondition(stamp(now), 'TIME_REJECTED');
    const m = validateManifest(manifestRaw, now), receipt = parse(authorizationRaw);
    keys(receipt, ['source', 'callId', 'consumed', 'answer', 'manifestSha256', 'approvedRootCommit', 'issuedAt', 'expiresAt']);
    const hash = digest(manifestRaw);
    requireCondition(receipt.source === 'direct_human_async_reply' && typeof receipt.callId === 'string' && /^call_[A-Za-z0-9_]+$/.test(receipt.callId) && receipt.consumed === false &&
      receipt.answer === `Autorizar reloj ${m.clock.scope.stage.toUpperCase()} ${m.phase} ${m.operationId}` && receipt.manifestSha256 === hash &&
      typeof receipt.approvedRootCommit === 'string' && /^[a-f0-9]{40}$/.test(receipt.approvedRootCommit), 'RECEIPT_REJECTED');
    requireCondition(stamp(receipt.issuedAt) && stamp(receipt.expiresAt) && receipt.issuedAt <= now && receipt.expiresAt > now &&
      receipt.expiresAt - receipt.issuedAt <= TEST_CLOCK_EVIDENCE_MAX_AGE_MS, 'WINDOW_REJECTED');
    const {request,plan}=await boundRequest(m,requestRaw,now);
    const sourceRoot = realpathSync(resolve(sourceArgument)), reviewRoot = realpathSync(resolve(reviewArgument));
    const selfFile = fileURLToPath(import.meta.url), selfPath = inside(sourceRoot, realpathSync(selfFile));
    const self = regularBytes(selfFile, 2 * 1024 * 1024);
    requireCondition(git(sourceRoot, ['rev-parse', 'HEAD']) === m.sourceSha && git(sourceRoot, ['remote', 'get-url', 'origin']) === 'https://github.com/Toydrum/roadmap2u-backend.git', 'SOURCE_REJECTED');
    requireCondition(git(sourceRoot, ['status', '--porcelain', '--untracked-files=normal']) === '', 'SOURCE_DIRTY');
    git(sourceRoot, ['ls-files', '--error-unmatch', '--', selfPath]);
    const sourceBlob = git(sourceRoot, ['show', 'HEAD:' + selfPath], true) as Buffer;
    requireCondition(sourceBlob.equals(Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(self).replaceAll('\r\n', '\n'))), 'EXECUTING_SOURCE_REJECTED');
    requireCondition(typeof manifestPath === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(manifestPath) &&
      !manifestPath.split('/').some(p => p === '.' || p === '..' || p === '.git'), 'REVIEW_PATH_REJECTED');
    const file = resolve(reviewRoot, manifestPath); inside(reviewRoot, realpathSync(file));
    requireCondition(digest(regularBytes(file)) === hash, 'REVIEW_FILE_CHANGED');
    git(reviewRoot, ['merge-base', '--is-ancestor', receipt.approvedRootCommit, 'HEAD']);
    const reviewed = git(reviewRoot, ['show', receipt.approvedRootCommit + ':' + manifestPath], true) as Buffer;
    requireCondition(digest(reviewed) === hash, 'REVIEW_BLOB_REJECTED');
    const finished = clockNow(); requireCondition(stamp(finished) && finished >= now && finished < receipt.expiresAt, 'WINDOW_REJECTED');
    const authority: ClockCallerAuthority = Object.freeze({ stage: m.clock.scope.stage, sourceSha: m.sourceSha, manifestSha256: hash, operationId: m.operationId,
      requestSha256: m.requestSha256, phase: m.phase, transactionSha256: plan.intent.transactionSha256, readbackSha256: plan.intent.readbackSha256,
      sourceShaVerified: true, authorizationReceiptBound: true, stackOwnershipVerified: false, physicalExecutionAllowed: false,
      verifiedAt: finished, expiresAt: receipt.expiresAt });
    authorities.set(authority, { manifest: m, plan: structuredClone(plan), verifiedAt: finished, expiresAt: receipt.expiresAt,
      consumptionKey: digest(JSON.stringify([receipt.callId, receipt.approvedRootCommit, hash])),
      attemptReservationId: digest(JSON.stringify(['clock-caller-attempt-v1', receipt.callId])), callIdSha256: digest(receipt.callId),
      issuedAt: receipt.issuedAt, approvedRootCommit: receipt.approvedRootCommit, request: structuredClone(request) as unknown as ClockJournalRequest,
      source: { sourceRoot, selfFile, selfPath, reviewRoot, manifestPath } });
    return authority;
  } catch (error) {
    const code = error instanceof Error && /^CLOCK_AUTHORITY_[A-Z_]+$/.test(error.message) ? error.message : 'CLOCK_AUTHORITY_VERIFICATION_FAILED';
    throw Error(code);
  }
}
/** An object copy or caller-supplied flags cannot manufacture this in-process binding. */
export function readClockCallerAuthority(value: ClockCallerAuthority, now: number): ClockCallerManifest {
  const bound = value && authorities.get(value);
  requireCondition(bound && stamp(now) && now >= bound.verifiedAt && now < bound.expiresAt, 'BOUND_CONTEXT_REQUIRED');
  return structuredClone(bound.manifest);
}
/** Returns only the exact real plan prepared from the approved request bytes. */
export function readClockCallerPlan(value: ClockCallerAuthority, now: number): PreparedClockJournal {
  readClockCallerAuthority(value, now);
  return structuredClone(authorities.get(value)!.plan);
}
/** The private request already verified from exact approved bytes; no replacement input. */
export function readClockCallerRequest(value: ClockCallerAuthority, now: number): ClockJournalRequest {
  readClockCallerAuthority(value, now); return structuredClone(authorities.get(value)!.request);
}
/** Revalidate actual source/review state immediately before external delegation.
 * A native sidecar must also be a regular tracked file with the committed bytes. */
export function assertClockCallerSource(value: ClockCallerAuthority, now: number, sidecar?: { file: string; sha256: string }): void {
  try {
    readClockCallerAuthority(value, now);
    const bound = authorities.get(value)!, s = bound.source;
    requireCondition(git(s.sourceRoot, ['rev-parse','HEAD']) === value.sourceSha &&
      git(s.sourceRoot, ['remote','get-url','origin']) === 'https://github.com/Toydrum/roadmap2u-backend.git' &&
      git(s.sourceRoot, ['status','--porcelain','--untracked-files=normal']) === '', 'SOURCE_CHANGED');
    const committed = (file: string, path: string) => {
      git(s.sourceRoot, ['ls-files','--error-unmatch','--',path]);
      const raw = regularBytes(file, 2 * 1024 * 1024), actual = new TextDecoder('utf-8',{fatal:true}).decode(raw).replaceAll('\r\n','\n');
      const blob = git(s.sourceRoot,['show','HEAD:'+path],true) as Buffer;
      requireCondition(blob.equals(raw) || blob.equals(Buffer.from(actual)), 'SOURCE_CHANGED');
    };
    committed(s.selfFile, s.selfPath);
    if (sidecar) {
      requireCondition(/^[a-f0-9]{64}$/.test(sidecar.sha256), 'SOURCE_CHANGED');
      const file = realpathSync(sidecar.file), path = inside(s.sourceRoot,file);
      requireCondition(digest(regularBytes(file)) === sidecar.sha256, 'SOURCE_CHANGED'); committed(file,path);
    }
    requireCondition(digest(regularBytes(resolve(s.reviewRoot,s.manifestPath))) === value.manifestSha256, 'SOURCE_CHANGED');
    git(s.reviewRoot,['merge-base','--is-ancestor',bound.approvedRootCommit,'HEAD']);
    requireCondition(digest(git(s.reviewRoot,['show',bound.approvedRootCommit+':'+s.manifestPath],true) as Buffer) === value.manifestSha256, 'SOURCE_CHANGED');
  } catch { throw Error('CLOCK_AUTHORITY_SOURCE_CHANGED'); }
}
/** The same receipt cannot start a second ownership read in this process, even
 * when another authority object was verified from its original bytes. */
export function claimClockOwnershipAuthority(value: ClockCallerAuthority, now: number): void {
  readClockCallerAuthority(value, now);
  const bound = authorities.get(value)!;
  requireCondition(!ownershipUses.has(bound.consumptionKey), 'OWNERSHIP_ALREADY_CONSUMED');
  ownershipUses.add(bound.consumptionKey);
}
/** Consumes the actual bound response in the reviewed native journal before any
 * external delegation. Incomplete or uncertain reservations are never retried. */
export function reserveDurableClockCallerAttempt(authority: ClockCallerAuthority, journal: DurableClockJournal, now: number): DurableClockCallerAttempt {
  const manifest = readClockCallerAuthority(authority, now);
  assertDurableClockJournal(journal);
  requireCondition(manifest.journal && isDeepStrictEqual(manifest.journal,
    { directory: journal.directory, directoryId: journal.directoryId, aclSha256: journal.aclSha256 }), 'JOURNAL_BINDING_REJECTED');
  const bound = authorities.get(authority)!;
  const receipt = { schemaVersion: 1, reservationId: bound.attemptReservationId, sourceSha: authority.sourceSha,
    manifestSha256: authority.manifestSha256, requestSha256: authority.requestSha256, transactionSha256: authority.transactionSha256,
    readbackSha256: authority.readbackSha256, operationId: authority.operationId, phase: authority.phase, stage: authority.stage,
    approvedRootCommit: bound.approvedRootCommit, callIdSha256: bound.callIdSha256, issuedAt: bound.issuedAt,
    expiresAt: bound.expiresAt, reservedAt: now, directoryId: journal.directoryId, aclSha256: journal.aclSha256,
    status: 'reserved', retryAllowed: false, physicalExecutionAllowed: false };
  writeDurableClockJournalFile(journal, bound.attemptReservationId + '.caller-attempt.json', receipt);
  const attempt: DurableClockCallerAttempt = Object.freeze({ sourceSha: authority.sourceSha, manifestSha256: authority.manifestSha256,
    operationId: authority.operationId, reservedAt: now, physicalExecutionAllowed: false });
  attempts.set(attempt, { authority, journal, receipt });
  return attempt;
}
/** Rechecks the real native receipt. The returned/copyable fields alone are not authority. */
export function assertDurableClockCallerAttempt(value: DurableClockCallerAttempt, authority: ClockCallerAuthority, journal: DurableClockJournal, now: number): void {
  const bound = value && attempts.get(value);
  requireCondition(bound && bound.authority === authority && bound.journal === journal && stamp(now) && now >= value.reservedAt, 'ATTEMPT_REQUIRED');
  readClockCallerAuthority(authority, now);
  const saved = readDurableClockJournalFile(journal, bound.receipt.reservationId + '.caller-attempt.json');
  requireCondition(isDeepStrictEqual(saved, bound.receipt), 'ATTEMPT_RECEIPT_CHANGED');
}
