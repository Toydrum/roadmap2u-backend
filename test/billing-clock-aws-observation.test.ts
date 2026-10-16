import { describe, expect, it, vi } from 'vitest';
import { STSClient } from '@aws-sdk/client-sts';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { HttpRequest } from '@smithy/types';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { restoreExclusionKey } from '../lambda/privacy/retention';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';
import { prepareClockTransitionTransaction } from '../scripts/stripe-test-clock-transition';
import { prepareClockAwsObserver, type ClockAwsReadKind } from '../scripts/stripe-test-clock-aws-observation';

const NOW=Date.UTC(2026,9,14,12),OWNER='owner_aws_observer',ACCOUNT='765932874577';
const ARN=`arn:aws:sts::${ACCOUNT}:assumed-role/roadmap-bootstrap-operator/clock-test`;
const PRIVATE='private-profile-only-in-memory',SECRET='synthetic-aws-secret-do-not-emit';
const kinds:ClockAwsReadKind[]=['identity','app_table','privacy_table','fixture_identity','snapshot','financial_partition'];
function input(stage='dev',kind:'install'|'transition'|'recovery'='install'){
  const tableName=`roadmap-${stage}`,privacyTableName=`roadmap-privacy-${stage}`;
  const fixture={ownerSub:OWNER,customerId:'cus_aws_observer',testClockId:'clock_aws_observer',bindingId:'aws_observer_binding',
    stage,stripeAccountId:'acct_sandbox',syntheticFixture:`stripe_clock_${stage}_aws_observer`};
  return {kind,clock:{ownerSub:OWNER,scope:{tableName,stage,stripeAccountId:'acct_sandbox',liveMode:false,fixtures:[fixture]}},
    storage:{stage,awsAccountId:ACCOUNT,region:'us-east-1',appTableArn:`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${tableName}`,
      privacyTableName,privacyTableArn:`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${privacyTableName}`},
    expectedCallerArn:ARN,userPoolId:'us-east-1_SYNTHETIC',
    credentials:{accessKeyId:'ASIA_SYNTHETIC',secretAccessKey:SECRET,sessionToken:'synthetic-session-token',expiration:new Date(NOW+3600000)}};
}
function rows(i= input()){
  const profile={pk:`USER#${OWNER}`,sk:'PROFILE',userId:OWNER,accountType:'adult',status:'active',privatePayload:PRIVATE};
  const flags={pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:61,quotaMode:'enforce',capabilityMode:'enforce',
    accessCodeIssuanceEnabled:false,accessCodeRedemptionEnabled:false,premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,
    schemaVersion:2,paymentScope:'none',individualCheckoutEnabled:false,updatedAt:NOW-1000,updatedBy:'synthetic',reason:'closed'};
  return [profile,flags,null,null,null,null,null,null] as (Record<string,unknown>|null)[];
}
function setup(i=input(),change?:(kind:ClockAwsReadKind,value:any)=>any){
  const remote=structuredClone(i);
  const seen:{kind:ClockAwsReadKind;body:any;credential:string}[]=[],reserved:ClockAwsReadKind[]=[];
  const state=rows(i);let destroyed=0,now=NOW;
  const json=(value:unknown,statusCode=200)=>({response:{statusCode,headers:{'content-type':'application/x-amz-json-1.0'},body:Buffer.from(JSON.stringify(value))}});
  const handler={destroy:()=>{destroyed++;},handle:async(request:HttpRequest)=>{
    const body=Buffer.from(request.body as string).toString('utf8');
    const operation=request.headers['x-amz-target'];
    const wireKind:ClockAwsReadKind=request.hostname.startsWith('sts.')?'identity':request.hostname.startsWith('cognito-idp.')?'fixture_identity':
      operation==='DynamoDB_20120810.DescribeTable'?(JSON.parse(body).TableName===remote.clock.scope.tableName?'app_table':'privacy_table'):
      operation==='DynamoDB_20120810.TransactGetItems'?'snapshot':'financial_partition';
    seen.push({kind:wireKind,body:wireKind==='identity'?body:JSON.parse(body),credential:request.headers.authorization??''});
    if(wireKind==='identity'){
      const value=change?.(wireKind,{Account:ACCOUNT,Arn:ARN,UserId:'AROA_SYNTHETIC:clock-test'})??{Account:ACCOUNT,Arn:ARN,UserId:'AROA_SYNTHETIC:clock-test'};
      return {response:{statusCode:200,headers:{'content-type':'text/xml'},body:Buffer.from(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${value.Account}</Account><Arn>${value.Arn}</Arn><UserId>${value.UserId}</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></GetCallerIdentityResponse>`)}};
    }
    let value:any;
    if(wireKind==='app_table'||wireKind==='privacy_table'){
      const name=wireKind==='app_table'?remote.clock.scope.tableName:remote.storage.privacyTableName;
      value={Table:{TableName:name,TableArn:`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${name}`,TableStatus:'ACTIVE',
        KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}};
    }else if(wireKind==='fixture_identity')value={Username:remote.clock.scope.fixtures[0]!.syntheticFixture,Enabled:false,UserStatus:'CONFIRMED',UserAttributes:[{Name:'sub',Value:OWNER}]};
    else if(wireKind==='snapshot')value={Responses:state.map(row=>row?{Item:marshall(row)}:{})};
    else value={Items:[],Count:0,ScannedCount:0};
    return json(change?.(wireKind,value)??value);
  }};
  return {i,state,seen,reserved,handler,now:()=>now,setNow:(n:number)=>{now=n;},destroyed:()=>destroyed,
    options:{...i,requestHandler:handler,now:()=>now,reserveWire:(kind:ClockAwsReadKind)=>{reserved.push(kind);}}};
}
function request(i:ReturnType<typeof input>,snapshot:any):ClockInstallRequest{
  const f=i.clock.scope.fixtures[0]!;
  return {operationId:'aws_observer_install',storage:i.storage,snapshot,
    clock:{...i.clock,realNow:snapshot.completedAt,priorMirror:null,observation:{stripeAccountId:f.stripeAccountId,stage:f.stage,liveMode:false,startedAt:NOW-20,completedAt:NOW-10,
      customer:{id:f.customerId,object:'customer',livemode:false,test_clock:f.testClockId,metadata:{owner:OWNER,stage:f.stage,integration:'roadmap2u_individual_v1'}},
      clock:{id:f.testClockId,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:NOW/1000-86400,deletes_after:NOW/1000+86400}}}};
}

describe('bounded AWS observation for clock publication',()=>{
  it.each(['dev','test'])('collects current %s facts and composes the real installation',async stage=>{
    const s=setup(input(stage)),observer=await prepareClockAwsObserver(s.options);
    expect(s.seen).toEqual([]);expect(s.reserved).toEqual([]);expect(JSON.stringify(observer.preview)).not.toContain(SECRET);
    const observed=await observer.observe();
    expect(s.seen.map(x=>x.kind)).toEqual(kinds);expect(s.reserved).toEqual(kinds);expect(s.destroyed()).toBe(1);
    expect(observed).toMatchObject({kind:'install',awsAccountId:ACCOUNT,callerArn:ARN,actualIdentityVerified:true,tablesVerified:true,
      physicalAuthorizationChecked:false,sourceShaVerified:false,snapshot:{ownerSub:OWNER,stage,consistentReads:true,financialPartitionComplete:true,
        identity:{ownerSub:OWNER,enabled:false},profile:s.state[0],flags:s.state[1],financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null}});
    expect(JSON.stringify(observed)).not.toContain(SECRET);
    expect(s.seen.find(x=>x.kind==='snapshot')!.body.TransactItems).toHaveLength(8);
    expect(s.seen.find(x=>x.kind==='financial_partition')!.body).toMatchObject({ConsistentRead:true,Limit:100});
    const actual=await prepareClockInstallTransaction(request(s.i,observed.snapshot));
    expect(actual.transaction.TransactItems).toHaveLength(9);
  });
  it('collects an existing transition snapshot without partition-querying or changing state',async()=>{
    const initial=setup(),o=await prepareClockAwsObserver(initial.options),snapshot=(await o.observe()).snapshot;
    const installed=await prepareClockInstallTransaction(request(initial.i,snapshot));
    const s=setup(input('dev','transition'));
    s.state[2]={...installed.evidence.mirror};s.state[3]=installed.transaction.TransactItems!.find(x=>x.Put?.Item?.sk==='OWNER')!.Put!.Item!;
    s.state[7]=installed.transaction.TransactItems!.find(x=>x.Put?.Item?.sk==='STATE')!.Put!.Item!;
    const before=structuredClone(s.state),observer=await prepareClockAwsObserver(s.options),result=await observer.observe();
    expect(s.seen.map(x=>x.kind)).toEqual(kinds.slice(0,-1));expect(s.state).toEqual(before);expect(result.snapshot).not.toHaveProperty('financialRows');
    expect(result.snapshot).toMatchObject({financialState:s.state[7],customerMapping:s.state[3],mirror:s.state[2]});
    const clock=request(initial.i,result.snapshot).clock;clock.priorMirror=installed.evidence.mirror;
    const transition=await prepareClockTransitionTransaction({kind:'advance_fence',operationId:'aws_observer_fence',targetFrozenTimeSeconds:NOW/1000,
      clock,storage:initial.i.storage,snapshot:result.snapshot as any});
    expect(transition.transaction.TransactItems).toHaveLength(8);
  });
  it.each(['prod','live','historical','table','privacy','arn','pool','caller','token','expiry','region','kind'] as const)('rejects %s before delegated IO',async fault=>{
    const s=setup(),v=s.options;
    if(fault==='prod')v.clock.scope.stage='prod';if(fault==='live')v.clock.scope.liveMode=true;
    if(fault==='historical')v.clock.scope.fixtures[0]!.ownerSub='e4282408-f0f1-70b2-b5ef-b9ddb80599e7';
    if(fault==='table')v.clock.scope.tableName='roadmap-prod';if(fault==='privacy')v.storage.privacyTableName='roadmap-privacy-prod';
    if(fault==='arn')v.storage.appTableArn=v.storage.appTableArn.replace(ACCOUNT,'111111111111');
    if(fault==='pool')v.userPoolId='eu-west-1_SYNTHETIC';if(fault==='caller')v.expectedCallerArn=ARN.replace(ACCOUNT,'111111111111');
    if(fault==='token')v.credentials.sessionToken='';if(fault==='expiry')v.credentials.expiration=new Date(NOW+30000);
    if(fault==='region')v.storage.region='eu-west-1';if(fault==='kind')(v as any).kind='restore';
    await expect(prepareClockAwsObserver(v)).rejects.toThrow(/CLOCK_(AWS_OBSERVATION|PUBLISHER)_/);
    expect(s.seen).toEqual([]);expect(s.reserved).toEqual([]);
  });
  it.each(['account','caller'] as const)('stops on actual STS %s drift',async fault=>{
    const s=setup(input(),(kind,v)=>kind==='identity'?{...v,[fault==='account'?'Account':'Arn']:fault==='account'?'111111111111':ARN+'other'}:v);
    const observer=await prepareClockAwsObserver(s.options);await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen.map(x=>x.kind)).toEqual(['identity']);expect(s.destroyed()).toBe(1);
  });
  it.each(['arn','name','status','keys','types'] as const)('stops on table %s drift before reading fixture state',async fault=>{
    const s=setup(input(),(kind,v)=>{if(kind!=='app_table')return v;
      if(fault==='arn')v.Table.TableArn=v.Table.TableArn.replace(ACCOUNT,'111111111111');if(fault==='name')v.Table.TableName='roadmap-prod';
      if(fault==='status')v.Table.TableStatus='DELETING';if(fault==='keys')v.Table.KeySchema[1].AttributeName='other';if(fault==='types')v.Table.AttributeDefinitions[1].AttributeType='N';return v;});
    const observer=await prepareClockAwsObserver(s.options);await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen.map(x=>x.kind)).toEqual(['identity','app_table']);
  });
  it.each(['enabled','sub','username','duplicate'] as const)('stops on fixture identity %s drift',async fault=>{
    const s=setup(input(),(kind,v)=>{if(kind!=='fixture_identity')return v;if(fault==='enabled')v.Enabled=true;if(fault==='sub')v.UserAttributes[0].Value='other';
      if(fault==='username')v.Username='someone-else';if(fault==='duplicate')v.UserAttributes.push({Name:'sub',Value:OWNER});return v;});
    const observer=await prepareClockAwsObserver(s.options);await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen).toHaveLength(4);expect(s.seen.some(x=>x.kind==='snapshot')).toBe(false);
  });
  it.each(['missing','length','crossed','partition','pagination','transition'] as const)('rejects incomplete or crossed %s rows',async fault=>{
    const s=setup(input('dev',fault==='transition'?'transition':'install'),(kind,v)=>{
      if(kind==='snapshot'&&fault==='missing')return {};if(kind==='snapshot'&&fault==='length')v.Responses.pop();
      if(kind==='snapshot'&&fault==='crossed')v.Responses[0].Item.pk={S:'USER#other'};
      if(kind==='financial_partition'&&fault==='partition')v.Items=[marshall({pk:'BILLING#other',sk:'STATE'})];
      if(kind==='financial_partition'&&fault==='pagination')v.LastEvaluatedKey=marshall({pk:`BILLING#${OWNER}`,sk:'STATE'});return v;
    });
    const observer=await prepareClockAwsObserver(s.options);await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen.length).toBeLessThanOrEqual(6);expect(s.destroyed()).toBe(1);
  });
  it('binds the privacy key to the canonical retention helper',async()=>{
    const s=setup(),observer=await prepareClockAwsObserver(s.options);await observer.observe();
    const gets=s.seen.find(x=>x.kind==='snapshot')!.body.TransactItems;
    expect(gets[6].Get).toEqual({TableName:s.i.storage.privacyTableName,Key:marshall(restoreExclusionKey(OWNER))});
  });
  it('captures input and credentials before asynchronous preparation',async()=>{
    const s=setup(),preparing=prepareClockAwsObserver(s.options);
    s.options.clock.scope.tableName='roadmap-prod';s.options.clock.scope.fixtures[0]!.customerId='cus_crossed';
    s.options.credentials.accessKeyId='ASIA_MUTATED';s.options.credentials.sessionToken='mutated';s.options.expectedCallerArn=ARN+'other';
    const observer=await preparing;await observer.observe();
    expect(s.seen.every(x=>x.credential.includes('ASIA_SYNTHETIC'))).toBe(true);
    expect(s.seen.find(x=>x.kind==='snapshot')!.body.TransactItems[0].Get.TableName).toBe('roadmap-dev');
  });
  it('consumes an observation even if the global budget refuses the first wire',async()=>{
    const s=setup(),observer=await prepareClockAwsObserver({...s.options,reserveWire:()=>{throw new Error(SECRET);}});
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen).toEqual([]);expect(observer.counts().wireReservations.identity).toBe(1);expect(observer.counts().wireDelegations.identity).toBe(0);
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_ALREADY_CONSUMED');expect(s.destroyed()).toBe(1);
  });
  it.each(['closed','throttled'] as const)('never retries a %s SDK send and hides raw provider errors',async mode=>{
    const s=setup(),observer=await prepareClockAwsObserver({...s.options,requestHandler:{...s.handler,handle:async()=>{
      s.reserved.push('identity');if(mode==='closed')throw Object.assign(new Error(SECRET),{code:'ECONNRESET'});
      return {response:{statusCode:429,headers:{},body:Buffer.from(SECRET)}};
    }}});
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_AWS_OBSERVATION_LOOKUP_FAILED$/);
    expect(observer.counts().wireDelegations.identity).toBe(1);expect(s.reserved.filter(x=>x==='identity')).toHaveLength(2);
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_ALREADY_CONSUMED');
  });
  it('bounds a hung handler and closes its owned transport',async()=>{
    let signal:{readonly aborted:boolean}|undefined;
    const s=setup(),observer=await prepareClockAwsObserver({...s.options,requestTimeoutMs:15,requestHandler:{...s.handler,handle:async(_request,options)=>{signal=options?.abortSignal;return new Promise(()=>{});}}});
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');expect(s.destroyed()).toBe(1);
    expect(observer.counts().wireDelegations.identity).toBe(1);expect(signal?.aborted).toBe(true);
  });
  it.each(['expired','backward','stale'] as const)('stops on %s operational time before the next read',async fault=>{
    const s=setup(),original=s.handler.handle;s.handler.handle=async r=>{const response=await original(r);s.setNow(fault==='expired'?NOW+3599990:fault==='backward'?NOW-1:NOW+16*60000);return response;};
    const observer=await prepareClockAwsObserver(s.options);await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');expect(s.seen).toHaveLength(1);
  });
  it('never admits a second observation after success',async()=>{
    const s=setup(),observer=await prepareClockAwsObserver(s.options);await observer.observe();
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_ALREADY_CONSUMED');expect(s.seen).toHaveLength(6);expect(s.destroyed()).toBe(1);
  });
  it.each(['hostname','method','path','query','body','target'] as const)('rejects actual SDK %s drift before delegation',async fault=>{
    const s=setup(),observer=await prepareClockAwsObserver(s.options),original=STSClient.prototype.send;
    const spy=vi.spyOn(STSClient.prototype,'send').mockImplementation(function(this:STSClient,...args:any[]){
      this.middlewareStack.add(next=>async request=>{
        const wire=request.request as HttpRequest;
        if(fault==='hostname'){wire.hostname='outside.invalid';wire.headers.host='outside.invalid';}
        if(fault==='method')wire.method='DELETE';if(fault==='path')wire.path='/unapproved';
        if(fault==='query')wire.query={unapproved:'true'};if(fault==='body')wire.body='Action=Unapproved';
        if(fault==='target')wire.headers['x-amz-target']='DynamoDB_20120810.DeleteTable';
        return next(request);
      },{step:'finalizeRequest',name:'clockTestChangedWire',priority:'low'});
      return (original as any).apply(this,args);
    } as any);
    try{
      await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
      expect(s.seen).toEqual([]);expect(s.reserved).toEqual([]);expect(observer.counts().wireDelegations.identity).toBe(0);
    }finally{spy.mockRestore();}
  });
  it.each(['requestHandler','now','reserveWire'] as const)('requires the explicit %s dependency',async key=>{
    const s=setup();await expect(prepareClockAwsObserver({...s.options,[key]:undefined} as any)).rejects.toThrow('CLOCK_AWS_OBSERVATION_DEPENDENCIES_REQUIRED');expect(s.seen).toEqual([]);
  });
  it('hides transport destruction errors and leaves the observer consumed',async()=>{
    const s=setup(),observer=await prepareClockAwsObserver({...s.options,requestHandler:{...s.handler,destroy:()=>{throw new Error(SECRET);}}});
    await expect(observer.observe()).rejects.toThrow(/^CLOCK_AWS_OBSERVATION_LOOKUP_FAILED$/);
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_ALREADY_CONSUMED');expect(s.seen).toHaveLength(6);
  });
  it.each(['flags','minor','closure','restore','financial_rows'] as const)('preserves %s facts so the real installer rejects them',async fault=>{
    const s=setup(input(),(kind,value)=>kind==='financial_partition'&&fault==='financial_rows'
      ?{Items:[marshall({pk:`BILLING#${OWNER}`,sk:'AUDIT#retained'})],Count:1,ScannedCount:1}:value);
    if(fault==='flags')s.state[1]!.individualCheckoutEnabled=true;if(fault==='minor')s.state[0]!.accountType='minor';
    if(fault==='closure')s.state[5]={pk:`ACCOUNT_CLOSURE#${OWNER}`,sk:'STATE',status:'requested'};
    if(fault==='restore')s.state[6]={...restoreExclusionKey(OWNER),status:'excluded'};
    const observer=await prepareClockAwsObserver(s.options),observed=await observer.observe();
    await expect(prepareClockInstallTransaction(request(s.i,observed.snapshot))).rejects.toThrow(/^CLOCK_INSTALL_(CLOSED_VERSIONED_FLAGS_REQUIRED|EXISTING_ACTIVE_ADULT_REQUIRED|OPEN_NON_RESTORED_OWNER_REQUIRED|INITIAL_EMPTY_FIXTURE_REQUIRED)$/);
    expect(s.seen).toHaveLength(6);
  });
});

