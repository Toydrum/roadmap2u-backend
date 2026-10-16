import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { AwsCredentialIdentity } from '@smithy/types';
import type Stripe from 'stripe';
import { readClockCallerAuthority, readClockCallerPlan, readClockCallerRequest, assertClockCallerSource,
  reserveDurableClockCallerAttempt, assertDurableClockCallerAttempt, type ClockCallerAuthority, type DurableClockCallerAttempt } from './stripe-test-clock-authority';
import { assertDurableClockJournal, readDurableClockJournalProgram, type DurableClockJournal } from './stripe-test-clock-durable-store';
import { nativeClockOwnershipCli, prepareDurableClockOwnershipObserver, type ClockOwnershipCli } from './stripe-test-clock-ownership';
import { prepareClockAwsObserver } from './stripe-test-clock-aws-observation';
import { prepareClockStripeObserver } from './stripe-test-clock-stripe-observation';
import { prepareClockDynamoExecutor, type ClockDynamoHandler } from './stripe-test-clock-dynamo-transport';
import { prepareClockStripeAdvance } from './stripe-test-clock-stripe-advance';
import type { ClockTransitionRequest } from './stripe-test-clock-transition';

export interface ClockCallerOptions {
  authority: ClockCallerAuthority; journalDirectory: DurableClockJournal; credentials: AwsCredentialIdentity;
  cliConfigPath: string; cliCredentialsPath: string; caBundlePath: string; caBundleSha256: string;
  awsHandler: ClockDynamoHandler; stripeClient: Stripe.HttpClient; apiKey: string; now: () => number;
  ownershipCli?: ClockOwnershipCli; requestTimeoutMs?: number;
}
type Status = 'stopped' | 'uncertain' | 'verified_applied' | 'advance_acknowledged';
type Step = 'preflight' | 'ownership' | 'aws' | 'stripe' | 'dynamo' | 'advance' | 'complete';
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw Error('CLOCK_CALLER_' + reason); }
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function comparable(value: unknown, transition: boolean) {
  requireCondition(record(value), 'OBSERVATION_REJECTED'); const copy = structuredClone(value);
  delete copy.startedAt; delete copy.completedAt;
  // TransitionSnapshot intentionally excludes subscriptionSource. No transaction
  // value or safety input is dropped; the real business preparer remains canonical.
  if (transition) delete copy.subscriptionSource;
  return copy;
}
/** Compose the real components. This has no credential/key discovery, retry,
 * resource creation or inference of approval from an automatic continuation. */
