import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { resolveFinancialClock, TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';
import { prepareClockTransitionTransaction, type ClockTransitionRequest } from '../scripts/stripe-test-clock-transition';

const NOW=Date.UTC(2026,9,13,12),TIME=NOW/1000;
async function input(stage='dev'): Promise<ClockTransitionRequest> {
  const owner='owner_one',customer='cus_one',clock='clock_one',account='acct_sandbox',table=`roadmap-${stage}`,privacy=`roadmap-privacy-${stage}`;
  const initial: ClockInstallRequest={operationId:'install_one',storage:{stage,awsAccountId:'765932874577',region:'us-east-1',appTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${table}`,privacyTableName:privacy,privacyTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${privacy}`},
    clock:{ownerSub:owner,priorMirror:null,realNow:NOW,scope:{tableName:table,stage,stripeAccountId:account,liveMode:false,fixtures:[{ownerSub:owner,customerId:customer,testClockId:clock,bindingId:'binding_one',stage,stripeAccountId:account,syntheticFixture:`stripe_clock_${stage}_one`}]},
      observation:{stripeAccountId:account,stage,liveMode:false,startedAt:NOW-100,completedAt:NOW-50,customer:{id:customer,object:'customer',livemode:false,test_clock:clock,metadata:{owner,stage,integration:'roadmap2u_individual_v1'}},
        clock:{id:clock,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:TIME,deletes_after:TIME+86400}}},
    snapshot:{ownerSub:owner,stage,appTableName:table,privacyTableName:privacy,startedAt:NOW-100,completedAt:NOW-10,consistentReads:true,financialPartitionComplete:true,
      identity:{ownerSub:owner,enabled:false},profile:{pk:`USER#${owner}`,sk:'PROFILE',userId:owner,accountType:'adult',status:'active'},financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null,
      flags:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:61,quotaMode:'enforce',capabilityMode:'enforce',accessCodeIssuanceEnabled:false,accessCodeRedemptionEnabled:false,premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,
        schemaVersion:2,paymentScope:'none',individualCheckoutEnabled:false,updatedAt:NOW-1000,updatedBy:'synthetic',reason:'closed'}}};
  const p=await prepareClockInstallTransaction(initial);
  const state=p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='STATE')!.Put!.Item!;
  const mapping=p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='OWNER')!.Put!.Item!;
  const {financialRows:_rows,financialPartitionComplete:_complete,subscriptionSource:_source,...common}=initial.snapshot;
  return {kind:'advance_fence',operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400,storage:initial.storage,
    clock:{...initial.clock,priorMirror:p.evidence.mirror,realNow:NOW+100,observation:{...initial.clock.observation,startedAt:NOW+1,completedAt:NOW+50}},
    snapshot:{...common,startedAt:NOW+1,completedAt:NOW+90,mirror:p.evidence.mirror,financialState:state,customerMapping:mapping}};
}
function financialClock(i:ClockTransitionRequest,mirror:unknown) {
  return resolveFinancialClock({ownerSub:i.clock.ownerSub,customerId:'cus_one',stage:i.clock.scope.stage,accountId:'acct_sandbox',liveMode:false,now:i.clock.realNow,reference:i.snapshot.financialState!.testClock,providerTestClockId:'clock_one'},mirror);
}
async function pending() {const i=await input(),p=await prepareClockTransitionTransaction(i);expect(p).toBeDefined();return {i,p:p!};}
async function readyInput() {
  const {i,p}=await pending();i.kind='ready';delete i.targetFrozenTimeSeconds;i.clock.priorMirror=p.evidence.mirror;i.snapshot.mirror=p.evidence.mirror;
  i.clock.realNow=NOW+300;i.clock.observation.startedAt=NOW+200;i.clock.observation.completedAt=NOW+250;i.clock.observation.clock.frozen_time=TIME+86400;
  i.snapshot.startedAt=NOW+200;i.snapshot.completedAt=NOW+290;return i;
}