describe('read-only AWS clock recovery inventory',()=>{
  it('requires a synchronous budget reservation before any AWS delegation',async()=>{
    const s=setup(input('dev','recovery'));
    s.options.reserveWire=(()=>Promise.resolve()) as any;
    const reader=await prepareClockAwsObserver(s.options);
    await expect(reader.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen).toHaveLength(0);expect(s.destroyed()).toBe(1);
  });
  it.each(['dev','test'])('observes an existing %s state without applying install rules',async stage=>{
    const s=setup(input(stage,'recovery'));
    s.state[2]={pk:`USER#${OWNER}`,sk:'BILLING#TEST_CLOCK',clockRevision:2,providerReadyEvidence:{status:'advancing'}};
    s.state[7]={pk:`BILLING#${OWNER}`,sk:'STATE',ownerSub:OWNER,state:'payment_review',revision:8};
    const before=structuredClone(s.state),observer=await prepareClockAwsObserver(s.options),result=await observer.observe();
    expect(result).toMatchObject({kind:'recovery',physicalAuthorizationChecked:false,sourceShaVerified:false,stackOwnershipVerified:false,
      snapshot:{financialState:s.state[7],mirror:s.state[2],financialPartitionComplete:true,financialRows:[]}});
    expect(s.seen.map(x=>x.kind)).toEqual(kinds);expect(s.reserved).toEqual(kinds);
    expect(s.state).toEqual(before);expect(s.destroyed()).toBe(1);
  });
  it('retains an absent financial state as a recovery fact',async()=>{
    const s=setup(input('dev','recovery'));
    const result=await (await prepareClockAwsObserver(s.options)).observe();
    expect(result).toMatchObject({kind:'recovery',snapshot:{financialState:null,mirror:null,customerMapping:null,financialRows:[]}});
    expect(s.seen).toHaveLength(6);
  });
  it('retains existing audit rows without treating the partition as empty',async()=>{
    const retained={pk:`BILLING#${OWNER}`,sk:'AUDIT#retained',privateDiagnostic:'only-in-memory'};
    const s=setup(input('dev','recovery'),(kind,value)=>kind==='financial_partition'?{Items:[marshall(retained)],Count:1,ScannedCount:1}:value);
    const result=await (await prepareClockAwsObserver(s.options)).observe();
    expect(result).toMatchObject({kind:'recovery',snapshot:{financialRows:[retained],financialPartitionComplete:true}});
    expect(s.seen.at(-1)!.body).toMatchObject({ConsistentRead:true,Limit:100});
    expect(s.seen.at(-1)!.body).not.toHaveProperty('ExclusiveStartKey');
  });
  it.each(['pagination','crossed_partition','wrong_count'] as const)('stops an incomplete or crossed %s inventory',async fault=>{
    const s=setup(input('dev','recovery'),(kind,value)=>{
      if(kind!=='financial_partition')return value;
      if(fault==='pagination')return{...value,LastEvaluatedKey:marshall({pk:`BILLING#${OWNER}`,sk:'next'})};
      if(fault==='wrong_count')return{...value,Count:1};
      return{Items:[marshall({pk:'BILLING#someone_else',sk:'STATE'})],Count:1};
    });
    await expect((await prepareClockAwsObserver(s.options)).observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen).toHaveLength(6);expect(s.destroyed()).toBe(1);
  });
  it('retains closure/minor/restore facts for diagnosis rather than granting safety',async()=>{
    const s=setup(input('dev','recovery'));
    s.state[0]!.accountType='minor';s.state[5]={pk:`ACCOUNT_CLOSURE#${OWNER}`,sk:'STATE',status:'requested'};
    s.state[6]={...restoreExclusionKey(OWNER),status:'excluded'};
    const result=await (await prepareClockAwsObserver(s.options)).observe();
    expect(result.snapshot).toMatchObject({profile:s.state[0],closure:s.state[5],restoreExclusion:s.state[6]});
    expect(result.physicalAuthorizationChecked).toBe(false);
  });
  it('still stops when the synthetic Cognito identity has been enabled',async()=>{
    const s=setup(input('dev','recovery'),(kind,value)=>kind==='fixture_identity'?{...value,Enabled:true}:value);
    await expect((await prepareClockAwsObserver(s.options)).observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');
    expect(s.seen.map(x=>x.kind)).toEqual(kinds.slice(0,4));
  });
  it('captures recovery mode before caller mutation and consumes the observer once',async()=>{
    const s=setup(input('dev','recovery')),observer=await prepareClockAwsObserver(s.options);
    s.options.kind='install';s.state[7]={pk:`BILLING#${OWNER}`,sk:'STATE'};
    expect((await observer.observe()).kind).toBe('recovery');
    await expect(observer.observe()).rejects.toThrow('CLOCK_AWS_OBSERVATION_ALREADY_CONSUMED');
    expect(s.seen).toHaveLength(6);
  });
});
