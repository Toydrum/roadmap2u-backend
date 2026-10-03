import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { PREPAYMENT_CATALOG } from '../lambda/commercial/catalog';
import type { AccessItem, GrantItem } from '../lambda/commercial/model';
import type { ProfileItem } from '../lambda/db';
import {
  createAccessReader,
  createDynamoAccessReaderDeps,
  createDynamoAccessResolver,
  accessSummary,
  type AccessReaderEvent,
  type OwnerCommercialSnapshot,
} from '../lambda/access-reader';
import { createCatalogHandler, createDynamoCatalogHandler } from '../lambda/catalog';
import { COMMERCIAL_FLAGS_ATTRIBUTES, FAMILY_BILLING_FLAG_DEFAULTS, type CommercialConfigResult } from '../lambda/commercial/flags';
import { createCoverageAssignment } from '../lambda/family/model';

const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = Date.UTC(2026, 7, 19, 18, 0, 0);
const OWNER = 'adult-1';

function profile(overrides: Record<string, unknown> = {}): ProfileItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'PROFILE',
    userId: OWNER,
    username: 'adult_1',
    displayName: 'Adult',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 1_000,
    status: 'active',
    ...overrides,
  } as ProfileItem;
}

function access(overrides: Partial<AccessItem> = {}): AccessItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'ACCESS',
    ownerSub: OWNER,
    effectivePlanKey: 'free',
    catalogVersion: PREPAYMENT_CATALOG.version,
    status: 'active',
    activeSources: [
      { kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null },
    ],
    limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
    capabilities: { cloudSync: false, social: false, family: false },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: NOW + 60_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function grant(overrides: Partial<GrantItem> = {}): GrantItem {
  return {
    pk: `USER#${OWNER}`,
    sk: 'GRANT#demo-1',
    ownerSub: OWNER,
    grantId: 'demo-1',
    sourceKind: 'sponsored',
    status: 'active',
    catalogVersion: PREPAYMENT_CATALOG.version,
    planKey: 'premium',
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    startsAt: NOW,
    expiresAt: null,
    revision: 1,
    reason: 'demo access',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function event(sub: unknown = OWNER): AccessReaderEvent {
  return {
    rawPath: '/v1/access',
    requestContext: {
      requestId: 'request-1',
      http: { method: 'GET' },
      authorizer: { jwt: { claims: { sub } } },
    },
    queryStringParameters: { ownerSub: 'attacker-selected-owner' },
    body: JSON.stringify({ ownerSub: 'attacker-selected-owner' }),
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

describe('GET /v1/plans catalog Lambda', () => {
  beforeEach(() => ddbMock.reset());
  const rawFlags = {
    pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', ...FAMILY_BILLING_FLAG_DEFAULTS,
    revision: 1, quotaMode: 'off', capabilityMode: 'off', accessCodeIssuanceEnabled: false,
    accessCodeRedemptionEnabled: false, premiumPaymentsEnabled: false, updatedAt: NOW,
    updatedBy: 'operator', reason: 'public catalog rollout',
  };

  it.each([false, true])('chooses only the server-configured catalog when familyCatalogEnabled=%s', async (enabled) => {
    ddbMock.on(GetCommand).resolves({ Item: { ...rawFlags, familyCatalogEnabled: enabled } });
    const catalog = createDynamoCatalogHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'roadmap-dev', now: () => NOW });
    const response = await catalog({ body: JSON.stringify({ familyCatalogEnabled: !enabled }), queryStringParameters: { tableName: 'attacker', sk: 'PROFILE' } });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=30');
    if (enabled) expect(body).toEqual(PREPAYMENT_CATALOG);
    else {
      expect(body).toEqual({ version: '2026-08-prepayment-v1', pricingVersion: 'launch-2026',
        currency: 'MXN', taxInclusive: true, paymentsEnabled: false, plans: PREPAYMENT_CATALOG.plans });
      expect(body).not.toHaveProperty('offers');
    }
    expect(body.paymentsEnabled).toBe(false);
    expect(response.body).not.toMatch(/priceId|providerId|updatedBy|reason/);
    const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ TableName: 'roadmap-dev', Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }, ConsistentRead: true });
    expect(Object.values(input.ExpressionAttributeNames!)).toEqual([...COMMERCIAL_FLAGS_ATTRIBUTES]);
    expect(input.ProjectionExpression!.split(', ')).toHaveLength(COMMERCIAL_FLAGS_ATTRIBUTES.length);
    await catalog();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it.each([undefined, null, { ...rawFlags, familyCatalogEnabled: 'yes' }])('keeps legacy offers on missing or malformed config %j', async (Item) => {
    ddbMock.on(GetCommand).callsFake(() => ({ Item }));
    const catalog = createDynamoCatalogHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'roadmap-dev', now: () => NOW });
    const response = await catalog();
    expect(JSON.parse(response.body)).not.toHaveProperty('offers');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('falls back to legacy when a previously enabled configuration becomes stale', async () => {
    let now = NOW;
    ddbMock.on(GetCommand).resolvesOnce({ Item: { ...rawFlags, familyCatalogEnabled: true } }).rejects(new Error('read unavailable'));
    const catalog = createDynamoCatalogHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'roadmap-dev', now: () => now });
    expect(JSON.parse((await catalog()).body).offers).toHaveLength(5);
    now += 30_000;
    const fallback = await catalog();
    expect(JSON.parse(fallback.body)).not.toHaveProperty('offers');
    expect(fallback.headers['cache-control']).toBe('no-store');
  });

  it('uses the legacy catalog when flags are explicitly unavailable', async () => {
    const response = await createCatalogHandler({ resolveFlags: async (): Promise<CommercialConfigResult> => ({ status: 'unavailable', reason: 'read-failed' }) })();
    expect(JSON.parse(response.body)).not.toHaveProperty('offers');
  });

  it('has no identity, secret or payment dependency', () => {
    const source = readFileSync(new URL('../lambda/catalog.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/SSM|Secrets|Cognito|authorizer|jwt/i);
    expect(source).not.toMatch(/Stripe|checkout|portal|webhook|priceId/i);
  });
});

describe('GET /v1/access handler boundary', () => {
  function harness(snapshots: OwnerCommercialSnapshot[]) {
    const readOwnerSnapshot = vi.fn(async () => snapshots.shift() ?? snapshots[0]);
    const resolveAccess = vi.fn(async () => access());
    return {
      handler: createAccessReader({ readOwnerSnapshot, resolveAccess }),
      readOwnerSnapshot,
      resolveAccess,
    };
  }

  beforeEach(() => ddbMock.reset());

  it.each([undefined, '', 42])(
    'rejects an untrusted JWT sub %j before touching storage',
    async (sub) => {
      const h = harness([{ profile: profile(), usage: { activeTrees: 0, visibleBranchesByTree: {} } }]);
      const request = event(sub);
      if (sub === undefined) {
        delete (request.requestContext as { authorizer?: unknown }).authorizer;
      }

      const response = await h.handler(request);

      expect(response.statusCode).toBe(401);
      expect(json(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' },
      });
      expect(h.readOwnerSnapshot).not.toHaveBeenCalled();
      expect(h.resolveAccess).not.toHaveBeenCalled();
    },
  );

  it('uses only the trusted authorizer sub and strips every internal ACCESS field', async () => {
    const entitlement = access({
      effectivePlanKey: 'premium',
      activeSources: [
        {
          kind: 'sponsored',
          sourceId: 'demo-1',
          planKey: 'premium',
          validUntil: null,
          pk: 'must-not-leak',
          sk: 'must-not-leak',
          ownerSub: 'must-not-leak',
          updatedAt: NOW,
        } as never,
      ],
      limits: {
        maxActiveTrees: null,
        maxVisibleBranchesPerTree: null,
        pk: 'must-not-leak',
      } as never,
      capabilities: {
        cloudSync: true,
        social: true,
        family: false,
        updatedAt: NOW,
      } as never,
      revision: 8,
    });
    const snapshots: OwnerCommercialSnapshot[] = [
      { profile: profile(), usage: { activeTrees: 0, visibleBranchesByTree: {} } },
      { profile: profile(), usage: { activeTrees: 2, visibleBranchesByTree: {} } },
    ];
    const readOwnerSnapshot = vi.fn(async () => snapshots.shift()!);
    const resolveAccess = vi.fn(async () => entitlement);
    const handler = createAccessReader({ readOwnerSnapshot, resolveAccess });

    const response = await handler(event());

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    expect(readOwnerSnapshot).toHaveBeenNthCalledWith(1, OWNER);
    expect(readOwnerSnapshot).toHaveBeenNthCalledWith(2, OWNER);
    expect(resolveAccess).toHaveBeenCalledWith(OWNER);
    expect(json(response)).toEqual({
      effectivePlanKey: 'premium',
      catalogVersion: PREPAYMENT_CATALOG.version,
      status: 'active',
      activeSources: [
        { kind: 'sponsored', sourceId: 'demo-1', planKey: 'premium', validUntil: null },
      ],
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
      usage: { activeTrees: 2, visibleBranchesByTree: {} },
      revision: 8,
      nextRecomputeAt: null,
      offlineValidUntil: NOW + 60_000,
    });
    expect(response.body).not.toMatch(/USER#|ownerSub|updatedAt|attacker-selected-owner/);
    expect(response.body).not.toMatch(/"pk"|"sk"|must-not-leak/);
  });

  it.each([
    ['missing profile', { usage: { activeTrees: 0, visibleBranchesByTree: {} } }, 401],
    [
      'closing profile',
      { profile: profile({ status: 'closing' }), usage: { activeTrees: 0, visibleBranchesByTree: {} } },
      409,
    ],
    [
      'unknown profile state',
      { profile: profile({ status: 'broken' }), usage: { activeTrees: 0, visibleBranchesByTree: {} } },
      409,
    ],
    [
      'closure tombstone',
      {
        profile: profile(),
        closure: { pk: `ACCOUNT_CLOSURE#${OWNER}`, sk: 'STATE' },
        usage: { activeTrees: 0, visibleBranchesByTree: {} },
      },
      409,
    ],
  ] as const)('fails closed for a %s before resolving access', async (_label, snapshot, status) => {
    const h = harness([snapshot as OwnerCommercialSnapshot]);

    const response = await h.handler(event());

    expect(response.statusCode).toBe(status);
    expect(h.resolveAccess).not.toHaveBeenCalled();
  });

  it('checks lifecycle again after entitlement resolution and never leaks a raced result', async () => {
    const h = harness([
      { profile: profile(), usage: { activeTrees: 0, visibleBranchesByTree: {} } },
      {
        profile: profile({ status: 'closing' }),
        closure: { pk: `ACCOUNT_CLOSURE#${OWNER}`, sk: 'STATE' },
        usage: { activeTrees: 0, visibleBranchesByTree: {} },
      },
    ]);

    const response = await h.handler(event());

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('effectivePlanKey');
    expect(h.resolveAccess).toHaveBeenCalledTimes(1);
    expect(h.readOwnerSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('Dynamo commercial reader adapters', () => {
  beforeEach(() => ddbMock.reset());

  it('reads PROFILE, closure and base USAGE in one serializable transaction', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    ddbMock.on(TransactGetCommand).resolves({
      Responses: [
        { Item: profile() },
        {},
        { Item: { pk: `USER#${OWNER}`, sk: 'USAGE', state: 'active', activeTrees: 2 } },
      ],
    });
    const deps = createDynamoAccessReaderDeps({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(deps.readOwnerSnapshot(OWNER)).resolves.toEqual({
      profile: profile(),
      usage: { activeTrees: 2, visibleBranchesByTree: {} },
    });
    const input = ddbMock.commandCalls(TransactGetCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      TransactItems: [
        { Get: { TableName: 'roadmap-dev', Key: { pk: `USER#${OWNER}`, sk: 'PROFILE' } } },
        {
          Get: {
            TableName: 'roadmap-dev',
            Key: { pk: `ACCOUNT_CLOSURE#${OWNER}`, sk: 'STATE' },
          },
        },
        { Get: { TableName: 'roadmap-dev', Key: { pk: `USER#${OWNER}`, sk: 'USAGE' } } },
      ],
    });
    expect(JSON.stringify(input)).not.toContain('ConsistentRead');
    for (const item of input?.TransactItems ?? []) {
      expect(item.Get?.ProjectionExpression).toBeTypeOf('string');
      expect(item.Get?.ExpressionAttributeNames).toBeTypeOf('object');
    }
    expect(JSON.stringify(input)).not.toMatch(
      /title|note|email|displayName|username|record/i,
    );
  });

  it.each([
    ['missing', undefined],
    ['wrong owner', { pk: 'USER#other', sk: 'USAGE', state: 'active', activeTrees: 9 }],
    ['not active', { pk: `USER#${OWNER}`, sk: 'USAGE', state: 'migrating', activeTrees: 9 }],
    ['negative count', { pk: `USER#${OWNER}`, sk: 'USAGE', state: 'active', activeTrees: -1 }],
    ['fractional count', { pk: `USER#${OWNER}`, sk: 'USAGE', state: 'active', activeTrees: 1.5 }],
  ])('maps a %s base USAGE item to the compatible zero seam', async (_label, usageItem) => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    ddbMock.on(TransactGetCommand).resolves({
      Responses: [{ Item: profile() }, {}, ...(usageItem === undefined ? [{}] : [{ Item: usageItem }])],
    });
    const deps = createDynamoAccessReaderDeps({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(deps.readOwnerSnapshot(OWNER)).resolves.toMatchObject({
      usage: { activeTrees: 0, visibleBranchesByTree: {} },
    });
  });

  it('reads both paid sources and preserves their trace in the public summary', async () => {
    const coverage = createCoverageAssignment({ householdId: 'household-a', accountId: OWNER, seatType: 'primary_responsible', paidThrough: NOW + 60_000, now: NOW - 1_000 });
    const subscription = {
      pk: `USER#${OWNER}`, sk: 'SUBSCRIPTION#INDIVIDUAL', entityType: 'SubscriptionSource',
      ownerSub: OWNER, sourceId: 'sub-a', state: 'active', paidThrough: NOW + 90_000,
      graceUntil: null, revision: 1, updatedAt: NOW - 1_000,
    };
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: [coverage, subscription].find((row) => row.pk === input.Key.pk && row.sk === input.Key.sk) }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    const resolver = createDynamoAccessResolver({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'roadmap-dev', now: () => NOW });
    const result = await resolver.resolveFresh(OWNER);
    expect(result.access.capabilities.family).toBe(true);
    expect(result.access.activeSources).toHaveLength(2);
    expect(accessSummary(result.access, { activeTrees: 0, visibleBranchesByTree: {} }).activeSources).toEqual(result.access.activeSources);
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    for (const row of [coverage, subscription]) {
      expect(transaction).toContainEqual({ ConditionCheck: expect.objectContaining({
        Key: { pk: row.pk, sk: row.sk },
        ExpressionAttributeValues: expect.objectContaining({ ':revision': 1, ':state': 'active', ':paidThrough': row.paidThrough }),
      }) });
    }
    for (const { args } of ddbMock.commandCalls(GetCommand)) {
      expect(args[0].input.ConsistentRead).toBe(true);
      expect(args[0].input.ProjectionExpression).toBeTypeOf('string');
    }
  });

  it('re-derives access if coverage ends between its read and materialization', async () => {
    const initial = createCoverageAssignment({ householdId: 'household-a', accountId: OWNER, seatType: 'minor', paidThrough: NOW + 60_000, now: NOW - 1_000 });
    let current = initial;
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'COVERAGE#FAMILY' ? current : undefined }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactGetCommand).resolves({ Responses: [{ Item: profile() }, {}, {}] });
    let attempts = 0;
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      if (++attempts === 1) {
        current = { ...initial, state: 'ended', revision: 2 };
        throw Object.assign(new Error('coverage changed'), { name: 'TransactionCanceledException' });
      }
      return {};
    });
    const resolver = createDynamoAccessResolver({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'roadmap-dev', now: () => NOW });
    const result = await resolver.resolveFresh(OWNER);
    expect(attempts).toBe(2);
    expect(result.access.effectivePlanKey).toBe('free');
    const first = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(first.some((item) => item.ConditionCheck?.Key?.sk === 'COVERAGE#FAMILY')).toBe(true);
    expect(ddbMock.commandCalls(TransactWriteCommand).every(({ args }) => args[0].input.TransactItems?.every((item) => !item.Delete))).toBe(true);
  });

  it('paginates a strong GRANT query and retries the whole snapshot when ACCESS changes', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const first = access({ revision: 1 });
    const winnerGrant = grant();
    const winner = access({
      revision: 2,
      effectivePlanKey: 'premium',
      activeSources: [
        { kind: 'sponsored', sourceId: 'demo-1', planKey: 'premium', validUntil: null },
      ],
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
    });
    const accessReads = [first, winner, winner, winner];
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'ACCESS' ? accessReads.shift() : undefined }));
    let queryCall = 0;
    ddbMock.on(QueryCommand).callsFake((input) => {
      queryCall += 1;
      if (queryCall === 1) {
        return { Items: [], LastEvaluatedKey: { pk: `USER#${OWNER}`, sk: 'GRANT#page' } };
      }
      if (queryCall === 2) return { Items: [] };
      return { Items: [winnerGrant] };
    });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).resolves.toEqual({
      access: winner,
      materialization: 'not-required',
    });
    expect(ddbMock.commandCalls(GetCommand).filter(({ args }) => args[0].input.Key?.sk === 'ACCESS')).toHaveLength(4);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(3);
    for (const call of ddbMock.commandCalls(GetCommand)) {
      expect(call.args[0].input.ConsistentRead).toBe(true);
      expect(call.args[0].input.ProjectionExpression).toBeTypeOf('string');
      expect(JSON.stringify(call.args[0].input)).not.toMatch(
        /title|note|email|displayName|username|record/i,
      );
    }
    for (const call of ddbMock.commandCalls(QueryCommand)) {
      expect(call.args[0].input).toMatchObject({
        ConsistentRead: true,
        Select: 'SPECIFIC_ATTRIBUTES',
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `USER#${OWNER}`, ':prefix': 'GRANT#' },
      });
      expect(call.args[0].input.ProjectionExpression).toBeTypeOf('string');
      expect(JSON.stringify(call.args[0].input)).not.toMatch(
        /title|note|email|displayName|username|record/i,
      );
    }
    expect(ddbMock.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({
      pk: `USER#${OWNER}`,
      sk: 'GRANT#page',
    });
  });

  it('materializes ACCESS with the owner profile, closure absence and CAS in one transaction', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).resolves.toMatchObject({
      materialization: 'created',
      access: { ownerSub: OWNER, effectivePlanKey: 'free', revision: 1 },
    });
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transaction?.TransactItems).toEqual([
      {
        ConditionCheck: expect.objectContaining({
          TableName: 'roadmap-dev',
          Key: { pk: `USER#${OWNER}`, sk: 'PROFILE' },
          ConditionExpression:
            'attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active) AND userId = :ownerSub',
          ExpressionAttributeValues: { ':active': 'active', ':ownerSub': OWNER },
        }),
      },
      {
        ConditionCheck: {
          TableName: 'roadmap-dev',
          Key: { pk: `ACCOUNT_CLOSURE#${OWNER}`, sk: 'STATE' },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: expect.objectContaining({
          TableName: 'roadmap-dev',
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          Item: expect.objectContaining({ ownerSub: OWNER, sk: 'ACCESS' }),
        }),
      },
      ...['SUBSCRIPTION#INDIVIDUAL', 'COVERAGE#FAMILY'].map((sk) => ({ ConditionCheck: {
        TableName: 'roadmap-dev', Key: { pk: `USER#${OWNER}`, sk },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      } })),
    ]);
  });

  it('fails with ACCESS_REVISION_CONFLICT after three unstable fenced snapshots without writing', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const unstableReads = [
      access({ revision: 1 }),
      access({ revision: 2 }),
      access({ revision: 2 }),
      access({ revision: 3 }),
      access({ revision: 3 }),
      access({ revision: 4 }),
    ];
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'ACCESS' ? unstableReads.shift() : undefined }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'ACCESS_REVISION_CONFLICT',
    });
    expect(ddbMock.commandCalls(GetCommand).filter(({ args }) => args[0].input.Key?.sk === 'ACCESS')).toHaveLength(6);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(3);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('returns CONFLICT when the lifecycle guard wins a materialization race', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('lifecycle won'), { name: 'TransactionCanceledException' }),
    );
    ddbMock.on(TransactGetCommand).resolves({
      Responses: [
        { Item: profile({ status: 'closing' }) },
        { Item: { pk: `ACCOUNT_CLOSURE#${OWNER}`, sk: 'STATE' } },
        {},
      ],
    });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'CONFLICT',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactGetCommand)).toHaveLength(1);
  });

  it('retries the ACCESS CAS when a canceled materialization finds lifecycle still healthy', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const winner = access({ revision: 1 });
    const accessReads: Array<AccessItem | undefined> = [undefined, undefined, winner, winner];
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'ACCESS' ? accessReads.shift() : undefined }));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(Object.assign(new Error('CAS lost'), { name: 'TransactionCanceledException' }));
    ddbMock.on(TransactGetCommand).resolves({
      Responses: [{ Item: profile() }, {}, {}],
    });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).resolves.toEqual({
      access: winner,
      materialization: 'not-required',
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactGetCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('does not impose a 100-item business cap on historical grants', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const historical = Array.from({ length: 101 }, (_, index) =>
      grant({
        sk: `GRANT#expired-${index}`,
        grantId: `expired-${index}`,
        startsAt: NOW - 2_000,
        expiresAt: NOW - 1_000,
        createdAt: NOW - 2_000,
        updatedAt: NOW - 1_000,
      }),
    );
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'ACCESS' ? access() : undefined }));
    ddbMock.on(QueryCommand).resolves({ Items: historical });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).resolves.toMatchObject({
      materialization: 'not-required',
      access: { effectivePlanKey: 'free' },
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('fails operationally instead of following an unbounded grant-page stream', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    let page = 0;
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: input.Key.sk === 'ACCESS' ? access() : undefined }));
    ddbMock.on(QueryCommand).callsFake(() => {
      page += 1;
      return {
        Items: [],
        LastEvaluatedKey: { pk: `USER#${OWNER}`, sk: `GRANT#page-${page}` },
      };
    });
    const resolver = createDynamoAccessResolver({
      ddb,
      tableName: 'roadmap-dev',
      now: () => NOW,
    });

    await expect(resolver.resolveFresh(OWNER)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(64);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
