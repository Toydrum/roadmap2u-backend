import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { fixture, NOW, config, request, subscription, invoice } from './support/billing-fixture';
import { BillingProjector } from '../lambda/billing/projection';

async function closeFixture() {
  const mod = await import('../lambda/billing/closure').catch(() => null); expect(mod, 'financial closure coordinator exists').not.toBeNull();
  const f = await fixture(); await f.service.checkout('adult', request());
  const customerId = (await f.repository.load('adult')).customerId!;
  f.provider.subscriptions.set('sub_1', subscription(customerId)); f.provider.invoices.set('in_1', invoice(customerId));
  const closer = new mod!.BillingClosure({ ...f, config, nextWorkerId: () => 'closure-worker' });
  return { ...f, closer };
}
describe('financial account closure', () => {
  it('expires open checkout, cancels immediately without invoicing or refund, verifies no future collection, then finishes', async () => {
    const f = await closeFixture();
    expect(await f.closer.resolve('adult', 'closure-1')).toBe(true);
    expect(f.provider.checkouts.get('cs_1')?.status).toBe('expired');
    expect(f.provider.cancelledSubscriptions).toEqual(['sub_1']);
    expect((await f.repository.load('adult'))).toMatchObject({ state: 'closed', closingId: 'closure-1', closedAt: NOW });
    expect(f.provider.invoices.get('in_1')?.refunds).toEqual([]);
  });
  it('provider timeout leaves durable closing fence and retries the same financial operation', async () => {
    const f = await closeFixture(); f.provider.unavailable = true;
    expect(await f.closer.resolve('adult', 'closure-1')).toBe(false);
    expect((await f.repository.load('adult')).closingId).toBe('closure-1');
    await expect(f.service.checkout('adult', request('new', (await f.repository.load('adult')).revision))).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    f.provider.unavailable = false; expect(await f.closer.resolve('adult', 'closure-1')).toBe(true);
    expect(f.provider.cancelledSubscriptions).toEqual(['sub_1']);
  });
  it('resolves remote response loss before closure and late events cannot recreate paid sources', async () => {
    const f = await fixture(); f.provider.failAfterCustomer = true; await f.service.checkout('adult', request());
    const mod = await import('../lambda/billing/closure');
    const closer = new mod.BillingClosure({ ...f, config, nextWorkerId: () => 'closure' });
    expect(await closer.resolve('adult', 'closure-1')).toBe(true);
    f.repository.actors.delete('adult');
    const customerId = [...f.provider.customers.keys()][0];
    f.provider.subscriptions.set('sub_late', subscription(customerId, 'sub_late')); f.provider.invoices.set('in_late', invoice(customerId, 'in_late', NOW - 1, NOW + 1000, 'sub_late'));
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'late' }).reconcileOwner('adult');
    expect(f.repository.sources.size).toBe(0); expect(f.provider.subscriptions.get('sub_late')?.status).toBe('canceled');
  });
  it('ordinary free/sponsored closure with no financial records needs no config or Stripe construction', async () => {
    const mod = await import('../lambda/billing/closure');
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})); const mock = mockClient(ddb);
    mock.on(GetCommand).resolves({}); mock.on(QueryCommand).resolves({ Items: [] });
    const result = await mod.resolveAccountBillingBeforePurge({ ddb, table: 'roadmap' }, { sub: 'adult', closureId: 'closure-1' }, async () => { throw new Error('Stripe must not be constructed'); });
    expect(result).toBe(true);
  });
  it('known financial state plus absent configuration stays pending, never declares purge safe', async () => {
    const mod = await import('../lambda/billing/closure');
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})); const mock = mockClient(ddb);
    mock.on(GetCommand).resolves({ Item: { ownerSub: 'adult', customerId: 'cus_1' } }); mock.on(QueryCommand).resolves({ Items: [{ sk: 'COMMAND#pending' }] });
    expect(await mod.resolveAccountBillingBeforePurge({ ddb, table: 'roadmap' }, { sub: 'adult', closureId: 'closure-1' }, async () => { throw new Error('missing Stripe config'); })).toBe(false);
  });
});
