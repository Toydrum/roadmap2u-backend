import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoAccessResolver } from '../lambda/access-reader';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { MemoryBillingRepository } from '../lambda/billing/repository';
import { initialState } from '../lambda/billing/model';
import { config, NOW } from './support/billing-fixture';
import { SSMClient } from '@aws-sdk/client-ssm';
import { createDynamoSponsoredAccessBrokerDeps } from '../lambda/commercial/access-code-dynamo';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';

const mocked=mockClient(DynamoDBDocumentClient);
beforeEach(()=>mocked.reset());
afterEach(()=>mocked.reset());
const client=()=>DynamoDBDocumentClient.from(new DynamoDBClient({}));
function mirror(revision=1, time=NOW) {
  return {pk:'USER#adult',sk:'BILLING#TEST_CLOCK',entityType:'BillingTestClock',ownerSub:'adult',customerId:'cus_qa',
    testClockId:'clock_qa',bindingId:'binding-qa',stage:'dev',stripeAccountId:config.accountId,liveMode:false,
    syntheticFixture:'stripe_clock_dev_qa',clockRevision:revision,frozenTimeSeconds:time/1000,
    providerReadyEvidence:{status:'ready',customerId:'cus_qa',testClockId:'clock_qa',stripeAccountId:config.accountId,
      liveMode:false,frozenTimeSeconds:time/1000,observedAt:NOW}};
}
const reference=()=>{
  const {ownerSub,customerId,testClockId,bindingId,stage,stripeAccountId,syntheticFixture,clockRevision,frozenTimeSeconds}=mirror();
  return {ownerSub,customerId,testClockId,bindingId,stage,stripeAccountId,syntheticFixture,clockRevision,frozenTimeSeconds};
};
describe('protected clock Dynamo observations and transaction fences',()=>{
  it('preserves protected clock metadata in the sponsored-grant adapter without reading secrets',async()=>{
    const issuanceId='7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a',m=mirror();
    const access=deriveAccessItem('adult',NOW,undefined,[]);
    mocked.on(GetCommand).callsFake(({Key})=>({Item:Key.sk === 'CODE' ? {status:'redeemed',redeemerSub:'adult'}
      : Key.sk === 'ACCESS' ? access : Key.sk === 'BILLING#TEST_CLOCK' ? m : undefined}));
    mocked.on(QueryCommand).resolves({Items:[{grantId:`code-${issuanceId}`}]});
    const secrets=mockClient(SSMClient);secrets.onAnyCommand().rejects(new Error('No secret read allowed'));
    try {
      const deps=createDynamoSponsoredAccessBrokerDeps({ddb:client(),ssm:new SSMClient({}),tableName:'qa',auditTableName:'audit-qa',
        parameterName:'/synthetic/never-read',stage:'dev',now:()=>NOW},[]);
      expect(await deps.readGrantSnapshot(issuanceId)).toMatchObject({testClock:m,billingStage:'dev'});
      expect(secrets.calls()).toHaveLength(0);
    } finally {secrets.restore();}
  });
  it('reads the owner mirror consistently and fences it in the financial transaction',async()=>{
    const m=mirror();mocked.on(GetCommand).resolves({Item:m});mocked.on(TransactWriteCommand).resolves({});
    const repository=new DynamoBillingRepository({ddb:client(),table:'qa',accountId:config.accountId,stage:'dev',liveMode:false});
    expect(await repository.readTestClock('adult')).toEqual(m);
    expect(mocked.commandCalls(GetCommand)[0].args[0].input).toMatchObject({Key:{pk:'USER#adult',sk:'BILLING#TEST_CLOCK'},ConsistentRead:true});
    expect(await repository.commit({expectedRevision:0,state:{...initialState('adult'),revision:1,updatedAt:NOW},
      guard:'none',clockObservation:{item:m},auditAction:'qa'})).toBe(true);
    const tx=mocked.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const guard=tx.find(item=>item.ConditionCheck?.Key?.['sk'] === 'BILLING#TEST_CLOCK')!.ConditionCheck!;
    expect(guard.ExpressionAttributeValues).toMatchObject({':clockRevision':1,':providerReadyEvidence':m.providerReadyEvidence});
    expect(tx.filter(item=>item.Put?.Item?.['sk'] === 'BILLING#TEST_CLOCK')).toHaveLength(0);
  });
  it('retries a changing mirror and expires a late-worker source using the stable revision',async()=>{
    const m=mirror(),later=mirror(2,NOW+60_000);let clockReads=0;
    const subscription={pk:'USER#adult',sk:'SUBSCRIPTION#INDIVIDUAL',entityType:'SubscriptionSource',ownerSub:'adult',
      sourceId:'qa-individual',state:'active',paidThrough:NOW+60_000,graceUntil:null,revision:1,updatedAt:NOW,testClock:reference()};
    mocked.on(GetCommand).callsFake(({Key})=>({Item:Key.sk === 'BILLING#TEST_CLOCK' ? (++clockReads === 1 ? m : later)
      : Key.sk === 'SUBSCRIPTION#INDIVIDUAL' ? subscription
      : Key.sk === 'PROFILE' ? {pk:'USER#adult',sk:'PROFILE',userId:'adult',accountType:'adult',status:'active'} : undefined}));
    mocked.on(QueryCommand).resolves({Items:[]});mocked.on(TransactWriteCommand).resolves({});
    const resolver=createDynamoAccessResolver({ddb:client(),tableName:'qa',now:()=>NOW,stage:'dev'});
    const result=await resolver.resolveFresh('adult');
    expect(clockReads).toBe(4);
    expect(result.access.effectivePlanKey).toBe('free');expect(result.access.offlineValidUntil).toBe(NOW);
    const tx=mocked.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx.find(item=>item.ConditionCheck?.Key?.['sk'] === 'BILLING#TEST_CLOCK')?.ConditionCheck?.ExpressionAttributeValues?.[':clockRevision']).toBe(2);
  });
  it('fences mirror absence for a restored clock-marked source in PROD',async()=>{
    const source={pk:'USER#adult',sk:'SUBSCRIPTION#INDIVIDUAL',entityType:'SubscriptionSource',ownerSub:'adult',sourceId:'qa-individual',
      state:'active',paidThrough:NOW+60_000,graceUntil:null,revision:1,updatedAt:NOW,testClock:reference()};
    mocked.on(GetCommand).callsFake(({Key})=>({Item:Key.sk === 'SUBSCRIPTION#INDIVIDUAL' ? source : undefined}));
    mocked.on(QueryCommand).resolves({Items:[]});mocked.on(TransactWriteCommand).resolves({});
    const access=(await createDynamoAccessResolver({ddb:client(),tableName:'qa',now:()=>NOW,stage:'prod'}).resolveFresh('adult')).access;
    expect(access.effectivePlanKey).toBe('free');expect(access.offlineValidUntil).toBe(NOW);
    const tx=mocked.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx).toContainEqual({ConditionCheck:{TableName:'qa',Key:{pk:'USER#adult',sk:'BILLING#TEST_CLOCK'},
      ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}});
  });
  it('rejects a financial commit after a mirror change without persisting stale facts',async()=>{
    const repository=new MemoryBillingRepository(),observed=mirror();
    repository.testClocks.set('adult',mirror(2,NOW+1000));
    expect(await repository.commit({expectedRevision:0,state:{...initialState('adult'),revision:1,updatedAt:NOW},guard:'none',
      clockObservation:{item:observed},auditAction:'qa'})).toBe(false);
    expect(repository.states.size).toBe(0);expect(repository.audit).toHaveLength(0);
  });
});
