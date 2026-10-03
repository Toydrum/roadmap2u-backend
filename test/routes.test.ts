import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_PATHS } from '@app/api/contracts';
import { ROUTES, authTimeMillisFromClaims, handleEvent, matchRoute } from '../lambda/router';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { familyV2Fixture } from './support/family-v2-fixture';
import { installFamilyV2Reads } from './support/family-v2-reads';

/**
 * Contract parity: every path the client transport can emit (http-api.ts,
 * via API_PATHS) must land on exactly one route with the same method.
 */
const CLIENT_CALLS: { method: string; path: string }[] = [
  { method: 'GET', path: API_PATHS.me },
  { method: 'PATCH', path: API_PATHS.me },
  { method: 'POST', path: API_PATHS.familyChildren },
  { method: 'POST', path: API_PATHS.familyChildResetPassword('u1') },
  { method: 'PATCH', path: API_PATHS.familyChild('u1') },
  { method: 'GET', path: API_PATHS.familyChildExport('u1') },
  { method: 'DELETE', path: API_PATHS.familyChild('u1') },
  { method: 'DELETE', path: API_PATHS.familyLink('g~m') },
  { method: 'POST', path: API_PATHS.familyInvites },
  { method: 'POST', path: API_PATHS.familyInvitesAccept },
  { method: 'DELETE', path: API_PATHS.familyInvite('C0DEC0DE') },
  { method: 'GET', path: API_PATHS.familyChildFriends('u1') },
  { method: 'DELETE', path: API_PATHS.familyChildFriend('u1', 'f1') },
  { method: 'DELETE', path: API_PATHS.familyChildRequest('u1', 'r1') },
  { method: 'GET', path: API_PATHS.familyHousehold },
  { method: 'GET', path: API_PATHS.familyInbox },
  { method: 'POST', path: API_PATHS.familyMinors },
  { method: 'POST', path: API_PATHS.familyMinorLinkCodes },
  { method: 'POST', path: API_PATHS.familyMinorLinkRequests },
  { method: 'POST', path: API_PATHS.familyMinorLinkRequestApprove('r1') },
  { method: 'POST', path: API_PATHS.familyMinorLinkRequestAccept('r1') },
  { method: 'POST', path: API_PATHS.familyAdditionalResponsibleInvitations },
  { method: 'POST', path: API_PATHS.familyAdditionalResponsibleInvitationAccept('i1') },
  { method: 'PUT', path: API_PATHS.familyAdditionalResponsibleScope },
  { method: 'DELETE', path: API_PATHS.familyAdditionalResponsible },
  { method: 'POST', path: API_PATHS.familyTransferPrimaryResponsibility },
  { method: 'GET', path: API_PATHS.friends },
  { method: 'GET', path: API_PATHS.friendCode },
  { method: 'POST', path: API_PATHS.friendCodeRotate },
  { method: 'POST', path: API_PATHS.friendRequests },
  { method: 'POST', path: API_PATHS.friendRequestAccept('r1') },
  { method: 'POST', path: API_PATHS.friendRequestDecline('r1') },
  { method: 'DELETE', path: API_PATHS.friendRequest('r1') },
  { method: 'DELETE', path: API_PATHS.friend('a~b') },
  { method: 'POST', path: API_PATHS.socialAdultFriendRequests },
  { method: 'POST', path: API_PATHS.socialAdultFriendRequestAccept('r1') },
  { method: 'DELETE', path: API_PATHS.socialFriendship('a~b') },
  { method: 'POST', path: API_PATHS.socialMinorInviteCodes },
  { method: 'POST', path: API_PATHS.socialMinorFriendRequests },
  { method: 'GET', path: API_PATHS.socialMinorFriendRequestsFor('m1') },
  { method: 'POST', path: API_PATHS.socialMinorFriendRequestAccept('r1') },
  { method: 'POST', path: API_PATHS.socialMinorFriendRequestResponsibleApprove('r1') },
  { method: 'POST', path: API_PATHS.socialMinorFriendRequestReject('r1') },
  { method: 'DELETE', path: API_PATHS.socialMinorFriendship('a~b') },
  { method: 'GET', path: API_PATHS.userForest('u1') },
  { method: 'GET', path: API_PATHS.syncChanges },
  { method: 'POST', path: API_PATHS.syncPush },
  { method: 'POST', path: API_PATHS.userSyncPush('u1') },
];

