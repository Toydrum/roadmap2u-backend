import { ApiError } from '@app/api/contracts';
import { describe, expect, it, vi } from 'vitest';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { createAccessCodeRedeemerHandler } from '../lambda/access-code-redeemer';
import { createSponsoredAccessBrokerHandler } from '../lambda/sponsored-access-broker';

const NOW = Date.parse('2026-08-22T18:30:00.000Z');
const OWNER = 'sub-adult';
const CODE =
  'RM2U1.7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a.MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE';
const ACTOR = 'arn:aws:sts::123456789012:assumed-role/SponsoredAccessOperator-dev/session';

function redeemEvent(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    rawPath: '/v1/access-codes/redeem',
    rawQueryString: '',
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'request-1',
      http: { method: 'POST' },
      authorizer: {
        jwt: { claims: { sub: OWNER, email_verified: 'true' } },
      },
    },
    ...overrides,
  };
}

function brokerEvent(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    rawQueryString: '',
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'request-1',
      http: { method: 'POST' },
      authorizer: { iam: { userArn: ACTOR } },
    },
    ...overrides,
  };
}

describe('access-code HTTP boundaries', () => {
  it('accepts only {code}, trusts JWT identity, and returns a no-store AccessSummary', async () => {
    const access = deriveAccessItem(OWNER, NOW, undefined, [
      {
        pk: `USER#${OWNER}`,
        sk: 'GRANT#code-test',
        ownerSub: OWNER,
        grantId: 'code-test',
        sourceKind: 'sponsored',
        status: 'active',
        catalogVersion: '2026-08-prepayment-v1',
        planKey: 'premium',
        limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
        capabilities: { cloudSync: true, social: true, family: false },
        startsAt: NOW,
        expiresAt: null,
        revision: 1,
        reason: 'beta',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const redeem = vi.fn(async () => access);
    const handler = createAccessCodeRedeemerHandler({
      redeem,
      readUsage: vi.fn(async () => ({ activeTrees: 2, visibleBranchesByTree: { oak: 10 } })),
    });

    const response = await handler(redeemEvent({ code: CODE }) as never);

    expect(redeem).toHaveBeenCalledWith({
      ownerSub: OWNER,
      emailVerified: true,
      code: CODE,
      requestId: 'request-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toMatchObject({
      effectivePlanKey: 'premium',
      usage: { activeTrees: 2, visibleBranchesByTree: { oak: 10 } },
    });
  });

  it('accepts the padded request ids emitted by API Gateway', async () => {
    const redeem = vi.fn(async () => deriveAccessItem(OWNER, NOW, undefined, []));
    const handler = createAccessCodeRedeemerHandler({
      redeem,
      readUsage: vi.fn(async () => ({ activeTrees: 0, visibleBranchesByTree: {} })),
    });
    const event = redeemEvent({ code: CODE }) as any;
    event.requestContext.requestId = 'CiVhEg0EoAMEVwg=';

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(redeem).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'CiVhEg0EoAMEVwg=' }),
    );
  });

  it.each([
    [redeemEvent({ code: CODE, planKey: 'premium' })],
    [redeemEvent({ code: CODE }, { rawQueryString: `code=${encodeURIComponent(CODE)}` })],
    [redeemEvent({ code: CODE }, { isBase64Encoded: true })],
  ])('rejects extra, URL or encoded secret transport before the redeemer', async (event) => {
    const redeem = vi.fn();
    const handler = createAccessCodeRedeemerHandler({
      redeem,
      readUsage: vi.fn(),
    });

    const response = await handler(event as never);

    expect(response.statusCode).toBe(400);
    expect(redeem).not.toHaveBeenCalled();
    expect(response.body).not.toContain(CODE);
  });

  it('maps a generic invalid code without echoing the submitted bearer secret', async () => {
    const handler = createAccessCodeRedeemerHandler({
      redeem: vi.fn(async () => {
        throw new ApiError('ACCESS_CODE_INVALID');
      }),
      readUsage: vi.fn(),
    });

    const response = await handler(redeemEvent({ code: CODE }) as never);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'ACCESS_CODE_INVALID', message: 'ACCESS_CODE_INVALID' },
    });
    expect(response.body).not.toContain(CODE);
  });

  it('passes verification state from the authorizer instead of accepting it from the body', async () => {
    const redeem = vi.fn(async () => deriveAccessItem(OWNER, NOW, undefined, []));
    const handler = createAccessCodeRedeemerHandler({
      redeem,
      readUsage: vi.fn(async () => ({ activeTrees: 0, visibleBranchesByTree: {} })),
    });
    const event = redeemEvent({ code: CODE }) as any;
    event.requestContext.authorizer.jwt.claims.email_verified = 'false';

    await handler(event);

    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false }));
  });

  it('passes the IAM actor exclusively from requestContext to the operator Broker', async () => {
    const execute = vi.fn(async (command) => ({
      command: 'issue-code',
      metadata: { issuanceId: 'id', status: 'issued' },
      plaintext: CODE,
      plaintextUnavailable: false,
      idempotent: false,
      received: command,
    }));
    const handler = createSponsoredAccessBrokerHandler({ execute });
    const body = {
      command: 'issue-code',
      stage: 'dev',
      commandId: 'e3850eda-32e1-4b2b-a1bf-233226881128',
      reason: 'beta',
      grantOfferKey: 'premium_demo',
      confirmHash: 'a'.repeat(64),
    };

    const response = await handler(brokerEvent(body));

    expect(execute).toHaveBeenCalledWith(body, {
      actorArn: ACTOR,
      requestId: 'request-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    [
      {
        command: 'issue-code',
        stage: 'dev',
        commandId: 'e3850eda-32e1-4b2b-a1bf-233226881128',
        reason: 'beta',
        grantOfferKey: 'premium_demo',
        confirmHash: 'a'.repeat(64),
        actor: ACTOR,
      },
    ],
    [
      {
        command: 'issue-code',
        stage: 'dev',
        commandId: 'e3850eda-32e1-4b2b-a1bf-233226881128',
        reason: 'beta',
        grantOfferKey: 'premium_demo',
        confirmHash: 'a'.repeat(64),
        limits: { maxActiveTrees: null },
      },
    ],
  ])('rejects body-supplied authority or entitlement fields', async (body) => {
    const execute = vi.fn();
    const handler = createSponsoredAccessBrokerHandler({ execute });

    const response = await handler(brokerEvent(body));

    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects operator query strings and non-POST methods', async () => {
    const execute = vi.fn();
    const handler = createSponsoredAccessBrokerHandler({ execute });
    const metadata = { command: 'metadata', stage: 'dev', issuanceId: 'id' };

    const withQuery = await handler(brokerEvent(metadata, { rawQueryString: 'issuanceId=id' }));
    const get = brokerEvent(metadata) as any;
    get.requestContext.http.method = 'GET';
    const withGet = await handler(get);

    expect(withQuery.statusCode).toBe(400);
    expect(withGet.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
