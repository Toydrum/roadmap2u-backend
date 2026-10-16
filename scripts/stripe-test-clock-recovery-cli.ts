import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync,fstatSync,lstatSync,openSync,readFileSync,readSync,realpathSync } from 'node:fs';
import { isAbsolute,relative,resolve,sep } from 'node:path';
import { previewClockRecoveryPlan,verifyClockRecoveryAuthority,readClockRecoveryAuthority } from './stripe-test-clock-recovery-authority';
import { openDurableClockJournal } from './stripe-test-clock-durable-store';
import { prepareClockRecoveryCaller } from './stripe-test-clock-recovery-caller';
import { prepareClockNativeTransports } from './stripe-test-clock-native-transport';
import type { ClockOwnershipCli } from './stripe-test-clock-ownership';

interface RecoveryCliPorts {now?:()=>number;nativeTransports?:typeof prepareClockNativeTransports;ownershipCli?:ClockOwnershipCli}
type NativeClients=ReturnType<typeof prepareClockNativeTransports>;
type Output=Record<string,unknown>;
interface Result {exitCode:number;output:Output}
const MAX_INPUT=512*1024,MAX_MANIFEST=256*1024,nativeExec=promisify(execFile);
function requireCondition(ok:unknown,code:string):asserts ok{if(!ok)throw Error('CLOCK_RECOVERY_CLI_'+code);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value:unknown,names:string[]):asserts value is Record<string,unknown>{
  requireCondition(record(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)),'PACKET_REJECTED');
}
function argumentsFor(args:readonly string[]){
  requireCondition(Array.isArray(args)&&args.length===7&&['--preview','--execute'].includes(args[0]),'ARGUMENTS');
  const values:Record<string,string>={};
  for(let i=1;i<args.length;i+=2){
    const flag=args[i],value=args[i+1];requireCondition(['--source-root','--review-root','--manifest'].includes(flag)
      &&!Object.hasOwn(values,flag)&&typeof value==='string'&&value.length>0&&value.length<=512&&!value.startsWith('--'),'ARGUMENTS');values[flag]=value;
  }
  requireCondition(isAbsolute(values['--source-root'])&&isAbsolute(values['--review-root']),'ARGUMENTS');
  const path=values['--manifest'];
  requireCondition(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'||p==='.git'),'ARGUMENTS');
  return{mode:args[0],sourceRoot:values['--source-root'],reviewRoot:values['--review-root'],manifestPath:path};
}
function manifestFile(rootArgument:string,path:string){
  const root=realpathSync(rootArgument),file=resolve(root,path),rel=relative(root,realpathSync(file));
  requireCondition(rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep),'MANIFEST_REJECTED');
  const info=lstatSync(file);requireCondition(info.isFile()&&!info.isSymbolicLink(),'MANIFEST_REJECTED');
  const fd=openSync(file,'r');try{
    const before=fstatSync(fd);requireCondition(before.isFile()&&before.size<=MAX_MANIFEST,'MANIFEST_REJECTED');
    const bytes=Buffer.alloc(MAX_MANIFEST+1);let length=0;
    while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
    const after=fstatSync(fd);requireCondition(length<=MAX_MANIFEST&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'MANIFEST_REJECTED');
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));
  }finally{closeSync(fd);}
}
function pinnedAws(runtime:unknown){
  requireCondition(record(runtime)&&typeof runtime.awsCliExecutable==='string'&&isAbsolute(runtime.awsCliExecutable)
    &&typeof runtime.awsCliSha256==='string'&&/^[a-f0-9]{64}$/.test(runtime.awsCliSha256),'AWS_BINARY_REJECTED');
  const file=runtime.awsCliExecutable,hash=runtime.awsCliSha256,canonical=realpathSync(file);
  const check=()=>{
    try{
      const info=lstatSync(file);requireCondition(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=32*1024*1024
        &&realpathSync(file)===canonical&&createHash('sha256').update(readFileSync(file)).digest('hex')===hash,'AWS_BINARY_CHANGED');
    }catch{throw Error('CLOCK_RECOVERY_CLI_AWS_BINARY_CHANGED');}
  };
  check();return{file:canonical,check};
}
/** Private packet only. No login, discovery, resource writes or secret lookup. */
export async function runClockRecoveryCli(args:readonly string[],packetRaw:string,ports:RecoveryCliPorts={}):Promise<Result>{
  let clients:NativeClients|undefined,result:Result|undefined;
  try{
    const parsed=argumentsFor(args),now=ports.now??Date.now,
      nativeTransports=ports.nativeTransports??prepareClockNativeTransports,ownershipCli=ports.ownershipCli;
    requireCondition(typeof packetRaw==='string'&&Buffer.byteLength(packetRaw)<=MAX_INPUT,'INPUT_LIMIT');
    let packet:unknown;try{packet=JSON.parse(packetRaw);}catch{throw Error('CLOCK_RECOVERY_CLI_PACKET_REJECTED');}
    requireCondition(record(packet),'PACKET_REJECTED');
    const withOriginal=Object.hasOwn(packet,'originalRequestRaw')||Object.hasOwn(packet,'savedIntent');
    keys(packet,['schemaVersion',...(withOriginal?['originalRequestRaw','savedIntent']:[]),
      ...(parsed.mode==='--execute'?['authorizationRaw','credentials','apiKey','cliConfigPath','cliCredentialsPath','caBundlePath','caBundleSha256']:[])]);
    requireCondition(packet.schemaVersion===1,'PACKET_REJECTED');
    const manifestRaw=manifestFile(parsed.reviewRoot,parsed.manifestPath);
    const original=withOriginal?{originalRequestRaw:packet.originalRequestRaw as string,savedIntent:packet.savedIntent as any}:{};
    if(parsed.mode==='--preview')return{exitCode:0,output:await previewClockRecoveryPlan({manifestRaw,...original,now})};
    requireCondition(typeof packet.authorizationRaw==='string'&&typeof packet.apiKey==='string'&&/^rk_test_[A-Za-z0-9]{8,256}$/.test(packet.apiKey),'PACKET_REJECTED');
    keys(packet.credentials,['accessKeyId','secretAccessKey','sessionToken','expiration']);const supplied=packet.credentials;
    requireCondition(typeof supplied.accessKeyId==='string'&&/^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId)
      &&typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0&&supplied.secretAccessKey.length<=256
      &&typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0&&supplied.sessionToken.length<=16384
      &&typeof supplied.expiration==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(supplied.expiration)
      &&new Date(supplied.expiration).getTime()>now()+120000,'PACKET_REJECTED');
    for(const name of ['cliConfigPath','cliCredentialsPath','caBundlePath'])requireCondition(typeof packet[name]==='string'&&isAbsolute(packet[name] as string),'PACKET_REJECTED');
    requireCondition(typeof packet.caBundleSha256==='string'&&/^[a-f0-9]{64}$/.test(packet.caBundleSha256),'PACKET_REJECTED');
    const credentials={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration)};
    const authority=await verifyClockRecoveryAuthority({manifestRaw,...original,authorizationRaw:packet.authorizationRaw,
      sourceRoot:parsed.sourceRoot,reviewRoot:parsed.reviewRoot,manifestPath:parsed.manifestPath,now});
    const manifest=readClockRecoveryAuthority(authority,now()),binary=pinnedAws(manifest.runtime);
    requireCondition(manifest.runtime.caBundleSha256===packet.caBundleSha256,'PACKET_REJECTED');
    const cfg={powershellExecutable:manifest.runtime.powershellExecutable,powershellSha256:manifest.runtime.powershellSha256};
    const journal=openDurableClockJournal({...cfg,directory:manifest.attemptJournal.directory});
    const prior=manifest.priorJournal?openDurableClockJournal({...cfg,directory:manifest.priorJournal.directory}):null;
    clients=nativeTransports({stage:manifest.clock.scope.stage,phase:'recovery',recoveryReadback:manifest.original!==null,
      caBundlePath:packet.caBundlePath as string,caBundleSha256:manifest.runtime.caBundleSha256,timeoutMs:10000});
    binary.check();
    const cli:ClockOwnershipCli=async(argv,options)=>{
      binary.check();
      if(ownershipCli)return ownershipCli(argv,options);
      const response=await nativeExec(binary.file,[...argv],{...options,encoding:'buffer',maxBuffer:2*1024*1024,windowsHide:true});
      return response.stdout;
    };
    const engine=await prepareClockRecoveryCaller({authority,journalDirectory:journal,priorJournalDirectory:prior,credentials,apiKey:packet.apiKey,
      cliConfigPath:packet.cliConfigPath as string,cliCredentialsPath:packet.cliCredentialsPath as string,
      caBundlePath:packet.caBundlePath as string,caBundleSha256:manifest.runtime.caBundleSha256,
      ownershipCli:cli,awsHandler:clients.aws,stripeClient:clients.stripe,now,requestTimeoutMs:10000});
    binary.check();const output=await engine.execute();
    result={exitCode:output.status==='observed'?0:output.status==='uncertain'?3:1,output};
  }catch(error){
    const code=error instanceof Error&&/^CLOCK_(?:RECOVERY|JOURNAL_STORE|NATIVE|HTTPS)_[A-Z_]+$/.test(error.message)
      ?error.message:'CLOCK_RECOVERY_CLI_FAILED';
    result={exitCode:2,output:{status:'rejected',code,retryAllowed:false,physicalExecutionAllowed:false}};
  }finally{
    try{clients?.destroy();}catch{result={exitCode:3,output:{...(result?.output??{}),status:'uncertain',step:'cleanup',
      code:'CLOCK_RECOVERY_CLI_CLEANUP_FAILED',retryAllowed:false,physicalExecutionAllowed:false}};}
  }
  return result!;
}
