import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export interface DurableClockJournal { readonly directory:string; readonly directoryId:string; readonly aclSha256:string }
export interface DurableClockJournalConfig { directory:string; powershellExecutable:string; powershellSha256:string }
interface Binding extends DurableClockJournalConfig { helper:string; helperSha256:string; directoryId:string; aclSha256:string }
const bindings=new WeakMap<object,Binding>();
const MAX_PAYLOAD=16_384;
const HEX=/^[a-f0-9]{64}$/;
const FILE=/^[a-f0-9]{64}\.(intent|delivery|readback|provider-advance-intent|provider-advance-result|caller-attempt)\.json$/;
const CODES=new Set(['DIRECTORY_REQUIRED','DIRECTORY_EXISTS','PATH_REJECTED','NTFS_REQUIRED','ACL_REJECTED','PARENT_ACL_REJECTED',
 'DIRECTORY_CHANGED','ALREADY_RESERVED','RECORD_REJECTED','FILE_REQUIRED','FILE_REJECTED','FLUSH_FAILED','NATIVE_FAILED']);
function fail(code:string):never{throw new Error('CLOCK_JOURNAL_STORE_'+code);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function sha(data:Buffer|string){return createHash('sha256').update(data).digest('hex');}
function regularHash(file:string){try{const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink())fail('PROGRAM_CHANGED');return sha(readFileSync(file));}catch{fail('PROGRAM_CHANGED');}}
function localPath(path:string){
 if(typeof path!=='string'||!path.match(/^[A-Za-z]:[\\/]/)||path.length>240||/[<>:"|?*\x00-\x1f]/.test(path.slice(2)))fail('PATH_REJECTED');
 return resolve(path);
}
function config(input:DurableClockJournalConfig):Omit<Binding,'directoryId'|'aclSha256'>{
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED');
 if(!record(input)||Object.keys(input).sort().join(',')!=='directory,powershellExecutable,powershellSha256'||!HEX.test(input.powershellSha256))fail('PATH_REJECTED');
 const helper=fileURLToPath(new URL('./stripe-test-clock-journal-windows.ps1',import.meta.url));
 const value={directory:localPath(input.directory),powershellExecutable:localPath(input.powershellExecutable),powershellSha256:input.powershellSha256,
  helper,helperSha256:regularHash(helper)};
 if(regularHash(value.powershellExecutable)!==value.powershellSha256)fail('PROGRAM_CHANGED');
 return value;
}
function native(binding:Omit<Binding,'directoryId'|'aclSha256'>,request:Record<string,unknown>):Record<string,unknown>{
 if(regularHash(binding.helper)!==binding.helperSha256||regularHash(binding.powershellExecutable)!==binding.powershellSha256)fail('PROGRAM_CHANGED');
 const env:NodeJS.ProcessEnv={};
 for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 let result:ReturnType<typeof spawnSync>|undefined;
 try{
  result=spawnSync(binding.powershellExecutable,['-NoProfile','-NonInteractive','-File',binding.helper],
   {cwd:dirname(binding.helper),env,input:JSON.stringify({schemaVersion:1,directory:binding.directory,...request}),encoding:'utf8',
    shell:false,windowsHide:true,timeout:15000,maxBuffer:65536});
  if(result.error)fail('NATIVE_FAILED');
  let value:unknown;
  try{value=JSON.parse(String(result.stdout))}catch{fail('NATIVE_FAILED');}
  if(!record(value))fail('NATIVE_FAILED');
  if(result.status!==0||value.status!=='ok'){
   const code=typeof value.code==='string'?value.code.replace(/^CLOCK_JOURNAL_STORE_/,''):'';
   fail(CODES.has(code)?code:'NATIVE_FAILED');
  }
  if(regularHash(binding.helper)!==binding.helperSha256||regularHash(binding.powershellExecutable)!==binding.powershellSha256)fail('PROGRAM_CHANGED');
  if(value.schemaVersion!==1||value.fileSystem!=='NTFS'||value.ownerVerified!==true||value.allowedPrincipalCount!==3||
   !HEX.test(String(value.directoryId))||!HEX.test(String(value.aclSha256)))fail('NATIVE_FAILED');
  return value;
 }finally{if(result){result.stdout='';result.stderr='';}}
}
function open(input:DurableClockJournalConfig,action:'initialize'|'inspect'):DurableClockJournal{
 const cfg=config(input),observed=native(cfg,{action});
 const directoryId=observed.directoryId as string,aclSha256=observed.aclSha256 as string;
 const result=Object.freeze({directory:cfg.directory,directoryId,aclSha256});
 bindings.set(result,{...cfg,directoryId,aclSha256});return result;
}
/** Creates only a new leaf. Existing directories/ACLs are never changed. */
export function initializeDurableClockJournal(input:DurableClockJournalConfig):DurableClockJournal{return open(input,'initialize');}
export function openDurableClockJournal(input:DurableClockJournalConfig):DurableClockJournal{return open(input,'inspect');}
export function assertDurableClockJournal(value:unknown):asserts value is DurableClockJournal{
 if(!value||typeof value!=='object'||!bindings.has(value))fail('CAPABILITY_REQUIRED');
}
export function durableClockJournalPath(store:DurableClockJournal,filename:string):string{
 assertDurableClockJournal(store);if(!FILE.test(filename))fail('FILENAME_REJECTED');return join(store.directory,filename);
}
function operation(store:DurableClockJournal,filename:string,action:'write'|'read',extra:Record<string,unknown>={}){
 durableClockJournalPath(store,filename);const binding=bindings.get(store)!;
 const result=native(binding,{action,filename,expectedDirectoryId:binding.directoryId,expectedAclSha256:binding.aclSha256,...extra});
 if(result.directoryId!==binding.directoryId||result.aclSha256!==binding.aclSha256)fail('DIRECTORY_CHANGED');
 if(result.filename!==filename||result.fileAclVerified!==true||!HEX.test(String(result.payloadSha256))||
  !Number.isSafeInteger(result.byteLength)||(result.byteLength as number)>MAX_PAYLOAD)fail('NATIVE_FAILED');
 return result;
}
/** Successful return means the native exclusive create/write/Flush(true) completed. */
export function writeDurableClockJournalFile(store:DurableClockJournal,filename:string,value:unknown):string{
 const file=durableClockJournalPath(store,filename);let text:string;
 try{text=JSON.stringify(value,null,2)+'\n';}catch{fail('RECORD_REJECTED');}
 if(!record(value)||Buffer.byteLength(text)>MAX_PAYLOAD)fail('RECORD_REJECTED');
 const result=operation(store,filename,'write',{payloadJson:text,payloadSha256:sha(text)});
 if(result.payloadSha256!==sha(text)||result.byteLength!==Buffer.byteLength(text)||result.writeThrough!==true||result.flushToDisk!==true||result.exclusiveCreate!==true)fail('FLUSH_FAILED');
 return file;
}
export function readDurableClockJournalFile(store:DurableClockJournal,filename:string):unknown{
 const result=operation(store,filename,'read'),text=result.payloadJson;
 if(typeof text!=='string'||sha(text)!==result.payloadSha256||Buffer.byteLength(text)!==result.byteLength)fail('RECORD_REJECTED');
 try{return JSON.parse(text)}catch{fail('RECORD_REJECTED');}
}
