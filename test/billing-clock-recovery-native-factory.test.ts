import { afterAll,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { basename,join,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import { prepareClockNativeTransports } from '../scripts/stripe-test-clock-native-transport';
const parent=mkdtempSync(join(tmpdir(),'clock-recovery-runtime-')),ca=join(parent,'public-ca.pem');
writeFileSync(ca,rootCertificates[0]);
const hash=createHash('sha256').update(readFileSync(ca)).digest('hex');
afterAll(()=>{
  const target=realpathSync(parent),base=realpathSync(tmpdir()),st=lstatSync(parent);
  if(!st.isDirectory()||st.isSymbolicLink()||!target.toLowerCase().startsWith((base+sep).toLowerCase())
    ||!/^clock-recovery-runtime-[A-Za-z0-9_-]+$/.test(basename(target)))throw Error('UNSAFE_TEST_CLEANUP');
  rmSync(target,{recursive:true,force:true});
});
it.each(['dev','test'].flatMap(stage=>[false,true].map(original=>[stage,original] as const)))('binds %s recovery SDK cap original=%s without network', (stage,original)=>{
  const clients=prepareClockNativeTransports({stage,phase:'recovery',recoveryReadback:original,caBundlePath:ca,caBundleSha256:hash} as any);
  expect(clients.preview).toMatchObject({stage,phase:'recovery',maximumSdkRequests:original?10:9});
  expect(clients.counts().requests).toBe(0);clients.destroy();expect(clients.counts().closed).toBe(true);
});
it.each([undefined,'yes',1])('rejects a non-boolean recovery readback selection %s',value=>{
  expect(()=>prepareClockNativeTransports({stage:'dev',phase:'recovery',recoveryReadback:value,caBundlePath:ca,caBundleSha256:hash} as any))
    .toThrow('CLOCK_NATIVE_RECOVERY_OPTIONS');
});
