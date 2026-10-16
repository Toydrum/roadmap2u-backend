import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactGetCommand } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentity, HttpRequest } from '@smithy/types';
import type { ClockDynamoHandler } from './stripe-test-clock-dynamo-transport';
import { prepareClockJournal, inspectClockWriteReadback, type ClockJournalIntent, type ClockWriteReadback } from './stripe-test-clock-journal';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

export interface ClockRecoveryReadbackOptions {
  originalRequestRaw:string; requestSha256:string; sourceSha:string; savedIntent:ClockJournalIntent;
  credentials:AwsCredentialIdentity; requestHandler:ClockDynamoHandler; now:()=>number;
  reserveWire:(kind:'readback')=>void; requestTimeoutMs?:number;
}
function requireCondition(ok:unknown,reason:string):asserts ok{if(!ok)throw Error('CLOCK_RECOVERY_READBACK_'+reason);}
function timestamp(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&Number.isFinite(new Date(v).getTime());}
function body(wire:HttpRequest):unknown{
  requireCondition(typeof wire.body==='string'||wire.body instanceof Uint8Array,'WIRE_BODY_REJECTED');
  return JSON.parse(Buffer.from(wire.body).toString('utf8'));
}
function client(credentials:AwsCredentialIdentity,requestHandler:ClockDynamoHandler){
  const base=new DynamoDBClient({region:'us-east-1',endpoint:'https://dynamodb.us-east-1.amazonaws.com',credentials,maxAttempts:1,requestHandler});
  return{document:DynamoDBDocumentClient.from(base),destroy:()=>base.destroy()};
}
/** Private read component only: new human authority, source and stack ownership
 * must be checked by a future coordinator before any external delegation. */
export async function prepareClockRecoveryReadback(options:ClockRecoveryReadbackOptions){
  try{
    const raw=options.originalRequestRaw,digest=options.requestSha256,source=options.sourceSha,intent=structuredClone(options.savedIntent);
    requireCondition(typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=256*1024&&/^[a-f0-9]{64}$/.test(digest)
      &&createHash('sha256').update(raw).digest('hex')===digest,'ORIGINAL_REQUEST_REQUIRED');
    const supplied=options.credentials,handler=options.requestHandler,now=options.now,reserve=options.reserveWire,timeout=options.requestTimeoutMs??10000;
    requireCondition(supplied&&typeof supplied.accessKeyId==='string'&&/^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId)
      &&typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0&&typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0
      &&supplied.expiration instanceof Date&&timestamp(supplied.expiration.getTime()),'CREDENTIALS_REQUIRED');
    requireCondition(handler&&typeof handler.handle==='function'&&typeof now==='function'&&typeof reserve==='function'
      &&Number.isSafeInteger(timeout)&&timeout>0&&timeout<=20000,'DEPENDENCIES_REQUIRED');
    const credentials={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration)};
    const delegate=handler.handle.bind(handler),destroy=handler.destroy?.bind(handler),preparedAt=now();
    const plan=await prepareClockJournal(JSON.parse(raw),source);
    requireCondition(isDeepStrictEqual(intent,plan.intent),'ORIGINAL_INTENT_MISMATCH');
    let previous=preparedAt;
    function fresh(){
      try{const t=now();requireCondition(timestamp(t)&&t>=previous&&t>=plan.intent.reservedAt&&t-preparedAt<TEST_CLOCK_EVIDENCE_MAX_AGE_MS
        &&credentials.expiration.getTime()>t+30000,'CONTEXT_EXPIRED');previous=t;return t;}
      catch{throw Error('CLOCK_RECOVERY_READBACK_CONTEXT_EXPIRED');}
    }
    fresh();
    // Capture the real SDK's serialization with an entirely in-memory handler.
    // Only a TransactGet command is constructed, including in this preparation.
    let expected:unknown,captures=0;
    const offline=client({accessKeyId:'synthetic',secretAccessKey:'synthetic'},{handle:async wire=>{
      requireCondition(captures++===0&&wire.headers['x-amz-target']==='DynamoDB_20120810.TransactGetItems','SERIALIZATION_REJECTED');
      expected=body(wire);return{response:{statusCode:200,headers:{},body:Buffer.from('{}')}};
    }});
    try{await offline.document.send(new TransactGetCommand(structuredClone(plan.readback)));}finally{offline.destroy();}
    requireCondition(captures===1&&expected!==undefined,'SERIALIZATION_REJECTED');
    let consumed=false,active=false,reservations=0,delegations=0;
    const counts=()=>({wireReservations:{readback:reservations},wireDelegations:{readback:delegations}});
    return{
      preview:{reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,readbackSha256:plan.intent.readbackSha256,
        maximumReadRequests:1,writeRequestsAllowed:0,physicalAuthorizationChecked:false as const,sourceShaVerified:false as const,physicalExecutionAllowed:false as const},
      counts,
      async observe(){
        requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;
        const guarded:ClockDynamoHandler={destroy,handle:async(wire,requestOptions)=>{
          requireCondition(active,'WIRE_INACTIVE');fresh();
          requireCondition(wire.protocol==='https:'&&wire.hostname==='dynamodb.us-east-1.amazonaws.com'&&(wire.port===undefined||wire.port===443)
            &&wire.method==='POST'&&wire.path==='/'&&(!wire.query||Object.keys(wire.query).length===0)&&wire.headers.host==='dynamodb.us-east-1.amazonaws.com'
            &&wire.headers['x-amz-target']==='DynamoDB_20120810.TransactGetItems'&&isDeepStrictEqual(body(wire),expected),'WIRE_SCOPE_REJECTED');
          requireCondition(reservations===0,'WIRE_LIMIT_REJECTED');reservations++;
          const reserved:unknown=reserve('readback');
          if(reserved&&typeof(reserved as {then?:unknown}).then==='function'){
            void Promise.resolve(reserved).catch(()=>undefined);throw Error('CLOCK_RECOVERY_READBACK_ASYNC_RESERVATION_REJECTED');
          }
          fresh();delegations++;return delegate(wire,requestOptions);
        }};
        const owned=client(credentials,guarded),abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        let inspected:ClockWriteReadback={status:'uncertain',reason:'READBACK_CONTEXT_INVALID',clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false};
        active=true;
        try{
          const startedAt=fresh();
          const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('CLOCK_RECOVERY_READBACK_TIMEOUT'));},timeout);});
          const response=await Promise.race([owned.document.send(new TransactGetCommand(structuredClone(plan.readback)),{abortSignal:abort.signal}),deadline]);
          const completedAt=fresh();
          inspected=inspectClockWriteReadback(plan,{transport:'TransactGetItems',requestSha256:plan.intent.readbackSha256,startedAt,completedAt,realNow:completedAt,response});
        }catch{/* Failed reads remain uncertain, with no write, retry or journal record. */}
        finally{active=false;clearTimeout(timer);try{owned.destroy();}catch{throw Error('CLOCK_RECOVERY_READBACK_CLEANUP_FAILED');}}
        return{...inspected,...counts(),transactionSha256:plan.intent.transactionSha256,readbackSha256:plan.intent.readbackSha256,
          physicalAuthorizationChecked:false as const,sourceShaVerified:false as const};
      },
    };
  }catch{throw Error('CLOCK_RECOVERY_READBACK_PREPARATION_REJECTED');}
}
