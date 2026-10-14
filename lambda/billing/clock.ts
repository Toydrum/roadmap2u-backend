import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

export const TEST_CLOCK_SK = 'BILLING#TEST_CLOCK' as const;
/** A physical publisher must refresh ready evidence within its bounded QA window. */
export const TEST_CLOCK_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
export interface BillingClockReference {
  readonly ownerSub: string;
  readonly customerId: string;
  readonly testClockId: string;
  readonly bindingId: string;
  readonly stage: string;
  readonly stripeAccountId: string;
  readonly syntheticFixture: string;
  readonly clockRevision: number;
  readonly frozenTimeSeconds: number;
}
export interface BillingTestClock extends BillingClockReference {
  readonly pk: string;
  readonly sk: typeof TEST_CLOCK_SK;
  readonly entityType: 'BillingTestClock';
  readonly liveMode: false;
  readonly providerReadyEvidence: {
    readonly status: 'ready';
    readonly customerId: string;
    readonly testClockId: string;
    readonly stripeAccountId: string;
    readonly liveMode: false;
    readonly frozenTimeSeconds: number;
    readonly observedAt: number;
  };
}
export type FinancialClock =
  | { readonly mode: 'real'; readonly now: number }
  | { readonly mode: 'simulation'; readonly now: number; readonly evidenceValidUntil: number; readonly reference: BillingClockReference }
  | { readonly mode: 'blocked'; readonly reference: BillingClockReference };
interface ClockContext {
  readonly ownerSub: string;
  readonly customerId: string;
  readonly stage: string;
  readonly accountId: string;
  readonly liveMode: boolean;
  readonly now: number;
  readonly reference?: unknown;
  /** Present only after an actual provider Customer read; null means no clock. */
  readonly providerTestClockId?: string | null;
}
const stable = ['ownerSub','customerId','testClockId','bindingId','stage','stripeAccountId','syntheticFixture'] as const;
export const TEST_CLOCK_ATTRIBUTES = ['pk','sk','entityType', ...stable, 'liveMode','clockRevision','frozenTimeSeconds','providerReadyEvidence'] as const;
function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function time(x: unknown): x is number { return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0; }
function reference(x: unknown): x is BillingClockReference {
  return record(x) && stable.every(k=> typeof x[k] === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(x[k] as string))
    && time(x['clockRevision']) && x['clockRevision'] > 0 && x['clockRevision'] < Number.MAX_SAFE_INTEGER
    && time(x['frozenTimeSeconds']) && x['frozenTimeSeconds'] > 0
    && Number.isSafeInteger(x['frozenTimeSeconds'] * 1000)
    && Number.isFinite(new Date(x['frozenTimeSeconds'] * 1000).getTime());
}
function mark(m: BillingClockReference): BillingClockReference {
  return { ownerSub:m.ownerSub,customerId:m.customerId,testClockId:m.testClockId,bindingId:m.bindingId,
    stage:m.stage,stripeAccountId:m.stripeAccountId,syntheticFixture:m.syntheticFixture,
    clockRevision:m.clockRevision,frozenTimeSeconds:m.frozenTimeSeconds };
}
/** Only an already bound synthetic source can request a protected mirror read. */
export function canReadTestClock(c: Omit<ClockContext, 'now' | 'providerTestClockId'>): boolean {
  const r = c.reference;
  return ['dev','test'].includes(c.stage) && !c.liveMode && reference(r)
    && r.ownerSub === c.ownerSub && r.customerId === c.customerId && r.stage === c.stage
    && r.stripeAccountId === c.accountId && r.customerId.startsWith('cus_') && r.testClockId.startsWith('clock_')
    && r.syntheticFixture.startsWith(`stripe_clock_${c.stage}_`);
}
/** No secrets, provider requests, global clock overrides or client-controlled time. */
export function resolveFinancialClock(c: ClockContext, mirror: unknown): FinancialClock {
  if (c.reference === undefined && !mirror && (c.providerTestClockId === undefined || c.providerTestClockId === null)) return { mode:'real',now:c.now };
  const retained = reference(c.reference) ? mark(c.reference) : reference(mirror) ? mark(mirror) : {
    ownerSub:c.ownerSub,customerId:c.customerId,testClockId:c.providerTestClockId ?? 'unverified',bindingId:'unbound',
    stage:c.stage,stripeAccountId:c.accountId,syntheticFixture:'unverified',clockRevision:0,frozenTimeSeconds:0,
  };
  const blocked: FinancialClock = {mode:'blocked',reference:retained};
  if (!['dev','test'].includes(c.stage) || c.liveMode || !time(c.now) || !reference(mirror) || !record(mirror)) return blocked;
  if (mirror['pk'] !== `USER#${c.ownerSub}` || mirror['sk'] !== TEST_CLOCK_SK || mirror['entityType'] !== 'BillingTestClock'
    || mirror.ownerSub !== c.ownerSub || mirror.customerId !== c.customerId || mirror.stage !== c.stage
    || mirror.stripeAccountId !== c.accountId || mirror['liveMode'] !== false
    || !mirror.customerId.startsWith('cus_') || !mirror.testClockId.startsWith('clock_')
    || !mirror.syntheticFixture.startsWith(`stripe_clock_${c.stage}_`)) return blocked;
  if (c.providerTestClockId !== undefined && c.providerTestClockId !== mirror.testClockId) return blocked;
  const prior = c.reference;
  if (prior !== undefined && (!reference(prior)
    || stable.some(k=>prior[k] !== mirror[k])
    || prior.clockRevision > mirror.clockRevision || prior.frozenTimeSeconds > mirror.frozenTimeSeconds
    || (prior.clockRevision === mirror.clockRevision && prior.frozenTimeSeconds !== mirror.frozenTimeSeconds))) return blocked;
  const e = mirror['providerReadyEvidence'];
  if (!record(e) || e['status'] !== 'ready' || e['liveMode'] !== false
    || e['customerId'] !== mirror.customerId || e['testClockId'] !== mirror.testClockId
    || e['stripeAccountId'] !== mirror.stripeAccountId || e['frozenTimeSeconds'] !== mirror.frozenTimeSeconds
    || !time(e['observedAt']) || e['observedAt'] > c.now || c.now-e['observedAt'] >= TEST_CLOCK_EVIDENCE_MAX_AGE_MS) return blocked;
  return {mode:'simulation',now:mirror.frozenTimeSeconds*1000,evidenceValidUntil:e['observedAt']+TEST_CLOCK_EVIDENCE_MAX_AGE_MS,reference:mark(mirror)};
}
/** Fence the exact observed mirror, including absence, in the caller's transaction. */
export function testClockGuard(tableName: string, ownerSub: string, mirror: unknown): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const base = {TableName:tableName,Key:{pk:`USER#${ownerSub}`,sk:TEST_CLOCK_SK}};
  if (!record(mirror)) return {ConditionCheck:{...base,ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}};
  const names: Record<string,string> = {}, values: Record<string,unknown> = {};
  const conditions = TEST_CLOCK_ATTRIBUTES.map(k=>{
    names[`#${k}`]=k;
    if (mirror[k] === undefined) return `attribute_not_exists(#${k})`;
    values[`:${k}`]=mirror[k]; return `#${k} = :${k}`;
  });
  return {ConditionCheck:{...base,ConditionExpression:conditions.join(' AND '),ExpressionAttributeNames:names,
    ...(Object.keys(values).length ? {ExpressionAttributeValues:values} : {})}};
}
