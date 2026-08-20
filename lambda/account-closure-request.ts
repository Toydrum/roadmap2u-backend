import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ApiError } from '@app/api/contracts';
import {
  realAccountClosureRequestDeps,
  requestAccountClosure,
  type AccountClosureReceipt,
} from './account-closure-handler';
import { realDeps } from './db';
import { errorResponse, ok, type HttpResponse } from './http';
import { instrumentHandler } from './observability';

export type AccountClosureRequestEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface AccountClosureRequestBoundaryDeps {
  readonly requestClosure: (
    ownerSub: string,
    requestId: string,
  ) => Promise<AccountClosureReceipt>;
}

const NO_STORE = Object.freeze({ 'cache-control': 'no-store' });

function noStore(response: HttpResponse): HttpResponse {
  return {
    ...response,
    headers: { ...response.headers, ...NO_STORE },
  };
}

function trustedOwnerSub(event: AccountClosureRequestEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.['sub'];
  if (typeof sub !== 'string' || !sub || sub !== sub.trim()) {
    throw new ApiError('UNAUTHENTICATED');
  }
  return sub;
}

function trustedRequestId(event: AccountClosureRequestEvent): string {
  const requestId = event.requestContext?.requestId;
  if (
    typeof requestId !== 'string' ||
    !requestId ||
    requestId !== requestId.trim() ||
    requestId.length > 256
  ) {
    throw new Error('trusted API Gateway request id is unavailable');
  }
  return requestId;
}

/** Dedicated exact-route boundary for durable self-service account closure. */
export function createAccountClosureRequestHandler(
  deps: AccountClosureRequestBoundaryDeps,
): (event: AccountClosureRequestEvent) => Promise<HttpResponse> {
  return async (event) => {
    try {
      const receipt = await deps.requestClosure(
        trustedOwnerSub(event),
        trustedRequestId(event),
      );
      return noStore(ok(receipt, 202));
    } catch (error) {
      return noStore(errorResponse(error));
    }
  };
}

let realHandler:
  | ((event: AccountClosureRequestEvent) => Promise<HttpResponse>)
  | undefined;

function productionHandler(): (
  event: AccountClosureRequestEvent,
) => Promise<HttpResponse> {
  if (realHandler) return realHandler;
  const deps = realAccountClosureRequestDeps(realDeps());
  realHandler = createAccountClosureRequestHandler({
    requestClosure: (ownerSub, requestId) =>
      requestAccountClosure(deps, ownerSub, requestId),
  });
  return realHandler;
}

export const handler = instrumentHandler(
  'account-closure-request',
  (event: AccountClosureRequestEvent, _context?: unknown): Promise<HttpResponse> =>
    productionHandler()(event),
);