describe('protected mirror transition request',()=>{
  it.each(['dev','test'])('prepares %s invalidation with no state/source/profile/mapping write',async stage=>{
    const i=await input(stage),before=structuredClone(i),p=await prepareClockTransitionTransaction(i);expect(p).toBeDefined();
    const tx=p!.transaction.TransactItems!;expect(tx).toHaveLength(8);expect(tx.filter(item=>item.Put)).toHaveLength(2);expect(tx.filter(item=>item.ConditionCheck)).toHaveLength(6);
    expect(tx.filter(item=>item.Put).map(item=>item.Put!.Item!.sk)).toEqual(expect.arrayContaining(['BILLING#TEST_CLOCK',expect.stringContaining('AUDIT#CLOCK#')]));
    expect(tx.some(item=>item.Update || item.Delete || item.Put?.Item?.sk==='STATE' || item.Put?.Item?.sk==='OWNER' || item.Put?.Item?.sk==='SUBSCRIPTION#INDIVIDUAL')).toBe(false);
    expect(financialClock(i,p!.evidence.mirror).mode).toBe('blocked');expect(p!.physicalExecutionAllowed).toBe(false);expect(i).toEqual(before);
  });
  it('publishes exact ready target with the same operation and retained earlier state reference',async()=>{
    const i=await readyInput(),p=await prepareClockTransitionTransaction(i);expect(p).toBeDefined();
    expect(p!.evidence.reference.clockRevision).toBe(2);expect(financialClock(i,p!.evidence.mirror)).toMatchObject({mode:'simulation',now:NOW+86400000});
    expect(i.snapshot.financialState!.testClock).toMatchObject({clockRevision:1,frozenTimeSeconds:TIME});
    expect(p!.transaction.TransactItems!.find(item=>item.ConditionCheck?.Key?.sk==='STATE' && item.ConditionCheck.Key.pk===`BILLING#${i.clock.ownerSub}`)?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({':revision':1,':reference':i.snapshot.financialState!.testClock,':now':NOW+300});
  });
  it('refreshes expired evidence without moving financial time or rebinding state',async()=>{
    const i=await input();i.kind='refresh';delete i.targetFrozenTimeSeconds;i.operationId='refresh_one';i.clock.realNow=NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS+500;
    i.clock.observation.startedAt=i.clock.realNow-100;i.clock.observation.completedAt=i.clock.realNow-50;i.snapshot.startedAt=i.clock.realNow-100;i.snapshot.completedAt=i.clock.realNow-10;
    const p=await prepareClockTransitionTransaction(i);expect(p).toBeDefined();expect(p!.evidence.kind).toBe('refresh');expect(p!.evidence.reference.clockRevision).toBe(2);
    expect(financialClock(i,p!.evidence.mirror)).toMatchObject({mode:'simulation',now:NOW});
  });
  it('accepts an expired real lease and denies a still-live one even before a future financial target',async()=>{
    const i=await input();i.snapshot.financialState!.leaseUntil=i.clock.realNow;
    expect(await prepareClockTransitionTransaction(i)).toBeDefined();i.snapshot.financialState!.leaseUntil=i.clock.realNow+1;
    await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();
  });
  const invalid:[string,(i:ClockTransitionRequest)=>void][]=[
    ['lost state',i=>{i.snapshot.financialState=null;}],['foreign state',i=>{i.snapshot.financialState!.ownerSub='other';}],
    ['closed state',i=>{i.snapshot.financialState!.state='closed';}],['closing state',i=>{i.snapshot.financialState!.closingId='closing';}],
    ['closed-at state',i=>{i.snapshot.financialState!.closedAt=NOW;}],['unbound state',i=>{delete i.snapshot.financialState!.testClock;}],
    ['rebound state',i=>{i.snapshot.financialState!.testClock={...(i.snapshot.financialState!.testClock as object),bindingId:'different'};}],
    ['future state clock revision',i=>{i.snapshot.financialState!.testClock={...(i.snapshot.financialState!.testClock as object),clockRevision:2};}],
    ['future state clock time',i=>{i.snapshot.financialState!.testClock={...(i.snapshot.financialState!.testClock as object),frozenTimeSeconds:TIME+1};}],
    ['zero state revision',i=>{i.snapshot.financialState!.revision=0;}],['foreign state customer',i=>{i.snapshot.financialState!.customerId='cus_other';}],
    ['missing mapping',i=>{i.snapshot.customerMapping=null;}],['foreign mapping owner',i=>{i.snapshot.customerMapping!.ownerSub='other';}],
    ['live mapping',i=>{i.snapshot.customerMapping!.liveMode=true;}],['foreign mapping account',i=>{i.snapshot.customerMapping!.accountId='acct_other';}],
    ['foreign mapping stage',i=>{i.snapshot.customerMapping!.stage='test';}],['crossed mirror snapshot',i=>{i.snapshot.mirror={...(i.snapshot.mirror as object),clockRevision:2};}],
    ['missing profile',i=>{i.snapshot.profile=null;}],['closing owner',i=>{i.snapshot.closure={closureId:'closing'};}],['restored account exclusion',i=>{i.snapshot.restoreExclusion={scope:'account'};}],
    ['enabled identity',i=>{i.snapshot.identity.enabled=true;}],['wrong table',i=>{i.storage.appTableArn='arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-prod';}],
    ['open purchases',i=>{Object.assign(i.snapshot.flags!,{paymentScope:'individual',premiumPaymentsEnabled:true,individualCheckoutEnabled:true});}],
    ['missing target',i=>{delete i.targetFrozenTimeSeconds;}],['missing operation',i=>{i.operationId=undefined as unknown as string;}],
    ['unknown phase',i=>{i.kind='unknown' as ClockTransitionRequest['kind'];}],
  ];
  it.each(invalid)('prepares no transition for %s',async(_name,change)=>{const i=await input();change(i);await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();});
  it('does not publish an advance owned by another operation',async()=>{const i=await readyInput();i.operationId='another';await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();});
  it('does not treat ready evidence as a pending advance',async()=>{const i=await input();i.kind='ready';delete i.targetFrozenTimeSeconds;await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();});
  it('does not treat a pending advance as a refresh',async()=>{const i=await readyInput();i.kind='refresh';await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();});
  it('cannot supply a fresh target in ready or refresh phases',async()=>{const i=await readyInput();i.targetFrozenTimeSeconds=TIME+2*86400;await expect(prepareClockTransitionTransaction(i)).rejects.toThrow();});
  it('uses one action per item and a distinct stable token/audit key for each phase',async()=>{
    const {i,p}=await pending(),again=await prepareClockTransitionTransaction(i),ready=await prepareClockTransitionTransaction(await readyInput());
    expect(again!.transaction).toEqual(p.transaction);expect(ready!.transaction.ClientRequestToken).not.toBe(p.transaction.ClientRequestToken);
    const keys=p.transaction.TransactItems!.map(item=>{const op=item.Put ?? item.ConditionCheck!,key='Item' in op?op.Item!:op.Key!;return `${op.TableName}:${key.pk}:${key.sk}`;});expect(new Set(keys).size).toBe(keys.length);
    const audit=p.transaction.TransactItems!.find(item=>item.Put?.Item?.retentionScope==='commercial')!.Put!;
    expect(audit.Item).toMatchObject({occurredAt:NOW+100,retentionStatus:'pending_policy_approval',operationId:'advance_one'});expect(audit.Item!.ttl).toBeUndefined();
    expect(audit.Item!.sk).not.toBe(ready!.transaction.TransactItems!.find(item=>item.Put?.Item?.retentionScope==='commercial')!.Put!.Item!.sk);
  });
  it('captures mutable input before validation yields',async()=>{const i=await input(),before=structuredClone(i),p=prepareClockTransitionTransaction(i);i.snapshot.financialState!.revision=999;i.clock.ownerSub='other';expect((await p)!.transaction).toEqual((await prepareClockTransitionTransaction(before))!.transaction);});
  it('serializes the mirror condition and advancing evidence with the actual SDK in memory',async()=>{
    const {p}=await pending();let body:any,handled=0;
    const ddb=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1',endpoint:'https://synthetic.invalid',maxAttempts:1,credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'},
      requestHandler:{handle:async(request:any)=>{handled++;body=JSON.parse(request.body);return{response:{statusCode:200,headers:{},body:Buffer.from('{}')}};}}}));
    try{await ddb.send(new TransactWriteCommand(p.transaction));}finally{ddb.destroy();}
    expect(handled).toBe(1);expect(body.TransactItems).toHaveLength(8);
    const mirror=body.TransactItems.find((item:any)=>item.Put?.Item?.sk?.S==='BILLING#TEST_CLOCK').Put;
    expect(mirror.Item.providerReadyEvidence.M.status.S).toBe('advancing');expect(mirror.ExpressionAttributeValues[':clockRevision'].N).toBe('1');
  });
});
