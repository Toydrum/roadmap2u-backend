import { afterAll,describe,expect,it } from 'vitest';
import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { callerFixture,cleanupCallerFixtures } from './support/clock-caller-fixture';
import { AUTH_NOW,AUTH_SECRET,authorityFixture } from './support/clock-authority-fixture';
export type PhysicalClockCli=Awaited<ReturnType<typeof import('../scripts/stripe-test-clock-cli').runClockCallerCli>>;

afterAll(cleanupCallerFixtures);
function args(f:any,mode='--execute'){return [mode,'--source-root',f.sourceRoot,'--review-root',f.reviewRoot,'--manifest','reports/clock-manifest.json'];}
function packet(f:any){return {schemaVersion:1,requestRaw:f.options().requestRaw,authorizationRaw:f.options().authorizationRaw,
  credentials:{...f.credentials,expiration:f.credentials.expiration.toISOString()},apiKey:'rk_test_clockCallerSynthetic',
  cliConfigPath:f.privateFiles.cliConfigPath,cliCredentialsPath:f.privateFiles.cliCredentialsPath,caBundlePath:f.privateFiles.caBundlePath};}
function context(f:any){let constructed=0,closed=0;
  return {count:()=>({constructed,closed}),ports:{now:()=>AUTH_NOW,ownershipCli:f.ownership.runCli,
    nativeTransports:()=>{constructed++;let done=false;return {aws:f.engineOptions.awsHandler,stripe:f.engineOptions.stripeClient,
      counts:()=>({requests:f.aws.length+f.stripe.length,closed:done}),destroy:()=>{if(!done){closed++;done=true;}}};}}};
}
describe.runIf(process.platform==='win32')('native clock CLI composed with real source and durable Windows journal',()=>{
  it('previews through the real plan with no receipt, key, journal writes or transport construction',async()=>{
    const f=await callerFixture();expect(f.api.runClockCallerCli,'Missing composed clock CLI').toBeTypeOf('function');
    const c=context(f),before=readdirSync(f.journal.directory);
    const result=await f.api.runClockCallerCli(args(f,'--preview'),JSON.stringify({schemaVersion:1,requestRaw:f.options().requestRaw}),c.ports);
    expect(result).toMatchObject({exitCode:0,output:{status:'preview',stage:'dev',physicalExecutionAllowed:false,authorizationReceiptBound:false}});
    expect(c.count()).toEqual({constructed:0,closed:0});expect(f.aws).toEqual([]);expect(f.stripe).toEqual([]);
    expect(readdirSync(f.journal.directory)).toEqual(before);
  });
  for(const phase of ['install','refresh','advance_fence'] as const){
    it(`executes the real ${phase} engine once and closes the shared transport`,async()=>{
      const f=await callerFixture(phase);expect(f.api.runClockCallerCli).toBeTypeOf('function');const c=context(f);
      const result=await f.api.runClockCallerCli(args(f),JSON.stringify(packet(f)),c.ports);
      expect(result.exitCode).toBe(0);expect(result.output.status).toBe(phase==='advance_fence'?'advance_acknowledged':'verified_applied');
      expect(f.written).toHaveLength(1);expect(f.advances()).toBe(phase==='advance_fence'?1:0);expect(c.count()).toEqual({constructed:1,closed:1});
      expect(JSON.stringify(result)).not.toMatch(/synthetic-native-cli-secret|synthetic-native-session|rk_test_|ownerSub|customerId|testClockId/);
      const second=await f.api.runClockCallerCli(args(f),JSON.stringify(packet(f)),c.ports);
      expect(second.exitCode).not.toBe(0);expect(f.written).toHaveLength(1);expect(f.ownership.calls).toHaveLength(6);
    },60000);
  }
  it('reports an uncertain delivery without private exception text or a retry',async()=>{
    const f=await callerFixture();expect(f.api.runClockCallerCli).toBeTypeOf('function');f.writeFail('after_apply');const c=context(f);
    const result=await f.api.runClockCallerCli(args(f),JSON.stringify(packet(f)),c.ports);
    expect(result).toMatchObject({exitCode:3,output:{status:'uncertain',retryAllowed:false}});expect(f.written).toHaveLength(1);
    expect(c.count()).toEqual({constructed:1,closed:1});expect(JSON.stringify(result)).not.toContain('synthetic-private-write-failure');
  },60000);
  it('rejects an invalid human receipt before constructing transports or consuming the journal',async()=>{
    const f=await callerFixture();expect(f.api.runClockCallerCli).toBeTypeOf('function');const c=context(f),p=packet(f);
    p.authorizationRaw=JSON.stringify({...f.receipt,answer:'continue automatically'});
    const result=await f.api.runClockCallerCli(args(f),JSON.stringify(p),c.ports);
    expect(result).toMatchObject({exitCode:2,output:{status:'rejected',code:'CLOCK_AUTHORITY_RECEIPT_REJECTED'}});
    expect(c.count().constructed).toBe(0);expect(f.ownership.calls).toEqual([]);expect(readdirSync(f.journal.directory)).toEqual([]);
  });
  it('rejects injected endpoints, unknown flags and credentials in preview without external sends',async()=>{
    const f=await callerFixture();expect(f.api.runClockCallerCli).toBeTypeOf('function');const c=context(f);
    const attempts=[{a:[...args(f),'--endpoint','https://foreign.invalid'],p:packet(f)},
      {a:args(f),p:{...packet(f),endpoint:'https://foreign.invalid'}},
      {a:args(f,'--preview'),p:packet(f)},{a:args(f),p:{...packet(f),apiKey:'rk_live_private'}}];
    for(const attempt of attempts){const result=await f.api.runClockCallerCli(attempt.a,JSON.stringify(attempt.p),c.ports);
      expect(result.exitCode).toBe(2);expect(JSON.stringify(result)).not.toMatch(/foreign.invalid|rk_live_|rk_test_|synthetic-native-cli-secret/);}
    expect(c.count().constructed).toBe(0);expect(f.aws).toEqual([]);expect(f.stripe).toEqual([]);
  });
  it('closes native resources if preparation fails before any external delegation',async()=>{
    const f=await callerFixture();expect(f.api.runClockCallerCli).toBeTypeOf('function');const c=context(f);
    const ports={...c.ports,nativeTransports:()=>{const value=c.ports.nativeTransports();return {...value,aws:null};}};
    const result=await f.api.runClockCallerCli(args(f),JSON.stringify(packet(f)),ports);
    expect(result.exitCode).toBe(2);expect(c.count()).toEqual({constructed:1,closed:1});expect(f.ownership.calls).toEqual([]);
  });
});
describe('private stdin and actual process entry point',()=>{
  it('bounds input bytes, UTF-8 and an unfinished stream without printing private input',async()=>{
    const f=await authorityFixture('dev','install',false,true);expect(f.api.readClockCliInput).toBeTypeOf('function');
    expect(await f.api.readClockCliInput(Readable.from([Buffer.from('{"ok":true}')] ))).toBe('{"ok":true}');
    await expect(f.api.readClockCliInput(Readable.from([Buffer.alloc(524289,65)]))).rejects.toThrow('CLOCK_CLI_INPUT_LIMIT');
    await expect(f.api.readClockCliInput(Readable.from([Buffer.from([0xc0,0xaf])]))).rejects.toThrow('CLOCK_CLI_INPUT_UTF8');
    const stalled=new Readable({read(){}});await expect(f.api.readClockCliInput(stalled,50)).rejects.toThrow('CLOCK_CLI_INPUT_TIMEOUT');expect(stalled.destroyed).toBe(true);
  });
  it('runs the actual entry point as a child for credential-free preview and rejects execute without a receipt',async()=>{
    const f=await authorityFixture('dev','install',false,true),entry=resolve('scripts/run-stripe-test-clock.ts');
    expect(existsSync(entry),'Missing physical entry point').toBe(true);
    const now=Date.now();f.request.clock.realNow=now;f.request.clock.observation.startedAt=now-20;f.request.clock.observation.completedAt=now-10;
    f.request.snapshot.startedAt=now-50;f.request.snapshot.completedAt=now-10;f.freezeReview();
    const input=JSON.stringify({schemaVersion:1,requestRaw:f.options().requestRaw});
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:AWS|STRIPE)_/i.test(key)));
    const result=spawnSync(process.execPath,['--import','tsx',entry,...args(f,'--preview')],{input,encoding:'utf8',env,timeout:15000,windowsHide:true});
    expect(result.status,result.stderr).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toMatchObject({status:'preview',authorizationReceiptBound:false});
    expect(result.stdout).not.toContain(AUTH_SECRET);
    const rejected=spawnSync(process.execPath,['--import','tsx',entry,...args(f)],{input,encoding:'utf8',env,timeout:15000,windowsHide:true});
    expect(rejected.status).toBe(2);expect(rejected.stderr).toBe('');expect(JSON.parse(rejected.stdout)).toMatchObject({status:'rejected'});
    expect(rejected.stdout).not.toContain(input);expect(readFileSync(entry,'utf8')).not.toMatch(/process\.env\.(?:AWS|STRIPE)/);
  },30000);
});
