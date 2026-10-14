import { describe, expect, it } from 'vitest';
import { AccessResolver, deriveAccessItem } from '../lambda/commercial/access-resolver';
import type { GrantItem, SubscriptionSourceItem } from '../lambda/commercial/model';
import { PREPAYMENT_CATALOG } from '../lambda/commercial/catalog';
import { BillingProjector } from '../lambda/billing/projection';
import { fixture, config, invoice, subscription, request, NOW } from './support/billing-fixture';
import { resolveFinancialClock } from '../lambda/billing/clock';
import { BillingService } from '../lambda/billing/service';
import { FakeBillingProvider } from '../lambda/billing/fake-provider';
import { BillingEventWorker } from '../lambda/billing/worker';
import { BillingReconciler } from '../lambda/billing/reconciler';
import { STRIPE_API_VERSION } from '../lambda/billing/model';
import { validateSyncEntryShapes } from '../lambda/commercial/sync-validation';

const DAY = 86_400_000;
function mirror(time = NOW, revision = 1) {
  return { pk: 'USER#adult', sk: 'BILLING#TEST_CLOCK', entityType: 'BillingTestClock',
    ownerSub: 'adult', customerId: 'cus_simulated', testClockId: 'clock_simulated', bindingId: 'binding-1',
    stage: 'dev', stripeAccountId: config.accountId, liveMode: false, syntheticFixture: 'stripe_clock_dev_monthly',
    frozenTimeSeconds: time / 1000, clockRevision: revision,
    providerReadyEvidence: { status: 'ready', customerId: 'cus_simulated', testClockId: 'clock_simulated',
      stripeAccountId: config.accountId, liveMode: false, frozenTimeSeconds: time / 1000, observedAt: NOW } };
}
function reference(m = mirror()) {
  const { ownerSub, customerId, testClockId, bindingId, stage, stripeAccountId, syntheticFixture, clockRevision, frozenTimeSeconds } = m;
  return { ownerSub, customerId, testClockId, bindingId, stage, stripeAccountId, syntheticFixture, clockRevision, frozenTimeSeconds };
}
function source(m = mirror()) {
  return { pk: 'USER#adult', sk: 'SUBSCRIPTION#INDIVIDUAL', entityType: 'SubscriptionSource', ownerSub: 'adult',
    sourceId: 'simulated-individual', state: 'active', paidThrough: NOW + DAY, graceUntil: null,
    revision: 1, updatedAt: NOW, testClock: reference(m) } as SubscriptionSourceItem & { testClock: ReturnType<typeof reference> };
}
function sources(m: unknown = mirror(), s = source(), stage = 'dev') {
  return { subscription: s, testClock: m, testClockObserved:true as const, billingStage: stage, ownerProfile: { accountType: 'adult' as const } };
}
describe('scoped financial time in the existing AccessResolver', () => {
  it('expires individual access at simulated paid end even when the worker is late', () => {
    const s = sources(mirror(NOW + DAY));
    expect(deriveAccessItem('adult', NOW, undefined, [], s).effectivePlanKey).toBe('free');
  });
  it.each([
    ['lost mirror', () => sources(null)],
    ['PROD restore', () => sources(mirror(), source(), 'prod')],
    ['unknown stage', () => sources(mirror(), source(), '')],
    ['revision rollback', () => sources(mirror(), source(mirror(NOW, 2)))],
    ['time rollback', () => sources(mirror(), source(mirror(NOW + 1000)))],
    ['time changed without new revision', () => sources(mirror(NOW+1000), source())],
    ['customer mismatch', () => sources({ ...mirror(), customerId: 'cus_other' })],
    ['owner mismatch', () => sources({ ...mirror(), ownerSub: 'other' })],
    ['advancing', () => sources({ ...mirror(), providerReadyEvidence: { ...mirror().providerReadyEvidence, status: 'advancing' } })],
    ['stale evidence', () => sources({ ...mirror(), providerReadyEvidence: { ...mirror().providerReadyEvidence, observedAt: NOW - DAY } })],
  ] as const)('fails closed for %s without wall-time fallback', (_label, getSources) => {
    expect(deriveAccessItem('adult', NOW, undefined, [], getSources()).effectivePlanKey).toBe('free');
  });
  it('gives an active synthetic subscription no offline lease', () => {
    const access = deriveAccessItem('adult', NOW, undefined, [], sources());
    expect(access.effectivePlanKey).toBe('premium');
    expect(access.offlineValidUntil).toBeLessThanOrEqual(NOW);
    expect(access.updatedAt).toBe(NOW);
    expect(JSON.stringify(access)).not.toContain('cus_simulated');
    expect(JSON.stringify(access)).not.toContain('clock_simulated');
  });
  it('expires only the individual source, preserving a grant on wall time', () => {
    const grant: GrantItem = { pk:'USER#adult',sk:'GRANT#qa',ownerSub:'adult',grantId:'qa',sourceKind:'sponsored',
      status:'active',catalogVersion:PREPAYMENT_CATALOG.version,planKey:'premium',...PREPAYMENT_CATALOG.plans.premium,
      startsAt:NOW-1000,expiresAt:NOW+60_000,revision:1,reason:'qa',createdAt:NOW-1000,updatedAt:NOW-1000 };
    const result = deriveAccessItem('adult', NOW, undefined, [grant], sources(mirror(NOW + DAY)));
    expect(result.effectivePlanKey).toBe('premium');
    expect(result.activeSources.map(s => s.sourceId)).toEqual(['qa']);
  });
  it('does not reuse cached simulated access after a mirror advance', async () => {
    let m = mirror();
    let cached = deriveAccessItem('adult', NOW, undefined, [], sources(m));
    const resolver = new AccessResolver({ tableName:'qa',now:()=>NOW,
      readSnapshot:async()=>({access:cached,grants:[],...sources(m)}),
      materializeAccess:async p=>{cached=p.Put.Item;return 'committed';} });
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('premium');
    m = mirror(NOW+DAY, 2);
    expect((await resolver.resolveFresh('adult')).access.effectivePlanKey).toBe('free');
  });
  it('preserves normal real-time individual access and its offline lease', () => {
    const { testClock: _ignored, ...realSource } = source();
    const access = deriveAccessItem('adult', NOW, undefined, [], {subscription:realSource});
    expect(access.effectivePlanKey).toBe('premium');
    expect(access.offlineValidUntil).toBeGreaterThan(NOW);
  });
});

