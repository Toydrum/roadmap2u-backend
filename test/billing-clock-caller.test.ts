import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AUTH_NOW } from './support/clock-authority-fixture';
import { callerFixture, cleanupCallerFixtures } from './support/clock-caller-fixture';

afterAll(cleanupCallerFixtures);
async function setup(phase: 'install' | 'advance_fence' | 'ready' | 'refresh' = 'install', stage = 'dev') {
  const f = await callerFixture(phase, stage);
  expect(f.api.prepareClockCaller, 'Missing complete clock caller').toBeTypeOf('function');
  return f;
}
describe.runIf(process.platform === 'win32')('complete clock caller, real Git/NTFS/SDK and simulated cloud transports', () => {
  it('accepts a tracked native helper with exact committed bytes before checking the full caller', async () => {
    const f = await setup();
    expect(() => f.api.assertClockCallerSource(f.authority, AUTH_NOW)).not.toThrow();
    const program = f.api.readDurableClockJournalProgram(f.journal);
    const blob = execFileSync('git', ['-C',f.sourceRoot,'show','HEAD:scripts/stripe-test-clock-journal-windows.ps1'], {windowsHide:true});
    expect(readFileSync(program.helperPath)).toEqual(blob);
    expect(() => f.api.assertClockCallerSource(f.authority, AUTH_NOW, {file:program.helperPath,sha256:program.helperSha256})).not.toThrow();
  }, 30000);
  it.each(['install','advance_fence','ready','refresh'] as const)('composes exact %s flow without delegating during preparation', async phase => {
    const f = await setup(phase), engine = await f.api.prepareClockCaller(f.engineOptions);
    expect(f.aws).toHaveLength(0); expect(f.stripe).toHaveLength(0); expect(f.ownership.calls).toHaveLength(0);
    expect(readdirSync(f.cfg.directory)).toHaveLength(0);
    const result = await engine.execute();
    expect(result.status, JSON.stringify({failureCode:result.failureCode,stoppedAt:result.stoppedAt,events:f.events})).toBe(phase === 'advance_fence' ? 'advance_acknowledged' : 'verified_applied');
    expect(result).toMatchObject({ status: phase === 'advance_fence' ? 'advance_acknowledged' : 'verified_applied', phase,
      retryAllowed: false, sourceSha: f.sourceSha, transactionSha256: f.authority.transactionSha256, readbackSha256: f.authority.readbackSha256 });
    expect(f.aws.filter((x: string) => x === 'write')).toHaveLength(1); expect(f.aws.filter((x: string) => x === 'readback')).toHaveLength(1);
    expect(f.ownership.calls).toHaveLength(6); expect(f.destroyed()).toBe(1);
    expect(f.stripe).toEqual(phase === 'advance_fence' ? ['account','customer','clock','account','customer','clock','advance'] : ['account','customer','clock']);
    expect(f.events.indexOf('stripe:clock')).toBeLessThan(f.events.indexOf('aws:write'));
    if (phase === 'advance_fence') { expect(f.advances()).toBe(1); expect(f.events.indexOf('aws:readback')).toBeLessThan(f.events.indexOf('stripe:advance')); expect(result.clockReadable).toBe(false); }
    else expect(result.clockReadable).toBe(true);
    const files = readdirSync(f.cfg.directory); expect(files.filter(x => x.endsWith('.caller-attempt.json'))).toHaveLength(1);
    expect(files.filter(x => x.endsWith('.intent.json'))).toHaveLength(1);
    const intent = JSON.parse(readFileSync(join(f.cfg.directory, files.find(x => x.endsWith('.intent.json'))!), 'utf8'));
    expect(intent.transactionSha256).toBe(f.authority.transactionSha256);
    await expect(engine.execute()).rejects.toThrow('CLOCK_CALLER_ALREADY_CONSUMED');
  }, 90000);
  it('supports independent TEST scope with exactly the same canonical preparers', async () => {
    const f = await setup('install', 'test'), engine = await f.api.prepareClockCaller(f.engineOptions);
    expect((await engine.execute()).status).toBe('verified_applied'); expect(engine.preview.stage).toBe('test');
  }, 90000);
  it.each(['profile','flags','mirror','customerMapping','closure','restoreExclusion'] as const)('rejects changed live %s before any write', async key => {
    const f = await setup(), index = {profile:0,flags:1,mirror:2,customerMapping:3,closure:5,restoreExclusion:6}[key];
    f.items[index] = f.items[index] ? { ...f.items[index], extraChanged: true } : { pk:'changed',sk:'changed' };
    const engine = await f.api.prepareClockCaller(f.engineOptions), result = await engine.execute();
    expect(result.status).toBe('stopped'); expect(f.aws).not.toContain('write'); expect(f.stripe).toHaveLength(0);
  }, 60000);
  it('rejects a changed Stripe frozen time before the transaction', async () => {
    const f = await setup(); f.stripeChange((kind: string, value: any) => kind === 'clock' ? { ...value, frozen_time: value.frozen_time + 1 } : value);
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('stopped'); expect(f.aws).not.toContain('write');
  }, 60000);
  it('rejects changed financial state in a transition before any write', async () => {
    const f = await setup('refresh'); f.items[7] = { ...f.items[7], revision: f.items[7].revision + 1 };
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('stopped'); expect(f.aws).not.toContain('write');
  }, 60000);
  it('allows newer ingress timestamps while retaining the reviewed transaction bytes', async () => {
    const f = await setup(); f.setNow(AUTH_NOW + 10000);
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('verified_applied'); expect(result.transactionSha256).toBe(f.authority.transactionSha256);
  }, 90000);
  it('does not advance when the fence write/readback remains uncertain', async () => {
    const f = await setup('advance_fence'); f.writeFail('before_apply');
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('uncertain'); expect(f.advances()).toBe(0); expect(f.aws.filter((x: string) => x === 'write')).toHaveLength(1);
  }, 90000);
  it('accepts exact atomic proof after a lost write response without sending the transaction twice', async () => {
    const f = await setup('advance_fence'); f.writeFail('after_apply');
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('advance_acknowledged'); expect(f.advances()).toBe(1); expect(f.aws.filter((x: string) => x === 'write')).toHaveLength(1);
  }, 90000);
  it('rechecks source changes after ownership and stops before AWS SDK delegation', async () => {
    const f = await setup(), original = f.engineOptions.ownershipCli;
    f.engineOptions.ownershipCli = async (...args: Parameters<typeof original>) => {
      const value = await original(...args);
      if (f.ownership.calls.length === 6) writeFileSync(f.bundle, readFileSync(f.bundle, 'utf8') + '\n// changed source\n');
      return value;
    };
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('stopped'); expect(f.aws).toHaveLength(0); expect(f.stripe).toHaveLength(0);
  }, 60000);
  it('consumes the window when ownership fails and prevents a new engine from making a first read', async () => {
    const f = await setup(); f.engineOptions.ownershipCli = async () => { throw Error('synthetic-private-ownership-failure'); };
    const first = await f.api.prepareClockCaller(f.engineOptions); expect((await first.execute()).status).toBe('stopped');
    const second = await f.api.prepareClockCaller(f.engineOptions); expect((await second.execute()).status).toBe('stopped');
    expect(f.aws).toHaveLength(0); expect(f.stripe).toHaveLength(0);
    expect(readdirSync(f.cfg.directory).filter(x => x.endsWith('.caller-attempt.json'))).toHaveLength(1);
  }, 60000);
  it('rejects copied authority, directory and expired window without any delegation', async () => {
    const f = await setup();
    await expect(f.api.prepareClockCaller({ ...f.engineOptions, authority: { ...f.authority } })).rejects.toThrow(/^CLOCK_/);
    await expect(f.api.prepareClockCaller({ ...f.engineOptions, journalDirectory: { ...f.journal } })).rejects.toThrow(/^CLOCK_/);
    f.setNow(f.receipt.expiresAt);
    await expect(f.api.prepareClockCaller(f.engineOptions)).rejects.toThrow(/^CLOCK_/);
    expect(f.ownership.calls).toHaveLength(0); expect(f.aws).toHaveLength(0);
  }, 60000);
  it('persists no private profile, key, credentials or transport errors in results or journals', async () => {
    const f = await setup(), result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    const all = JSON.stringify(result) + readdirSync(f.cfg.directory).map(n => readFileSync(join(f.cfg.directory,n),'utf8')).join('');
    for (const value of ['in-memory-only', f.credentials.secretAccessKey, f.credentials.sessionToken, f.engineOptions.apiKey, 'Authorization', 'AWS4-HMAC-SHA256']) expect(all).not.toContain(value);
  }, 90000);
  it.each(['missing','program','certificate'] as const)('rejects %s reviewed runtime pins before delegating', async fault => {
    const f = await setup();
    if (fault === 'missing') delete f.manifest.runtime;
    else if (fault === 'program') f.manifest.runtime.powershellSha256 = 'a'.repeat(64);
    else f.manifest.runtime.caBundleSha256 = 'a'.repeat(64);
    f.freezeReview(); const authority = await f.api.verifyClockCallerAuthority(f.options());
    await expect(f.api.prepareClockCaller({ ...f.engineOptions, authority })).rejects.toThrow(/^CLOCK_/);
    expect(f.aws).toHaveLength(0); expect(f.stripe).toHaveLength(0);
  }, 60000);
  it('stops before another request if the pinned CA changes after an AWS read', async () => {
    const f = await setup();
    f.awsChange((kind: string, value: any) => { if (kind === 'identity') writeFileSync(f.privateFiles.caBundlePath,'PUBLIC_MODIFIED_CA\n'); return value; });
    const result = await (await f.api.prepareClockCaller(f.engineOptions)).execute();
    expect(result.status).toBe('stopped'); expect(f.aws).toEqual(['identity']); expect(f.stripe).toHaveLength(0);
  }, 90000);
});
