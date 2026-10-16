import { afterAll,describe,expect,it } from 'vitest';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { cleanupAuthorityFixtures } from './support/clock-authority-fixture';
import { cleanupRecoveryAuthorityFixtures } from './support/clock-recovery-authority-fixture';
import { recoveryCliFixture,type RecoveryCli } from './support/clock-recovery-cli-fixture';
afterAll(()=>{cleanupRecoveryAuthorityFixtures();cleanupAuthorityFixtures();});
function run(f:any):RecoveryCli{expect(f.api.runClockRecoveryCli,'recovery CLI is missing').toBeTypeOf('function');return f.api.runClockRecoveryCli;}
describe('credential-free recovery preview',()=>{
  it.each(['dev','test'].flatMap(stage=>[false,true].map(original=>[stage,original] as const)))('previews %s original=%s without credentials or authority',async(stage,original)=>{
    const f=await recoveryCliFixture(stage,original,false),result=await run(f)(f.args('--preview'),JSON.stringify(f.previewPacket),{now:f.ports.now});
    expect(result).toMatchObject({exitCode:0,output:{status:'preview',maximumReadRequests:original?16:15,
      sourceShaVerified:false,authorizationReceiptBound:false,remoteWritesAllowed:0,providerAdvancesAllowed:0}});
    expect(f.factories).toEqual([]);
  });
  it.each(['credentials','argv','unknown','traversal'] as const)('rejects %s in preview without echoing private values',async fault=>{
    const f=await recoveryCliFixture('dev',false,false),call=run(f),packet:any={...f.previewPacket},args=f.args('--preview');
    if(fault==='credentials')packet.apiKey='rk_test_never_echo_this_value';
    if(fault==='argv')args.push('--api-key','rk_test_never_echo_this_value');
    if(fault==='unknown')packet.nativeTransports={disabledTls:true};
    if(fault==='traversal')args[6]='../outside.json';
    const result=await call(args,JSON.stringify(packet),{now:f.ports.now});
    expect(result.exitCode).toBe(2);expect(JSON.stringify(result)).not.toContain('never_echo_this_value');expect(f.factories).toEqual([]);
  });
  it('runs the actual private-stdin process entry for preview',async()=>{
    const entry=resolve('scripts/run-stripe-test-clock-recovery.ts');
    expect(existsSync(entry),'native recovery process entry is missing').toBe(true);
    const f=await recoveryCliFixture('dev',false,false),output=join(f.root,'recovery-entry.mjs');
    buildSync({entryPoints:[entry],outfile:output,bundle:true,packages:'external',platform:'node',format:'esm',target:'node22',logLevel:'silent'});
    // Use only this owned runtime junction; no dependency install or download.
    const fs=await import('node:fs');fs.symlinkSync(fs.realpathSync('node_modules'),join(f.root,'node_modules'),'junction');
    const child=spawnSync(process.execPath,[output,...f.args('--preview')],{input:JSON.stringify(f.previewPacket),encoding:'utf8',
      shell:false,windowsHide:true,timeout:20000,maxBuffer:4096});
    expect(child.status).toBe(0);expect(child.error).toBeUndefined();
    expect(JSON.parse(child.stdout)).toMatchObject({status:'preview',maximumReadRequests:15,sourceShaVerified:false});
    expect(child.stderr).toBe('');
  },60000);
});
describe.runIf(process.platform==='win32')('native recovery execute boundary, simulated cloud only',()=>{
  it('captures transport delegates before invoking the supplied clock',async()=>{
    const f=await recoveryCliFixture(),ports:any={...f.ports,now:()=>{
      ports.nativeTransports=()=>{throw Error('private replacement factory must not run');};
      ports.ownershipCli=()=>{throw Error('private replacement CLI must not run');};return f.ports.now();
    }};
    const result=await run(f)(f.args(),JSON.stringify(f.executePacket),ports);
    expect(result).toMatchObject({exitCode:0,output:{status:'observed',remoteWrites:0}});
    expect(f.factories).toHaveLength(1);expect(f.ownership.calls).toHaveLength(6);expect(f.destroyed()).toBe(1);
  },180000);
  it.each([['dev',true],['test',false]] as const)('executes %s original=%s with pinned runtime and closed transports',async(stage,original)=>{
    const f=await recoveryCliFixture(stage,original),result=await run(f)(f.args(),JSON.stringify(f.executePacket),f.ports);
    expect(result).toMatchObject({exitCode:0,output:{status:'observed',remoteWrites:0,providerAdvances:0,clockReadable:false}});
    expect(f.factories).toHaveLength(1);expect(f.factories[0]).toMatchObject({stage,phase:'recovery',recoveryReadback:original});
    expect(f.ownership.calls).toHaveLength(6);expect(f.destroyed()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(f.credentials.secretAccessKey);expect(JSON.stringify(result)).not.toContain(f.executePacket!.apiKey);
  },180000);
  it.each(['live_key','permanent_key','expired','extra','aws_pin'] as const)('rejects %s before native transport creation',async fault=>{
    const f=await recoveryCliFixture(),call=run(f),packet:any=structuredClone(f.executePacket);
    if(fault==='live_key')packet.apiKey='rk_live_should_never_be_used';
    if(fault==='permanent_key')packet.credentials.accessKeyId='AKIA'+'A'.repeat(16);
    if(fault==='expired')packet.credentials.expiration=new Date(0).toISOString();
    if(fault==='extra')packet.profile='roadmap2u';
    if(fault==='aws_pin')writeFileSync(f.awsBinary,'changed');
    const result=await call(f.args(),JSON.stringify(packet),f.ports);
    expect(result.exitCode).toBe(2);expect(f.factories).toEqual([]);expect(f.ownership.calls).toEqual([]);expect(f.aws).toEqual([]);
  },90000);
  it('stops binary drift after transport preparation before a CLI delegation',async()=>{
    const f=await recoveryCliFixture(),call=run(f),factory=f.ports.nativeTransports;
    f.ports.nativeTransports=(options:any)=>{const clients=factory(options);writeFileSync(f.awsBinary,'changed');return clients;};
    const result=await call(f.args(),JSON.stringify(f.executePacket),f.ports);
    expect(result.exitCode).not.toBe(0);expect(f.ownership.calls).toEqual([]);expect(f.aws).toEqual([]);expect(f.destroyed()).toBe(1);
  },90000);
  it('maps uncertain exact-original readback to exit 3 without financial action',async()=>{
    const f=await recoveryCliFixture('dev',true);
    f.awsChange((kind:string,value:any)=>kind==='readback'?{Responses:[]}:value);
    const result=await run(f)(f.args(),JSON.stringify(f.executePacket),f.ports);
    expect(result).toMatchObject({exitCode:3,output:{status:'uncertain',originalReadback:{status:'uncertain'},remoteWrites:0,providerAdvances:0}});
  },180000);
});
