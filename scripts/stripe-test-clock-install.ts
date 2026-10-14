import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { prepareClockInstall, type ClockPublisherInput, type PreparedClockEvidence } from './stripe-test-clock-evidence';
import { initialState, type BillingState } from '../lambda/billing/model';
import { CommercialFlagsResolver, COMMERCIAL_FLAGS_ATTRIBUTES } from '../lambda/commercial/flags';
import { restoreExclusionKey } from '../lambda/privacy/retention';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

export interface ClockStorageScope {
  stage: string; awsAccountId: string; region: string; appTableArn: string; privacyTableName: string; privacyTableArn: string;
}
export interface ClockInstallSnapshot {
  ownerSub: string; stage: string; appTableName: string; privacyTableName: string;
  startedAt: number; completedAt: number; consistentReads: boolean; financialPartitionComplete: boolean;
  identity: {ownerSub: string; enabled: boolean}; profile: Record<string,unknown> | null;
  financialRows: readonly Record<string,unknown>[]; mirror: unknown; customerMapping: unknown; subscriptionSource: unknown;
  closure: unknown; restoreExclusion: unknown; flags: unknown;
}
export interface ClockInstallRequest {
  clock: ClockPublisherInput; storage: ClockStorageScope; snapshot: ClockInstallSnapshot; operationId: string;
}
export interface PreparedClockInstall {
  evidence: PreparedClockEvidence; state: BillingState; transaction: TransactWriteCommandInput;
  physicalExecutionAllowed: false;
}
type Tx = NonNullable<TransactWriteCommandInput['TransactItems']>;
const financial = {retentionScope:'commercial',retentionPolicyVersion:'financial-v1-draft',retentionStatus:'pending_policy_approval'};
const absent = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`CLOCK_INSTALL_${reason}`); }
function record(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function flagsCondition(table: string, flags: Record<string,unknown>): Tx[number] {
  const names: Record<string,string> = {}, values: Record<string,unknown> = {};
  const conditions=COMMERCIAL_FLAGS_ATTRIBUTES.map(key=>{
    names[`#flag_${key}`]=key;
    if (!Object.hasOwn(flags,key)) return `attribute_not_exists(#flag_${key})`;
    values[`:flag_${key}`]=flags[key];return `#flag_${key} = :flag_${key}`;
  });
  return {ConditionCheck:{TableName:table,Key:{pk:'COMMERCIAL#CONFIG',sk:'FLAGS'},ConditionExpression:conditions.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values}};
}
/** Request data only; caller identity, deployed tables and send/readback remain external. */
export async function prepareClockInstallTransaction(request: ClockInstallRequest): Promise<PreparedClockInstall> {
  // Capture before the flags parser yields; an operator journal can hash these
  // exact bytes without a later caller mutation changing the planned scope.
  const {clock,storage,snapshot:s,operationId}=structuredClone(request);
  const evidence=prepareClockInstall(clock),owner=clock.ownerSub,table=clock.scope.tableName,now=clock.realNow;
  requireCondition(typeof operationId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(operationId),'OPERATION_ID_REQUIRED');
  requireCondition(storage.stage === clock.scope.stage && storage.awsAccountId === '765932874577' && storage.region === 'us-east-1','STORAGE_SCOPE_MISMATCH');
  requireCondition(typeof storage.privacyTableName === 'string' && /^[A-Za-z0-9_.-]{3,255}$/.test(storage.privacyTableName) && storage.privacyTableName !== table,'INDEPENDENT_PRIVACY_TABLE_REQUIRED');
  // Match the canonical CDK names, not merely mutually consistent caller data.
  requireCondition(table === `roadmap-${clock.scope.stage}` && storage.privacyTableName === `roadmap-privacy-${clock.scope.stage}`,'CANONICAL_STAGE_TABLES_REQUIRED');
  const arnPrefix=`arn:aws:dynamodb:${storage.region}:${storage.awsAccountId}:table/`;
  requireCondition(storage.appTableArn === arnPrefix+table && storage.privacyTableArn === arnPrefix+storage.privacyTableName,'TABLE_ARN_MISMATCH');
  requireCondition(s.ownerSub === owner && s.stage === clock.scope.stage && s.appTableName === table && s.privacyTableName === storage.privacyTableName,'SNAPSHOT_SCOPE_MISMATCH');
  requireCondition(s.consistentReads === true && s.financialPartitionComplete === true && timestamp(s.startedAt) && timestamp(s.completedAt)
    && s.startedAt <= s.completedAt && s.completedAt <= now && now-s.startedAt < TEST_CLOCK_EVIDENCE_MAX_AGE_MS,'COMPLETE_CURRENT_SNAPSHOT_REQUIRED');
  requireCondition(s.identity.ownerSub === owner && s.identity.enabled === false,'DISABLED_FIXTURE_IDENTITY_REQUIRED');
  requireCondition(record(s.profile) && s.profile.pk === `USER#${owner}` && s.profile.sk === 'PROFILE' && s.profile.userId === owner && s.profile.accountType === 'adult'
    && (!Object.hasOwn(s.profile,'status') || s.profile.status === 'active') && !Object.hasOwn(s.profile,'privacyMode'),'EXISTING_ACTIVE_ADULT_REQUIRED');
  requireCondition(Array.isArray(s.financialRows) && s.financialRows.length === 0 && s.mirror === null && s.customerMapping === null
    && s.subscriptionSource === null && s.closure === null && s.restoreExclusion === null,'INITIAL_EMPTY_FIXTURE_REQUIRED');
  const flags=await new CommercialFlagsResolver({readItem:async()=>s.flags,now:()=>now,emitMetric:()=>{}}).resolve();
  requireCondition(flags.status === 'available' && flags.freshness === 'fresh' && flags.flags.schemaVersion === 2 && flags.flags.paymentScope === 'none'
    && flags.flags.premiumPaymentsEnabled === false && flags.flags.individualCheckoutEnabled === false && flags.flags.checkoutEnabled === false,'CLOSED_VERSIONED_FLAGS_REQUIRED');
  requireCondition(record(s.flags),'RAW_FLAGS_REQUIRED');
  const reference=evidence.reference;
  const state: BillingState={...initialState(owner),revision:1,customerId:reference.customerId,testClock:reference,updatedAt:now,nextReconcileAt:now};
  const stateItem={...state,pk:`BILLING#${owner}`,sk:'STATE',...financial,gsi1pk:`BILLING#OWNERS#${clock.scope.stage}`,gsi1sk:`NEXT#${String(now).padStart(14,'0')}#${owner}`};
  const mirrorGuard=evidence.mirrorCondition.ConditionCheck;
  requireCondition(mirrorGuard && mirrorGuard.TableName === table && mirrorGuard.Key?.pk === `USER#${owner}` && mirrorGuard.Key.sk === 'BILLING#TEST_CLOCK','MIRROR_GUARD_MISMATCH');
  const {Key:_mirrorKey,...mirrorCondition}=mirrorGuard;
  const items: Tx=[
    {Put:{TableName:table,Item:stateItem,ConditionExpression:absent}},
    {Put:{...mirrorCondition,Item:evidence.mirror}},
    {Put:{TableName:table,Item:{pk:`STRIPE#${reference.stripeAccountId}#${reference.stage}#test#CUSTOMER#${reference.customerId}`,sk:'OWNER',...financial,
      ownerSub:owner,accountId:reference.stripeAccountId,stage:reference.stage,liveMode:false},ConditionExpression:absent}},
    {Put:{TableName:table,Item:{pk:`BILLING#${owner}`,sk:`AUDIT#${String(now).padStart(14,'0')}#1`,...financial,
      action:'test_clock_binding_installed',revision:1,occurredAt:now},ConditionExpression:absent}},
    {ConditionCheck:{TableName:table,Key:{pk:`USER#${owner}`,sk:'PROFILE'},
      ConditionExpression:'attribute_exists(pk) AND attribute_exists(sk) AND userId = :owner AND accountType = :adult AND attribute_not_exists(privacyMode) AND (attribute_not_exists(#status) OR #status = :active)',
      ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':owner':owner,':adult':'adult',':active':'active'}}},
    {ConditionCheck:{TableName:table,Key:{pk:`ACCOUNT_CLOSURE#${owner}`,sk:'STATE'},ConditionExpression:absent}},
    {ConditionCheck:{TableName:storage.privacyTableName,Key:restoreExclusionKey(owner),ConditionExpression:absent}},
    {ConditionCheck:{TableName:table,Key:{pk:`USER#${owner}`,sk:'SUBSCRIPTION#INDIVIDUAL'},ConditionExpression:absent}},
    flagsCondition(table,s.flags),
  ];
  const token=createHash('sha256').update(JSON.stringify({operationId,app:storage.appTableArn,privacy:storage.privacyTableArn,stage:reference.stage,
    account:reference.stripeAccountId,owner,customer:reference.customerId,clock:reference.testClockId,binding:reference.bindingId})).digest('hex').slice(0,36);
  return {evidence:structuredClone(evidence),state:structuredClone(state),transaction:structuredClone({TransactItems:items,ClientRequestToken:token}),physicalExecutionAllowed:false};
}
