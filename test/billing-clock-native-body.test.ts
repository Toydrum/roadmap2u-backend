import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CognitoIdentityProviderClient,AdminGetUserCommand} from '@aws-sdk/client-cognito-identity-provider';
const network=vi.hoisted(()=>({bodies:[] as Buffer[],requests:0}));
vi.mock('node:https',async()=>{
  const {EventEmitter}=await import('node:events');
  return {Agent:class {destroy(){}},request:(_options:unknown,response:(value:any)=>void)=>{
    network.requests++;const request=new EventEmitter() as any;request.destroy=()=>{};
    request.end=(body:Buffer)=>{network.bodies.push(Buffer.from(body));queueMicrotask(()=>{
      const reply=new EventEmitter() as any;reply.headers={'content-length':'2'};reply.statusCode=200;reply.complete=true;
      response(reply);reply.emit('data',Buffer.from('{}'));reply.emit('end');
    });};return request;
  }};
});
import {createPinnedClockHttps,createClockSdkHttpClients} from '../scripts/stripe-test-clock-native-transport';
const owned:string[]=[];
afterEach(()=>{for(const directory of owned.splice(0)){unlinkSync(join(directory,'synthetic-ca.txt'));rmdirSync(directory);}network.bodies=[];network.requests=0;});
it('copies a real SDK Uint8Array window to the native request without using a misleading string hook',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'clock-native-body-'));owned.push(directory);
  const ca=Buffer.from('SYNTHETIC_PUBLIC_CA_NOT_A_TLS_CERTIFICATE'),path=join(directory,'synthetic-ca.txt');writeFileSync(path,ca);
  const transport=createPinnedClockHttps({caBundlePath:path,caBundleSha256:createHash('sha256').update(ca).digest('hex'),
    origins:['https://synthetic.invalid'],maximumRequests:1,timeoutMs:1000});
  const clients=createClockSdkHttpClients(transport),sdk=new CognitoIdentityProviderClient({region:'us-east-1',endpoint:'https://synthetic.invalid',maxAttempts:1,
    credentials:{accessKeyId:'ASIA'+'A'.repeat(16),secretAccessKey:'synthetic-key',sessionToken:'synthetic-session'},requestHandler:clients.aws});
  let adapters=0,coercions=0;
  sdk.middlewareStack.add(next=>async context=>{
    const request=context.request as any,value=request.body;
    if(value instanceof Uint8Array){
      const padded=new Uint8Array(value.byteLength+16);padded.fill(0x78);padded.set(value,8);
      const Adapter=value.constructor as new(buffer:ArrayBufferLike,offset:number,length:number)=>Uint8Array;
      const view=new Adapter(padded.buffer,8,value.byteLength);
      Object.defineProperty(view,'valueOf',{value:()=>{coercions++;return '{"UserPoolId":"us-east-1_CROSSED","Username":"crossed"}';}});
      request.body=view;adapters++;
    }
    return next(context);
  },{name:'testNativeBodyWindow',step:'finalizeRequest',priority:'low'});
  try{
    expect((await sdk.send(new AdminGetUserCommand({UserPoolId:'us-east-1_SYNTHETIC',Username:'synthetic'}))).$metadata.httpStatusCode).toBe(200);
    expect(adapters).toBe(1);expect(coercions).toBe(0);expect(network.requests).toBe(1);
    expect(JSON.parse(network.bodies[0]!.toString())).toEqual({UserPoolId:'us-east-1_SYNTHETIC',Username:'synthetic'});
  }finally{sdk.destroy();transport.destroy();}
});
