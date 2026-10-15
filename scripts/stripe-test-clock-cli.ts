import { closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync } from 'node:fs';
import { isAbsolute,relative,resolve,sep } from 'node:path';
import type { Readable } from 'node:stream';
import { previewClockCallerPlan,readClockCallerAuthority,verifyClockCallerAuthority } from './stripe-test-clock-authority';
import { openDurableClockJournal } from './stripe-test-clock-durable-store';
import { prepareClockCaller } from './stripe-test-clock-caller';
import { prepareClockNativeTransports } from './stripe-test-clock-native-transport';
import type { ClockOwnershipCli } from './stripe-test-clock-ownership';

const MAX_INPUT=512*1024,MAX_MANIFEST=256*1024;
function requireCondition(ok:unknown,reason:string):asserts ok{if(!ok)throw Error('CLOCK_CLI_'+reason);}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value:unknown,names:string[]):asserts value is Record<string,unknown>{
  requireCondition(record(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name)),'PACKET_REJECTED');
}
/** No private value is accepted on argv. The actual process uses a private pipe,
 * with a byte/deadline bound and no echo, environment lookup or persistent copy. */
export function readClockCliInput(input:Readable,timeoutMs=10000):Promise<string>{
  requireCondition(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000,'INPUT_TIMEOUT');
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0,done=false;
    const timer=setTimeout(()=>finish('INPUT_TIMEOUT'),timeoutMs);
    function finish(reason?:string){
      if(done)return;done=true;clearTimeout(timer);input.removeListener('data',data);input.removeListener('end',ended);input.removeListener('error',failed);
      input.destroy();
      try{
        if(reason)throw Error('CLOCK_CLI_'+reason);
        const bytes=Buffer.concat(chunks,size);
        try{resolve(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}
        catch{reject(Error('CLOCK_CLI_INPUT_UTF8'));}finally{bytes.fill(0);}
      }catch(error){reject(error);}finally{for(const chunk of chunks)chunk.fill(0);chunks.length=0;}
    }
    function data(value:unknown){
      if(done)return;if(!(value instanceof Uint8Array)){finish('INPUT_REJECTED');return;}
      size+=value.byteLength;if(size>MAX_INPUT){finish('INPUT_LIMIT');return;}chunks.push(Buffer.from(value));
    }
    function ended(){finish();}function failed(){finish('INPUT_FAILED');}
    input.on('data',data);input.once('end',ended);input.once('error',failed);
  });
}
function argumentsFor(args:readonly string[]){
  requireCondition(Array.isArray(args)&&args.length===7&&['--preview','--execute'].includes(args[0]),'ARGUMENTS');
  const values:Record<string,string>={};
  for(let i=1;i<args.length;i+=2){
    const flag=args[i],value=args[i+1];
    requireCondition(['--source-root','--review-root','--manifest'].includes(flag)&&!Object.hasOwn(values,flag)&&
      typeof value==='string'&&value.length>0&&value.length<=512&&!value.startsWith('--'),'ARGUMENTS');values[flag]=value;
  }
  requireCondition(isAbsolute(values['--source-root'])&&isAbsolute(values['--review-root']),'ARGUMENTS');
  const manifestPath=values['--manifest'];
  requireCondition(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(manifestPath)&&
    !manifestPath.split('/').some(value=>['.','..','.git'].includes(value)),'ARGUMENTS');
  return {mode:args[0],sourceRoot:values['--source-root'],reviewRoot:values['--review-root'],manifestPath};
}
function manifestFile(reviewRoot:string,manifestPath:string){
  try{
    const root=realpathSync(reviewRoot),file=resolve(root,manifestPath),actual=realpathSync(file),inside=relative(root,actual);
    requireCondition(inside!==''&&!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..'+sep)&&!lstatSync(file).isSymbolicLink(),'MANIFEST_REJECTED');
    const fd=openSync(file,'r');
    try{
      const before=fstatSync(fd);requireCondition(before.isFile()&&before.size>0&&before.size<=MAX_MANIFEST,'MANIFEST_REJECTED');
      const bytes=Buffer.alloc(MAX_MANIFEST+1);let count=0;
      while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
      const after=fstatSync(fd);requireCondition(count<=MAX_MANIFEST&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'MANIFEST_REJECTED');
      return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count));
    }finally{closeSync(fd);}
  }catch{throw Error('CLOCK_CLI_MANIFEST_REJECTED');}
}
type NativeClients=Pick<ReturnType<typeof prepareClockNativeTransports>,'aws'|'stripe'|'destroy'|'counts'>;
interface CliPorts {now?:()=>number;nativeTransports?:(options:Parameters<typeof prepareClockNativeTransports>[0])=>NativeClients;ownershipCli?:ClockOwnershipCli}
interface CliResult {exitCode:number;output:Record<string,unknown>}
/** The process entry always uses the fixed native adapters. Constructor ports
 * exercise this same assembly locally; stdin cannot select adapters or a clock. */
