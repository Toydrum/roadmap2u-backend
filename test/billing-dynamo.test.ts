import { describe, expect, it } from 'vitest';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { initialState } from '../lambda/billing/model';

async function fixture() {
  const mod = await import('../lambda/billing/dynamo').catch(() => null);
  expect(mod, 'financial DynamoDB adapter exists').not.toBeNull();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const mock = mockClient(ddb);
  mock.on(GetCommand).resolves({}); mock.on(TransactWriteCommand).resolves({});
  mock.on(UpdateCommand).resolves({}); mock.on(PutCommand).resolves({});
  return { repository: new mod!.DynamoBillingRepository({ ddb, table: 'roadmap', accountId: 'acct_fixture', stage: 'dev', liveMode: false }), mock };
}
describe('billing durable storage fencing', () => {
  it('commits a history page and cursor only under the current unexpired owner lease', async () => {
    const { repository, mock } = await fixture();
    await repository.saveHistoryCursor('history:fixture:invoices:0', { items: [] }, { ownerSub: 'adult', owner: 'worker', revision: 4, now: 100 });
    const tx = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].ConditionCheck).toMatchObject({ Key: { pk: 'BILLING#adult', sk: 'STATE' }, ExpressionAttributeValues: { ':owner': 'worker', ':revision': 4, ':now': 100 } });
    expect(tx[0].ConditionCheck?.ConditionExpression).toContain('leaseUntil > :now');
    expect(tx[1].Put?.Item).toMatchObject({ pk: 'BILLING#RECONCILER#dev', sk: 'CURSOR#history:fixture:invoices:0' });
    mock.on(TransactWriteCommand).rejects(Object.assign(new Error('old worker'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }));
    await expect(repository.saveHistoryCursor('history:fixture', { after: 'in_old' }, { ownerSub: 'adult', owner: 'old', revision: 3, now: 200 })).rejects.toMatchObject({ continuation: true });
  });
  it('atomically fences financial projection, adult profile, closure, mapping ownership and audit', async () => {
    const { repository, mock } = await fixture();
    const state = { ...initialState('adult'), revision: 1, updatedAt: 100, customerId: 'cus_1' };
    expect(await repository.commit({ expectedRevision: 0, state, guard: 'adult', actor: { ownerSub: 'adult', accountType: 'adult', status: 'active', emailVerified: true, adultDeclarationCurrent: true, privacyRevision: 4, declarationHash: 'a'.repeat(64) }, mappings: [{ kind: 'customer', id: 'cus_1' }], auditAction: 'billing.customer_bound' })).toBe(true);
    const tx = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const encoded = JSON.stringify(tx);
    expect(encoded).toContain('ACCOUNT_CLOSURE#adult');
    expect(encoded).toContain('accountType = :adult');
    expect(encoded).toContain('PRIVACY#ADULT');
    expect(encoded).toContain('declarationDocumentHash');
    expect(encoded).toContain('attribute_not_exists(ownerSub) OR ownerSub = :owner');
    expect(encoded).toContain('AUDIT#');
    expect(encoded).toContain('commercial');
    expect(encoded).not.toContain('"ttl"');
    expect(tx.some((x) => x.Put?.Item?.['pk'] === 'BILLING#adult' && x.Put?.ConditionExpression?.includes('attribute_not_exists(pk)'))).toBe(true);
  });
  it('does not convert infrastructure errors into a revision conflict', async () => {
    const { repository, mock } = await fixture();
    mock.on(TransactWriteCommand).rejects({ name: 'ProvisionedThroughputExceededException' });
    await expect(repository.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1 }, guard: 'none', auditAction: 'billing.test' })).rejects.toMatchObject({ name: 'ProvisionedThroughputExceededException' });
    mock.on(TransactWriteCommand).rejects(Object.assign(new Error('conditional conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }));
    expect(await repository.commit({ expectedRevision: 0, state: { ...initialState('adult'), revision: 1 }, guard: 'none', auditAction: 'billing.test' })).toBe(false);
  });
  it('queries due work by index with cursor and time bound, never a table scan', async () => {
    const { repository, mock } = await fixture();
    const cursor = { pk: 'STRIPE_EVENT#old', sk: 'EVENT' };
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: cursor });
    expect((await repository.due('events', 100, cursor, 7)).cursor).toEqual(cursor);
    const input = mock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input).toMatchObject({ IndexName: 'gsi1', Limit: 7, ExclusiveStartKey: cursor });
    expect(input.KeyConditionExpression).toContain('<=');
    expect(input.ExpressionAttributeValues?.[':pk']).toBe('BILLING#EVENTS#dev');
  });
  it('only admits a new source while the owner profile is active and closure absent', async () => {
    const { repository, mock } = await fixture();
    const state = { ...initialState('adult'), revision: 2, updatedAt: 100 };
    await repository.commit({ expectedRevision: 1, state, guard: 'none', source: { pk: 'USER#adult', sk: 'SUBSCRIPTION#INDIVIDUAL', entityType: 'SubscriptionSource', ownerSub: 'adult', sourceId: 'sub_1', state: 'active', paidThrough: 999, graceUntil: null, revision: 2, updatedAt: 100 }, lease: { owner: 'worker', revision: 3, now: 100 }, auditAction: 'billing.projected' });
    const tx = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(JSON.stringify(tx)).toContain('leaseUntil > :leaseNow');
    expect(tx.filter((x) => x.ConditionCheck?.Key?.['sk'] === 'PROFILE')).toHaveLength(1);
    expect(tx.filter((x) => x.ConditionCheck?.Key?.['pk'] === 'ACCOUNT_CLOSURE#adult')).toHaveLength(1);
  });
  it('deduplicates inbox by account and stage without storing event payload or a TTL', async () => {
    const { repository, mock } = await fixture();
    const event = { eventId: 'evt_1', type: 'invoice.paid', objectId: 'in_1', objectType: 'invoice', apiVersion: '2026-09-30.endive', liveMode: false, accountId: 'acct_fixture', status: 'pending' as const, attempts: 0, receivedAt: 100, nextAttemptAt: 100 };
    expect(await repository.putEvent(event)).toBe(true);
    const input = mock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item).toMatchObject({ pk: 'STRIPE_EVENT#acct_fixture#dev#evt_1', sk: 'EVENT', gsi1pk: 'BILLING#EVENTS#dev' });
    expect(input.Item).not.toHaveProperty('data');
    mock.on(PutCommand).rejects({ name: 'ConditionalCheckFailedException' });
    expect(await repository.putEvent(event)).toBe(false);
  });
});
