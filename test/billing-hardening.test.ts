import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { fixture, config, NOW, request, subscription, invoice } from './support/billing-fixture';
import { BillingClosure } from '../lambda/billing/closure';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingService } from '../lambda/billing/service';
import { processAccountClosureMessage, type AccountClosureDeps } from '../lambda/account-closure';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { initialState, STRIPE_API_VERSION } from '../lambda/billing/model';

describe('billing purchase and closure race boundaries', () => {
  it('a closure cannot finish while Checkout creation is in flight, and retries expire the result', async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
    const original = f.provider.createCheckout.bind(f.provider);
    f.provider.createCheckout = async (...args) => { entered(); await gate; return original(...args); };
    const purchase = f.service.checkout('adult', request()); await started;
    const closer = new BillingClosure({ ...f, config, nextWorkerId: () => 'closer' });
    expect(await closer.resolve('adult', 'close-1')).toBe(false);
    release(); await purchase;
    expect(await closer.resolve('adult', 'close-1')).toBe(true);
    expect([...f.provider.checkouts.values()].every((s) => s.status !== 'open')).toBe(true);
  });
  it('recovery rechecks the canonical adult declaration before any additional external call', async () => {
    const f = await fixture(); f.provider.failAfterCustomer = true; await f.service.checkout('adult', request());
    const c = (await f.repository.command('adult', 'purchase-1'))!;
    f.repository.actors.get('adult')!.adultDeclarationCurrent = false;
    await expect(f.service.resumeCheckout('adult', c)).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(f.provider.checkouts.size).toBe(0);
  });
  it('an unmapped remote subscription prevents a second purchase after local state restoration', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    const state = await f.repository.load('adult');
    f.provider.checkouts.get('cs_1')!.status = 'complete';
    f.provider.subscriptions.set('sub_external', subscription(state.customerId!, 'sub_external'));
    f.repository.states.set('adult', { ...state, activeCommandId: undefined, state: 'none' });
    await expect(f.service.checkout('adult', request('restored', state.revision))).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS' });
    expect(f.provider.checkouts.size).toBe(1);
  });
  it.each(['requested', 'purgeComplete'] as const)('canonical %s closure cannot erase identity or data until financial resolution succeeds', async (state) => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})), mock = mockClient(ddb);
    mock.on(GetCommand).resolves({ Item: { pk: 'ACCOUNT_CLOSURE#adult', sk: 'STATE', sub: 'adult', username: 'adult', closureId: 'close-1', state, revision: 1, requestedAt: NOW, updatedAt: NOW, familyCleanupVersion: 1 } });
    const enqueue = vi.fn(), resolveBilling = vi.fn(async () => false);
    const deps = { ddb, table: 'roadmap', now: () => NOW, queue: { enqueue }, resolveBilling, cognito: { send: vi.fn() } } as unknown as AccountClosureDeps;
    expect(await processAccountClosureMessage(deps, { sub: 'adult', closureId: 'close-1' })).toBe('pending');
    expect(resolveBilling).toHaveBeenCalledOnce(); expect(enqueue).toHaveBeenCalled();
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0); expect(deps.cognito.send).not.toHaveBeenCalled();
  });
  it('financial closure writes require the matching canonical closure identity', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})), mock = mockClient(ddb); mock.on(TransactWriteCommand).resolves({});
    const r = new DynamoBillingRepository({ ddb, table: 'roadmap', accountId: config.accountId, stage: 'dev', liveMode: false });
    await r.commit({ expectedRevision: 1, state: { ...initialState('adult'), revision: 2, closingId: 'close-1' }, guard: 'closure', auditAction: 'billing.closure_fenced' });
    const checks = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.filter((v) => v.ConditionCheck?.Key?.['pk'] === 'ACCOUNT_CLOSURE#adult');
    expect(checks).toHaveLength(1); expect(checks[0].ConditionCheck?.ExpressionAttributeValues).toEqual({ ':closureId': 'close-1' });
  });
  it('a lost API lease cannot overwrite the replacement worker with a payment review transition', async () => {
    const f = await fixture();
    f.provider.findCustomers = async () => {
      const s = f.repository.states.get('adult')!; f.repository.states.set('adult', { ...s, leaseOwner: 'replacement', leaseRevision: (s.leaseRevision ?? 0) + 1 });
      return [{ id: 'cus_1', ownerSub: 'adult', operationId: 'x', liveMode: false, country: 'MX' }, { id: 'cus_2', ownerSub: 'adult', operationId: 'x', liveMode: false, country: 'MX' }];
    };
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect((await f.repository.load('adult')).leaseOwner).toBe('replacement'); expect((await f.repository.load('adult')).state).toBe('checkout_pending');
  });
  it('Portal separately validates its permissions while preserving access during catalog retirement', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    f.provider.preflightValid = false; // Represents subscription changes/coupons enabled in the remote Portal.
    await expect(f.service.portal('adult', { commandId: 'unsafe-portal', expectedBillingRevision: (await f.repository.load('adult')).revision })).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect(f.provider.portalCustomers).toHaveLength(0);
  });
});

