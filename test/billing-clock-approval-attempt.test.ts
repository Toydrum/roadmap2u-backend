import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { AUTH_NOW, authorityFixture, cleanupAuthorityFixtures, ownershipFixture } from './support/clock-authority-fixture';

const windows = process.platform === 'win32';
const parent = mkdtempSync(join(tmpdir(), 'roadmap-clock-durable-'));
const pwsh = process.env.CLOCK_TEST_PWSH ?? process.env.USERPROFILE + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
let next = 0;
beforeAll(() => {
  if (!windows) return;
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', resolve('test/support/protect-clock-journal-test-parent.ps1')],
    { input: parent, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 });
  if (result.status !== 0) throw Error('TEST_PRIVATE_PARENT_REQUIRED');
});
afterAll(() => {
  cleanupAuthorityFixtures();
  const absolute = realpathSync(parent), base = realpathSync(tmpdir());
  if (!absolute.toLowerCase().startsWith((base + sep).toLowerCase())) throw Error('UNSAFE_TEST_CLEANUP');
  rmSync(absolute, { recursive: true, force: true });
});
function config() {
  return { directory: join(parent, 'protected', 'attempt-' + (++next)), powershellExecutable: pwsh,
    powershellSha256: createHash('sha256').update(readFileSync(pwsh)).digest('hex') };
}
async function setup(stage = 'dev', phase: 'install' | 'advance_fence' | 'ready' | 'refresh' = 'install') {
  const f = await authorityFixture(stage, phase, true);
  expect(f.api.reserveDurableClockCallerAttempt, 'Missing durable approval consumption').toBeTypeOf('function');
  expect(f.api.assertDurableClockCallerAttempt).toBeTypeOf('function');
  expect(f.api.prepareDurableClockOwnershipObserver).toBeTypeOf('function');
  const cfg = config(), store = f.api.initializeDurableClockJournal(cfg);
  f.manifest.journal = { directory: store.directory, directoryId: store.directoryId, aclSha256: store.aclSha256 }; f.freezeReview();
  const authority = await f.api.verifyClockCallerAuthority(f.options());
  return { ...f, authority, cfg, store };
}
function record(f: any) {
  const names = readdirSync(f.cfg.directory);
  expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[a-f0-9]{64}\.caller-attempt\.json$/);
  return JSON.parse(readFileSync(join(f.cfg.directory, names[0]), 'utf8'));
}
function childAttempt(f: any) {
  const script = `let raw='';for await(const b of process.stdin)raw+=b;const i=JSON.parse(raw);try{const a=await import(i.bundle);const authority=await a.verifyClockCallerAuthority({...i.options,now:()=>i.now});const store=a.openDurableClockJournal(i.config);a.reserveDurableClockCallerAttempt(authority,store,i.now);process.stdout.write('reserved');}catch(e){process.stdout.write(/^CLOCK_[A-Z_]+$/.test(e.message)?e.message:e.code==='ERR_MODULE_NOT_FOUND'?'TEST_DEPENDENCY_RESOLUTION_FAILED':'CONTROLLED_FAILURE');process.exitCode=1;}`;
  return new Promise<{ status: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { shell: false, windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('CHILD_TEST_TIMEOUT')); }, 20000);
    child.stdout.on('data', value => { output += value; }); child.stderr.resume();
    child.on('error', reject); child.on('close', status => { clearTimeout(timer); done({ status, output }); });
    const { now: _now, ...options } = f.options();
    child.stdin.end(JSON.stringify({ options, config: f.cfg, now: AUTH_NOW, bundle: new URL('file:///' + f.bundle.replaceAll('\\', '/')).href }));
  });
}

