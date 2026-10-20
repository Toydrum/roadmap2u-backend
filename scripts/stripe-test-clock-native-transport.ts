import { Agent,request as httpsRequest } from 'node:https';
import type { ClientRequest,OutgoingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync } from 'node:fs';
import { Readable } from 'node:stream';
import type Stripe from 'stripe';
import type { ClockDynamoHandler } from './stripe-test-clock-dynamo-transport';

interface PinnedHttpsOptions {
  caBundlePath:string;caBundleSha256:string;origins:readonly string[];maximumRequests:number;
  timeoutMs:number;maximumResponseBytes?:number;maximumRequestBytes?:number;
}
interface HttpsWire {
  hostname:string;port?:number;path:string;method:string;headers:OutgoingHttpHeaders;body?:string|Uint8Array;
}
interface HttpsResponse {statusCode:number;headers:Record<string,string>;body:Buffer}
function requireCondition(ok:unknown,reason:string):asserts ok{if(!ok)throw Error('CLOCK_HTTPS_'+reason);}
function certificate(path:string,expected:string):Buffer {
  try{
    requireCondition(/^[a-f0-9]{64}$/.test(expected)&&lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),'CA');
    const fd=openSync(path,'r');
    try{
      const before=fstatSync(fd);requireCondition(before.isFile()&&before.size>0&&before.size<=256*1024,'CA');
      const bytes=Buffer.alloc(256*1024+1);let count=0;
      while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
      const after=fstatSync(fd),result=bytes.subarray(0,count);
      requireCondition(count<=256*1024&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&
        createHash('sha256').update(result).digest('hex')===expected,'CA');return result;
    }finally{closeSync(fd);}
  }catch{throw Error('CLOCK_HTTPS_CA');}
}
/** TLS primitive. Its explicit origins are useful for local loopback tests; the
 * physical factory below supplies only fixed AWS/Stripe endpoints. No authority,
 * credential lookup, redirect following, retry, proxy or global TLS mutation. */
export function createPinnedClockHttps(options:PinnedHttpsOptions){
  const path=options.caBundlePath,hash=options.caBundleSha256,initial=certificate(path,hash);
  let canonical:string;try{canonical=realpathSync(path);}catch{throw Error('CLOCK_HTTPS_CA');}
  const timeout=options.timeoutMs,maximum=options.maximumRequests,responseMaximum=options.maximumResponseBytes??2*1024*1024,
    requestMaximum=options.maximumRequestBytes??2*1024*1024;
  requireCondition(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=10000&&Number.isSafeInteger(maximum)&&maximum>0&&maximum<=20,'OPTIONS');
  requireCondition(Number.isSafeInteger(responseMaximum)&&responseMaximum>0&&responseMaximum<=2*1024*1024&&
    Number.isSafeInteger(requestMaximum)&&requestMaximum>0&&requestMaximum<=2*1024*1024,'OPTIONS');
  requireCondition(Array.isArray(options.origins)&&options.origins.length>0&&options.origins.length<=4,'SCOPE');
  const origins=new Set(options.origins.map(value=>{
    try{const u=new URL(value);requireCondition(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'SCOPE');return u.origin;}
    catch{throw Error('CLOCK_HTTPS_SCOPE');}
  }));
  const agent=new Agent({ca:initial,rejectUnauthorized:true,minVersion:'TLSv1.2',keepAlive:false,maxCachedSessions:0,maxSockets:1});
  const active=new Set<(reason:string)=>void>();let requests=0,closed=false;
  return {
    counts:()=>({requests,closed}),
    destroy(){if(closed)return;closed=true;for(const cancel of [...active])cancel('CLOSED');agent.destroy();},
    async request(input:HttpsWire,signal?:AbortSignal):Promise<HttpsResponse>{
      requireCondition(!closed,'CLOSED');
      requireCondition(typeof input.hostname==='string'&&Number.isSafeInteger(input.port??443)&&(input.port??443)>0&&(input.port??443)<=65535&&
        typeof input.path==='string'&&input.path.startsWith('/')&&input.path.length<=4096&&['GET','POST'].includes(input.method),'SCOPE');
      let origin:string;try{origin=new URL(`https://${input.hostname}:${input.port??443}`).origin;}catch{throw Error('CLOCK_HTTPS_SCOPE');}
      requireCondition(origins.has(origin),'SCOPE');
      requireCondition(input.body===undefined||typeof input.body==='string'||input.body instanceof Uint8Array,'BODY');
      requireCondition((typeof input.body==='string'?Buffer.byteLength(input.body):input.body?.byteLength??0)<=requestMaximum,'BODY');
      requireCondition(!signal||typeof signal.aborted==='boolean'&&typeof signal.addEventListener==='function','ABORTED');
      requireCondition(!signal?.aborted,'ABORTED');
      try{requireCondition(realpathSync(path)===canonical,'CA');certificate(path,hash);}catch{throw Error('CLOCK_HTTPS_CA');}
      requireCondition(requests<maximum,'LIMIT');requests++;
      const value=input.body??'';
      const body=typeof value==='string'?Buffer.from(value):Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
      const headers={...input.headers},hostname=input.hostname,port=input.port??443,method=input.method,urlPath=input.path;
      return new Promise<HttpsResponse>((resolve,reject)=>{
        let req:ClientRequest|undefined,done=false;const chunks:Buffer[]=[];let size=0;
        const cancel=(reason:string)=>finish(Error('CLOCK_HTTPS_'+reason));
        const aborted=()=>cancel('ABORTED');
        const timer=setTimeout(()=>cancel('TIMEOUT'),timeout);
        function finish(error?:Error,value?:HttpsResponse){
          if(done)return;done=true;clearTimeout(timer);active.delete(cancel);signal?.removeEventListener('abort',aborted);
          if(error){req?.destroy();chunks.length=0;reject(error);}else resolve(value!);
        }
        active.add(cancel);signal?.addEventListener('abort',aborted,{once:true});
        try{
          req=httpsRequest({hostname,port,path:urlPath,method,headers,agent,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384},res=>{
            const declared=res.headers['content-length'];
            if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>responseMaximum)){cancel('RESPONSE_LIMIT');return;}
            res.on('data',(chunk:Buffer)=>{
              if(done)return;size+=chunk.length;if(size>responseMaximum){cancel('RESPONSE_LIMIT');return;}chunks.push(Buffer.from(chunk));
            });
            res.on('error',()=>cancel('NETWORK'));res.on('aborted',()=>cancel('NETWORK'));
            res.on('close',()=>{if(!res.complete)cancel('NETWORK');});
            res.on('end',()=>{
              if(!res.complete){cancel('NETWORK');return;}
              const responseHeaders=Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]));
              finish(undefined,{statusCode:res.statusCode??0,headers:responseHeaders,body:Buffer.concat(chunks,size)});chunks.length=0;
            });
          });
          req.on('error',()=>cancel('NETWORK'));req.end(body);
        }catch{cancel('NETWORK');}
      });
    },
  };
}
type PinnedClockHttps=ReturnType<typeof createPinnedClockHttps>;
/** Preserve the installed SDK interfaces while consuming a complete bounded
 * response. getRawResponse exposes metadata, not the socket/request/headers sent. */
