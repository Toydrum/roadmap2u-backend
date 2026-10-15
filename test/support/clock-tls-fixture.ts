import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const ownedDirectories:string[]=[];
const servers:ReturnType<typeof createServer>[]=[];
const closers:(()=>void)[]=[];
export function ownedTlsDirectory(){const path=mkdtempSync(join(tmpdir(),'roadmap-clock-tls-'));ownedDirectories.push(path);return path;}
export function createTlsCertificate(wrongHost=false){
  const directory=ownedTlsDirectory();
  const pwsh=process.env.CLOCK_TEST_PWSH??process.env.USERPROFILE+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
  const result=spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',resolve('test/support/create-clock-tls-fixture.ps1')],
    {input:JSON.stringify({directory,wrongHost}),encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
  if(result.status!==0||result.stdout!=='SYNTHETIC_TLS_FIXTURE_CREATED')throw Error('LOCAL_TLS_FIXTURE_FAILED');
  const caBundlePath=join(directory,'ca.pem');
  return {directory,caBundlePath,caBundleSha256:createHash('sha256').update(readFileSync(caBundlePath)).digest('hex'),
    key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem'))};
}
export async function loadNativeTransportApi(){
  const entry=resolve('scripts/stripe-test-clock-native-transport.ts');
  if(!existsSync(entry))return {} as any;
  const output=join(ownedTlsDirectory(),'transport.mjs');
  buildSync({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  return import(pathToFileURL(output).href);
}
export async function tlsServer(certificate:ReturnType<typeof createTlsCertificate>,listener:RequestListener){
  let requests=0,tlsErrors=0;
  const server=createServer({key:certificate.key,cert:certificate.cert},(req,res)=>{requests++;listener(req,res);});
  servers.push(server);server.on('tlsClientError',()=>{tlsErrors++;});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw Error('LOOPBACK_ADDRESS_REQUIRED');
  return {origin:`https://127.0.0.1:${address.port}`,port:address.port,requests:()=>requests,tlsErrors:()=>tlsErrors};
}
export function ownTlsTransport(value:{destroy:()=>void}){closers.push(()=>value.destroy());return value;}
export async function closeTlsServers(){
  for(const close of closers.splice(0))close();
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));
}
export async function cleanupTlsFixtures(){
  await closeTlsServers();
  for(const directory of ownedDirectories.splice(0)){
    const target=realpathSync(directory),base=realpathSync(tmpdir());
    if(!target.toLowerCase().startsWith((base+sep).toLowerCase()))throw Error('OWNED_TLS_CLEANUP_REQUIRED');
    rmSync(target,{recursive:true,force:true});
  }
}