export async function runClockCallerCli(args:readonly string[],packetRaw:string,ports:CliPorts={}):Promise<CliResult>{
  let clients:NativeClients|undefined,result:CliResult|undefined;
  try{
    const options=argumentsFor(args),now=ports.now??Date.now;
    requireCondition(typeof packetRaw==='string'&&Buffer.byteLength(packetRaw,'utf8')<=MAX_INPUT,'INPUT_LIMIT');
    let packet:unknown;try{packet=JSON.parse(packetRaw);}catch{throw Error('CLOCK_CLI_PACKET_REJECTED');}
    keys(packet,['schemaVersion','requestRaw',...(options.mode==='--execute'?['authorizationRaw','credentials','apiKey','cliConfigPath','cliCredentialsPath','caBundlePath']:[])]);
    requireCondition(packet.schemaVersion===1&&typeof packet.requestRaw==='string','PACKET_REJECTED');
    const manifestRaw=manifestFile(options.reviewRoot,options.manifestPath);
    if(options.mode==='--preview')return {exitCode:0,output:await previewClockCallerPlan({manifestRaw,requestRaw:packet.requestRaw,now})};
    requireCondition(typeof packet.authorizationRaw==='string'&&typeof packet.apiKey==='string'&&/^rk_test_[A-Za-z0-9]{8,256}$/.test(packet.apiKey),'PACKET_REJECTED');
    keys(packet.credentials,['accessKeyId','secretAccessKey','sessionToken','expiration']);
    const supplied=packet.credentials;
    requireCondition(typeof supplied.accessKeyId==='string'&&/^ASIA[A-Z0-9]{16}$/.test(supplied.accessKeyId)&&
      typeof supplied.secretAccessKey==='string'&&supplied.secretAccessKey.length>0&&supplied.secretAccessKey.length<=256&&
      typeof supplied.sessionToken==='string'&&supplied.sessionToken.length>0&&supplied.sessionToken.length<=16384&&typeof supplied.expiration==='string'&&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(supplied.expiration),'PACKET_REJECTED');
    for(const key of ['cliConfigPath','cliCredentialsPath','caBundlePath'])requireCondition(typeof packet[key]==='string'&&isAbsolute(packet[key] as string),'PACKET_REJECTED');
    const credentials={accessKeyId:supplied.accessKeyId,secretAccessKey:supplied.secretAccessKey,sessionToken:supplied.sessionToken,expiration:new Date(supplied.expiration)};
    const authority=await verifyClockCallerAuthority({manifestRaw,requestRaw:packet.requestRaw,authorizationRaw:packet.authorizationRaw,
      sourceRoot:options.sourceRoot,reviewRoot:options.reviewRoot,manifestPath:options.manifestPath,now});
    const manifest=readClockCallerAuthority(authority,now());
    requireCondition(manifest.journal&&manifest.runtime,'NATIVE_BINDING_REQUIRED');
    const journal=openDurableClockJournal({directory:manifest.journal.directory,powershellExecutable:manifest.runtime.powershellExecutable,powershellSha256:manifest.runtime.powershellSha256});
    clients=(ports.nativeTransports??prepareClockNativeTransports)({stage:manifest.clock.scope.stage,phase:manifest.phase,
      caBundlePath:packet.caBundlePath as string,caBundleSha256:manifest.runtime.caBundleSha256,timeoutMs:10000});
    const engine=await prepareClockCaller({authority,journalDirectory:journal,credentials,cliConfigPath:packet.cliConfigPath as string,
      cliCredentialsPath:packet.cliCredentialsPath as string,caBundlePath:packet.caBundlePath as string,caBundleSha256:manifest.runtime.caBundleSha256,
      awsHandler:clients.aws,stripeClient:clients.stripe,apiKey:packet.apiKey,now,ownershipCli:ports.ownershipCli,requestTimeoutMs:10000});
    const output=await engine.execute();
    result={exitCode:output.status==='uncertain'?3:output.status==='stopped'?1:0,output};
  }catch(error){
    const code=error instanceof Error&&/^CLOCK_(?:CLI|AUTHORITY|CALLER|JOURNAL_STORE|HTTPS|NATIVE)_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_CLI_FAILED';
    result={exitCode:2,output:{status:'rejected',code,retryAllowed:false,physicalExecutionAllowed:false}};
  }finally{
    try{clients?.destroy();}catch{result={exitCode:3,output:{status:'uncertain',code:'CLOCK_CLI_CLEANUP_FAILED',retryAllowed:false,physicalExecutionAllowed:false}};}
  }
  return result!;
}
