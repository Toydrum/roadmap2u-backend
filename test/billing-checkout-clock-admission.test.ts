import {describe, expect, it, vi} from 'vitest';
import {BillingService} from '../lambda/billing/service';
import {BillingProjector} from '../lambda/billing/projection';
import {TEST_CLOCK_EVIDENCE_MAX_AGE_MS} from '../lambda/billing/clock';
import {fixture, config, request, NOW, approvedRetentionPolicy} from './support/billing-fixture';

async function clockFixture() {
  const f = await fixture(), customerId = 'cus_clock_admission';
  const mirror = {pk: 'USER#adult', sk: 'BILLING#TEST_CLOCK', entityType: 'BillingTestClock', ownerSub: 'adult', customerId,
    testClockId: 'clock_admission', bindingId: 'binding-admission', stage: 'dev', stripeAccountId: config.accountId,
    syntheticFixture: 'stripe_clock_dev_monthly', liveMode: false, clockRevision: 1, frozenTimeSeconds: Date.UTC(2027, 11, 31, 12) / 1000,
    providerReadyEvidence: {status: 'ready', customerId, testClockId: 'clock_admission', stripeAccountId: config.accountId,
      liveMode: false, frozenTimeSeconds: Date.UTC(2027, 11, 31, 12) / 1000, observedAt: NOW}};
  const {pk: _pk, sk: _sk, entityType: _entityType, liveMode: _live, providerReadyEvidence: _evidence, ...reference} = mirror;
  f.repository.states.set('adult', {...await f.repository.load('adult'), customerId, testClock: reference});
  f.repository.testClocks.set('adult', mirror);
  f.repository.mappings.set('customer/' + customerId, 'adult');
  f.provider.customers.set(customerId, {id: customerId, ownerSub: 'adult', operationId: 'clock-admission-customer', liveMode: false, country: 'MX', testClockId: mirror.testClockId});
  await new BillingProjector({...f, config, nextWorkerId: () => 'clock-admission-fixture'}).reconcileOwner('adult');
  const state = await f.repository.load('adult');
  expect(state.state).toBe('none');
  return {...f, mirror, customerId, checkout: request('clock-admission-purchase', state.revision)};
}

