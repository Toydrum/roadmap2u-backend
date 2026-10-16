import { afterAll,describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AUTH_NOW,cleanupAuthorityFixtures } from './support/clock-authority-fixture';
import { cleanupRecoveryAuthorityFixtures,recoveryAuthorityFixture } from './support/clock-recovery-authority-fixture';

afterAll(()=>{cleanupRecoveryAuthorityFixtures();cleanupAuthorityFixtures();});
function required(f:any,name:string){expect(f.api[name],name+' is missing').toBeTypeOf('function');return f.api[name];}
async function verify(f:any,options=f.recoveryOptions()){return required(f,'verifyClockRecoveryAuthority')(options);}
describe('new read-only clock recovery authority with actual Git review bytes',()=>{
  it.each(['dev','test'])('binds %s without minting write authority',async stage=>{
    const f=await recoveryAuthorityFixture(stage),authority=await verify(f);
    expect(authority).toMatchObject({stage,sourceSha:f.sourceSha,operationId:f.manifest.operationId,
      sourceShaVerified:true,authorizationReceiptBound:true,stackOwnershipVerified:false,maximumReadRequests:15,
      remoteWritesAllowed:0,providerAdvancesAllowed:0,retryAllowed:false,physicalExecutionAllowed:false});
    expect(required(f,'readClockRecoveryAuthority')(authority,AUTH_NOW)).toEqual(f.manifest);
    expect(()=>f.api.readClockCallerAuthority(authority,AUTH_NOW)).toThrow('CLOCK_AUTHORITY_BOUND_CONTEXT_REQUIRED');
    expect(JSON.stringify(authority)).not.toContain('clock_native_owner');
  });
  it('binds an old exact original for a 16-read recovery window',async()=>{
    const f=await recoveryAuthorityFixture('dev',true);f.setNow(AUTH_NOW+86400000);
    f.receipt.issuedAt=AUTH_NOW+86400000-1000;f.receipt.expiresAt=AUTH_NOW+86400000+899000;
    const authority=await verify(f);
    expect(authority.maximumReadRequests).toBe(16);
    const original=required(f,'readClockRecoveryOriginal')(authority,AUTH_NOW+86400000);
    expect(original).toEqual({requestRaw:f.originalRequestRaw,savedIntent:f.savedIntent});
    expect(JSON.stringify(authority)).not.toContain('in-memory-only');
  });
  it.each(['copy','forged'] as const)('rejects a %s authority object',async mode=>{
    const f=await recoveryAuthorityFixture(),authority=await verify(f),read=required(f,'readClockRecoveryAuthority');
    expect(()=>read(mode==='copy'?{...authority}:{sourceShaVerified:true},AUTH_NOW)).toThrow('CLOCK_RECOVERY_AUTHORITY_BOUND_CONTEXT_REQUIRED');
  });
  it.each(['old_write_reply','consumed','expired','future','long_window','manifest_hash','review_commit'] as const)('rejects %s authority before any delegation',async fault=>{
    const f=await recoveryAuthorityFixture();const factory=required(f,'verifyClockRecoveryAuthority');
    if(fault==='old_write_reply')f.receipt.answer='Autorizar reloj DEV install native_authority_install_1';
    if(fault==='consumed')f.receipt.consumed=true;
    if(fault==='expired')f.receipt.expiresAt=AUTH_NOW;
    if(fault==='future')f.receipt.issuedAt=AUTH_NOW+1;
    if(fault==='long_window')f.receipt.issuedAt=AUTH_NOW-900001;
    if(fault==='manifest_hash')f.receipt.manifestSha256='0'.repeat(64);
    if(fault==='review_commit')f.receipt.approvedRootCommit='0'.repeat(40);
    await expect(factory(f.recoveryOptions())).rejects.toThrow(/^CLOCK_RECOVERY_AUTHORITY_/);
  });
  it.each(['prod','live','historical','storage','stack','resources','extra','journal_alias'] as const)('rejects %s scope',async fault=>{
    const f=await recoveryAuthorityFixture('dev',true),factory=required(f,'verifyClockRecoveryAuthority');
    if(fault==='prod')f.manifest.clock.scope.stage='prod';
    if(fault==='live')f.manifest.clock.scope.liveMode=true;
    if(fault==='historical'){f.manifest.clock.ownerSub='e4282408-f0f1-70b2-b5ef-b9ddb80599e7';f.manifest.clock.scope.fixtures[0].ownerSub=f.manifest.clock.ownerSub;}
    if(fault==='storage')f.manifest.storage.awsAccountId='000000000000';
    if(fault==='stack')f.manifest.cloudformation.stackId='arn:aws:cloudformation:us-east-1:765932874577:stack/Roadmap-prod-Backend/11111111-2222-3333-4444-555555555555';
    if(fault==='resources')f.manifest.cloudformation.resources[2].resourceType='AWS::IAM::Role';
    if(fault==='extra')f.manifest.allowWrite=true;
    if(fault==='journal_alias')f.manifest.attemptJournal={...f.manifest.priorJournal};
    f.freezeReview();await expect(factory(f.recoveryOptions())).rejects.toThrow(/^CLOCK_RECOVERY_AUTHORITY_/);
  });
  it.each(['request_bytes','intent','missing_original','unexpected_original','crossed_original'] as const)('rejects %s before preparing recovery',async fault=>{
    const f=await recoveryAuthorityFixture('dev',fault!=='unexpected_original'),factory=required(f,'verifyClockRecoveryAuthority'),options:any=f.recoveryOptions();
    if(fault==='request_bytes')options.originalRequestRaw+=' ';
    if(fault==='intent')options.savedIntent.transactionSha256='0'.repeat(64);
    if(fault==='missing_original')delete options.originalRequestRaw;
    if(fault==='unexpected_original'){options.originalRequestRaw='{}';options.savedIntent={};}
    if(fault==='crossed_original'){f.manifest.clock.ownerSub='other';f.manifest.clock.scope.fixtures[0].ownerSub='other';f.freezeReview();options.manifestRaw=f.recoveryOptions().manifestRaw;options.authorizationRaw=f.recoveryOptions().authorizationRaw;}
    await expect(factory(options)).rejects.toThrow(/^CLOCK_RECOVERY_AUTHORITY_/);
  });
  it.each(['head','origin','dirty','manifest','module'] as const)('rechecks actual %s drift at the read boundary',async fault=>{
    const f=await recoveryAuthorityFixture(),authority=await verify(f),assert=required(f,'assertClockRecoverySource');
    if(fault==='head')f.git(f.sourceRoot,['commit','--allow-empty','-qm','Synthetic new source']);
    if(fault==='origin')f.git(f.sourceRoot,['remote','set-url','origin','https://example.invalid/other.git']);
    if(fault==='dirty')writeFileSync(join(f.sourceRoot,'untracked.txt'),'changed');
    if(fault==='manifest')writeFileSync(join(f.reviewRoot,'reports/clock-recovery-manifest.json'),'changed');
    if(fault==='module')writeFileSync(f.bundle,readFileSync(f.bundle,'utf8')+'\n');
    expect(()=>assert(authority,AUTH_NOW)).toThrow('CLOCK_RECOVERY_AUTHORITY_SOURCE_CHANGED');
  });
  it('does not retain mutable options after asynchronous original preparation starts',async()=>{
    const f=await recoveryAuthorityFixture('dev',true),factory=required(f,'verifyClockRecoveryAuthority'),options=f.recoveryOptions();
    const pending=factory(options);options.savedIntent.scope.ownerSub='changed';options.sourceRoot='changed';options.now=()=>0;
    const authority=await pending;
    expect(required(f,'readClockRecoveryOriginal')(authority,AUTH_NOW).savedIntent.scope.ownerSub).toBe('clock_native_owner');
  });
  it('returns only a credential-free preview and does not mint authority',async()=>{
    const f=await recoveryAuthorityFixture(),preview=await required(f,'previewClockRecoveryPlan')({manifestRaw:f.recoveryOptions().manifestRaw,now:()=>AUTH_NOW});
    expect(preview).toMatchObject({status:'preview',maximumReadRequests:15,remoteWritesAllowed:0,sourceShaVerified:false,
      authorizationReceiptBound:false,physicalExecutionAllowed:false});
    expect(()=>required(f,'readClockRecoveryAuthority')(preview,AUTH_NOW)).toThrow('CLOCK_RECOVERY_AUTHORITY_BOUND_CONTEXT_REQUIRED');
  });
  it('captures preview bytes before asynchronous preparation yields',async()=>{
    const f=await recoveryAuthorityFixture(),options=f.recoveryOptions(),raw=options.manifestRaw;
    const previewOptions={manifestRaw:raw,now:()=>AUTH_NOW},pending=required(f,'previewClockRecoveryPlan')(previewOptions);
    previewOptions.manifestRaw='changed after preparation started';
    expect((await pending).manifestSha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

describe.runIf(process.platform==='win32')('native recovery approval consumption, without cloud',()=>{
  function recoveryRecord(f:any){
    return{schemaVersion:1,reservationId:'a'.repeat(64),kind:'clock_recovery_read_only',status:'reserved',
      sourceSha:f.sourceSha,manifestSha256:'b'.repeat(64),operationId:'recovery_native_format_1',stage:'dev',
      callIdSha256:'c'.repeat(64),approvedRootCommit:f.receipt.approvedRootCommit,issuedAt:AUTH_NOW-1000,
      expiresAt:AUTH_NOW+899000,reservedAt:AUTH_NOW,directoryId:f.journal.directoryId,aclSha256:f.journal.aclSha256,
      priorJournalDirectoryId:null,originalRequestSha256:null,maximumReadRequests:15,remoteWritesAllowed:0,
      providerAdvancesAllowed:0,retryAllowed:false,physicalExecutionAllowed:false};
  }
  it('stores a strict recovery format independently from financial caller records',async()=>{
    const f=await recoveryAuthorityFixture('dev',false,true),payload=recoveryRecord(f),name=payload.reservationId+'.recovery-attempt.json';
    f.api.writeDurableClockJournalFile(f.journal,name,payload);
    expect(f.api.readDurableClockJournalFile(f.journal,name)).toEqual(payload);
    expect(()=>f.api.writeDurableClockJournalFile(f.journal,payload.reservationId+'.caller-attempt.json',payload)).toThrow('CLOCK_JOURNAL_STORE_RECORD_REJECTED');
  },90000);
  it('rejects writes, advance, retry, unsafe scope, aliases and malformed budgets in the native format',async()=>{
    const f=await recoveryAuthorityFixture('dev',false,true),base=recoveryRecord(f),name=base.reservationId+'.recovery-attempt.json';
    const invalid:any[]=[
      {...base,remoteWritesAllowed:1},{...base,providerAdvancesAllowed:1},{...base,retryAllowed:true},
      {...base,remoteWritesAllowed:false},{...base,maximumReadRequests:17},{...base,stage:'prod'},
      {...base,kind:'write'},{...base,transactionSha256:'0'.repeat(64)},
      {...base,maximumReadRequests:16,originalRequestSha256:'d'.repeat(64)},
      {...base,maximumReadRequests:16,originalRequestSha256:'d'.repeat(64),priorJournalDirectoryId:base.directoryId},
      {...base,expiresAt:AUTH_NOW},{...base,maximumReadRequests:16},
    ];
    for(const value of invalid)expect(()=>f.api.writeDurableClockJournalFile(f.journal,name,value)).toThrow('CLOCK_JOURNAL_STORE_RECORD_REJECTED');
  },90000);
  it('writes a separate flushed record once and rejects the same reply after reopening',async()=>{
    const f=await recoveryAuthorityFixture('dev',true,true),authority=await verify(f);
    const reserve=required(f,'reserveDurableClockRecoveryAttempt'),assert=required(f,'assertDurableClockRecoveryAttempt');
    const oldPath=f.api.durableClockJournalPath(f.prior,f.savedIntent.reservationId+'.intent.json'),before=readFileSync(oldPath);
    const attempt=reserve(authority,f.journal,f.prior,AUTH_NOW);
    assert(attempt,authority,f.journal,f.prior,AUTH_NOW);
    expect(readFileSync(oldPath)).toEqual(before);
    const id=createHash('sha256').update(JSON.stringify(['clock-recovery-attempt-v1',f.receipt.callId])).digest('hex');
    expect(f.api.readDurableClockJournalFile(f.journal,id+'.recovery-attempt.json')).toMatchObject({
      kind:'clock_recovery_read_only',maximumReadRequests:16,remoteWritesAllowed:0,providerAdvancesAllowed:0});
    const program=f.api.readDurableClockJournalProgram(f.journal),config=(store:any)=>({
      directory:store.directory,powershellExecutable:program.powershellExecutable,powershellSha256:program.powershellSha256});
    const script="import {pathToFileURL} from 'node:url';let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);const api=await import(pathToFileURL(p.bundle).href);let step='verify';try{const a=await api.verifyClockRecoveryAuthority({...p.options,now:()=>p.now});step='open';const j=api.openDurableClockJournal(p.attempt),old=api.openDurableClockJournal(p.prior);step='reserve';api.reserveDurableClockRecoveryAttempt(a,j,old,p.now);console.log(JSON.stringify({status:'unexpected_success'}));}catch(e){console.log(JSON.stringify({status:'rejected',step,code:e.message==='CLOCK_RECOVERY_AUTHORITY_ALREADY_RESERVED'?e.message:'OTHER_FAILURE'}));}";
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
      input:JSON.stringify({bundle:f.bundle,options:f.recoveryOptions(),now:AUTH_NOW,attempt:config(f.journal),prior:config(f.prior)}),
      encoding:'utf8',shell:false,windowsHide:true,timeout:60000,maxBuffer:4096});
    expect(child.status).toBe(0);expect(child.error).toBeUndefined();
    expect(JSON.parse(child.stdout)).toEqual({status:'rejected',step:'reserve',code:'CLOCK_RECOVERY_AUTHORITY_ALREADY_RESERVED'});expect(readFileSync(oldPath)).toEqual(before);
  },90000);
  it('rejects a changed original native intent before creating the recovery record',async()=>{
    const f=await recoveryAuthorityFixture('dev',true,true),authority=await verify(f),reserve=required(f,'reserveDurableClockRecoveryAttempt');
    const path=f.api.durableClockJournalPath(f.prior,f.savedIntent.reservationId+'.intent.json');
    writeFileSync(path,JSON.stringify({...f.savedIntent,transactionSha256:'0'.repeat(64)}));
    expect(()=>reserve(authority,f.journal,f.prior,AUTH_NOW)).toThrow('CLOCK_RECOVERY_AUTHORITY_ORIGINAL_CHANGED');
    const id=createHash('sha256').update(JSON.stringify(['clock-recovery-attempt-v1',f.receipt.callId])).digest('hex');
    expect(existsSync(f.api.durableClockJournalPath(f.journal,id+'.recovery-attempt.json'))).toBe(false);
  },90000);
  it('rejects an attempt record changed after consumption',async()=>{
    const f=await recoveryAuthorityFixture('dev',false,true),authority=await verify(f);
    const attempt=required(f,'reserveDurableClockRecoveryAttempt')(authority,f.journal,null,AUTH_NOW);
    const id=createHash('sha256').update(JSON.stringify(['clock-recovery-attempt-v1',f.receipt.callId])).digest('hex');
    const path=f.api.durableClockJournalPath(f.journal,id+'.recovery-attempt.json');writeFileSync(path,'{}');
    expect(()=>required(f,'assertDurableClockRecoveryAttempt')(attempt,authority,f.journal,null,AUTH_NOW)).toThrow(/^CLOCK_RECOVERY_AUTHORITY_/);
  },90000);
});
