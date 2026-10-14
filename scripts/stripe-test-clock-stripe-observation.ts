import Stripe from 'stripe';
import { prepareClockInstall, selectClockPublisherFixture, type ClockPublisherScope, type ProviderClockObservation } from './stripe-test-clock-evidence';
import { INTEGRATION, STRIPE_API_VERSION } from '../lambda/billing/model';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

type ReadKind='account'|'customer'|'clock';
export interface ClockStripeObserverOptions {
  scope:ClockPublisherScope; ownerSub:string; apiKey:string; httpClient:Stripe.HttpClient;
  now:()=>number; reserveWire:(kind:ReadKind)=>void; requestTimeoutMs?:number;
}
function requireCondition(ok:unknown,reason:string):asserts ok {if(!ok)throw new Error(`CLOCK_STRIPE_${reason}`);}
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function timestamp(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&Number.isFinite(new Date(v).getTime());}
/** Explicit read-only transport component. No key lookup or physical authority is inferred here. */
export function prepareClockStripeObserver(options:ClockStripeObserverOptions){
  const scope=structuredClone(options.scope),ownerSub=options.ownerSub,key=options.apiKey,now=options.now,reserveWire=options.reserveWire,delegate=options.httpClient,timeout=options.requestTimeoutMs??10000;
  requireCondition(typeof now==='function','CLOCK_REQUIRED');
  const fixture=selectClockPublisherFixture({scope,ownerSub,realNow:now()});
  requireCondition(typeof key==='string'&&/^rk_test_[A-Za-z0-9_]+$/.test(key),'RESTRICTED_TEST_KEY_REQUIRED');
  requireCondition(delegate&&typeof delegate.makeRequest==='function','HTTP_CLIENT_REQUIRED');requireCondition(typeof reserveWire==='function','BUDGET_REQUIRED');
  requireCondition(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=10000,'TIMEOUT_INVALID');
  const makeRequest=delegate.makeRequest.bind(delegate),counts:Record<ReadKind,number>={account:0,customer:0,clock:0},delegations:Record<ReadKind,number>={account:0,customer:0,clock:0};
  const paths:Record<ReadKind,string>={account:'/v1/account',customer:`/v1/customers/${encodeURIComponent(fixture.customerId)}`,clock:`/v1/test_helpers/test_clocks/${encodeURIComponent(fixture.testClockId)}`};
  let consumed=false,active=false,startedAt=0;
  const guarded:Stripe.HttpClient={getClientName:()=> 'roadmap2u-clock-observation',makeRequest:async(host,port,path,method,headers,data,protocol,requestTimeout)=>{
    const kind=(Object.keys(paths) as ReadKind[]).find(k=>paths[k]===path),t=now();
    requireCondition(active&&kind&&timestamp(t)&&t>=startedAt&&t-startedAt<TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'WIRE_CONTEXT_REJECTED');
    requireCondition(host==='api.stripe.com'&&port==='443'&&protocol==='https'&&method==='GET'&&data===''
      &&headers['Stripe-Version']===STRIPE_API_VERSION&&headers['Stripe-Account']===undefined&&headers['Stripe-Context']===undefined
      &&headers.Authorization==='Bearer '+key&&requestTimeout===timeout,'WIRE_SCOPE_REJECTED');
    requireCondition(counts[kind]===0&&(kind==='account'||delegations.account===1)&&(kind!=='clock'||delegations.customer===1),'WIRE_LIMIT_REJECTED');
    // The installed SDK may retry closed connections despite maxNetworkRetries=0.
    // This counter is consumed before the budget callback and delegate.
    counts[kind]++;reserveWire(kind);delegations[kind]++;
    return makeRequest(host,port,path,method,headers,data,protocol,requestTimeout);
  }};
  const stripe=new Stripe(key,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:0,timeout,httpClient:guarded,telemetry:false});
  function statistics(){return{wireReservations:{...counts},wireDelegations:{...delegations}};}
  async function read<T>(work:()=>Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('CLOCK_STRIPE_READ_UNCERTAIN')),timeout);});
      const value=await Promise.race([work(),deadline]);
      requireCondition(record(value)&&record(value.lastResponse)&&value.lastResponse.statusCode===200,'READ_UNCERTAIN');return value;
    }catch{throw new Error('CLOCK_STRIPE_READ_UNCERTAIN');}finally{clearTimeout(timer);}
  }
  return{
    preview:structuredClone({fixture,stage:scope.stage,apiVersion:STRIPE_API_VERSION,maximumDelegations:3,physicalAuthorizationChecked:false}),counts:statistics,
    async observe(){
      requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;startedAt=now();selectClockPublisherFixture({scope,ownerSub,realNow:startedAt});active=true;
      try{
        const account:unknown=await read(()=>stripe.accounts.retrieve(null));
        requireCondition(record(account)&&account.object==='account'&&account.id===scope.stripeAccountId&&account.country==='MX','ACCOUNT_MISMATCH');
        const customer:unknown=await read(()=>stripe.customers.retrieve(fixture.customerId));
        requireCondition(record(customer)&&customer.object==='customer'&&customer.id===fixture.customerId&&customer.deleted!==true&&customer.livemode===false
          &&customer.test_clock===fixture.testClockId&&record(customer.metadata)&&customer.metadata.owner===ownerSub&&customer.metadata.stage===scope.stage&&customer.metadata.integration===INTEGRATION,'CUSTOMER_MISMATCH');
        const clock:unknown=await read(()=>stripe.testHelpers.testClocks.retrieve(fixture.testClockId));
        requireCondition(record(clock),'CLOCK_RESPONSE_INVALID');
        const observation:ProviderClockObservation={stripeAccountId:scope.stripeAccountId,stage:scope.stage,liveMode:false,startedAt,completedAt:now(),
          customer:{id:customer.id as string,object:'customer',livemode:false,test_clock:customer.test_clock as string,metadata:{owner:customer.metadata.owner as string,stage:customer.metadata.stage as string,integration:customer.metadata.integration as string}},
          clock:{id:clock.id as string,object:clock.object as string,livemode:clock.livemode as boolean,status:clock.status as string,frozen_time:clock.frozen_time as number,deletes_after:clock.deletes_after as number}};
        // The actual core verifies ready, times, identity and monotonic-safe reference shape.
        // No prepared evidence is returned or installed by this read-only adapter.
        prepareClockInstall({scope,ownerSub,priorMirror:null,observation,realNow:now()});
        return{status:'ready_observed' as const,observation:structuredClone(observation),...statistics(),physicalAuthorizationChecked:false as const};
      }finally{active=false;}
    },
  };
}