describe('new Checkout uses the protected clock independently of stale projection', () => {
  it('allows a fresh synthetic clock while session expiry uses operational time', async () => {
    const f = await clockFixture();
    const result = await f.service.checkout('adult', f.checkout);
    expect(result.outcome).toBe('redirect'); expect(f.provider.checkoutCreateCalls).toBe(1);
    expect([...f.provider.checkouts.values()][0].expiresAt).toBe(NOW + 1_860_000);
  });
  it.each([['different', 'clock_other'], ['null', null], ['missing', undefined]])('rejects a %s Customer clock before creating Checkout', async (_, testClockId) => {
    const f = await clockFixture();
    Object.assign(f.provider.customers.get(f.customerId)!, {testClockId});
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('rejects an unbound Customer clock without reading the protected mirror', async () => {
    const f = await fixture(), read = vi.spyOn(f.repository, 'readTestClock'), snapshot = f.provider.snapshot.bind(f.provider);
    vi.spyOn(f.provider, 'snapshot').mockImplementation(async id => {
      const value = await snapshot(id);
      return {...value, customer: {...value.customer, testClockId: 'clock_unbound'}};
    });
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.provider.checkoutCreateCalls).toBe(0); expect(read).not.toHaveBeenCalled();
  });
  it('rejects exactly at evidence expiry before the next reconciliation', async () => {
    const f = await clockFixture(); f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);
    expect((await f.service.summary('adult')).canCheckout).toBe(false);
    expect((await f.repository.load('adult')).state).toBe('none');
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.repository.commands.size).toBe(0); expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it.each(['missing', 'advancing', 'foreign', 'regressive'] as const)('rejects a %s mirror without creating a command', async kind => {
    const f = await clockFixture();
    if (kind === 'missing') f.repository.testClocks.delete('adult');
    else if (kind === 'advancing') f.repository.testClocks.set('adult', {...f.mirror, providerReadyEvidence: {...f.mirror.providerReadyEvidence, status: 'advancing'}});
    else if (kind === 'foreign') f.repository.testClocks.set('adult', {...f.mirror, customerId: 'cus_other'});
    else f.repository.testClocks.set('adult', {...f.mirror, clockRevision: 0});
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.repository.commands.size).toBe(0); expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('rechecks expiry after provider preflight before reserving a new command', async () => {
    const f = await clockFixture();
    vi.spyOn(f.provider, 'preflight').mockImplementation(async () => {f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);});
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.repository.commands.size).toBe(0); expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('fences the exact mirror in command and parameter reservation', async () => {
    const f = await clockFixture(), commit = vi.spyOn(f.repository, 'commit');
    await f.service.checkout('adult', f.checkout);
    const reservations = commit.mock.calls.map(([c]) => c).filter(c => ['billing.checkout_reserved', 'billing.checkout_parameters_reserved'].includes(c.auditAction));
    expect(reservations).toHaveLength(2);
    for (const c of reservations) expect(c.clockObservation?.item).toEqual(f.mirror);
  });
  it('a mirror replacement between observation and reservation prevents a remote session', async () => {
    const f = await clockFixture(), commit = f.repository.commit.bind(f.repository);
    vi.spyOn(f.repository, 'commit').mockImplementation(async c => {
      if (c.auditAction === 'billing.checkout_reserved') f.repository.testClocks.set('adult', {...f.mirror, clockRevision: 2});
      return commit(c);
    });
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_REVISION_CONFLICT'});
    expect(f.repository.commands.size).toBe(0); expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('expiry during provider snapshot prevents the new remote create', async () => {
    const f = await clockFixture(), snapshot = f.provider.snapshot.bind(f.provider);
    vi.spyOn(f.provider, 'snapshot').mockImplementation(async id => {
      const value = await snapshot(id); f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS); return value;
    });
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('never creates with a lease that expired during a protected read after the last state check', async () => {
    const f = await clockFixture(), snapshot = f.provider.snapshot.bind(f.provider), load = f.repository.load.bind(f.repository),
      read = f.repository.readTestClock.bind(f.repository), create = f.provider.createCheckout.bind(f.provider);
    let snapshotFinished = false, latestStateRead = false, invalidCreates = 0;
    vi.spyOn(f.provider, 'snapshot').mockImplementation(async (...args) => {
      const result = await snapshot(...args); snapshotFinished = true; return result;
    });
    vi.spyOn(f.repository, 'load').mockImplementation(async (...args) => {
      const result = await load(...args); if (snapshotFinished) latestStateRead = true; return result;
    });
    vi.spyOn(f.repository, 'readTestClock').mockImplementation(async (...args) => {
      const result = await read(...args); if (latestStateRead) f.setNow(NOW + 60_001); return result;
    });
    vi.spyOn(f.provider, 'createCheckout').mockImplementation(async (...args) => {
      if ((f.repository.states.get('adult')?.leaseUntil ?? 0) <= f.now()) invalidCreates++;
      return create(...args);
    });
    await f.service.checkout('adult', f.checkout);
    expect(invalidCreates).toBe(0);
  });
  it('rechecks evidence expiry synchronously after the final state read', async () => {
    const f = await clockFixture(), snapshot = f.provider.snapshot.bind(f.provider), load = f.repository.load.bind(f.repository);
    f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS - 500);
    let snapshotFinished = false;
    vi.spyOn(f.provider, 'snapshot').mockImplementation(async (...args) => {
      const result = await snapshot(...args); snapshotFinished = true; return result;
    });
    vi.spyOn(f.repository, 'load').mockImplementation(async (...args) => {
      const result = await load(...args); if (snapshotFinished) f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS); return result;
    });
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('keeps cancellation available after clock expiry', async () => {
    const f = await clockFixture(); f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);
    const result = await f.service.portal('adult', {commandId: 'expired-clock-portal', expectedBillingRevision: (await f.repository.load('adult')).revision});
    expect(result.outcome).toBe('redirect'); expect(f.provider.portalCustomers).toEqual([f.customerId]);
  });
  it('recovers a previously created remote session after expiry without creating again', async () => {
    const f = await clockFixture(); f.provider.failAfterCheckout = true;
    expect((await f.service.checkout('adult', f.checkout)).outcome).toBe('pending');
    expect(f.provider.checkoutCreateCalls).toBe(1);
    f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);
    expect((await f.service.checkout('adult', f.checkout)).outcome).toBe('redirect');
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });
  it('does not create a previously reserved but absent remote session after expiry', async () => {
    const f = await clockFixture();
    const failed = vi.spyOn(f.provider, 'createCheckout').mockRejectedValueOnce(Error('provider stopped before create'));
    expect((await f.service.checkout('adult', f.checkout)).outcome).toBe('pending');
    expect(f.provider.checkouts.size).toBe(0); failed.mockRestore();
    f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);
    await expect(f.service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('applies the same expired-source rule in TEST', async () => {
    const f = await clockFixture(), state = await f.repository.load('adult');
    const mirror = {...f.mirror, stage: 'test', syntheticFixture: 'stripe_clock_test_monthly'};
    f.repository.testClocks.set('adult', mirror);
    f.repository.states.set('adult', {...state, testClock: {...state.testClock!, stage: 'test', syntheticFixture: mirror.syntheticFixture}});
    f.setNow(NOW + TEST_CLOCK_EVIDENCE_MAX_AGE_MS);
    const service = new BillingService({...f, config: {...config, stage: 'test'}, purchasesEnabled: async () => true});
    await expect(service.checkout('adult', f.checkout)).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(f.repository.commands.size).toBe(0); expect(f.provider.checkoutCreateCalls).toBe(0);
  });
  it('ordinary purchases do not read a test clock or add a clock condition', async () => {
    const f = await fixture(), read = vi.spyOn(f.repository, 'readTestClock').mockRejectedValue(Error('unexpected protected read'));
    const commit = vi.spyOn(f.repository, 'commit');
    expect((await f.service.checkout('adult', request())).outcome).toBe('redirect');
    expect(read).not.toHaveBeenCalled(); expect(commit.mock.calls.every(([c]) => c.clockObservation === undefined)).toBe(true);
  });
  it('a marked PROD restore is rejected without reading the protected mirror', async () => {
    const f = await clockFixture(), read = vi.spyOn(f.repository, 'readTestClock');
    const service = new BillingService({...f, config: {...config, stage: 'prod', liveMode: true, termsVersion: 'approved',
      fiscalApprovalReference: 'fiscal', commercialTermsApprovalReference: 'subscription', generalCommercialTermsApprovalReference: 'general', financialRetentionPolicy: approvedRetentionPolicy}, purchasesEnabled: async () => true});
    await expect(service.checkout('adult', {...f.checkout, termsAcceptance: {...f.checkout.termsAcceptance, version: 'approved'}})).rejects.toMatchObject({code: 'BILLING_PAYMENT_REVIEW'});
    expect(read).not.toHaveBeenCalled(); expect(f.provider.checkoutCreateCalls).toBe(0); expect(f.repository.commands.size).toBe(0);
  });
});
