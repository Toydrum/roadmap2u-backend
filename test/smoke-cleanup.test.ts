import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const smokeCleanupScriptPath = join(process.cwd(), 'scripts', 'aws-smoke-cleanup.ps1');
const smokeUsername = 'smoke_empty';
const smokeUserId = '00000000-0000-4000-8000-000000000001';
const userPoolId = 'us-east-1_TESTPOOL';

function runSmokeCleanupWithEmptyPartition() {
  const fakeDirectory = mkdtempSync(join(tmpdir(), 'roadmap2u-fake-smoke-cleanup-'));
  const windows = process.platform === 'win32';
  const fakeAwsPath = join(fakeDirectory, windows ? 'aws.cmd' : 'aws');
  const caBundlePath = join(fakeDirectory, 'trusted-ca.pem');
  const callsPath = join(fakeDirectory, 'calls.log');
  const fakeAws = windows
    ? `@echo off
if "%~1"=="--version" (
  echo aws-cli/2.36.4 Python/3.13 Windows/11 exe/AMD64
  exit /b 0
)
if "%~1"=="configure" (
  echo %FAKE_PROFILE_CA_BUNDLE%
  exit /b 0
)
if "%~1"=="sts" (
  if "%~2"=="get-caller-identity" (
    echo {"UserId":"AIDATEST","Account":"765932874577","Arn":"arn:aws:iam::765932874577:user/Hector-admin"}
    exit /b 0
  )
  if "%~2"=="assume-role" (
    echo {"AccessKeyId":"ASIATEST","SecretAccessKey":"secret","SessionToken":"token"}
    exit /b 0
  )
)
if "%~1"=="ssm" (
  echo ${userPoolId}
  exit /b 0
)
if "%~1"=="cognito-idp" (
  if "%~2"=="admin-get-user" (
    echo {"Username":"${smokeUsername}","UserAttributes":[{"Name":"sub","Value":"${smokeUserId}"}]}
    exit /b 0
  )
  if "%~2"=="admin-delete-user" (
    echo cognito-delete-user>>"%FAKE_AWS_CALLS_LOG%"
    exit /b 0
  )
)
if "%~1"=="dynamodb" (
  if "%~2"=="query" (
    echo %* | findstr /C:"--consistent-read" >nul
    if errorlevel 1 exit /b 11
    echo dynamodb-query>>"%FAKE_AWS_CALLS_LOG%"
    echo {"Items":[]}
    exit /b 0
  )
  if "%~2"=="delete-item" (
    echo dynamodb-delete-item>>"%FAKE_AWS_CALLS_LOG%"
    exit /b 0
  )
)
exit /b 2
`
    : `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "aws-cli/2.36.4 Python/3.13 Linux/amd64"
  exit 0
fi
if [[ "$1" == "configure" ]]; then
  echo "$FAKE_PROFILE_CA_BUNDLE"
  exit 0
fi
if [[ "$1" == "sts" ]]; then
  if [[ "$2" == "get-caller-identity" ]]; then
    echo '{"UserId":"AIDATEST","Account":"765932874577","Arn":"arn:aws:iam::765932874577:user/Hector-admin"}'
    exit 0
  fi
  if [[ "$2" == "assume-role" ]]; then
    echo '{"AccessKeyId":"ASIATEST","SecretAccessKey":"secret","SessionToken":"token"}'
    exit 0
  fi
fi
if [[ "$1" == "ssm" ]]; then
  echo '${userPoolId}'
  exit 0
fi
if [[ "$1" == "cognito-idp" ]]; then
  if [[ "$2" == "admin-get-user" ]]; then
    echo '{"Username":"${smokeUsername}","UserAttributes":[{"Name":"sub","Value":"${smokeUserId}"}]}'
    exit 0
  fi
  if [[ "$2" == "admin-delete-user" ]]; then
    echo 'cognito-delete-user' >> "$FAKE_AWS_CALLS_LOG"
    exit 0
  fi
fi
if [[ "$1" == "dynamodb" ]]; then
  if [[ "$2" == "query" ]]; then
    [[ "$*" == *"--consistent-read"* ]] || exit 11
    echo 'dynamodb-query' >> "$FAKE_AWS_CALLS_LOG"
    echo '{"Items":[]}'
    exit 0
  fi
  if [[ "$2" == "delete-item" ]]; then
    echo 'dynamodb-delete-item' >> "$FAKE_AWS_CALLS_LOG"
    exit 0
  fi
fi
exit 2
`;

  try {
    writeFileSync(fakeAwsPath, fakeAws, 'utf8');
    writeFileSync(caBundlePath, 'test-ca', 'utf8');
    if (!windows) chmodSync(fakeAwsPath, 0o755);

    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    environment[pathKey] = `${fakeDirectory}${delimiter}${environment[pathKey] ?? ''}`;
    environment.FAKE_PROFILE_CA_BUNDLE = caBundlePath;
    environment.FAKE_AWS_CALLS_LOG = callsPath;
    environment.AWS_PROFILE = 'ambient-profile';
    environment.AWS_DEFAULT_PROFILE = 'ambient-default-profile';
    delete environment.AWS_CA_BUNDLE;

    const result = spawnSync(windows ? 'powershell.exe' : 'pwsh', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      smokeCleanupScriptPath,
      '-Stage',
      'dev',
      '-UserPoolId',
      userPoolId,
      '-Username',
      smokeUsername,
      '-UserId',
      smokeUserId,
      '-Confirmation',
      `DELETE SMOKE dev ${smokeUsername}`,
      '-MfaCode',
      '123456',
      '-AdminProfile',
      'mock-profile',
    ], {
      encoding: 'utf8',
      env: environment,
      timeout: 15_000,
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
      calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '',
    };
  } finally {
    rmSync(fakeDirectory, { recursive: true, force: true });
  }
}

describe('MFA smoke cleanup', () => {
  it('skips user-partition deletes when DynamoDB is already empty', () => {
    const result = runSmokeCleanupWithEmptyPartition();
    const output = `${result.stdout}\n${result.stderr}`;
    const calls = result.calls.trim().split(/\r?\n/);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      'dynamodb-query',
      'dynamodb-delete-item',
      'dynamodb-query',
      'cognito-delete-user',
    ]);
    expect(output).toContain(`Deleted Cognito user ${smokeUsername} and its dev DynamoDB records.`);
  }, 20_000);
});