describe('financial and operational clocks in billing consumers', () => {
  it('accepts a simulated future paid-at while scheduling and auditing on wall time', async () => {
    const f = await fixture();
    await f.service.checkout('adult', request());
    const customerId = (await f.repository.load('adult')).customerId!;
    const m = mirror(NOW+DAY);
    m.customerId=customerId; m.providerReadyEvidence.customerId=customerId;
    f.repository.states.set('adult',{...await f.repository.load('adult'),testClock:reference(m)});
    Object.assign(f.repository, {readTestClock:async()=>m});
    Object.assign(f.provider.customers.get(customerId)!, {testClockId:m.testClockId});
    f.provider.subscriptions.set('sub_1', subscription(customerId));
    const inv = invoice(customerId, 'in_simulated', NOW+DAY, NOW+2*DAY); inv.paidAt=NOW+DAY;
    f.provider.invoices.set(inv.id, inv);
    const projector = new BillingProjector({...f,config,nextWorkerId:()=> 'worker-qa'});
    await projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('active');
    expect((await f.repository.load('adult')).nextReconcileAt).toBe(NOW+900_000);
    expect((await f.repository.load('adult')).updatedAt).toBe(NOW);
    expect((await f.repository.receipts('adult'))[0].verifiedAt).toBe(NOW);
  });
  it.each(['month','year'] as const)('renews and expires %s v2 totals across worker, reconciler, summary and late access readers', async interval => {
    const cfg={...config,catalogVersion:'individual-mx-2026-10-v2'};
    const f=await fixture(), repository=f.repository, provider=new FakeBillingProvider(cfg,f.now);
    const service=new BillingService({...f,provider,config:cfg,purchasesEnabled:async()=>true});
    await service.checkout('adult',{...request(),catalogVersion:cfg.catalogVersion,interval});
    const customerId=(await repository.load('adult')).customerId!;
    let m=mirror();m.customerId=customerId;m.providerReadyEvidence.customerId=customerId;
    const publish=(time:number,revision:number)=>{m={...m,frozenTimeSeconds:time/1000,clockRevision:revision,
      providerReadyEvidence:{...m.providerReadyEvidence,frozenTimeSeconds:time/1000}};repository.testClocks.set('adult',m);};
    publish(NOW,1);
    repository.states.set('adult',{...await repository.load('adult'),testClock:reference(m)});
    Object.assign(provider.customers.get(customerId)!,{testClockId:m.testClockId});
    const priceId=interval === 'month' ? cfg.monthlyPriceId : cfg.annualPriceId;
    const amount=interval === 'month' ? 11484 : 110084;
    const end=interval === 'month' ? Date.UTC(2026,10,11,12) : Date.UTC(2027,9,11,12);
    const nextEnd=interval === 'month' ? Date.UTC(2026,11,11,12) : Date.UTC(2028,9,11,12);
    provider.subscriptions.set('sub_1',{...subscription(customerId),interval,priceId});
    const paid=(id:string,start:number,until:number)=>{
      const inv=invoice(customerId,id,start,until);inv.paidAt=start;inv.amountDue=amount;inv.amountPaid=amount;
      Object.assign(inv.lines[0],{interval,priceId,amount});inv.payments[0].amountPaid=amount;return inv;
    };
    provider.invoices.set('in_initial',paid('in_initial',NOW,end));
    const projector=new BillingProjector({repository,provider,config:cfg,now:f.now,nextWorkerId:()=> 'qa-clock-worker'});
    const access=async()=> (await new AccessResolver({tableName:'qa',now:f.now,
      readSnapshot:async()=>({grants:[],subscription:repository.sources.get('adult'),testClock:await repository.readTestClock('adult'),testClockObserved:true,
        billingStage:cfg.stage,ownerProfile:{accountType:'adult'}}),materializeAccess:async()=> 'committed'}).resolveFresh('adult')).access;
    await projector.reconcileOwner('adult');
    expect((await access()).effectivePlanKey).toBe('premium');
    publish(end,2);
    expect((await access()).effectivePlanKey).toBe('free');
    expect((await service.summary('adult')).state).toBe('expired');
    provider.invoices.set('in_renewal',paid('in_renewal',end,nextEnd));
    const event={eventId:'evt_simulated',type:'invoice.paid',objectId:'in_renewal',objectType:'invoice',
      apiVersion:STRIPE_API_VERSION,liveMode:false,accountId:cfg.accountId,status:'pending' as const,attempts:0,receivedAt:NOW,nextAttemptAt:NOW};
    await repository.putEvent(event);
    const worker=new BillingEventWorker({repository,provider,projector,config:cfg,now:f.now,metric:()=>{}});
    await worker.process(event.eventId);
    expect((await access()).effectivePlanKey).toBe('premium');
    expect((await service.summary('adult')).state).toBe('active');
    expect((await repository.event(event.eventId))?.processedAt).toBe(NOW);
    const reconciler=new BillingReconciler({repository,provider,service,worker,projector,now:f.now,metric:()=>{}});
    expect((await reconciler.run('audit')).failed).toBe(0);
    expect((await repository.load('adult')).paidThrough).toBe(nextEnd);
    provider.subscriptions.get('sub_1')!.cancelAtPeriodEnd=true;
    await projector.reconcileOwner('adult');
    publish(nextEnd,3);
    expect((await access()).effectivePlanKey).toBe('free');
    expect((await service.summary('adult')).state).toBe('expired');
    provider.subscriptions.get('sub_1')!.status='canceled';
    await projector.reconcileOwner('adult');await projector.reconcileOwner('adult');
    expect((await access()).effectivePlanKey).toBe('free');
    expect((await repository.load('adult')).nextReconcileAt).toBe(NOW+900_000);
    expect((await repository.load('adult')).updatedAt).toBe(NOW);
    expect((await repository.receipts('adult')).every(i=>i.valid && i.amountPaid === amount && i.verifiedAt === NOW)).toBe(true);
  });
  it('closes an absent owner with a lost mirror without recreating USER data', async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const customerId=(await f.repository.load('adult')).customerId!;
    Object.assign(f.provider.customers.get(customerId)!,{testClockId:'clock_simulated'});
    f.provider.subscriptions.set('sub_1',subscription(customerId));
    f.provider.invoices.set('in_1',invoice(customerId));
    f.repository.actors.delete('adult');
    const projector=new BillingProjector({...f,config,nextWorkerId:()=> 'closed-clock'});
    await projector.reconcileOwner('adult');
    expect((await f.repository.load('adult')).state).toBe('closed');
    expect(f.provider.subscriptions.get('sub_1')?.status).toBe('canceled');
    expect(f.repository.sources.has('adult')).toBe(false);
    expect(f.repository.actors.has('adult')).toBe(false);
  });
  it('records review and a protected marker for an unbound clock Customer',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const customerId=(await f.repository.load('adult')).customerId!;
    Object.assign(f.provider.customers.get(customerId)!,{testClockId:'clock_simulated'});
    f.provider.subscriptions.set('sub_1',subscription(customerId));f.provider.invoices.set('in_1',invoice(customerId));
    await new BillingProjector({...f,config,nextWorkerId:()=> 'unbound-clock'}).reconcileOwner('adult');
    expect((await f.repository.load('adult')).reviewReasons).toContain('test_clock_unavailable');
    expect(f.repository.sources.get('adult')).toMatchObject({state:'ended',testClock:{clockRevision:0}});
    expect((await f.service.summary('adult')).canCheckout).toBe(false);
  });
  it('re-reads provider facts if the protected mirror advances during a snapshot',async()=>{
    const f=await fixture();await f.service.checkout('adult',request());
    const customerId=(await f.repository.load('adult')).customerId!;
    const initial=mirror();initial.customerId=customerId;initial.providerReadyEvidence.customerId=customerId;
    f.repository.testClocks.set('adult',initial);
    f.repository.states.set('adult',{...await f.repository.load('adult'),testClock:reference(initial)});
    Object.assign(f.provider.customers.get(customerId)!,{testClockId:initial.testClockId});
    f.provider.subscriptions.set('sub_1',subscription(customerId));f.provider.invoices.set('in_1',invoice(customerId));
    const end=f.provider.invoices.get('in_1')!.lines[0].end;
    const snapshot=f.provider.snapshot.bind(f.provider);let reads=0;
    f.provider.snapshot=async customer=>{
      reads++;const result=await snapshot(customer);
      if (reads === 1) {
        const renewal=invoice(customerId,'in_renewed',end,end+DAY);renewal.paidAt=end;
        f.provider.invoices.set(renewal.id,renewal);
        f.repository.testClocks.set('adult',{...initial,clockRevision:2,frozenTimeSeconds:end/1000,
          providerReadyEvidence:{...initial.providerReadyEvidence,frozenTimeSeconds:end/1000}});
      }
      return result;
    };
    await new BillingProjector({...f,config,nextWorkerId:()=> 'clock-race'}).reconcileOwner('adult');
    expect(reads).toBe(2);
    expect((await f.repository.load('adult')).state).toBe('active');
    expect(f.repository.sources.get('adult')?.paidThrough).toBe(end+DAY);
  });
});

