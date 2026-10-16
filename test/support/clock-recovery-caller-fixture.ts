import { marshall } from '@aws-sdk/util-dynamodb';
import { AUTH_NOW,ownershipFixture } from './clock-authority-fixture';
import { recoveryAuthorityFixture } from './clock-recovery-authority-fixture';
import { prepareClockJournal } from '../../scripts/stripe-test-clock-journal';
import { STRIPE_API_VERSION } from '../../lambda/billing/model';
export type RecoveryCaller=Awaited<ReturnType<typeof import('../../scripts/stripe-test-clock-recovery-caller').prepareClockRecoveryCaller>>;

export async function recoveryCallerFixture(stage='dev',original=false){
  const f=await recoveryAuthorityFixture(stage,original,true),ownership=ownershipFixture(f);
  const authority=await f.api.verifyClockRecoveryAuthority(f.recoveryOptions()),scope=f.manifest.clock.scope,owner=f.manifest.clock.ownerSub;
  const plan=original?await prepareClockJournal(f.request,f.savedIntent!.sourceSha):null;
  const state:any={pk:'BILLING#'+owner,sk:'STATE',revision:8,state:'payment_review',activeCommandId:'private-command'};
  const mirror:any={pk:'USER#'+owner,sk:'BILLING#TEST_CLOCK',clockRevision:3,frozenTimeSeconds:Math.floor(AUTH_NOW/1000),
    providerReadyEvidence:{status:'advancing'}};
  const snapshot:any[]=[f.request.snapshot.profile,f.request.snapshot.flags,mirror,null,null,null,null,state];
  const clock:any={...f.request.clock.observation.clock,status:'advancing'};
  let current=AUTH_NOW,destroyed=0,awsFault:((kind:string,value:any)=>any)|undefined,
    stripeFault:((kind:string,value:any)=>any)|undefined,failed='',cleanupError=false,clockMissing=false;
  const aws:string[]=[],stripe:string[]=[],events:string[]=[],wires:any[]=[];
  const awsHandler={destroy:()=>{destroyed++;if(cleanupError)throw Error('synthetic-private-cleanup');},handle:async(wire:any)=>{
    wires.push(wire);const target=wire.headers['x-amz-target'],identity=wire.hostname.startsWith('sts.');
    const body=identity?{}:JSON.parse(Buffer.from(wire.body).toString());
    const kind=identity?'identity':wire.hostname.startsWith('cognito-idp.')?'fixture_identity':
      target.endsWith('.DescribeTable')?body.TableName===scope.tableName?'app_table':'privacy_table':
      target.endsWith('.Query')?'financial_partition':target.endsWith('.TransactGetItems')?body.TransactItems.length===8?'snapshot':'readback':'unexpected_write';
    aws.push(kind);events.push('aws:'+kind);if(failed==='aws:'+kind)throw Object.assign(Error('rk_test_private_transport_failure'),{code:'ECONNRESET'});
    let value:any;
    if(kind==='identity'){
      value=awsFault?.(kind,{Account:'765932874577',Arn:f.manifest.expectedCallerArn,UserId:'AROA_SYNTHETIC:recovery'})??{Account:'765932874577',Arn:f.manifest.expectedCallerArn,UserId:'AROA_SYNTHETIC:recovery'};
      return{response:{statusCode:200,headers:{'content-type':'text/xml'},
        body:Buffer.from('<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>'+value.Account+'</Account><Arn>'+value.Arn+'</Arn><UserId>'+value.UserId+'</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></GetCallerIdentityResponse>')}};
    }
    if(kind==='app_table'||kind==='privacy_table')value={Table:{TableName:body.TableName,TableArn:'arn:aws:dynamodb:us-east-1:765932874577:table/'+body.TableName,
      TableStatus:'ACTIVE',KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}};
    else if(kind==='fixture_identity')value={Username:scope.fixtures[0].syntheticFixture,Enabled:false,UserAttributes:[{Name:'sub',Value:owner}]};
    else if(kind==='snapshot')value={Responses:snapshot.map(Item=>Item?{Item:marshall(Item)}:{})};
    else if(kind==='financial_partition')value={Items:[marshall({pk:'BILLING#'+owner,sk:'AUDIT#private-row',private:'private-financial-payload'})],Count:1,ScannedCount:1};
    else if(kind==='readback')value={Responses:plan!.expectedItems.map(Item=>({Item:marshall(Item)}))};
    else throw Error('UNEXPECTED_WRITE');
    value=awsFault?.(kind,value)??value;
    return{response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.0'},body:Buffer.from(JSON.stringify(value))}};
  }};
  const stripeClient={getClientName:()=> 'synthetic-recovery',makeRequest:async(_host:any,_port:any,path:string,method:string,_headers:any,data:string)=>{
    const kind=path==='/v1/account'?'account':path.includes('/customers/')?'customer':'clock';stripe.push(kind);events.push('stripe:'+kind);
    if(method!=='GET'||data!=='')throw Error('UNEXPECTED_PROVIDER_WRITE');
    if(failed==='stripe:'+kind)throw Object.assign(Error('rk_test_private_provider_failure'),{code:'ECONNRESET'});
    const missing=kind==='clock'&&clockMissing;
    let value:any=missing?{error:{type:'invalid_request_error',code:'resource_missing',message:'private missing clock'}}:
      kind==='account'?{id:scope.stripeAccountId,object:'account',country:'MX',private:'private-account'}:
      kind==='customer'?{...f.request.clock.observation.customer,email:'private@example.invalid'}:clock;
    value=stripeFault?.(kind,structuredClone(value))??value;
    return{getStatusCode:()=>missing?404:200,getHeaders:()=>({'request-id':'req_synthetic_recovery','stripe-version':STRIPE_API_VERSION}),
      getRawResponse:()=>({statusCode:missing?404:200}),toStream:()=>undefined,toJSON:async()=>structuredClone(value)};
  }};
  const cli=async(args:readonly string[],options:any)=>{
    const value=await ownership.runCli(args,options);events.push('ownership:'+ownership.calls.at(-1)!.kind);return value;
  };
  const options={authority,journalDirectory:f.journal,priorJournalDirectory:f.prior??null,credentials:f.credentials,...f.privateFiles,
    ownershipCli:cli,awsHandler,stripeClient,apiKey:'rk_test_clockRecoverySynthetic',now:()=>current,requestTimeoutMs:10000};
  return{...f,authority,options,ownership,aws,stripe,events,wires,snapshot,clock,destroyed:()=>destroyed,
    setClock:(value:number)=>{current=value;f.setNow(value);},fail:(value:string)=>{failed=value;},
    awsChange:(value:typeof awsFault)=>{awsFault=value;},stripeChange:(value:typeof stripeFault)=>{stripeFault=value;},
    failCleanup:()=>{cleanupError=true;},missingClock:()=>{clockMissing=true;}};
}
