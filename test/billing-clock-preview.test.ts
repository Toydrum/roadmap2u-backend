import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';
import { prepareClockJournal, prepareClockProviderAdvance } from '../scripts/stripe-test-clock-journal';
import type { ClockTransitionRequest } from '../scripts/stripe-test-clock-transition';
import { prepareClockPreview as preview, runClockPreviewCli as cli } from '../scripts/stripe-test-clock-preview';

const NOW = Date.UTC(2026, 9, 13, 12), FROZEN = NOW / 1000 - 86400;
const SOURCE = '43b2dc8abc3f2f8465cfa2706ff0f6b5b4e8b0db';
const marker = 'private-profile-value-not-for-preview';
function initial(stage = 'dev'): ClockInstallRequest {
  const owner = 'owner_preview', customer = 'cus_preview', clock = 'clock_preview', account = 'acct_sandbox';
  const app = `roadmap-${stage}`, privacy = `roadmap-privacy-${stage}`;
  return { operationId: 'preview_install', storage: { stage, awsAccountId: '765932874577', region: 'us-east-1', appTableArn: `arn:aws:dynamodb:us-east-1:765932874577:table/${app}`, privacyTableName: privacy, privacyTableArn: `arn:aws:dynamodb:us-east-1:765932874577:table/${privacy}` },
    clock: { ownerSub: owner, realNow: NOW, priorMirror: null,
      scope: { tableName: app, stage, stripeAccountId: account, liveMode: false, fixtures: [{ ownerSub: owner, customerId: customer, testClockId: clock, bindingId: 'preview_binding', stage, stripeAccountId: account, syntheticFixture: `stripe_clock_${stage}_preview` }] },
      observation: { stripeAccountId: account, stage, liveMode: false, startedAt: NOW - 100, completedAt: NOW - 50,
        customer: { id: customer, object: 'customer', livemode: false, test_clock: clock, metadata: { owner, stage, integration: 'roadmap2u_individual_v1' } },
        clock: { id: clock, object: 'test_helpers.test_clock', livemode: false, status: 'ready', frozen_time: FROZEN, deletes_after: NOW / 1000 + 86400 } } },
    snapshot: { ownerSub: owner, stage, appTableName: app, privacyTableName: privacy, startedAt: NOW - 100, completedAt: NOW - 20, consistentReads: true, financialPartitionComplete: true,
      identity: { ownerSub: owner, enabled: false }, profile: { pk: `USER#${owner}`, sk: 'PROFILE', userId: owner, accountType: 'adult', status: 'active', privatePayload: marker },
      financialRows: [], mirror: null, customerMapping: null, subscriptionSource: null, closure: null, restoreExclusion: null,
      flags: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', revision: 61, quotaMode: 'enforce', capabilityMode: 'enforce', accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: false,
        premiumPaymentsEnabled: false, ...FAMILY_BILLING_FLAG_DEFAULTS, schemaVersion: 2, paymentScope: 'none', individualCheckoutEnabled: false, updatedAt: NOW - 1000, updatedBy: 'synthetic', reason: 'closed' } } };
}
function manifest(request: ClockInstallRequest | ClockTransitionRequest = initial()) { return { schemaVersion: 1, sourceSha: SOURCE, request }; }
async function transition(kind: 'advance_fence' | 'ready' | 'refresh'): Promise<ClockTransitionRequest> {
  const i = initial(), installed = await prepareClockInstallTransaction(i);
  const clock = structuredClone(i.clock), snapshot: any = structuredClone(i.snapshot);
  clock.realNow += 100; clock.priorMirror = installed.evidence.mirror;
  clock.observation.startedAt = NOW + 20; clock.observation.completedAt = NOW + 50;
  snapshot.startedAt = NOW + 10; snapshot.completedAt = NOW + 60;
  snapshot.mirror = clock.priorMirror;
  snapshot.financialState = installed.transaction.TransactItems!.find(row => row.Put?.Item?.sk === 'STATE')!.Put!.Item!;
  snapshot.customerMapping = installed.transaction.TransactItems!.find(row => row.Put?.Item?.sk === 'OWNER')!.Put!.Item!;
  delete snapshot.financialRows; delete snapshot.financialPartitionComplete; delete snapshot.subscriptionSource;
  const request: ClockTransitionRequest = { clock, snapshot, storage: i.storage, operationId: 'preview_transition', kind: kind === 'ready' ? 'advance_fence' : kind,
    ...(kind === 'refresh' ? {} : { targetFrozenTimeSeconds: FROZEN + 86400 }) };
  if (kind === 'ready') {
    const fence = await prepareClockJournal(request, SOURCE);
    request.kind = 'ready'; request.clock.priorMirror = fence.evidence.mirror; request.snapshot.mirror = fence.evidence.mirror;
    request.clock.realNow += 100; request.clock.observation.startedAt += 100; request.clock.observation.completedAt += 100;
    request.snapshot.startedAt += 100; request.snapshot.completedAt += 100;
    request.clock.observation.clock.frozen_time = request.targetFrozenTimeSeconds!; delete request.targetFrozenTimeSeconds;
  }
  return request;
}
const io = (raw = JSON.stringify(manifest())) => {
  const output: string[] = [], errors: string[] = []; let reads = 0;
  return { output, errors, reads: () => reads, readManifest: async () => { reads++; return raw; },
    writeOut: (text: string) => output.push(text), writeError: (text: string) => errors.push(text) };
};
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-clock-preview-'));
  return { dir, close: () => { const absolute = realpathSync(dir); expect(absolute.startsWith(realpathSync(tmpdir()) + sep)).toBe(true); expect(absolute.split(sep).at(-1)).toMatch(/^roadmap-clock-preview-/); rmSync(absolute, { recursive: true, force: true }); } };
}

