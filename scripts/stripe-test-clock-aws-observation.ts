import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentity, HttpRequest } from '@smithy/types';
import { selectClockPublisherFixture, type ClockPublisherContext } from './stripe-test-clock-evidence';
import type { ClockInstallSnapshot, ClockStorageScope } from './stripe-test-clock-install';
import type { ClockTransitionSnapshot } from './stripe-test-clock-transition';
import type { ClockDynamoHandler } from './stripe-test-clock-dynamo-transport';
import { restoreExclusionKey } from '../lambda/privacy/retention';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

export type ClockAwsReadKind='identity'|'app_table'|'privacy_table'|'fixture_identity'|'snapshot'|'financial_partition';
export interface ClockAwsObservationOptions {
  kind:'install'|'transition'|'recovery'; clock:Pick<ClockPublisherContext,'ownerSub'|'scope'>; storage:ClockStorageScope;
  expectedCallerArn:string; userPoolId:string; credentials:AwsCredentialIdentity;
  requestHandler:ClockDynamoHandler; now:()=>number; reserveWire:(kind:ClockAwsReadKind)=>void; requestTimeoutMs?:number;
}
const kinds:ClockAwsReadKind[]=['identity','app_table','privacy_table','fixture_identity','snapshot','financial_partition'];
const count=():Record<ClockAwsReadKind,number>=>({identity:0,app_table:0,privacy_table:0,fixture_identity:0,snapshot:0,financial_partition:0});
function requireCondition(ok:unknown,reason:string):asserts ok{if(!ok)throw new Error(`CLOCK_AWS_OBSERVATION_${reason}`);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function timestamp(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value).getTime());}
function body(request:HttpRequest):string{
  requireCondition(typeof request.body==='string'||request.body instanceof Uint8Array,'WIRE_BODY_INVALID');
  const value=request.body;
  return (typeof value==='string'?Buffer.from(value):Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))).toString('utf8');
}
function clients(credentials:AwsCredentialIdentity,requestHandler:ClockDynamoHandler){
  const common={region:'us-east-1',credentials,requestHandler,maxAttempts:1};
  const identity=new STSClient({...common,endpoint:'https://sts.us-east-1.amazonaws.com'});
  const cognito=new CognitoIdentityProviderClient({...common,endpoint:'https://cognito-idp.us-east-1.amazonaws.com'});
  const database=new DynamoDBClient({...common,endpoint:'https://dynamodb.us-east-1.amazonaws.com'});
  return {identity,cognito,database,document:DynamoDBDocumentClient.from(database),destroy(){identity.destroy();cognito.destroy();database.destroy();}};
}
type Clients=ReturnType<typeof clients>;
interface Action {kind:ClockAwsReadKind;send:(sdk:Clients,signal?:AbortSignal)=>Promise<unknown>}
interface Wire {hostname:string;target:string|undefined;body:string}
function wire(request:HttpRequest,kind:ClockAwsReadKind):Wire{
  const hostname=kind==='identity'?'sts.us-east-1.amazonaws.com':kind==='fixture_identity'?'cognito-idp.us-east-1.amazonaws.com':'dynamodb.us-east-1.amazonaws.com';
  requireCondition(request.protocol==='https:'&&request.hostname===hostname&&(request.port===undefined||request.port===443)
    &&request.method==='POST'&&request.path==='/'&&(!request.query||Object.keys(request.query).length===0)&&request.headers.host===hostname,'WIRE_SCOPE_REJECTED');
  return {hostname,target:request.headers['x-amz-target'],body:body(request)};
}
function accepted(value:unknown):asserts value is Record<string,unknown>{requireCondition(record(value)&&record(value.$metadata)&&value.$metadata.httpStatusCode===200,'RESPONSE_INVALID');}
function table(value:unknown,name:string,arn:string){
  accepted(value);const t=value.Table;
  requireCondition(record(t)&&t.TableName===name&&t.TableArn===arn&&t.TableStatus==='ACTIVE','TABLE_MISMATCH');
  requireCondition(Array.isArray(t.KeySchema)&&t.KeySchema.length===2&&t.KeySchema.every(record),'TABLE_KEYS_INVALID');
  const keys=t.KeySchema;requireCondition(keys.some(k=>k.AttributeName==='pk'&&k.KeyType==='HASH')&&keys.some(k=>k.AttributeName==='sk'&&k.KeyType==='RANGE'),'TABLE_KEYS_INVALID');
  requireCondition(Array.isArray(t.AttributeDefinitions)&&t.AttributeDefinitions.every(record),'TABLE_TYPES_INVALID');
  for(const key of ['pk','sk']){
    const definitions=t.AttributeDefinitions.filter(v=>v.AttributeName===key);requireCondition(definitions.length===1&&definitions[0]!.AttributeType==='S','TABLE_TYPES_INVALID');
  }
}
/** Private read component. All credentials and handlers are explicit; the caller
 * must separately verify human authority, source and CloudFormation ownership. */
