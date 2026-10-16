import { readClockCliInput } from './stripe-test-clock-cli';
import { runClockRecoveryCli } from './stripe-test-clock-recovery-cli';
// The reviewed coordinator supplies secrets only in private stdin.
try{
  if(process.stdin.isTTY)throw Error('CLOCK_RECOVERY_CLI_PRIVATE_STDIN_REQUIRED');
  const packet=await readClockCliInput(process.stdin),result=await runClockRecoveryCli(process.argv.slice(2),packet);
  process.stdout.write(JSON.stringify(result.output)+'\n');process.exitCode=result.exitCode;
}catch(error){
  const code=error instanceof Error&&/^CLOCK_(?:RECOVERY_CLI|CLI)_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_RECOVERY_CLI_INPUT_FAILED';
  process.stdout.write(JSON.stringify({status:'rejected',code,retryAllowed:false,physicalExecutionAllowed:false})+'\n');process.exitCode=2;
}