describe('offline test clock manifest preview', () => {
  it.each(['dev', 'test'])('derives %s installation through the real preparer without authority', async stage => {
    const request = initial(stage), raw = JSON.stringify(manifest(request)), real = await prepareClockJournal(request, SOURCE);
    const result = await preview(raw);
    expect(result).toMatchObject({ schemaVersion: 1, mode: 'offline_preview', intent: real.intent,
      physicalExecutionAllowed: false, physicalAuthorizationChecked: false, sourceShaVerified: false, remoteStateVerified: false, retryAllowed: false,
      dynamodb: { transactionItems: 9, writes: 4, conditionChecks: 5, maximumWriteRequests: 1, maximumReadbackRequests: 1, readbackItems: 4 } });
    expect(result.manifestSha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(result.dynamodb.targets).toHaveLength(9);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.providerAdvance).toBeNull();
  });
  it.each(['advance_fence', 'ready', 'refresh'] as const)('previews %s with the existing journal and provider descriptor', async kind => {
    const request = await transition(kind), actual = await prepareClockJournal(request, SOURCE), result = await preview(JSON.stringify(manifest(request)));
    expect(result.intent).toEqual(actual.intent);
    expect(result.dynamodb).toMatchObject({ transactionItems: 8, writes: 2, conditionChecks: 6, readbackItems: 2 });
    expect(result.providerAdvance).toEqual(kind === 'advance_fence' ? { ...prepareClockProviderAdvance(actual), requiresVerifiedFence: true, maximumPostRequests: 1 } : null);
    expect(result.physicalExecutionAllowed).toBe(false);
  });
  it('binds exact UTF-8 manifest bytes while retaining identical derived transaction hashes', async () => {
    const data = manifest(), compact = await preview(JSON.stringify(data)), pretty = await preview(JSON.stringify(data, null, 2));
    expect(pretty.manifestSha256).not.toBe(compact.manifestSha256);
    expect(pretty.intent).toEqual(compact.intent);
  });
  it.each([null, 7, {}, [], '', '{bad', JSON.stringify({ ...manifest(), schemaVersion: 2 }), JSON.stringify({ ...manifest(), sourceSha: 'bad' }),
    JSON.stringify({ ...manifest(), apiKey: 'rk_test_do_not_echo' }), JSON.stringify({ ...manifest(), request: null }), ' '.repeat(262145)].map(raw => ({ raw })))('rejects malformed, oversized or extra manifest fields', async ({ raw }) => {
    await expect(preview(raw)).rejects.toThrow(/CLOCK_PREVIEW/);
  });
  it.each(['prod', 'live', 'region', 'flags', 'historical', 'enabled', 'lease'] as const)('retains the real %s rejection', async invalid => {
    const request = initial();
    if (invalid === 'prod') request.clock.scope.stage = 'prod';
    if (invalid === 'live') request.clock.scope.liveMode = true;
    if (invalid === 'region') request.storage.region = 'eu-west-1';
    if (invalid === 'flags') request.snapshot.flags = { ...request.snapshot.flags as object, individualCheckoutEnabled: true };
    if (invalid === 'historical') request.clock.scope.fixtures = [{ ...request.clock.scope.fixtures[0], ownerSub: 'e4282408-f0f1-70b2-b5ef-b9ddb80599e7' }];
    if (invalid === 'enabled') request.snapshot.identity.enabled = true;
    if (invalid === 'lease') { const t = await transition('refresh'); t.snapshot.financialState!.leaseUntil = t.clock.realNow + 1; await expect(preview(JSON.stringify(manifest(t)))).rejects.toThrow(/CLOCK_/); return; }
    await expect(preview(JSON.stringify(manifest(request)))).rejects.toThrow(/CLOCK_/);
  });
  it.each([[], ['--execute'], ['--manifest'], ['--manifest','a.json','--execute'], ['--manifest','a.json','--manifest','b.json']].map(args => ({ args })))('rejects CLI modes before reading input', async ({ args }) => {
    const output = io(); expect(await cli(args, output)).toBe(2); expect(output.reads()).toBe(0); expect(output.output).toEqual([]);
    expect(JSON.parse(output.errors[0])).toEqual({ status: 'rejected', code: 'CLOCK_PREVIEW_ARGUMENTS' });
  });
  it('writes only a sanitized successful preview to stdout', async () => {
    const output = io(); expect(await cli(['--manifest','fixture.json'], output)).toBe(0); expect(output.reads()).toBe(1); expect(output.errors).toEqual([]);
    expect(JSON.parse(output.output[0]).mode).toBe('offline_preview'); expect(output.output.join('')).not.toContain(marker);
  });
  it('does not print raw reader errors or malformed input', async () => {
    const output = io('{"secret":"rk_test_never_echo"'); expect(await cli(['--manifest','fixture.json'], output)).toBe(1);
    expect(output.errors.join('')).not.toContain('rk_test'); expect(output.output).toEqual([]);
    const failed = io(); failed.readManifest = async () => { throw new Error('whsec_never_echo'); };
    expect(await cli(['--manifest','fixture.json'], failed)).toBe(1); expect(failed.errors.join('')).not.toContain('whsec'); expect(failed.output).toEqual([]);
  });
  it('applies the byte limit to multibyte text, including ignored profile attributes', async () => {
    const data = manifest(); data.request.snapshot.profile!.privatePayload = 'é'.repeat(140000);
    const raw = JSON.stringify(data); expect(raw.length).toBeLessThan(262144);
    await expect(preview(raw)).rejects.toThrow('CLOCK_PREVIEW_MANIFEST_REJECTED');
  });
  it.each(['oversized', 'invalid_utf8', 'directory'] as const)('rejects an actual %s manifest file without raw diagnostics', async bad => {
    const own = temp();
    try {
      const input = bad === 'directory' ? own.dir : join(own.dir, 'bad.json');
      if (bad === 'oversized') writeFileSync(input, ' '.repeat(262145));
      if (bad === 'invalid_utf8') writeFileSync(input, Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xc0,0xaf,0x22,0x7d]));
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/stripe-test-clock-preview.ts', '--manifest', input], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: own.dir, TMP: own.dir, TSX_DISABLE_CACHE: '1' },
      });
      expect(child.status).toBe(1); expect(child.stdout).toBe('');
      expect(JSON.parse(child.stderr)).toEqual({ status: 'rejected', code: 'CLOCK_PREVIEW_READ_FAILED' });
      expect(child.stderr).not.toContain(own.dir);
    } finally { own.close(); }
  });
  it('runs the actual CLI with all network primitives blocked and creates no files', () => {
    const own = temp();
    try {
      const input = join(own.dir, 'fixture.json'), guard = join(own.dir, 'deny-network.cjs');
      writeFileSync(input, JSON.stringify(manifest()));
      writeFileSync(guard, "for(const n of ['node:http','node:https']){const m=require(n);m.request=m.get=()=>{throw new Error('NETWORK_FORBIDDEN')};}for(const n of ['node:net','node:tls']){require(n).connect=()=>{throw new Error('NETWORK_FORBIDDEN')};}globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')};");
      const before = readdirSync(own.dir), bytes = readFileSync(input);
      const child = spawnSync(process.execPath, ['--require', guard, '--import', 'tsx', 'scripts/stripe-test-clock-preview.ts', '--manifest', input], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: own.dir, TMP: own.dir, TSX_DISABLE_CACHE: '1' },
      });
      expect(child.status, child.stderr).toBe(0); expect(child.stderr).toBe(''); expect(JSON.parse(child.stdout).intent.sourceSha).toBe(SOURCE);
      expect(readdirSync(own.dir)).toEqual(before); expect(readFileSync(input)).toEqual(bytes);
    } finally { own.close(); }
  });
});
