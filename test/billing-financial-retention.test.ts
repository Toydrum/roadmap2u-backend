import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import Stripe from 'stripe';
import { parsePrivateConfig, purchasesConfigReady } from '../lambda/billing/config';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { initialState, STRIPE_API_VERSION, type BillingCommand, type InvoiceReceipt } from '../lambda/billing/model';
import { BillingService } from '../lambda/billing/service';
import { config, fixture, request } from './support/billing-fixture';

const documentSha256 = createHash('sha256').update(readFileSync(new URL('../docs/financial-retention-policy.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const binding = { version: 'mx-financial-2026-10-22-v1', documentSha256, approvalReference: 'owner-design-approval-2026-10-22', status: 'approved' as const };
const live = { ...config, stage: 'prod', liveMode: true, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'rk_live_synthetic', taxRatePercentage: 16, fiscalApprovalReference: 'owner-fiscal', commercialTermsApprovalReference: 'owner-subscription', generalCommercialTermsApprovalReference: 'owner-general' };
const approvedMetadata = { retentionScope: 'commercial', retentionPolicyVersion: binding.version, retentionPolicySha256: documentSha256, retentionApprovalReference: binding.approvalReference, retentionStatus: 'classification_required' };
let ddb: AwsClientStub<DynamoDBDocumentClient>, ssm: AwsClientStub<SSMClient>, sqs: AwsClientStub<SQSClient>;
beforeEach(() => {
  ddb = mockClient(DynamoDBDocumentClient); ssm = mockClient(SSMClient); sqs = mockClient(SQSClient);
  ddb.on(GetCommand).resolves({}); ddb.on(PutCommand).resolves({}); ddb.on(TransactWriteCommand).resolves({});
  sqs.on(SendMessageCommand).resolves({});
});
afterEach(() => { ddb.restore(); ssm.restore(); sqs.restore(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('production financial retention is an independent purchase precondition', () => {
  it('closes otherwise approved live sales when the policy is absent', () => {
    expect(purchasesConfigReady(parsePrivateConfig(live))).toBe(false);
  });
  it.each([
    null, [], {},
    { ...binding, version: 'unknown-policy' },
    { ...binding, documentSha256: '0'.repeat(64) },
    { ...binding, status: 'withdrawn' },
    { ...binding, status: 'draft' },
    { ...binding, approvalReference: '' },
    { ...binding, approvalReference: 'owner-draft-approval' },
    { ...binding, approvalReference: 'bad\nreference' },
  ])('rejects an unapproved or divergent policy without disabling financial configuration: %j', (financialRetentionPolicy) => {
    const parsed = parsePrivateConfig({ ...live, financialRetentionPolicy });
    expect(purchasesConfigReady(parsed)).toBe(false);
  });
  it('admits only the exact document and preserves the other approval gates', () => {
    const approved = { ...live, financialRetentionPolicy: binding };
    expect(purchasesConfigReady(parsePrivateConfig(approved))).toBe(true);
    for (const change of [{ fiscalApprovalReference: '' }, { termsVersion: 'terms-draft' }, { catalogVersion: 'unknown' }]) {
      expect(purchasesConfigReady(parsePrivateConfig({ ...approved, ...change }))).toBe(false);
    }
  });
  it('keeps Portal cancellation available after approval withdrawal', async () => {
    const f = await fixture(); await f.service.checkout('adult', request());
    const service = new BillingService({ ...f, config: parsePrivateConfig({ ...live, financialRetentionPolicy: { ...binding, status: 'withdrawn' } }), purchasesEnabled: async () => true });
    expect((await service.catalog()).purchasesEnabled).toBe(false);
    expect((await service.portal('adult', { commandId: 'cancel-after-withdrawal', expectedBillingRevision: (await f.repository.load('adult')).revision })).outcome).toBe('redirect');
  });
});

describe('financial writers bind policy without inventing document expiry', () => {
  it('uses the same exact metadata for all eight financial writer categories', async () => {
    const repository = new DynamoBillingRepository({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'roadmap', accountId: 'acct_fixture', stage: 'prod', liveMode: true, financialRetentionPolicy: binding });
    const command: BillingCommand = { ownerSub: 'adult', commandId: 'purchase-1', kind: 'checkout', fingerprint: 'fixture', operationId: 'op_fixture', createdAt: 100, updatedAt: 100, status: 'reserved', customerKey: 'customer', customerParams: { ownerSub: 'adult', operationId: 'op_fixture' }, checkoutKey: 'checkout' };
    const invoice: InvoiceReceipt = { ownerSub: 'adult', invoiceId: 'in_fixture', subscriptionId: 'sub_fixture', customerId: 'cus_fixture', start: 100, end: 200, interval: 'month', amountPaid: 11484, currency: 'mxn', valid: true, suspended: false, refunded: 0, reviewReasons: [], verifiedAt: 100, paymentIds: [], paidAt: 100, priceId: 'price_month', productId: 'prod_individual', taxRateId: 'txr_fixture', chargeIds: [] };
    await repository.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1, updatedAt: 100 }, command, invoices: [invoice], mappings: [{ kind: 'customer', id: 'cus_fixture' }], guard: 'none', auditAction: 'billing.test' });
    await repository.putEvent({ eventId: 'evt_fixture', type: 'invoice.paid', objectId: 'in_fixture', objectType: 'invoice', apiVersion: STRIPE_API_VERSION, liveMode: true, accountId: 'acct_fixture', status: 'pending', attempts: 0, receivedAt: 100, nextAttemptAt: 100 });
    await repository.saveCursor('owners', { pk: 'fixture' });
    await repository.saveHistoryCursor('history', { items: [] }, { ownerSub: 'adult', owner: 'worker', revision: 1, now: 100 });
    const items = [
      ...ddb.commandCalls(TransactWriteCommand).flatMap((c) => c.args[0].input.TransactItems!.flatMap((tx) => tx.Put ? [tx.Put.Item!] : [])),
      ...ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item!),
    ];
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item).toMatchObject(approvedMetadata);
      for (const field of ['ttl', 'retainUntil', 'deleteAt', 'fiscalDeclarationAt', 'data', 'profile', 'notes']) expect(item).not.toHaveProperty(field);
    }
  });
  it('keeps historical DEV and TEST writers in their original draft scope', async () => {
    for (const stage of ['dev', 'test']) {
      const repository = new DynamoBillingRepository({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'roadmap', accountId: 'acct_fixture', stage, liveMode: false, financialRetentionPolicy: binding });
      await repository.saveCursor(stage);
    }
    for (const call of ddb.commandCalls(PutCommand)) expect(call.args[0].input.Item).toMatchObject({ retentionPolicyVersion: 'financial-v1-draft', retentionStatus: 'pending_policy_approval' });
  });
  it('allows recovery writes when a live approval was withdrawn', async () => {
    const repository = new DynamoBillingRepository({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'roadmap', accountId: 'acct_fixture', stage: 'prod', liveMode: true, financialRetentionPolicy: { ...binding, status: 'withdrawn' } });
    await expect(repository.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1, updatedAt: 100 }, guard: 'none', auditAction: 'billing.recovered' })).resolves.toBe(true);
    for (const tx of ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!) {
      if (tx.Put) expect(tx.Put.Item).toMatchObject(approvedMetadata);
    }
  });
  it('passes the configured binding through the deployed billing runtime', async () => {
    vi.stubEnv('STAGE', 'prod'); vi.stubEnv('TABLE_NAME', 'roadmap'); vi.stubEnv('STRIPE_CONFIG_PARAMETER', '/roadmap2u/prod/stripe/config');
    ssm.on(GetParameterCommand).resolves({ Parameter: { Type: 'SecureString', Value: JSON.stringify({ ...live, financialRetentionPolicy: binding }) } });
    const runtime = await (await import('../lambda/billing/runtime')).createBillingRuntime();
    await runtime.repository.saveCursor('owners');
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject(approvedMetadata);
  });
  it('does not mix fallback draft metadata with a stale approval when rewriting stored state', async () => {
    const repository = new DynamoBillingRepository({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'roadmap', accountId: 'acct_fixture', stage: 'prod', liveMode: true });
    const state = { ...initialState('adult'), ...approvedMetadata, revision: 2, updatedAt: 100 };
    await repository.commit({ expectedRevision: 1, state, guard: 'none', auditAction: 'billing.recovered' });
    const stored = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put!.Item!;
    expect(stored).toMatchObject({ retentionPolicyVersion: 'financial-v1-draft', retentionStatus: 'pending_policy_approval' });
    expect(stored).not.toHaveProperty('retentionPolicySha256');
    expect(stored).not.toHaveProperty('retentionApprovalReference');
  });
  it('passes the webhook binding into a minimal signed inbox event', async () => {
    vi.stubEnv('STAGE', 'prod'); vi.stubEnv('TABLE_NAME', 'roadmap'); vi.stubEnv('STRIPE_WEBHOOK_SECRET_PARAMETER', '/roadmap2u/prod/stripe/webhook-secret'); vi.stubEnv('BILLING_EVENT_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/synthetic');
    const secret = 'whsec_synthetic_retention_fixture';
    ssm.on(GetParameterCommand).resolves({ Parameter: { Type: 'SecureString', Value: JSON.stringify({ secret, accountId: 'acct_fixture', liveMode: true, stage: 'prod', apiVersion: STRIPE_API_VERSION, financialRetentionPolicy: binding }) } });
    const payload = JSON.stringify({ id: 'evt_Retention', type: 'invoice.paid', api_version: STRIPE_API_VERSION, livemode: true, data: { object: { id: 'in_fixture', object: 'invoice', unnecessary_personal_data: 'never persist' } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const response = await (await import('../lambda/billing/webhook')).handler({ body: payload, headers: { 'stripe-signature': signature } } as never);
    expect(response.statusCode).toBe(200);
    const stored = ddb.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(stored).toMatchObject(approvedMetadata);
    expect(JSON.stringify(stored)).not.toContain('unnecessary_personal_data');
    expect(stored).not.toHaveProperty('data');
  });
});
