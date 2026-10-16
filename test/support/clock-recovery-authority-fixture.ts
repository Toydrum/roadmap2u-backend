import { createHash } from 'node:crypto';
import { lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { basename,join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AUTH_NOW, authorityFixture } from './clock-authority-fixture';
import { prepareClockJournal } from '../../scripts/stripe-test-clock-journal';

const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const nativeParents:string[]=[];
export async function recoveryAuthorityFixture(stage='dev',original=false,native=false){
  const f=await authorityFixture(stage,'install',native);
  const manifest:any={
    schemaVersion:1,kind:'clock_recovery_read_only',sourceSha:f.sourceSha,operationId:'native_recovery_inventory_1',
    clock:structuredClone(f.manifest.clock),storage:structuredClone(f.manifest.storage),expectedCallerArn:f.manifest.expectedCallerArn,
    cloudformation:structuredClone(f.manifest.cloudformation),
    attemptJournal:{directory:'C:/synthetic/recovery-attempts',directoryId:'1'.repeat(64),aclSha256:'2'.repeat(64)},
    priorJournal:original?{directory:'C:/synthetic/financial-journal',directoryId:'3'.repeat(64),aclSha256:'4'.repeat(64)}:null,
    runtime:{powershellExecutable:'C:/synthetic/pwsh.exe',powershellSha256:'5'.repeat(64),caBundleSha256:f.privateFiles.caBundleSha256},
    original:null,
  };
  let journal:any,prior:any;
  if(native){
    const parent=mkdtempSync(join(tmpdir(),'roadmap-clock-durable-'));nativeParents.push(parent);
    const pwsh=process.env.CLOCK_TEST_PWSH??process.env.USERPROFILE+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
    const protection=spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',resolve('test/support/protect-clock-journal-test-parent.ps1')],
      {input:parent,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
    if(protection.status!==0)throw Error('TEST_PRIVATE_PARENT_REQUIRED');
    const base={powershellExecutable:realpathSync(pwsh),powershellSha256:digest(readFileSync(pwsh))};
    journal=f.api.initializeDurableClockJournal({...base,directory:join(parent,'protected','recovery-attempts')});
    if(original)prior=f.api.initializeDurableClockJournal({...base,directory:join(parent,'protected','financial-journal')});
    manifest.attemptJournal={...journal};manifest.priorJournal=prior?{...prior}:null;
    manifest.runtime={...base,caBundleSha256:f.privateFiles.caBundleSha256};
  }
  const originalRequestRaw=original?JSON.stringify(f.request):undefined;
  const plan=original?await prepareClockJournal(f.request,f.sourceSha):undefined;
  const savedIntent=plan?structuredClone(plan.intent):undefined;
  if(plan)manifest.original={sourceSha:f.sourceSha,requestSha256:digest(originalRequestRaw!),intentSha256:digest(JSON.stringify(savedIntent)),reservationId:plan.intent.reservationId};
  if(prior)f.api.writeDurableClockJournalFile(prior,plan!.intent.reservationId+'.intent.json',savedIntent);
  const receipt:any={source:'direct_human_async_reply',callId:'call_LOCAL_RECOVERY_TEST_ONLY',consumed:false,
    answer:'Autorizar recuperación '+stage.toUpperCase()+' solo lectura '+manifest.operationId,
    manifestSha256:'',approvedRootCommit:'',issuedAt:AUTH_NOW-1000,expiresAt:AUTH_NOW+899000};
  let raw='',current=AUTH_NOW;
  function freezeReview(){
    raw=JSON.stringify(manifest,null,2)+'\n';
    writeFileSync(join(f.reviewRoot,'reports/clock-recovery-manifest.json'),raw);
    f.git(f.reviewRoot,['add','.']);f.git(f.reviewRoot,['commit','--allow-empty','-qm','Synthetic reviewed recovery manifest']);
    receipt.manifestSha256=digest(raw);receipt.approvedRootCommit=f.git(f.reviewRoot,['rev-parse','HEAD']);
  }
  freezeReview();
  return{...f,manifest,receipt,journal,prior,savedIntent,originalRequestRaw,freezeReview,setNow:(value:number)=>{current=value;},
    recoveryOptions:()=>({manifestRaw:raw,authorizationRaw:JSON.stringify(receipt),sourceRoot:f.sourceRoot,reviewRoot:f.reviewRoot,
      manifestPath:'reports/clock-recovery-manifest.json',now:()=>current,...(original?{originalRequestRaw,savedIntent}: {})})};
}
export function cleanupRecoveryAuthorityFixtures(){
  const base=realpathSync(tmpdir());
  for(const parent of nativeParents.splice(0)){
    const st=lstatSync(parent),target=realpathSync(parent);
    if(!st.isDirectory()||st.isSymbolicLink()||!target.toLowerCase().startsWith((base+sep).toLowerCase())
      ||!/^roadmap-clock-durable-[A-Za-z0-9_-]+$/.test(basename(target)))throw Error('UNSAFE_TEST_CLEANUP');
    rmSync(target,{recursive:true,force:true});
  }
}
