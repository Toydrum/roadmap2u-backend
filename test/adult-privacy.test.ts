import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { handleEvent } from '../lambda/router';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { getSyncChanges, pushSync } from '../lambda/handlers/sync';
import { getForest } from '../lambda/handlers/forests';
import { processCloudErasurePage } from '../lambda/privacy/erasure';
import { handleEvent as handlePostConfirmation } from '../lambda/post-confirmation';
import { ADULT_PRIVACY_VERSIONS } from '@app/api/contracts';

const NOW = 1_800_000_000_000;
const OWNER = 'adult-owner';
const versions = ADULT_PRIVACY_VERSIONS;
const ddb = mockClient(DynamoDBDocumentClient);
let rows: Map<string, Record<string, unknown>>;
let documentHash = 'feature-not-implemented';
const key = (value: { pk?: unknown; sk?: unknown }) => `${value.pk}/${value.sk}`;
const profile = (accountType: 'adult' | 'minor' = 'adult'): ProfileItem => ({
  ...K.profile(OWNER),
  userId: OWNER,
  username: OWNER,
  displayName: OWNER,
  accountType,
  socialEnabled: false,
  status: 'active',
  createdAt: NOW - 1000,
});
function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
    table: 'roadmap-dev',
    userPoolId: 'pool',
    now: () => NOW,
    ...{ privacyTable: 'privacy-retention-dev' },
  };
}
async function request(method: string, path: string, body?: unknown) {
  return handleEvent(
    {
      version: '2.0',
      rawPath: `/v1${path}`,
      headers: { authorization: 'Bearer privacy-test-secret-token' },
      requestContext: {
        http: { method },
        authorizer: {
          jwt: {
            claims: {
              sub: OWNER,
              auth_time: String((NOW - 60000) / 1000),
            },
          },
        },
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    deps(),
  );
}
const command = (action: string, revision = 0, overrides: Record<string, unknown> = {}) => ({
  action,
  expectedRevision: revision,
  commandId: `${action}-${revision}`,
  language: 'es',
  documentHash,
  ...versions,
  ...overrides,
});
async function enroll() {
  const response = await request(
    'POST',
    '/privacy/consents',
    command('declare_adult', 0, {
      declareAdult: true,
      acceptTerms: true,
    }),
  );
  expect(response.statusCode).toBe(200);
  return response;
}

beforeEach(async () => {
  vi.stubEnv('ADULT_PRIVACY_MODE', 'enforce');
  ddb.reset();
  rows = new Map([[key(K.profile(OWNER)), profile() as unknown as Record<string, unknown>]]);
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(key(input.Key ?? {})) }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? []) {
      if (item.Put?.Item) rows.set(key(item.Put.Item), item.Put.Item);
      if (item.Delete?.Key) rows.delete(key(item.Delete.Key));
    }
    return {};
  });
  documentHash =
    JSON.parse((await request('GET', '/privacy/status')).body).documentHash ??
    'feature-not-implemented';
});
afterEach(() => vi.unstubAllEnvs());

