import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DynamoBillingRepository } from '../lambda/billing/dynamo';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import { resolveFinancialClock } from '../lambda/billing/clock';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../scripts/stripe-test-clock-install';

const NOW=Date.UTC(2026,9,13,12),FROZEN=NOW/1000-86400;
function input(stage='dev'): ClockInstallRequest {
  const owner='owner_clock_one',customerId='cus_clock_one',testClockId='clock_one',account='acct_sandbox';
  const table=`roadmap-${stage}`,privacy=`roadmap-privacy-${stage}`;
  return {operationId:'clock_install_one',storage:{stage,awsAccountId:'765932874577',region:'us-east-1',appTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${table}`,privacyTableName:privacy,privacyTableArn:`arn:aws:dynamodb:us-east-1:765932874577:table/${privacy}`},
    clock:{ownerSub:owner,realNow:NOW,priorMirror:null,scope:{tableName:table,stage,stripeAccountId:account,liveMode:false,fixtures:[{ownerSub:owner,customerId,testClockId,bindingId:'binding_one',stage,stripeAccountId:account,syntheticFixture:`stripe_clock_${stage}_one`}]},
      observation:{stripeAccountId:account,stage,liveMode:false,startedAt:NOW-100,completedAt:NOW-50,
        customer:{id:customerId,object:'customer',livemode:false,test_clock:testClockId,metadata:{integration:'roadmap2u_individual_v1',stage,owner}},
        clock:{id:testClockId,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:FROZEN,deletes_after:NOW/1000+86400}}},
    snapshot:{ownerSub:owner,stage,appTableName:table,privacyTableName:privacy,startedAt:NOW-100,completedAt:NOW-20,consistentReads:true,financialPartitionComplete:true,
      identity:{ownerSub:owner,enabled:false},profile:{pk:`USER#${owner}`,sk:'PROFILE',userId:owner,accountType:'adult',status:'active'},financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null,
      flags:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:61,quotaMode:'enforce',capabilityMode:'enforce',accessCodeIssuanceEnabled:false,accessCodeRedemptionEnabled:false,
        premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,schemaVersion:2,paymentScope:'none',individualCheckoutEnabled:false,updatedAt:NOW-1000,updatedBy:'synthetic',reason:'closed'}}};
}
async function prepared(stage='dev') {const i=input(stage),p=await prepareClockInstallTransaction(i);expect(p).toBeDefined();return {i,p:p!};}
function operations(tx:TransactWriteCommandInput) {return tx.TransactItems!.map(item=>item.Put ?? item.ConditionCheck!);}

