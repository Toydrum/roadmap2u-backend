import { createHash } from 'node:crypto';
import { lstatSync,readFileSync,realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AwsCredentialIdentity } from '@smithy/types';
import type Stripe from 'stripe';
import { readClockRecoveryAuthority,readClockRecoveryOriginal,assertClockRecoverySource,reserveDurableClockRecoveryAttempt,
  assertDurableClockRecoveryAttempt,type ClockRecoveryAuthority,type DurableClockRecoveryAttempt } from './stripe-test-clock-recovery-authority';
import { assertDurableClockJournal,readDurableClockJournalProgram,type DurableClockJournal } from './stripe-test-clock-durable-store';
import { prepareClockRecoveryOwnershipObserver,type ClockOwnershipCli } from './stripe-test-clock-ownership';
import { prepareClockAwsObserver } from './stripe-test-clock-aws-observation';
import { prepareClockStripeRecoveryObserver } from './stripe-test-clock-stripe-observation';
import { prepareClockRecoveryReadback } from './stripe-test-clock-recovery-readback';
import type { ClockDynamoHandler } from './stripe-test-clock-dynamo-transport';

export interface ClockRecoveryCallerOptions {
  authority:ClockRecoveryAuthority;journalDirectory:DurableClockJournal;priorJournalDirectory:DurableClockJournal|null;
  credentials:AwsCredentialIdentity;cliConfigPath:string;cliCredentialsPath:string;caBundlePath:string;caBundleSha256:string;
  ownershipCli:ClockOwnershipCli;awsHandler:ClockDynamoHandler;stripeClient:Stripe.HttpClient;apiKey:string;now:()=>number;requestTimeoutMs?:number;
}
function requireCondition(ok:unknown,code:string):asserts ok{if(!ok)throw Error('CLOCK_RECOVERY_CALLER_'+code);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function stamp(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function number(value:unknown):number|null{return stamp(value)?value:null;}
export async function prepareClockRecoveryCaller(options:ClockRecoveryCallerOptions){
  try{
    const authority=options.authority,journal=options.journalDirectory,prior=options.priorJournalDirectory,now=options.now;
    requireCondition(typeof now==='function','CLOCK_REQUIRED');assertDurableClockJournal(journal);
    if(prior!==null)assertDurableClockJournal(prior);
    const initial=now(),manifest=readClockRecoveryAuthority(authority,initial),original=readClockRecoveryOriginal(authority,initial);
    const supplied=options.credentials;
    requireCondition(supplied&&/^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId)&&typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0
      &&typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0&&supplied.expiration instanceof Date
      &&supplied.expiration.getTime()>initial+120000,'CREDENTIALS_REQUIRED');
    const credentials={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration)};
    const aws=options.awsHandler,stripe=options.stripeClient,cli=options.ownershipCli,key=options.apiKey,timeout=options.requestTimeoutMs??10000;
    requireCondition(aws&&typeof aws.handle==='function'&&stripe&&typeof stripe.makeRequest==='function'&&typeof cli==='function','TRANSPORT_REQUIRED');
    requireCondition(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=10000,'TIMEOUT_REJECTED');
    const awsHandle=aws.handle.bind(aws),destroy=aws.destroy?.bind(aws),stripeHandle=stripe.makeRequest.bind(stripe);
    const files={cliConfigPath:options.cliConfigPath,cliCredentialsPath:options.cliCredentialsPath,caBundlePath:options.caBundlePath,caBundleSha256:options.caBundleSha256};
    requireCondition(files.caBundleSha256===manifest.runtime.caBundleSha256,'CERTIFICATE_CHANGED');
    const ca=realpathSync(files.caBundlePath),program=readDurableClockJournalProgram(journal),
      self=fileURLToPath(import.meta.url),selfHash=createHash('sha256').update(readFileSync(self)).digest('hex');
    requireCondition(program.powershellExecutable===manifest.runtime.powershellExecutable&&program.powershellSha256===manifest.runtime.powershellSha256,'RUNTIME_REJECTED');
    const helper={file:program.helperPath,sha256:program.helperSha256};
    function certificate(){
      const st=lstatSync(ca);requireCondition(st.isFile()&&!st.isSymbolicLink()&&st.size<=256*1024
        &&createHash('sha256').update(readFileSync(ca)).digest('hex')===files.caBundleSha256,'CERTIFICATE_CHANGED');
    }
    certificate();assertClockRecoverySource(authority,initial,{file:self,sha256:selfHash});assertClockRecoverySource(authority,initial,helper);
    const order=[...['identity','stack','app','privacy','pool','stack_after'].map(k=>'ownership:'+k),
      ...['identity','app_table','privacy_table','fixture_identity','snapshot','financial_partition'].map(k=>'aws:'+k),
      ...['account','customer','clock'].map(k=>'stripe:'+k),...(original?['original:readback']:[])];
    requireCondition(order.length===authority.maximumReadRequests,'BUDGET_REJECTED');
    const reserved=Object.fromEntries(order.map(k=>[k,0])),delegated={...reserved};
    let active:string|undefined,reservedAt=0,index=0,consumed=false,previous=initial,attempt:DurableClockRecoveryAttempt|undefined;
    function fresh(){
      const t=now();requireCondition(stamp(t)&&t>=previous&&credentials.expiration.getTime()>t+30000,'CONTEXT_EXPIRED');
      readClockRecoveryAuthority(authority,t);assertClockRecoverySource(authority,t,helper);
      if(attempt)assertDurableClockRecoveryAttempt(attempt,authority,journal,prior,t);
      certificate();const completed=now();readClockRecoveryAuthority(authority,completed);
      requireCondition(stamp(completed)&&completed>=t&&credentials.expiration.getTime()>completed+30000,'CONTEXT_EXPIRED');
      previous=completed;return completed;
    }
    function reserve(name:string){
      reservedAt=fresh();requireCondition(attempt&&order[index]===name&&reserved[name]===0&&active===undefined,'REQUEST_BOUND');
      reserved[name]++;active=name;
    }
    function delegate(prefix:string){
      const t=fresh(),name=active;
      requireCondition(name&&name.startsWith(prefix)&&order[index]===name&&reserved[name]===1&&delegated[name]===0&&t-reservedAt<timeout,'DELEGATION_REJECTED');
      delegated[name]++;active=undefined;index++;
    }
    const handler:ClockDynamoHandler={destroy:()=>{},handle:async(wire,context)=>{
      const target=wire.headers['x-amz-target'];
      requireCondition(wire.protocol==='https:'&&wire.method==='POST'&&wire.path==='/'&&
        (target===undefined&&wire.hostname==='sts.us-east-1.amazonaws.com'||
         ['DynamoDB_20120810.DescribeTable','DynamoDB_20120810.Query','DynamoDB_20120810.TransactGetItems','AWSCognitoIdentityProviderService.AdminGetUser'].includes(target)),'READ_ONLY_REJECTED');
      delegate(active==='original:readback'?'original:':'aws:');return awsHandle(wire,context);
    }};
    const http:Stripe.HttpClient={getClientName:()=> 'clock-recovery-read-only',makeRequest:async(...args)=>{
      requireCondition(args[3]==='GET'&&args[5]==='','READ_ONLY_REJECTED');delegate('stripe:');return stripeHandle(...args);
    }};
    const observedAws=await prepareClockAwsObserver({kind:'recovery',clock:manifest.clock,storage:manifest.storage,
      expectedCallerArn:manifest.expectedCallerArn,userPoolId:manifest.cloudformation.resources.find(r=>r.kind==='pool')!.physicalId,
      credentials,requestHandler:handler,now,reserveWire:k=>reserve('aws:'+k),requestTimeoutMs:timeout});
    const observedProvider=prepareClockStripeRecoveryObserver({scope:manifest.clock.scope,ownerSub:manifest.clock.ownerSub,apiKey:key,httpClient:http,
      now,reserveWire:k=>reserve('stripe:'+k),requestTimeoutMs:timeout});
    const readback=original?await prepareClockRecoveryReadback({originalRequestRaw:original.requestRaw,requestSha256:manifest.original!.requestSha256,
      sourceSha:manifest.original!.sourceSha,savedIntent:original.savedIntent,credentials,requestHandler:handler,now,reserveWire:k=>reserve('original:'+k),requestTimeoutMs:timeout}):null;
    const counts=()=>({reservations:Object.values(reserved).reduce((a,b)=>a+b,0),delegations:Object.values(delegated).reduce((a,b)=>a+b,0),
      reservedByKind:{...reserved},delegatedByKind:{...delegated}});
    return{
      preview:Object.freeze({stage:authority.stage,sourceSha:authority.sourceSha,operationId:authority.operationId,maximumReadRequests:order.length,
        remoteWritesAllowed:0,providerAdvancesAllowed:0,physicalExecutionAllowed:false}),counts,
      async execute(){
        requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;
        let status:'observed'|'stopped'|'uncertain'='stopped',step='preflight',code:string|null=null,observations:Record<string,unknown>|null=null,
          originalReadback:{status:string;reason?:string}={status:'not_requested'};
        try{
          fresh();attempt=reserveDurableClockRecoveryAttempt(authority,journal,prior,now());fresh();step='ownership';
          const ownership=prepareClockRecoveryOwnershipObserver({authority,attempt,journalDirectory:journal,priorJournalDirectory:prior,
            credentials,...files,now,reserveWire:k=>reserve('ownership:'+k),runCli:async(args,context)=>{
              requireCondition(args[0]==='sts'&&args[1]==='get-caller-identity'||args[0]==='cloudformation'&&['describe-stacks','describe-stack-resource'].includes(args[1]),'READ_ONLY_REJECTED');
              delegate('ownership:');return cli(args,context);
            },requestTimeoutMs:timeout});
          await ownership.observe();fresh();step='aws';const awsFacts=await observedAws.observe();fresh();
          requireCondition(awsFacts.kind==='recovery','OBSERVATION_REJECTED');step='stripe';
          const provider=await observedProvider.observe();fresh();
          const snapshot=awsFacts.snapshot,financial=record(snapshot.financialState)?snapshot.financialState:null,
            mirror=record(snapshot.mirror)?snapshot.mirror:null,flags=record(snapshot.flags)?snapshot.flags:null;
          observations={aws:{financialStatePresent:!!financial,financialRevision:number(financial?.revision),
            financialRows:snapshot.financialRows.length,mirrorRevision:number(mirror?.clockRevision),
            profileAdult:record(snapshot.profile)&&snapshot.profile.accountType==='adult',
            closurePresent:!!snapshot.closure,restoreExclusionPresent:!!snapshot.restoreExclusion,
            purchasesClosed:!!flags&&flags.premiumPaymentsEnabled===false&&flags.individualCheckoutEnabled===false&&flags.paymentScope==='none'},
            clock:{status:provider.status==='clock_not_found'?'not_found':provider.observation.clock!.status,
              expired:provider.observation.clockExpired,frozenAt:provider.observation.clock?provider.observation.clock.frozen_time*1000:null}};
          if(readback){step='original';const proof=await readback.observe();fresh();originalReadback={status:proof.status,reason:proof.reason};}
          requireCondition(index===order.length&&active===undefined,'INCOMPLETE_READS');
          status=originalReadback.status==='uncertain'?'uncertain':'observed';step='complete';
        }catch(error){
          status='stopped';code=error instanceof Error&&/^CLOCK_RECOVERY_(?:CALLER|AUTHORITY)_[A-Z_]+$/.test(error.message)
            ?error.message:'CLOCK_RECOVERY_CALLER_'+step.toUpperCase()+'_FAILED';
        }finally{
          try{destroy?.();}catch{status='uncertain';step='cleanup';code='CLOCK_RECOVERY_CALLER_CLEANUP_FAILED';}
        }
        return{status,step,code,stage:authority.stage,sourceSha:authority.sourceSha,operationId:authority.operationId,
          observations,originalReadback,counts:counts(),attemptReserved:!!attempt,remoteWrites:0,providerAdvances:0,
          providerReadyEvidenceProduced:false,clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false};
      },
    };
  }catch(error){
    throw Error(error instanceof Error&&/^CLOCK_(?:RECOVERY|OWNERSHIP|AWS_OBSERVATION|STRIPE|JOURNAL_STORE)_[A-Z_]+$/.test(error.message)
      ?error.message:'CLOCK_RECOVERY_CALLER_PREPARATION_FAILED');
  }
}
