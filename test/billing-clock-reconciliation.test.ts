import { describe, expect, it, vi } from 'vitest';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { initialState, type BillingCommand } from '../lambda/billing/model';
import { config, fixture, NOW } from './support/billing-fixture';

async function setup(stage = 'dev', marked = true) {
  const f = await fixture(), cfg = { ...config, stage };
  const customerId = 'cus_cadence', testClockId = 'clock_cadence';
  const reference = { ownerSub: 'adult', customerId, testClockId, bindingId: 'cadence_binding',
    stage, stripeAccountId: cfg.accountId, syntheticFixture: `stripe_clock_${stage}_cadence`,
    clockRevision: 2, frozenTimeSeconds: NOW / 1000 };
  const mirror = { ...reference, pk: 'USER#adult', sk: 'BILLING#TEST_CLOCK', entityType: 'BillingTestClock', liveMode: false,
    providerReadyEvidence: { status: 'ready', customerId, testClockId, stripeAccountId: cfg.accountId,
      liveMode: false, frozenTimeSeconds: reference.frozenTimeSeconds, observedAt: NOW - 900001 } };
  f.provider.customers.set(customerId, { id: customerId, ownerSub: 'adult', operationId: 'cadence', liveMode: false,
    country: null, ...(marked ? { testClockId } : {}) });
  f.repository.states.set('adult', { ...initialState('adult'), revision: 1, customerId, ...(marked ? { testClock: reference } : {}) });
  f.repository.testClocks.set('adult', mirror);
  const projector = new BillingProjector({ ...f, config: cfg, nextWorkerId: () => 'cadence-worker' });
  const worker = { process: async () => {} }, metric = vi.fn();
  const reconciler = new BillingReconciler({ ...f, config: cfg, projector, worker, metric });
  await projector.reconcileOwner('adult');
  const publish = (revision: number, observedAt: number) => {
    const fresh = { ...mirror, clockRevision: revision, providerReadyEvidence: { ...mirror.providerReadyEvidence, observedAt } };
    f.repository.testClocks.set('adult', fresh); return fresh;
  };
  return { ...f, config: cfg, projector, worker, metric, reconciler, publish };
}