describe('router ↔ API_PATHS parity', () => {
  it('normalizes Cognito auth_time seconds for reinforced family actions', () => {
    expect(authTimeMillisFromClaims({ auth_time: 1_800_000_000 })).toBe(1_800_000_000_000);
    expect(authTimeMillisFromClaims({ auth_time: '1800000000' })).toBe(1_800_000_000_000);
    expect(authTimeMillisFromClaims({ auth_time: 'not-a-number' })).toBeUndefined();
    expect(authTimeMillisFromClaims({})).toBeUndefined();
  });

  it('answers an unauthenticated CORS preflight before resolving the caller', async () => {
    const event: APIGatewayProxyEventV2 = {
      version: '2.0',
      routeKey: 'OPTIONS /v1/{proxy+}',
      rawPath: '/v1/me',
      rawQueryString: '',
      headers: {},
      requestContext: {
        accountId: '123456789012',
        apiId: 'api-id',
        domainName: 'api.dev.roadmap2u.com',
        domainPrefix: 'api.dev',
        http: {
          method: 'OPTIONS',
          path: '/v1/me',
          protocol: 'HTTP/1.1',
          sourceIp: '127.0.0.1',
          userAgent: 'vitest',
        },
        requestId: 'request-id',
        routeKey: 'OPTIONS /v1/{proxy+}',
        stage: '$default',
        time: '21/Jul/2026:15:00:00 +0000',
        timeEpoch: 0,
      },
      isBase64Encoded: false,
    };

    const response = await handleEvent(event, {} as never);

    expect(response).toEqual({ statusCode: 204, headers: {}, body: '' });
  });

  it('covers every client call', () => {
    for (const call of CLIENT_CALLS) {
      const found = matchRoute(call.method, call.path);
      expect(found, `${call.method} ${call.path}`).not.toBeNull();
      const matches = ROUTES.filter((route) =>
        route.method === call.method &&
        new RegExp(`^${route.pattern.replace(/:[^/]+/g, '[^/]+')}$`).test(call.path),
      );
      expect(matches, `${call.method} ${call.path}`).toHaveLength(1);
    }
  });

  it('has no orphan routes the client never calls', () => {
    expect(ROUTES.length).toBe(CLIENT_CALLS.length);
  });

  it('extracts params and rejects unknown paths', () => {
    const hit = matchRoute('POST', '/family/children/abc-123/reset-password');
    expect(hit?.params['id']).toBe('abc-123');
    expect(matchRoute('GET', '/nope')).toBeNull();
    expect(matchRoute('DELETE', '/me')).toBeNull(); // right path, wrong method
  });
});

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
}

function profile(userId: string, overrides: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(userId), userId, username: userId, displayName: userId,
    accountType: 'adult', socialEnabled: true, status: 'active', createdAt: NOW - 10_000,
    ...overrides,
  };
}

