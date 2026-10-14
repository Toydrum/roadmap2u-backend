import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactGetCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { resolveFinancialClock, TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';
import { prepareClockJournal, reserveClockWrite, recordClockWriteDelivery, inspectClockWriteReadback, recordClockReadback } from '../scripts/stripe-test-clock-journal';
import { prepareClockTransitionTransaction, type ClockTransitionRequest } from '../scripts/stripe-test-clock-transition';

const NOW=Date.UTC(2026,9,13,12),TIME=NOW/1000,SOURCE='13f9898be0fce0613ad75b716655732d05cd6f96';
const dirs:string[]=[];
function directory(){const dir=mkdtempSync(join(tmpdir(),'clock-journal-test-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0)){const target=resolve(dir);if(!target.startsWith(resolve(tmpdir())+sep) || !basename(target).startsWith('clock-journal-test-'))throw new Error('UNSAFE_TEST_CLEANUP');rmSync(target,{recursive:true,force:true});}});
function initial(stage='dev'):ClockInstallRequest {
  const owner='owner_one',customer='cus_one',clock='clock_one',account='acct_sandbox',table=`roadmap-${stage}`,privacy=`roadmap-privacy-${stage}`;
  return {operationId:'install_one',storage:{stage,awsAccountId:'765932874577',region:'us-east-1',appTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${table}`,privacyTableName:privacy,privacyTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${privacy}`},
    clock:{ownerSub:owner,priorMirror:null,realNow:NOW,scope:{tableName:table,stage,stripeAccountId:account,liveMode:false,fixtures:[{ownerSub:owner,customerId:customer,testClockId:clock,bindingId:'binding_one',stage,stripeAccountId:account,syntheticFixture:`stripe_clock_${stage}_one`}]},
      observation:{stripeAccountId:account,stage,liveMode:false,startedAt:NOW-100,completedAt:NOW-50,customer:{id:customer,object:'customer',livemode:false,test_clock:clock,metadata:{owner,stage,integration:'roadmap2u_individual_v1'}},
        clock:{id:clock,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:TIME,deletes_after:TIME+86400}}},
    snapshot:{ownerSub:owner,stage,appTableName:table,privacyTableName:privacy,startedAt:NOW-100,completedAt:NOW-10,consistentReads:true,financialPartitionComplete:true,
      identity:{ownerSub:owner,enabled:false},profile:{pk:`USER#${owner}`,sk:'PROFILE',userId:owner,accountType:'adult',status:'active',ignoredPrivateField:'do-not-persist-profile'},
      financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null,
      flags:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:61,quotaMode:'enforce',capabilityMode:'enforce',accessCodeIssuanceEnabled:false,accessCodeRedemptionEnabled:false,premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,
        schemaVersion:2,paymentScope:'none',individualCheckoutEnabled:false,updatedAt:NOW-1000,updatedBy:'synthetic',reason:'closed'}}};
}
async function transition(kind:'advance_fence'|'refresh'='advance_fence'):Promise<ClockTransitionRequest>{
  const i=initial(),p=await prepareClockInstallTransaction(i),{financialRows:_rows,financialPartitionComplete:_complete,subscriptionSource:_source,...common}=i.snapshot;
  return {operationId:kind==='refresh'?'refresh_one':'advance_one',kind,...(kind==='advance_fence'?{targetFrozenTimeSeconds:TIME+86400}:{}),storage:i.storage,
    clock:{...i.clock,priorMirror:p.evidence.mirror,realNow:NOW+100,observation:{...i.clock.observation,startedAt:NOW+1,completedAt:NOW+50}},
    snapshot:{...common,startedAt:NOW+1,completedAt:NOW+90,mirror:p.evidence.mirror,
      financialState:p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='STATE')!.Put!.Item!,customerMapping:p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='OWNER')!.Put!.Item!}};
}
function observed(plan:any){return {transport:'TransactGetItems',requestSha256:plan.intent.readbackSha256,startedAt:plan.intent.reservedAt+1,completedAt:plan.intent.reservedAt+2,realNow:plan.intent.reservedAt+3,response:{$metadata:{httpStatusCode:200},Responses:plan.expectedItems.map((item:any)=>({Item:structuredClone(item)}))}};}
function acknowledge(dir:string,plan:any,delivery='acknowledged'){reserveClockWrite(dir,plan);return recordClockWriteDelivery(dir,plan,{delivery,recordedAt:plan.intent.reservedAt+1});}

describe('clock publisher local journal and atomic readback',()=>{
  it.each(['dev','test'])('binds a %s installation to four exact atomic readback items',async stage=>{
    const i=initial(stage),original=structuredClone(i),p=await prepareClockJournal(i,SOURCE),actual=await prepareClockInstallTransaction(i);
    expect(p.transaction).toEqual(actual.transaction);expect(p.intent).toMatchObject({sourceSha:SOURCE,operationId:'install_one',phase:'install',reservedAt:NOW});
    expect(p.readback.TransactItems).toHaveLength(4);expect(p.expectedItems).toEqual(actual.transaction.TransactItems!.filter(item=>item.Put).map(item=>item.Put!.Item));
    expect(p.readback.TransactItems!.map((item:any)=>item.Get.Key)).toEqual(p.expectedItems.map((item:any)=>({pk:item.pk,sk:item.sk})));
    expect(p.intent.transactionSha256).toMatch(/^[a-f0-9]{64}$/);expect(p.intent.readbackSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.physicalExecutionAllowed).toBe(false);expect(i).toEqual(original);
  });
  it('binds transition mirror plus audit and confirms invalidation remains unreadable',async()=>{
    const i=await transition(),p=await prepareClockJournal(i,SOURCE),r=inspectClockWriteReadback(p,observed(p));expect(p.readback.TransactItems).toHaveLength(2);
    expect(r).toMatchObject({status:'verified_applied',clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false});
    const ref=i.snapshot.financialState!.testClock;expect(resolveFinancialClock({ownerSub:'owner_one',customerId:'cus_one',stage:'dev',accountId:'acct_sandbox',liveMode:false,reference:ref,now:NOW+103,providerTestClockId:'clock_one'},p.evidence.mirror).mode).toBe('blocked');
  });
  it('verifies refresh using the real reader and records a separate phase reservation',async()=>{
    const i=await transition('refresh'),p=await prepareClockJournal(i,SOURCE);expect(inspectClockWriteReadback(p,observed(p))).toMatchObject({status:'verified_applied',clockReadable:true});
    const advance=await prepareClockJournal({...i,kind:'advance_fence',targetFrozenTimeSeconds:TIME+86400},SOURCE);expect(advance.intent.reservationId).not.toBe(p.intent.reservationId);
  });
  it('verifies ready only after the actual pending advance and target',async()=>{
    const i=await transition(),pending=await prepareClockTransitionTransaction(i);i.kind='ready';delete i.targetFrozenTimeSeconds;
    i.clock.priorMirror=pending.evidence.mirror;i.snapshot.mirror=pending.evidence.mirror;i.clock.realNow=NOW+300;
    Object.assign(i.clock.observation,{startedAt:NOW+200,completedAt:NOW+250});i.clock.observation.clock.frozen_time=TIME+86400;
    Object.assign(i.snapshot,{startedAt:NOW+200,completedAt:NOW+290});
    const p=await prepareClockJournal(i,SOURCE);expect(p.intent.phase).toBe('ready');expect(inspectClockWriteReadback(p,observed(p))).toMatchObject({status:'verified_applied',clockReadable:true});
  });
  it('uses canonical object ordering without changing transaction identity',async()=>{
    const i=initial(),a=await prepareClockJournal(i,SOURCE),b=await prepareClockJournal({...i,snapshot:{...i.snapshot,flags:Object.fromEntries(Object.entries(i.snapshot.flags as object).reverse())}},SOURCE);expect(a.intent).toEqual(b.intent);
  });
  it('captures the request before asynchronous validation yields',async()=>{const i=initial(),copy=structuredClone(i),promise=prepareClockJournal(i,SOURCE);i.clock.ownerSub='other';i.snapshot.profile!.ignoredPrivateField='changed';expect(await promise).toEqual(await prepareClockJournal(copy,SOURCE));});
  it('creates a private exclusive intent without persisting transaction or profile',async()=>{
    const p=await prepareClockJournal(initial(),SOURCE),dir=directory(),file=reserveClockWrite(dir,p),raw=readFileSync(file,'utf8');expect(JSON.parse(raw)).toEqual(p.intent);
    expect(raw).not.toContain('do-not-persist-profile');expect(raw).not.toContain('TransactItems');expect(raw).not.toContain('providerReadyEvidence');expect(readdirSync(dir)).toHaveLength(1);
  });
  it('never reserves the same attempt twice even after a completed readback',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();acknowledge(dir,p);recordClockReadback(dir,p,observed(p));expect(()=>reserveClockWrite(dir,p)).toThrow(/EEXIST/);expect(readdirSync(dir)).toHaveLength(3);});
  it('does not reserve a changed transaction under the same operation',async()=>{
    const i=initial(),a=await prepareClockJournal(i,SOURCE),dir=directory();reserveClockWrite(dir,a);i.clock.realNow+=1;i.snapshot.completedAt+=1;const b=await prepareClockJournal(i,SOURCE);
    expect(a.intent.reservationId).toBe(b.intent.reservationId);expect(a.intent.transactionSha256).not.toBe(b.intent.transactionSha256);expect(()=>reserveClockWrite(dir,b)).toThrow(/EEXIST/);
  });
  it.each(['acknowledged','uncertain','rejected'])('records one sanitized %s delivery without proving readback',async delivery=>{
    const p=await prepareClockJournal(initial(),SOURCE),dir=directory(),file=acknowledge(dir,p,delivery),r=JSON.parse(readFileSync(file,'utf8'));
    expect(r).toMatchObject({delivery,reservationId:p.intent.reservationId,retryAllowed:false,physicalExecutionAllowed:false});expect(r.status).toBeUndefined();expect(()=>recordClockWriteDelivery(dir,p,{delivery,recordedAt:NOW+2})).toThrow(/EEXIST/);
  });
  it('requires an intact reserved intent before recording any delivery',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();expect(()=>recordClockWriteDelivery(dir,p,{delivery:'uncertain',recordedAt:NOW+1})).toThrow(/ENOENT/);const file=reserveClockWrite(dir,p);writeFileSync(file,'{incomplete');expect(()=>recordClockWriteDelivery(dir,p,{delivery:'uncertain',recordedAt:NOW+1})).toThrow();expect(readdirSync(dir)).toHaveLength(1);expect(()=>reserveClockWrite(dir,p)).toThrow(/EEXIST/);});
  it('rejects a journal belonging to another exact payload before recording',async()=>{const i=initial(),p=await prepareClockJournal(i,SOURCE),dir=directory();reserveClockWrite(dir,p);i.clock.realNow+=1;const other=await prepareClockJournal(i,SOURCE);expect(()=>recordClockWriteDelivery(dir,other,{delivery:'acknowledged',recordedAt:NOW+2})).toThrow(/CLOCK_JOURNAL_INTENT_MISMATCH/);expect(readdirSync(dir)).toHaveLength(1);});
  it('rejects unrecognized delivery data without saving raw error or secret fields',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();reserveClockWrite(dir,p);expect(()=>recordClockWriteDelivery(dir,p,{delivery:'uncertain',recordedAt:NOW+1,error:'rk_test_never_store_this'})).toThrow(/CLOCK_JOURNAL_DELIVERY_INVALID/);expect(readdirSync(dir)).toHaveLength(1);});
  it('verifies complete installation only when all four items match atomically',async()=>{const p=await prepareClockJournal(initial(),SOURCE),result=inspectClockWriteReadback(p,observed(p));expect(result).toMatchObject({status:'verified_applied',clockReadable:true,retryAllowed:false,physicalExecutionAllowed:false});});
  const invalid:[string,(o:any)=>void][]=[
    ['failed SDK response',o=>{o.response.$metadata.httpStatusCode=503;}],['missing SDK response status',o=>{delete o.response.$metadata;}],
    ['missing response',o=>{delete o.response;}],['missing array',o=>{delete o.response.Responses;}],['too few items',o=>{o.response.Responses.pop();}],['extra item',o=>{o.response.Responses.push({Item:{pk:'foreign'}});}],
    ['missing audit',o=>{o.response.Responses[3]={};}],['missing mirror',o=>{o.response.Responses[1]=null;}],['foreign state',o=>{o.response.Responses[0].Item.ownerSub='other';}],
    ['missing state reference',o=>{delete o.response.Responses[0].Item.testClock;}],['crossed mapping',o=>{o.response.Responses[2].Item.ownerSub='other';}],['changed mirror',o=>{o.response.Responses[1].Item.clockRevision=99;}],
    ['changed audit',o=>{o.response.Responses[3].Item.action='other';}],['out-of-order items',o=>{o.response.Responses.reverse();}],['different readback request',o=>{o.requestSha256='0'.repeat(64);}],
    ['batch read',o=>{o.transport='BatchGetItems';}],['separate gets',o=>{o.transport='GetItem';}],['observation predates reservation',o=>{o.startedAt=NOW-1;}],['backwards observation',o=>{o.completedAt=o.startedAt-1;}],
    ['future observation',o=>{o.realNow=o.completedAt-1;}],['expired observation',o=>{o.realNow=o.startedAt+TEST_CLOCK_EVIDENCE_MAX_AGE_MS;}],['non-finite time',o=>{o.realNow=NaN;}],
  ];
  it.each(invalid)('keeps %s uncertain without allowing retry',async(_name,change)=>{const p=await prepareClockJournal(initial(),SOURCE),o=observed(p);change(o);expect(inspectClockWriteReadback(p,o)).toMatchObject({status:'uncertain',retryAllowed:false,physicalExecutionAllowed:false});});
  it('does not confuse an applied but expired mirror with usable financial evidence',async()=>{const p=await prepareClockJournal(initial(),SOURCE),o=observed(p);o.startedAt=NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS+1;o.completedAt=o.startedAt+1;o.realNow=o.completedAt+1;expect(inspectClockWriteReadback(p,o)).toMatchObject({status:'verified_applied',clockReadable:false});});
  it('records sanitized uncertain readback after uncertain delivery, without replacing it',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();acknowledge(dir,p,'uncertain');const o=observed(p);o.response.Responses[3]={Item:{private:'do-not-persist-response'}};const file=recordClockReadback(dir,p,o),raw=readFileSync(file,'utf8');expect(JSON.parse(raw)).toMatchObject({status:'uncertain',retryAllowed:false});expect(raw).not.toContain('do-not-persist-response');expect(()=>recordClockReadback(dir,p,observed(p))).toThrow(/EEXIST/);});
  it('requires a delivery record before saving readback proof',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();reserveClockWrite(dir,p);expect(()=>recordClockReadback(dir,p,observed(p))).toThrow(/ENOENT/);});
  it('rejects a modified plan before any local reservation',async()=>{const p=await prepareClockJournal(initial(),SOURCE),dir=directory();p.transaction.TransactItems![0]!.Put!.Item!.ownerSub='other';expect(()=>reserveClockWrite(dir,p)).toThrow(/CLOCK_JOURNAL_PLAN_MISMATCH/);expect(readdirSync(dir)).toHaveLength(0);});
  it.each(['','short','f'.repeat(39),'G'.repeat(40)])('requires an exact Git source SHA: %s',async source=>{await expect(prepareClockJournal(initial(),source)).rejects.toThrow(/CLOCK_JOURNAL_SOURCE_SHA_REQUIRED/);});
  it('delegates scope rejection to the actual preparator',async()=>{const i=initial();i.clock.scope.liveMode=true;await expect(prepareClockJournal(i,SOURCE)).rejects.toThrow(/CLOCK_PUBLISHER_SANDBOX_SCOPE_REQUIRED/);});
  it('serializes and decodes atomic readback using the actual SDK entirely in memory',async()=>{
    const p=await prepareClockJournal(initial(),SOURCE);let body:any,calls=0;
    const client=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1',endpoint:'https://synthetic.invalid',maxAttempts:1,credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'},
      requestHandler:{handle:async(request:any)=>{calls++;body=JSON.parse(request.body);return{response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.0'},body:Buffer.from(JSON.stringify({Responses:p.expectedItems.map((item:any)=>({Item:marshall(item)}))}))}};}}}));
    try{const response=await client.send(new TransactGetCommand(p.readback));expect(inspectClockWriteReadback(p,{...observed(p),response})).toMatchObject({status:'verified_applied',clockReadable:true});}finally{client.destroy();}
    expect(calls).toBe(1);expect(body.TransactItems).toHaveLength(4);expect(body.TransactItems[0].Get.Key.sk.S).toBe('STATE');expect(body.TransactItems.some((item:any)=>item.Get.ConsistentRead!==undefined)).toBe(false);
  });
});
