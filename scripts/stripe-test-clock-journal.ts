import type { TransactGetCommandInput, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prepareClockInstallTransaction, type ClockInstallRequest } from './stripe-test-clock-install';
import { prepareClockTransitionTransaction, type ClockTransitionRequest } from './stripe-test-clock-transition';
import type { PreparedClockEvidence } from './stripe-test-clock-evidence';
import { resolveFinancialClock, TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

export const CLOCK_ADVANCE_FENCE_MAX_AGE_MS = 2 * 60_000;

export type ClockJournalRequest = ClockInstallRequest | ClockTransitionRequest;
interface JournalScope {
  awsAccountId:string; region:string; stage:string; appTableName:string; privacyTableName:string;
  ownerSub:string; stripeAccountId:string; customerId:string; testClockId:string; bindingId:string;
}
export interface ClockJournalIntent {
  schemaVersion:1; reservationId:string; sourceSha:string; operationId:string; phase:PreparedClockEvidence['kind'];
  scope:JournalScope; reservedAt:number; clientRequestToken:string; transactionSha256:string; readbackSha256:string;
}
export interface PreparedClockJournal {
  intent:ClockJournalIntent; transaction:TransactWriteCommandInput; readback:TransactGetCommandInput;
  expectedItems:Record<string,unknown>[]; evidence:PreparedClockEvidence; physicalExecutionAllowed:false;
}
export interface ClockWriteReadback {
  status:'verified_applied'|'uncertain'; reason:'EXACT_ATOMIC_READBACK'|'READBACK_CONTEXT_INVALID'|'READBACK_ITEMS_DIFFER';
  clockReadable:boolean; retryAllowed:false; physicalExecutionAllowed:false;
}
type Delivery='acknowledged'|'uncertain'|'rejected';
function requireCondition(ok:unknown,reason:string):asserts ok { if(!ok)throw new Error(`CLOCK_JOURNAL_${reason}`); }
function record(v:unknown):v is Record<string,unknown>{return !!v && typeof v==='object' && !Array.isArray(v);}
function timestamp(v:unknown):v is number{return typeof v==='number' && Number.isSafeInteger(v) && v>=0 && Number.isFinite(new Date(v).getTime());}
function canonical(v:unknown):string {
  if(v===null || typeof v==='string' || typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='number'){requireCondition(Number.isFinite(v),'NON_JSON_REQUEST');return JSON.stringify(v);}
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  requireCondition(record(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v)),'NON_JSON_REQUEST');
  return '{'+Object.keys(v).sort().map(key=>JSON.stringify(key)+':'+canonical(v[key])).join(',')+'}';
}
function digest(v:unknown){return createHash('sha256').update(canonical(v)).digest('hex');}
function reservationId(i:Pick<ClockJournalIntent,'operationId'|'phase'|'scope'>){return digest({schemaVersion:1,operationId:i.operationId,phase:i.phase,scope:i.scope});}
function readbackFor(transaction:TransactWriteCommandInput){
  const puts=transaction.TransactItems?.filter(item=>item.Put).map(item=>item.Put!) ?? [];
  requireCondition(puts.length===2 || puts.length===4,'PUT_ITEMS_REQUIRED');
  for(const put of puts)requireCondition(typeof put.TableName==='string' && record(put.Item) && typeof put.Item.pk==='string' && typeof put.Item.sk==='string','PUT_KEY_REQUIRED');
  return {readback:{TransactItems:puts.map(put=>({Get:{TableName:put.TableName!,Key:{pk:put.Item!.pk,sk:put.Item!.sk}}}))},expectedItems:puts.map(put=>structuredClone(put.Item!))};
}
/** Calls the real preparators. The returned journal is evidence data, never physical authority. */
export async function prepareClockJournal(request:ClockJournalRequest,sourceSha:string):Promise<PreparedClockJournal>{
  const captured=structuredClone(request);
  requireCondition(typeof sourceSha==='string' && /^[a-f0-9]{40}$/.test(sourceSha),'SOURCE_SHA_REQUIRED');
  const prepared='kind' in captured?await prepareClockTransitionTransaction(captured):await prepareClockInstallTransaction(captured);
  const r=prepared.evidence.reference,s=captured.storage;
  const scope:JournalScope={awsAccountId:s.awsAccountId,region:s.region,stage:r.stage,appTableName:captured.clock.scope.tableName,privacyTableName:s.privacyTableName,
    ownerSub:r.ownerSub,stripeAccountId:r.stripeAccountId,customerId:r.customerId,testClockId:r.testClockId,bindingId:r.bindingId};
  const {readback,expectedItems}=readbackFor(prepared.transaction),phase=prepared.evidence.kind;
  const intent:ClockJournalIntent={schemaVersion:1,reservationId:reservationId({operationId:captured.operationId,phase,scope}),sourceSha,
    operationId:captured.operationId,phase,scope,reservedAt:captured.clock.realNow,clientRequestToken:prepared.transaction.ClientRequestToken!,
    transactionSha256:digest(prepared.transaction),readbackSha256:digest(readback)};
  return {intent,transaction:structuredClone(prepared.transaction),readback:structuredClone(readback),expectedItems:structuredClone(expectedItems),evidence:structuredClone(prepared.evidence),physicalExecutionAllowed:false};
}
function assertPlan(plan:PreparedClockJournal):void {
  const i=plan.intent,s=i.scope;
  const safe:ClockJournalIntent={schemaVersion:i.schemaVersion,reservationId:i.reservationId,sourceSha:i.sourceSha,operationId:i.operationId,phase:i.phase,
    scope:{awsAccountId:s.awsAccountId,region:s.region,stage:s.stage,appTableName:s.appTableName,privacyTableName:s.privacyTableName,
      ownerSub:s.ownerSub,stripeAccountId:s.stripeAccountId,customerId:s.customerId,testClockId:s.testClockId,bindingId:s.bindingId},reservedAt:i.reservedAt,
    clientRequestToken:i.clientRequestToken,transactionSha256:i.transactionSha256,readbackSha256:i.readbackSha256};
  requireCondition(isDeepStrictEqual(i,safe) && i.schemaVersion===1 && /^[a-f0-9]{40}$/.test(i.sourceSha) && /^[A-Za-z0-9:_-]{1,128}$/.test(i.operationId)
    && ['install','advance_fence','ready','refresh'].includes(i.phase) && timestamp(i.reservedAt) && i.reservationId===reservationId(i)
    && Object.values(s).every(v=>typeof v==='string' && v.length>0),'PLAN_MISMATCH');
  const derived=readbackFor(plan.transaction);
  requireCondition(plan.physicalExecutionAllowed===false && i.transactionSha256===digest(plan.transaction) && i.readbackSha256===digest(plan.readback)
    && i.clientRequestToken===plan.transaction.ClientRequestToken && isDeepStrictEqual(plan.readback,derived.readback)
    && isDeepStrictEqual(plan.expectedItems,derived.expectedItems) && i.phase===plan.evidence.kind
    && plan.expectedItems.some(item=>isDeepStrictEqual(item,plan.evidence.mirror)),'PLAN_MISMATCH');
}
function journalPath(directory:string,intent:ClockJournalIntent,kind:'intent'|'delivery'|'readback'|'provider-advance-intent'|'provider-advance-result'){return join(realpathSync(directory),`${intent.reservationId}.${kind}.json`);}
function exclusive(file:string,value:unknown):string {
  const fd=openSync(file,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  return file;
}
function readReceipt(file:string):unknown {const raw=readFileSync(file,'utf8');try{return JSON.parse(raw);}catch{throw new Error('CLOCK_JOURNAL_INVALID_RECEIPT');}}
function assertSavedIntent(directory:string,plan:PreparedClockJournal):void {
  assertPlan(plan);requireCondition(isDeepStrictEqual(readReceipt(journalPath(directory,plan.intent,'intent')),plan.intent),'INTENT_MISMATCH');
}
/** Exclusive reservation must succeed before the separately authorized future sender. No retry path. */
export function reserveClockWrite(directory:string,plan:PreparedClockJournal):string {assertPlan(plan);return exclusive(journalPath(directory,plan.intent,'intent'),plan.intent);}
function deliveryReceipt(plan:PreparedClockJournal,result:unknown){
  requireCondition(record(result) && Object.keys(result).length===2 && ['acknowledged','uncertain','rejected'].includes(result.delivery as string)
    && timestamp(result.recordedAt) && result.recordedAt>=plan.intent.reservedAt,'DELIVERY_INVALID');
  return {schemaVersion:1,reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,delivery:result.delivery as Delivery,
    recordedAt:result.recordedAt,retryAllowed:false,physicalExecutionAllowed:false};
}
export function recordClockWriteDelivery(directory:string,plan:PreparedClockJournal,result:unknown):string {
  const receipt=deliveryReceipt(plan,result);assertSavedIntent(directory,plan);return exclusive(journalPath(directory,plan.intent,'delivery'),receipt);
}
/** Exact atomic state proof only; missing or changed data never authorizes another write. */
export function inspectClockWriteReadback(plan:PreparedClockJournal,observation:unknown):ClockWriteReadback {
  assertPlan(plan);
  const uncertain=(reason:ClockWriteReadback['reason']):ClockWriteReadback=>({status:'uncertain',reason,clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false});
  if(!record(observation) || observation.transport!=='TransactGetItems' || observation.requestSha256!==plan.intent.readbackSha256
    || !timestamp(observation.startedAt) || !timestamp(observation.completedAt) || !timestamp(observation.realNow)
    || observation.startedAt<plan.intent.reservedAt || observation.completedAt<observation.startedAt || observation.realNow<observation.completedAt
    || observation.realNow-observation.startedAt>=TEST_CLOCK_EVIDENCE_MAX_AGE_MS)return uncertain('READBACK_CONTEXT_INVALID');
  const response=observation.response;
  if(!record(response) || !record(response.$metadata) || response.$metadata.httpStatusCode!==200)return uncertain('READBACK_CONTEXT_INVALID');
  if(!Array.isArray(response.Responses) || response.Responses.length!==plan.expectedItems.length
    || !response.Responses.every((row,index)=>record(row) && isDeepStrictEqual(row.Item,plan.expectedItems[index])))return uncertain('READBACK_ITEMS_DIFFER');
  const s=plan.intent.scope;
  const clock=resolveFinancialClock({ownerSub:s.ownerSub,customerId:s.customerId,stage:s.stage,accountId:s.stripeAccountId,liveMode:false,reference:plan.evidence.reference,
    now:observation.realNow,providerTestClockId:s.testClockId},plan.evidence.mirror);
  return {status:'verified_applied',reason:'EXACT_ATOMIC_READBACK',clockReadable:clock.mode==='simulation',retryAllowed:false,physicalExecutionAllowed:false};
}
export function recordClockReadback(directory:string,plan:PreparedClockJournal,observation:unknown):string {
  assertSavedIntent(directory,plan);
  const delivery=readReceipt(journalPath(directory,plan.intent,'delivery'));
  requireCondition(record(delivery) && isDeepStrictEqual(delivery,deliveryReceipt(plan,{delivery:delivery.delivery,recordedAt:delivery.recordedAt})),'DELIVERY_INVALID');
  const inspected=inspectClockWriteReadback(plan,observation);
  requireCondition(record(observation) && timestamp(observation.realNow) && observation.realNow>=plan.intent.reservedAt,'RESULT_TIME_REQUIRED');
  return exclusive(journalPath(directory,plan.intent,'readback'),{schemaVersion:1,reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,
    readbackSha256:plan.intent.readbackSha256,recordedAt:observation.realNow,...inspected});
}
/** Exact provider request data derived only from the pending fence; not physical authority. */
export function prepareClockProviderAdvance(plan:PreparedClockJournal){
  assertPlan(plan);const pending=plan.evidence.mirror.providerReadyEvidence;
  requireCondition(plan.intent.phase==='advance_fence'&&pending.status==='advancing'&&pending.operationId===plan.intent.operationId,'ADVANCE_FENCE_REQUIRED');
  const body=`frozen_time=${pending.targetFrozenTimeSeconds}`;
  return{schemaVersion:1,reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,readbackSha256:plan.intent.readbackSha256,
    operationId:plan.intent.operationId,testClockId:plan.intent.scope.testClockId,priorFrozenTimeSeconds:plan.evidence.reference.frozenTimeSeconds,
    targetFrozenTimeSeconds:pending.targetFrozenTimeSeconds,apiVersion:STRIPE_API_VERSION,bodySha256:createHash('sha256').update(body).digest('hex'),
    body,idempotencyKey:'r2u-clock-advance-'+digest({reservation:plan.intent.reservationId,target:pending.targetFrozenTimeSeconds}).slice(0,48)};
}
/** Requires the real matching journal records, never a caller-supplied verified flag. */
export function assertVerifiedClockFence(directory:string,plan:PreparedClockJournal,realNow:number):void {
  prepareClockProviderAdvance(plan);assertSavedIntent(directory,plan);
  const delivery=readReceipt(journalPath(directory,plan.intent,'delivery'));
  requireCondition(record(delivery)&&isDeepStrictEqual(delivery,deliveryReceipt(plan,{delivery:delivery.delivery,recordedAt:delivery.recordedAt}))
    &&['acknowledged','uncertain'].includes(delivery.delivery as string),'VERIFIED_FENCE_REQUIRED');
  const r=readReceipt(journalPath(directory,plan.intent,'readback'));
  requireCondition(record(r)&&isDeepStrictEqual(r,{schemaVersion:1,reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,
    readbackSha256:plan.intent.readbackSha256,recordedAt:r.recordedAt,status:'verified_applied',reason:'EXACT_ATOMIC_READBACK',clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false}),'VERIFIED_FENCE_REQUIRED');
  requireCondition(timestamp(realNow)&&timestamp(r.recordedAt)&&r.recordedAt>=plan.intent.reservedAt&&realNow>=r.recordedAt
    &&realNow-r.recordedAt<CLOCK_ADVANCE_FENCE_MAX_AGE_MS&&realNow-plan.intent.reservedAt<TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'FENCE_EXPIRED');
}
export function reserveClockProviderAdvance(directory:string,plan:PreparedClockJournal,realNow:number):string {
  assertVerifiedClockFence(directory,plan,realNow);return exclusive(journalPath(directory,plan.intent,'provider-advance-intent'),{...prepareClockProviderAdvance(plan),reservedAt:realNow});
}
export function assertClockProviderAdvanceReservation(directory:string,plan:PreparedClockJournal,realNow:number):void {
  const descriptor=prepareClockProviderAdvance(plan),saved=readReceipt(journalPath(directory,plan.intent,'provider-advance-intent'));
  requireCondition(record(saved)&&timestamp(saved.reservedAt)&&saved.reservedAt>=plan.intent.reservedAt&&timestamp(realNow)&&realNow>=saved.reservedAt
    &&isDeepStrictEqual(saved,{...descriptor,reservedAt:saved.reservedAt}),'PROVIDER_INTENT_MISMATCH');
}
export function recordClockProviderAdvanceResult(directory:string,plan:PreparedClockJournal,result:{status:'advance_acknowledged'|'uncertain';recordedAt:number}):string {
  assertClockProviderAdvanceReservation(directory,plan,result.recordedAt);const descriptor=prepareClockProviderAdvance(plan);
  requireCondition(Object.keys(result).length===2&&['advance_acknowledged','uncertain'].includes(result.status)&&timestamp(result.recordedAt),'PROVIDER_RESULT_INVALID');
  return exclusive(journalPath(directory,plan.intent,'provider-advance-result'),{schemaVersion:1,reservationId:plan.intent.reservationId,transactionSha256:plan.intent.transactionSha256,
    targetFrozenTimeSeconds:descriptor.targetFrozenTimeSeconds,status:result.status,recordedAt:result.recordedAt,retryAllowed:false,readyEvidencePublished:false,physicalAuthorizationChecked:false});
}
