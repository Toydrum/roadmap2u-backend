import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { prepareClockStripeObserver } from '../scripts/stripe-test-clock-stripe-observation';
import * as StripeClockReaders from '../scripts/stripe-test-clock-stripe-observation';
import { prepareClockInstall, type ClockPublisherScope } from '../scripts/stripe-test-clock-evidence';
import { resolveFinancialClock, TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

const NOW=Date.now(),TIME=Math.floor(NOW/1000),KEY='rk_test_syntheticOnly123';
function fixture(stage='dev'){
  const scope:ClockPublisherScope={tableName:`roadmap-${stage}`,stage,stripeAccountId:'acct_sandbox',liveMode:false,fixtures:[{ownerSub:'owner_one',customerId:'cus_one',testClockId:'clock_one',bindingId:'binding_one',stage,stripeAccountId:'acct_sandbox',syntheticFixture:`stripe_clock_${stage}_one`}]};
  const account:any={id:'acct_sandbox',object:'account',country:'MX',external_accounts:'private-account-field'},customer:any={id:'cus_one',object:'customer',livemode:false,test_clock:'clock_one',email:'private@example.invalid',metadata:{owner:'owner_one',stage,integration:'roadmap2u_individual_v1',private:'do-not-return'}},clock:any={id:'clock_one',object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:TIME,deletes_after:TIME+86400,name:'private-clock-name'};
  const requests:{host:string;port:string;path:string;method:string;data:string;protocol:string;version:unknown;connected:unknown;authorized:boolean;timeout:number}[]=[],reservations:string[]=[];
  let current=NOW,failPath='',failure:'none'|'closed'|'500'|'timeout'|'status201'='none';
  const httpClient:Stripe.HttpClient={getClientName:()=> 'synthetic-memory',makeRequest:async(host,port,path,method,headers,data,protocol,timeout)=>{
    requests.push({host,port,path,method,data,protocol,version:headers['Stripe-Version'],connected:headers['Stripe-Account'],authorized:headers.Authorization==='Bearer '+KEY,timeout});
    if(path===failPath&&failure==='closed')throw Object.assign(new Error('private-rk_test_error'),{code:'ECONNRESET'});
    if(path===failPath&&failure==='timeout')return await new Promise(()=>{});
    const status=path===failPath&&failure==='500'?500:path===failPath&&failure==='status201'?201:200;
    const value=status===500?{error:{type:'api_error',message:'private-rk_test_error'}}:path==='/v1/account'?account:path==='/v1/customers/cus_one'?customer:clock;
    return{getStatusCode:()=>status,getHeaders:()=>({'request-id':'req_synthetic','stripe-version':STRIPE_API_VERSION}),getRawResponse:()=>({statusCode:status}),toStream:()=>undefined,toJSON:async()=>structuredClone(value)};
  }};
  const options={scope,ownerSub:'owner_one',apiKey:KEY,httpClient,now:()=>current,reserveWire:(kind:string)=>{reservations.push(kind);},requestTimeoutMs:200};
  return{options,requests,reservations,account,customer,clock,setNow:(value:number)=>{current=value;},fail:(path:string,kind:typeof failure)=>{failPath=path;failure=kind;}};
}

describe('bounded ready Stripe observation with actual SDK',()=>{
  it.each(['dev','test'])('observes one %s account/Customer/TestClock snapshot accepted by the actual publisher',async stage=>{
    const f=fixture(stage),observer=prepareClockStripeObserver(f.options);expect(f.requests).toHaveLength(0);const result=await observer.observe();
    expect(result).toMatchObject({status:'ready_observed',physicalAuthorizationChecked:false,wireDelegations:{account:1,customer:1,clock:1}});
    expect(f.requests.map(r=>r.path)).toEqual(['/v1/account','/v1/customers/cus_one','/v1/test_helpers/test_clocks/clock_one']);expect(f.reservations).toEqual(['account','customer','clock']);
    expect(f.requests.every(r=>r.host==='api.stripe.com'&&r.port==='443'&&r.protocol==='https'&&r.method==='GET'&&r.data===''&&r.version===STRIPE_API_VERSION&&r.connected===undefined&&r.authorized)).toBe(true);
    const prepared=prepareClockInstall({scope:f.options.scope,ownerSub:'owner_one',priorMirror:null,observation:result.observation,realNow:NOW});
    expect(resolveFinancialClock({ownerSub:'owner_one',customerId:'cus_one',stage,accountId:'acct_sandbox',liveMode:false,now:NOW,reference:prepared.reference,providerTestClockId:'clock_one'},prepared.mirror).mode).toBe('simulation');
  });
  it('drops unrelated personal/account/provider data and never returns the key',async()=>{const f=fixture(),observer=prepareClockStripeObserver(f.options),result=await observer.observe(),raw=JSON.stringify({result,preview:observer.preview,counts:observer.counts()});for(const value of [KEY,'private@example.invalid','do-not-return','private-clock-name','private-account-field'])expect(raw).not.toContain(value);expect(result.observation.customer.metadata).toEqual({owner:'owner_one',stage:'dev',integration:'roadmap2u_individual_v1'});});
  it('captures scope, key and handler before the caller can mutate options or preview',async()=>{const f=fixture(),observer=prepareClockStripeObserver(f.options);(f.options.scope.fixtures as any[])[0]={...f.options.scope.fixtures[0],ownerSub:'other'};f.options.apiKey='rk_test_changed123';f.options.httpClient={} as any;(observer.preview.fixture as {ownerSub:string}).ownerSub='other';expect((await observer.observe()).status).toBe('ready_observed');});
  it('cannot observe twice using the same instance',async()=>{const f=fixture(),observer=prepareClockStripeObserver(f.options);await observer.observe();await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_ALREADY_CONSUMED');expect(f.requests).toHaveLength(3);});
  const scopeBad:[string,(f:ReturnType<typeof fixture>)=>void,string][]=[
    ['production',f=>{f.options.scope.stage='prod';},'SANDBOX_SCOPE_REQUIRED'],['live mode',f=>{f.options.scope.liveMode=true;},'SANDBOX_SCOPE_REQUIRED'],
    ['unbound owner',f=>{f.options.ownerSub='other';},'OWNER_NOT_IN_SCOPE'],['protected historical owner',f=>{(f.options.scope.fixtures as any[])[0]={...f.options.scope.fixtures[0],ownerSub:'e4282408-f0f1-70b2-b5ef-b9ddb80599e7'};f.options.ownerSub='e4282408-f0f1-70b2-b5ef-b9ddb80599e7';},'HISTORICAL_OWNER_PROTECTED'],
    ['duplicate binding',f=>{f.options.scope.fixtures=[f.options.scope.fixtures[0],f.options.scope.fixtures[0]];},'DUPLICATE_BINDING'],['missing fixture',f=>{f.options.scope.fixtures=[];},'FIXTURE_LIMIT'],
  ];
  it.each(scopeBad)('rejects %s before provider reads',(_name,change,code)=>{const f=fixture();change(f);expect(()=>prepareClockStripeObserver(f.options)).toThrow('CLOCK_PUBLISHER_'+code);expect(f.requests).toHaveLength(0);});
  it.each(['','sk_test_synthetic123','rk_live_synthetic123'])('rejects a non-restricted-test key %s before reads',key=>{const f=fixture();f.options.apiKey=key;expect(()=>prepareClockStripeObserver(f.options)).toThrow('CLOCK_STRIPE_RESTRICTED_TEST_KEY_REQUIRED');expect(f.requests).toHaveLength(0);});
  it.each(['HTTP delegate','budget','clock','timeout'])('requires explicit valid %s',kind=>{const f=fixture(),options:any=f.options;if(kind==='HTTP delegate')delete options.httpClient;if(kind==='budget')delete options.reserveWire;if(kind==='clock')delete options.now;if(kind==='timeout')options.requestTimeoutMs=10001;const code=kind==='HTTP delegate'?'HTTP_CLIENT_REQUIRED':kind==='budget'?'BUDGET_REQUIRED':kind==='clock'?'CLOCK_REQUIRED':'TIMEOUT_INVALID';expect(()=>prepareClockStripeObserver(options)).toThrow('CLOCK_STRIPE_'+code);expect(f.requests).toHaveLength(0);});
  it.each(['wrong account','wrong market'])('stops after account for %s',async kind=>{const f=fixture();if(kind==='wrong account')f.account.id='acct_other';else f.account.country='US';const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_ACCOUNT_MISMATCH');expect(f.requests).toHaveLength(1);});
  const customerBad:[string,(f:ReturnType<typeof fixture>)=>void][]=[
    ['owner',f=>{f.customer.metadata.owner='other';}],['stage',f=>{f.customer.metadata.stage='other';}],['integration',f=>{f.customer.metadata.integration='other';}],['clock',f=>{f.customer.test_clock='clock_other';}],
    ['live',f=>{f.customer.livemode=true;}],['deleted',f=>{f.customer.deleted=true;}],['expanded clock',f=>{f.customer.test_clock={id:'clock_one'};}],
  ];
  it.each(customerBad)('stops before clock GET for wrong customer %s',async(_name,change)=>{const f=fixture();change(f);const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_CUSTOMER_MISMATCH');expect(f.requests).toHaveLength(2);});
  it.each(['advancing','internal_failure'])('does not produce ready evidence for %s',async status=>{const f=fixture();f.clock.status=status;const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_PUBLISHER_CLOCK_NOT_READY_OR_MISMATCHED');expect(f.requests).toHaveLength(3);});
  it('rejects an expired physical clock through the actual core validator',async()=>{const f=fixture();f.clock.deletes_after=TIME;const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_PUBLISHER_PHYSICAL_CLOCK_EXPIRED');});
  it('rejects an observation that exceeds the real evidence window',async()=>{const f=fixture();const delegate=f.options.httpClient.makeRequest;f.options.httpClient.makeRequest=async(...args)=>{const result=await delegate(...args);if(args[2].includes('/test_clocks/'))f.setNow(NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS);return result;};const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_PUBLISHER_OBSERVATION_TIME_INVALID');});
  it.each(['closed','500','status201'] as const)('sanitizes %s failure and never delegates the same GET twice',async kind=>{const f=fixture();f.fail('/v1/account',kind);if(kind==='closed')f.options.requestTimeoutMs=1500;const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');expect(f.requests).toHaveLength(1);expect(observer.counts()).toMatchObject({wireDelegations:{account:1,customer:0,clock:0}});});
  it('stops when the request budget fails before delegating anything',async()=>{const f=fixture();f.options.reserveWire=()=>{throw new Error('private-rk_test_budget');};const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');expect(f.requests).toHaveLength(0);expect(observer.counts()).toMatchObject({wireReservations:{account:1,customer:0,clock:0},wireDelegations:{account:0,customer:0,clock:0}});});
  it('bounds a stalled request without reading further or returning a raw error',async()=>{const f=fixture();f.fail('/v1/account','timeout');f.options.requestTimeoutMs=10;const observer=prepareClockStripeObserver(f.options);await expect(observer.observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');expect(f.requests).toHaveLength(1);});
});

function recoveryReader(options:Parameters<typeof prepareClockStripeObserver>[0]){
  const factory=(StripeClockReaders as unknown as Record<string,any>).prepareClockStripeRecoveryObserver;
  expect(factory).toBeTypeOf('function');return factory(options);
}
describe('read-only Stripe clock recovery diagnosis',()=>{
  it.each(['ready','recovery'])('rejects a reservation that exhausts the evidence window in %s mode',async mode=>{
    const f=fixture();f.options.reserveWire=()=>{f.setNow(NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS);};
    const reader=mode==='recovery'?recoveryReader(f.options):prepareClockStripeObserver(f.options);
    await expect(reader.observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');
    expect(f.requests).toHaveLength(0);
    expect(reader.counts()).toMatchObject({wireReservations:{account:1},wireDelegations:{account:0}});
  });
  it.each(['dev','test'].flatMap(stage=>['ready','advancing','internal_failure'].map(status=>[stage,status])))('observes %s %s without creating ready evidence',async(stage,status)=>{
    const f=fixture(stage);f.clock.status=status;const result=await recoveryReader(f.options).observe();
    expect(result).toMatchObject({status:'clock_observed',physicalAuthorizationChecked:false,providerReadyEvidenceProduced:false,retryAllowed:false,
      observation:{clock:{id:'clock_one',status},clockExpired:false}});
    expect(f.requests).toHaveLength(3);expect(f.requests.every(r=>r.method==='GET'&&r.data===''&&r.connected===undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);expect(JSON.stringify(result)).not.toContain('private@example.invalid');
  });
  it('observes an expired clock without publishing evidence or extending its lifetime',async()=>{
    const f=fixture();f.clock.deletes_after=TIME-1;
    expect(await recoveryReader(f.options).observe()).toMatchObject({status:'clock_observed',providerReadyEvidenceProduced:false,
      observation:{clock:{deletes_after:TIME-1},clockExpired:true}});
  });
  it('reports only a scoped resource_missing clock response as absent',async()=>{
    const f=fixture(),original=f.options.httpClient.makeRequest;
    f.options.httpClient.makeRequest=async(...args)=>{
      const value=await original(...args);
      if(args[2].includes('/test_clocks/'))return{...value,getStatusCode:()=>404,toJSON:async()=>({error:{type:'invalid_request_error',code:'resource_missing',message:'private missing-clock error'}})};
      return value;
    };
    const result=await recoveryReader(f.options).observe();
    expect(result).toMatchObject({status:'clock_not_found',providerReadyEvidenceProduced:false,observation:{clock:null,clockExpired:null}});
    expect(JSON.stringify(result)).not.toContain('private missing-clock error');expect(f.requests).toHaveLength(3);
  });
  it.each(['status','id','live','time','expiry'] as const)('rejects malformed/crossed clock %s facts',async fault=>{
    const f=fixture();if(fault==='status')f.clock.status='unexpected';if(fault==='id')f.clock.id='clock_other';
    if(fault==='live')f.clock.livemode=true;if(fault==='time')f.clock.frozen_time=-1;if(fault==='expiry')f.clock.deletes_after='tomorrow';
    await expect(recoveryReader(f.options).observe()).rejects.toThrow('CLOCK_STRIPE_RECOVERY_CLOCK_INVALID');expect(f.requests).toHaveLength(3);
  });
  it('still rejects a Customer belonging to another owner before reading its clock',async()=>{
    const f=fixture();f.customer.metadata.owner='someone_else';
    await expect(recoveryReader(f.options).observe()).rejects.toThrow('CLOCK_STRIPE_CUSTOMER_MISMATCH');expect(f.requests).toHaveLength(2);
  });
  it('rejects an asynchronous reservation before delegating a provider request',async()=>{
    const f=fixture();f.options.reserveWire=(()=>Promise.reject(new Error('private asynchronous budget'))) as any;
    await expect(recoveryReader(f.options).observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');expect(f.requests).toHaveLength(0);
  });
  it('consumes recovery even on connection loss and never repeats the GET',async()=>{
    const f=fixture();f.fail('/v1/account','closed');f.options.requestTimeoutMs=1500;const reader=recoveryReader(f.options);
    await expect(reader.observe()).rejects.toThrow('CLOCK_STRIPE_READ_UNCERTAIN');
    await expect(reader.observe()).rejects.toThrow('CLOCK_STRIPE_ALREADY_CONSUMED');expect(f.requests).toHaveLength(1);
  });
});