describe('adult privacy through the authenticated router', () => {
  it('returns absent consent and the required versions without reading forest content', async () => {
    const response = await request('GET', '/privacy/status');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      revision: 0,
      adultDeclared: false,
      cloudConsent: 'absent',
      canUseCloud: false,
      versions,
    });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('does not infer adulthood or terms from an adult profile', async () => {
    const response = await request(
      'POST',
      '/privacy/consents',
      command('grant_cloud', 0, { accepted: true }),
    );
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'ADULT_DECLARATION_REQUIRED' },
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('records the declaration separately from cloud consent with server identity and time', async () => {
    const response = await enroll();
    expect(JSON.parse(response.body)).toMatchObject({
      revision: 1,
      adultDeclared: true,
      cloudConsent: 'absent',
      canUseCloud: false,
    });
    const written = [...rows.values()].filter((row) => row['sk'] !== 'PROFILE');
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written.every((row) => row['userId'] === OWNER && row['updatedAt'] === NOW)).toBe(true);
    expect(JSON.stringify(written)).not.toContain('privacy-test-secret-token');
    expect(
      written.every(
        (row) => !('authorization' in row) && !('idToken' in row) && !('accessToken' in row),
      ),
    ).toBe(true);
  });
  it('rejects unchecked adulthood and unchecked terms without any write', async () => {
    for (const overrides of [
      { declareAdult: false, acceptTerms: true },
      { declareAdult: true, acceptTerms: false },
    ]) {
      expect(
        (await request('POST', '/privacy/consents', command('declare_adult', 0, overrides)))
          .statusCode,
      ).toBe(400);
    }
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('rejects a body-selected owner and a substituted document version', async () => {
    for (const overrides of [
      { ownerSub: 'other', declareAdult: true, acceptTerms: true },
      { noticeVersion: 'forged', declareAdult: true, acceptTerms: true },
    ]) {
      expect(
        (await request('POST', '/privacy/consents', command('declare_adult', 0, overrides)))
          .statusCode,
      ).toBe(400);
    }
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('grants once, replays exactly, and rejects command id reuse with a different decision', async () => {
    await enroll();
    const payload = command('grant_cloud', 1, { accepted: true });
    const first = await request('POST', '/privacy/consents', payload);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      revision: 2,
      cloudConsent: 'granted',
      canUseCloud: true,
    });
    const count = ddb.commandCalls(TransactWriteCommand).length;
    expect((await request('POST', '/privacy/consents', payload)).statusCode).toBe(200);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(count);
    expect(
      (
        await request('POST', '/privacy/consents', {
          ...payload,
          action: 'revoke_cloud',
          accepted: undefined,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('denies minors and accounts already closing', async () => {
    rows.set(key(K.profile(OWNER)), profile('minor') as unknown as Record<string, unknown>);
    expect(
      (
        await request(
          'POST',
          '/privacy/consents',
          command('declare_adult', 0, { declareAdult: true, acceptTerms: true }),
        )
      ).statusCode,
    ).toBe(403);
    rows.set(key(K.profile(OWNER)), { ...profile(), status: 'closing' });
    expect(
      (
        await request(
          'POST',
          '/privacy/consents',
          command('declare_adult', 0, { declareAdult: true, acceptTerms: true }),
        )
      ).statusCode,
    ).toBe(409);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('rejects a stale revision after an explicit revocation', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    const revoked = await request('POST', '/privacy/consents', command('revoke_cloud', 2));
    expect(JSON.parse(revoked.body)).toMatchObject({
      revision: 3,
      cloudConsent: 'revoked',
      canUseCloud: false,
    });
    expect(
      (await request('POST', '/privacy/consents', command('grant_cloud', 2, { accepted: true })))
        .statusCode,
    ).toBe(409);
    expect(rows.has(key(K.profile(OWNER)))).toBe(true);
  });
  it('denies direct push and pull without consent before forest reads or writes', async () => {
    const ctx = { callerId: OWNER, caller: profile(), deps: deps() };
    await expect(getSyncChanges(ctx)).rejects.toMatchObject({ code: 'ADULT_DECLARATION_REQUIRED' });
    await expect(pushSync(ctx, { schemaVersion: 15, records: [] })).rejects.toMatchObject({
      code: 'ADULT_DECLARATION_REQUIRED',
    });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('does not deliver a self snapshot without current cloud consent', async () => {
    await expect(
      getForest({ callerId: OWNER, caller: profile(), deps: deps() }, OWNER),
    ).rejects.toMatchObject({ code: 'ADULT_DECLARATION_REQUIRED' });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('requires adult admission on social routes while privacy rights remain reachable', async () => {
    expect((await request('GET', '/friends')).statusCode).toBe(403);
    expect((await request('GET', '/privacy/export')).statusCode).toBe(200);
  });
  it('withdrawal during a pull prevents that response from delivering content', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    ddb.on(QueryCommand).callsFake(async () => {
      await request('POST', '/privacy/consents', command('revoke_cloud', 2));
      return { Items: [] };
    });
    await expect(
      getSyncChanges({ callerId: OWNER, caller: profile(), deps: deps() }),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });
  it('withdrawal during a forest snapshot prevents delivery', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    ddb.on(QueryCommand).callsFake(async () => {
      await request('POST', '/privacy/consents', command('revoke_cloud', 2));
      return { Items: [] };
    });
    await expect(
      getForest({ callerId: OWNER, caller: profile(), deps: deps() }, OWNER),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });
  it('an old grant replay after withdrawal reports the current revoked state', async () => {
    await enroll();
    const payload = command('grant_cloud', 1, { accepted: true });
    await request('POST', '/privacy/consents', payload);
    await request('POST', '/privacy/consents', command('revoke_cloud', 2));
    const response = await request('POST', '/privacy/consents', payload);
    expect(JSON.parse(response.body)).toMatchObject({
      revision: 3,
      cloudConsent: 'revoked',
      canUseCloud: false,
    });
  });
  it('refuses to overflow a canonical revision', async () => {
    await enroll();
    const stateKey = `${K.user(OWNER)}/PRIVACY#ADULT`;
    rows.set(stateKey, { ...rows.get(stateKey), revision: Number.MAX_SAFE_INTEGER });
    const count = ddb.commandCalls(TransactWriteCommand).length;
    expect(
      (await request('POST', '/privacy/consents', command('revoke_cloud', Number.MAX_SAFE_INTEGER)))
        .statusCode,
    ).toBe(409);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(count);
  });
  it('an export cursor cannot select another account', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ pk: 'USER#other', sk: 'REC#nodes#private' }),
    ).toString('base64url');
    const response = await handleEvent(
      {
        version: '2.0',
        rawPath: '/v1/privacy/export',
        requestContext: {
          http: { method: 'GET' },
          authorizer: { jwt: { claims: { sub: OWNER } } },
        },
        queryStringParameters: { cursor },
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
      deps(),
    );
    expect(response.statusCode).toBe(400);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('cancels the remote forest, preserves accounts, and writes an independent restore exclusion', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    const recordKey = K.rec(OWNER, 'checkins', 'private-checkin');
    rows.set(key(recordKey), {
      ...recordKey,
      owner: OWNER,
      store: 'checkins',
      rev: 1,
      record: { id: 'private-checkin', note: 'intimate-content', rev: 1, deletedAt: null },
    });
    rows.set('USER#other/REC#checkins#other', {
      pk: 'USER#other',
      sk: 'REC#checkins#other',
      note: 'other',
    });
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()].filter(
          (row) =>
            row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
            (input.ExpressionAttributeValues?.[':prefix'] === undefined ||
              String(row['sk']).startsWith(input.ExpressionAttributeValues[':prefix'])),
        ),
      }));
    const response = await request('POST', '/privacy/consents', command('erase_cloud', 2));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      erasure: 'completed',
      cloudConsent: 'revoked',
      canUseCloud: false,
    });
    expect(rows.has(key(recordKey))).toBe(false);
    expect(rows.has(key(K.profile(OWNER)))).toBe(true);
    expect(rows.has('USER#other/REC#checkins#other')).toBe(true);
    const exclusions = ddb
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? [])
      .filter(
        (item) =>
          item.Put?.TableName === 'privacy-retention-dev' &&
          item.Put.Item?.['pk'] === `RESTORE#${OWNER}`,
      );
    expect(exclusions.length).toBeGreaterThan(0);
    const exclusion = exclusions.at(-1)?.Put?.Item;
    expect(exclusion?.['ttl']).toBe(Math.ceil((NOW + 36 * 86400000) / 1000));
    expect(JSON.stringify(exclusions)).not.toContain('intimate-content');
  });
  it('does not resurrect withdrawn consent when the data table is restored to an old snapshot', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    const stateKey = `${K.user(OWNER)}/PRIVACY#ADULT`;
    const staleSnapshot = structuredClone(rows.get(stateKey)!);
    await request('POST', '/privacy/consents', command('revoke_cloud', 2));
    rows.set(stateKey, staleSnapshot);
    await expect(
      getSyncChanges({ callerId: OWNER, caller: profile(), deps: deps() }),
    ).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('blocks cancellation under a documented active forest hold', async () => {
    await enroll();
    rows.set(`HOLD#${OWNER}/CASE#verified-case`, {
      pk: `HOLD#${OWNER}`,
      sk: 'CASE#verified-case',
      userId: OWNER,
      scope: 'forest',
      legalBasis: 'verified court preservation obligation',
      caseId: 'verified-case',
      expiresAt: NOW + 86400000,
      reviewAt: NOW + 3600000,
      state: 'active',
    });
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()].filter(
          (row) => row['pk'] === input.ExpressionAttributeValues?.[':pk'],
        ),
      }));
    const response = await request('POST', '/privacy/consents', command('erase_cloud', 1));
    expect(JSON.parse(response.body)).toMatchObject({
      erasure: 'blocked',
      cloudConsent: 'revoked',
      canUseCloud: false,
    });
    expect(
      ddb
        .commandCalls(TransactWriteCommand)
        .flatMap((call) => call.args[0].input.TransactItems ?? [])
        .filter((item) => item.Delete),
    ).toHaveLength(0);
  });
  it('does not serve restored forest records from an erased consent epoch after a new grant', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    const erased = JSON.parse(
      (await request('POST', '/privacy/consents', command('erase_cloud', 2))).body,
    );
    expect(erased.erasure).toBe('completed');
    await request(
      'POST',
      '/privacy/consents',
      command('grant_cloud', erased.revision, { accepted: true }),
    );
    ddb
      .on(QueryCommand)
      .resolves({
        Items: [
          {
            ...K.rec(OWNER, 'checkins', 'restored'),
            gsi2pk: K.user(OWNER),
            gsi2sk: 'CHG#restored',
            owner: OWNER,
            store: 'checkins',
            record: { id: 'restored', note: 'erased-secret', rev: 1, deletedAt: null },
            privacyRevision: 2,
          },
        ],
      });
    await expect(
      getSyncChanges({ callerId: OWNER, caller: profile(), deps: deps() }),
    ).rejects.toMatchObject({ code: 'PRIVACY_ERASURE_PENDING' });
  });
  it('also clears old sync receipts and tree counters so a later authorized upload is not silently skipped', async () => {
    await enroll();
    rows.set(`${K.user(OWNER)}/MUTATION#old`, {
      pk: K.user(OWNER),
      sk: 'MUTATION#old',
      requestHash: 'old',
    });
    rows.set(`${K.user(OWNER)}/USAGE#TREE#old`, {
      pk: K.user(OWNER),
      sk: 'USAGE#TREE#old',
      generation: 'gen',
      visibleBranches: 4,
    });
    rows.set(`${K.user(OWNER)}/USAGE`, {
      pk: K.user(OWNER),
      sk: 'USAGE',
      state: 'active',
      activeGeneration: 'gen',
      activeTrees: 1,
    });
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()].filter(
          (row) =>
            row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
            (input.ExpressionAttributeValues?.[':prefix'] === undefined ||
              String(row['sk']).startsWith(input.ExpressionAttributeValues[':prefix'])),
        ),
      }));
    const response = await request('POST', '/privacy/consents', command('erase_cloud', 1));
    expect(JSON.parse(response.body).erasure).toBe('completed');
    expect(rows.has(`${K.user(OWNER)}/MUTATION#old`)).toBe(false);
    expect(rows.has(`${K.user(OWNER)}/USAGE#TREE#old`)).toBe(false);
    expect(rows.get(`${K.user(OWNER)}/USAGE`)).toMatchObject({
      activeTrees: 0,
      activeGeneration: 'gen',
    });
  });
  it.each([
    ['canonical empty account', 0, 0],
    ['canonical check-in account', 0, 1],
    ['legacy unversioned tree usage', 3, 3],
  ] as const)('completes erasure for %s without inventing a usage generation', async (_label, trees, recordCount) => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});
    rows.delete(key(K.profile(OWNER)));
    try {
      await handlePostConfirmation({
        triggerSource: 'PostConfirmation_ConfirmSignUp',
        userName: OWNER,
        userPoolId: 'pool',
        request: { userAttributes: { sub: OWNER, name: 'Local synthetic adult' } },
        response: {},
      } as unknown as Parameters<typeof handlePostConfirmation>[0], deps());
    } finally {
      cognito.restore();
    }
    const usageKey = { pk: K.user(OWNER), sk: 'USAGE' };
    expect(rows.get(key(usageKey))).toEqual({ ...usageKey, state: 'active', activeTrees: 0 });
    rows.set(key(usageKey), { ...rows.get(key(usageKey)), activeTrees: trees });
    const foreign = { ...K.rec('foreign', 'checkins', 'preserved'), owner: 'foreign' };
    rows.set(key(foreign), foreign);
    for (let index = 0; index < recordCount; index++) {
      const record = K.rec(OWNER, trees ? 'trees' : 'checkins', `canonical-${index}`);
      rows.set(key(record), { ...record, owner: OWNER, record: { id: `canonical-${index}` } });
    }
    ddb.on(QueryCommand).callsFake((input) => ({
      Items: [...rows.values()].filter((row) =>
        row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
        String(row['sk']).startsWith(input.ExpressionAttributeValues?.[':prefix'] ?? ''),
      ).slice(0, input.Limit),
    }));
    await enroll();
    const response = await request('POST', '/privacy/consents', command('erase_cloud', 1));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ cloudConsent: 'revoked', erasure: 'completed' });
    expect(rows.get(key(usageKey))).toEqual({ ...usageKey, state: 'active', activeTrees: 0 });
    expect(rows.get(key(K.profile(OWNER)))).toMatchObject({ userId: OWNER, status: 'active' });
    expect(rows.get(key(foreign))).toEqual(foreign);
    expect([...rows.values()].filter((row) => row['pk'] === K.user(OWNER) && String(row['sk']).startsWith('REC#'))).toHaveLength(0);
    const reset = ddb.commandCalls(TransactWriteCommand).flatMap((call) => call.args[0].input.TransactItems ?? [])
      .find((item) => item.Put?.Item?.sk === 'USAGE' && item.Put.ConditionExpression?.includes('activeTrees = :trees'))?.Put;
    expect(reset?.ConditionExpression).toContain('attribute_not_exists(activeGeneration)');
    expect(reset?.ExpressionAttributeValues).toMatchObject({ ':state': 'active', ':trees': trees });
    expect(reset?.ExpressionAttributeValues).not.toHaveProperty(':generation');
  });
  it.each([
    { activeGeneration: '' },
    { activeGeneration: null },
    { activeGeneration: 7 },
    { activeTrees: -1 },
    { state: 'migrating' },
  ])('does not complete erasure by weakening malformed usage %j', async (invalid) => {
    await enroll();
    const usageKey = { pk: K.user(OWNER), sk: 'USAGE' };
    const usage = { ...usageKey, state: 'active', activeTrees: 0, ...invalid };
    rows.set(key(usageKey), usage);
    const response = await request('POST', '/privacy/consents', command('erase_cloud', 1));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'USAGE_MIGRATION_IN_PROGRESS' } });
    expect(rows.get(key(usageKey))).toEqual(usage);
    expect(rows.get(`${K.user(OWNER)}/PRIVACY#ADULT`)?.['erasure']).toBe('requested');
    expect(rows.get(`RESTORE#${OWNER}/STATE`)).not.toHaveProperty('completedAt');
    expect(ddb.commandCalls(TransactWriteCommand).flatMap((call) => call.args[0].input.TransactItems ?? [])
      .some((item) => item.Put?.Item?.sk === 'USAGE')).toBe(false);
  });
  it('keeps an enrolled withdrawal effective during the compatible deployment mode', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    await request('POST', '/privacy/consents', command('revoke_cloud', 2));
    vi.stubEnv('ADULT_PRIVACY_MODE', 'off');
    await expect(
      getSyncChanges({ callerId: OWNER, caller: profile(), deps: deps() }),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });
  it('reads a stable decision when revocation commits between the state and independent ledger reads', async () => {
    await enroll();
    await request('POST', '/privacy/consents', command('grant_cloud', 1, { accepted: true }));
    const stateKey = `${K.user(OWNER)}/PRIVACY#ADULT`;
    const stale = structuredClone(rows.get(stateKey)!);
    await request('POST', '/privacy/consents', command('revoke_cloud', 2));
    let first = true;
    ddb.on(GetCommand).callsFake((input) => {
      if (key(input.Key ?? {}) === stateKey && first) {
        first = false;
        return { Item: stale };
      }
      return { Item: rows.get(key(input.Key ?? {})) };
    });
    const response = await request('GET', '/privacy/status');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ revision: 3, cloudConsent: 'revoked' });
  });
  it('continues a large cancellation in bounded pages without depending on a live client', async () => {
    await enroll();
    for (let i = 0; i < 43; i++) {
      const rec = K.rec(OWNER, 'nodes', `node-${i}`);
      rows.set(key(rec), { ...rec, owner: OWNER, store: 'nodes', record: { id: `node-${i}` } });
    }
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()]
          .filter(
            (row) =>
              row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
              String(row['sk']).startsWith(input.ExpressionAttributeValues?.[':prefix'] ?? ''),
          )
          .slice(0, input.Limit),
      }));
    const started = JSON.parse(
      (await request('POST', '/privacy/consents', command('erase_cloud', 1))).body,
    );
    expect(started.erasure).toBe('purging');
    expect((await processCloudErasurePage(deps(), OWNER))?.erasure).toBe('purging');
    expect((await processCloudErasurePage(deps(), OWNER))?.erasure).toBe('completed');
    expect(
      [...rows.values()].filter(
        (row) => row['pk'] === K.user(OWNER) && String(row['sk']).startsWith('REC#'),
      ),
    ).toHaveLength(0);
    expect(
      ddb
        .commandCalls(TransactWriteCommand)
        .every(
          (call) =>
            (call.args[0].input.TransactItems?.filter((item) => item.Delete).length ?? 0) <= 20,
        ),
    ).toBe(true);
  });
  it('does not delete while a usage backfill lease is active and resumes after it ends', async () => {
    await enroll();
    const rec = K.rec(OWNER, 'nodes', 'retained');
    rows.set(key(rec), { ...rec, owner: OWNER, store: 'nodes', record: { id: 'retained' } });
    const migration = {
      pk: K.user(OWNER),
      sk: 'USAGE_MIGRATION',
      state: 'migrating',
      generation: 'backfill',
      leaseUntil: NOW + 60000,
    };
    rows.set(key(migration), migration);
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()]
          .filter(
            (row) =>
              row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
              String(row['sk']).startsWith(input.ExpressionAttributeValues?.[':prefix'] ?? ''),
          )
          .slice(0, input.Limit),
      }));
    expect((await request('POST', '/privacy/consents', command('erase_cloud', 1))).statusCode).toBe(
      409,
    );
    expect(rows.has(key(rec))).toBe(true);
    rows.set(key(migration), { ...migration, state: 'completed' });
    expect((await processCloudErasurePage(deps(), OWNER))?.erasure).toBe('completed');
    expect(rows.has(key(rec))).toBe(false);
  });
  it('retries safely after a failed purge transaction without reporting completion or losing evidence', async () => {
    await enroll();
    const rec = K.rec(OWNER, 'nodes', 'retry');
    rows.set(key(rec), { ...rec, owner: OWNER, store: 'nodes', record: { id: 'retry' } });
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items: [...rows.values()]
          .filter(
            (row) =>
              row['pk'] === input.ExpressionAttributeValues?.[':pk'] &&
              String(row['sk']).startsWith(input.ExpressionAttributeValues?.[':prefix'] ?? ''),
          )
          .slice(0, input.Limit),
      }));
    let crashed = false;
    ddb.on(TransactWriteCommand).callsFake((input) => {
      if (
        !crashed &&
        input.TransactItems?.some(
          (item: NonNullable<TransactWriteCommandInput['TransactItems']>[number]) => item.Delete,
        )
      ) {
        crashed = true;
        throw new Error('simulated outage');
      }
      for (const item of input.TransactItems ?? []) {
        if (item.Put?.Item) rows.set(key(item.Put.Item), item.Put.Item);
        if (item.Delete?.Key) rows.delete(key(item.Delete.Key));
      }
      return {};
    });
    expect((await request('POST', '/privacy/consents', command('erase_cloud', 1))).statusCode).toBe(
      500,
    );
    expect(rows.has(key(rec))).toBe(true);
    expect(rows.get(`${K.user(OWNER)}/PRIVACY#ADULT`)?.['erasure']).toBe('requested');
    expect((await processCloudErasurePage(deps(), OWNER))?.erasure).toBe('completed');
    expect(rows.has(`${K.user(OWNER)}/PRIVACY#COMMAND#erase_cloud-1`)).toBe(true);
  });
  it('does not expose a closed account restored into the main table to an old valid token', async () => {
    rows.set(`RESTORE#${OWNER}/STATE`, {
      pk: `RESTORE#${OWNER}`,
      sk: 'STATE',
      userId: OWNER,
      scope: 'account',
      revision: 1,
      holdRevision: 0,
      cutoffRevision: 0,
      erasureId: 'closure',
      updatedAt: NOW,
    });
    expect((await request('GET', '/me')).statusCode).toBe(401);
    expect((await request('GET', '/privacy/export')).statusCode).toBe(401);
  });
});
