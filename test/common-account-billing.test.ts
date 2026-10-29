import { describe, expect, it } from 'vitest';
import { GetCommand, TransactWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { fixture, request } from './support/billing-fixture';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { initialState, type BillingActor } from '../lambda/billing/model';
import { commonPrivacyDocumentHash } from '../lambda/privacy/consent';
import { BillingService } from '../lambda/billing/service';
import { config } from './support/billing-fixture';

const commonActor = (): BillingActor => ({
  ownerSub: 'adult', accountType: 'adult', status: 'active', emailVerified: true,
  adultDeclarationCurrent: false, accountTermsCurrent: true,
  privacyRevision: 2, accountTermsHash: 'c'.repeat(64),
});

describe('standard own-account commercial admission', () => {
  it('loads common account terms proof from the canonical privacy state without adult evidence', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})); const mock = mockClient(ddb);
    mock.on(GetCommand).callsFake((input) => ({ Item: input.Key?.sk === 'PROFILE'
      ? { pk: 'USER#adult', sk: 'PROFILE', userId: 'adult', accountType: 'adult', email: 'common@example.com' }
      : input.Key?.sk === 'PRIVACY#ADULT' ? { pk: 'USER#adult', sk: 'PRIVACY#ADULT', userId: 'adult', revision: 2, updatedAt: 100, cloudConsent: 'absent', erasure: 'none', accountTermsAcceptedAt: 100, accountTermsLanguage: 'es', accountTermsDocumentHash: commonPrivacyDocumentHash('es') } : undefined }));
    const r = new DynamoBillingRepository({ ddb, table: 'roadmap', accountId: 'acct_fixture', stage: 'dev', liveMode: false, authenticatedOwner: { ownerSub: 'adult', emailVerified: true } });
    expect(await r.actor('adult')).toMatchObject({ adultDeclarationCurrent: false, accountTermsCurrent: true, accountTermsHash: commonPrivacyDocumentHash('es'), privacyRevision: 2, emailVerified: true });
    mock.restore();
  });
  it('lets a verified common account buy without an adult declaration or cloud consent', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    expect((await f.service.summary('adult')).canCheckout).toBe(true);
    expect((await f.service.checkout('adult', request())).outcome).toBe('redirect');
    expect(f.provider.checkouts.size).toBe(1);
    expect(f.repository.sources.size).toBe(0);
    expect((await f.repository.command('adult', 'purchase-1'))?.consent).toMatchObject({ acceptedAt: f.now() });
  });

  it('resumes a reserved common purchase using verified reservation evidence and current terms', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    f.provider.failAfterCustomer = true;
    expect((await f.service.checkout('adult', request())).outcome).toBe('pending');
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    f.repository.actors.get('adult')!.emailVerified = false;
    f.provider.failAfterCustomer = false;
    expect((await f.service.resumeCheckout('adult', command)).outcome).toBe('redirect');
    expect(f.provider.checkouts.size).toBe(1);
  });

  it.each([{ accountTermsCurrent: false }, { accountType: 'minor' }, { privacyMode: 'adolescent_private' }, { emailVerified: false }, { closing: true }])('rejects canonical ineligibility: %j', async (change) => {
    const f = await fixture(); f.repository.actors.set('adult', { ...commonActor(), ...change });
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(f.provider.customers.size).toBe(0);
  });

  it('rejects a withdrawn/replaced common admission before asynchronous provider checkout', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    f.provider.failAfterCustomer = true;
    await f.service.checkout('adult', request());
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    f.repository.actors.get('adult')!.accountTermsCurrent = false;
    await expect(f.service.resumeCheckout('adult', command)).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(f.provider.checkouts.size).toBe(0);
  });

  it('fences common terms hash/revision and ordinary profile in every standard transaction', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const mock = mockClient(ddb); mock.on(GetCommand).resolves({}); mock.on(TransactWriteCommand).resolves({});
    const r = new DynamoBillingRepository({ ddb, table: 'roadmap', accountId: 'acct_fixture', stage: 'dev', liveMode: false });
    expect(await r.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1 }, guard: 'standard', actor: commonActor(), auditAction: 'billing.checkout_reserved' })).toBe(true);
    const tx = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const privacy = tx.find((item) => item.ConditionCheck?.Key?.sk === 'PRIVACY#ADULT')!.ConditionCheck!;
    expect(privacy.ConditionExpression).toContain('accountTermsDocumentHash');
    expect(privacy.ExpressionAttributeValues).toMatchObject({ ':privacyRevision': 2, ':termsHash': 'c'.repeat(64) });
    expect(JSON.stringify(tx)).not.toContain('adultDeclaredAt');
    expect(JSON.stringify(tx)).toContain('attribute_not_exists(privacyMode)');
    mock.restore();
  });

  it('does not commit common checkout after its observed admission revision changes', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    const observed = await f.repository.actor('adult');
    f.repository.actors.get('adult')!.privacyRevision = 3;
    expect(await f.repository.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1 }, guard: 'standard', actor: observed!, auditAction: 'billing.checkout_reserved' })).toBe(false);
  });

  it('rechecks account admission after provider observation before creating checkout', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    const snapshot = f.provider.snapshot.bind(f.provider);
    f.provider.snapshot = async (...args) => { const result = await snapshot(...args); f.repository.actors.get('adult')!.accountTermsCurrent = false; return result; };
    await expect(f.service.checkout('adult', request())).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(f.provider.checkouts.size).toBe(0);
  });

  it('recovers pending commands with their reserved older subscription consent after configuration changes', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    f.provider.failAfterCheckout = true; await f.service.checkout('adult', request());
    const command = (await f.repository.command('adult', 'purchase-1'))!;
    const service = new BillingService({ ...f, config: { ...config, termsVersion: 'replacement-current', termsHashes: { es: 'd'.repeat(64), en: 'e'.repeat(64) } }, purchasesEnabled: async () => false });
    expect((await service.resumeCheckout('adult', command)).outcome).toBe('redirect');
    expect((await f.repository.command('adult', 'purchase-1'))?.consent).toEqual(command.consent);
    expect(f.provider.checkouts.size).toBe(1);
  });

  it('preserves Portal when standard terms need review and purchases are closed', async () => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor());
    await f.service.checkout('adult', request());
    f.repository.actors.get('adult')!.accountTermsCurrent = false; f.setEnabled(false);
    const s = await f.service.summary('adult');
    expect(s.canCheckout).toBe(false); expect(s.canOpenPortal).toBe(true);
    expect((await f.service.portal('adult', { commandId: 'portal-common', expectedBillingRevision: s.revision })).outcome).toBe('redirect');
  });

  it.each([{ status: 'closing' }, { closing: true }, { privacyMode: 'adolescent_private' }])('advertises the same Portal lifecycle permission it actually enforces: %j', async (change) => {
    const f = await fixture(); f.repository.actors.set('adult', commonActor()); await f.service.checkout('adult', request());
    Object.assign(f.repository.actors.get('adult')!, change);
    const summary = await f.service.summary('adult'); expect(summary.canOpenPortal).toBe(false);
    await expect(f.service.portal('adult', { commandId: 'portal-denied', expectedBillingRevision: summary.revision })).rejects.toMatchObject({ code: 'BILLING_BUYER_INELIGIBLE' });
    expect(f.provider.portalCustomers).toHaveLength(0);
  });
});
