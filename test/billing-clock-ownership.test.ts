import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AUTH_NOW, AUTH_SECRET, authorityFixture, ownershipFixture, cleanupAuthorityFixtures } from './support/clock-authority-fixture';

afterAll(cleanupAuthorityFixtures);
async function setup(stage = 'dev') {
  const f = await authorityFixture(stage);
  expect(f.api.prepareClockOwnershipObserver, 'Bounded ownership observer is missing').toBeTypeOf('function');
  return { f, h: ownershipFixture(f) };
}
describe('bounded native CLI CloudFormation ownership', () => {
  it.each(['dev', 'test'])('verifies %s identity, immutable stack, three resources and stable final stack', async stage => {
    const { f, h } = await setup(stage), observer = f.api.prepareClockOwnershipObserver(await h.options());
    expect(h.calls).toEqual([]); expect(h.reserved).toEqual([]);
    const proof = await observer.observe();
    expect(h.calls.map(x => x.kind)).toEqual(['identity', 'stack', 'app', 'privacy', 'pool', 'stack_after']);
    expect(h.reserved).toEqual(h.calls.map(x => x.kind));
    expect(proof).toMatchObject({ status: 'ownership_verified', sourceShaVerified: true, authorizationReceiptBound: true,
      stackOwnershipVerified: true, physicalExecutionAllowed: false, stage, operationId: f.manifest.operationId });
    expect(JSON.stringify(proof)).not.toContain(AUTH_SECRET);
    expect(JSON.stringify(observer.preview)).not.toContain(AUTH_SECRET);
    for (const call of h.calls) {
      expect(call.args).not.toContain(AUTH_SECRET); expect(call.args).not.toContain('--profile');
      expect(call.args).toContain('--no-paginate'); expect(call.args).toContain('--no-cli-auto-prompt');
      expect(call.env.AWS_SECRET_ACCESS_KEY).toBe(AUTH_SECRET); expect(call.env.AWS_MAX_ATTEMPTS).toBe('1');
      expect(call.env.AWS_CONFIG_FILE).toBe(f.privateFiles.cliConfigPath);
      expect(call.env.AWS_EC2_METADATA_DISABLED).toBe('true');
    }
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(6);
  });
  it.each(['forged', 'copied', 'expired', 'backward', 'credential', 'config', 'ca'] as const)(
    'rejects %s before delegation', async fault => {
      const { f, h } = await setup(), options = await h.options();
      if (fault === 'forged') options.authority = { ...options.authority, sourceShaVerified: true };
      if (fault === 'copied') options.authority = structuredClone(options.authority);
      if (fault === 'expired') options.now = () => AUTH_NOW + 900000;
      if (fault === 'backward') options.now = () => AUTH_NOW - 1;
      if (fault === 'credential') options.credentials.sessionToken = '';
      if (fault === 'config') writeFileSync(options.cliConfigPath, '[default]\nregion=eu-west-1\n');
      if (fault === 'ca') writeFileSync(options.caBundlePath, 'REPLACED_CA');
      expect(() => f.api.prepareClockOwnershipObserver(options)).toThrow(/^CLOCK_(?:AUTHORITY|OWNERSHIP)_/);
      expect(h.calls).toEqual([]); expect(h.reserved).toEqual([]);
    });
  for (const [kind, field, value] of [
    ['identity', 'Account', '111111111111'], ['identity', 'Arn', 'arn:aws:iam::765932874577:user/foreign'],
    ['stack', 'StackId', 'arn:aws:cloudformation:us-east-1:765932874577:stack/Other/11111111-2222-3333-4444-555555555555'],
    ['stack', 'StackStatus', 'UPDATE_IN_PROGRESS'], ['app', 'PhysicalResourceId', 'roadmap-prod'],
    ['privacy', 'ResourceType', 'AWS::S3::Bucket'], ['pool', 'PhysicalResourceId', 'us-east-1_FOREIGN'],
    ['pool', 'StackName', 'Roadmap-prod-Backend'], ['app', 'LogicalResourceId', 'Foreign'],
    ['privacy', 'ResourceStatus', 'DELETE_COMPLETE'], ['stack_after', 'LastUpdatedTime', new Date(AUTH_NOW).toISOString()],
  ]) it(`stops on ${kind}.${field} drift without a second send`, async () => {
    const { f, h } = await setup(); h.change((seen, row) => {
      if (seen !== kind) return row; const target = seen === 'identity' ? row : seen.startsWith('stack') ? row.Stacks[0] : row.StackResourceDetail;
      target[field] = value; return row;
    });
    const observer = f.api.prepareClockOwnershipObserver(await h.options());
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls.filter(x => x.kind === kind)).toHaveLength(1);
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
  });
  it('rejects paginated named-stack data instead of inferring complete ownership', async () => {
    const { f, h } = await setup(); h.change((kind, value) => kind === 'stack' ? { ...value, NextToken: 'unexpected-page' } : value);
    await expect(f.api.prepareClockOwnershipObserver(await h.options()).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(2);
  });
  it('reserves before delegation and never delegates after a failed reservation', async () => {
    const { f, h } = await setup(), options = await h.options(); options.reserveWire = () => { throw Error(AUTH_SECRET); };
    await expect(f.api.prepareClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(0);
  });
  it('aborts a hung dependency at its bounded deadline and consumes the observer', async () => {
    const { f, h } = await setup(), options = await h.options();
    let signal: AbortSignal | undefined; options.requestTimeoutMs = 20;
    options.runCli = async (_args: any, child: any) => { signal = child.signal; return new Promise<never>(() => {}); };
    const observer = f.api.prepareClockOwnershipObserver(options);
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(signal?.aborted).toBe(true); await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.reserved).toHaveLength(1);
  });
  it('uses copied credentials and approved bindings after caller mutation', async () => {
    const { f, h } = await setup(), options = await h.options();
    const observer = f.api.prepareClockOwnershipObserver(options);
    options.credentials.secretAccessKey = 'caller-mutated'; options.credentials.expiration.setTime(0);
    options.cliConfigPath = 'foreign-config'; options.now = () => 0;
    const result = await observer.observe(); expect(result.stackOwnershipVerified).toBe(true);
    expect(h.calls[0].env.AWS_SECRET_ACCESS_KEY).toBe(AUTH_SECRET);
  });
  it('detects configuration replacement between serial reads before the next delegation', async () => {
    const { f, h } = await setup(); h.change((kind, value) => { if (kind === 'identity') writeFileSync(f.privateFiles.cliConfigPath, 'changed'); return value; });
    await expect(f.api.prepareClockOwnershipObserver(await h.options()).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(1);
  });
  it('rejects invalid UTF-8 and never includes arbitrary child error text', async () => {
    const { f, h } = await setup(), options = await h.options(); options.runCli = async () => Buffer.from([0xc0, 0xaf]);
    await expect(f.api.prepareClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    f.receipt.callId = 'call_LOCAL_NATIVE_ERROR_WINDOW_2';
    const next = await h.options(); let sends = 0;
    next.runCli = async () => { sends++; throw Error(AUTH_SECRET); };
    await expect(f.api.prepareClockOwnershipObserver(next).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(sends).toBe(1);
  });
  it('cannot reuse one authority object through a second prepared observer', async () => {
    const { f, h } = await setup(), options = await h.options();
    const first = f.api.prepareClockOwnershipObserver(options), second = f.api.prepareClockOwnershipObserver(options);
    await first.observe();
    await expect(second.observe()).rejects.toThrow(/^CLOCK_(?:AUTHORITY|OWNERSHIP)_/);
    expect(h.calls).toHaveLength(6);
  });
  it('rejects an asynchronous reservation before delegating the first read', async () => {
    const { f, h } = await setup(), options = await h.options(); options.reserveWire = async () => {};
    const observer = f.api.prepareClockOwnershipObserver(options);
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(0);
    expect(observer.counts().delegations.identity).toBe(0);
  });
  it('rechecks fixed CLI files after the reservation before delegating', async () => {
    const { f, h } = await setup(), options = await h.options();
    options.reserveWire = () => { writeFileSync(options.cliConfigPath, 'unreviewed endpoint override'); };
    const observer = f.api.prepareClockOwnershipObserver(options);
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(0);
  });
  it('rejects an oversized response without a second delegation', async () => {
    const { f, h } = await setup(), options = await h.options();
    let sends = 0; options.runCli = async () => { sends++; return Buffer.alloc(2 * 1024 * 1024 + 1, 32); };
    await expect(f.api.prepareClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(sends).toBe(1);
  });
  it('expires the authority during a response before another request is sent', async () => {
    const { f, h } = await setup(), options = await h.options(); let now = AUTH_NOW;
    options.now = () => now;
    options.runCli = async (args: any, child: any) => { const value = await h.runCli(args, child); now += 900000; return value; };
    await expect(f.api.prepareClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    expect(h.calls).toHaveLength(1);
  });
  it('cannot mint a second ownership use by verifying the same receipt again', async () => {
    const { f, h } = await setup();
    await f.api.prepareClockOwnershipObserver(await h.options()).observe();
    await expect(f.api.prepareClockOwnershipObserver(await h.options()).observe()).rejects.toThrow(/^CLOCK_(?:AUTHORITY|OWNERSHIP)_/);
    expect(h.calls).toHaveLength(6);
  });
  it('absorbs a rejected asynchronous reservation without delegating or exposing its error', async () => {
    const { f, h } = await setup(), options = await h.options();
    options.reserveWire = async () => { throw Error(AUTH_SECRET); };
    await expect(f.api.prepareClockOwnershipObserver(options).observe()).rejects.toThrow(/^CLOCK_OWNERSHIP_/);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.calls).toHaveLength(0);
  });
  it('removes unrelated Stripe secrets and ambient AWS overrides from the child environment', async () => {
    const { f, h } = await setup(), options = await h.options();
    const names = ['STRIPE_API_KEY', 'AWS_PROFILE', 'AWS_ENDPOINT_URL'];
    const before = Object.fromEntries(names.map(k => [k, process.env[k]]));
    try {
      process.env.STRIPE_API_KEY = 'synthetic-unrelated-stripe-value';
      process.env.AWS_PROFILE = 'unreviewed-profile'; process.env.AWS_ENDPOINT_URL = 'https://example.invalid';
      await f.api.prepareClockOwnershipObserver(options).observe();
      for (const call of h.calls) for (const name of names) expect(call.env[name]).toBeUndefined();
    } finally { for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  });
});
