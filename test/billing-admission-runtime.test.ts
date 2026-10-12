import { describe, expect, it, vi } from 'vitest';
import { BillingService } from '../lambda/billing/service';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { config, fixture, request, NOW } from './support/billing-fixture';
import { parsePrivateConfig } from '../lambda/billing/config';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

describe('private admission only controls new individual purchases', () => {
  it.each([undefined, { version: 1, mode: 'cohort', ownerSubs: ['another-adult'] }])('refuses nonadmitted POST before any Stripe call (%j)', async (purchaseAdmission) => {
    const f = await fixture(), provider = f.provider, preflight = vi.spyOn(provider, 'preflight');
    const service = new BillingService({ ...f, config: { ...config, purchaseAdmission } as typeof config, purchasesEnabled: async () => true });
    expect((await service.summary('adult')).canCheckout).toBe(false);
    await expect(service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_DISABLED' });
    expect(preflight).not.toHaveBeenCalled(); expect(provider.customers.size).toBe(0);
  });
  it('shows the public cohort offer, admits its member and leaves Portal usable after sales close', async () => {
    const f = await fixture(), cfg = { ...config, purchaseAdmission: { version: 1, mode: 'cohort', ownerSubs: ['adult'] } } as typeof config;
    const service = new BillingService({ ...f, config: cfg, purchasesEnabled: async () => true });
    expect((await service.catalog()).purchasesEnabled).toBe(true); expect((await service.summary('adult')).canCheckout).toBe(true);
    expect((await service.checkout('adult', request())).outcome).toBe('redirect');
    const closed = new BillingService({ ...f, config: { ...cfg, purchaseAdmission: { version: 1, mode: 'closed' } } as typeof config, purchasesEnabled: async () => true });
    expect((await closed.catalog()).purchasesEnabled).toBe(false); expect((await closed.summary('adult')).canOpenPortal).toBe(true);
    expect((await closed.portal('adult', { commandId: 'portal', expectedBillingRevision: (await f.repository.load('adult')).revision })).outcome).toBe('redirect');
  });
  it('normalizes missing or invalid private admission to closed without disabling financial config', () => {
    const base = { ...config, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'sk_test_fixture', taxRatePercentage: 7.25, purchaseAdmission: undefined };
    expect(parsePrivateConfig(base).purchaseAdmission).toEqual({ version: 1, mode: 'closed' });
    expect(parsePrivateConfig({ ...base, purchaseAdmission: { version: 1, mode: 'general' } }).purchaseAdmission).toEqual({ version: 1, mode: 'closed' });
  });
  it('continues a paginated owner without an active Checkout at the one-minute cadence', async () => {
    const f = await fixture(); await f.service.checkout('adult', request()); const s = await f.repository.load('adult');
    f.repository.states.set('adult', { ...s, activeCommandId: undefined, historyPending: true, nextReconcileAt: NOW });
    const preflight = vi.spyOn(f.provider, 'preflight');
    expect((await f.service.summary('adult')).canCheckout).toBe(false);
    await expect(f.service.checkout('adult', request('fresh', s.revision))).rejects.toMatchObject({ code: 'BILLING_OPERATION_PENDING' }); expect(preflight).not.toHaveBeenCalled();
    const projector = { reconcileOwner: vi.fn(async () => {}) }, worker = { process: async () => {} };
    await new BillingReconciler({ ...f, projector, worker, metric: vi.fn() }).run('pending');
    expect(projector.reconcileOwner).toHaveBeenCalledWith('adult');
  });
});
