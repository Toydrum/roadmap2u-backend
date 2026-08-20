import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@app/api/contracts';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createAccountClosureRequestHandler } from '../lambda/account-closure-request';

function event(
  sub: unknown = 'adult-1',
  requestId: unknown = 'api-request-1',
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    rawPath: '/v1/me',
    rawQueryString: 'ownerSub=attacker',
    queryStringParameters: { ownerSub: 'attacker' },
    body: JSON.stringify({ ownerSub: 'attacker' }),
    requestContext: {
      requestId,
      http: { method: 'DELETE' },
      authorizer: { jwt: { claims: { sub } } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('DELETE /v1/me Lambda boundary', () => {
  it('has a dedicated thin entrypoint instead of adding closure authority to the router', () => {
    expect(
      existsSync(join(process.cwd(), 'lambda', 'account-closure-request.ts')),
    ).toBe(true);
  });

  it('exports an injectable HTTP handler factory', async () => {
    const module = await import('../lambda/account-closure-request');

    expect(typeof module.createAccountClosureRequestHandler).toBe('function');
  });

  it('uses only the JWT sub and API Gateway request id, then returns 202 with no-store', async () => {
    const requestClosure = vi.fn(async () => ({
      closureId: 'closure-1',
      state: 'requested' as const,
    }));
    const handler = createAccountClosureRequestHandler({ requestClosure });

    const response = await handler(event());

    expect(requestClosure).toHaveBeenCalledOnce();
    expect(requestClosure).toHaveBeenCalledWith('adult-1', 'api-request-1');
    expect(response).toEqual({
      statusCode: 202,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ closureId: 'closure-1', state: 'requested' }),
    });
    expect(response.body).not.toContain('attacker');
  });

  it.each([undefined, '', ' padded ', 42])(
    'rejects untrusted JWT sub %j before invoking closure authority',
    async (sub) => {
      const requestClosure = vi.fn();
      const request = event(sub);
      if (sub === undefined) {
        delete (request.requestContext as { authorizer?: unknown }).authorizer;
      }
      const response = await createAccountClosureRequestHandler({ requestClosure })(request);

      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(requestClosure).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', ' padded ', 42])(
    'fails closed for an invalid trusted request id %j',
    async (requestId) => {
      const requestClosure = vi.fn();
      const request = event('adult-1', requestId);
      if (requestId === undefined) {
        delete (request.requestContext as { requestId?: unknown }).requestId;
      }
      const response = await createAccountClosureRequestHandler({ requestClosure })(
        request,
      );

      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(requestClosure).not.toHaveBeenCalled();
    },
  );

  it('preserves closure conflicts without caching them', async () => {
    const handler = createAccountClosureRequestHandler({
      requestClosure: async () => {
        throw new ApiError('CONFLICT', 'family ownership must be reconciled');
      },
    });

    const response = await handler(event());

    expect(response.statusCode).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'CONFLICT', message: 'family ownership must be reconciled' },
    });
  });
});