describe('protected mirror validation',()=>{
  const context=()=>({ownerSub:'adult',customerId:'cus_simulated',stage:'dev',accountId:config.accountId,liveMode:false,now:NOW,reference:reference()});
  it.each([
    ['wrong sandbox',(m:ReturnType<typeof mirror>)=>({...m,stripeAccountId:'acct_other'})],
    ['wrong clock',(m:ReturnType<typeof mirror>)=>({...m,testClockId:'clock_other'})],
    ['wrong binding',(m:ReturnType<typeof mirror>)=>({...m,bindingId:'binding-other'})],
    ['live mirror',(m:ReturnType<typeof mirror>)=>({...m,liveMode:true})],
    ['wrong fixture',(m:ReturnType<typeof mirror>)=>({...m,syntheticFixture:'ordinary-user'})],
    ['wrong stage',(m:ReturnType<typeof mirror>)=>({...m,stage:'test'})],
    ['unsafe milliseconds',(m:ReturnType<typeof mirror>)=>({...m,frozenTimeSeconds:Number.MAX_SAFE_INTEGER})],
    ['fractional seconds',(m:ReturnType<typeof mirror>)=>({...m,frozenTimeSeconds:1.5})],
    ['invalid revision',(m:ReturnType<typeof mirror>)=>({...m,clockRevision:0})],
    ['crossed evidence',(m:ReturnType<typeof mirror>)=>({...m,providerReadyEvidence:{...m.providerReadyEvidence,customerId:'cus_other'}})],
    ['future observation',(m:ReturnType<typeof mirror>)=>({...m,providerReadyEvidence:{...m.providerReadyEvidence,observedAt:NOW+1}})],
    ['failed provider',(m:ReturnType<typeof mirror>)=>({...m,providerReadyEvidence:{...m.providerReadyEvidence,status:'internal_failure'}})],
  ] as const)('rejects %s',(_label,change)=>{
    expect(resolveFinancialClock(context(),change(mirror())).mode).toBe('blocked');
  });
  it('rejects live runtime and an actual Customer clock that disagrees with the mirror',()=>{
    expect(resolveFinancialClock({...context(),liveMode:true},mirror()).mode).toBe('blocked');
    expect(resolveFinancialClock({...context(),providerTestClockId:'clock_other'},mirror()).mode).toBe('blocked');
    expect(resolveFinancialClock({...context(),providerTestClockId:null},mirror()).mode).toBe('blocked');
    expect(resolveFinancialClock({...context(),reference:undefined,providerTestClockId:''},null).mode).toBe('blocked');
  });
  it('rejects safe integer milliseconds outside the supported Date range',()=>{
    const m=mirror(8_640_000_000_001_000);
    expect(resolveFinancialClock({...context(),reference:reference(m)},m).mode).toBe('blocked');
  });
  it.each(['BILLING#TEST_CLOCK','billingTestClocks','subscriptions','access'])('rejects client sync store %s',store=>{
    expect(()=>validateSyncEntryShapes([{store,record:mirror()}])).toThrow();
  });
  it('rejects client clock fields hidden inside an otherwise valid tree',()=>{
    const tree={id:'tree-1',createdAt:NOW-1000,updatedAt:NOW,rev:1,deletedAt:null,name:'QA',accent:'moss',order:1,
      currentNodeId:null,archivedAt:null,testClock:mirror()};
    expect(()=>validateSyncEntryShapes([{store:'trees',record:tree}])).toThrow();
  });
});
