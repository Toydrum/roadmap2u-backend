import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CliModule = {
  createAwsCredentialLoader(options: Record<string, unknown>): (
    profile: string | undefined,
  ) => Promise<Record<string, string>>;
  createAwsJsonRunner(options: Record<string, unknown>): (
    profile: string | undefined,
    args: string[],
  ) => unknown;
  runCommercialConfigCli(options: Record<string, unknown>): Promise<number>;
};

async function cliModule(): Promise<CliModule> {
  const url = pathToFileURL(
    join(process.cwd(), 'scripts', 'lib', 'commercial-config-cli.mjs'),
  ).href;
  return import(url) as Promise<CliModule>;
}

const ACCOUNT = '765932874577';
const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';
const MIGRATION_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-dev-commercial-migration/operator-session`;
const FLAG_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-dev-commercial-flag-operator/operator-session`;
const CREDENTIALS = {
  AccessKeyId: 'ASIAEXAMPLE',
  SecretAccessKey: 'not-a-real-secret',
  SessionToken: 'not-a-real-session-token',
};

afterEach(() => vi.restoreAllMocks());

function deps(overrides: Record<string, unknown> = {}) {
  const output: string[] = [];
  return {
    output,
    options: {
      write: (line: string) => output.push(line),
      getCallerIdentity: vi.fn(async () => ({ Account: ACCOUNT, Arn: MIGRATION_ARN })),
      getCredentials: vi.fn(async () => CREDENTIALS),
      fetch: vi.fn(async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ command: 'bootstrap-flags', revision: 1 }),
      })),
      now: () => new Date('2026-08-19T18:30:00.000Z'),
      ...overrides,
    },
  };
}

