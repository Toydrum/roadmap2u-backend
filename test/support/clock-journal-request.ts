import { FAMILY_BILLING_FLAG_DEFAULTS } from '../../lambda/commercial/flags';
import { prepareClockInstallTransaction, type ClockInstallRequest } from '../../scripts/stripe-test-clock-install';
import type { ClockTransitionRequest } from '../../scripts/stripe-test-clock-transition';

export const JOURNAL_NOW=Date.UTC(2026,9,14,23,30);
/** Pure synthetic request. No Git, human receipt, credentials or network. */
export async function clockJournalRequest(phase:'install'|'advance_fence'='install'){
 const now=JOURNAL_NOW,owner='clock_native_owner',customer='cus_native_fixture',clock='clock_native_fixture',account='acct_native_sandbox';
 const request:ClockInstallRequest={operationId:'native_install_one',
  storage:{stage:'dev',awsAccountId:'765932874577',region:'us-east-1',appTableArn:'arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-dev',
   privacyTableName:'roadmap-privacy-dev',privacyTableArn:'arn:aws:dynamodb:us-east-1:765932874577:table/roadmap-privacy-dev'},
  clock:{ownerSub:owner,priorMirror:null,realNow:now,scope:{tableName:'roadmap-dev',stage:'dev',stripeAccountId:account,liveMode:false,
   fixtures:[{ownerSub:owner,customerId:customer,testClockId:clock,bindingId:'native_fixture_binding',stage:'dev',stripeAccountId:account,syntheticFixture:'stripe_clock_dev_native'}]},
   observation:{stripeAccountId:account,stage:'dev',liveMode:false,startedAt:now-20,completedAt:now-10,
    customer:{id:customer,object:'customer',livemode:false,test_clock:clock,metadata:{owner,stage:'dev',integration:'roadmap2u_individual_v1'}},
    clock:{id:clock,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:now/1000-86400,deletes_after:now/1000+86400}}},
  snapshot:{ownerSub:owner,stage:'dev',appTableName:'roadmap-dev',privacyTableName:'roadmap-privacy-dev',startedAt:now-50,completedAt:now-10,
   consistentReads:true,financialPartitionComplete:true,identity:{ownerSub:owner,enabled:false},
   profile:{pk:'USER#'+owner,sk:'PROFILE',userId:owner,accountType:'adult',status:'active',privatePayload:'in-memory-only'},
   financialRows:[],mirror:null,customerMapping:null,subscriptionSource:null,closure:null,restoreExclusion:null,
   flags:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS',revision:65,quotaMode:'enforce',capabilityMode:'enforce',accessCodeIssuanceEnabled:false,
    accessCodeRedemptionEnabled:false,premiumPaymentsEnabled:false,...FAMILY_BILLING_FLAG_DEFAULTS,schemaVersion:2,paymentScope:'none',
    individualCheckoutEnabled:false,updatedAt:now-3000,updatedBy:'synthetic',reason:'closed'}}};
 if(phase==='install')return {request,sourceSha:'b'.repeat(40)};
 const prior=structuredClone(request);prior.clock.realNow-=2000;prior.clock.observation.startedAt-=2000;prior.clock.observation.completedAt-=2000;
 prior.snapshot.startedAt-=2000;prior.snapshot.completedAt-=2000;
 const installed=await prepareClockInstallTransaction(prior);
 const {financialRows:_rows,financialPartitionComplete:_complete,subscriptionSource:_source,...snapshot}=request.snapshot;
 const transition:ClockTransitionRequest={operationId:'native_advance_one',kind:'advance_fence',targetFrozenTimeSeconds:now/1000,storage:request.storage,
  clock:{...request.clock,priorMirror:installed.evidence.mirror},snapshot:{...snapshot,mirror:installed.evidence.mirror,
   financialState:installed.transaction.TransactItems!.find(x=>x.Put?.Item?.sk==='STATE')!.Put!.Item!,
   customerMapping:installed.transaction.TransactItems!.find(x=>x.Put?.Item?.sk==='OWNER')!.Put!.Item!}};
 return {request:transition,sourceSha:'b'.repeat(40)};
}