describe('original subscription price continuity', () => {
  it('keeps the reserved original price if the catalog changes before the first paid webhook', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const s = await f.repository.load('adult');
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    f.provider.subscriptions.set('sub_1', { ...subscription(s.customerId!), operationId: command.operationId }); f.provider.invoices.set('in_1', invoice(s.customerId!));
    await new BillingProjector({ ...f, config: { ...config, catalogVersion: 'replacement', productId: 'prod_new', monthlyPriceId: 'price_new' }, nextWorkerId: () => 'worker' }).reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
    expect((await f.repository.load('adult')).priceBindings?.[0].catalogVersion).toBe(config.catalogVersion);
  });
  it('preserves an existing paid period and its original price during catalog replacement, including recovery', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); const original = invoice(customerId); original.paidAt = NOW;
    f.provider.invoices.set('in_1', original);
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'first' }).reconcileOwner('adult');
    const changed = { ...config, catalogVersion: 'replacement-v2', productId: 'prod_replacement', monthlyPriceId: 'price_replacement_month', annualPriceId: 'price_replacement_year' };
    const projector = new BillingProjector({ ...f, config: changed, nextWorkerId: () => 'next' });
    await projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')?.state).toBe('active');
    const end = original.lines[0].end; f.setNow(end + 86400000);
    const recovered = invoice(customerId, 'in_2', end, Date.UTC(2026, 11, 11, 12)); recovered.paidAt = f.now(); f.provider.invoices.set(recovered.id, recovered);
    await projector.reconcileOwner('adult'); expect(f.repository.sources.get('adult')?.state).toBe('active');
    const state = await f.repository.load('adult'); expect(state.firstPaidAt).toBe(NOW); expect(state.protectedPriceUntil).toBe(Date.UTC(2027, 9, 11, 12));
    expect(state.priceBindings?.[0]).toMatchObject({ subscriptionId: 'sub_1', priceId: config.monthlyPriceId, productId: config.productId, amountMinor: 9900, firstPaidAt: NOW });
  });
  it('a malformed later invoice enters review without revoking an unaffected previously verified period', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); f.provider.invoices.set('in_1', invoice(customerId));
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' }); await projector.reconcileOwner('adult');
    const bad = invoice(customerId, 'in_bad', NOW, NOW + 86400000); bad.creditApplied = true; f.provider.invoices.set(bad.id, bad);
    await projector.reconcileOwner('adult'); expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(f.repository.sources.get('adult')?.state).toBe('active');
  });
  it('missing or unapproved inclusive tax evidence never grants a new paid period', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1', subscription(customerId)); const inv = invoice(customerId); inv.taxValid = false; f.provider.invoices.set(inv.id, inv);
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' }).reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review'); expect(f.repository.sources.get('adult')?.state).toBe('ended');
  });
  it.each(['country', 'subscription_quantity', 'subscription_customer', 'tax_rate', 'charge_reused'])('rejects unverified %s instead of extending access', async (kind) => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    const sub = subscription(customerId), inv = invoice(customerId); f.provider.subscriptions.set(sub.id, sub); f.provider.invoices.set(inv.id, inv);
    if (kind === 'country') f.provider.customers.get(customerId)!.country = 'US';
    if (kind === 'subscription_quantity') sub.quantity = 2;
    if (kind === 'subscription_customer') sub.ownerSub = 'another-owner';
    if (kind === 'tax_rate') inv.taxRateIds = ['txr_unapproved'];
    if (kind === 'charge_reused') { const other = invoice(customerId, 'in_2', NOW, NOW + 86_400_000); other.payments[0].chargeId = inv.payments[0].chargeId; f.provider.invoices.set(other.id, other); }
    await new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' }).reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review'); expect(f.repository.sources.get('adult')?.state).toBe('ended');
  });
  it('a dispute permanently stops its own subscription while a win restores only its financial period', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const customerId = (await f.repository.load('adult')).customerId!;
    const inv = invoice(customerId); inv.disputes = [{ id: 'dp_1', chargeId: inv.payments[0].chargeId!, amount: 9900, status: 'needs_response' }];
    f.provider.invoices.set(inv.id, inv); f.provider.subscriptions.set('sub_1', subscription(customerId));
    const projector = new BillingProjector({ ...f, config, nextWorkerId: () => 'worker' });
    await projector.reconcileOwner('adult'); expect(f.provider.subscriptions.get('sub_1')?.status).toBe('canceled');
    inv.disputes[0].status = 'won'; await projector.reconcileOwner('adult');
    expect(f.repository.sources.get('adult')?.state).toBe('active'); expect(f.provider.subscriptions.get('sub_1')?.status).toBe('canceled');
    f.provider.subscriptions.set('sub_2', subscription(customerId, 'sub_2')); f.provider.invoices.set('in_2', invoice(customerId, 'in_2', NOW - 1, NOW + 1000, 'sub_2'));
    await projector.reconcileOwner('adult'); expect(f.provider.subscriptions.get('sub_2')?.status).toBe('active');
  });
});