describe('commercial config CLI', () => {
  it('uses the direct AWS SDK credential provider for apply credentials, preserves the profile, and never calls DynamoDB', async () => {
    const { createAwsCredentialLoader } = await cliModule();
    const env: Record<string, string> = {
      AWS_PROFILE: 'original-profile',
      AWS_EC2_METADATA_DISABLED: 'false',
    };
    const send = vi.fn(() => {
      throw new Error('DynamoDB must never be called');
    });
    const destroy = vi.fn();
    const credentials = vi.fn(async () => {
      expect(env.AWS_PROFILE).toBe('roadmap-operations');
      expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
      return {
        accessKeyId: CREDENTIALS.AccessKeyId,
        secretAccessKey: CREDENTIALS.SecretAccessKey,
        sessionToken: CREDENTIALS.SessionToken,
      };
    });
    const createClient = vi.fn(() => ({ config: { credentials }, send, destroy }));
    const loadCredentials = createAwsCredentialLoader({ createClient, env });

    await expect(loadCredentials('roadmap-operations')).resolves.toEqual(CREDENTIALS);
    expect(createClient).toHaveBeenCalledWith({
      region: 'us-east-1',
      profile: 'roadmap-operations',
    });
    expect(credentials).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(env.AWS_PROFILE).toBe('original-profile');
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('false');
    expect(
      readFileSync(
        join(process.cwd(), 'scripts', 'lib', 'commercial-config-cli.mjs'),
        'utf8',
      ),
    ).not.toContain('export-credentials');
  });

  it('restores an absent profile and hides credential-provider failures', async () => {
    const { createAwsCredentialLoader } = await cliModule();
    const env: Record<string, string> = {};
    const destroy = vi.fn();
    const createClient = vi.fn(() => ({
      config: {
        credentials: vi.fn(async () => {
          expect(env.AWS_PROFILE).toBe('roadmap-operations');
          expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
          throw new Error(`provider exposed ${CREDENTIALS.SecretAccessKey}`);
        }),
      },
      send: vi.fn(),
      destroy,
    }));
    const loadCredentials = createAwsCredentialLoader({ createClient, env });

    await expect(loadCredentials('roadmap-operations')).rejects.toThrow(
      'AWS credentials are unavailable',
    );
    await expect(loadCredentials('roadmap-operations')).rejects.not.toThrow(
      CREDENTIALS.SecretAccessKey,
    );
    expect(env).not.toHaveProperty('AWS_PROFILE');
    expect(env).not.toHaveProperty('AWS_EC2_METADATA_DISABLED');
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'static credentials',
      {
        AWS_ACCESS_KEY_ID: 'ambient-access-key',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret-key',
        AWS_SESSION_TOKEN: 'ambient-session-token',
      },
    ],
    [
      'web identity',
      {
        AWS_ROLE_ARN: 'arn:aws:iam::765932874577:role/ambient-web-role',
        AWS_WEB_IDENTITY_TOKEN_FILE: 'C:\\private\\ambient-token',
      },
    ],
    [
      'container credentials',
      {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/ambient',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'ambient-container-secret',
      },
    ],
  ])('fails fast when --profile competes with %s and restores the full environment', async (_name, ambient) => {
    const { createAwsCredentialLoader } = await cliModule();
    const env: Record<string, string> = {
      AWS_PROFILE: 'original-profile',
      AWS_EC2_METADATA_DISABLED: 'false',
      ...ambient,
    };
    const original = { ...env };
    const createClient = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loadCredentials = createAwsCredentialLoader({ createClient, env });

    await expect(loadCredentials('roadmap-operations')).rejects.toThrow(
      'ambient AWS credential sources',
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(env).toEqual(original);
    const capture = [...error.mock.calls, ...warn.mock.calls].flat().join('\n');
    for (const secret of Object.values(ambient)) expect(capture).not.toContain(secret);
  });

  it('keeps the normal default provider chain and environment untouched without --profile', async () => {
    const { createAwsCredentialLoader } = await cliModule();
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: 'ambient-access-key',
      AWS_SECRET_ACCESS_KEY: 'ambient-secret-key',
      AWS_SESSION_TOKEN: 'ambient-session-token',
      AWS_EC2_METADATA_DISABLED: 'false',
    };
    const original = { ...env };
    const credentials = vi.fn(async () => {
      expect(env).toEqual(original);
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      };
    });
    const send = vi.fn();
    const destroy = vi.fn();
    const createClient = vi.fn(() => ({ config: { credentials }, send, destroy }));
    const loadCredentials = createAwsCredentialLoader({ createClient, env });

    await expect(loadCredentials(undefined)).resolves.toEqual({
      AccessKeyId: 'ambient-access-key',
      SecretAccessKey: 'ambient-secret-key',
      SessionToken: 'ambient-session-token',
    });
    expect(createClient).toHaveBeenCalledWith({ region: 'us-east-1' });
    expect(send).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(env).toEqual(original);
  });

  it('uses a configured AWS executable without a shell and parses its JSON response', async () => {
    const { createAwsJsonRunner } = await cliModule();
    const execute = vi.fn(() => JSON.stringify({ Account: ACCOUNT }));
    const runAwsJson = createAwsJsonRunner({
      execute,
      platform: 'win32',
      env: { ROADMAP2U_AWS_CLI: 'C:\\Tools\\aws.exe' },
    });

    expect(runAwsJson('operations', ['sts', 'get-caller-identity'])).toEqual({
      Account: ACCOUNT,
    });
    expect(execute).toHaveBeenCalledWith(
      'C:\\Tools\\aws.exe',
      ['sts', 'get-caller-identity', '--profile', 'operations'],
      expect.objectContaining({
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('falls back to python -m awscli only when the AWS executable is missing', async () => {
    const { createAwsJsonRunner } = await cliModule();
    const missing = Object.assign(new Error('spawn aws.cmd ENOENT'), { code: 'ENOENT' });
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockReturnValueOnce(JSON.stringify({ Account: ACCOUNT }));
    const runAwsJson = createAwsJsonRunner({
      execute,
      platform: 'win32',
      env: { ROADMAP2U_PYTHON: 'C:\\Python313\\python.exe' },
    });

    expect(runAwsJson(undefined, ['sts', 'get-caller-identity'])).toEqual({
      Account: ACCOUNT,
    });
    expect(execute.mock.calls).toEqual([
      [
        'aws.cmd',
        ['sts', 'get-caller-identity'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      ],
      [
        'C:\\Python313\\python.exe',
        ['-m', 'awscli', 'sts', 'get-caller-identity'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      ],
    ]);
  });

  it('does not retry through Python after a real AWS CLI failure', async () => {
    const { createAwsJsonRunner } = await cliModule();
    const execute = vi.fn(() => {
      throw Object.assign(new Error('AccessDenied'), { status: 254 });
    });
    const runAwsJson = createAwsJsonRunner({
      execute,
      platform: 'win32',
      env: { ROADMAP2U_PYTHON: 'C:\\Python313\\python.exe' },
    });

    expect(() => runAwsJson(undefined, ['sts', 'get-caller-identity'])).toThrow(
      'AWS CLI request failed',
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('is dry-run by default, validates the migration identity, and emits only a confirmation hash', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const fixture = deps();

    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'bootstrap-flags',
        argv: ['--stage', 'dev', '--url', URL, '--reason', 'initial commercial flags'],
      }),
    ).resolves.toBe(0);

    expect(fixture.options.getCallerIdentity).toHaveBeenCalledOnce();
    expect(fixture.options.getCredentials).not.toHaveBeenCalled();
    expect(fixture.options.fetch).not.toHaveBeenCalled();
    const capture = fixture.output.join('\n');
    expect(capture).toMatch(/dryRunHash=[a-f0-9]{64}/);
    expect(capture).toContain('command=bootstrap-flags');
    expect(capture).toContain('stage=dev');
    expect(capture).not.toContain('initial commercial flags');
    expect(capture).not.toContain(MIGRATION_ARN);
  });

  it('requires apply, exact stage confirmation, and matching dry-run hash before HTTP mutation', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const fixture = deps();

    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'bootstrap-flags',
        argv: [
          '--stage', 'dev',
          '--url', URL,
          '--reason', 'initial commercial flags',
          '--apply',
          '--confirm-stage', 'dev',
          '--confirm-hash', '0'.repeat(64),
        ],
      }),
    ).rejects.toThrow('confirmation hash');
    expect(fixture.options.fetch).not.toHaveBeenCalled();
  });

  it('signs an applied set request with SigV4 and never prints the actor, reason, body, or credentials', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const dry = deps({
      getCallerIdentity: vi.fn(async () => ({ Account: ACCOUNT, Arn: FLAG_ARN })),
    });
    const argv = [
      '--stage', 'dev',
      '--url', URL,
      '--reason', 'observe quota without exposure',
      '--expected-revision', '7',
      '--quota-mode', 'observe',
      '--access-code-issuance-enabled', 'false',
    ];
    await runCommercialConfigCli({
      ...dry.options,
      command: 'set-flags',
      argv,
    });
    const hash = /dryRunHash=([a-f0-9]{64})/.exec(dry.output.join('\n'))?.[1];
    expect(hash).toBeDefined();

    const applied = deps({
      getCallerIdentity: vi.fn(async () => ({ Account: ACCOUNT, Arn: FLAG_ARN })),
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ command: 'set-flags', revision: 8 }),
      })),
    });
    await expect(
      runCommercialConfigCli({
        ...applied.options,
        command: 'set-flags',
        argv: [
          ...argv,
          '--apply',
          '--confirm-stage', 'dev',
          '--confirm-hash', hash,
        ],
      }),
    ).resolves.toBe(0);

    expect(applied.options.getCredentials).toHaveBeenCalledOnce();
    expect(applied.options.fetch).toHaveBeenCalledOnce();
    const [requestUrl, request] = (applied.options.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(requestUrl).toBe(URL);
    expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/');
    expect(request.headers.Authorization).toContain('/us-east-1/lambda/aws4_request');
    expect(request.headers['x-amz-date']).toBe('20260819T183000Z');
    expect(request.headers['x-amz-security-token']).toBe(CREDENTIALS.SessionToken);
    expect(JSON.parse(request.body)).toEqual({
      command: 'set-flags',
      stage: 'dev',
      expectedRevision: 7,
      reason: 'observe quota without exposure',
      changes: { quotaMode: 'observe', accessCodeIssuanceEnabled: false },
    });
    const capture = applied.output.join('\n');
    for (const secret of [
      FLAG_ARN,
      CREDENTIALS.AccessKeyId,
      CREDENTIALS.SecretAccessKey,
      CREDENTIALS.SessionToken,
      'observe quota without exposure',
      JSON.stringify(JSON.parse(request.body)),
    ]) {
      expect(capture).not.toContain(secret);
    }
    expect(capture).toContain('status=200');
    expect(capture).toContain('revision=8');
  });

  it.each([
    ['wrong account', { Account: '000000000000', Arn: MIGRATION_ARN }, 'AWS account'],
    [
      'wrong stage role',
      {
        Account: ACCOUNT,
        Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-test-commercial-migration/operator-session`,
      },
      'stage role',
    ],
    [
      'IAM user instead of assumed role',
      { Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/Hector-admin` },
      'assumed role',
    ],
  ])('rejects %s before signing', async (_name, identity, message) => {
    const { runCommercialConfigCli } = await cliModule();
    const fixture = deps({ getCallerIdentity: vi.fn(async () => identity) });
    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'bootstrap-flags',
        argv: ['--stage', 'dev', '--url', URL, '--reason', 'safe reason'],
      }),
    ).rejects.toThrow(message);
    expect(fixture.options.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-Function URLs, unknown/premium flags, and non-canonical freeze timestamps', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const fixture = deps();
    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'bootstrap-flags',
        argv: [
          '--stage', 'dev',
          '--url', 'https://example.com/',
          '--reason', 'safe reason',
        ],
      }),
    ).rejects.toThrow('Function URL');
    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'set-flags',
        argv: [
          '--stage', 'dev',
          '--url', URL,
          '--reason', 'safe reason',
          '--expected-revision', '1',
          '--premium-payments-enabled', 'false',
        ],
      }),
    ).rejects.toThrow('Unknown option');
    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'freeze-cutover',
        argv: [
          '--stage', 'dev',
          '--url', URL,
          '--reason', 'safe reason',
          '--cutover-at', '2026-08-19T18:30:00Z',
          '--inventory-manifest-hash', 'a'.repeat(64),
        ],
      }),
    ).rejects.toThrow('canonical UTC');
  });
});
