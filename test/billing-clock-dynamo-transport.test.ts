import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { prepareClockDynamoExecutor } from '../scripts/stripe-test-clock-dynamo-transport';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';
import { prepareClockTransitionTransaction, type ClockTransitionRequest } from '../scripts/stripe-test-clock-transition';

const NOW=Date.now(),TIME=Math.floor(NOW/1000),SOURCE='63e3e9553ba1ec57b2364a4f84695380da52930a';
const dirs:string[]=[];function directory(){const dir=mkdtempSync(join(tmpdir(),'clock-dynamo-test-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0)){const target=resolve(dir);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('clock-dynamo-test-'))throw new Error('UNSAFE_TEST_CLEANUP');rmSync(target,{recursive:true,force:true});}});
function initial():ClockInstallRequest {
  const owner='owner_one',customer='cus_one',clock='clock_one',account='acct_sandbox',table='roadmap-dev',privacy='roadmap-privacy-dev';
  return {operationId:'install_one',storage:{stage:'dev',awsAccountId:'765932874577',region:'us-east-1',appTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${table}`,privacyTableName:privacy,privacyTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${privacy}`},
    clock:{ownerSub:owner,priorMirror:null,realNow:NOW,scope:{tableName:table,stage:'dev',stripeAccountId:account,liveMode:false,fixtures:[{ownerSub:owner,customerId:customer,testClockId:clock,bindingId:'binding_one',stage:'dev',stripeAccountId:account,syntheticFixture:'stripe_clock_dev_one'}]},
      observation:{stripeAccountId:account,stage:'dev',liveMode:false,startedAt:NOW-100,completedAt:NOW-50,customer:{id:customer,object:'customer',livemode:false,test_clock:clock,metadata:{owner,stage:'dev',integration:'roadmap2u_individual_v1'}},
        clock:{id:clock,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:TIME,deletes_after:TIME+86400}}},
    snapshot:{ownerSub:owner,stage:'dev',appTableName:table,privacyTableName:privacy,startedAt:NOW-100,completedAt:NOW-10,consistentReads:true,financialPartitionComplete:true,
      identity:{ownerSub:owner,enabled:false},profile:{pk:`USER#${owner}`,sk:'PROFILE',userId:owner,accountType:'adult',status:'active'},financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null,
      flags:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:61,quotaMode:'enforce',capabilityMode:'enforce',accessCodeIssuanceEnabled:false,accessCodeRedemptionEnabled:false,premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,
        schemaVersion:2,paymentScope:'none',individualCheckoutEnabled:false,updatedAt:NOW-1000,updatedBy:'synthetic',reason:'closed'}}};
}
interface FakeOptions {write?:'disconnect_after_apply'|'disconnect_before_apply'|'500'|'timeout'|'expire_after_write';read?:'500'|'missing'|'timeout';}
function fixture(fake:FakeOptions={}){
  const rows=new Map<string,any>(),calls:{operation:string;body:any;host:string;protocol:string}[]=[],reservations:string[]=[];
  let destroyed=0,current=NOW+1;
  const handler={handle:async(request:any,options:any)=>{
    const operation=request.headers['x-amz-target'].split('.').pop(),body=JSON.parse(Buffer.from(request.body).toString('utf8'));calls.push({operation,body,host:request.hostname,protocol:request.protocol});
    if((operation==='TransactWriteItems'&&fake.write==='timeout') || (operation==='TransactGetItems'&&fake.read==='timeout'))return await new Promise<any>((_resolve,reject)=>options.abortSignal.addEventListener('abort',()=>reject(new Error('private-timeout-rk_test_do_not_store')),{once:true}));
    if(operation==='TransactWriteItems'){
      if(fake.write==='disconnect_before_apply')throw Object.assign(new Error('private-rk_test_do_not_store'),{code:'ECONNRESET'});
      if(fake.write==='500')return{response:{statusCode:500,headers:{},body:Buffer.from('{"__type":"InternalServerError","message":"private-rk_test_do_not_store"}')}};
      for(const item of body.TransactItems.filter((item:any)=>item.Put)){const put=item.Put,row=unmarshall(put.Item);rows.set(`${put.TableName}:${row.pk}:${row.sk}`,row);}
      if(fake.write==='disconnect_after_apply')throw Object.assign(new Error('private-rk_test_do_not_store'),{code:'ECONNRESET'});
      if(fake.write==='expire_after_write')current=NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS;
      return{response:{statusCode:200,headers:{},body:Buffer.from('{}')}};
    }
    if(fake.read==='500')return{response:{statusCode:500,headers:{},body:Buffer.from('{"__type":"InternalServerError","message":"private-rk_test_do_not_store"}')}};
    const Responses=body.TransactItems.map((item:any,index:number)=>{const key=unmarshall(item.Get.Key),row=rows.get(`${item.Get.TableName}:${key.pk}:${key.sk}`);return row && !(fake.read==='missing'&&index===1)?{Item:marshall(row)}:{};});
    return{response:{statusCode:200,headers:{},body:Buffer.from(JSON.stringify({Responses}))}};
  },destroy:()=>{destroyed++;}};
  const opts={request:initial(),sourceSha:SOURCE,journalDirectory:directory(),credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic-secret',sessionToken:'synthetic-token',expiration:new Date(NOW+3600000)},
    requestHandler:handler,now:()=>current,reserveWire:(kind:string)=>{reservations.push(kind);},requestTimeoutMs:200};
  return{opts,calls,reservations,rows,setNow:(time:number)=>{current=time;},destroyed:()=>destroyed};
}
function saved(f:ReturnType<typeof fixture>,suffix:string){const name=readdirSync(f.opts.journalDirectory).find(name=>name.endsWith('.'+suffix+'.json'));return name?JSON.parse(readFileSync(join(f.opts.journalDirectory,name),'utf8')):null;}

describe('bounded clock DynamoDB transport with actual SDK',()=>{
  it('rejects raw SDK transaction bytes even when a Uint8Array string hook supplies the allowed JSON',async()=>{
    const f=fixture(),handle=f.opts.requestHandler.handle;
    f.opts.requestHandler={...f.opts.requestHandler,handle:async(request:any,options:any)=>{
      const value=request.body;
      return handle({...request,body:typeof value==='string'?value:Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))},options);
    }};
    const executor=await prepareClockDynamoExecutor(f.opts),original=DynamoDBDocumentClient.prototype.send;let coercions=0;
    const spy=vi.spyOn(DynamoDBDocumentClient.prototype,'send').mockImplementation(function(this:DynamoDBDocumentClient,...args:any[]){
      this.middlewareStack.add(next=>async context=>{
        const request=context.request as any;
        if(request.headers['x-amz-target']==='DynamoDB_20120810.TransactWriteItems'){
          const expected=typeof request.body==='string'?request.body:new TextDecoder().decode(request.body);
          const raw=JSON.parse(expected);raw.TransactItems.find((item:any)=>item.Put).Put.TableName='roadmap-prod';
          const bytes=Buffer.from(JSON.stringify(raw)),padded=new Uint8Array(bytes.byteLength+16);padded.fill(0x78);padded.set(bytes,8);
          class CoercingBody extends Uint8Array {valueOf():any{coercions++;return expected;}}
          request.body=new CoercingBody(padded.buffer,8,bytes.byteLength);
        }
        return next(context);
      },{name:'testDynamoRawByteGuard',step:'finalizeRequest',priority:'low',override:true});
      return (original as any).apply(this,args);
    });
    try{
      const result=await executor.execute();
      expect(result).toMatchObject({status:'uncertain',wireDelegations:{write:0,readback:0},retryAllowed:false});
      expect(f.calls).toEqual([]);expect(f.reservations).toEqual([]);expect(coercions).toBe(0);
    }finally{spy.mockRestore();}
  });
  it('prepares without remote delegation or journal and executes one write plus exact readback',async()=>{
    const f=fixture(),e=await prepareClockDynamoExecutor(f.opts);expect(f.calls).toHaveLength(0);expect(readdirSync(f.opts.journalDirectory)).toHaveLength(0);
    expect(e.preview).toMatchObject({physicalAuthorizationChecked:false,writeMaximum:1,readbackMaximum:1});
    const result=await e.execute();expect(result).toMatchObject({status:'verified_applied',clockReadable:true,writeDelivery:'acknowledged',wireDelegations:{write:1,readback:1},retryAllowed:false});
    expect(f.calls.map(c=>c.operation)).toEqual(['TransactWriteItems','TransactGetItems']);expect(f.reservations).toEqual(['write','readback']);expect(f.calls[0].body.TransactItems).toHaveLength(9);expect(f.calls[1].body.TransactItems).toHaveLength(4);
    expect(f.calls.every(c=>c.host==='dynamodb.us-east-1.amazonaws.com'&&c.protocol==='https:')).toBe(true);expect(readdirSync(f.opts.journalDirectory)).toHaveLength(3);expect(saved(f,'readback').status).toBe('verified_applied');expect(f.destroyed()).toBe(1);
  });
  it('resolves apply-then-disconnect by atomic readback without replaying the write',async()=>{const f=fixture({write:'disconnect_after_apply'}),e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'verified_applied',writeDelivery:'uncertain',wireDelegations:{write:1,readback:1}});expect(saved(f,'delivery').delivery).toBe('uncertain');expect(f.calls).toHaveLength(2);});
  it.each(['advance_fence','ready','refresh'] as const)('executes %s with two exact Put readbacks and no financial STATE mutation',async kind=>{
    const f=fixture(),i=f.opts.request,p=await prepareClockInstallTransaction(i),{financialRows:_rows,financialPartitionComplete:_complete,subscriptionSource:_source,...common}=i.snapshot;
    const state=p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='STATE')!.Put!.Item!;
    for(const item of p.transaction.TransactItems!.filter(item=>item.Put)){const put=item.Put!;f.rows.set(`${put.TableName}:${put.Item!.pk}:${put.Item!.sk}`,structuredClone(put.Item));}
    const t:ClockTransitionRequest={kind:kind==='refresh'?'refresh':'advance_fence',operationId:kind==='refresh'?'refresh_one':'advance_one',...(kind==='refresh'?{}:{targetFrozenTimeSeconds:TIME+86400}),storage:i.storage,
      clock:{...i.clock,priorMirror:p.evidence.mirror,realNow:NOW+100,observation:{...i.clock.observation,startedAt:NOW+1,completedAt:NOW+50}},
      snapshot:{...common,startedAt:NOW+1,completedAt:NOW+90,mirror:p.evidence.mirror,financialState:state,customerMapping:p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='OWNER')!.Put!.Item!}};
    if(kind==='ready'){const pending=await prepareClockTransitionTransaction(t);for(const item of pending.transaction.TransactItems!.filter(item=>item.Put)){const put=item.Put!;f.rows.set(`${put.TableName}:${put.Item!.pk}:${put.Item!.sk}`,structuredClone(put.Item));}
      t.kind='ready';delete t.targetFrozenTimeSeconds;t.clock.priorMirror=pending.evidence.mirror;t.snapshot.mirror=pending.evidence.mirror;t.clock.realNow=NOW+300;
      Object.assign(t.clock.observation,{startedAt:NOW+200,completedAt:NOW+250});t.clock.observation.clock.frozen_time=TIME+86400;Object.assign(t.snapshot,{startedAt:NOW+200,completedAt:NOW+290});}
    f.setNow(t.clock.realNow+1);const e=await prepareClockDynamoExecutor({...f.opts,request:t}),r=await e.execute();
    expect(r).toMatchObject({status:'verified_applied',clockReadable:kind!=='advance_fence',wireDelegations:{write:1,readback:1}});expect(f.calls[0].body.TransactItems).toHaveLength(8);expect(f.calls[1].body.TransactItems).toHaveLength(2);expect(f.rows.get(`roadmap-dev:${state.pk}:STATE`)).toEqual(state);
  });
  it.each(['disconnect_before_apply','500'] as const)('keeps %s uncertain with one physical write delegation',async write=>{const f=fixture({write}),e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',clockReadable:false,writeDelivery:'uncertain',wireDelegations:{write:1,readback:1},retryAllowed:false});expect(f.calls).toHaveLength(2);});
  it.each(['500','missing'] as const)('keeps %s readback uncertain after acknowledged write',async read=>{const f=fixture({read}),e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',writeDelivery:'acknowledged',wireDelegations:{write:1,readback:1}});expect(saved(f,'readback').status).toBe('uncertain');});
  it.each(['write','readback'] as const)('aborts a bounded %s timeout and never resends',async kind=>{const f=fixture(kind==='write'?{write:'timeout'}:{read:'timeout'});f.opts.requestTimeoutMs=10;const e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',wireDelegations:{write:1,readback:1},retryAllowed:false});expect(f.calls).toHaveLength(2);});
  it('never executes the same object twice',async()=>{const f=fixture(),e=await prepareClockDynamoExecutor(f.opts);await e.execute();await expect(e.execute()).rejects.toThrow(/CLOCK_DYNAMO_ALREADY_CONSUMED/);expect(f.calls).toHaveLength(2);});
  it('does not execute a fresh object for a previously reserved operation',async()=>{const f=fixture(),first=await prepareClockDynamoExecutor(f.opts);await first.execute();const second=await prepareClockDynamoExecutor(f.opts);await expect(second.execute()).rejects.toThrow(/EEXIST/);expect(f.calls).toHaveLength(2);});
  it('records uncertainty when write budget reservation fails, without delegating or reading',async()=>{const f=fixture();f.opts.reserveWire=()=>{throw new Error('private-budget-rk_test_do_not_store');};const e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',wireDelegations:{write:0,readback:0},retryAllowed:false});expect(f.calls).toHaveLength(0);expect(saved(f,'delivery').delivery).toBe('uncertain');});
  it('does not delegate a readback rejected by its budget',async()=>{const f=fixture();f.opts.reserveWire=kind=>{if(kind==='readback')throw new Error('private-budget-rk_test_do_not_store');f.reservations.push(kind);};const e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',wireDelegations:{write:1,readback:0}});expect(f.calls).toHaveLength(1);});
  it('captures credentials, request and handler before asynchronous preparation',async()=>{const f=fixture(),promise=prepareClockDynamoExecutor(f.opts);f.opts.request.clock.ownerSub='other';f.opts.credentials.secretAccessKey='changed';f.opts.requestHandler={} as any;const e=await promise;e.preview.intent.scope.ownerSub='mutated_preview';expect((await e.execute()).status).toBe('verified_applied');expect(f.calls).toHaveLength(2);});
  it('rejects a snapshot that expires before execute, before journal or SDK delegation',async()=>{const f=fixture(),e=await prepareClockDynamoExecutor(f.opts);f.setNow(NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS);await expect(e.execute()).rejects.toThrow(/CLOCK_DYNAMO_CONTEXT_EXPIRED/);expect(f.calls).toHaveLength(0);expect(readdirSync(f.opts.journalDirectory)).toHaveLength(0);});
  it('rejects credential expiry before execute without consulting a provider chain',async()=>{const f=fixture();f.opts.credentials.expiration=new Date(NOW+40000);const e=await prepareClockDynamoExecutor(f.opts);f.setNow(NOW+20000);await expect(e.execute()).rejects.toThrow(/CLOCK_DYNAMO_CREDENTIALS_EXPIRED/);expect(f.calls).toHaveLength(0);});
  it('keeps a snapshot that expires after write uncertain without delegating another request',async()=>{const f=fixture({write:'expire_after_write'}),e=await prepareClockDynamoExecutor(f.opts),r=await e.execute();expect(r).toMatchObject({status:'uncertain',clockReadable:false,writeDelivery:'acknowledged',wireDelegations:{write:1,readback:0}});expect(f.calls).toHaveLength(1);});
  it.each(['missing token','missing expiration','expired credentials','credential provider','missing handler','missing budget','invalid timeout'] as const)('rejects %s before journal or remote requests',async kind=>{
    const f=fixture(),opts:any=f.opts;if(kind==='missing token')delete opts.credentials.sessionToken;if(kind==='missing expiration')delete opts.credentials.expiration;
    if(kind==='expired credentials')opts.credentials.expiration=new Date(NOW);if(kind==='credential provider')opts.credentials=async()=>f.opts.credentials;
    if(kind==='missing handler')delete opts.requestHandler;if(kind==='missing budget')delete opts.reserveWire;if(kind==='invalid timeout')opts.requestTimeoutMs=20001;
    const code=kind==='missing handler'?'HANDLER_REQUIRED':kind==='missing budget'?'BUDGET_REQUIRED':kind==='invalid timeout'?'TIMEOUT_INVALID':kind==='expired credentials'?'CREDENTIALS_EXPIRED':'CREDENTIAL_SNAPSHOT_REQUIRED';
    await expect(prepareClockDynamoExecutor(opts)).rejects.toThrow('CLOCK_DYNAMO_'+code);expect(f.calls).toHaveLength(0);expect(readdirSync(f.opts.journalDirectory)).toHaveLength(0);
  });
  it('never returns or persists raw errors, secrets, tokens or signed headers',async()=>{const f=fixture({write:'disconnect_after_apply'}),e=await prepareClockDynamoExecutor(f.opts),r=await e.execute(),all=JSON.stringify(r)+readdirSync(f.opts.journalDirectory).map(name=>readFileSync(join(f.opts.journalDirectory,name),'utf8')).join('');for(const value of ['private-rk_test_do_not_store','synthetic-secret','synthetic-token','AWS4-HMAC-SHA256','Credential=','"authorization":'])expect(all).not.toContain(value);});
});
