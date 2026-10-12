import { ApiError, CLOSED_INDIVIDUAL_BILLING_CATALOG, type ApiErrorCode } from '@app/api/contracts';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { errorResponse, ok, parseJsonBody, type HttpResponse } from '../http';
import { BillingError } from './model';
import type { BillingService } from './service';
import { createBillingRuntime } from './runtime';
import { billingMetric } from './metrics';

interface BillingHttpEvent {
  rawPath: string; requestContext: { http: { method: string }; authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
  body?: string | null; isBase64Encoded?: boolean; headers: Record<string, string | undefined>;
}
const noStore = (response: HttpResponse): HttpResponse => ({ ...response, headers: { ...response.headers, 'cache-control': 'no-store' } });
export function createBillingHandler(resolve: (ownerSub?: string, emailVerified?: boolean) => Promise<BillingService>) {
  return async (event: BillingHttpEvent): Promise<HttpResponse> => {
    const route = event.rawPath.replace(/^\/v1/, ''), method = event.requestContext.http.method;
    if (!((method === 'GET' && ['/billing/individual/catalog', '/billing/individual/summary'].includes(route)) || (method === 'POST' && ['/billing/individual/checkout', '/billing/individual/portal'].includes(route)))) return noStore(errorResponse(new ApiError('NOT_FOUND')));
    try {
      if (route.endsWith('/catalog')) {
        try { return noStore(ok(await (await resolve()).catalog())); }
        catch { return noStore(ok(CLOSED_INDIVIDUAL_BILLING_CATALOG)); }
      }
      const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
      const ownerSub = claims['sub'];
      if (typeof ownerSub !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,127}$/.test(ownerSub)) throw new ApiError('UNAUTHENTICATED');
      const emailVerified = claims['email_verified'] === true || claims['email_verified'] === 'true';
      if (route.endsWith('/checkout') && !emailVerified) throw new ApiError('BILLING_BUYER_INELIGIBLE');
      if (event.body && Buffer.byteLength(event.body) > 16_384) throw new ApiError('VALIDATION');
      const service = await resolve(ownerSub, emailVerified);
      if (route.endsWith('/summary')) return noStore(ok(await service.summary(ownerSub)));
      const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      const body = parseJsonBody(raw ?? undefined);
      return noStore(ok(route.endsWith('/checkout') ? await service.checkout(ownerSub, body) : await service.portal(ownerSub, body)));
    } catch (error) {
      if (error instanceof ApiError) return noStore(errorResponse(error));
      if (error instanceof BillingError) {
        const code = error.code === 'BAD_REQUEST' ? 'VALIDATION' : error.code === 'BILLING_DISABLED' ? 'FORBIDDEN' : error.code;
        return noStore(errorResponse(new ApiError(code as ApiErrorCode)));
      }
      // Provider/SSM errors can contain request material; never log raw exceptions.
      billingMetric('StripeError'); return noStore(errorResponse(new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE')));
    }
  };
}
export const handler = createBillingHandler(async (ownerSub, emailVerified) => (await createBillingRuntime(ownerSub ? { ownerSub, emailVerified: emailVerified === true } : undefined)).service) as (event: APIGatewayProxyEventV2) => Promise<HttpResponse>;
