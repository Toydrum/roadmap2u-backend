import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { BillingClosure } from '../lambda/billing/closure';
import type { BillingCommit } from '../lambda/billing/model';
import { fixture, config, NOW, request } from './support/billing-fixture';

// Model the asynchronous completion of DynamoDB writes without replacing the
// repository's revision, ownership or lease checks with unconditional success.
function asynchronousWrites(repository: Awaited<ReturnType<typeof fixture>>['repository'], failAction?: string) {
  const commit = repository.commit.bind(repository);
  repository.commit = async (value: BillingCommit) => {
    await setImmediate();
    if (value.auditAction === failAction) throw new Error('synthetic storage response failure');
    return commit(value);
  };
}

describe('financial completion retains its lease until the write settles', () => {
  it('durably binds a newly created Checkout before releasing the lease', async () => {
    const f = await fixture();
    asynchronousWrites(f.repository);
    expect(await f.service.checkout('adult', request())).toMatchObject({ outcome: 'redirect', commandId: 'purchase-1' });
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'redirect', sessionId: 'cs_1' });
    expect(await f.repository.mappedOwner('checkout', 'cs_1')).toBe('adult');
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });

  it('binds an existing remote Checkout on recovery without another create', async () => {
    const f = await fixture();
    f.provider.failAfterCheckout = true;
    expect(await f.service.checkout('adult', request())).toMatchObject({ outcome: 'pending' });
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    asynchronousWrites(f.repository);
    expect(await f.service.resumeCheckout('adult', command)).toMatchObject({ outcome: 'redirect' });
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'redirect', sessionId: 'cs_1', checkoutKey: command.checkoutKey, checkoutParams: command.checkoutParams });
    expect(f.provider.checkoutCreateCalls).toBe(1);
    expect(f.provider.checkouts.size).toBe(1);
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
  });

  it('persists review before rejecting duplicate customers', async () => {
    const f = await fixture();
    for (const id of ['cus_1', 'cus_2']) f.provider.customers.set(id, { id, ownerSub: 'adult', operationId: 'synthetic-customer-operation', liveMode: false, country: 'MX' });
    asynchronousWrites(f.repository);
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_PAYMENT_REVIEW' });
    expect(await f.repository.load('adult')).toMatchObject({ state: 'payment_review', reviewReasons: ['duplicate_customer'] });
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });

  it('persists expiry of an old customer-only reservation without creating Checkout', async () => {
    const f = await fixture();
    f.provider.failAfterCustomer = true;
    await f.service.checkout('adult', request());
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    f.setNow(NOW + 23 * 3_600_000 + 1);
    asynchronousWrites(f.repository);
    expect(await f.service.resumeCheckout('adult', command)).toMatchObject({ outcome: 'pending' });
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'expired', recoveryEvidence: { reason: 'no_checkout_authorized' } });
    expect(await f.repository.load('adult')).toMatchObject({ state: 'none' });
    expect((await f.repository.load('adult')).activeCommandId).toBeUndefined();
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
    expect(f.provider.checkoutCreateCalls).toBe(0);
  });

  it('handles a failed completion write while the lease still protects the uncertainty journal', async () => {
    const f = await fixture();
    asynchronousWrites(f.repository, 'billing.checkout_observed');
    await expect(f.service.checkout('adult', request())).resolves.toMatchObject({ outcome: 'pending' });
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'uncertain' });
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });

  it('keeps the existing fence when another worker actually replaces the lease', async () => {
    const f = await fixture();
    const create = f.provider.createCheckout.bind(f.provider);
    f.provider.createCheckout = async (...args) => {
      const session = await create(...args);
      const state = await f.repository.load('adult');
      f.repository.states.set('adult', { ...state, leaseOwner: 'other-worker', leaseRevision: (state.leaseRevision ?? 0) + 1, leaseUntil: NOW + 60_000 });
      return session;
    };
    asynchronousWrites(f.repository);
    expect(await f.service.checkout('adult', request())).toMatchObject({ outcome: 'pending' });
    expect((await f.repository.command('adult', 'purchase-1'))?.sessionId).toBeUndefined();
    expect((await f.repository.load('adult')).leaseOwner).toBe('other-worker');
    expect(f.provider.checkoutCreateCalls).toBe(1);
  });

  it('persists verified account closure before releasing the financial lease', async () => {
    const f = await fixture();
    await f.service.checkout('adult', request());
    asynchronousWrites(f.repository);
    const closer = new BillingClosure({ ...f, config, nextWorkerId: () => 'closure-worker' });
    expect(await closer.resolve('adult', 'closure-1')).toBe(true);
    expect(await f.repository.load('adult')).toMatchObject({ state: 'closed', closingId: 'closure-1', closedAt: NOW });
    expect(await f.repository.command('adult', 'purchase-1')).toMatchObject({ status: 'expired' });
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
  });

  it('keeps account closure blocked when its asynchronous final write fails', async () => {
    const f = await fixture();
    await f.service.checkout('adult', request());
    asynchronousWrites(f.repository, 'billing.closure_verified');
    const closer = new BillingClosure({ ...f, config, nextWorkerId: () => 'closure-worker' });
    await expect(closer.resolve('adult', 'closure-1')).resolves.toBe(false);
    expect((await f.repository.load('adult')).closedAt).toBeUndefined();
    expect((await f.repository.load('adult')).closingId).toBe('closure-1');
    expect((await f.repository.load('adult')).leaseOwner).toBeUndefined();
  });
});
