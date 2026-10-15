import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AUTH_NOW, authorityFixture, cleanupAuthorityFixtures, ownershipFixture } from './clock-authority-fixture';
import { STRIPE_API_VERSION } from '../../lambda/billing/model';

const parents: string[] = [];
export async function callerFixture(phase: 'install' | 'advance_fence' | 'ready' | 'refresh' = 'install', stage = 'dev') {
  const f = await authorityFixture(stage, phase, true, true);
  const parent = mkdtempSync(join(tmpdir(), 'roadmap-clock-durable-')); parents.push(parent);
  const pwsh = process.env.CLOCK_TEST_PWSH ?? process.env.USERPROFILE + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
  const protectedParent = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', resolve('test/support/protect-clock-journal-test-parent.ps1')],
    { input: parent, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  if (protectedParent.status !== 0) throw Error('TEST_PRIVATE_PARENT_REQUIRED');
  const cfg = { directory: join(parent, 'protected', 'journal'), powershellExecutable: pwsh, powershellSha256: createHash('sha256').update(readFileSync(pwsh)).digest('hex') };
  const journal = f.api.initializeDurableClockJournal(cfg);
  f.manifest.journal = { directory: journal.directory, directoryId: journal.directoryId, aclSha256: journal.aclSha256 };
  f.manifest.runtime = { powershellExecutable: realpathSync(pwsh), powershellSha256: cfg.powershellSha256, caBundleSha256: f.privateFiles.caBundleSha256 }; f.freezeReview();
  const authority = await f.api.verifyClockCallerAuthority(f.options()), ownership = ownershipFixture(f);
  const request = structuredClone(f.request), scope = request.clock.scope, owner = request.clock.ownerSub;
  const items = [request.snapshot.profile, request.snapshot.flags, request.snapshot.mirror, request.snapshot.customerMapping,
    request.snapshot.subscriptionSource ?? null, request.snapshot.closure, request.snapshot.restoreExclusion, request.snapshot.financialState ?? null];
  const rows = new Map<string, any>();
  const aws: string[] = [], stripe: string[] = [], events: string[] = [], written: any[] = [];
  let time = AUTH_NOW, destroyed = 0, advances = 0;
  let mutateAws: ((kind: string, value: any) => any) | undefined;
  let mutateStripe: ((kind: string, value: any) => any) | undefined;
  let writeFailure: 'none' | 'before_apply' | 'after_apply' = 'none';
  const response = (value: unknown) => ({ response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Buffer.from(JSON.stringify(value)) } });
  const awsHandler = { destroy: () => { destroyed++; }, handle: async (wire: any) => {
    const target = wire.headers['x-amz-target'], body = wire.hostname.startsWith('sts.') ? {} : JSON.parse(Buffer.from(wire.body).toString('utf8'));
    const kind = wire.hostname.startsWith('sts.') ? 'identity' : wire.hostname.startsWith('cognito-idp.') ? 'fixture_identity' :
      target.endsWith('.DescribeTable') ? body.TableName === scope.tableName ? 'app_table' : 'privacy_table' :
      target.endsWith('.Query') ? 'financial_partition' : target.endsWith('.TransactWriteItems') ? 'write' : body.TransactItems.length === 8 ? 'snapshot' : 'readback';
    aws.push(kind); events.push('aws:' + kind);
    let value: any;
    if (kind === 'identity') {
      value = { Account: request.storage.awsAccountId, Arn: f.manifest.expectedCallerArn, UserId: 'AROA_SYNTHETIC:caller' };
      value = mutateAws?.(kind, value) ?? value;
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${value.Account}</Account><Arn>${value.Arn}</Arn><UserId>${value.UserId}</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></GetCallerIdentityResponse>`) } };
    }
    if (kind === 'app_table' || kind === 'privacy_table') value = { Table: { TableName: body.TableName,
      TableArn: 'arn:aws:dynamodb:us-east-1:765932874577:table/' + body.TableName, TableStatus: 'ACTIVE',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }] } };
    else if (kind === 'fixture_identity') value = { Username: scope.fixtures[0].syntheticFixture, Enabled: false, UserAttributes: [{ Name: 'sub', Value: owner }] };
    else if (kind === 'snapshot') value = { Responses: items.map(Item => Item ? { Item: marshall(Item) } : {}) };
    else if (kind === 'financial_partition') value = { Items: [], Count: 0, ScannedCount: 0 };
    else if (kind === 'write') {
      if (writeFailure === 'before_apply') throw Error('synthetic-private-write-failure');
      written.push(structuredClone(body));
      for (const item of body.TransactItems) if (item.Put) { const row = unmarshall(item.Put.Item); rows.set(item.Put.TableName + ':' + row.pk + ':' + row.sk, row); }
      if (writeFailure === 'after_apply') throw Error('synthetic-private-write-failure');
      value = {};
    } else value = { Responses: body.TransactItems.map(({ Get }: any) => { const key = unmarshall(Get.Key), row = rows.get(Get.TableName + ':' + key.pk + ':' + key.sk); return row ? { Item: marshall(row) } : {}; }) };
    return response(mutateAws?.(kind, value) ?? value);
  } };
  const stripeClient = { getClientName: () => 'synthetic-caller', makeRequest: async (_host: any, _port: any, path: string, method: string, _headers: any, data: string) => {
    const kind = method === 'POST' ? 'advance' : path === '/v1/account' ? 'account' : path.includes('/customers/') ? 'customer' : 'clock';
    stripe.push(kind); events.push('stripe:' + kind);
    let value: any = kind === 'account' ? { id: scope.stripeAccountId, object: 'account', country: 'MX' } : kind === 'customer' ? request.clock.observation.customer : request.clock.observation.clock;
    if (kind === 'advance') { advances++; value = { ...value, status: 'advancing', status_details: { advancing: { target_frozen_time: Number(data.slice('frozen_time='.length)) } } }; }
    value = mutateStripe?.(kind, structuredClone(value)) ?? value;
    return { getStatusCode: () => 200, getHeaders: () => ({ 'request-id': 'req_synthetic', 'stripe-version': STRIPE_API_VERSION }),
      getRawResponse: () => ({statusCode:200}), toStream: () => undefined, toJSON: async () => structuredClone(value) };
  } };
  return { ...f, cfg, journal, authority, ownership, items, aws, stripe, events, written, rows,
    setNow: (v: number) => { time = v; }, awsChange: (fn: typeof mutateAws) => { mutateAws = fn; }, stripeChange: (fn: typeof mutateStripe) => { mutateStripe = fn; },
    writeFail: (v: typeof writeFailure) => { writeFailure = v; }, destroyed: () => destroyed, advances: () => advances,
    engineOptions: { authority, journalDirectory: journal, credentials: f.credentials, ...f.privateFiles, ownershipCli: ownership.runCli,
      awsHandler, stripeClient, apiKey: 'rk_test_clockCallerSynthetic', now: () => time, requestTimeoutMs: 10000 } };
}
export function cleanupCallerFixtures() {
  cleanupAuthorityFixtures();
  for (const parent of parents.splice(0)) {
    const absolute = realpathSync(parent), base = realpathSync(tmpdir());
    if (!absolute.toLowerCase().startsWith((base + sep).toLowerCase())) throw Error('UNSAFE_TEST_CLEANUP');
    rmSync(absolute, { recursive: true, force: true });
  }
}
