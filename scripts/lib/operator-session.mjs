import { execFileSync } from 'node:child_process';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export const OPERATOR_ACCOUNT = '765932874577';
export const OPERATOR_REGION = 'us-east-1';
export const OPERATOR_SESSION_SECONDS = 3_600;
export const OPERATOR_MFA_WINDOW_SECONDS = 28_800;
const STAGES = ['dev', 'test', 'prod'];
const PURPOSES = Object.freeze({ migration: 'commercial-migration', flags: 'commercial-flag-operator', pilot: 'family-pilot-operator', fixture: 'commercial-e2e-fixture' });
const AMBIENT_CREDENTIALS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

export function buildOperatorProfiles() {
  return STAGES.flatMap(stage => Object.entries(PURPOSES)
    .filter(([purpose]) => stage !== 'prod' || purpose !== 'fixture')
    .map(([purpose, suffix]) => {
      const profile = `roadmap2u-${stage}-${suffix}`;
      return { stage, purpose, profile, roleName: profile,
        roleArn: `arn:aws:iam::${OPERATOR_ACCOUNT}:role/roadmap2u/${stage}/operations/${profile}`,
        sourceProfile: 'roadmap2u', roleSessionName: `codex-${stage}-${purpose}-work`,
        durationSeconds: OPERATOR_SESSION_SECONDS, region: OPERATOR_REGION };
    }));
}

function exportCliCredentials(profile) {
  const executable = process.env.ROADMAP2U_AWS_CLI || (process.platform === 'win32' ? 'aws.exe' : 'aws');
  try {
    const output = execFileSync(executable, ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output);
  } catch { throw new Error('OperatorSessionCredentialsUnavailable'); }
}

async function callerIdentity(credentials) {
  const sts = new STSClient({ region: OPERATOR_REGION, credentials, maxAttempts: 1 });
  try { return await sts.send(new GetCallerIdentityCommand({})); }
  catch { throw new Error('OperatorSessionIdentityUnavailable'); }
  finally { sts.destroy(); }
}

/** Credentials are non-enumerable; only role identity and expiration can enter receipts. */
export function createOperatorSessionProvider({ exportCredentials = exportCliCredentials,
  getCallerIdentity = callerIdentity, now = Date.now, env = process.env } = {}) {
  return async (stage, purpose) => {
    const profile = buildOperatorProfiles().find(p => p.stage === stage && p.purpose === purpose);
    if (!profile) throw new Error('UnapprovedOperatorStageOrPurpose');
    if (AMBIENT_CREDENTIALS.some(key => typeof env[key] === 'string' && env[key].trim())) {
      throw new Error('OperatorProfileCannotUseAmbientCredentials');
    }
    const exported = await exportCredentials(profile.profile);
    if (exported?.Version !== 1 || ['AccessKeyId', 'SecretAccessKey', 'SessionToken'].some(key =>
      typeof exported[key] !== 'string' || !exported[key].length)) throw new Error('InvalidOperatorSessionCredentials');
    const expiration = new Date(exported.Expiration);
    if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= now() + 5 * 60_000 ||
      expiration.getTime() > now() + OPERATOR_SESSION_SECONDS * 1000 + 60_000) {
      throw new Error('OperatorSessionLifetimeInvalid');
    }
    const credentials = { accessKeyId: exported.AccessKeyId, secretAccessKey: exported.SecretAccessKey,
      sessionToken: exported.SessionToken, expiration };
    const actual = await getCallerIdentity(credentials);
    const prefix = `arn:aws:sts::${OPERATOR_ACCOUNT}:assumed-role/${profile.roleName}/`;
    if (actual?.Account !== OPERATOR_ACCOUNT || !actual?.Arn?.startsWith(prefix) ||
      !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(actual.Arn.slice(prefix.length))) {
      throw new Error('OperatorSessionIdentityMismatch');
    }
    const session = { stage, purpose, profile: profile.profile,
      identity: { Account: actual.Account, Arn: actual.Arn }, expiration: expiration.toISOString() };
    Object.defineProperties(session, {
      raw: { enumerable: false, value: { AccessKeyId: exported.AccessKeyId, SecretAccessKey: exported.SecretAccessKey,
        SessionToken: exported.SessionToken, Expiration: expiration } },
      credentials: { enumerable: false, value: credentials },
    });
    return session;
  };
}