export function createClockSdkHttpClients(transport:PinnedClockHttps){
  const aws:ClockDynamoHandler={destroy:()=>transport.destroy(),handle:async(wire,options)=>{
    requireCondition(wire.protocol==='https:'&&(!wire.query||Object.keys(wire.query).length===0),'SCOPE');
    const response=await transport.request({hostname:wire.hostname,port:wire.port,path:wire.path,method:wire.method,
      headers:wire.headers,body:wire.body},options?.abortSignal as AbortSignal|undefined);
    return {response};
  }};
  const stripe:Stripe.HttpClient={getClientName:()=> 'roadmap2u-pinned-native-https',makeRequest:async(host,port,path,method,headers,data,protocol)=>{
    requireCondition(protocol==='https','SCOPE');
    const response=await transport.request({hostname:host,port:Number(port),path,method,headers,body:data});
    return {getStatusCode:()=>response.statusCode,getHeaders:()=>({...response.headers}),getRawResponse:()=>({statusCode:response.statusCode,headers:{...response.headers}}),
      toStream:complete=>{const stream=Readable.from([response.body]);stream.once('end',complete);return stream;},
      toJSON:async()=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body));}catch{throw Error('CLOCK_NATIVE_JSON_REJECTED');}}};
  }};
  return {aws,stripe,destroy:()=>transport.destroy()};
}
export function prepareClockNativeTransports(options:{stage:string;phase:string;caBundlePath:string;caBundleSha256:string;timeoutMs?:number;recoveryReadback?:boolean}){
  if(!['dev','test'].includes(options.stage))throw Error('CLOCK_NATIVE_STAGE');
  if(!['install','ready','refresh','advance_fence','recovery'].includes(options.phase))throw Error('CLOCK_NATIVE_PHASE');
  if(options.phase==='recovery'&&typeof options.recoveryReadback!=='boolean'||options.phase!=='recovery'&&options.recoveryReadback!==undefined)throw Error('CLOCK_NATIVE_RECOVERY_OPTIONS');
  const maximum=options.phase==='recovery'?(options.recoveryReadback?10:9):options.phase==='install'?11:options.phase==='advance_fence'?14:10;
  const transport=createPinnedClockHttps({caBundlePath:options.caBundlePath,caBundleSha256:options.caBundleSha256,timeoutMs:options.timeoutMs??10000,
    maximumRequests:maximum,origins:['https://sts.us-east-1.amazonaws.com','https://dynamodb.us-east-1.amazonaws.com','https://cognito-idp.us-east-1.amazonaws.com','https://api.stripe.com']});
  return {...createClockSdkHttpClients(transport),counts:transport.counts,
    preview:Object.freeze({stage:options.stage,phase:options.phase,maximumSdkRequests:maximum,physicalAuthorizationChecked:false})};
}
