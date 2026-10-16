import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_NOW } from './clock-authority-fixture';
import { recoveryAuthorityFixture } from './clock-recovery-authority-fixture';
import { recoveryCallerFixture } from './clock-recovery-caller-fixture';
export type RecoveryCli=typeof import('../../scripts/stripe-test-clock-recovery-cli').runClockRecoveryCli;
export async function recoveryCliFixture(stage='dev',original=false,execute=true){
  const f=execute?await recoveryCallerFixture(stage,original):await recoveryAuthorityFixture(stage,original,false);
  const aws=join(f.root,'aws.exe');writeFileSync(aws,'SYNTHETIC_AWS_BINARY_ONLY\n');
  // Preview is portable but reviews a Windows-native runtime even on Linux CI.
  // Only native execute needs a real owned binary file for its hash checks.
  if(execute){
    f.manifest.runtime.awsCliExecutable=aws;
    f.manifest.runtime.awsCliSha256=createHash('sha256').update('SYNTHETIC_AWS_BINARY_ONLY\n').digest('hex');
  }
  f.freezeReview();
  const privateOriginal=original?{originalRequestRaw:f.originalRequestRaw,savedIntent:f.savedIntent}:{};
  const previewPacket={schemaVersion:1,...privateOriginal},executePacket=execute?{
    ...previewPacket,authorizationRaw:f.recoveryOptions().authorizationRaw,
    credentials:{...f.credentials,expiration:f.credentials.expiration.toISOString()},
    apiKey:'rk_test_clockRecoverySynthetic',...f.privateFiles,
  }:null;
  const args=(mode='--execute')=>[mode,'--source-root',f.sourceRoot,'--review-root',f.reviewRoot,'--manifest','reports/clock-recovery-manifest.json'];
  const factories:any[]=[];let closed=false;
  const nativeTransports=(options:any)=>{
    factories.push(options);
    const close=()=>{if(!closed){closed=true;f.options.awsHandler.destroy();}};
    return{aws:{handle:f.options.awsHandler.handle,destroy:close},stripe:f.options.stripeClient,destroy:close,
      counts:()=>({requests:f.aws.length+f.stripe.length,closed}),preview:{stage,phase:'recovery',maximumSdkRequests:original?10:9,physicalAuthorizationChecked:false}};
  };
  return{...f,awsBinary:aws,previewPacket,executePacket,args,factories,
    ports:{now:()=>AUTH_NOW,nativeTransports,ownershipCli:execute?f.options.ownershipCli:undefined}};
}
