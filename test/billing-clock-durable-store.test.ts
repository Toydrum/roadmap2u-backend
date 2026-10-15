import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initializeDurableClockJournal, openDurableClockJournal, assertDurableClockJournal, durableClockJournalPath,
  writeDurableClockJournalFile, readDurableClockJournalFile, type DurableClockJournal } from '../scripts/stripe-test-clock-durable-store';
import { prepareClockJournal, reserveClockWrite, recordClockWriteDelivery, recordClockReadback,
 reserveClockProviderAdvance, recordClockProviderAdvanceResult } from '../scripts/stripe-test-clock-journal';
import { clockJournalRequest, JOURNAL_NOW as AUTH_NOW } from './support/clock-journal-request';
import type { ClockTransitionRequest } from '../scripts/stripe-test-clock-transition';

const windows=process.platform==='win32';
const pwsh=process.env['CLOCK_TEST_PWSH'] || 'C:/Users/Toy/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const parent=mkdtempSync(join(tmpdir(),'roadmap-clock-durable-'));
const helper=resolve('scripts/stripe-test-clock-journal-windows.ps1');
const id='a'.repeat(64),filename=id+'.intent.json';
const payload={schemaVersion:1,reservationId:id,sourceSha:'b'.repeat(40),operationId:'durable-unit-1',phase:'install',
 scope:{awsAccountId:'765932874577',region:'us-east-1',stage:'dev',appTableName:'roadmap-dev',privacyTableName:'roadmap-privacy-dev',
  ownerSub:'clock-synthetic-owner',stripeAccountId:'acct_synthetic_dev',customerId:'cus_synthetic',testClockId:'clock_synthetic',bindingId:'binding-synthetic'},
 reservedAt:1792000000000,clientRequestToken:'synthetic-token',transactionSha256:'c'.repeat(64),readbackSha256:'d'.repeat(64)};
let number=0;
function config(){return {directory:join(parent,'protected','journal-'+(++number)),powershellExecutable:pwsh,
 powershellSha256:windows?createHash('sha256').update(readFileSync(pwsh)).digest('hex'):'e'.repeat(64)};}
function native(request:unknown){return spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',helper],
 {input:JSON.stringify(request),encoding:'utf8',shell:false,windowsHide:true,timeout:15000,maxBuffer:65536});}