function authenticatedEvent(method: string, path: string, callerId = 'caller'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0', routeKey: '$default', rawPath: `/v1${path}`, rawQueryString: '', headers: {},
    requestContext: {
      accountId: '123456789012', apiId: 'api-id', domainName: 'api.dev.roadmap2u.com',
      domainPrefix: 'api.dev', requestId: 'request-id', routeKey: '$default', stage: '$default',
      time: '15/Jan/2027:08:00:00 +0000', timeEpoch: NOW,
      http: { method, path: `/v1${path}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      authorizer: {
        principalId: callerId, integrationLatency: 0,
        jwt: { claims: { sub: callerId, auth_time: (NOW - 60_000) / 1_000 }, scopes: [] },
      },
    },
    isBase64Encoded: false,
  };
}

describe('family and social HTTP authorization boundary', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(GetCommand, { Key: K.profile('caller') }).resolves({ Item: profile('caller') });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });

  it('rejects every authenticated route before any database access when the JWT subject is absent', async () => {
    for (const call of CLIENT_CALLS) {
      const event = authenticatedEvent(call.method, call.path);
      event.requestContext.authorizer.jwt.claims = {};
      const response = await handleEvent(event, deps());
      expect(response.statusCode, `${call.method} ${call.path}`).toBe(401);
      expect(JSON.parse(response.body).error.code).toBe('UNAUTHENTICATED');
    }
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each([API_PATHS.friendRequests, API_PATHS.socialAdultFriendRequests])(
    'returns a client validation error for a null request on %s', async (path) => {
      const response = await handleEvent({ ...authenticatedEvent('POST', path), body: 'null' }, deps());
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('VALIDATION');
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('fails closed on a missing family rollout config before creating any family identity', async () => {
    const response = await handleEvent({ ...authenticatedEvent('POST', API_PATHS.familyMinors),
      body: '{}' }, deps());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    API_PATHS.familyMinors,
    API_PATHS.familyMinorLinkCodes,
    API_PATHS.familyMinorLinkRequests,
    API_PATHS.familyMinorLinkRequestApprove('request-a'),
    API_PATHS.familyMinorLinkRequestAccept('request-a'),
    API_PATHS.familyAdditionalResponsibleInvitations,
    API_PATHS.familyAdditionalResponsibleInvitationAccept('invitation-a'),
    API_PATHS.familyTransferPrimaryResponsibility,
    API_PATHS.socialMinorInviteCodes,
    API_PATHS.socialMinorFriendRequests,
    API_PATHS.socialMinorFriendRequestAccept('request-a'),
    API_PATHS.socialMinorFriendRequestResponsibleApprove('request-a'),
  ])('blocks %s with its rollout flag off before family mutation', async (path) => {
    ddbMock.on(GetCommand, { Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' } }).resolves({
      Item: {
        pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', revision: 1,
        quotaMode: 'off', capabilityMode: 'off',
        accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: false,
        premiumPaymentsEnabled: false, ...FAMILY_BILLING_FLAG_DEFAULTS,
        updatedAt: NOW, updatedBy: 'test', reason: 'rollout gates off',
      },
    });
    const response = await handleEvent({ ...authenticatedEvent('POST', path), body: '{}' }, deps());
    expect(JSON.parse(response.body).error.code).toBe('CAPABILITY_REQUIRED');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('keeps family reads and revocations available when rollout config is missing', async () => {
    await handleEvent(authenticatedEvent('GET', API_PATHS.familyHousehold), deps());
    await handleEvent({ ...authenticatedEvent('DELETE', API_PATHS.familyAdditionalResponsible),
      body: '{}' }, deps());
    const configReads = ddbMock.commandCalls(GetCommand).filter((call) =>
      call.args[0].input.Key?.['pk'] === 'COMMERCIAL#CONFIG');
    expect(configReads).toHaveLength(0);
  });

  it.each(['absent', 'unrelated adult', 'unrelated minor', 'closing'] as const)(
    'does not enumerate an %s account through remote forest reads or writes', async (state) => {
      if (state !== 'absent') {
        const target = profile('target', {
          accountType: state === 'unrelated minor' ? 'minor' : 'adult',
          ...(state === 'unrelated minor' ? { majorityAt: '2030-01-01' } : {}),
          status: state === 'closing' ? 'closing' : 'active',
        });
        ddbMock.on(GetCommand, { Key: K.profile('target') }).resolves({ Item: target });
      }
      for (const [method, path] of [
        ['GET', API_PATHS.userForest('target')],
        ['POST', API_PATHS.userSyncPush('target')],
      ]) {
        const response = await handleEvent({ ...authenticatedEvent(method!, path!), body: '{}' }, deps());
        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body)).toEqual({ error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } });
      }
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand).some(({ args }) =>
        String(args[0].input.ExpressionAttributeValues?.[':prefix']).startsWith('REC#'),
      )).toBe(false);
    },
  );

  it('does not let query parameters expand the additional responsible account scope', async () => {
    const family = familyV2Fixture({
      now: NOW, primaryId: 'primary', minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleSeat: 1, additionalId: 'caller', additionalScope: ['minor-a'],
    });
    installFamilyV2Reads(ddbMock, family, [
      profile('caller'), profile('primary'),
      ...['minor-a', 'minor-b'].map((id) => profile(id, { accountType: 'minor', majorityAt: '2030-01-01' })),
    ]);
    for (const [method, path] of [
      ['GET', API_PATHS.userForest('minor-b')],
      ['POST', API_PATHS.userSyncPush('minor-b')],
    ]) {
      const response = await handleEvent({
        ...authenticatedEvent(method!, path!), queryStringParameters: { id: 'minor-a' }, body: '{}',
      }, deps());
      expect(response.statusCode).toBe(404);
    }
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const allowed = await handleEvent(authenticatedEvent('GET', API_PATHS.userForest('minor-a')), deps());
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ detail: 'full', owner: { userId: 'minor-a' } });
  });
});
