import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { fixture, config, NOW, request, subscription, invoice } from './support/billing-fixture';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

const secret = 'whsec_synthetic_only';
function eventInput(type = 'invoice.paid', id = 'evt_1') {
  return { id, object: 'event', type, api_version: STRIPE_API_VERSION, livemode: false, created: Math.floor(NOW / 1000), data: { object: { id: 'in_1', object: 'invoice' } } };
}
async function webhookFixture() {
  const mod = await import('../lambda/billing/webhook').catch(() => null);
  expect(mod, 'raw signature webhook boundary exists').not.toBeNull();
  const f = await fixture(), queued: string[] = [];
  let queueFails = false;
  const handler = mod!.createWebhookHandler({ repository: f.repository, config: { secret, accountId: config.accountId, liveMode: false, apiVersion: STRIPE_API_VERSION, stage: 'dev' }, now: () => NOW, enqueue: async (id) => { if (queueFails) throw new Error('SQS unavailable'); queued.push(id); }, metric: () => {} });
  const invoke = (value = eventInput(), base64 = false, signed = true) => {
    const body = JSON.stringify(value);
    return handler({ body: base64 ? Buffer.from(body).toString('base64') : body, isBase64Encoded: base64, headers: { 'Stripe-Signature': signed ? Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: NOW / 1000 }) : 't=1,v1=invalid' } });
  };
  return { ...f, queued, handler, invoke, setQueueFails: (v: boolean) => { queueFails = v; } };
}
describe('Stripe minimal durable inbox', () => {
  it('verifies original decoded bytes, persists minimal envelope then queues only the event id', async () => {
    const f = await webhookFixture(); expect((await f.invoke(eventInput(), true)).statusCode).toBe(200);
    expect(f.queued).toEqual(['evt_1']);
    expect(await f.repository.event('evt_1')).toMatchObject({ eventId: 'evt_1', objectId: 'in_1', objectType: 'invoice', status: 'pending' });
    expect(await f.repository.event('evt_1')).not.toHaveProperty('data');
  });
  it('invalid signatures, wrong mode and wrong API version never enter the inbox', async () => {
    const f = await webhookFixture(); expect((await f.invoke(eventInput(), false, false)).statusCode).toBe(400);
    expect((await f.invoke({ ...eventInput(), livemode: true })).statusCode).toBe(400);
    expect((await f.invoke({ ...eventInput(), api_version: 'old' as typeof STRIPE_API_VERSION })).statusCode).toBe(400);
    expect(f.repository.events.size).toBe(0);
  });
  it('refuses oversized or malformed base64 before parsing or signature work', async () => {
    const f = await webhookFixture();
    expect((await f.handler({ body: 'x'.repeat(262145), headers: {}, isBase64Encoded: false })).statusCode).toBe(413);
    expect((await f.handler({ body: 'not-base64!', headers: {}, isBase64Encoded: true })).statusCode).toBe(400);
  });
  it('acknowledges durable persistence even when SQS fails and deduplicates retries', async () => {
    const f = await webhookFixture(); f.setQueueFails(true);
    expect((await f.invoke()).statusCode).toBe(200);
    expect(f.repository.events.size).toBe(1); expect(f.queued).toHaveLength(0);
    f.setQueueFails(false); expect((await f.invoke()).statusCode).toBe(200);
    expect(f.repository.events.size).toBe(1); expect(f.queued).toEqual(['evt_1']);
  });
  it('does not acknowledge an inbox write failure', async () => {
    const f = await webhookFixture(); f.repository.putEvent = async () => { throw new Error('DDB unavailable'); };
    expect((await f.invoke()).statusCode).toBe(503); expect(f.queued).toHaveLength(0);
  });
  it('worker retrieves current provider objects, processes once and ignores unknown signed event types', async () => {
    const f = await webhookFixture();
    await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); f.provider.invoices.set('in_1', invoice(customerId));
    const { BillingProjector } = await import('../lambda/billing/projection');
    const { BillingEventWorker } = await import('../lambda/billing/worker');
    const worker = new BillingEventWorker({ repository: f.repository, provider: f.provider, projector: new BillingProjector({ ...f, config, now: () => NOW, nextWorkerId: () => 'worker' }), config, now: () => NOW, metric: () => {} });
    await f.invoke(); await worker.process('evt_1'); await worker.process('evt_1');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect((await f.repository.receipts('adult'))).toHaveLength(1);
    await f.invoke(eventInput('customer.unrecognized', 'evt_unknown')); await worker.process('evt_unknown');
    expect((await f.repository.event('evt_unknown'))?.status).toBe('ignored');
  });
  it('reconciler recovers accepted-but-not-enqueued events using an indexed page and durable cursor', async () => {
    const f = await webhookFixture(); f.setQueueFails(true); await f.invoke();
    const mod = await import('../lambda/billing/reconciler');
    const processed: string[] = [];
    const reconciler = new mod.BillingReconciler({ repository: f.repository, provider: f.provider, service: f.service, worker: { process: async (id: string) => { processed.push(id); await f.repository.finishEvent(id, 'processed', NOW); } }, projector: { reconcileOwner: async () => {} }, now: () => NOW, metric: () => {} });
    await reconciler.run('pending'); expect(processed).toEqual(['evt_1']);
    expect((await f.repository.event('evt_1'))?.status).toBe('processed');
  });
});
