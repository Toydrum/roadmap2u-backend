import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { copyFileSync,readFileSync,unlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient,GetItemCommand } from '@aws-sdk/client-dynamodb';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../lambda/billing/model';
export type NativeClockTransports=ReturnType<typeof import('../scripts/stripe-test-clock-native-transport').prepareClockNativeTransports>;
import { cleanupTlsFixtures,closeTlsServers,createTlsCertificate,loadNativeTransportApi,ownedTlsDirectory,ownTlsTransport,tlsServer } from './support/clock-tls-fixture';

let api:any,certificate:ReturnType<typeof createTlsCertificate>,other:ReturnType<typeof createTlsCertificate>,wrongHost:ReturnType<typeof createTlsCertificate>;
beforeAll(async()=>{api=await loadNativeTransportApi();certificate=createTlsCertificate();other=createTlsCertificate();wrongHost=createTlsCertificate(true);},30000);
afterEach(closeTlsServers);afterAll(cleanupTlsFixtures);
function transport(origin:string,extra:Record<string,unknown>={}){
  expect(api.createPinnedClockHttps,'Missing native HTTPS transport').toBeTypeOf('function');
  const value=api.createPinnedClockHttps({...certificate,origins:[origin],maximumRequests:2,timeoutMs:1000,maximumResponseBytes:2048,...extra});
  ownTlsTransport(value);return value;
}
function wire(server:{port:number},extra:Record<string,unknown>={}){return {hostname:'127.0.0.1',port:server.port,path:'/',method:'GET',headers:{},body:'',...extra};}
describe.runIf(process.platform==='win32')('real native TLS with synthetic loopback certificates and no cloud credentials',()=>{
  it('sends once over verified TLS, reads the full response and refuses a second attempt',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.end('{"ok":true}')),t=transport(s.origin,{maximumRequests:1});
    expect(s.requests()).toBe(0);expect(t.counts().requests).toBe(0);
    const r=await t.request(wire(s));expect(r.statusCode).toBe(200);expect(r.body.toString()).toBe('{"ok":true}');
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_LIMIT');expect(s.requests()).toBe(1);expect(s.tlsErrors()).toBe(0);
  });
  it('rejects an unpinned CA before any socket request',async()=>{
    expect(api.createPinnedClockHttps,'Missing native HTTPS transport').toBeTypeOf('function');
    expect(()=>api.createPinnedClockHttps({...certificate,caBundleSha256:'0'.repeat(64),origins:['https://api.stripe.com'],maximumRequests:1,timeoutMs:1000})).toThrow('CLOCK_HTTPS_CA');
  });
  it('rejects a different certificate authority without reaching the HTTP handler',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.end('{}')),t=transport(s.origin,other);
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_NETWORK');
    expect(s.requests()).toBe(0);await vi.waitFor(()=>expect(s.tlsErrors()).toBeGreaterThan(0));
  });
  it('rejects a trusted certificate for another host',async()=>{
    const s=await tlsServer(wrongHost,(_req,res)=>res.end('{}')),t=transport(s.origin,wrongHost);
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_NETWORK');expect(s.requests()).toBe(0);
  });
  it('stops before opening a socket when its pinned file changes',async()=>{
    const copy=join(ownedTlsDirectory(),'ca.pem');copyFileSync(certificate.caBundlePath,copy);
    const s=await tlsServer(certificate,(_req,res)=>res.end('{}')),t=transport(s.origin,{caBundlePath:copy});
    writeFileSync(copy,readFileSync(other.caBundlePath));
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_CA');expect(s.requests()).toBe(0);
  });
  it('conceals a missing CA path and stops before opening a socket',async()=>{
    const copy=join(ownedTlsDirectory(),'private-ca-file.pem');copyFileSync(certificate.caBundlePath,copy);
    const s=await tlsServer(certificate,(_req,res)=>res.end('{}')),t=transport(s.origin,{caBundlePath:copy});unlinkSync(copy);
    const error=await t.request(wire(s)).catch((value:Error)=>value);
    expect(error.message).toBe('CLOCK_HTTPS_CA');expect(String(error)).not.toContain(copy);expect(t.counts().requests).toBe(0);expect(s.requests()).toBe(0);
  });
  it('refuses foreign origins and oversized request bodies without a send',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.end('{}')),t=transport(s.origin,{maximumRequestBytes:16});
    await expect(t.request(wire(s,{hostname:'api.stripe.com',port:443}))).rejects.toThrow('CLOCK_HTTPS_SCOPE');
    await expect(t.request(wire(s,{method:'POST',body:'x'.repeat(17)}))).rejects.toThrow('CLOCK_HTTPS_BODY');
    expect(s.requests()).toBe(0);expect(t.counts().requests).toBe(0);
  });
  it('does not follow redirects to a different origin',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.writeHead(302,{location:'https://api.stripe.com/v1/account'}).end()),t=transport(s.origin);
    expect((await t.request(wire(s))).statusCode).toBe(302);expect(s.requests()).toBe(1);expect(t.counts().requests).toBe(1);
  });
  it('bounds chunked response bytes and conceals their content in errors',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>{res.write('private-response'.repeat(64));res.end('tail');}),t=transport(s.origin,{maximumResponseBytes:32});
    const e=await t.request(wire(s)).catch((x:Error)=>x);expect(e.message).toBe('CLOCK_HTTPS_RESPONSE_LIMIT');expect(String(e)).not.toContain('private-response');expect(t.counts().requests).toBe(1);
  });
  it('destroys a connection that stalls after response headers',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();res.write('{');}),t=transport(s.origin,{timeoutMs:500});
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_TIMEOUT');expect(t.counts().requests).toBe(1);
  });
  it('rejects a truncated response without returning its private partial body',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>{res.writeHead(200,{'content-length':'100'});res.write('private-partial');res.socket?.destroy();}),t=transport(s.origin);
    const error=await t.request(wire(s)).catch((value:Error)=>value);
    expect(error.message).toBe('CLOCK_HTTPS_NETWORK');expect(String(error)).not.toContain('private-partial');expect(t.counts().requests).toBe(1);
  });
  it('deterministically closes an in-flight request without retry',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>{res.write('{');}),t=transport(s.origin);
    const outcome=t.request(wire(s)).then(()=>null,(error:Error)=>error);
    try{await vi.waitFor(()=>expect(s.requests()).toBe(1));}finally{t.destroy();await outcome;}
    expect((await outcome)?.message).toBe('CLOCK_HTTPS_CLOSED');expect(t.counts()).toEqual({requests:1,closed:true});
  });
  it('propagates cancellation before and during a request without retry',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>{res.write('{');}),t=transport(s.origin);
    const before=new AbortController();before.abort();await expect(t.request(wire(s),before.signal)).rejects.toThrow('CLOCK_HTTPS_ABORTED');
    expect(s.requests()).toBe(0);const during=new AbortController();
    const outcome=t.request(wire(s),during.signal).then(()=>null,(error:Error)=>error);
    try{await vi.waitFor(()=>expect(s.requests()).toBe(1));}finally{during.abort();await outcome;}
    expect((await outcome)?.message).toBe('CLOCK_HTTPS_ABORTED');expect(t.counts().requests).toBe(1);
  });
  it('rejects use after deterministic transport cleanup',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.end('{}')),t=transport(s.origin);t.destroy();t.destroy();
    await expect(t.request(wire(s))).rejects.toThrow('CLOCK_HTTPS_CLOSED');expect(s.requests()).toBe(0);
  });
  it('carries the real DynamoDB SDK signing/serialization and Stripe SDK response decoding over TLS',async()=>{
    const bodies:string[]=[];
    const s=await tlsServer(certificate,(req,res)=>{
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        bodies.push(body);res.setHeader('content-type','application/json');
        res.setHeader('request-id','req_local_synthetic');res.setHeader('stripe-version',STRIPE_API_VERSION);
        if(req.url==='/v1/account')res.end('{"id":"acct_synthetic","object":"account","country":"MX"}');
        else res.end('{"Item":{"pk":{"S":"synthetic"}}}');
      });
    }),t=transport(s.origin);expect(api.createClockSdkHttpClients).toBeTypeOf('function');
    const clients=api.createClockSdkHttpClients(t),ddb=new DynamoDBClient({region:'us-east-1',endpoint:s.origin,maxAttempts:1,
      credentials:{accessKeyId:'ASIA'+'A'.repeat(16),secretAccessKey:'synthetic-key',sessionToken:'synthetic-session'},requestHandler:clients.aws});
    const stripe=new Stripe('rk_test_localSynthetic',{apiVersion:STRIPE_API_VERSION,host:'127.0.0.1',port:s.port,protocol:'https',telemetry:false,maxNetworkRetries:0,httpClient:clients.stripe});
    try{
      expect((await ddb.send(new GetItemCommand({TableName:'synthetic',Key:{pk:{S:'synthetic'}}}))).Item?.pk.S).toBe('synthetic');
      const account=await stripe.accounts.retrieve(null);expect(account.id).toBe('acct_synthetic');expect(account.lastResponse.statusCode).toBe(200);
      expect(JSON.stringify(account.lastResponse)).not.toMatch(/rk_test_|ASIA|synthetic-session/);expect(s.requests()).toBe(2);expect(bodies[0]).toContain('TableName');
    }finally{ddb.destroy();}
  });
  it('prepares only fixed DEV/TEST AWS and Stripe origins and rejects PROD before sends',async()=>{
    expect(api.prepareClockNativeTransports,'Missing fixed native transport factory').toBeTypeOf('function');
    const options={...certificate,stage:'dev',phase:'install'},clients=api.prepareClockNativeTransports(options);ownTlsTransport(clients);
    expect(clients.preview).toMatchObject({stage:'dev',maximumSdkRequests:11,physicalAuthorizationChecked:false});
    await expect(clients.aws.handle({protocol:'https:',hostname:'127.0.0.1',port:443,method:'POST',path:'/',headers:{},body:''})).rejects.toThrow('CLOCK_HTTPS_SCOPE');
    expect(()=>api.prepareClockNativeTransports({...options,stage:'prod'})).toThrow('CLOCK_NATIVE_STAGE');
  });
  it('conceals invalid Stripe JSON while exposing only response metadata',async()=>{
    const s=await tlsServer(certificate,(_req,res)=>res.end('private-invalid-json')),t=transport(s.origin),clients=api.createClockSdkHttpClients(t);
    const response=await clients.stripe.makeRequest('127.0.0.1',String(s.port),'/', 'GET',{authorization:'Bearer private-test-key'},'', 'https');
    await expect(response.toJSON()).rejects.toThrow('CLOCK_NATIVE_JSON_REJECTED');
    expect(Object.keys(response.getRawResponse()).sort()).toEqual(['headers','statusCode']);
    expect(JSON.stringify(response.getRawResponse())).not.toMatch(/private-test-key|private-invalid-json/);
  });
});
