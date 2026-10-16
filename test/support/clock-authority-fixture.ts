import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../../lambda/commercial/flags';
import { prepareClockInstallTransaction } from '../../scripts/stripe-test-clock-install';
import { prepareClockTransitionTransaction } from '../../scripts/stripe-test-clock-transition';

const backendRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const AUTH_NOW = Date.UTC(2026, 9, 14, 23, 30);
export const AUTH_SECRET = 'synthetic-native-cli-secret-never-log';
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function init(root: string) {
  mkdirSync(root, { recursive: true }); git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Synthetic Clock QA']);
  git(root, ['config', 'user.email', 'clock-qa@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
}
export async function authorityFixture(stage = 'dev', phase: 'install' | 'advance_fence' | 'ready' | 'refresh' = 'install', nativeJournal = false, fullCaller = false) {
  const sourceFile = join(backendRoot, 'scripts/stripe-test-clock-authority.ts');
  const ownershipFile = join(backendRoot, 'scripts/stripe-test-clock-ownership.ts');
  // Missing implementation yields assertion failures, not an import/bundler error.
  if (!existsSync(sourceFile) || !existsSync(ownershipFile)) return { api: {} } as any;
  const root = mkdtempSync(join(tmpdir(), 'rmap-clock-authority-')); roots.push(root);
  const sourceRoot = join(root, 'source'), reviewRoot = join(root, 'review');
  init(sourceRoot); init(reviewRoot); mkdirSync(join(sourceRoot, 'scripts'));
  const bundle = join(sourceRoot, 'scripts/clock-caller.mjs');
  const callerExport = fullCaller && existsSync(join(backendRoot, 'scripts/stripe-test-clock-caller.ts')) ? "export * from './scripts/stripe-test-clock-caller';" : '';
  const cliExport=fullCaller&&existsSync(join(backendRoot,'scripts/stripe-test-clock-cli.ts'))?"export * from './scripts/stripe-test-clock-cli';":'';
  const recoveryExport=existsSync(join(backendRoot,'scripts/stripe-test-clock-recovery-authority.ts'))?"export * from './scripts/stripe-test-clock-recovery-authority';":'';
  buildSync({ stdin: { contents: "export * from './scripts/stripe-test-clock-authority'; export * from './scripts/stripe-test-clock-ownership'; export * from './scripts/stripe-test-clock-durable-store';" + callerExport+cliExport+recoveryExport, resolveDir: backendRoot },
    outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  if (nativeJournal) {
    writeFileSync(join(sourceRoot, 'scripts/stripe-test-clock-journal-windows.ps1'), readFileSync(join(backendRoot, 'scripts/stripe-test-clock-journal-windows.ps1')));
  }
  if(nativeJournal||fullCaller){
    // Standalone Node children need the same existing dependencies as Vitest.
    // Ignore only this owned junction; no install, download or dependency change.
    writeFileSync(join(sourceRoot, '.gitignore'), 'node_modules/\n');
    symlinkSync(realpathSync(join(backendRoot, 'node_modules')), join(sourceRoot, 'node_modules'), 'junction');
  }
  git(sourceRoot, ['remote', 'add', 'origin', 'https://github.com/Toydrum/roadmap2u-backend.git']);
  git(sourceRoot, ['add', '.']); git(sourceRoot, ['commit', '-qm', 'Synthetic source binding']);
  const sourceSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  const owner = 'clock_native_owner';
  const fixture = { ownerSub: owner, customerId: 'cus_native_fixture', testClockId: 'clock_native_fixture', bindingId: 'native_fixture_binding',
    stage, stripeAccountId: 'acct_native_sandbox', syntheticFixture: `stripe_clock_${stage}_native` };
  const manifest: any = { schemaVersion: 1, sourceSha, operationId: 'native_authority_install_1', phase,
    clock: { ownerSub: owner, scope: { stage, tableName: `roadmap-${stage}`, stripeAccountId: fixture.stripeAccountId, liveMode: false, fixtures: [fixture] } },
    storage: { stage, awsAccountId: '765932874577', region: 'us-east-1', appTableArn: `arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-${stage}`,
      privacyTableName: `roadmap-privacy-${stage}`, privacyTableArn: `arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-privacy-${stage}` },
    expectedCallerArn: 'arn:aws:sts::765932874577:assumed-role/clock-existing-operator/native-test',
    cloudformation: { stackName: `Roadmap-${stage}-Backend`, stackId: `arn:aws:cloudformation:us-east-1:765932874577:stack/Roadmap-${stage}-Backend/11111111-2222-3333-4444-555555555555`,
      resources: [{ kind: 'app', logicalId: 'TableCD117FA1', physicalId: `roadmap-${stage}`, resourceType: 'AWS::DynamoDB::Table' },
        { kind: 'privacy', logicalId: 'PrivacyTableBE3EBEE6', physicalId: `roadmap-privacy-${stage}`, resourceType: 'AWS::DynamoDB::Table' },
        { kind: 'pool', logicalId: 'Users0A0EEA89', physicalId: 'us-east-1_NATIVEFIXTURE', resourceType: 'AWS::Cognito::UserPool' }] } };
  mkdirSync(join(reviewRoot, 'reports'));
  const api: any = await import(/* @vite-ignore */ pathToFileURL(bundle).href);
  const receipt: any = { source: 'direct_human_async_reply', callId: 'call_LOCAL_NATIVE_TEST_ONLY', consumed: false,
    answer: `Autorizar reloj ${stage.toUpperCase()} ${phase} native_authority_install_1`, manifestSha256: '', approvedRootCommit: '',
    issuedAt: AUTH_NOW - 1000, expiresAt: AUTH_NOW + 899000 };
  const flags = { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', revision: 61, quotaMode: 'enforce', capabilityMode: 'enforce',
    accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: false, premiumPaymentsEnabled: false, ...FAMILY_BILLING_FLAG_DEFAULTS,
    schemaVersion: 2, paymentScope: 'none', individualCheckoutEnabled: false, updatedAt: AUTH_NOW - 3000, updatedBy: 'synthetic', reason: 'closed' };
  const base: any = { operationId: manifest.operationId, storage: structuredClone(manifest.storage),
    clock: { ...structuredClone(manifest.clock), realNow: AUTH_NOW, priorMirror: null,
      observation: { stripeAccountId: fixture.stripeAccountId, stage, liveMode: false, startedAt: AUTH_NOW - 20, completedAt: AUTH_NOW - 10,
        customer: { id: fixture.customerId, object: 'customer', livemode: false, test_clock: fixture.testClockId, metadata: { owner, stage, integration: 'roadmap2u_individual_v1' } },
        clock: { id: fixture.testClockId, object: 'test_helpers.test_clock', livemode: false, status: 'ready', frozen_time: AUTH_NOW / 1000 - 86400, deletes_after: AUTH_NOW / 1000 + 86400 } } },
    snapshot: { ownerSub: owner, stage, appTableName: `roadmap-${stage}`, privacyTableName: `roadmap-privacy-${stage}`,
      startedAt: AUTH_NOW - 50, completedAt: AUTH_NOW - 10, consistentReads: true, financialPartitionComplete: true,
      identity: { ownerSub: owner, enabled: false }, profile: { pk: `USER#${owner}`, sk: 'PROFILE', userId: owner, accountType: 'adult', status: 'active', privatePayload: 'in-memory-only' },
      flags, financialRows: [], mirror: null, customerMapping: null, subscriptionSource: null, closure: null, restoreExclusion: null } };
  let request = base;
  if (phase !== 'install') {
    const prior = structuredClone(base); prior.clock.realNow -= 2000; prior.clock.observation.startedAt -= 2000; prior.clock.observation.completedAt -= 2000;
    prior.snapshot.startedAt -= 2000; prior.snapshot.completedAt -= 2000;
    const installed = await prepareClockInstallTransaction(prior);
    const { financialRows: _rows, financialPartitionComplete: _complete, ...snapshot } = base.snapshot;
    request = { ...base, kind: phase, clock: { ...base.clock, priorMirror: installed.evidence.mirror },
      snapshot: { ...snapshot, mirror: installed.evidence.mirror, financialState: installed.transaction.TransactItems!.find(x => x.Put?.Item?.sk === 'STATE')!.Put!.Item!,
        customerMapping: installed.transaction.TransactItems!.find(x => x.Put?.Item?.sk === 'OWNER')!.Put!.Item! } };
    if (phase === 'advance_fence') request.targetFrozenTimeSeconds = AUTH_NOW / 1000;
    if (phase === 'ready') {
      const fence = structuredClone(request); fence.kind = 'advance_fence'; fence.targetFrozenTimeSeconds = AUTH_NOW / 1000;
      fence.clock.realNow -= 1000; fence.clock.observation.startedAt -= 1000; fence.clock.observation.completedAt -= 1000;
      fence.snapshot.startedAt -= 1000; fence.snapshot.completedAt -= 1000;
      const advancing = await prepareClockTransitionTransaction(fence);
      request.clock.priorMirror = advancing.evidence.mirror; request.snapshot.mirror = advancing.evidence.mirror;
      request.clock.observation.clock.frozen_time = fence.targetFrozenTimeSeconds;
    }
  }
  manifest.targetFrozenTimeSeconds = phase === 'advance_fence' ? request.targetFrozenTimeSeconds : null;
  let raw = '', requestRaw = '';
  function freezeReview() {
    requestRaw = JSON.stringify(request, null, 2) + '\n'; manifest.requestSha256 = digest(requestRaw);
    raw = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(join(reviewRoot, 'reports/clock-manifest.json'), raw);
    git(reviewRoot, ['add', '.']); git(reviewRoot, ['commit', '--allow-empty', '-qm', 'Synthetic reviewed clock manifest']);
    receipt.manifestSha256 = digest(raw); receipt.approvedRootCommit = git(reviewRoot, ['rev-parse', 'HEAD']);
  }
  freezeReview();
  const options = () => ({ manifestRaw: raw, requestRaw, authorizationRaw: JSON.stringify(receipt), sourceRoot, reviewRoot,
    manifestPath: 'reports/clock-manifest.json', now: () => AUTH_NOW });
  const config = join(root, 'empty-config'), credentials = join(root, 'empty-credentials'), ca = join(root, 'qa-ca.pem');
  writeFileSync(config, ''); writeFileSync(credentials, ''); writeFileSync(ca, 'PUBLIC_TEST_CA_ONLY\n');
  return { api, root, sourceRoot, reviewRoot, sourceSha, bundle, manifest, request, receipt, options, freezeReview, git,
    privateFiles: { cliConfigPath: config, cliCredentialsPath: credentials, caBundlePath: ca, caBundleSha256: digest(readFileSync(ca)) },
    credentials: { accessKeyId: 'ASIA' + 'A'.repeat(16), secretAccessKey: AUTH_SECRET, sessionToken: 'synthetic-native-session-token', expiration: new Date(AUTH_NOW + 3600000) } };
}
export function ownershipFixture(f: any) {
  const calls: any[] = [], reserved: string[] = [], signals: AbortSignal[] = [];
  let mutate: ((kind: string, value: any) => any) | undefined;
  const stack = () => ({ StackName: f.manifest.cloudformation.stackName, StackId: f.manifest.cloudformation.stackId,
    StackStatus: 'UPDATE_COMPLETE', CreationTime: new Date(AUTH_NOW - 86400000).toISOString(), LastUpdatedTime: new Date(AUTH_NOW - 10000).toISOString() });
  const runCli = async (args: readonly string[], options: any) => {
    signals.push(options.signal); const action = args.slice(0, 2).join(' ');
    const kind = action === 'sts get-caller-identity' ? 'identity' : action === 'cloudformation describe-stacks' ?
      (calls.some(x => x.kind === 'stack') ? 'stack_after' : 'stack') : f.manifest.cloudformation.resources.find((x: any) => x.logicalId === args[args.indexOf('--logical-resource-id') + 1])?.kind;
    calls.push({ kind, args: [...args], env: { ...options.env } });
    let value: any;
    if (kind === 'identity') value = { Account: '765932874577', Arn: f.manifest.expectedCallerArn, UserId: 'AROA_NATIVE:fixture' };
    else if (kind === 'stack' || kind === 'stack_after') value = { Stacks: [stack()] };
    else { const resource = f.manifest.cloudformation.resources.find((x: any) => x.kind === kind);
      value = { StackResourceDetail: { StackId: f.manifest.cloudformation.stackId, StackName: f.manifest.cloudformation.stackName,
        LogicalResourceId: resource.logicalId, PhysicalResourceId: resource.physicalId, ResourceType: resource.resourceType, ResourceStatus: 'CREATE_COMPLETE' } }; }
    return Buffer.from(JSON.stringify(mutate ? mutate(kind, value) : value));
  };
  return { calls, reserved, signals, runCli, change: (fn: typeof mutate) => { mutate = fn; },
    options: async () => ({ authority: await f.api.verifyClockCallerAuthority(f.options()), credentials: f.credentials, ...f.privateFiles,
      now: () => AUTH_NOW, reserveWire: (kind: string) => { reserved.push(kind); }, runCli }) };
}
export function cleanupAuthorityFixtures() {
  const temp = resolve(tmpdir());
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(temp + sep) || !basename(target).startsWith('rmap-clock-authority-')) throw Error('UNSAFE_TEST_CLEANUP');
    rmSync(target, { recursive: true, force: true });
  }
}
