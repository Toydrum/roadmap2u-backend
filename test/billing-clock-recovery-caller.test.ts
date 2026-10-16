import { afterAll,describe,expect,it } from 'vitest';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_NOW,cleanupAuthorityFixtures } from './support/clock-authority-fixture';
import { cleanupRecoveryAuthorityFixtures } from './support/clock-recovery-authority-fixture';
import { recoveryCallerFixture } from './support/clock-recovery-caller-fixture';
afterAll(()=>{cleanupRecoveryAuthorityFixtures();cleanupAuthorityFixtures();});
function factory(f:any):typeof import('../scripts/stripe-test-clock-recovery-caller').prepareClockRecoveryCaller{
  expect(f.api.prepareClockRecoveryCaller,'recovery caller is missing').toBeTypeOf('function');return f.api.prepareClockRecoveryCaller;
}
describe.runIf(process.platform==='win32')('bounded read-only recovery composition with real Git/NTFS/SDK',()=>{
  it.each(['dev','test'].flatMap(stage=>[false,true].map(original=>[stage,original] as const)))('composes %s recovery original=%s without writes',async(stage,original)=>{
    const f=await recoveryCallerFixture(stage,original),prepare=factory(f),before=f.prior?readFileSync(f.api.durableClockJournalPath(f.prior,f.savedIntent!.reservationId+'.intent.json')):null;
    const engine=await prepare(f.options);expect(f.events).toEqual([]);expect(engine.preview.maximumReadRequests).toBe(original?16:15);
    const output=await engine.execute();
    expect(output).toMatchObject({status:'observed',step:'complete',remoteWrites:0,providerAdvances:0,
      providerReadyEvidenceProduced:false,clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false,
      originalReadback:{status:original?'verified_applied':'not_requested'},observations:{clock:{status:'advancing'},aws:{financialRows:1,financialRevision:8}}});
    expect(output.counts.delegations).toBe(original?16:15);expect(f.ownership.calls).toHaveLength(6);expect(f.stripe).toEqual(['account','customer','clock']);
    expect(f.aws).toEqual(['identity','app_table','privacy_table','fixture_identity','snapshot','financial_partition',...(original?['readback']:[])]);
    expect(f.wires.some((w:any)=>w.headers['x-amz-target']?.includes('TransactWrite'))).toBe(false);expect(f.destroyed()).toBe(1);
    const raw=JSON.stringify(output);for(const value of ['in-memory-only','private@example.invalid','private-financial-payload','private-command','cus_native_fixture','clock_native_fixture',f.options.apiKey,f.credentials.secretAccessKey])expect(raw).not.toContain(value);
    if(before)expect(readFileSync(f.api.durableClockJournalPath(f.prior,f.savedIntent!.reservationId+'.intent.json'))).toEqual(before);
    await expect(engine.execute()).rejects.toThrow('CLOCK_RECOVERY_CALLER_ALREADY_CONSUMED');
  },180000);
  it.each(['ready','advancing','internal_failure'])('diagnoses %s without publishing ready',async status=>{
    const f=await recoveryCallerFixture();f.clock.status=status;
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'observed',providerReadyEvidenceProduced:false,clockReadable:false,observations:{clock:{status}}});
  },180000);
  it('diagnoses an expired provider clock',async()=>{
    const f=await recoveryCallerFixture();f.clock.deletes_after=Math.floor(AUTH_NOW/1000)-1;
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'observed',observations:{clock:{expired:true}}});
  },180000);
  it('reports a scoped missing clock without inventing ready evidence',async()=>{
    const f=await recoveryCallerFixture();f.missingClock();
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'observed',observations:{clock:{status:'not_found',expired:null}}});
  },180000);
  it.each(['head','helper','certificate'] as const)('stops %s drift before any request',async fault=>{
    const f=await recoveryCallerFixture(),engine=await factory(f)(f.options);
    if(fault==='head')f.git(f.sourceRoot,['commit','--allow-empty','-qm','Synthetic source drift']);
    if(fault==='helper')writeFileSync(join(f.sourceRoot,'scripts/stripe-test-clock-journal-windows.ps1'),'changed');
    if(fault==='certificate')writeFileSync(f.privateFiles.caBundlePath,'changed');
    expect((await engine.execute()).status).toBe('stopped');expect(f.events).toEqual([]);
  },90000);
  it('stops stack resource drift before SDK observation',async()=>{
    const f=await recoveryCallerFixture();f.ownership.change((kind:string,value:any)=>kind==='app'?{...value,StackResourceDetail:{...value.StackResourceDetail,PhysicalResourceId:'wrong'}}:value);
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'stopped',step:'ownership'});
    expect(f.aws).toEqual([]);expect(f.stripe).toEqual([]);
  },90000);
  it('stops actual SDK caller drift before table reads',async()=>{
    const f=await recoveryCallerFixture();f.awsChange((kind:string,value:any)=>kind==='identity'?{...value,Account:'000000000000'}:value);
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'stopped',step:'aws'});
    expect(f.aws).toEqual(['identity']);expect(f.stripe).toEqual([]);
  },90000);
  it('rejects incomplete query results before provider observation',async()=>{
    const f=await recoveryCallerFixture();f.awsChange((kind:string,value:any)=>kind==='financial_partition'?{...value,LastEvaluatedKey:{pk:{S:'BILLING#other'}}}:value);
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'stopped',step:'aws'});expect(f.stripe).toEqual([]);
  },90000);
  it.each(['account','customer'])('stops provider %s mismatch before original readback',async kind=>{
    const f=await recoveryCallerFixture('dev',true);
    f.stripeChange((read:string,value:any)=>read===kind?kind==='account'?{...value,id:'acct_wrong'}:{...value,metadata:{...value.metadata,owner:'wrong'}}:value);
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'stopped',step:'stripe'});expect(f.aws).not.toContain('readback');
  },90000);
  it.each(['missing','changed'])('keeps %s original readback uncertain without replay',async fault=>{
    const f=await recoveryCallerFixture('dev',true);f.awsChange((kind:string,value:any)=>kind==='readback'?{Responses:fault==='missing'?[]:[{},...value.Responses.slice(1)]}:value);
    expect(await (await factory(f)(f.options)).execute()).toMatchObject({status:'uncertain',step:'complete',originalReadback:{status:'uncertain'},remoteWrites:0,providerAdvances:0});
    expect(f.aws.filter((x:string)=>x==='readback')).toHaveLength(1);
  },180000);
  it.each(['aws:identity','stripe:account'])('does not retry a failed %s read or a consumed reply',async failure=>{
    const f=await recoveryCallerFixture(),prepare=factory(f);f.fail(failure);
    const output=await (await prepare(f.options)).execute();expect(output.status).toBe('stopped');
    const before=f.events.length;expect((await (await prepare(f.options)).execute()).status).toBe('stopped');expect(f.events).toHaveLength(before);
    expect(JSON.stringify(output)).not.toContain('private_transport_failure');expect(JSON.stringify(output)).not.toContain('private_provider_failure');
  },180000);
  it('captures credentials and delegate before preparation yields',async()=>{
    const f=await recoveryCallerFixture('dev',true),pending=factory(f)(f.options);
    f.options.credentials.secretAccessKey='changed';f.options.credentials.accessKeyId='ASIA'+'B'.repeat(16);
    f.options.credentials.sessionToken='changed';f.options.awsHandler={destroy:()=>{},handle:async()=>{throw Error('replaced delegate');}};
    f.options.stripeClient={} as any;f.options.now=()=>0;
    expect((await (await pending).execute()).status).toBe('observed');expect(f.wires[0].headers.authorization).toContain('Credential=ASIA'+'A'.repeat(16));
    expect(f.wires[0].headers['x-amz-security-token']).toBe('synthetic-native-session-token');
  },180000);
  it('stops an expired window after the first ownership read',async()=>{
    const f=await recoveryCallerFixture(),run=f.options.ownershipCli;
    f.options.ownershipCli=async(args:readonly string[],options:any)=>{const value=await run(args,options);f.setClock(AUTH_NOW+900001);return value;};
    expect((await (await factory(f)(f.options)).execute()).status).toBe('stopped');expect(f.ownership.calls).toHaveLength(1);expect(f.aws).toEqual([]);
  },90000);
  it('returns a fixed uncertain cleanup result without private errors',async()=>{
    const f=await recoveryCallerFixture();f.failCleanup();
    const output=await (await factory(f)(f.options)).execute();
    expect(output).toMatchObject({status:'uncertain',step:'cleanup',code:'CLOCK_RECOVERY_CALLER_CLEANUP_FAILED'});
    expect(JSON.stringify(output)).not.toContain('synthetic-private-cleanup');
  },180000);
});