describe.runIf(windows)('durable consumption of a synthetic local approval before ownership reads', () => {
  it.each(['dev', 'test'].flatMap(stage => ['install', 'advance_fence', 'ready', 'refresh'].map(phase => [stage, phase])))('binds %s/%s without creating financial authority', async (stage, phase) => {
    const f = await setup(stage, phase as any), attempt = f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW);
    expect(attempt).toMatchObject({ sourceSha: f.sourceSha, manifestSha256: f.receipt.manifestSha256, physicalExecutionAllowed: false });
    expect(() => f.api.assertDurableClockCallerAttempt(attempt, f.authority, f.store, AUTH_NOW)).not.toThrow();
    expect(record(f)).toMatchObject({ sourceSha: f.sourceSha, requestSha256: f.manifest.requestSha256, phase, stage,
      approvedRootCommit: f.receipt.approvedRootCommit, reservedAt: AUTH_NOW, status: 'reserved', retryAllowed: false, physicalExecutionAllowed: false });
    expect(JSON.stringify(record(f))).not.toContain('in-memory-only');
    expect(JSON.stringify(record(f))).not.toContain(f.receipt.answer);
  });
  it('rejects the same approval after reopening with a freshly verified authority', async () => {
    const f = await setup(); f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW);
    const authority = await f.api.verifyClockCallerAuthority(f.options()), store = f.api.openDurableClockJournal(f.cfg);
    expect(() => f.api.reserveDurableClockCallerAttempt(authority, store, AUTH_NOW)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
    expect(record(f).status).toBe('reserved');
  });
  it('uses the human call identity once even if someone fabricates a new reviewed manifest for it', async () => {
    const f = await setup(); f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW);
    f.manifest.operationId = f.request.operationId = 'another_synthetic_operation';
    f.receipt.answer = 'Autorizar reloj DEV install another_synthetic_operation'; f.freezeReview();
    const authority = await f.api.verifyClockCallerAuthority(f.options());
    expect(() => f.api.reserveDurableClockCallerAttempt(authority, f.store, AUTH_NOW)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
  });
  it('rejects a replay in a separate Node process without sending anything', async () => {
    const f = await setup(); f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW);
    const result = await childAttempt(f);
    expect(result).toEqual({ status: 1, output: 'CLOCK_JOURNAL_STORE_ALREADY_RESERVED' });
  }, 30000);
  it('allows one winner between two independent authority-verifying processes', async () => {
    const f = await setup(), results = await Promise.all([childAttempt(f), childAttempt(f)]);
    expect(results.map(x => x.status).sort()).toEqual([0, 1]);
    expect(results.filter(x => x.output === 'reserved')).toHaveLength(1);
    expect(results.filter(x => x.output === 'CLOCK_JOURNAL_STORE_ALREADY_RESERVED')).toHaveLength(1);
    expect(record(f).status).toBe('reserved');
  }, 30000);
  it('requires the actual opaque authority and native directory capability', async () => {
    const f = await setup();
    expect(() => f.api.reserveDurableClockCallerAttempt({ ...f.authority }, f.store, AUTH_NOW)).toThrow('CLOCK_AUTHORITY_BOUND_CONTEXT_REQUIRED');
    expect(() => f.api.reserveDurableClockCallerAttempt(f.authority, f.cfg.directory, AUTH_NOW)).toThrow('CLOCK_JOURNAL_STORE_CAPABILITY_REQUIRED');
    expect(readdirSync(f.cfg.directory)).toHaveLength(0);
  });
  it('rejects an expired approval before any local reservation', async () => {
    const f = await setup();
    expect(() => f.api.reserveDurableClockCallerAttempt(f.authority, f.store, f.receipt.expiresAt)).toThrow('CLOCK_AUTHORITY_BOUND_CONTEXT_REQUIRED');
    expect(readdirSync(f.cfg.directory)).toHaveLength(0);
  });
  it('rejects substituting a new native directory for the one reviewed by the human', async () => {
    const f = await setup(), otherConfig = config(), other = f.api.initializeDurableClockJournal(otherConfig);
    expect(() => f.api.reserveDurableClockCallerAttempt(f.authority, other, AUTH_NOW)).toThrow('CLOCK_AUTHORITY_JOURNAL_BINDING_REJECTED');
    expect(readdirSync(otherConfig.directory)).toHaveLength(0); expect(readdirSync(f.cfg.directory)).toHaveLength(0);
  });
  it('rejects a legacy evidence manifest with no reviewed journal binding', async () => {
    const f = await setup(); delete f.manifest.journal; f.freezeReview();
    const authority = await f.api.verifyClockCallerAuthority(f.options());
    expect(() => f.api.reserveDurableClockCallerAttempt(authority, f.store, AUTH_NOW)).toThrow('CLOCK_AUTHORITY_JOURNAL_BINDING_REJECTED');
    expect(readdirSync(f.cfg.directory)).toHaveLength(0);
  });
  it('rejects copied, crossed or changed attempt bindings', async () => {
    const f = await setup(), attempt = f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW);
    const other = f.api.openDurableClockJournal(f.cfg);
    for (const copy of [{ ...attempt }, JSON.parse(JSON.stringify(attempt)), {}])
      expect(() => f.api.assertDurableClockCallerAttempt(copy, f.authority, f.store, AUTH_NOW)).toThrow('CLOCK_AUTHORITY_ATTEMPT_REQUIRED');
    expect(() => f.api.assertDurableClockCallerAttempt(attempt, f.authority, other, AUTH_NOW)).toThrow('CLOCK_AUTHORITY_ATTEMPT_REQUIRED');
    const name = readdirSync(f.cfg.directory)[0]; writeFileSync(join(f.cfg.directory, name), '{');
    expect(() => f.api.assertDurableClockCallerAttempt(attempt, f.authority, f.store, AUTH_NOW)).toThrow(/^CLOCK_/);
    expect(() => f.api.reserveDurableClockCallerAttempt(f.authority, f.store, AUTH_NOW)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
  });
  it('persists the reservation before the first simulated CLI delegation', async () => {
    const f = await setup(), owned = ownershipFixture(f); let count = 0;
    const reader = f.api.prepareDurableClockOwnershipObserver({ ...(await owned.options()), authority: f.authority, journalDirectory: f.store,
      runCli: async (args: readonly string[], context: any) => { expect(record(f).status).toBe('reserved'); count++; return owned.runCli(args, context); } });
    expect((await reader.observe()).status).toBe('ownership_verified'); expect(count).toBe(6);
    await expect(reader.observe()).rejects.toThrow(/^CLOCK_/); expect(count).toBe(6);
  }, 15000);
  it('consumes a failed ownership attempt and prevents a second first read', async () => {
    const f = await setup(), owned = ownershipFixture(f); let count = 0;
    const options = { ...(await owned.options()), authority: f.authority, journalDirectory: f.store,
      runCli: async () => { count++; throw Error('synthetic-private-error-never-persist'); } };
    await expect(f.api.prepareDurableClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_/);
    expect(count).toBe(1); expect(JSON.stringify(record(f))).not.toContain('synthetic-private-error');
    const authority = await f.api.verifyClockCallerAuthority(f.options());
    await expect(f.api.prepareDurableClockOwnershipObserver({ ...options, authority }).observe()).rejects.toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
    expect(count).toBe(1);
  });
  it('stops before another delegation if the durable record changed after the first read', async () => {
    const f = await setup(), owned = ownershipFixture(f); let count = 0;
    const reader = f.api.prepareDurableClockOwnershipObserver({ ...(await owned.options()), authority: f.authority, journalDirectory: f.store,
      runCli: async (args: readonly string[], context: any) => {
        count++; const result = await owned.runCli(args, context);
        if (count === 1) { const name = readdirSync(f.cfg.directory)[0], saved = record(f); saved.status = 'rewritten'; writeFileSync(join(f.cfg.directory, name), JSON.stringify(saved)); }
        return result;
      } });
    await expect(reader.observe()).rejects.toThrow(/^CLOCK_/); expect(count).toBe(1);
  });
  it('does not delegate if the window expires after the durable reservation', async () => {
    const f = await setup(), owned = ownershipFixture(f); let ticks = 0;
    const reader = f.api.prepareDurableClockOwnershipObserver({ ...(await owned.options()), authority: f.authority, journalDirectory: f.store,
      now: () => ++ticks <= 2 ? AUTH_NOW : f.receipt.expiresAt });
    await expect(reader.observe()).rejects.toThrow(/^CLOCK_/);
    expect(record(f).status).toBe('reserved'); expect(owned.calls).toHaveLength(0);
  });
});
