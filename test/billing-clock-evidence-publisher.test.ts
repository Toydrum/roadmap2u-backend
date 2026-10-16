import { describe, expect, it } from 'vitest';
import { canReadTestClock, resolveFinancialClock, TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';
import { prepareClockInstall, prepareClockReady, prepareClockAdvance, type ClockPublisherInput, type ClockFixture } from '../scripts/stripe-test-clock-evidence';

const NOW = Date.UTC(2026,9,13,12), TIME = NOW / 1000;
const fixture = (stage = 'dev', suffix = 'one'): ClockFixture => ({ownerSub:`owner_${suffix}`,customerId:`cus_${suffix}`,testClockId:`clock_${suffix}`,bindingId:`binding_${suffix}`,stage,stripeAccountId:'acct_sandbox',syntheticFixture:`stripe_clock_${stage}_${suffix}`});
function input(stage = 'dev'): ClockPublisherInput {
  const f = fixture(stage);
  return {scope:{tableName:`Roadmap-${stage}-AppData`,stage,stripeAccountId:f.stripeAccountId,liveMode:false,fixtures:[f]},ownerSub:f.ownerSub,priorMirror:null,realNow:NOW,
    observation:{stripeAccountId:f.stripeAccountId,stage,liveMode:false,startedAt:NOW-100,completedAt:NOW-50,
      customer:{id:f.customerId,object:'customer',livemode:false,test_clock:f.testClockId,metadata:{owner:f.ownerSub,stage,integration:'roadmap2u_individual_v1'}},
      clock:{id:f.testClockId,object:'test_helpers.test_clock',livemode:false,status:'ready',frozen_time:TIME,deletes_after:TIME+7*86400}}};
}
function context(i: ClockPublisherInput, reference: unknown) {
  return {ownerSub:i.ownerSub,customerId:i.observation.customer.id,stage:i.scope.stage,accountId:i.scope.stripeAccountId,liveMode:i.scope.liveMode,now:i.realNow,reference,providerTestClockId:i.observation.clock.id};
}
function installed(stage = 'dev') { const i = input(stage); const p = prepareClockInstall(i)!; expect(p).toBeDefined(); return {i,p}; }

describe('trusted clock evidence publisher core', () => {
  it.each(['dev','test'])('prepares %s evidence accepted by the actual reader without changing inputs', stage => {
    const i = input(stage), before = structuredClone(i), p = prepareClockInstall(i);
    expect(p).toEqual(expect.objectContaining({kind:'install',requiresAtomicReferenceInstall:true}));
    expect(canReadTestClock(context(i,p?.reference))).toBe(true);
    expect(resolveFinancialClock(context(i,p?.reference),p?.mirror)).toEqual(expect.objectContaining({mode:'simulation',now:NOW}));
    expect(p?.mirror.providerReadyEvidence.observedAt).toBe(i.observation.startedAt);
    expect(p?.mirrorCondition).toMatchObject({ConditionCheck:{Key:{pk:`USER#${i.ownerSub}`,sk:'BILLING#TEST_CLOCK'},ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}});
    expect(i).toEqual(before);
  });
  it.each(['prod','unknown'])('refuses %s scope', stage => {const i=input(stage);expect(()=>prepareClockInstall(i)).toThrow();});
  it('refuses live mode',()=>{const i=input();i.scope.liveMode=true;expect(()=>prepareClockInstall(i)).toThrow();});
  it('requires an actual table-name string rather than a coerced missing value',()=>{const i=input();i.scope.tableName=undefined as unknown as string;expect(()=>prepareClockInstall(i)).toThrow();});
  it('does not reuse the protected historical monthly owner',()=>{const i=input();i.ownerSub='e4282408-f0f1-70b2-b5ef-b9ddb80599e7';i.scope.fixtures=[{...i.scope.fixtures[0]!,ownerSub:i.ownerSub}];i.observation.customer.metadata.owner=i.ownerSub;expect(()=>prepareClockInstall(i)).toThrow();});
  it('bounds the exact fixture roster to two owners',()=>{const i=input();i.scope.fixtures=[fixture(),fixture('dev','two'),fixture('dev','three')];expect(()=>prepareClockInstall(i)).toThrow();});
  it.each(['ownerSub','customerId','testClockId','bindingId'] as const)('refuses a duplicate %s in the roster', field=>{const i=input(), other={...fixture('dev','two'),[field]:i.scope.fixtures[0]![field]};i.scope.fixtures=[...i.scope.fixtures,other];expect(()=>prepareClockInstall(i)).toThrow();});
  it('accepts the two-fixture roster without granting access or publishing either',()=>{const i=input();i.scope.fixtures=[fixture(),fixture('dev','two')];expect(prepareClockInstall(i)?.kind).toBe('install');});
  it('cannot select an owner outside the exact roster',()=>{const i=input();i.ownerSub='unlisted';expect(()=>prepareClockInstall(i)).toThrow();});
  it('cannot overwrite an existing mirror while installing',()=>{const {i,p}=installed();i.priorMirror=p.mirror;expect(()=>prepareClockInstall(i)).toThrow();});
  const invalidObservations: [string,(i:ClockPublisherInput)=>void][] = [
    ['foreign account',i=>{i.observation.stripeAccountId='acct_foreign';}],
    ['foreign stage',i=>{i.observation.stage='test';}],
    ['live read context',i=>{i.observation.liveMode=true;}],
    ['foreign Customer',i=>{i.observation.customer.id='cus_foreign';}],
    ['deleted Customer',i=>{i.observation.customer.deleted=true;}],
    ['live Customer',i=>{i.observation.customer.livemode=true;}],
    ['unbound Customer',i=>{i.observation.customer.test_clock=null;}],
    ['foreign Customer owner',i=>{i.observation.customer.metadata.owner='foreign';}],
    ['foreign integration',i=>{i.observation.customer.metadata.integration='other';}],
    ['foreign clock',i=>{i.observation.clock.id='clock_foreign';}],
    ['live clock',i=>{i.observation.clock.livemode=true;}],
    ['clock still advancing',i=>{i.observation.clock.status='advancing';}],
    ['failed clock',i=>{i.observation.clock.status='internal_failure';}],
    ['expired physical clock',i=>{i.observation.clock.deletes_after=TIME;}],
    ['stale observations',i=>{i.observation.startedAt=NOW-TEST_CLOCK_EVIDENCE_MAX_AGE_MS;}],
    ['future observations',i=>{i.observation.startedAt=NOW+1;i.observation.completedAt=NOW+2;}],
    ['reversed observation times',i=>{i.observation.completedAt=i.observation.startedAt-1;}],
    ['invalid frozen seconds',i=>{i.observation.clock.frozen_time=0;}],
    ['fractional frozen seconds',i=>{i.observation.clock.frozen_time=TIME+0.5;}],
    ['overflowing milliseconds',i=>{i.observation.clock.frozen_time=Number.MAX_SAFE_INTEGER;}],
  ];
  it.each(invalidObservations)('refuses %s without producing an install plan',(_name,change)=>{const i=input();change(i);expect(()=>prepareClockInstall(i)).toThrow();});
  it('refreshes expired ready evidence at the same financial time with a newer revision',()=>{
    const {i,p}=installed();i.priorMirror=p.mirror;i.realNow=NOW+TEST_CLOCK_EVIDENCE_MAX_AGE_MS+500;i.observation.startedAt=i.realNow-100;i.observation.completedAt=i.realNow-50;
    expect(resolveFinancialClock(context(i,p.reference),p.mirror).mode).toBe('blocked');
    const ready=prepareClockReady(i)!;expect(ready.kind).toBe('refresh');expect(ready.reference.clockRevision).toBe(2);expect(ready.reference.frozenTimeSeconds).toBe(TIME);
    expect(resolveFinancialClock(context(i,p.reference),ready.mirror).mode).toBe('simulation');expect(ready.requiresAtomicReferenceInstall).toBe(false);
  });
  it('cannot silently refresh a changed provider time without an advance fence',()=>{const {i,p}=installed();i.priorMirror=p.mirror;i.observation.clock.frozen_time=TIME+86400;expect(()=>prepareClockReady(i)).toThrow();});
  it.each([TIME,TIME-1,TIME+0.5])('refuses invalid/non-forward advance target %s',target=>{const {i,p}=installed();i.priorMirror=p.mirror;expect(()=>prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:target})).toThrow();});
  it('requires a real operation ID before preparing an unusable advance fence',()=>{const {i,p}=installed();i.priorMirror=p.mirror;expect(()=>prepareClockAdvance({...i,operationId:undefined as unknown as string,targetFrozenTimeSeconds:TIME+86400})).toThrow();});
  it('captures the observed mirror by value so caller mutations cannot weaken the condition',()=>{
    const {i,p}=installed();i.priorMirror=p.mirror;const observed=p.mirror.providerReadyEvidence.observedAt;
    const pending=prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400});
    Object.assign(p.mirror.providerReadyEvidence,{observedAt:NOW+999});
    expect(pending.mirrorCondition).toMatchObject({ConditionCheck:{ExpressionAttributeValues:{':providerReadyEvidence':{observedAt:observed}}}});
  });
  it('invalidates before advance and publishes ready only after observing the exact target',()=>{
    const {i,p}=installed();i.priorMirror=p.mirror;
    const pending=prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400})!;
    expect(pending.kind).toBe('advance_fence');expect(resolveFinancialClock(context(i,p.reference),pending.mirror).mode).toBe('blocked');
    expect(pending.reference.clockRevision).toBe(1);expect(pending.mirrorCondition).toMatchObject({ConditionCheck:{ExpressionAttributeValues:{':providerReadyEvidence':p.mirror.providerReadyEvidence}}});
    i.priorMirror=pending.mirror;i.realNow=NOW+100;i.observation.startedAt=NOW+1;i.observation.completedAt=NOW+99;i.observation.clock.frozen_time=TIME+86400;
    const ready=prepareClockReady(i)!;expect(ready.kind).toBe('ready');expect(ready.reference.clockRevision).toBe(2);
    expect(resolveFinancialClock(context(i,p.reference),ready.mirror)).toEqual(expect.objectContaining({mode:'simulation',now:NOW+86400000}));
    expect(ready.mirrorCondition).toMatchObject({ConditionCheck:{ExpressionAttributeValues:{':providerReadyEvidence':pending.mirror.providerReadyEvidence}}});
  });
  it('rejects observations from before the invalidation even when they contain the target',()=>{const {i,p}=installed();i.priorMirror=p.mirror;const pending=prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400})!;i.priorMirror=pending.mirror;i.observation.clock.frozen_time=TIME+86400;expect(()=>prepareClockReady(i)).toThrow();});
  it('rejects an unexpected ready target',()=>{const {i,p}=installed();i.priorMirror=p.mirror;const pending=prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400})!;i.priorMirror=pending.mirror;i.realNow=NOW+100;i.observation.startedAt=NOW+1;i.observation.completedAt=NOW+99;i.observation.clock.frozen_time=TIME+2*86400;expect(()=>prepareClockReady(i)).toThrow();});
  it('cannot invalidate again while a previous advance is pending',()=>{const {i,p}=installed();i.priorMirror=p.mirror;const pending=prepareClockAdvance({...i,operationId:'advance_one',targetFrozenTimeSeconds:TIME+86400})!;i.priorMirror=pending.mirror;expect(()=>prepareClockAdvance({...i,operationId:'advance_two',targetFrozenTimeSeconds:TIME+2*86400})).toThrow();});
  it.each(['ownerSub','customerId','testClockId'] as const)('rejects crossed prior mirror %s',field=>{const {i,p}=installed();i.priorMirror={...p.mirror,[field]:'crossed'};expect(()=>prepareClockReady(i)).toThrow();});
});
