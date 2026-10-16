import Stripe from 'stripe';
import type { ClockTransitionRequest } from './stripe-test-clock-transition';
import { type ClockJournalDirectory, prepareClockJournal, prepareClockProviderAdvance, assertVerifiedClockFence, assertClockProviderAdvanceReservation, reserveClockProviderAdvance, recordClockProviderAdvanceResult } from './stripe-test-clock-journal';
import { prepareClockStripeObserver } from './stripe-test-clock-stripe-observation';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

type WireKind='account'|'customer'|'clock'|'advance';
export interface ClockStripeAdvanceOptions {
  fence:ClockTransitionRequest; sourceSha:string; journalDirectory:ClockJournalDirectory; apiKey:string; httpClient:Stripe.HttpClient;
  now:()=>number; reserveWire:(kind:WireKind)=>void; requestTimeoutMs?:number;
}
function requireCondition(ok:unknown,reason:string):asserts ok {if(!ok)throw new Error(`CLOCK_ADVANCE_${reason}`);}
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
/** Future physical caller must verify its exact human window and serialize the private operation. */
export async function prepareClockStripeAdvance(options:ClockStripeAdvanceOptions){
  const fence=structuredClone(options.fence),sourceSha=options.sourceSha,directory=options.journalDirectory,key=options.apiKey,delegate=options.httpClient,
    now=options.now,reserveWire=options.reserveWire,timeout=options.requestTimeoutMs??10000;
  requireCondition(fence.kind==='advance_fence','FENCE_PHASE_REQUIRED');
  const observer=prepareClockStripeObserver({scope:fence.clock.scope,ownerSub:fence.clock.ownerSub,apiKey:key,httpClient:delegate,now,reserveWire,requestTimeoutMs:timeout});
  const makeRequest=delegate.makeRequest.bind(delegate),plan=await prepareClockJournal(fence,sourceSha),descriptor=prepareClockProviderAdvance(plan);
  const path=`/v1/test_helpers/test_clocks/${encodeURIComponent(descriptor.testClockId)}/advance`;
  let consumed=false,active=false,reservations=0,delegations=0;
  const guarded:Stripe.HttpClient={getClientName:()=> 'roadmap2u-clock-advance',makeRequest:async(host,port,p,method,headers,data,protocol,requestTimeout)=>{
    requireCondition(active,'WIRE_CONTEXT_REJECTED');assertVerifiedClockFence(directory,plan,now());assertClockProviderAdvanceReservation(directory,plan,now());
    requireCondition(host==='api.stripe.com'&&port==='443'&&protocol==='https'&&p===path&&method==='POST'&&data===descriptor.body
      &&headers['Stripe-Version']===STRIPE_API_VERSION&&headers['Stripe-Account']===undefined&&headers['Stripe-Context']===undefined
      &&headers.Authorization==='Bearer '+key&&headers['Idempotency-Key']===descriptor.idempotencyKey&&requestTimeout===timeout,'WIRE_SCOPE_REJECTED');
    requireCondition(reservations===0,'WIRE_LIMIT_REJECTED');reservations++;reserveWire('advance');delegations++;
    return makeRequest(host,port,p,method,headers,data,protocol,requestTimeout);
  }};
  const stripe=new Stripe(key,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:0,timeout,httpClient:guarded,telemetry:false});
  return{
    preview:structuredClone({...descriptor,physicalAuthorizationChecked:false,readyEvidencePublished:false}),
    async execute(){
      requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;reserveClockProviderAdvance(directory,plan,now());active=true;
      let status:'advance_acknowledged'|'uncertain'='uncertain';
      try{
        const observed=await observer.observe();requireCondition(observed.observation.clock.frozen_time===descriptor.priorFrozenTimeSeconds,'PRIOR_PROVIDER_TIME_MISMATCH');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('CLOCK_ADVANCE_REQUEST_TIMEOUT')),timeout);});
          const response:unknown=await Promise.race([stripe.testHelpers.testClocks.advance(descriptor.testClockId,{frozen_time:descriptor.targetFrozenTimeSeconds},{idempotencyKey:descriptor.idempotencyKey}),deadline]);
          requireCondition(record(response)&&record(response.lastResponse)&&response.lastResponse.statusCode===200&&response.id===descriptor.testClockId
            &&response.object==='test_helpers.test_clock'&&response.livemode===false&&response.status==='advancing'
            &&typeof response.frozen_time==='number'&&Number.isSafeInteger(response.frozen_time)&&response.frozen_time>=descriptor.priorFrozenTimeSeconds&&response.frozen_time<=descriptor.targetFrozenTimeSeconds
            &&typeof response.deletes_after==='number'&&Number.isSafeInteger(response.deletes_after)&&response.deletes_after*1000>now(),'ACKNOWLEDGEMENT_INVALID');
          if(response.status_details!==undefined){requireCondition(record(response.status_details),'ACKNOWLEDGEMENT_INVALID');const advancing=response.status_details.advancing;
            requireCondition(advancing===undefined||(record(advancing)&&advancing.target_frozen_time===descriptor.targetFrozenTimeSeconds),'ACKNOWLEDGEMENT_INVALID');}
          status='advance_acknowledged';
        }finally{clearTimeout(timer);}
      }catch{/* Uncertain or rejected responses never cause a provider replay or ready write. */}finally{active=false;}
      recordClockProviderAdvanceResult(directory,plan,{status,recordedAt:now()});
      const reads=observer.counts();return{status,reservationId:plan.intent.reservationId,targetFrozenTimeSeconds:descriptor.targetFrozenTimeSeconds,
        wireReservations:{...reads.wireReservations,advance:reservations},wireDelegations:{...reads.wireDelegations,advance:delegations},retryAllowed:false,readyEvidencePublished:false,physicalAuthorizationChecked:false};
    },
  };
}
