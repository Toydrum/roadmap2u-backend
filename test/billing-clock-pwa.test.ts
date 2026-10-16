import { describe, expect, it } from 'vitest';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { accessSummary } from '../lambda/access-reader';
import { BillingService } from '../lambda/billing/service';
import { fixture, config, request, NOW } from './support/billing-fixture';
const DAY=86400000;
function clock(stage='dev') {
  const reference={ownerSub:'adult',customerId:'cus_simulated',testClockId:'clock_simulated',bindingId:'binding-1',stage,
    stripeAccountId:config.accountId,syntheticFixture:`stripe_clock_${stage}_monthly`,clockRevision:2,frozenTimeSeconds:(NOW+DAY)/1000};
  const mirror={...reference,pk:'USER#adult',sk:'BILLING#TEST_CLOCK',entityType:'BillingTestClock',liveMode:false,
    providerReadyEvidence:{status:'ready',customerId:reference.customerId,testClockId:reference.testClockId,stripeAccountId:config.accountId,
      liveMode:false,frozenTimeSeconds:reference.frozenTimeSeconds,observedAt:NOW}};
  const subscription={pk:'USER#adult',sk:'SUBSCRIPTION#INDIVIDUAL' as const,entityType:'SubscriptionSource' as const,ownerSub:'adult',
    sourceId:'simulated-individual',state:'active' as const,paidThrough:NOW+2*DAY,graceUntil:null,revision:1,updatedAt:NOW,testClock:reference};
  return {reference,mirror,subscription};
}
describe('public PWA clock presentation from existing server authority',()=>{
  it.each(['dev','test'])('publishes minimal %s access metadata without granting an offline lease',stage=>{
    const c=clock(stage),access=deriveAccessItem('adult',NOW,undefined,[],{subscription:c.subscription,testClock:c.mirror,testClockObserved:true,billingStage:stage});
    const result=accessSummary(access,{activeTrees:0,visibleBranchesByTree:{}});
    expect(result).toMatchObject({effectivePlanKey:'premium',offlineValidUntil:NOW,simulation:{stage,mode:'ready',frozenAt:NOW+DAY,clockRevision:2,observedAt:NOW,evidenceValidUntil:NOW+900000}});
    expect(JSON.stringify(result)).not.toMatch(/cus_simulated|clock_simulated|binding-1/);
  });
  it('publishes unavailable metadata for a marked source with lost evidence',()=>{
    const c=clock(),access=deriveAccessItem('adult',NOW,undefined,[],{subscription:c.subscription,testClockObserved:true,billingStage:'dev'});
    expect(accessSummary(access,{activeTrees:0,visibleBranchesByTree:{}})).toMatchObject({effectivePlanKey:'free',simulation:{mode:'unavailable',frozenAt:null,evidenceValidUntil:null}});
  });
  it('does not expose a simulation in PROD or an ordinary response',()=>{
    const c=clock();
    const prod=deriveAccessItem('adult',NOW,undefined,[],{subscription:c.subscription,billingStage:'prod'});
    const {testClock:_ignored,...subscription}=c.subscription;
    const normal=deriveAccessItem('adult',NOW,undefined,[],{subscription,billingStage:'dev'});
    for(const a of [prod,normal])expect(accessSummary(a,{activeTrees:0,visibleBranchesByTree:{}})).not.toHaveProperty('simulation');
  });
  it('uses the same protected financial clock for the subscription summary',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());const state=await f.repository.load('adult'),c=clock();
    c.reference.customerId=state.customerId!;c.mirror.customerId=state.customerId!;c.mirror.providerReadyEvidence.customerId=state.customerId!;
    f.repository.states.set('adult',{...state,testClock:c.reference});f.repository.testClocks.set('adult',c.mirror);
    const service=new BillingService({...f,config,purchasesEnabled:async()=>false});
    expect(await service.summary('adult')).toHaveProperty('simulation',{stage:'dev',mode:'ready',frozenAt:NOW+DAY,clockRevision:2,observedAt:NOW,evidenceValidUntil:NOW+900000});
  });
});
