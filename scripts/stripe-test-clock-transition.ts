import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareClockAdvance, prepareClockReady, type ClockPublisherInput, type PreparedClockEvidence, type PublisherMirror } from './stripe-test-clock-evidence';
import { prepareClockSafetyConditions, CLOCK_FINANCIAL_RETENTION, type ClockInstallSnapshot, type ClockStorageScope } from './stripe-test-clock-install';
import { canReadTestClock, type BillingClockReference } from '../lambda/billing/clock';

export type ClockTransitionSnapshot = Omit<ClockInstallSnapshot,'financialRows'|'financialPartitionComplete'|'subscriptionSource'|'customerMapping'> & {
  financialState: Record<string,unknown> | null; customerMapping: Record<string,unknown> | null;
};
export interface ClockTransitionRequest {
  clock: ClockPublisherInput; storage: ClockStorageScope; snapshot: ClockTransitionSnapshot;
  operationId: string; kind: 'advance_fence' | 'ready' | 'refresh'; targetFrozenTimeSeconds?: number;
}
export interface PreparedClockTransition {
  evidence: PreparedClockEvidence; transaction: TransactWriteCommandInput; physicalExecutionAllowed: false;
}
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`CLOCK_TRANSITION_${reason}`); }
function record(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const stable=['ownerSub','customerId','testClockId','bindingId','stage','stripeAccountId','syntheticFixture'] as const;
const openStates=['none','checkout_pending','active','cancel_at_period_end','past_due','expired','payment_review'];
/** Pure request preparation; physical transport and readback need their own approved window. */
export async function prepareClockTransitionTransaction(request: ClockTransitionRequest): Promise<PreparedClockTransition> {
  const {clock,storage,snapshot:s,operationId,kind,targetFrozenTimeSeconds}=structuredClone(request);
  requireCondition(typeof operationId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(operationId),'OPERATION_ID_REQUIRED');
  requireCondition(['advance_fence','ready','refresh'].includes(kind),'UNKNOWN_PHASE');
  let evidence: PreparedClockEvidence;
  if (kind === 'advance_fence') {
    requireCondition(typeof targetFrozenTimeSeconds === 'number','ADVANCE_TARGET_REQUIRED');
    evidence=prepareClockAdvance({...clock,operationId,targetFrozenTimeSeconds});
  } else {
    requireCondition(targetFrozenTimeSeconds === undefined,'TARGET_ONLY_ALLOWED_FOR_ADVANCE');
    if (kind === 'ready') {
      const prior=clock.priorMirror;
      requireCondition(record(prior) && record(prior.providerReadyEvidence) && prior.providerReadyEvidence.status === 'advancing'
        && prior.providerReadyEvidence.operationId === operationId,'PENDING_OPERATION_MISMATCH');
    }
    evidence=prepareClockReady(clock);
    requireCondition(evidence.kind === kind,'PHASE_MISMATCH');
  }
  requireCondition(isDeepStrictEqual(s.mirror,clock.priorMirror),'MIRROR_SNAPSHOT_MISMATCH');
  const prior=clock.priorMirror as PublisherMirror,r=evidence.reference,owner=clock.ownerSub,table=clock.scope.tableName,now=clock.realNow;
  const state=s.financialState;
  requireCondition(record(state) && state.pk === `BILLING#${owner}` && state.sk === 'STATE' && state.ownerSub === owner && state.customerId === r.customerId
    && Number.isSafeInteger(state.revision) && (state.revision as number) > 0 && openStates.includes(state.state as string)
    && !Object.hasOwn(state,'closingId') && !Object.hasOwn(state,'closedAt'),'BOUND_OPEN_STATE_REQUIRED');
  const stateReference=state.testClock as BillingClockReference;
  requireCondition(canReadTestClock({ownerSub:owner,customerId:r.customerId,stage:r.stage,accountId:r.stripeAccountId,liveMode:false,reference:stateReference})
    && stable.every(key=>stateReference[key] === r[key]) && stateReference.clockRevision <= prior.clockRevision
    && stateReference.frozenTimeSeconds <= prior.frozenTimeSeconds
    && (stateReference.clockRevision !== prior.clockRevision || stateReference.frozenTimeSeconds === prior.frozenTimeSeconds),'STATE_REFERENCE_MISMATCH');
  requireCondition(!Object.hasOwn(state,'leaseUntil') || (typeof state.leaseUntil === 'number' && Number.isSafeInteger(state.leaseUntil) && state.leaseUntil >= 0 && state.leaseUntil <= now),'REAL_LEASE_ACTIVE_OR_INVALID');
  const mappingKey={pk:`STRIPE#${r.stripeAccountId}#${r.stage}#test#CUSTOMER#${r.customerId}`,sk:'OWNER'};
  const mapping=s.customerMapping;
  requireCondition(record(mapping) && mapping.pk === mappingKey.pk && mapping.sk === mappingKey.sk && mapping.ownerSub === owner
    && mapping.accountId === r.stripeAccountId && mapping.stage === r.stage && mapping.liveMode === false,'SCOPED_MAPPING_REQUIRED');
  const safety=await prepareClockSafetyConditions(clock,storage,s);
  const mirrorGuard=evidence.mirrorCondition.ConditionCheck;
  requireCondition(mirrorGuard && mirrorGuard.TableName === table && mirrorGuard.Key?.pk === `USER#${owner}` && mirrorGuard.Key.sk === 'BILLING#TEST_CLOCK','MIRROR_GUARD_MISMATCH');
  const {Key:_mirrorKey,...mirrorCondition}=mirrorGuard;
  const items: NonNullable<TransactWriteCommandInput['TransactItems']>=[
    {Put:{...mirrorCondition,Item:evidence.mirror}},
    {Put:{TableName:table,Item:{pk:`BILLING#${owner}`,sk:`AUDIT#CLOCK#${r.bindingId}#${operationId}#${kind}`,...CLOCK_FINANCIAL_RETENTION,
      action:`test_clock.${kind}`,operationId,bindingId:r.bindingId,clockRevision:r.clockRevision,stateRevision:state.revision,occurredAt:now},
      ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}},
    {ConditionCheck:{TableName:table,Key:{pk:`BILLING#${owner}`,sk:'STATE'},
      ConditionExpression:'attribute_exists(pk) AND attribute_exists(sk) AND #revision = :revision AND ownerSub = :owner AND customerId = :customer AND testClock = :reference AND #state = :state AND attribute_not_exists(closingId) AND attribute_not_exists(closedAt) AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)',
      ExpressionAttributeNames:{'#revision':'revision','#state':'state'},ExpressionAttributeValues:{':revision':state.revision,':owner':owner,':customer':r.customerId,':reference':stateReference,':state':state.state,':now':now}}},
    {ConditionCheck:{TableName:table,Key:mappingKey,ConditionExpression:'attribute_exists(pk) AND attribute_exists(sk) AND #owner = :owner AND #account = :account AND #stage = :stage AND #live = :live',
      ExpressionAttributeNames:{'#owner':'ownerSub','#account':'accountId','#stage':'stage','#live':'liveMode'},ExpressionAttributeValues:{':owner':owner,':account':r.stripeAccountId,':stage':r.stage,':live':false}}},
    ...safety,
  ];
  const token=createHash('sha256').update(JSON.stringify({operationId,kind,app:storage.appTableArn,privacy:storage.privacyTableArn,stage:r.stage,
    account:r.stripeAccountId,owner,customer:r.customerId,clock:r.testClockId,binding:r.bindingId})).digest('hex').slice(0,36);
  return {evidence:structuredClone(evidence),transaction:structuredClone({TransactItems:items,ClientRequestToken:token}),physicalExecutionAllowed:false};
}