export async function prepareClockCaller(options: ClockCallerOptions) {
  try {
    const authority = options.authority, journal = options.journalDirectory, now = options.now;
    requireCondition(typeof now === 'function', 'CLOCK_REQUIRED'); assertDurableClockJournal(journal);
    const initial = now(), manifest = readClockCallerAuthority(authority, initial), program = readDurableClockJournalProgram(journal);
    requireCondition(manifest.journal && isDeepStrictEqual(manifest.journal, {directory:journal.directory,directoryId:journal.directoryId,aclSha256:journal.aclSha256}), 'JOURNAL_BINDING_REJECTED');
    requireCondition(manifest.runtime && manifest.runtime.powershellExecutable === program.powershellExecutable &&
      manifest.runtime.powershellSha256 === program.powershellSha256 && manifest.runtime.caBundleSha256 === options.caBundleSha256, 'RUNTIME_BINDING_REJECTED');
    const sidecar = {file:program.helperPath,sha256:program.helperSha256}; assertClockCallerSource(authority, initial, sidecar);
    const request = readClockCallerRequest(authority, initial), plan = readClockCallerPlan(authority, initial), transition = manifest.phase !== 'install';
    const supplied = options.credentials;
    requireCondition(supplied && typeof supplied.accessKeyId === 'string' && /^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId) &&
      typeof supplied.secretAccessKey === 'string' && supplied.secretAccessKey.length > 0 && typeof supplied.sessionToken === 'string' && supplied.sessionToken.length > 0 &&
      supplied.expiration instanceof Date && supplied.expiration.getTime() > initial + 120000, 'CREDENTIAL_SNAPSHOT_REQUIRED');
    const credentials = {accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration.getTime())};
    const aws = options.awsHandler, stripe = options.stripeClient, cli = options.ownershipCli ?? nativeClockOwnershipCli;
    requireCondition(aws && typeof aws.handle === 'function' && stripe && typeof stripe.makeRequest === 'function' && typeof cli === 'function', 'TRANSPORT_REQUIRED');
    const awsHandle = aws.handle.bind(aws), awsDestroy = aws.destroy?.bind(aws), stripeHandle = stripe.makeRequest.bind(stripe), key = options.apiKey;
    const timeout = options.requestTimeoutMs ?? 10000;
    requireCondition(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 10000, 'TIMEOUT_REJECTED');
    const privateFiles = {cliConfigPath:options.cliConfigPath,cliCredentialsPath:options.cliCredentialsPath,caBundlePath:options.caBundlePath,caBundleSha256:options.caBundleSha256};
    const caFile=realpathSync(privateFiles.caBundlePath),caHash=privateFiles.caBundleSha256;
    function certificate() {
      const info=lstatSync(caFile);
      requireCondition(info.isFile()&&!info.isSymbolicLink()&&info.size<=256*1024&&
        createHash('sha256').update(readFileSync(caFile)).digest('hex')===caHash,'CERTIFICATE_CHANGED');
    }
    certificate();
    const kinds = [ ...['identity','stack','app','privacy','pool','stack_after'].map(x=>'ownership:'+x),
      ...['identity','app_table','privacy_table','fixture_identity','snapshot',...(transition?[]:['financial_partition'])].map(x=>'aws:'+x),
      ...['account','customer','clock'].map(x=>'stripe:'+x), 'dynamo:write','dynamo:readback',
      ...(manifest.phase==='advance_fence'?['account','customer','clock','advance'].map(x=>'advance:'+x):[]) ];
    const reservations = Object.fromEntries(kinds.map(x=>[x,0])), delegations = {...reservations};
    let previous = initial, attempt: DurableClockCallerAttempt | undefined, consumed = false, activeWire: string | undefined, reservedAt = initial;
    function fresh() {
      const t = now(); readClockCallerAuthority(authority,t);
      requireCondition(Number.isSafeInteger(t) && t >= previous && credentials.expiration.getTime() > t + 30000, 'CONTEXT_EXPIRED'); previous=t;
      assertClockCallerSource(authority,t,sidecar);
      if (attempt) assertDurableClockCallerAttempt(attempt,authority,journal,t);
      certificate();
      const done=now(); readClockCallerAuthority(authority,done);
      requireCondition(Number.isSafeInteger(done) && done>=previous && credentials.expiration.getTime()>done+30000, 'CONTEXT_EXPIRED'); previous=done;
      return done;
    }
    function reserve(name:string) {
      reservedAt=now(); fresh(); requireCondition(attempt && Object.hasOwn(reservations,name) && reservations[name]===0, 'REQUEST_BOUND');
      reservations[name]++; activeWire=name;
    }
    function delegate(prefix:string) {
      const done=fresh(), name=activeWire;
      requireCondition(name && name.startsWith(prefix) && reservations[name]===1 && delegations[name]===0 && done-reservedAt<timeout, 'DELEGATION_REJECTED');
      delegations[name]++; activeWire=undefined;
    }
    // Component clients may destroy their wrappers; the actual shared transport
    // stays owned by this one engine until its complete attempt has ended.
    const handler:ClockDynamoHandler={handle:async(wire,context)=>{delegate(wire.headers['x-amz-target']==='DynamoDB_20120810.TransactWriteItems'||wire.headers['x-amz-target']==='DynamoDB_20120810.TransactGetItems'&&activeWire==='dynamo:readback'?'dynamo:':'aws:');return awsHandle(wire,context);},destroy:()=>{}};
    const stripeBefore:Stripe.HttpClient={getClientName:()=> 'clock-caller-preflight',makeRequest:async(...args)=>{delegate('stripe:');return stripeHandle(...args);}};
    const stripeAdvance:Stripe.HttpClient={getClientName:()=> 'clock-caller-advance',makeRequest:async(...args)=>{delegate('advance:');return stripeHandle(...args);}};
    const awsObserver=await prepareClockAwsObserver({kind:transition?'transition':'install',clock:manifest.clock,storage:manifest.storage,
      expectedCallerArn:manifest.expectedCallerArn,userPoolId:manifest.cloudformation.resources.find(x=>x.kind==='pool')!.physicalId,
      credentials,requestHandler:handler,now,reserveWire:x=>reserve('aws:'+x),requestTimeoutMs:timeout});
    const provider=prepareClockStripeObserver({scope:manifest.clock.scope,ownerSub:manifest.clock.ownerSub,apiKey:key,httpClient:stripeBefore,
      now,reserveWire:x=>reserve('stripe:'+x),requestTimeoutMs:timeout});
    const executor=await prepareClockDynamoExecutor({request,sourceSha:manifest.sourceSha,journalDirectory:journal,credentials,requestHandler:handler,
      now,reserveWire:x=>reserve('dynamo:'+x),requestTimeoutMs:timeout});
    requireCondition(executor.preview.intent.transactionSha256===authority.transactionSha256&&executor.preview.intent.readbackSha256===authority.readbackSha256,'PLAN_BINDING_REJECTED');
    const advance=manifest.phase==='advance_fence'?await prepareClockStripeAdvance({fence:request as ClockTransitionRequest,sourceSha:manifest.sourceSha,
      journalDirectory:journal,apiKey:key,httpClient:stripeAdvance,now,reserveWire:x=>reserve('advance:'+x),requestTimeoutMs:timeout}):null;
    return {
      preview:Object.freeze({stage:authority.stage,sourceSha:authority.sourceSha,operationId:authority.operationId,phase:authority.phase,
        transactionSha256:authority.transactionSha256,readbackSha256:authority.readbackSha256,maximumRequests:kinds.length,
        maximumWrites:1,maximumProviderAdvances:advance?1:0,physicalExecutionAllowed:false}),
      counts:()=>({reservations:{...reservations},delegations:{...delegations}}),
      async execute() {
        requireCondition(!consumed,'ALREADY_CONSUMED'); consumed=true;
        let status:Status='stopped', step:Step='preflight', clockReadable=false, failureCode:string|null=null;
        try {
          fresh(); attempt=reserveDurableClockCallerAttempt(authority,journal,now()); fresh(); step='ownership';
          const ownership=prepareDurableClockOwnershipObserver({authority,journalDirectory:journal,attempt,credentials,...privateFiles,now,
            reserveWire:x=>reserve('ownership:'+x),runCli:async(args,context)=>{delegate('ownership:');return cli(args,context);},requestTimeoutMs:timeout});
          await ownership.observe(); fresh(); step='aws';
          const observed=await awsObserver.observe(); fresh();
          requireCondition(isDeepStrictEqual(comparable(observed.snapshot,transition),comparable(request.snapshot,transition)),'SNAPSHOT_CHANGED');
          step='stripe'; const ready=await provider.observe(); fresh();
          requireCondition(isDeepStrictEqual(comparable(ready.observation,false),comparable(request.clock.observation,false)),'PROVIDER_CHANGED');
          step='dynamo'; const applied=await executor.execute(); fresh();
          if(applied.status!=='verified_applied'){status='uncertain';failureCode='CLOCK_CALLER_EXECUTION_UNCERTAIN';}
          else if(advance){step='advance';const advanced=await advance.execute();fresh();status=advanced.status;
            if(status==='uncertain')failureCode='CLOCK_CALLER_ADVANCE_UNCERTAIN';}
          else {status='verified_applied';clockReadable=applied.clockReadable;}
          if(failureCode===null)step='complete';
        } catch(error) {
          status=delegations['dynamo:write']>0||delegations['advance:advance']>0?'uncertain':'stopped';
          failureCode=error instanceof Error&&/^CLOCK_CALLER_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_CALLER_'+step.toUpperCase()+'_FAILED';
        } finally {
          try{awsDestroy?.();}catch{status='uncertain';clockReadable=false;failureCode='CLOCK_CALLER_CLEANUP_FAILED';}
        }
        return {status,phase:authority.phase,stage:authority.stage,sourceSha:authority.sourceSha,operationId:authority.operationId,
          transactionSha256:authority.transactionSha256,readbackSha256:authority.readbackSha256,clockReadable,
          stoppedAt:step,failureCode,lastVerifiedAt:previous,attemptReserved:!!attempt,retryAllowed:false,readyEvidencePublished:status==='verified_applied'&&clockReadable,
          physicalExecutionAllowed:false,reservations:{...reservations},delegations:{...delegations}};
      },
    };
  } catch(error) {
    throw Error(error instanceof Error && /^CLOCK_(?:CALLER|AUTHORITY|JOURNAL_STORE|DYNAMO|AWS_OBSERVATION|STRIPE)_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_CALLER_PREPARATION_FAILED');
  }
}