describe('live sales approvals are independent of financial configuration', () => {
  it('missing, blank or draft approvals close live sales without breaking transport configuration or Portal', async () => {
    const mod = await import('../lambda/billing/config');
    const live = { ...config, stage: 'prod', liveMode: true, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'sk_live_synthetic', taxRatePercentage: 7.25 };
    expect(() => mod.parsePrivateConfig(live)).not.toThrow();
    expect(mod.purchasesConfigReady(mod.parsePrivateConfig(live))).toBe(false);
    const approved = { ...live, fiscalApprovalReference: 'owner-fiscal-1', commercialTermsApprovalReference: 'owner-subscription-1', generalCommercialTermsApprovalReference: 'owner-general-1' };
    expect(mod.purchasesConfigReady(mod.parsePrivateConfig(approved))).toBe(true);
    for (const change of [{ fiscalApprovalReference: '' }, { commercialTermsApprovalReference: ' ' }, { generalCommercialTermsApprovalReference: '' }, { termsVersion: 'subscription-draft-v1' }]) expect(mod.purchasesConfigReady(mod.parsePrivateConfig({ ...approved, ...change }))).toBe(false);
    expect(mod.purchasesConfigReady(mod.parsePrivateConfig({ ...live, stage: 'test', liveMode: false, apiKey: 'sk_test_synthetic', termsVersion: 'synthetic-draft-v1' }))).toBe(true);
    const f = await fixture(); await f.service.checkout('adult', request());
    const service = new BillingService({ ...f, config: live, purchasesEnabled: async () => false });
    expect((await service.catalog()).purchasesEnabled).toBe(false);
    expect((await service.portal('adult', { commandId: 'portal-approved-independently', expectedBillingRevision: (await f.repository.load('adult')).revision })).outcome).toBe('redirect');
  });
});
