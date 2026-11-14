import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { fixture, config, NOW, request, subscription, invoice } from './support/billing-fixture';
import { INTEGRATION, STRIPE_API_VERSION } from '../lambda/billing/model';

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
  it('ignores only verified DespensaLista customers in the shared live account', async () => {
    const f = await fixture();
    const { BillingEventWorker } = await import('../lambda/billing/worker');
    const { StripeBillingProvider } = await import('../lambda/billing/stripe-provider');
    const liveConfig = { ...config, stage: 'prod', liveMode: true } as const;
    const customerId = 'cus_despensalista';
    const metadata = {
      integration: 'despensalista',
      stage: 'prod',
      despensalistaHouseholdId: 'a0c1a32b-1808-49ec-b273-0793bd2fc230',
    };
    const readCustomer = vi.fn();
    const provider = new StripeBillingProvider(liveConfig, {
      invoices: { retrieve: vi.fn(async () => ({ customer: customerId })) },
      customers: { retrieve: readCustomer },
    } as unknown as Stripe);
    const reconcileOwner = vi.fn(async () => {});
    const retryEvent = vi.spyOn(f.repository, 'retryEvent');
    const worker = new BillingEventWorker({
      repository: f.repository, provider, projector: { reconcileOwner },
      config: liveConfig, now: () => NOW, metric: () => {},
    });
    const event = (eventId: string) => f.repository.putEvent({
      eventId, type: 'invoice.paid', objectId: 'in_shared', objectType: 'invoice',
      apiVersion: STRIPE_API_VERSION, liveMode: true, accountId: liveConfig.accountId,
      status: 'pending', attempts: 0, receivedAt: NOW, nextAttemptAt: NOW,
    });
    const customer = { id: customerId, livemode: true, metadata };
    readCustomer.mockResolvedValueOnce(customer);
    await event('evt_despensalista');
    await worker.process('evt_despensalista');
    expect((await f.repository.event('evt_despensalista'))?.status).toBe('ignored');
    expect(retryEvent).not.toHaveBeenCalled();
    expect(reconcileOwner).not.toHaveBeenCalled();

    const unverifiedCustomers = [
      { ...customer, metadata: { ...metadata, integration: 'unrecognized' } },
      { ...customer, metadata: { ...metadata, stage: 'dev' } },
      { ...customer, metadata: { ...metadata, despensalistaHouseholdId: '' } },
      { ...customer, id: 'cus_other' },
      { ...customer, livemode: false },
      { id: customerId, deleted: true },
    ];
    for (const [index, unverified] of unverifiedCustomers.entries()) {
      const id = `evt_unverified${index}`;
      readCustomer.mockResolvedValueOnce(unverified);
      await event(id);
      await expect(worker.process(id)).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    }
    readCustomer.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await event('evt_network');
    await expect(worker.process('evt_network')).rejects.toThrow('Stripe unavailable');
    expect(retryEvent).toHaveBeenCalledTimes(unverifiedCustomers.length + 1);
    expect(reconcileOwner).not.toHaveBeenCalled();
  });
  it('continues to repair RoadMap2U customer mappings only after a matching durable checkout reservation', async () => {
    const f = await webhookFixture();
    const { BillingEventWorker } = await import('../lambda/billing/worker');
    const { StripeBillingProvider } = await import('../lambda/billing/stripe-provider');
    f.provider.failAfterCustomer = true;
    await f.service.checkout('adult', request());
    const [customer] = f.provider.customers.values();
    expect(await f.repository.mappedOwner('customer', customer.id)).toBeNull();

    const metadata = { integration: INTEGRATION, stage: config.stage, owner: 'adult', operation: customer.operationId };
    const readCustomer = vi.fn();
    const provider = new StripeBillingProvider(config, {
      invoices: { retrieve: vi.fn(async () => ({ customer: customer.id })) },
      customers: { retrieve: readCustomer },
    } as unknown as Stripe);
    const reconcileOwner = vi.fn(async () => {});
    const worker = new BillingEventWorker({
      repository: f.repository, provider, projector: { reconcileOwner },
      config, now: () => NOW, metric: () => {},
    });

    readCustomer.mockResolvedValueOnce({ ...customer, livemode: false, metadata: { ...metadata, operation: 'unreserved' } });
    await f.invoke(eventInput('invoice.paid', 'evt_unreserved'));
    await expect(worker.process('evt_unreserved')).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect(await f.repository.mappedOwner('customer', customer.id)).toBeNull();
    expect(reconcileOwner).not.toHaveBeenCalled();

    readCustomer.mockResolvedValueOnce({ ...customer, livemode: false, metadata });
    await f.invoke(); await worker.process('evt_1');
    expect(await f.repository.mappedOwner('customer', customer.id)).toBe('adult');
    expect((await f.repository.event('evt_1'))?.status).toBe('processed');
    expect(reconcileOwner).toHaveBeenCalledOnce();
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
