import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync } from 'node:fs';
import { resolve,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ClockCallerManifest } from './stripe-test-clock-authority';
import { selectClockPublisherFixture } from './stripe-test-clock-evidence';
import { prepareClockJournal,type ClockJournalIntent } from './stripe-test-clock-journal';
import { assertDurableClockJournal,readDurableClockJournalFile,readDurableClockJournalProgram,writeDurableClockJournalFile,
  type DurableClockJournal } from './stripe-test-clock-durable-store';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

interface JournalBinding {directory:string;directoryId:string;aclSha256:string}
export interface ClockRecoveryManifest {
  schemaVersion:1;kind:'clock_recovery_read_only';sourceSha:string;operationId:string;
  clock:ClockCallerManifest['clock'];storage:ClockCallerManifest['storage'];expectedCallerArn:string;
  cloudformation:ClockCallerManifest['cloudformation'];attemptJournal:JournalBinding;priorJournal:JournalBinding|null;
  runtime:NonNullable<ClockCallerManifest['runtime']>&{awsCliExecutable:string;awsCliSha256:string};
  original:null|{sourceSha:string;requestSha256:string;intentSha256:string;reservationId:string};
}
export interface ClockRecoveryAuthority {
  readonly stage:string;readonly sourceSha:string;readonly operationId:string;readonly manifestSha256:string;
  readonly sourceShaVerified:true;readonly authorizationReceiptBound:true;readonly stackOwnershipVerified:false;
  readonly maximumReadRequests:15|16;readonly remoteWritesAllowed:0;readonly providerAdvancesAllowed:0;
  readonly retryAllowed:false;readonly physicalExecutionAllowed:false;readonly verifiedAt:number;readonly expiresAt:number;
}
interface Original {requestRaw:string;savedIntent:ClockJournalIntent}
interface Bound {manifest:ClockRecoveryManifest;original:Original|null;verifiedAt:number;expiresAt:number;
  callIdSha256:string;attemptId:string;approvedRootCommit:string;issuedAt:number;
  source:{root:string;reviewRoot:string;manifestPath:string;selfFile:string;selfPath:string}}