describe('atomic clock initial installation request',()=>{
  it.each(['dev','test'])('packs %s reference, mirror, mapping and audit in one transaction without granting access',async stage=>{
    const {i,p}=await prepared(stage),items=p.transaction.TransactItems!;
    expect(items).toHaveLength(9);expect(items.filter(item=>item.Put)).toHaveLength(4);expect(items.filter(item=>item.ConditionCheck)).toHaveLength(5);
    const state=items.find(item=>item.Put?.Item?.sk==='STATE')!.Put!.Item!;
    expect(state).toMatchObject({pk:`BILLING#${i.clock.ownerSub}`,ownerSub:i.clock.ownerSub,revision:1,state:'none',customerId:i.clock.observation.customer.id,testClock:p.evidence.reference,updatedAt:NOW,nextReconcileAt:NOW});
    expect(items.find(item=>item.Put?.Item?.sk==='BILLING#TEST_CLOCK')?.Put?.Item).toEqual(p.evidence.mirror);
    expect(items.find(item=>item.Put?.Item?.sk==='OWNER')?.Put?.Item).toMatchObject({pk:`STRIPE#acct_sandbox#${stage}#test#CUSTOMER#cus_clock_one`,ownerSub:i.clock.ownerSub,liveMode:false});
    expect(items.some(item=>item.Put?.Item?.sk==='PROFILE' || item.Put?.Item?.sk==='ACCESS' || item.Put?.Item?.sk==='SUBSCRIPTION#INDIVIDUAL')).toBe(false);
    expect(p.physicalExecutionAllowed).toBe(false);
    expect(deriveAccessItem(i.clock.ownerSub,NOW,undefined,[]).effectivePlanKey).toBe('free');
    expect(resolveFinancialClock({ownerSub:i.clock.ownerSub,customerId:i.clock.observation.customer.id,stage,accountId:'acct_sandbox',liveMode:false,now:NOW,reference:state.testClock,providerTestClockId:'clock_one'},p.evidence.mirror).mode).toBe('simulation');
  });
  it('matches financial state, mapping, retention and audit packing from the real repository',async()=>{
    const {i,p}=await prepared();let captured:TransactWriteCommandInput|undefined;
    const ddb={send:async(command:TransactWriteCommand)=>{captured=command.input;return {};}} as unknown as DynamoDBDocumentClient;
    const repository=new DynamoBillingRepository({ddb,table:i.clock.scope.tableName,accountId:'acct_sandbox',stage:'dev',liveMode:false});
    await repository.commit({expectedRevision:0,state:p.state,guard:'none',mappings:[{kind:'customer',id:'cus_clock_one'}],auditAction:'test_clock_binding_installed'});
    for (const item of captured!.TransactItems!.filter(item=>item.Put)) {
      const real=item.Put!.Item!;
      expect(p.transaction.TransactItems!.find(candidate=>candidate.Put?.Item?.pk===real.pk && candidate.Put?.Item?.sk===real.sk)?.Put?.Item).toEqual(real);
      expect(real.ttl).toBeUndefined();expect(real.retentionScope).toBe('commercial');expect(real.retentionStatus).toBe('pending_policy_approval');
    }
  });
  it('uses real time for due index and audit even when financial time is behind',async()=>{
    const {p}=await prepared();const state=p.transaction.TransactItems!.find(item=>item.Put?.Item?.sk==='STATE')!.Put!.Item!;
    expect(state.gsi1sk).toBe(`NEXT#${String(NOW).padStart(14,'0')}#owner_clock_one`);
    expect(p.transaction.TransactItems!.find(item=>item.Put?.Item?.action==='test_clock_binding_installed')!.Put!.Item).toMatchObject({occurredAt:NOW});
    expect(p.state.testClock?.frozenTimeSeconds).toBe(FROZEN);
  });
  it('has one conditional action per item and no overwrite path',async()=>{
    const {p}=await prepared();const keys=operations(p.transaction).map(op=>{const key='Item' in op?op.Item!:op.Key!;return `${op.TableName}:${key.pk}:${key.sk}`;});
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of p.transaction.TransactItems!.filter(item=>item.Put)) expect(item.Put!.ConditionExpression).toContain('attribute_not_exists');
    expect(p.transaction.TransactItems!.some(item=>item.Update || item.Delete)).toBe(false);
  });
  it('fences adult existence, closure, source, independent restore exclusion and exact closed flags',async()=>{
    const {i,p}=await prepared();const guards=p.transaction.TransactItems!.filter(item=>item.ConditionCheck).map(item=>item.ConditionCheck!);
    expect(guards.find(g=>g.Key?.sk==='PROFILE')).toMatchObject({ConditionExpression:expect.stringContaining('attribute_exists'),ExpressionAttributeValues:{':owner':i.clock.ownerSub,':adult':'adult',':active':'active'}});
    expect(guards.find(g=>g.Key?.pk===`ACCOUNT_CLOSURE#${i.clock.ownerSub}`)?.ConditionExpression).toContain('attribute_not_exists');
    expect(guards.find(g=>g.Key?.pk===`RESTORE#${i.clock.ownerSub}`)).toMatchObject({TableName:i.storage.privacyTableName,ConditionExpression:expect.stringContaining('attribute_not_exists')});
    expect(guards.find(g=>g.Key?.sk==='SUBSCRIPTION#INDIVIDUAL')?.ConditionExpression).toContain('attribute_not_exists');
    expect(guards.find(g=>g.Key?.pk==='COMMERCIAL#CONFIG')?.ExpressionAttributeValues).toMatchObject({':flag_revision':61,':flag_paymentScope':'none',':flag_individualCheckoutEnabled':false});
  });
  const invalid: [string,(i:ClockInstallRequest)=>void][]=[
    ['missing profile',i=>{i.snapshot.profile=null;}],['foreign profile',i=>{i.snapshot.profile!.userId='other';}],
    ['minor profile',i=>{i.snapshot.profile!.accountType='minor';}],['inactive profile',i=>{i.snapshot.profile!.status='closed';}],
    ['private profile',i=>{i.snapshot.profile!.privacyMode='private';}],['enabled identity',i=>{i.snapshot.identity.enabled=true;}],
    ['foreign identity',i=>{i.snapshot.identity.ownerSub='other';}],['incomplete financial partition',i=>{i.snapshot.financialPartitionComplete=false;}],
    ['existing financial state',i=>{i.snapshot.financialRows=[{pk:`BILLING#${i.clock.ownerSub}`,sk:'STATE',revision:1}];}],
    ['orphan historical invoice',i=>{i.snapshot.financialRows=[{pk:`BILLING#${i.clock.ownerSub}`,sk:'INVOICE#old'}];}],
    ['existing mirror',i=>{i.snapshot.mirror={clockRevision:1};}],['existing mapping',i=>{i.snapshot.customerMapping={ownerSub:i.clock.ownerSub};}],
    ['existing individual source',i=>{i.snapshot.subscriptionSource={state:'ended'};}],['closing owner',i=>{i.snapshot.closure={closureId:'closing'};}],
    ['restore exclusion',i=>{i.snapshot.restoreExclusion={scope:'account'};}],['inconsistent reads',i=>{i.snapshot.consistentReads=false;}],
    ['foreign snapshot owner',i=>{i.snapshot.ownerSub='other';}],['wrong snapshot table',i=>{i.snapshot.appTableName='Roadmap-prod-AppData';}],
    ['stale inventory',i=>{i.snapshot.startedAt=NOW-900000;}],['future inventory',i=>{i.snapshot.completedAt=NOW+1;}],
    ['wrong AWS account',i=>{i.storage.awsAccountId='111111111111';}],['wrong region',i=>{i.storage.region='us-west-2';}],
    ['cross-account table ARN',i=>{i.storage.appTableArn=i.storage.appTableArn.replace('765932874577','111111111111');}],
    ['shared privacy table',i=>{i.storage.privacyTableName=i.clock.scope.tableName;i.storage.privacyTableArn=i.storage.appTableArn;i.snapshot.privacyTableName=i.clock.scope.tableName;}],
    ['open purchases',i=>{Object.assign(i.snapshot.flags!,{premiumPaymentsEnabled:true,paymentScope:'individual',individualCheckoutEnabled:true});}],
    ['invalid flags',i=>{Object.assign(i.snapshot.flags!,{revision:0});}],['missing flags',i=>{i.snapshot.flags=null;}],
    ['missing operation ID',i=>{i.operationId=undefined as unknown as string;}],
  ];
  it.each(invalid)('does not prepare a transaction for %s',async(_name,change)=>{const i=input();change(i);await expect(prepareClockInstallTransaction(i)).rejects.toThrow();});
  it.each(['prod','unknown'])('rejects %s even with an otherwise complete snapshot',async stage=>{await expect(prepareClockInstallTransaction(input(stage))).rejects.toThrow();});
  it.each(['app','privacy'])('rejects a PROD %s table even when the supplied ARN and snapshot agree',async target=>{
    const i=input();
    if (target==='app') {i.clock.scope.tableName='roadmap-prod';i.storage.appTableArn='arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-prod';i.snapshot.appTableName='roadmap-prod';}
    else {i.storage.privacyTableName='roadmap-privacy-prod';i.storage.privacyTableArn='arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-privacy-prod';i.snapshot.privacyTableName='roadmap-privacy-prod';}
    await expect(prepareClockInstallTransaction(i)).rejects.toThrow();
  });
  it('uses a stable bounded operation token and captures caller data before async validation',async()=>{
    const i=input(),before=structuredClone(i);const pending=prepareClockInstallTransaction(i);
    Object.assign(i.snapshot.flags!,{revision:999});i.clock.ownerSub='changed';
    const p=await pending;expect(p).toBeDefined();const again=await prepareClockInstallTransaction(before);expect(p!.transaction).toEqual(again!.transaction);
    expect(p!.transaction.ClientRequestToken).toMatch(/^[a-f0-9]{36}$/);
    const other=await prepareClockInstallTransaction({...before,operationId:'clock_install_two'});expect(other!.transaction.ClientRequestToken).not.toBe(p!.transaction.ClientRequestToken);
  });
  it('serializes with the actual document client through an in-memory handler only',async()=>{
    const {p}=await prepared();let body:Record<string,any>|undefined,handled=0;
    const ddb=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-east-1',endpoint:'https://synthetic.invalid',maxAttempts:1,
      credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'},requestHandler:{handle:async(request:any)=>{handled++;body=JSON.parse(request.body);return {response:{statusCode:200,headers:{},body:Buffer.from('{}')}};}}}));
    try {await ddb.send(new TransactWriteCommand(p.transaction));} finally {ddb.destroy();}
    expect(handled).toBe(1);expect(body!.TransactItems).toHaveLength(9);
    expect(body!.TransactItems.find((item:any)=>item.Put?.Item?.sk?.S==='STATE').Put.Item.testClock.M.clockRevision.N).toBe('1');
    expect(body!.TransactItems.find((item:any)=>item.Put?.Item?.sk?.S==='BILLING#TEST_CLOCK').Put.Item.liveMode.BOOL).toBe(false);
  });
});
