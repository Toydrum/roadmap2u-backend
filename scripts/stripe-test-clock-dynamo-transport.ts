import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentity, HttpHandlerOptions, HttpRequest, HttpResponse } from '@smithy/types';
import { isDeepStrictEqual } from 'node:util';
import { prepareClockJournal, reserveClockWrite, recordClockWriteDelivery, inspectClockWriteReadback, recordClockReadback, type ClockJournalRequest, type ClockWriteReadback, type PreparedClockJournal } from './stripe-test-clock-journal';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

type WireKind='write'|'readback';
export interface ClockDynamoHandler {
  handle(request:HttpRequest,options?:HttpHandlerOptions):Promise<{response:HttpResponse}>;
  destroy?():void;
}
export interface ClockDynamoOptions {
  request:ClockJournalRequest; sourceSha:string; journalDirectory:string;
  credentials:AwsCredentialIdentity; requestHandler:ClockDynamoHandler;
  now:()=>number; reserveWire:(kind:WireKind)=>void; requestTimeoutMs?:number;
}
interface ClockDynamoResult extends ClockWriteReadback {
  writeDelivery:'acknowledged'|'uncertain'; wireReservations:Record<WireKind,number>; wireDelegations:Record<WireKind,number>;
  transactionSha256:string; readbackSha256:string; physicalAuthorizationChecked:false;
}
function requireCondition(ok:unknown,reason:string):asserts ok {if(!ok)throw new Error(`CLOCK_DYNAMO_${reason}`);}
function timestamp(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&Number.isFinite(new Date(v).getTime());}
function body(request:HttpRequest):unknown {
  requireCondition(typeof request.body==='string'||request.body instanceof Uint8Array,'WIRE_BODY_REJECTED');
  return JSON.parse(Buffer.from(request.body).toString('utf8'));
}
function client(credentials:AwsCredentialIdentity,handler:ClockDynamoHandler){
  const base=new DynamoDBClient({region:'us-east-1',endpoint:'https://dynamodb.us-east-1.amazonaws.com',credentials,maxAttempts:1,requestHandler:handler});
  // DocumentClient.destroy is deliberately a no-op in the pinned SDK.
  return {sdk:DynamoDBDocumentClient.from(base),destroy:()=>base.destroy()};
}
/** Freeze the SDK's own serialization without any delegate, credentials lookup or network. */
async function wireBodies(plan:PreparedClockJournal):Promise<Record<WireKind,unknown>>{
  const captured:Partial<Record<WireKind,unknown>>={};
  const owned=client({accessKeyId:'synthetic',secretAccessKey:'synthetic'},{handle:async(request)=>{
    const operation=request.headers['x-amz-target'],kind=operation==='DynamoDB_20120810.TransactWriteItems'?'write':operation==='DynamoDB_20120810.TransactGetItems'?'readback':null;
    requireCondition(kind&&!Object.hasOwn(captured,kind),'SERIALIZATION_REJECTED');captured[kind]=body(request);
    return{response:{statusCode:200,headers:{},body:Buffer.from('{}')}};
  }});
  try{await owned.sdk.send(new TransactWriteCommand(structuredClone(plan.transaction)));await owned.sdk.send(new TransactGetCommand(structuredClone(plan.readback)));}finally{owned.destroy();}
  requireCondition(Object.hasOwn(captured,'write')&&Object.hasOwn(captured,'readback'),'SERIALIZATION_REJECTED');
  return captured as Record<WireKind,unknown>;
}
/** Transport component only. Its future physical caller must verify the human window and actual AWS identity. */
export async function prepareClockDynamoExecutor(options:ClockDynamoOptions){
  const request=structuredClone(options.request),sourceSha=options.sourceSha,journalDirectory=options.journalDirectory;
  const supplied=options.credentials;
  requireCondition(supplied&&typeof supplied==='object'&&typeof supplied.accessKeyId==='string'&&supplied.accessKeyId.length>0
    &&typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0&&typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0
    &&supplied.expiration instanceof Date&&timestamp(supplied.expiration.getTime()),'CREDENTIAL_SNAPSHOT_REQUIRED');
  const credentials:AwsCredentialIdentity={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration.getTime())};
  const handler=options.requestHandler,now=options.now,reserveWire=options.reserveWire,timeout=options.requestTimeoutMs??20000;
  requireCondition(handler&&typeof handler.handle==='function','HANDLER_REQUIRED');requireCondition(typeof reserveWire==='function','BUDGET_REQUIRED');
  requireCondition(typeof now==='function','CLOCK_REQUIRED');requireCondition(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=20000,'TIMEOUT_INVALID');
  const plan=await prepareClockJournal(request,sourceSha),counts={write:0,readback:0},delegations={write:0,readback:0};
  function fresh(){const t=now();requireCondition(timestamp(t)&&t>=plan.intent.reservedAt&&t-plan.intent.reservedAt<TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'CONTEXT_EXPIRED');
    requireCondition(credentials.expiration!.getTime()>t+30000,'CREDENTIALS_EXPIRED');return t;}
  fresh();const expected=await wireBodies(plan);let consumed=false;
  return {
    preview:structuredClone({intent:plan.intent,writeMaximum:1,readbackMaximum:1,physicalAuthorizationChecked:false}),
    async execute():Promise<ClockDynamoResult>{
      requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;fresh();reserveClockWrite(journalDirectory,plan);
      const guarded:ClockDynamoHandler={handle:async(request,requestOptions)=>{
        fresh();const target=request.headers['x-amz-target'],kind:WireKind|null=target==='DynamoDB_20120810.TransactWriteItems'?'write':target==='DynamoDB_20120810.TransactGetItems'?'readback':null;
        requireCondition(kind&&request.protocol==='https:'&&request.hostname==='dynamodb.us-east-1.amazonaws.com'&&(request.port===undefined||request.port===443)
          &&request.method==='POST'&&request.path==='/'&&(!request.query||Object.keys(request.query).length===0)&&request.headers.host==='dynamodb.us-east-1.amazonaws.com','WIRE_SCOPE_REJECTED');
        requireCondition(isDeepStrictEqual(body(request),expected[kind]),'WIRE_BODY_REJECTED');
        requireCondition(counts[kind]===0&&(kind==='write'||delegations.write===1),'WIRE_LIMIT_REJECTED');
        // Reserve before handing a signed request to the supplied transport.
        counts[kind]++;reserveWire(kind);delegations[kind]++;
        return handler.handle(request,requestOptions);
      },destroy:()=>handler.destroy?.()};
      const owned=client(credentials,guarded),sdk=owned.sdk;
      async function bounded<T>(send:(signal:AbortSignal)=>Promise<T>):Promise<T>{
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('CLOCK_DYNAMO_REQUEST_TIMEOUT'));},timeout);});
        try{return await Promise.race([send(controller.signal),deadline]);}finally{clearTimeout(timer);}
      }
      try{
        let writeDelivery:'acknowledged'|'uncertain'='uncertain';
        try{const response=await bounded(signal=>sdk.send(new TransactWriteCommand(structuredClone(plan.transaction)),{abortSignal:signal}));if(response.$metadata.httpStatusCode===200)writeDelivery='acknowledged';}catch{/* No raw SDK/provider error leaves this component. */}
        recordClockWriteDelivery(journalDirectory,plan,{delivery:writeDelivery,recordedAt:now()});
        const startedAt=now();let response:unknown={$metadata:{httpStatusCode:0},Responses:[]};
        if(delegations.write===1){try{response=await bounded(signal=>sdk.send(new TransactGetCommand(structuredClone(plan.readback)),{abortSignal:signal}));}catch{/* A failed readback is uncertainty, never a retry instruction. */}}
        const observation={transport:'TransactGetItems',requestSha256:plan.intent.readbackSha256,startedAt,completedAt:now(),realNow:now(),response};
        const verified=inspectClockWriteReadback(plan,observation);recordClockReadback(journalDirectory,plan,observation);
        return{...verified,writeDelivery,wireReservations:{...counts},wireDelegations:{...delegations},transactionSha256:plan.intent.transactionSha256,readbackSha256:plan.intent.readbackSha256,physicalAuthorizationChecked:false};
      }finally{owned.destroy();}
    },
  };
}
