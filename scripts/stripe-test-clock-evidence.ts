import { canReadTestClock, resolveFinancialClock, testClockGuard, TEST_CLOCK_EVIDENCE_MAX_AGE_MS, type BillingClockReference, type BillingTestClock } from '../lambda/billing/clock';
import { INTEGRATION } from '../lambda/billing/model';

export type ClockFixture = Omit<BillingClockReference, 'clockRevision' | 'frozenTimeSeconds'>;
export interface ClockPublisherScope {
  tableName: string; stage: string; stripeAccountId: string; liveMode: boolean;
  fixtures: readonly ClockFixture[];
}
export interface ProviderClockObservation {
  stripeAccountId: string; stage: string; liveMode: boolean; startedAt: number; completedAt: number;
  customer: { id: string; object: string; livemode: boolean; test_clock: string | null; deleted?: boolean; metadata: Record<string,string> };
  clock: { id: string; object: string; livemode: boolean; status: string; frozen_time: number; deletes_after: number };
}
interface AdvancingEvidence {
  status: 'advancing'; customerId: string; testClockId: string; stripeAccountId: string; liveMode: false;
  frozenTimeSeconds: number; observedAt: number; operationId: string; targetFrozenTimeSeconds: number;
}
export type PublisherMirror = BillingTestClock | (Omit<BillingTestClock, 'providerReadyEvidence'> & {providerReadyEvidence: AdvancingEvidence});
export interface ClockPublisherInput {
  scope: ClockPublisherScope; ownerSub: string; priorMirror: unknown; observation: ProviderClockObservation; realNow: number;
}
export type ClockPublisherContext = Pick<ClockPublisherInput,'scope'|'ownerSub'|'realNow'>;
export interface PreparedClockEvidence {
  kind: 'install' | 'refresh' | 'advance_fence' | 'ready'; reference: BillingClockReference; mirror: PublisherMirror;
  mirrorCondition: ReturnType<typeof testClockGuard>; requiresAtomicReferenceInstall: boolean;
}
const PROTECTED_MONTHLY_OWNER = 'e4282408-f0f1-70b2-b5ef-b9ddb80599e7';
const bindingKeys = ['ownerSub','customerId','testClockId','bindingId','stage','stripeAccountId','syntheticFixture'] as const;
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`CLOCK_PUBLISHER_${reason}`); }
function record(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function realTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()); }
function reference(f: ClockFixture, revision: number, seconds: number): BillingClockReference {
  return {ownerSub:f.ownerSub,customerId:f.customerId,testClockId:f.testClockId,bindingId:f.bindingId,stage:f.stage,
    stripeAccountId:f.stripeAccountId,syntheticFixture:f.syntheticFixture,clockRevision:revision,frozenTimeSeconds:seconds};
}
function context(i: ClockPublisherContext, f: ClockFixture, r: BillingClockReference, now = i.realNow) {
  return {ownerSub:f.ownerSub,customerId:f.customerId,stage:i.scope.stage,accountId:i.scope.stripeAccountId,liveMode:i.scope.liveMode,
    reference:r,now,providerTestClockId:f.testClockId};
}
function checkedReference(i: ClockPublisherContext, f: ClockFixture, revision: number, seconds: number): BillingClockReference {
  const r = reference(f,revision,seconds);
  requireCondition(canReadTestClock(context(i,f,r)), 'INVALID_REFERENCE');
  return r;
}
function selectFixture(i: ClockPublisherContext): ClockFixture {
  const s = i.scope;
  requireCondition(['dev','test'].includes(s.stage) && s.liveMode === false && /^acct_[A-Za-z0-9_]+$/.test(s.stripeAccountId), 'SANDBOX_SCOPE_REQUIRED');
  requireCondition(realTimestamp(i.realNow) && typeof s.tableName === 'string' && /^[A-Za-z0-9_.-]{3,255}$/.test(s.tableName), 'INVALID_OPERATIONAL_CONTEXT');
  requireCondition(Array.isArray(s.fixtures) && s.fixtures.length > 0 && s.fixtures.length <= 2, 'FIXTURE_LIMIT');
  for (const f of s.fixtures) {
    requireCondition(f.ownerSub !== PROTECTED_MONTHLY_OWNER, 'HISTORICAL_OWNER_PROTECTED');
    checkedReference(i,f,1,1);
  }
  for (const key of ['ownerSub','customerId','testClockId','bindingId'] as const) requireCondition(new Set(s.fixtures.map(f=>f[key])).size === s.fixtures.length, 'DUPLICATE_BINDING');
  const f = s.fixtures.find(f=>f.ownerSub === i.ownerSub);
  requireCondition(f, 'OWNER_NOT_IN_SCOPE');
  return f;
}
/** Shared pre-read scope validation; callers receive a copy of the selected binding. */
export function selectClockPublisherFixture(i: ClockPublisherContext): ClockFixture { return structuredClone(selectFixture(i)); }
function validateObservation(i: ClockPublisherInput, f: ClockFixture): void {
  const o = i.observation;
  requireCondition(o.stripeAccountId === f.stripeAccountId && o.stage === f.stage && o.liveMode === false, 'OBSERVATION_SCOPE_MISMATCH');
  requireCondition(realTimestamp(o.startedAt) && realTimestamp(o.completedAt) && o.startedAt <= o.completedAt && o.completedAt <= i.realNow
    && i.realNow-o.startedAt < TEST_CLOCK_EVIDENCE_MAX_AGE_MS, 'OBSERVATION_TIME_INVALID');
  const c = o.customer;
  requireCondition(c.object === 'customer' && c.id === f.customerId && c.deleted !== true && c.livemode === false && c.test_clock === f.testClockId
    && c.metadata.owner === f.ownerSub && c.metadata.stage === f.stage && c.metadata.integration === INTEGRATION, 'CUSTOMER_MISMATCH');
  const clock = o.clock;
  requireCondition(clock.object === 'test_helpers.test_clock' && clock.id === f.testClockId && clock.livemode === false && clock.status === 'ready', 'CLOCK_NOT_READY_OR_MISMATCHED');
  checkedReference(i,f,1,clock.frozen_time);
  requireCondition(Number.isSafeInteger(clock.deletes_after) && realTimestamp(clock.deletes_after*1000) && clock.deletes_after*1000 > i.realNow, 'PHYSICAL_CLOCK_EXPIRED');
}
function priorMirror(i: ClockPublisherInput, f: ClockFixture): PublisherMirror {
  const m = i.priorMirror;
  requireCondition(record(m) && m.pk === `USER#${f.ownerSub}` && m.sk === 'BILLING#TEST_CLOCK' && m.entityType === 'BillingTestClock' && m.liveMode === false
    && bindingKeys.every(key=>m[key] === f[key]), 'PRIOR_MIRROR_MISMATCH');
  const r = checkedReference(i,f,m.clockRevision as number,m.frozenTimeSeconds as number);
  const e = m.providerReadyEvidence;
  requireCondition(record(e) && realTimestamp(e.observedAt) && e.observedAt <= i.realNow, 'PRIOR_EVIDENCE_INVALID');
  if (e.status === 'ready') {
    // Validate the stored shape at its original observation time. This permits
    // a publisher refresh after expiry; application readers still use realNow.
    requireCondition(resolveFinancialClock(context(i,f,r,e.observedAt),m).mode === 'simulation', 'PRIOR_READY_EVIDENCE_INVALID');
  } else {
    requireCondition(e.status === 'advancing' && e.customerId === f.customerId && e.testClockId === f.testClockId && e.stripeAccountId === f.stripeAccountId
      && e.liveMode === false && e.frozenTimeSeconds === r.frozenTimeSeconds && typeof e.operationId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(e.operationId), 'PRIOR_ADVANCE_INVALID');
    checkedReference(i,f,r.clockRevision,e.targetFrozenTimeSeconds as number);
    requireCondition((e.targetFrozenTimeSeconds as number) > r.frozenTimeSeconds, 'PRIOR_ADVANCE_TARGET_INVALID');
  }
  return m as unknown as PublisherMirror;
}
function readyMirror(r: BillingClockReference, observedAt: number): BillingTestClock {
  return {...r,pk:`USER#${r.ownerSub}`,sk:'BILLING#TEST_CLOCK',entityType:'BillingTestClock',liveMode:false,
    providerReadyEvidence:{status:'ready',customerId:r.customerId,testClockId:r.testClockId,stripeAccountId:r.stripeAccountId,liveMode:false,frozenTimeSeconds:r.frozenTimeSeconds,observedAt}};
}
function prepared(i: ClockPublisherInput, kind: PreparedClockEvidence['kind'], r: BillingClockReference, mirror: PublisherMirror): PreparedClockEvidence {
  return structuredClone({kind,reference:r,mirror,mirrorCondition:testClockGuard(i.scope.tableName,i.ownerSub,i.priorMirror),requiresAtomicReferenceInstall:kind === 'install'});
}
/** Pure evidence only. The future executor must install reference + mirror atomically. */
export function prepareClockInstall(i: ClockPublisherInput): PreparedClockEvidence {
  const f = selectFixture(i);
  requireCondition(i.priorMirror === null, 'INSTALL_REQUIRES_OBSERVED_ABSENCE');
  validateObservation(i,f);
  const r = checkedReference(i,f,1,i.observation.clock.frozen_time);
  return prepared(i,'install',r,readyMirror(r,i.observation.startedAt));
}
/** Refresh unchanged time, or publish the exact pending advance after fresh provider reads. */
export function prepareClockReady(i: ClockPublisherInput): PreparedClockEvidence {
  const f = selectFixture(i), prior = priorMirror(i,f);
  validateObservation(i,f);
  const evidence = prior.providerReadyEvidence;
  if (evidence.status === 'ready') {
    requireCondition(i.observation.clock.frozen_time === prior.frozenTimeSeconds && i.observation.startedAt >= evidence.observedAt, 'UNFENCED_TIME_CHANGE');
  } else {
    requireCondition(i.observation.clock.frozen_time === evidence.targetFrozenTimeSeconds && i.observation.startedAt > evidence.observedAt, 'ADVANCE_NOT_OBSERVED_AFTER_FENCE');
  }
  const r = checkedReference(i,f,prior.clockRevision+1,i.observation.clock.frozen_time);
  return prepared(i,evidence.status === 'ready' ? 'refresh' : 'ready',r,readyMirror(r,i.observation.startedAt));
}
/** Prepare an unusable mirror before the separately authorized provider advance. */
export function prepareClockAdvance(i: ClockPublisherInput & {operationId: string; targetFrozenTimeSeconds: number}): PreparedClockEvidence {
  const f = selectFixture(i), prior = priorMirror(i,f);
  validateObservation(i,f);
  requireCondition(prior.providerReadyEvidence.status === 'ready' && i.observation.clock.frozen_time === prior.frozenTimeSeconds
    && i.observation.startedAt >= prior.providerReadyEvidence.observedAt, 'ADVANCE_REQUIRES_CURRENT_READY');
  requireCondition(typeof i.operationId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(i.operationId), 'INVALID_ADVANCE_OPERATION');
  const r = checkedReference(i,f,prior.clockRevision,prior.frozenTimeSeconds);
  checkedReference(i,f,r.clockRevision,i.targetFrozenTimeSeconds);
  requireCondition(i.targetFrozenTimeSeconds > r.frozenTimeSeconds, 'ADVANCE_MUST_MOVE_FORWARD');
  const mirror: PublisherMirror = {...prior,providerReadyEvidence:{status:'advancing',customerId:f.customerId,testClockId:f.testClockId,
    stripeAccountId:f.stripeAccountId,liveMode:false,frozenTimeSeconds:r.frozenTimeSeconds,observedAt:i.realNow,
    operationId:i.operationId,targetFrozenTimeSeconds:i.targetFrozenTimeSeconds}};
  return prepared(i,'advance_fence',r,mirror);
}