const authorities=new WeakMap<object,Bound>();
const HEX=/^[a-f0-9]{64}$/,SOURCE=/^[a-f0-9]{40}$/,MAX=256*1024;
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function requireCondition(ok:unknown,code:string):asserts ok{if(!ok)throw Error('CLOCK_RECOVERY_AUTHORITY_'+code);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function stamp(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value).getTime());}
function keys(value:unknown,names:string[]):asserts value is Record<string,unknown>{
  requireCondition(record(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)),'SHAPE_REJECTED');
}
function parse(raw:unknown):unknown{
  requireCondition(typeof raw==='string'&&Buffer.byteLength(raw)<=MAX,'INPUT_REJECTED');
  try{return JSON.parse(raw);}catch{throw Error('CLOCK_RECOVERY_AUTHORITY_JSON_REJECTED');}
}
function path(value:unknown):asserts value is string{
  requireCondition(typeof value==='string'&&/^[A-Za-z]:[\\/]/.test(value)&&value.length<=240&&!/[<>:"|?*\x00-\x1f]/.test(value.slice(2)),'PATH_REJECTED');
}
function journal(value:unknown):asserts value is JournalBinding{
  keys(value,['directory','directoryId','aclSha256']);path(value.directory);
  requireCondition(typeof value.directoryId==='string'&&HEX.test(value.directoryId)&&typeof value.aclSha256==='string'&&HEX.test(value.aclSha256),'JOURNAL_REJECTED');
}
function manifest(raw:unknown,now:number):ClockRecoveryManifest{
  const m=parse(raw);
  keys(m,['schemaVersion','kind','sourceSha','operationId','clock','storage','expectedCallerArn','cloudformation','attemptJournal','priorJournal','runtime','original']);
  requireCondition(m.schemaVersion===1&&m.kind==='clock_recovery_read_only'&&typeof m.sourceSha==='string'&&SOURCE.test(m.sourceSha)
    &&typeof m.operationId==='string'&&/^[A-Za-z0-9:_-]{8,128}$/.test(m.operationId),'MANIFEST_REJECTED');
  keys(m.clock,['ownerSub','scope']);keys(m.clock.scope,['tableName','stage','stripeAccountId','liveMode','fixtures']);
  requireCondition(Array.isArray(m.clock.scope.fixtures),'FIXTURES_REJECTED');
  for(const f of m.clock.scope.fixtures)keys(f,['ownerSub','customerId','testClockId','bindingId','stage','stripeAccountId','syntheticFixture']);
  try{selectClockPublisherFixture({...m.clock as unknown as ClockRecoveryManifest['clock'],realNow:now});}
  catch{throw Error('CLOCK_RECOVERY_AUTHORITY_SCOPE_REJECTED');}
  keys(m.storage,['stage','awsAccountId','region','appTableArn','privacyTableName','privacyTableArn']);
  const stage=m.clock.scope.stage;
  requireCondition(m.storage.stage===stage&&m.storage.awsAccountId==='765932874577'&&m.storage.region==='us-east-1'
    &&m.clock.scope.tableName==='roadmap-'+stage&&m.storage.privacyTableName==='roadmap-privacy-'+stage
    &&m.storage.appTableArn==='arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-'+stage
    &&m.storage.privacyTableArn==='arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-privacy-'+stage,'STORAGE_REJECTED');
  requireCondition(typeof m.expectedCallerArn==='string'&&/^arn:aws:(?:sts::765932874577:assumed-role|iam::765932874577:user)\/[A-Za-z0-9_+=,.@/-]+$/.test(m.expectedCallerArn),'CALLER_REJECTED');
  keys(m.cloudformation,['stackName','stackId','resources']);const cloud=m.cloudformation;
  requireCondition(cloud.stackName==='Roadmap-'+stage+'-Backend'&&typeof cloud.stackId==='string'
    &&new RegExp('^arn:aws:cloudformation:us-east-1:765932874577:stack/Roadmap-'+stage+'-Backend/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$').test(cloud.stackId)
    &&Array.isArray(cloud.resources)&&cloud.resources.length===3,'STACK_REJECTED');
  for(const r of cloud.resources){
    keys(r,['kind','logicalId','physicalId','resourceType']);
    requireCondition(['app','privacy','pool'].includes(r.kind as string)&&typeof r.logicalId==='string'&&/^[A-Za-z][A-Za-z0-9]{0,254}$/.test(r.logicalId),'RESOURCE_REJECTED');
    requireCondition(r.kind==='pool'?r.resourceType==='AWS::Cognito::UserPool'&&typeof r.physicalId==='string'&&/^us-east-1_[A-Za-z0-9]+$/.test(r.physicalId)
      :r.resourceType==='AWS::DynamoDB::Table'&&r.physicalId===(r.kind==='app'?m.clock.scope.tableName:m.storage.privacyTableName),'RESOURCE_REJECTED');
  }
  requireCondition(new Set(cloud.resources.map(r=>r.kind)).size===3&&new Set(cloud.resources.map(r=>r.logicalId)).size===3,'RESOURCE_REJECTED');
  journal(m.attemptJournal);
  if(m.priorJournal!==null){
    journal(m.priorJournal);requireCondition(m.priorJournal.directoryId!==m.attemptJournal.directoryId
      &&m.priorJournal.directory.replaceAll('\\','/').toLowerCase()!==m.attemptJournal.directory.replaceAll('\\','/').toLowerCase(),'JOURNAL_ALIAS_REJECTED');
  }
  keys(m.runtime,['powershellExecutable','powershellSha256','caBundleSha256','awsCliExecutable','awsCliSha256']);
  path(m.runtime.powershellExecutable);path(m.runtime.awsCliExecutable);
  requireCondition(typeof m.runtime.powershellSha256==='string'&&HEX.test(m.runtime.powershellSha256)
    &&typeof m.runtime.caBundleSha256==='string'&&HEX.test(m.runtime.caBundleSha256)
    &&typeof m.runtime.awsCliSha256==='string'&&HEX.test(m.runtime.awsCliSha256),'RUNTIME_REJECTED');
  if(m.original!==null){
    keys(m.original,['sourceSha','requestSha256','intentSha256','reservationId']);
    const original=m.original;
    requireCondition(m.priorJournal!==null&&typeof original.sourceSha==='string'&&SOURCE.test(original.sourceSha)
      &&['requestSha256','intentSha256','reservationId'].every(k=>typeof original[k]==='string'&&HEX.test(original[k] as string)),'ORIGINAL_REJECTED');
  }
  return structuredClone(m) as unknown as ClockRecoveryManifest;
}
async function original(m:ClockRecoveryManifest,raw:unknown,intent:unknown):Promise<Original|null>{
  if(m.original===null){requireCondition(raw===undefined&&intent===undefined,'UNEXPECTED_ORIGINAL');return null;}
  requireCondition(typeof raw==='string'&&Buffer.byteLength(raw)<=MAX&&digest(raw)===m.original.requestSha256
    &&record(intent)&&digest(JSON.stringify(intent))===m.original.intentSha256,'ORIGINAL_REJECTED');
  let plan;
  try{plan=await prepareClockJournal(JSON.parse(raw),m.original.sourceSha);}
  catch{throw Error('CLOCK_RECOVERY_AUTHORITY_ORIGINAL_REJECTED');}
  const request=JSON.parse(raw);
  requireCondition(isDeepStrictEqual(intent,plan.intent)&&plan.intent.reservationId===m.original.reservationId
    &&plan.intent.operationId!==m.operationId&&isDeepStrictEqual(request.clock.scope,m.clock.scope)
    &&request.clock.ownerSub===m.clock.ownerSub&&isDeepStrictEqual(request.storage,m.storage),'ORIGINAL_REJECTED');
  return{requestRaw:raw,savedIntent:structuredClone(plan.intent)};
}
function inside(root:string,file:string){
  const rel=relative(root,file);requireCondition(rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep),'PATH_REJECTED');return rel.replaceAll('\\','/');
}
function regular(file:string,maximum=MAX){
  const st=lstatSync(file);requireCondition(st.isFile()&&!st.isSymbolicLink(),'REGULAR_FILE_REQUIRED');
  const fd=openSync(file,'r');try{
    const before=fstatSync(fd);requireCondition(before.isFile()&&before.size<=maximum,'FILE_BOUND');
    const bytes=Buffer.alloc(maximum+1);let count=0;
    while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
    const after=fstatSync(fd);
    requireCondition(count<=maximum&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'FILE_CHANGED');return bytes.subarray(0,count);
  }finally{closeSync(fd);}
}
function git(root:string,args:string[],bytes=false):string|Buffer{
  const out=execFileSync('git',['--no-pager','--no-optional-locks','-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,...args],
    {timeout:10000,maxBuffer:2*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});return bytes?out:out.toString('utf8').trim();
}
function committed(root:string,file:string,selfPath:string){
  git(root,['ls-files','--error-unmatch','--',selfPath]);const raw=regular(file,2*1024*1024),blob=git(root,['show','HEAD:'+selfPath],true) as Buffer;
  requireCondition(blob.equals(raw)||blob.equals(Buffer.from(new TextDecoder('utf-8',{fatal:true}).decode(raw).replaceAll('\r\n','\n'))),'SOURCE_CHANGED');
}
export async function previewClockRecoveryPlan(options:{manifestRaw:string;originalRequestRaw?:string;savedIntent?:ClockJournalIntent;now:()=>number}){
  try{
    const raw=options.manifestRaw,requestRaw=options.originalRequestRaw,intent=structuredClone(options.savedIntent),now=options.now();
    requireCondition(stamp(now),'TIME_REJECTED');const m=manifest(raw,now);
    await original(m,requestRaw,intent);
    return Object.freeze({status:'preview' as const,stage:m.clock.scope.stage,sourceSha:m.sourceSha,operationId:m.operationId,
      manifestSha256:digest(raw),maximumReadRequests:m.original?16:15,remoteWritesAllowed:0,providerAdvancesAllowed:0,
      sourceShaVerified:false,authorizationReceiptBound:false,retryAllowed:false,physicalExecutionAllowed:false});
  }catch{throw Error('CLOCK_RECOVERY_AUTHORITY_PREVIEW_REJECTED');}
}
export async function verifyClockRecoveryAuthority(options:{
  manifestRaw:string;authorizationRaw:string;sourceRoot:string;reviewRoot:string;manifestPath:string;now:()=>number;
  originalRequestRaw?:string;savedIntent?:ClockJournalIntent;
}):Promise<ClockRecoveryAuthority>{
  try{
    const raw=options.manifestRaw,authRaw=options.authorizationRaw,rawOriginal=options.originalRequestRaw,intent=structuredClone(options.savedIntent),
      sourceArgument=options.sourceRoot,reviewArgument=options.reviewRoot,manifestPath=options.manifestPath,now=options.now;
    requireCondition(typeof now==='function','TIME_REJECTED');const started=now();requireCondition(stamp(started),'TIME_REJECTED');
    const m=manifest(raw,started),receipt=parse(authRaw);keys(receipt,['source','callId','consumed','answer','manifestSha256','approvedRootCommit','issuedAt','expiresAt']);
    const hash=digest(raw);
    requireCondition(receipt.source==='direct_human_async_reply'&&typeof receipt.callId==='string'&&/^call_[A-Za-z0-9_]+$/.test(receipt.callId)
      &&receipt.consumed===false&&receipt.answer==='Autorizar recuperación '+m.clock.scope.stage.toUpperCase()+' solo lectura '+m.operationId
      &&receipt.manifestSha256===hash&&typeof receipt.approvedRootCommit==='string'&&SOURCE.test(receipt.approvedRootCommit),'RECEIPT_REJECTED');
    requireCondition(stamp(receipt.issuedAt)&&stamp(receipt.expiresAt)&&receipt.issuedAt<=started&&receipt.expiresAt>started
      &&receipt.expiresAt-receipt.issuedAt<=TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'WINDOW_REJECTED');
    const capturedOriginal=await original(m,rawOriginal,intent),root=realpathSync(resolve(sourceArgument)),reviewRoot=realpathSync(resolve(reviewArgument));
    const selfFile=fileURLToPath(import.meta.url),selfPath=inside(root,realpathSync(selfFile));
    requireCondition(git(root,['rev-parse','HEAD'])===m.sourceSha&&git(root,['remote','get-url','origin'])==='https://github.com/Toydrum/roadmap2u-backend.git'
      &&git(root,['status','--porcelain','--untracked-files=normal'])==='','SOURCE_CHANGED');committed(root,selfFile,selfPath);
    requireCondition(typeof manifestPath==='string'&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(manifestPath)
      &&!manifestPath.split('/').some(p=>p==='.'||p==='..'||p==='.git'),'PATH_REJECTED');
    const file=resolve(reviewRoot,manifestPath);inside(reviewRoot,realpathSync(file));
    requireCondition(digest(regular(file))===hash,'REVIEW_CHANGED');
    git(reviewRoot,['merge-base','--is-ancestor',receipt.approvedRootCommit,'HEAD']);
    requireCondition(digest(git(reviewRoot,['show',receipt.approvedRootCommit+':'+manifestPath],true) as Buffer)===hash,'REVIEW_CHANGED');
    const finished=now();requireCondition(stamp(finished)&&finished>=started&&finished<receipt.expiresAt,'WINDOW_REJECTED');
    const authority:ClockRecoveryAuthority=Object.freeze({stage:m.clock.scope.stage,sourceSha:m.sourceSha,operationId:m.operationId,manifestSha256:hash,
      sourceShaVerified:true,authorizationReceiptBound:true,stackOwnershipVerified:false,maximumReadRequests:m.original?16:15,
      remoteWritesAllowed:0,providerAdvancesAllowed:0,retryAllowed:false,physicalExecutionAllowed:false,verifiedAt:finished,expiresAt:receipt.expiresAt});
    authorities.set(authority,{manifest:m,original:capturedOriginal,verifiedAt:finished,expiresAt:receipt.expiresAt,
      callIdSha256:digest(receipt.callId),attemptId:digest(JSON.stringify(['clock-recovery-attempt-v1',receipt.callId])),
      approvedRootCommit:receipt.approvedRootCommit,issuedAt:receipt.issuedAt,source:{root,reviewRoot,manifestPath,selfFile,selfPath}});
    return authority;
  }catch(error){throw Error(error instanceof Error&&/^CLOCK_RECOVERY_AUTHORITY_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_RECOVERY_AUTHORITY_VERIFICATION_REJECTED');}
}
function bound(value:ClockRecoveryAuthority,now:number){
  const b=value&&authorities.get(value);requireCondition(b&&stamp(now)&&now>=b.verifiedAt&&now<b.expiresAt,'BOUND_CONTEXT_REQUIRED');return b;
}
export function readClockRecoveryAuthority(value:ClockRecoveryAuthority,now:number){return structuredClone(bound(value,now).manifest);}
export function readClockRecoveryOriginal(value:ClockRecoveryAuthority,now:number){return structuredClone(bound(value,now).original);}
export function assertClockRecoverySource(value:ClockRecoveryAuthority,now:number,sidecar?:{file:string;sha256:string}){
  try{
    const b=bound(value,now),s=b.source;
    requireCondition(git(s.root,['rev-parse','HEAD'])===value.sourceSha&&git(s.root,['remote','get-url','origin'])==='https://github.com/Toydrum/roadmap2u-backend.git'
      &&git(s.root,['status','--porcelain','--untracked-files=normal'])==='','SOURCE_CHANGED');committed(s.root,s.selfFile,s.selfPath);
    if(sidecar){requireCondition(HEX.test(sidecar.sha256)&&digest(regular(sidecar.file))===sidecar.sha256,'SOURCE_CHANGED');
      committed(s.root,realpathSync(sidecar.file),inside(s.root,realpathSync(sidecar.file)));}
    requireCondition(digest(regular(resolve(s.reviewRoot,s.manifestPath)))===value.manifestSha256,'SOURCE_CHANGED');
    git(s.reviewRoot,['merge-base','--is-ancestor',b.approvedRootCommit,'HEAD']);
    requireCondition(digest(git(s.reviewRoot,['show',b.approvedRootCommit+':'+s.manifestPath],true) as Buffer)===value.manifestSha256,'SOURCE_CHANGED');
  }catch{throw Error('CLOCK_RECOVERY_AUTHORITY_SOURCE_CHANGED');}
}

export interface DurableClockRecoveryAttempt {
  readonly sourceSha:string;readonly manifestSha256:string;readonly operationId:string;readonly reservedAt:number;readonly physicalExecutionAllowed:false;
}
const recoveryAttempts=new WeakMap<object,{authority:ClockRecoveryAuthority;store:DurableClockJournal;prior:DurableClockJournal|null;record:Record<string,unknown>}>(),
  claimedReplies=new Set<string>();
function checkedStores(authority:ClockRecoveryAuthority,store:DurableClockJournal,prior:DurableClockJournal|null,now:number){
  const context=bound(authority,now),m=context.manifest;assertDurableClockJournal(store);
  requireCondition(isDeepStrictEqual(store,m.attemptJournal),'JOURNAL_BINDING_REJECTED');
  const program=readDurableClockJournalProgram(store);
  requireCondition(program.powershellExecutable===m.runtime.powershellExecutable&&program.powershellSha256===m.runtime.powershellSha256,'RUNTIME_REJECTED');
  assertClockRecoverySource(authority,now,{file:program.helperPath,sha256:program.helperSha256});
  if(m.priorJournal===null)requireCondition(prior===null,'JOURNAL_BINDING_REJECTED');
  else{
    assertDurableClockJournal(prior);requireCondition(isDeepStrictEqual(prior,m.priorJournal)&&prior.directoryId!==store.directoryId,'JOURNAL_BINDING_REJECTED');
    const priorProgram=readDurableClockJournalProgram(prior);
    requireCondition(isDeepStrictEqual(priorProgram,program),'RUNTIME_REJECTED');
    if(m.original){
      const saved=readDurableClockJournalFile(prior,m.original.reservationId+'.intent.json');
      requireCondition(context.original&&isDeepStrictEqual(saved,context.original.savedIntent)
        &&digest(JSON.stringify(saved))===m.original.intentSha256,'ORIGINAL_CHANGED');
    }
  }
  return context;
}
/** One local exclusive record for the new read-only reply. Prior records are read only. */
export function reserveDurableClockRecoveryAttempt(authority:ClockRecoveryAuthority,store:DurableClockJournal,prior:DurableClockJournal|null,now:number):DurableClockRecoveryAttempt{
  try{
    const context=checkedStores(authority,store,prior,now);
    requireCondition(!claimedReplies.has(context.callIdSha256),'ALREADY_CONSUMED');claimedReplies.add(context.callIdSha256);
    const saved={schemaVersion:1,reservationId:context.attemptId,kind:'clock_recovery_read_only',status:'reserved',
      sourceSha:authority.sourceSha,manifestSha256:authority.manifestSha256,operationId:authority.operationId,stage:authority.stage,
      callIdSha256:context.callIdSha256,approvedRootCommit:context.approvedRootCommit,issuedAt:context.issuedAt,
      expiresAt:context.expiresAt,reservedAt:now,directoryId:store.directoryId,aclSha256:store.aclSha256,
      priorJournalDirectoryId:prior?.directoryId??null,originalRequestSha256:context.manifest.original?.requestSha256??null,
      maximumReadRequests:authority.maximumReadRequests,remoteWritesAllowed:0,providerAdvancesAllowed:0,retryAllowed:false,physicalExecutionAllowed:false};
    writeDurableClockJournalFile(store,context.attemptId+'.recovery-attempt.json',saved);
    const attempt:DurableClockRecoveryAttempt=Object.freeze({sourceSha:authority.sourceSha,manifestSha256:authority.manifestSha256,
      operationId:authority.operationId,reservedAt:now,physicalExecutionAllowed:false});
    recoveryAttempts.set(attempt,{authority,store,prior,record:saved});return attempt;
  }catch(error){
    const code=error instanceof Error?error.message:'';
    throw Error(code==='CLOCK_JOURNAL_STORE_ALREADY_RESERVED'?'CLOCK_RECOVERY_AUTHORITY_ALREADY_RESERVED'
      :code==='CLOCK_RECOVERY_AUTHORITY_ORIGINAL_CHANGED'?code:'CLOCK_RECOVERY_AUTHORITY_ATTEMPT_REJECTED');
  }
}
export function assertDurableClockRecoveryAttempt(attempt:DurableClockRecoveryAttempt,authority:ClockRecoveryAuthority,store:DurableClockJournal,prior:DurableClockJournal|null,now:number):void{
  try{
    const actual=attempt&&recoveryAttempts.get(attempt);
    requireCondition(actual&&actual.authority===authority&&actual.store===store&&actual.prior===prior&&stamp(now)&&now>=attempt.reservedAt,'ATTEMPT_REQUIRED');
    const context=checkedStores(authority,store,prior,now);
    requireCondition(isDeepStrictEqual(readDurableClockJournalFile(store,context.attemptId+'.recovery-attempt.json'),actual.record),'ATTEMPT_CHANGED');
  }catch{throw Error('CLOCK_RECOVERY_AUTHORITY_ATTEMPT_REJECTED');}
}