beforeAll(()=>{
 if(!windows)return;
 const result=spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',resolve('test/support/protect-clock-journal-test-parent.ps1')],
  {input:parent,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
 if(result.status!==0)throw new Error('TEST_PRIVATE_PARENT_REQUIRED');
});
afterAll(()=>{
 const absolute=realpathSync(parent),base=realpathSync(tmpdir());
 if(!absolute.toLowerCase().startsWith((base+requireSeparator()).toLowerCase()))throw new Error('UNSAFE_TEST_CLEANUP');
 rmSync(absolute,{recursive:true,force:true});
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}

it('requires the Windows native adapter on other platforms',()=>{
 if(!windows){expect(()=>openDurableClockJournal(config())).toThrow('CLOCK_JOURNAL_STORE_WINDOWS_REQUIRED');return;}
 expect(()=>openDurableClockJournal(config())).toThrow('CLOCK_JOURNAL_STORE_DIRECTORY_REQUIRED');
});
describe.runIf(windows)('real NTFS journal storage, synthetic data only',()=>{
 it('rejects a different native executable hash',()=>{
  expect(()=>initializeDurableClockJournal({...config(),powershellSha256:'0'.repeat(64)})).toThrow('CLOCK_JOURNAL_STORE_PROGRAM_CHANGED');
 });
 it('creates a protected directory and opens it with the same identity',()=>{
  const cfg=config(),first=initializeDurableClockJournal(cfg),second=openDurableClockJournal(cfg);
  expect(first.directory).toBe(resolve(cfg.directory));expect(first.directoryId).toMatch(/^[a-f0-9]{64}$/);
  expect(second.directoryId).toBe(first.directoryId);expect(second.aclSha256).toBe(first.aclSha256);
  expect(()=>assertDurableClockJournal(first)).not.toThrow();
 });
 it('requires explicit initialization and never tightens an existing folder ACL',()=>{
  const cfg=config();mkdirSync(cfg.directory);writeFileSync(join(cfg.directory,'unrelated.txt'),'keep');
  expect(()=>openDurableClockJournal(cfg)).toThrow('CLOCK_JOURNAL_STORE_ACL_REJECTED');
  expect(()=>initializeDurableClockJournal(cfg)).toThrow('CLOCK_JOURNAL_STORE_DIRECTORY_EXISTS');
  expect(readFileSync(join(cfg.directory,'unrelated.txt'),'utf8')).toBe('keep');
 });
 it('writes exact UTF-8 receipt bytes with a durable exclusive creation and reads them back',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg),file=writeDurableClockJournalFile(store,filename,payload);
  expect(file).toBe(join(cfg.directory,filename));expect(readDurableClockJournalFile(store,filename)).toEqual(payload);
  expect(readFileSync(file,'utf8')).toBe(JSON.stringify(payload,null,2)+'\n');
 });
 it('refuses replay with original or changed payload after reopening the directory',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg);writeDurableClockJournalFile(store,filename,payload);
  const reopened=openDurableClockJournal(cfg);
  expect(()=>writeDurableClockJournalFile(reopened,filename,payload)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
  expect(()=>writeDurableClockJournalFile(reopened,filename,{...payload,reservedAt:payload.reservedAt+1})).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
 });
 it('rejects copied and fabricated capabilities',()=>{
  const store=initializeDurableClockJournal(config());
  for(const value of [{...store},JSON.parse(JSON.stringify(store)),{}]){
   expect(()=>assertDurableClockJournal(value)).toThrow('CLOCK_JOURNAL_STORE_CAPABILITY_REQUIRED');
   expect(()=>writeDurableClockJournalFile(value as DurableClockJournal,filename,payload)).toThrow('CLOCK_JOURNAL_STORE_CAPABILITY_REQUIRED');
  }
 });
 it('rejects traversal, streams and wrong file names before any file write',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg);
  for(const name of ['../outside.json',filename+':stream','other.json',id+'.unknown.json',id.toUpperCase()+'.intent.json'])
   expect(()=>durableClockJournalPath(store,name)).toThrow('CLOCK_JOURNAL_STORE_FILENAME_REJECTED');
  expect(existsSync(join(cfg.directory,filename))).toBe(false);
 });
 it('rejects arbitrary fields and secrets rather than persisting them',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg);
  expect(()=>writeDurableClockJournalFile(store,filename,{...payload,secret:'do-not-store'})).toThrow('CLOCK_JOURNAL_STORE_RECORD_REJECTED');
  expect(existsSync(join(cfg.directory,filename))).toBe(false);
 });
 it('an incomplete file left by a stopped process blocks another reservation',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg);writeFileSync(join(cfg.directory,filename),'{');
  expect(()=>readDurableClockJournalFile(store,filename)).toThrow('CLOCK_JOURNAL_STORE_RECORD_REJECTED');
  expect(()=>writeDurableClockJournalFile(store,filename,payload)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
  expect(readFileSync(join(cfg.directory,filename),'utf8')).toBe('{');
 });
 it('rejects a hard-linked record instead of reading an alias as an independent receipt',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg),file=writeDurableClockJournalFile(store,filename,payload);
  linkSync(file,join(cfg.directory,'second-link.json'));
  expect(()=>readDurableClockJournalFile(store,filename)).toThrow('CLOCK_JOURNAL_STORE_FILE_REJECTED');
 });
 it('detects directory replacement before writing under the previous capability',()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg),target=realpathSync(cfg.directory),owned=realpathSync(parent);
  if(!target.toLowerCase().startsWith((owned+requireSeparator()).toLowerCase()))throw new Error('UNSAFE_TEST_CLEANUP');
  rmSync(target,{recursive:true});initializeDurableClockJournal(cfg);
  expect(()=>writeDurableClockJournalFile(store,filename,payload)).toThrow('CLOCK_JOURNAL_STORE_DIRECTORY_CHANGED');
  expect(existsSync(join(cfg.directory,filename))).toBe(false);
 });
 it('enforces one winner between two independent native processes',async()=>{
  const cfg=config(),store=initializeDurableClockJournal(cfg),text=JSON.stringify(payload,null,2)+'\n';
  const request={schemaVersion:1,action:'write',directory:cfg.directory,expectedDirectoryId:store.directoryId,expectedAclSha256:store.aclSha256,
   filename,payloadJson:text,payloadSha256:createHash('sha256').update(text).digest('hex')};
  const run=()=>new Promise<{status:number|null;output:string}>((done,reject)=>{
   const child=spawn(pwsh,['-NoProfile','-NonInteractive','-File',helper],{shell:false,windowsHide:true});let output='';
   const timer=setTimeout(()=>{child.kill();reject(new Error('NATIVE_TEST_TIMEOUT'));},15000);
   child.stdout.on('data',x=>output+=x);child.on('error',reject);child.on('close',status=>{clearTimeout(timer);done({status,output})});
   child.stdin.end(JSON.stringify(request));
  });
  const result=await Promise.all([run(),run()]);expect(result.map(x=>x.status).sort()).toEqual([0,1]);
  expect(result.filter(x=>x.output.includes('CLOCK_JOURNAL_STORE_ALREADY_RESERVED'))).toHaveLength(1);
  expect(readDurableClockJournalFile(store,filename)).toEqual(payload);
 });
 it('native helper rejects unreviewed JSON and prints only a fixed failure code',()=>{
  const result=native({schemaVersion:1,action:'write',directory:'not-absolute',rawSecret:'never-print-this'});
  expect(result.status).toBe(1);expect(result.stdout).not.toContain('never-print-this');expect(result.stderr).not.toContain('never-print-this');
  expect(result.stdout).toMatch(/CLOCK_JOURNAL_STORE_/);
 });
 it('records an actual prepared install and exact atomic readback through the native store',async()=>{
  const f=await clockJournalRequest(),plan=await prepareClockJournal(f.request,f.sourceSha),store=initializeDurableClockJournal(config());
  const intent=reserveClockWrite(store,plan);
  recordClockWriteDelivery(store,plan,{delivery:'acknowledged',recordedAt:AUTH_NOW+1});
  const file=recordClockReadback(store,plan,{transport:'TransactGetItems',requestSha256:plan.intent.readbackSha256,
   startedAt:AUTH_NOW+1,completedAt:AUTH_NOW+2,realNow:AUTH_NOW+3,
   response:{$metadata:{httpStatusCode:200},Responses:plan.expectedItems.map(Item=>({Item}))}});
  expect(JSON.parse(readFileSync(intent,'utf8'))).toEqual(plan.intent);
  expect(readFileSync(intent,'utf8')).not.toContain('in-memory-only');
  expect(readDurableClockJournalFile(store,file.split(/[\\/]/).at(-1)!)).toMatchObject({status:'verified_applied',clockReadable:true,physicalExecutionAllowed:false});
  expect(()=>reserveClockWrite(store,plan)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
 },20000);
 it('keeps advance reservation and result durable without performing an AWS or Stripe send',async()=>{
  const f=await clockJournalRequest('advance_fence'),plan=await prepareClockJournal(f.request,f.sourceSha),store=initializeDurableClockJournal(config());
  reserveClockWrite(store,plan);recordClockWriteDelivery(store,plan,{delivery:'acknowledged',recordedAt:AUTH_NOW+1});
  recordClockReadback(store,plan,{transport:'TransactGetItems',requestSha256:plan.intent.readbackSha256,startedAt:AUTH_NOW+1,completedAt:AUTH_NOW+2,
   realNow:AUTH_NOW+3,response:{$metadata:{httpStatusCode:200},Responses:plan.expectedItems.map(Item=>({Item}))}});
  const intent=reserveClockProviderAdvance(store,plan,AUTH_NOW+4);
  expect(JSON.parse(readFileSync(intent,'utf8')).body).toBe('frozen_time='+(f.request as ClockTransitionRequest).targetFrozenTimeSeconds);
  const result=recordClockProviderAdvanceResult(store,plan,{status:'advance_acknowledged',recordedAt:AUTH_NOW+5});
  expect(JSON.parse(readFileSync(result,'utf8'))).toMatchObject({retryAllowed:false,readyEvidencePublished:false,physicalAuthorizationChecked:false});
  expect(()=>reserveClockProviderAdvance(store,plan,AUTH_NOW+6)).toThrow('CLOCK_JOURNAL_STORE_ALREADY_RESERVED');
 },30000);
});
