import { describe, expect, it } from 'vitest';
import { isIndividualBillingCatalog, isIndividualBillingSummary, isIndividualBillingCommandResult } from '@app/api/contracts';
import { fixture, request } from './support/billing-fixture';

async function boundary() {
  const mod = await import('../lambda/billing/handler').catch(() => null);
  expect(mod, 'individual billing HTTP boundary exists').not.toBeNull();
  const f = await fixture();
  return { ...f, handler: mod!.createBillingHandler(async () => f.service) };
}
function event(path: string, method = 'GET', body?: unknown, claims: Record<string, unknown> = { sub: 'adult', email_verified: true }) {
  return { rawPath: `/v1/billing/individual/${path}`, requestContext: { http: { method }, authorizer: { jwt: { claims } } }, ...(body ? { body: JSON.stringify(body) } : {}), headers: {}, isBase64Encoded: false };
}
describe('billing HTTP identity boundary', () => {
  it('public catalog and JWT summary/command match strict generated DTO guards and hide provider identifiers', async () => {
    const f = await boundary();
    const catalog = await f.handler(event('catalog', 'GET', undefined, {}));
    expect(catalog.statusCode).toBe(200); expect(isIndividualBillingCatalog(JSON.parse(catalog.body))).toBe(true);
    const summary = await f.handler(event('summary'));
    expect(summary.statusCode).toBe(200); expect(isIndividualBillingSummary(JSON.parse(summary.body))).toBe(true);
    const checkout = await f.handler(event('checkout', 'POST', request()));
    expect(checkout.statusCode).toBe(200); expect(isIndividualBillingCommandResult(JSON.parse(checkout.body))).toBe(true);
    expect(checkout.headers['cache-control']).toBe('no-store');
    expect(summary.body).not.toContain('customerId'); expect(checkout.body).not.toContain('ownerSub');
  });
  it('rejects unverified/absent JWT and never trusts a purchaser in the body', async () => {
    const f = await boundary();
    expect((await f.handler(event('checkout', 'POST', request(), {}))).statusCode).toBe(401);
    expect((await f.handler(event('checkout', 'POST', request(), { sub: 'adult', email_verified: false }))).statusCode).toBe(403);
    expect((await f.handler(event('checkout', 'POST', { ...request(), ownerSub: 'another' }))).statusCode).toBe(400);
    expect(f.provider.checkouts.size).toBe(0);
  });
  it('fails purchases closed but permits basic Portal while sales are disabled', async () => {
    const f = await boundary(); await f.handler(event('checkout', 'POST', request())); f.setEnabled(false);
    const summary = JSON.parse((await f.handler(event('summary'))).body);
    expect((await f.handler(event('portal', 'POST', { commandId: 'portal', expectedBillingRevision: summary.revision }))).statusCode).toBe(200);
    expect((await f.handler(event('checkout', 'POST', request('new', summary.revision)))).statusCode).toBe(403);
  });
});
