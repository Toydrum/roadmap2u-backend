import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CliModule = {
  runSponsoredAccessCli(options: Record<string, unknown>): Promise<number>;
};

const ACCOUNT = '765932874577';
const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';
const COMMAND_ID = '123e4567-e89b-42d3-a456-426614174000';
const ISSUANCE_ID = '123e4567-e89b-42d3-a456-426614174001';
const ACCESS_CODE = `RM2U1.${ISSUANCE_ID}.${'s'.repeat(43)}`;
const ROLE_ARN =
  `arn:aws:sts::${ACCOUNT}:assumed-role/` +
  'roadmap2u-dev-sponsored-access-operator/operator-session';
const CREDENTIALS = {
  AccessKeyId: 'ASIAEXAMPLE',
  SecretAccessKey: 'not-a-real-secret',
  SessionToken: 'not-a-real-session-token',
};

async function cliModule(): Promise<CliModule> {
  return import(
    pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'sponsored-access-cli.mjs')).href
  ) as Promise<CliModule>;
}

function deps(overrides: Record<string, unknown> = {}) {
  const output: string[] = [];
  return {
    output,
    options: {
      write: (line: string) => output.push(line),
      getCallerIdentity: vi.fn(async () => ({ Account: ACCOUNT, Arn: ROLE_ARN })),
      getCredentials: vi.fn(async () => CREDENTIALS),
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            command: 'issue-code',
            metadata: {
              issuanceId: ISSUANCE_ID,
              status: 'issued',
              planKey: 'premium',
            },
            plaintext: ACCESS_CODE,
            plaintextUnavailable: false,
            idempotent: false,
          }),
      })),
      now: () => new Date('2026-08-22T18:30:00.000Z'),
      isInteractive: true,
      ...overrides,
    },
  };
}

const ISSUE_ARGS = [
  'issue-code',
  '--stage',
  'dev',
  '--url',
  URL,
  '--command-id',
  COMMAND_ID,
  '--reason',
  'beta tester invitation',
];

afterEach(() => vi.restoreAllMocks());

describe('sponsored access CLI', () => {
  it('is exposed as one owner-only command without direct data or secret clients', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(packageJson.scripts['commercial:access']).toBe('node scripts/sponsored-access.mjs');
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'lib', 'sponsored-access-cli.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/DynamoDB|SecretsManager|GetSecretValue|PutItem|UpdateItem/);
  });

  it('dry-runs a normalized temporary issue and does not fetch credentials or call the broker', async () => {
    const { runSponsoredAccessCli } = await cliModule();
    const { output, options } = deps();

    await expect(runSponsoredAccessCli({ argv: ISSUE_ARGS, ...options })).resolves.toBe(0);

    expect(options.getCallerIdentity).toHaveBeenCalledOnce();
    expect(options.getCredentials).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(output).toContain('dry-run command=issue-code stage=dev');
    expect(output.join('\n')).toMatch(/confirmHash=[a-f0-9]{64}/);
    expect(output.join('\n')).not.toContain('beta tester invitation');
  });

  it('applies the confirmed request through SigV4 and reveals a new plaintext once', async () => {
    const { runSponsoredAccessCli } = await cliModule();
    const dryRun = deps();
    await runSponsoredAccessCli({ argv: ISSUE_ARGS, ...dryRun.options });
    const confirmHash = dryRun.output
      .find((line) => line.startsWith('confirmHash='))
      ?.slice('confirmHash='.length);
    const applied = deps();

    await expect(
      runSponsoredAccessCli({
        argv: [...ISSUE_ARGS, '--apply', '--confirm-stage', 'dev', '--confirm-hash', confirmHash],
        ...applied.options,
      }),
    ).resolves.toBe(0);

    const [, request] = applied.options.fetch.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(request.body);
    expect(body).toEqual({
      command: 'issue-code',
      stage: 'dev',
      commandId: COMMAND_ID,
      reason: 'beta tester invitation',
      grantOfferKey: 'premium_demo',
      confirmHash,
    });
    expect(request.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(applied.output).toContain(`accessCode=${ACCESS_CODE}`);
    expect(applied.output.join('\n')).not.toContain(CREDENTIALS.SecretAccessKey);
  });

  it('requires explicit permanent confirmation and never accepts a target user', async () => {
    const { runSponsoredAccessCli } = await cliModule();
    const permanent = deps();
    await expect(
      runSponsoredAccessCli({ argv: [...ISSUE_ARGS, '--permanent'], ...permanent.options }),
    ).rejects.toThrow('confirm-permanent');
    await expect(
      runSponsoredAccessCli({
        argv: [...ISSUE_ARGS, '--target-sub', 'someone'],
        ...permanent.options,
      }),
    ).rejects.toThrow('Unknown option');
  });

  it('rejects the wrong role before credentials or network access', async () => {
    const { runSponsoredAccessCli } = await cliModule();
    const wrongRole = deps({
      getCallerIdentity: vi.fn(async () => ({
        Account: ACCOUNT,
        Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/roadmap2u-dev-commercial-migration/session`,
      })),
    });
    await expect(runSponsoredAccessCli({ argv: ISSUE_ARGS, ...wrongRole.options })).rejects.toThrow(
      'selected stage role',
    );
    expect(wrongRole.options.getCredentials).not.toHaveBeenCalled();
    expect(wrongRole.options.fetch).not.toHaveBeenCalled();
  });

  it('rejects apply from a non-interactive environment before loading credentials', async () => {
    const { runSponsoredAccessCli } = await cliModule();
    const dryRun = deps();
    await runSponsoredAccessCli({ argv: ISSUE_ARGS, ...dryRun.options });
    const confirmHash = dryRun.output
      .find((line) => line.startsWith('confirmHash='))
      ?.slice('confirmHash='.length);
    const nonInteractive = deps({ isInteractive: false });

    await expect(
      runSponsoredAccessCli({
        argv: [...ISSUE_ARGS, '--apply', '--confirm-stage', 'dev', '--confirm-hash', confirmHash],
        ...nonInteractive.options,
      }),
    ).rejects.toThrow('interactive terminal');

    expect(nonInteractive.options.getCredentials).not.toHaveBeenCalled();
    expect(nonInteractive.options.fetch).not.toHaveBeenCalled();
  });
});
