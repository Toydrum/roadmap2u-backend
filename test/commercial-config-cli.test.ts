import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CliModule = {
  createAwsCredentialLoader(options: Record<string, unknown>): (
    profile: string | undefined,
  ) => Promise<Record<string, string>>;
  createAwsJsonRunner(options: Record<string, unknown>): (
    profile: string | undefined,
    args: string[],
  ) => unknown;
  buildCutoverEvidenceMirror(input: Record<string, unknown>): Record<string, unknown>;
  createCutoverEvidenceWriter(options: Record<string, unknown>): (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  runCommercialConfigCli(options: Record<string, unknown>): Promise<number>;
};

type CutoverEvidenceInput = {
  evidenceRoot: string;
  stage: string;
  mirror: {
    schemaVersion: number;
    evidenceKind: string;
    stage: string;
    commercialEntitlementsCutoverAt: string;
    inventoryManifestHash: string;
    mirrorHash: string;
  };
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
const EVIDENCE_ROOT = resolve(
  process.cwd(),
  '..',
  '..',
  'evidence',
  'commercial-launch',
);
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

  it('writes zero evidence on dry-run and mirrors only the confirmed immutable cutover on apply/rerun', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const reason = 'private operator reason that must never enter evidence';
    const cutoverAt = '2026-08-20T01:00:00.000Z';
    const inventoryManifestHash = 'a'.repeat(64);
    const evidenceRoot = EVIDENCE_ROOT;
    const baseArgv = [
      '--stage', 'dev',
      '--url', URL,
      '--reason', reason,
      '--cutover-at', cutoverAt,
      '--inventory-manifest-hash', inventoryManifestHash,
    ];
    const dryWriter = vi.fn();
    const dry = deps();

    await expect(
      runCommercialConfigCli({
        ...dry.options,
        command: 'freeze-cutover',
        argv: baseArgv,
        evidenceRoot,
        writeEvidenceMirror: dryWriter,
      }),
    ).resolves.toBe(0);

    expect(dryWriter).not.toHaveBeenCalled();
    const dryRunHash = /dryRunHash=([a-f0-9]{64})/.exec(dry.output.join('\n'))?.[1];
    expect(dryRunHash).toBeDefined();

    const firstWriter = vi.fn(async (_input: CutoverEvidenceInput) => ({ created: true }));
    const first = deps({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            command: 'freeze-cutover',
            commercialEntitlementsCutoverAt: cutoverAt,
            inventoryManifestHash,
            idempotent: false,
          }),
      })),
    });
    await expect(
      runCommercialConfigCli({
        ...first.options,
        command: 'freeze-cutover',
        argv: [
          ...baseArgv,
          '--apply',
          '--confirm-stage', 'dev',
          '--confirm-hash', dryRunHash,
        ],
        evidenceRoot,
        writeEvidenceMirror: firstWriter,
      }),
    ).resolves.toBe(0);

    expect(firstWriter).toHaveBeenCalledOnce();
    const firstInput = firstWriter.mock.calls[0][0];
    expect(firstInput).toEqual({
      evidenceRoot,
      stage: 'dev',
      mirror: {
        schemaVersion: 1,
        evidenceKind: 'commercial-cutover',
        stage: 'dev',
        commercialEntitlementsCutoverAt: cutoverAt,
        inventoryManifestHash,
        mirrorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(firstInput)).not.toContain(reason);
    expect(JSON.stringify(firstInput)).not.toContain(MIGRATION_ARN);
    expect(JSON.stringify(firstInput)).not.toContain(CREDENTIALS.SecretAccessKey);
    expect(first.output).toContain(
      `evidenceMirrorHash=${firstInput.mirror.mirrorHash}`,
    );

    const rerunWriter = vi.fn(async (_input: CutoverEvidenceInput) => ({ created: false }));
    const rerun = deps({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            command: 'freeze-cutover',
            commercialEntitlementsCutoverAt: cutoverAt,
            inventoryManifestHash,
            idempotent: true,
          }),
      })),
    });
    await runCommercialConfigCli({
      ...rerun.options,
      command: 'freeze-cutover',
      argv: [
        ...baseArgv,
        '--apply',
        '--confirm-stage', 'dev',
        '--confirm-hash', dryRunHash,
      ],
      evidenceRoot,
      writeEvidenceMirror: rerunWriter,
    });
    expect(rerunWriter.mock.calls[0][0]).toEqual(firstInput);

    const mismatchWriter = vi.fn();
    const mismatch = deps({
      fetch: vi.fn(async () => ({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: 'CONFIGURATION_CONFLICT' }),
      })),
    });
    await expect(
      runCommercialConfigCli({
        ...mismatch.options,
        command: 'freeze-cutover',
        argv: [
          ...baseArgv,
          '--apply',
          '--confirm-stage', 'dev',
          '--confirm-hash', dryRunHash,
        ],
        evidenceRoot,
        writeEvidenceMirror: mismatchWriter,
      }),
    ).rejects.toThrow('status 409');
    expect(mismatchWriter).not.toHaveBeenCalled();
  });

  it.each([
    [
      'different timestamp',
      {
        command: 'freeze-cutover',
        commercialEntitlementsCutoverAt: '2026-08-20T01:00:01.000Z',
        inventoryManifestHash: 'a'.repeat(64),
        idempotent: false,
      },
    ],
    [
      'different manifest hash',
      {
        command: 'freeze-cutover',
        commercialEntitlementsCutoverAt: '2026-08-20T01:00:00.000Z',
        inventoryManifestHash: 'b'.repeat(64),
        idempotent: false,
      },
    ],
    [
      'missing field',
      {
        command: 'freeze-cutover',
        commercialEntitlementsCutoverAt: '2026-08-20T01:00:00.000Z',
        inventoryManifestHash: 'a'.repeat(64),
      },
    ],
    [
      'extra field',
      {
        command: 'freeze-cutover',
        commercialEntitlementsCutoverAt: '2026-08-20T01:00:00.000Z',
        inventoryManifestHash: 'a'.repeat(64),
        idempotent: false,
        reason: 'untrusted broker response field',
      },
    ],
  ])('writes zero evidence for a 2xx freeze response with %s', async (_name, payload) => {
    const { runCommercialConfigCli } = await cliModule();
    const writer = vi.fn();
    const fixture = deps({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify(payload),
      })),
    });
    const argv = [
      '--stage', 'dev',
      '--url', URL,
      '--reason', 'private operator reason',
      '--cutover-at', '2026-08-20T01:00:00.000Z',
      '--inventory-manifest-hash', 'a'.repeat(64),
    ];
    const dry = deps();
    await runCommercialConfigCli({
      ...dry.options,
      command: 'freeze-cutover',
      argv,
    });
    const hash = /dryRunHash=([a-f0-9]{64})/.exec(dry.output.join('\n'))?.[1];

    await expect(
      runCommercialConfigCli({
        ...fixture.options,
        command: 'freeze-cutover',
        argv: [
          ...argv,
          '--apply',
          '--confirm-stage', 'dev',
          '--confirm-hash', hash,
        ],
        evidenceRoot: EVIDENCE_ROOT,
        writeEvidenceMirror: writer,
      }),
    ).rejects.toThrow('freeze response');
    expect(writer).not.toHaveBeenCalled();
    expect(fixture.output.join('\n')).not.toContain('applied command=freeze-cutover');
    expect(fixture.output.join('\n')).not.toContain('untrusted broker response field');
  });

  it('fails closed when the mirror write fails and can resume idempotently', async () => {
    const { runCommercialConfigCli } = await cliModule();
    const cutoverAt = '2026-08-20T01:00:00.000Z';
    const inventoryManifestHash = 'a'.repeat(64);
    const argv = [
      '--stage', 'dev',
      '--url', URL,
      '--reason', 'private operator reason',
      '--cutover-at', cutoverAt,
      '--inventory-manifest-hash', inventoryManifestHash,
    ];
    const dry = deps();
    await runCommercialConfigCli({
      ...dry.options,
      command: 'freeze-cutover',
      argv,
    });
    const hash = /dryRunHash=([a-f0-9]{64})/.exec(dry.output.join('\n'))?.[1];
    const writer = vi
      .fn(async (_input: CutoverEvidenceInput) => ({ created: false }))
      .mockRejectedValueOnce(new Error('cutover evidence mirror could not be written'))
      .mockResolvedValueOnce({ created: false });
    const successResponse = (idempotent: boolean, status: number) =>
      vi.fn(async () => ({
        ok: true,
        status,
        text: async () =>
          JSON.stringify({
            command: 'freeze-cutover',
            commercialEntitlementsCutoverAt: cutoverAt,
            inventoryManifestHash,
            idempotent,
          }),
      }));
    const first = deps({ fetch: successResponse(false, 201) });
    const options = {
      command: 'freeze-cutover',
      argv: [
        ...argv,
        '--apply',
        '--confirm-stage', 'dev',
        '--confirm-hash', hash,
      ],
      evidenceRoot: EVIDENCE_ROOT,
      writeEvidenceMirror: writer,
    };

    await expect(
      runCommercialConfigCli({ ...first.options, ...options }),
    ).rejects.toThrow('evidence mirror could not be written');
    expect(first.output.join('\n')).not.toContain('applied command=freeze-cutover');

    const rerun = deps({ fetch: successResponse(true, 200) });
    await expect(
      runCommercialConfigCli({ ...rerun.options, ...options }),
    ).resolves.toBe(0);
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls[1][0]).toEqual(writer.mock.calls[0][0]);
    expect(rerun.output.join('\n')).toContain('applied command=freeze-cutover');
    expect(rerun.output.join('\n')).toContain('idempotent=true');
  });

  it('writes a canonical content-addressed mirror and requests owner-only mode', async () => {
    const { buildCutoverEvidenceMirror, createCutoverEvidenceWriter } =
      await cliModule();
    const mirror = buildCutoverEvidenceMirror({
      stage: 'dev',
      commercialEntitlementsCutoverAt: '2026-08-20T01:00:00.000Z',
      inventoryManifestHash: 'a'.repeat(64),
    });
    const makeDirectory = vi.fn(async () => undefined);
    const writeFile = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    const readFile = vi.fn();
    const checkout = resolve(process.cwd(), 'artifact', 'backend');
    const writer = createCutoverEvidenceWriter({
      makeDirectory,
      writeFile,
      readFile,
      cwd: checkout,
    });
    const evidenceRoot = resolve(
      process.cwd(),
      'artifact',
      'evidence',
      'commercial-launch',
    );
    const canonicalMirroredFields =
      `{"commercialEntitlementsCutoverAt":"2026-08-20T01:00:00.000Z",` +
      `"evidenceKind":"commercial-cutover","inventoryManifestHash":"${'a'.repeat(64)}",` +
      '"schemaVersion":1,"stage":"dev"}';
    expect(mirror.mirrorHash).toBe(
      createHash('sha256').update(canonicalMirroredFields, 'utf8').digest('hex'),
    );

    const first = await writer({ evidenceRoot, stage: 'dev', mirror });

    expect(first).toMatchObject({ created: true });
    expect(first.path).toMatch(
      /[\\/]evidence[\\/]commercial-launch[\\/]cutover[\\/]dev[\\/][a-f0-9]{64}\.json$/,
    );
    expect(makeDirectory).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]cutover[\\/]dev$/),
      { recursive: true },
    );
    const [path, content, options] = writeFile.mock.calls[0];
    expect(path).toBe(first.path);
    expect(options).toEqual({ encoding: 'utf8', mode: 0o600, flag: 'wx' });
    expect(content).toBe(
      `{"commercialEntitlementsCutoverAt":"2026-08-20T01:00:00.000Z","evidenceKind":"commercial-cutover","inventoryManifestHash":"${'a'.repeat(64)}","mirrorHash":"${mirror.mirrorHash}","schemaVersion":1,"stage":"dev"}\n`,
    );
    expect(content).not.toMatch(
      /"(?:reason|actor|credentials?|secret|flags|title|note|email)"/i,
    );

    readFile.mockResolvedValueOnce(content);
    await expect(
      writer({ evidenceRoot, stage: 'dev', mirror }),
    ).resolves.toEqual({ path: first.path, created: false });
    expect(readFile).toHaveBeenCalledWith(first.path, 'utf8');

    await expect(
      writer({
        evidenceRoot,
        stage: 'dev',
        mirror: { ...mirror, mirrorHash: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('hash does not match');

    await expect(
      writer({
        evidenceRoot: resolve(checkout, 'evidence', 'commercial-launch'),
        stage: 'dev',
        mirror,
      }),
    ).rejects.toThrow('outside the backend checkout');
  });
});
