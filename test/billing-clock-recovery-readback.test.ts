import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { HttpRequest } from '@smithy/types';
import { clockJournalRequest } from './support/clock-journal-request';
import { prepareClockJournal } from '../scripts/stripe-test-clock-journal';
import { TEST_CLOCK_EVIDENCE_MAX_AGE_MS } from '../lambda/billing/clock';

const SECRET='synthetic-recovery-secret-never-emit';
async function prepare(options:any){
  const path=fileURLToPath(new URL('../scripts/stripe-test-clock-recovery-readback.ts',import.meta.url));
  const api:any=existsSync(path)?await vi.importActual(path):{};
  expect(api.prepareClockRecoveryReadback).toBeTypeOf('function');
  return api.prepareClockRecoveryReadback(options);
}
async function fixture(phase:'install'|'advance_fence'='install'){
  const {request,sourceSha}=await clockJournalRequest(phase),plan=await prepareClockJournal(request,sourceSha);
  const originalRequestRaw=JSON.stringify(request),requestSha256=createHash('sha256').update(originalRequestRaw).digest('hex');
  let now=request.clock.realNow+TEST_CLOCK_EVIDENCE_MAX_AGE_MS+100, destroyed=0;
  const seen:HttpRequest[]=[],reserved:string[]=[],responseItems=structuredClone(plan.expectedItems);
  const handler={destroy:()=>{destroyed++;},handle:async(wire:HttpRequest,_options?:any)=>{
    seen.push(wire);
    return{response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.0'},
      body:Buffer.from(JSON.stringify({Responses:responseItems.map(Item=>({Item:marshall(Item)}))}))}};
  }};
  const options:any={originalRequestRaw,requestSha256,sourceSha,savedIntent:structuredClone(plan.intent),
    credentials:{accessKeyId:'ASIA'+'A'.repeat(16),secretAccessKey:SECRET,sessionToken:'synthetic-recovery-session',expiration:new Date(now+3600000)},
    requestHandler:handler,now:()=>now,reserveWire:(kind:string)=>{reserved.push(kind);},requestTimeoutMs:1000};
  return{request,plan,options,handler,seen,reserved,responseItems,destroyed:()=>destroyed,setNow:(value:number)=>{now=value;}};
}
describe('read-only exact original recovery readback with actual SDK',()=>{
  it('captures credentials and delegate before asynchronous preparation yields',async()=>{
    const f=await fixture(),path=fileURLToPath(new URL('../scripts/stripe-test-clock-recovery-readback.ts',import.meta.url));
    const api:any=await vi.importActual(path),pending=api.prepareClockRecoveryReadback(f.options);
    f.options.credentials.sessionToken='changed-after-preparation-started';
    f.options.requestHandler={handle:()=>{throw Error('changed delegate during preparation');}};
    const reader=await pending;
    expect((await reader.observe()).status).toBe('verified_applied');expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.headers['x-amz-security-token']).toBe('synthetic-recovery-session');
  });
  it.each(['install','advance_fence'] as const)('reads only the original %s items after process evidence has expired',async phase=>{
    const f=await fixture(phase),reader=await prepare(f.options);expect(f.seen).toHaveLength(0);
    const result=await reader.observe();
    expect(result).toMatchObject({status:'verified_applied',reason:'EXACT_ATOMIC_READBACK',clockReadable:false,
      retryAllowed:false,physicalExecutionAllowed:false,physicalAuthorizationChecked:false,sourceShaVerified:false,
      wireReservations:{readback:1},wireDelegations:{readback:1}});
    expect(f.seen).toHaveLength(1);expect(f.reserved).toEqual(['readback']);expect(f.destroyed()).toBe(1);
    const wire=f.seen[0]!;expect(wire.hostname).toBe('dynamodb.us-east-1.amazonaws.com');
    expect(wire.headers['x-amz-target']).toBe('DynamoDB_20120810.TransactGetItems');
    const body=JSON.parse(Buffer.from(wire.body as string).toString());
    expect(body.TransactItems).toHaveLength(phase==='install'?4:2);expect(body).not.toHaveProperty('ClientRequestToken');
    const raw=JSON.stringify({result,preview:reader.preview,counts:reader.counts()});
    for(const privateValue of [SECRET,'synthetic-recovery-session','in-memory-only','TransactItems'])expect(raw).not.toContain(privateValue);
  });
  it.each(['raw_bytes','digest','intent','source','invalid_json','credentials','expired_credentials'] as const)('rejects %s before reading anything',async fault=>{
    const f=await fixture();
    if(fault==='raw_bytes')f.options.originalRequestRaw+=' ';
    if(fault==='digest')f.options.requestSha256='0'.repeat(64);
    if(fault==='intent')f.options.savedIntent.transactionSha256='0'.repeat(64);
    if(fault==='source')f.options.sourceSha='c'.repeat(40);
    if(fault==='invalid_json'){f.options.originalRequestRaw='{';f.options.requestSha256=createHash('sha256').update('{').digest('hex');}
    if(fault==='credentials')delete f.options.credentials.sessionToken;
    if(fault==='expired_credentials')f.options.credentials.expiration=new Date(0);
    await expect(prepare(f.options)).rejects.toThrow();expect(f.seen).toHaveLength(0);
  });
  it('captures original bytes, intent and delegate before options change',async()=>{
    const f=await fixture(),reader=await prepare(f.options);
    f.options.originalRequestRaw='changed';f.options.savedIntent.sourceSha='0'.repeat(40);
    f.options.credentials.secretAccessKey='changed';f.options.requestHandler={handle:()=>{throw Error('replaced delegate');}};
    expect((await reader.observe()).status).toBe('verified_applied');expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.headers.authorization).toContain('Credential=ASIA'+'A'.repeat(16));
  });
  it.each(['missing_item','changed_item','reordered_items'] as const)('keeps a %s observation uncertain',async fault=>{
    const f=await fixture();
    if(fault==='missing_item')f.responseItems.pop();
    if(fault==='changed_item')f.responseItems[0]!.revision=99;
    if(fault==='reordered_items')f.responseItems.reverse();
    const result=await (await prepare(f.options)).observe();
    expect(result).toMatchObject({status:'uncertain',clockReadable:false,retryAllowed:false,physicalExecutionAllowed:false});
    expect(f.seen).toHaveLength(1);
  });
  it('sanitizes a failed read without sending a write or retry',async()=>{
    const f=await fixture();f.handler.handle=async wire=>{f.seen.push(wire);throw Object.assign(Error(SECRET),{code:'ECONNRESET'});};
    const reader=await prepare(f.options),result=await reader.observe();
    expect(result.status).toBe('uncertain');expect(JSON.stringify(result)).not.toContain(SECRET);
    await expect(reader.observe()).rejects.toThrow('CLOCK_RECOVERY_READBACK_ALREADY_CONSUMED');
    expect(f.seen).toHaveLength(1);expect(f.destroyed()).toBe(1);
  });
  it.each(['throw','thenable'] as const)('rejects a %s reservation before delegation',async mode=>{
    const f=await fixture();f.options.reserveWire=()=>{
      if(mode==='throw')throw Error(SECRET);return Promise.reject(Error(SECRET));
    };
    const reader=await prepare(f.options),result=await reader.observe();
    expect(result).toMatchObject({status:'uncertain',wireReservations:{readback:1},wireDelegations:{readback:0}});
    expect(f.seen).toHaveLength(0);expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('bounds a stalled read and aborts its actual handler signal',async()=>{
    const f=await fixture();let signal:AbortSignal|undefined;
    f.options.requestTimeoutMs=10;f.handler.handle=async(wire,options)=>{
      f.seen.push(wire);signal=options?.abortSignal;return new Promise(()=>{});
    };
    const result=await (await prepare(f.options)).observe();
    expect(result.status).toBe('uncertain');expect(signal?.aborted).toBe(true);expect(f.seen).toHaveLength(1);expect(f.destroyed()).toBe(1);
  });
  it('does not turn a later expired observation into readable evidence',async()=>{
    const f=await fixture(),original=f.handler.handle;
    f.handler.handle=async(...args)=>{const result=await original(...args);f.setNow(f.options.now()+TEST_CLOCK_EVIDENCE_MAX_AGE_MS);return result;};
    expect(await (await prepare(f.options)).observe()).toMatchObject({status:'uncertain',clockReadable:false});expect(f.seen).toHaveLength(1);
  });
  it('returns a fixed cleanup failure without the transport error',async()=>{
    const f=await fixture();f.handler.destroy=()=>{throw Error(SECRET);};
    await expect((await prepare(f.options)).observe()).rejects.toThrow('CLOCK_RECOVERY_READBACK_CLEANUP_FAILED');expect(f.seen).toHaveLength(1);
  });
});
