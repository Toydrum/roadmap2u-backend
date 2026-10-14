import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoAccessResolver } from '../lambda/access-reader';
import { BillingProjector } from '../lambda/billing/projection';
import { BillingService } from '../lambda/billing/service';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { config, fixture, invoice, NOW, request, subscription } from './support/billing-fixture';
const SK='BILLING#TEST_CLOCK';
function mark(customerId='cus_qa') {return {ownerSub:'adult',customerId,testClockId:'clock_qa',bindingId:'binding-qa',stage:'dev',
  stripeAccountId:config.accountId,syntheticFixture:'stripe_clock_dev_qa',clockRevision:1,frozenTimeSeconds:NOW/1000};}
function source(clock=false) {return {pk:'USER#adult',sk:'SUBSCRIPTION#INDIVIDUAL',entityType:'SubscriptionSource',ownerSub:'adult',
  sourceId:'individual-qa',state:'active',paidThrough:NOW+60_000,graceUntil:null,revision:1,updatedAt:NOW,...(clock?{testClock:mark()}:{})};}
afterEach(()=>vi.restoreAllMocks());
describe('approved protected-clock read isolation',()=>{
  it.each(['dev','test','prod','unknown'])('ordinary %s access performs zero mirror reads or checks',async stage=>{
    const mocked=mockClient(DynamoDBDocumentClient);
    mocked.on(GetCommand).callsFake(({Key})=>({Item:Key.sk === 'SUBSCRIPTION#INDIVIDUAL' ? source() : undefined}));
    mocked.on(QueryCommand).resolves({Items:[]});mocked.on(TransactWriteCommand).resolves({});
    try {
      const result=await createDynamoAccessResolver({ddb:DynamoDBDocumentClient.from(new DynamoDBClient({})),tableName:'qa',now:()=>NOW,stage}).resolveFresh('adult');
      expect(result.access.effectivePlanKey).toBe('premium');
      expect(mocked.commandCalls(GetCommand).filter(c=>c.args[0].input.Key?.['sk'] === SK)).toHaveLength(0);
      const tx=mocked.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
      expect(tx.some(item=>item.ConditionCheck?.Key?.['sk'] === SK)).toBe(false);
    } finally {mocked.restore();}
  });
  it.each(['prod','unknown'])('restored marked source is denied in %s without consulting its mirror',async stage=>{
    const mocked=mockClient(DynamoDBDocumentClient);
    mocked.on(GetCommand).callsFake(({Key})=>({Item:Key.sk === 'SUBSCRIPTION#INDIVIDUAL' ? source(true) : undefined}));
    mocked.on(QueryCommand).resolves({Items:[]});mocked.on(TransactWriteCommand).resolves({});
    try {
      const result=await createDynamoAccessResolver({ddb:DynamoDBDocumentClient.from(new DynamoDBClient({})),tableName:'qa',now:()=>NOW,stage}).resolveFresh('adult');
      expect(result.access.effectivePlanKey).toBe('free');
      expect(mocked.commandCalls(GetCommand).filter(c=>c.args[0].input.Key?.['sk'] === SK)).toHaveLength(0);
      expect(mocked.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.some(item=>item.ConditionCheck?.Key?.['sk'] === SK)).toBe(false);
    } finally {mocked.restore();}
  });
  it('ordinary projection and summary never call the protected-clock repository',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const customerId=(await f.repository.load('adult')).customerId!;
    f.provider.subscriptions.set('sub_1',subscription(customerId));f.provider.invoices.set('in_1',invoice(customerId));
    const read=vi.spyOn(f.repository,'readTestClock');
    const commit=vi.spyOn(f.repository,'commit');
    await new BillingProjector({...f,config,nextWorkerId:()=> 'ordinary'}).reconcileOwner('adult');
    expect((await f.service.summary('adult')).state).toBe('active');
    expect(read).not.toHaveBeenCalled();
    expect(commit.mock.calls.every(([c])=>c.clockObservation === undefined)).toBe(true);
  });
  it.each([
    {stage:'prod',liveMode:false}, {stage:'dev',liveMode:true}, {stage:'test',liveMode:false},
  ])('summary rejects a foreign or live clock without mirror reads: %o',async overrides=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const s=await f.repository.load('adult');f.repository.states.set('adult',{...s,testClock:mark(s.customerId)});
    const read=vi.spyOn(f.repository,'readTestClock');
    const service=new BillingService({...f,config:{...config,...overrides},purchasesEnabled:async()=>true});
    expect((await service.summary('adult')).state).toBe('payment_review');expect(read).not.toHaveBeenCalled();
  });
  it.each([
    {ownerSub:'other'}, {customerId:'cus_other'}, {stripeAccountId:'acct_other'}, {syntheticFixture:'ordinary'},
    {clockRevision:0}, {testClockId:'not-a-clock'}, {stage:'test'},
  ])('does not read a mirror for a malformed or crossed reference: %o',async patch=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const s=await f.repository.load('adult');f.repository.states.set('adult',{...s,testClock:{...mark(s.customerId),...patch}});
    const read=vi.spyOn(f.repository,'readTestClock');
    expect((await f.service.summary('adult')).state).toBe('payment_review');expect(read).not.toHaveBeenCalled();
  });
  it.each(['dev','test'])('reads only the prebound synthetic %s summary mirror',async stage=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const s=await f.repository.load('adult'),reference={...mark(s.customerId),stage,syntheticFixture:`stripe_clock_${stage}_qa`};
    f.repository.states.set('adult',{...s,testClock:reference});
    f.repository.testClocks.set('adult',{...reference,pk:'USER#adult',sk:SK,entityType:'BillingTestClock',liveMode:false,
      providerReadyEvidence:{status:'ready',customerId:s.customerId,testClockId:reference.testClockId,stripeAccountId:config.accountId,
        liveMode:false,frozenTimeSeconds:NOW/1000,observedAt:NOW}});
    const read=vi.spyOn(f.repository,'readTestClock');
    const service=new BillingService({...f,config:{...config,stage},purchasesEnabled:async()=>false});
    expect((await service.summary('adult')).state).toBe('checkout_pending');expect(read).toHaveBeenCalledTimes(1);
  });
  it('denies an unbound clock Customer without bootstrapping from a stray mirror',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const customerId=(await f.repository.load('adult')).customerId!;
    Object.assign(f.provider.customers.get(customerId)!,{testClockId:'clock_qa'});
    f.repository.testClocks.set('adult',{...mark(customerId),pk:'USER#adult',sk:SK,entityType:'BillingTestClock',liveMode:false,
      providerReadyEvidence:{status:'ready',customerId,testClockId:'clock_qa',stripeAccountId:config.accountId,liveMode:false,frozenTimeSeconds:NOW/1000,observedAt:NOW}});
    f.provider.subscriptions.set('sub_1',subscription(customerId));f.provider.invoices.set('in_1',invoice(customerId));
    const read=vi.spyOn(f.repository,'readTestClock'),projector=new BillingProjector({...f,config,nextWorkerId:()=> 'unbound'});
    await projector.reconcileOwner('adult');await projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review');
    expect(f.repository.sources.get('adult')).toMatchObject({state:'ended',testClock:{clockRevision:0}});
    expect(read).not.toHaveBeenCalled();
  });
  it('projects a restored PROD clock as denied without protected reads or checks',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const s=await f.repository.load('adult'),customerId=s.customerId!;
    f.repository.states.set('adult',{...s,testClock:mark(customerId)});
    Object.assign(f.provider.customers.get(customerId)!,{testClockId:'clock_qa',liveMode:true});
    f.provider.subscriptions.set('sub_1',subscription(customerId));f.provider.invoices.set('in_1',invoice(customerId));
    const read=vi.spyOn(f.repository,'readTestClock'),commit=vi.spyOn(f.repository,'commit');
    await new BillingProjector({...f,config:{...config,stage:'prod',liveMode:true},nextWorkerId:()=> 'prod-restore'}).reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('payment_review');expect(read).not.toHaveBeenCalled();
    expect(f.repository.sources.get('adult')?.state).toBe('ended');
    expect(commit.mock.calls.every(([c])=>c.clockObservation === undefined)).toBe(true);
  });
  it('the production Dynamo adapter denies clock reads even when called directly',async()=>{
    const mocked=mockClient(DynamoDBDocumentClient);mocked.on(GetCommand).resolves({});
    try {
      const repo=new DynamoBillingRepository({ddb:DynamoDBDocumentClient.from(new DynamoDBClient({})),table:'qa',stage:'prod',accountId:config.accountId,liveMode:true});
      expect(await repo.readTestClock('adult')).toBeNull();expect(mocked.commandCalls(GetCommand)).toHaveLength(0);
    } finally {mocked.restore();}
  });
});
