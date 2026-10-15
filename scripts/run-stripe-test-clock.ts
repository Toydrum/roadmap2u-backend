import { readClockCliInput,runClockCallerCli } from './stripe-test-clock-cli';

// Trusted local orchestration supplies private stdin only after the human has
// approved the exact committed manifest. No receipt/key discovery or login.
try{
  if(process.stdin.isTTY)throw Error('CLOCK_CLI_PRIVATE_STDIN_REQUIRED');
  const packet=await readClockCliInput(process.stdin);
  const result=await runClockCallerCli(process.argv.slice(2),packet);
  process.stdout.write(JSON.stringify(result.output)+'\n');process.exitCode=result.exitCode;
}catch(error){
  const code=error instanceof Error&&/^CLOCK_CLI_[A-Z_]+$/.test(error.message)?error.message:'CLOCK_CLI_INPUT_FAILED';
  process.stdout.write(JSON.stringify({status:'rejected',code,retryAllowed:false,physicalExecutionAllowed:false})+'\n');process.exitCode=2;
}
