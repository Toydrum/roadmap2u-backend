import { afterAll,describe,expect,it } from 'vitest';
import { AUTH_NOW,authorityFixture,cleanupAuthorityFixtures,digest } from './support/clock-authority-fixture';
export type ClockCallerPublicPreview=Awaited<ReturnType<typeof import('../scripts/stripe-test-clock-authority').previewClockCallerPlan>>;

afterAll(cleanupAuthorityFixtures);
describe('credential-free clock caller preview',()=>{
  for(const stage of ['dev','test'])for(const phase of ['install','ready','refresh','advance_fence'] as const){
    it(`previews the real ${stage} ${phase} plan without minting human authority`,async()=>{
      const f=await authorityFixture(stage,phase);
      expect(f.api.previewClockCallerPlan,'Missing public plan preview').toBeTypeOf('function');
      const {manifestRaw,requestRaw}=f.options();
      const result=await f.api.previewClockCallerPlan({manifestRaw,requestRaw,now:()=>AUTH_NOW});
      expect(result).toMatchObject({status:'preview',stage,phase,sourceSha:f.sourceSha,operationId:f.manifest.operationId,
        manifestSha256:digest(manifestRaw),requestSha256:digest(requestRaw),
        sourceShaVerified:false,authorizationReceiptBound:false,physicalExecutionAllowed:false,
        maximumRequests:phase==='install'?17:phase==='advance_fence'?20:16,maximumWrites:1,maximumProviderAdvances:phase==='advance_fence'?1:0});
      expect(result.transactionSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.readbackSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toMatch(/ownerSub|customerId|testClockId|TransactItems|ConditionExpression|secretAccessKey/);
      expect(()=>f.api.readClockCallerAuthority(result,AUTH_NOW)).toThrow('CLOCK_AUTHORITY_BOUND_CONTEXT_REQUIRED');
    });
  }
  it('rejects request bytes that differ from the reviewed digest',async()=>{
    const f=await authorityFixture();expect(f.api.previewClockCallerPlan).toBeTypeOf('function');
    await expect(f.api.previewClockCallerPlan({...f.options(),requestRaw:f.options().requestRaw+' ',now:()=>AUTH_NOW})).rejects.toThrow('CLOCK_AUTHORITY_REQUEST_BINDING_REJECTED');
  });
  it('rejects stale snapshots and unknown manifest fields with fixed error codes',async()=>{
    const f=await authorityFixture();expect(f.api.previewClockCallerPlan).toBeTypeOf('function');
    await expect(f.api.previewClockCallerPlan({...f.options(),now:()=>AUTH_NOW+900000})).rejects.toThrow('CLOCK_AUTHORITY_REQUEST_BINDING_REJECTED');
    await expect(f.api.previewClockCallerPlan({...f.options(),manifestRaw:JSON.stringify({...f.manifest,apiKey:'private-do-not-log'}),now:()=>AUTH_NOW})).rejects.toThrow('CLOCK_AUTHORITY_SHAPE_REJECTED');
  });
});