export async function prepareClockAwsObserver(options:ClockAwsObservationOptions){
  const clock=structuredClone(options.clock),storage=structuredClone(options.storage),kind=options.kind;
  const expectedCallerArn=options.expectedCallerArn,userPoolId=options.userPoolId,handler=options.requestHandler,now=options.now,reserveWire=options.reserveWire;
  const timeout=options.requestTimeoutMs??20000,supplied=options.credentials;
  requireCondition(kind==='install'||kind==='transition'||kind==='recovery','KIND_INVALID');
  requireCondition(typeof now==='function'&&typeof reserveWire==='function'&&handler&&typeof handler.handle==='function','DEPENDENCIES_REQUIRED');
  requireCondition(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=20000,'TIMEOUT_INVALID');
  requireCondition(supplied&&typeof supplied.accessKeyId==='string'&&supplied.accessKeyId.length>0&&typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0
    &&typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0&&supplied.expiration instanceof Date&&timestamp(supplied.expiration.getTime()),'CREDENTIAL_SNAPSHOT_REQUIRED');
  const credentials:AwsCredentialIdentity={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration.getTime())};
  const preparedAt=now();requireCondition(timestamp(preparedAt),'TIME_INVALID');let previous=preparedAt;
  function fresh(){const t=now();requireCondition(timestamp(t)&&t>=previous&&t-preparedAt<TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'CONTEXT_EXPIRED');
    requireCondition(credentials.expiration!.getTime()>t+30000,'CREDENTIALS_EXPIRED');previous=t;return t;}
  fresh();const fixture=selectClockPublisherFixture({...clock,realNow:preparedAt});
  const app=clock.scope.tableName,privacy=storage.privacyTableName,stage=clock.scope.stage,owner=clock.ownerSub;
  requireCondition(storage.stage===stage&&storage.awsAccountId==='765932874577'&&storage.region==='us-east-1','STORAGE_SCOPE_MISMATCH');
  requireCondition(app===`roadmap-${stage}`&&privacy===`roadmap-privacy-${stage}`,'CANONICAL_TABLES_REQUIRED');
  const arnPrefix='arn:aws:dynamodb:us-east-1:765932874577:table/';
  requireCondition(storage.appTableArn===arnPrefix+app&&storage.privacyTableArn===arnPrefix+privacy,'TABLE_ARN_MISMATCH');
  requireCondition(typeof userPoolId==='string'&&/^us-east-1_[A-Za-z0-9]+$/.test(userPoolId),'USER_POOL_SCOPE_REQUIRED');
  requireCondition(typeof expectedCallerArn==='string'&&/^arn:aws:(?:sts::765932874577:assumed-role|iam::765932874577:user)\/[A-Za-z0-9_+=,.@/-]+$/.test(expectedCallerArn),'CALLER_ARN_REQUIRED');
  const targets=[
    {TableName:app,Key:{pk:`USER#${owner}`,sk:'PROFILE'}},
    {TableName:app,Key:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS'}},
    {TableName:app,Key:{pk:`USER#${owner}`,sk:'BILLING#TEST_CLOCK'}},
    {TableName:app,Key:{pk:`STRIPE#${fixture.stripeAccountId}#${stage}#test#CUSTOMER#${fixture.customerId}`,sk:'OWNER'}},
    {TableName:app,Key:{pk:`USER#${owner}`,sk:'SUBSCRIPTION#INDIVIDUAL'}},
    {TableName:app,Key:{pk:`ACCOUNT_CLOSURE#${owner}`,sk:'STATE'}},
    {TableName:privacy,Key:restoreExclusionKey(owner)},
    {TableName:app,Key:{pk:`BILLING#${owner}`,sk:'STATE'}},
  ];
  const actions:Action[]=[
    {kind:'identity',send:(sdk,signal)=>sdk.identity.send(new GetCallerIdentityCommand({}),{abortSignal:signal})},
    {kind:'app_table',send:(sdk,signal)=>sdk.database.send(new DescribeTableCommand({TableName:app}),{abortSignal:signal})},
    {kind:'privacy_table',send:(sdk,signal)=>sdk.database.send(new DescribeTableCommand({TableName:privacy}),{abortSignal:signal})},
    {kind:'fixture_identity',send:(sdk,signal)=>sdk.cognito.send(new AdminGetUserCommand({UserPoolId:userPoolId,Username:fixture.syntheticFixture}),{abortSignal:signal})},
    {kind:'snapshot',send:(sdk,signal)=>sdk.document.send(new TransactGetCommand({TransactItems:targets.map(Get=>({Get:structuredClone(Get)}))}),{abortSignal:signal})},
    ...(kind!=='transition'?[{kind:'financial_partition' as const,send:(sdk:Clients,signal?:AbortSignal)=>sdk.document.send(new QueryCommand({TableName:app,KeyConditionExpression:'pk = :owner',
      ExpressionAttributeValues:{':owner':`BILLING#${owner}`},ConsistentRead:true,Limit:100}),{abortSignal:signal})}]:[]),
  ];
  // Capture the installed SDK's exact serialization without any external handler.
  const expected:Partial<Record<ClockAwsReadKind,Wire>>={};let serializing:ClockAwsReadKind='identity';
  const offline=clients({accessKeyId:'synthetic',secretAccessKey:'synthetic'},{handle:async request=>{
    requireCondition(!expected[serializing],'SERIALIZATION_REPEATED');expected[serializing]=wire(request,serializing);
    return {response:{statusCode:200,headers:{},body:Buffer.from('{}')}};
  }});
  try{for(const action of actions){serializing=action.kind;try{await action.send(offline);}catch{/* Deserialization is irrelevant to wire capture. */}
    requireCondition(expected[action.kind],'SERIALIZATION_FAILED');}}finally{offline.destroy();}
  const reservations=count(),delegations=count();let consumed=false,active=false,current:ClockAwsReadKind='identity';
  const guarded:ClockDynamoHandler={handle:async(request,requestOptions)=>{
    requireCondition(active,'WIRE_INACTIVE');fresh();const actual=wire(request,current),planned=expected[current]!;
    requireCondition(actual.hostname===planned.hostname&&actual.target===planned.target&&actual.body===planned.body,'WIRE_BODY_REJECTED');
    requireCondition(reservations[current]===0,'WIRE_LIMIT_REJECTED');reservations[current]++;
    const reserved:unknown=reserveWire(current);
    if(reserved&&typeof(reserved as {then?:unknown}).then==='function'){
      void Promise.resolve(reserved).catch(()=>undefined);throw Error('CLOCK_AWS_OBSERVATION_ASYNC_RESERVATION_REJECTED');
    }
    fresh();delegations[current]++;
    return handler.handle(request,requestOptions);
  }};
  async function bounded(action:Action,sdk:Clients){
    current=action.kind;fresh();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('CLOCK_AWS_OBSERVATION_REQUEST_TIMEOUT'));},timeout);});
    try{return await Promise.race([action.send(sdk,controller.signal),deadline]);}finally{clearTimeout(timer);}
  }
  return {
    preview:{kind,stage,ownerSub:owner,awsAccountId:storage.awsAccountId,appTableArn:storage.appTableArn,privacyTableArn:storage.privacyTableArn,
      maximumReadRequests:actions.length,atomicReadItems:targets.length,physicalAuthorizationChecked:false,sourceShaVerified:false,stackOwnershipVerified:false},
    counts:()=>({wireReservations:{...reservations},wireDelegations:{...delegations}}),
    async observe(){
      requireCondition(!consumed,'ALREADY_CONSUMED');consumed=true;active=true;const owned=clients(credentials,guarded);
      try{
        const startedAt=fresh(),responses:Partial<Record<ClockAwsReadKind,unknown>>={};
        for(const action of actions){
          const value=await bounded(action,owned);accepted(value);responses[action.kind]=value;fresh();
          if(action.kind==='identity')requireCondition(value.Account===storage.awsAccountId&&value.Arn===expectedCallerArn&&typeof value.UserId==='string'&&value.UserId.length>0,'CALLER_MISMATCH');
          if(action.kind==='app_table')table(value,app,storage.appTableArn);
          if(action.kind==='privacy_table')table(value,privacy,storage.privacyTableArn);
          if(action.kind==='fixture_identity'){
            requireCondition(value.Username===fixture.syntheticFixture&&value.Enabled===false&&Array.isArray(value.UserAttributes)&&value.UserAttributes.every(record),'FIXTURE_IDENTITY_MISMATCH');
            const subjects=value.UserAttributes.filter(v=>v.Name==='sub');requireCondition(subjects.length===1&&subjects[0]!.Value===owner,'FIXTURE_IDENTITY_MISMATCH');
          }
        }
        const response=responses.snapshot;requireCondition(record(response)&&Array.isArray(response.Responses)&&response.Responses.length===targets.length,'ATOMIC_SNAPSHOT_INCOMPLETE');
        const items=response.Responses.map((row,index)=>{
          requireCondition(record(row),'ATOMIC_SNAPSHOT_INVALID');if(row.Item===undefined)return null;
          requireCondition(record(row.Item)&&row.Item.pk===targets[index]!.Key.pk&&row.Item.sk===targets[index]!.Key.sk,'ATOMIC_SNAPSHOT_CROSSED');return structuredClone(row.Item);
        });
        const snapshot={ownerSub:owner,stage,appTableName:app,privacyTableName:privacy,startedAt,completedAt:fresh(),consistentReads:true,
          identity:{ownerSub:owner,enabled:false},profile:items[0]!,flags:items[1],mirror:items[2],customerMapping:items[3],subscriptionSource:items[4],closure:items[5],restoreExclusion:items[6]};
        const evidence={awsAccountId:storage.awsAccountId,callerArn:expectedCallerArn,actualIdentityVerified:true,tablesVerified:true,
          physicalAuthorizationChecked:false,sourceShaVerified:false,stackOwnershipVerified:false,wireReservations:{...reservations},wireDelegations:{...delegations}};
        if(kind!=='transition'){
          if(kind==='install')requireCondition(items[7]===null,'INSTALL_STATE_PRESENT');
          const query=responses.financial_partition;
          requireCondition(record(query)&&Array.isArray(query.Items)&&query.Count===query.Items.length
            &&(query.LastEvaluatedKey===undefined||(record(query.LastEvaluatedKey)&&Object.keys(query.LastEvaluatedKey).length===0)),'PARTITION_INCOMPLETE');
          requireCondition(query.Items.every(row=>record(row)&&row.pk===`BILLING#${owner}`&&typeof row.sk==='string'&&row.sk.length>0),'PARTITION_CROSSED');
          const result:ClockInstallSnapshot={...snapshot,financialPartitionComplete:true,financialRows:structuredClone(query.Items)};
          // Recovery observes facts even after a partial installation. It does
          // not satisfy installation guards or grant financial authority.
          if(kind==='recovery')return{kind:'recovery' as const,snapshot:{...result,financialState:items[7]},...evidence};
          return {kind:'install' as const,snapshot:result,...evidence};
        }
        requireCondition(record(items[7]),'TRANSITION_STATE_MISSING');
        const result:ClockTransitionSnapshot={...snapshot,financialState:items[7],customerMapping:items[3]};
        return {kind:'transition' as const,snapshot:result,...evidence};
      }catch{throw new Error('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');}
      finally{active=false;let failed=false;try{owned.destroy();}catch{failed=true;}try{handler.destroy?.();}catch{failed=true;}
        if(failed)throw new Error('CLOCK_AWS_OBSERVATION_LOOKUP_FAILED');}
    },
  };
}