describe('prebound synthetic clock reconciliation cadence', () => {
  it.each(['dev', 'test'])('wakes a fresh %s mirror at one minute, then holds STATE stable until the next publication', async stage => {
    const f = await setup(stage), before = await f.repository.load('adult');
    expect(before).toMatchObject({ state: 'payment_review', reviewReasons: ['test_clock_unavailable'], nextReconcileAt: NOW + 60000 });
    const provider = vi.spyOn(f.provider, 'snapshot');
    f.publish(3, NOW + 10000); expect(await f.repository.load('adult')).toEqual(before);
    f.setNow(NOW + 60000);
    expect(await f.reconciler.run('pending')).toEqual({ processed: 1, failed: 0 });
    const ready = await f.repository.load('adult');
    expect(ready).toMatchObject({ state: 'none', reviewReasons: [], nextReconcileAt: NOW + 120000, testClock: { clockRevision: 3 } });
    expect(provider).toHaveBeenCalledTimes(1);
    f.setNow(NOW + 120000);
    expect(await f.reconciler.run('pending')).toEqual({ processed: 0, failed: 0 });
    expect(await f.repository.load('adult')).toEqual(ready); expect(provider).toHaveBeenCalledTimes(1);
    f.publish(4, NOW + 125000); f.setNow(NOW + 180000);
    expect(await f.reconciler.run('pending')).toEqual({ processed: 1, failed: 0 });
    expect(await f.repository.load('adult')).toMatchObject({ state: 'none', testClock: { clockRevision: 4 } });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('does not churn the native STATE revision while evidence remains stale', async () => {
    const f = await setup(), before = await f.repository.load('adult');
    expect(before.nextReconcileAt).toBe(NOW + 60000);
    const provider = vi.spyOn(f.provider, 'snapshot'), commit = vi.spyOn(f.repository, 'commit');
    for (const ms of [60000, 120000, 180000]) {
      f.setNow(NOW + ms); expect(await f.reconciler.run('pending')).toEqual({ processed: 0, failed: 0 });
      expect(await f.repository.load('adult')).toEqual(before);
    }
    expect(provider).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it.each(['dev', 'test', 'prod'])('keeps ordinary %s owners on fifteen minutes without mirror reads', async stage => {
    const f = await setup(stage, false), state = await f.repository.load('adult');
    expect(state.nextReconcileAt).toBe(NOW + 900000);
    f.repository.states.set('adult', { ...state, nextReconcileAt: NOW });
    const read = vi.spyOn(f.repository, 'readTestClock'); f.setNow(NOW + 60000);
    expect(await f.reconciler.run('pending')).toEqual({ processed: 0, failed: 0 }); expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['PROD', { stage: 'prod' }], ['live', { liveMode: true }], ['owner', { reference: { ownerSub: 'other' } }],
    ['customer', { reference: { customerId: 'cus_other' } }], ['account', { reference: { stripeAccountId: 'acct_other' } }],
    ['stage', { reference: { stage: 'test' } }], ['fixture', { reference: { syntheticFixture: 'ordinary' } }],
  ] as const)('does not consult a protected mirror for %s context', async (_label, change) => {
    const f = await setup(), state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, nextReconcileAt: NOW,
      testClock: { ...state.testClock!, ...('reference' in change ? change.reference : {}) } });
    const cfg = { ...f.config, ...('stage' in change ? { stage: change.stage } : {}), ...('liveMode' in change ? { liveMode: change.liveMode } : {}) };
    const read = vi.spyOn(f.repository, 'readTestClock'); f.setNow(NOW + 60000);
    expect(await new BillingReconciler({ ...f, config: cfg }).run('pending')).toEqual({ processed: 0, failed: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it('closes the fast path when the trusted runtime config is absent', async () => {
    const f = await setup(), state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, nextReconcileAt: NOW }); f.publish(3, NOW + 10000); f.setNow(NOW + 60000);
    const read = vi.spyOn(f.repository, 'readTestClock');
    expect(await new BillingReconciler({ ...f, config: undefined }).run('pending')).toEqual({ processed: 0, failed: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it('contains a mirror-read failure to its owner and completes the existing cursor cycle', async () => {
    const f = await setup(), state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, nextReconcileAt: NOW }); f.setNow(NOW + 60000);
    const read = vi.spyOn(f.repository, 'readTestClock').mockRejectedValue(new Error('synthetic mirror unavailable'));
    expect(await f.reconciler.run('pending')).toEqual({ processed: 0, failed: 1 });
    expect(read).toHaveBeenCalledTimes(1); expect(f.metric).toHaveBeenCalledWith('StripeError');
    expect(await f.repository.readCursor('pending-owners')).toBeUndefined();
    expect(await f.repository.load('adult')).toEqual({ ...state, nextReconcileAt: NOW });
  });

  it('preserves existing command recovery without requiring a protected mirror read first', async () => {
    const f = await setup(), state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, activeCommandId: 'existing', nextReconcileAt: NOW });
    const command = { commandId: 'existing' } as BillingCommand;
    vi.spyOn(f.repository, 'command').mockResolvedValue(command);
    const resumeCheckout = vi.fn(async () => ({ outcome: 'pending' as const, commandId: 'existing', billingRevision: state.revision, retryAfterMs: 1000 }));
    const read = vi.spyOn(f.repository, 'readTestClock').mockRejectedValue(new Error('synthetic mirror unavailable'));
    f.setNow(NOW + 60000);
    expect(await new BillingReconciler({ ...f, service: { resumeCheckout } }).run('pending')).toEqual({ processed: 1, failed: 0 });
    expect(resumeCheckout).toHaveBeenCalledWith('adult', command); expect(read).not.toHaveBeenCalled();
  });

  it('preserves existing paginated-history recovery without a new preliminary mirror read', async () => {
    const f = await setup(), state = await f.repository.load('adult');
    f.repository.states.set('adult', { ...state, historyPending: true, nextReconcileAt: NOW });
    const reconcileOwner = vi.fn(async () => {});
    const read = vi.spyOn(f.repository, 'readTestClock').mockRejectedValue(new Error('synthetic mirror unavailable'));
    f.setNow(NOW + 60000);
    expect(await new BillingReconciler({ ...f, projector: { reconcileOwner } }).run('pending')).toEqual({ processed: 1, failed: 0 });
    expect(reconcileOwner).toHaveBeenCalledWith('adult'); expect(read).not.toHaveBeenCalled();
  });
});
