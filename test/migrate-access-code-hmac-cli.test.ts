import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

type MigrationResult = Readonly<Record<string, any>> & {
  readonly confirmationHash?: string;
};

type MigrationCliModule = {
  runAccessCodeHmacMigrationCli(options: Record<string, unknown>): Promise<MigrationResult>;
};

const SOURCE_KEY = 'A'.repeat(64);
const GENERATED_KEY = 'B'.repeat(64);
const DIFFERENT_KEY = 'C'.repeat(64);
const SOURCE_VALUE = JSON.stringify({ activeVersion: 'v1', v1: SOURCE_KEY });
const DIFFERENT_VALUE = JSON.stringify({ activeVersion: 'v1', v1: DIFFERENT_KEY });
const SOURCE_SECRET_ID = 'roadmap2u/dev/access-code-hmac/v1';
const TARGET_PARAMETER_NAME = '/roadmap2u/dev/access-code-hmac/v1';
const AWS_ACCOUNT_ID = '765932874577';
const MODULE_PATH = join(
  process.cwd(),
  'scripts',
  'lib',
  'access-code-hmac-migration-cli.mjs',
);
const MODULE_EXISTS = existsSync(MODULE_PATH);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function cliModule(): Promise<MigrationCliModule> {
  return import(pathToFileURL(MODULE_PATH).href) as Promise<MigrationCliModule>;
}

function fixture({
  sourceValue = SOURCE_VALUE,
  sourceExists = true,
  targetValue,
  targetType = 'SecureString',
}: {
  readonly sourceValue?: string;
  readonly sourceExists?: boolean;
  readonly targetValue?: string;
  readonly targetType?: 'String' | 'SecureString';
} = {}) {
  const output: string[] = [];
  const getCallerIdentity = vi.fn(async () => ({
    Account: AWS_ACCOUNT_ID,
    Arn: `arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/roadmap2u-dev-commercial-migration/test`,
  }));
  const describeSecret = vi.fn(async () => {
    if (!sourceExists) {
      const error = new Error('secret not found');
      error.name = 'ResourceNotFoundException';
      throw error;
    }
    return { ARN: `arn:aws:secretsmanager:us-east-1:${AWS_ACCOUNT_ID}:secret:${SOURCE_SECRET_ID}` };
  });
  const getSecretValue = vi.fn(async () => ({ SecretString: sourceValue }));
  const getParameter = vi.fn(async () =>
    targetValue === undefined
      ? undefined
      : {
          Parameter: {
            Name: TARGET_PARAMETER_NAME,
            Type: targetType,
            Value: targetValue,
            Version: 1,
          },
        },
  );
  const putParameter = vi.fn(async (_input: Record<string, unknown>) => ({ Version: 1 }));
  const generateSecretMaterial = vi.fn(() => GENERATED_KEY);
  return {
    output,
    getCallerIdentity,
    describeSecret,
    getSecretValue,
    getParameter,
    putParameter,
    generateSecretMaterial,
    options: {
      env: {},
      write: (line: string) => output.push(line),
      getCallerIdentity,
      describeSecret,
      getSecretValue,
      getParameter,
      putParameter,
      generateSecretMaterial,
    },
  };
}

function expectNoPlaintext(value: unknown, secrets: readonly string[]): void {
  const capture = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) expect(capture).not.toContain(secret);
}

describe('access-code HMAC migration CLI', () => {
  it('exposes the dedicated migration entrypoint without inline secret inputs', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts['commercial:migrate-hmac']).toBe(
      'node scripts/migrate-access-code-hmac.mjs',
    );
  });

  it('provides the injectable migration module', () => {
    expect(MODULE_EXISTS).toBe(true);
  });
});

const describeWithModule = MODULE_EXISTS ? describe : describe.skip;

describeWithModule('access-code HMAC migration contract', () => {
  it('rejects credentials from another AWS account before any secret read or write', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();
    f.getCallerIdentity.mockResolvedValueOnce({
      Account: '000000000000',
      Arn: 'arn:aws:iam::000000000000:user/wrong-account',
    });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
      }),
    ).rejects.toThrow(`AWS account must be ${AWS_ACCOUNT_ID}`);
    expect(f.getCallerIdentity).toHaveBeenCalledOnce();
    expect(f.getSecretValue).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.putParameter).not.toHaveBeenCalled();
  });

  it('rejects a keyring larger than the 4 KiB Standard parameter limit', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const oversizedValue = JSON.stringify({
      activeVersion: 'v0',
      ...Object.fromEntries(
        Array.from({ length: 48 }, (_, index) => [`v${index}`, SOURCE_KEY.repeat(2)]),
      ),
    });
    expect(Buffer.byteLength(oversizedValue, 'utf8')).toBeGreaterThan(4096);
    const f = fixture({ sourceValue: oversizedValue });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
      }),
    ).rejects.toThrow(/4 KiB|4096|Standard parameter/i);
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.putParameter).not.toHaveBeenCalled();
  });

  it('rejects an existing plaintext String target even when its keyring matches', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture({ targetValue: SOURCE_VALUE, targetType: 'String' });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
      }),
    ).rejects.toThrow(/SecureString/i);
    expect(f.putParameter).not.toHaveBeenCalled();
  });

  it('plans a dev migration using decrypted in-memory reads and exposes only fingerprints', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();

    const result = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
    });

    expect(f.getCallerIdentity).toHaveBeenCalledOnce();
    expect(f.getSecretValue).toHaveBeenCalledWith({ SecretId: SOURCE_SECRET_ID });
    expect(f.getParameter).toHaveBeenCalledWith({
      Name: TARGET_PARAMETER_NAME,
      WithDecryption: true,
    });
    expect(f.putParameter).not.toHaveBeenCalled();
    expect(f.generateSecretMaterial).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      command: 'plan',
      mode: 'migrate',
      stage: 'dev',
      source: {
        provider: 'secretsmanager',
        secretId: SOURCE_SECRET_ID,
        activeVersion: 'v1',
        keyVersions: ['v1'],
        fingerprint: sha256(SOURCE_VALUE),
      },
      target: {
        provider: 'ssm',
        parameterName: TARGET_PARAMETER_NAME,
        status: 'absent',
      },
    });
    expect(result.confirmationHash).toMatch(/^[a-f0-9]{64}$/);
    const publicCapture = JSON.stringify({ result, output: f.output });
    expect(publicCapture).toContain(sha256(SOURCE_VALUE));
    expect(publicCapture).toContain(result.confirmationHash as string);
    expectNoPlaintext(publicCapture, [SOURCE_KEY, SOURCE_VALUE]);
  });

  it('rejects a malformed source keyring before reading or writing the target', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture({
      sourceValue: JSON.stringify({ activeVersion: 'v2', v1: SOURCE_KEY }),
    });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
      }),
    ).rejects.toThrow(/invalid access-code HMAC keyring/i);
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.putParameter).not.toHaveBeenCalled();
    expectNoPlaintext(f.output, [SOURCE_KEY]);
  });

  it('requires the exact stage and plan hash before apply can write', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();
    const plan = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
    });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: [
          'apply',
          '--stage',
          'dev',
          '--mode',
          'migrate',
          '--confirm-stage',
          'test',
          '--confirm-hash',
          plan.confirmationHash,
        ],
      }),
    ).rejects.toThrow(/confirm-stage/i);
    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: [
          'apply',
          '--stage',
          'dev',
          '--mode',
          'migrate',
          '--confirm-stage',
          'dev',
          '--confirm-hash',
          '0'.repeat(64),
        ],
      }),
    ).rejects.toThrow(/confirmation hash/i);
    expect(f.putParameter).not.toHaveBeenCalled();
  });

  it('creates a new standard SecureString only after matching confirmation', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();
    const plan = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
    });
    f.output.length = 0;

    const result = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: [
        'apply',
        '--stage',
        'dev',
        '--mode',
        'migrate',
        '--confirm-stage',
        'dev',
        '--confirm-hash',
        plan.confirmationHash,
      ],
    });

    expect(f.putParameter).toHaveBeenCalledOnce();
    expect(f.putParameter).toHaveBeenCalledWith(
      expect.objectContaining({
        Name: TARGET_PARAMETER_NAME,
        Value: SOURCE_VALUE,
        Type: 'SecureString',
        Tier: 'Standard',
        KeyId: 'alias/aws/ssm',
        Overwrite: false,
        Tags: expect.arrayContaining([
          { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
          { Key: 'roadmap2u-stage', Value: 'dev' },
        ]),
      }),
    );
    expect(result).toMatchObject({
      command: 'apply',
      mode: 'migrate',
      stage: 'dev',
      status: 'created',
      changed: true,
    });
    expectNoPlaintext({ result, output: f.output }, [SOURCE_KEY, SOURCE_VALUE]);
  });

  it('treats an identical existing target as an idempotent no-op', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture({ targetValue: SOURCE_VALUE });
    const plan = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
    });

    const result = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: [
        'apply',
        '--stage',
        'dev',
        '--mode',
        'migrate',
        '--confirm-stage',
        'dev',
        '--confirm-hash',
        plan.confirmationHash,
      ],
    });

    expect(f.putParameter).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'already-migrated', changed: false });
    expectNoPlaintext({ result, output: f.output }, [SOURCE_KEY, SOURCE_VALUE]);
  });

  it('fails closed when the target parameter contains different key material', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture({ targetValue: DIFFERENT_VALUE });
    const plan = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', 'dev', '--mode', 'migrate'],
    });

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: [
          'apply',
          '--stage',
          'dev',
          '--mode',
          'migrate',
          '--confirm-stage',
          'dev',
          '--confirm-hash',
          plan.confirmationHash,
        ],
      }),
    ).rejects.toThrow(/target parameter differs/i);
    expect(f.putParameter).not.toHaveBeenCalled();
    expectNoPlaintext(f.output, [SOURCE_KEY, SOURCE_VALUE, DIFFERENT_KEY, DIFFERENT_VALUE]);
  });

  it.each([
    ['--value', ['plan', '--stage', 'dev', '--mode', 'migrate', '--value', SOURCE_KEY], {}],
    ['--secret', ['plan', '--stage', 'dev', '--mode', 'migrate', '--secret', SOURCE_KEY], {}],
    [
      '--secret-file',
      ['plan', '--stage', 'dev', '--mode', 'migrate', '--secret-file', 'C:\\secret\\hmac.json'],
      {},
    ],
    [
      'ACCESS_CODE_HMAC_VALUE',
      ['plan', '--stage', 'dev', '--mode', 'migrate'],
      { ACCESS_CODE_HMAC_VALUE: SOURCE_KEY },
    ],
  ])('rejects the plaintext input channel %s before any AWS read', async (_name, argv, env) => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();

    await expect(
      runAccessCodeHmacMigrationCli({ ...f.options, argv, env }),
    ).rejects.toThrow(/plaintext input.*forbidden/i);
    expect(f.getCallerIdentity).not.toHaveBeenCalled();
    expect(f.getSecretValue).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.putParameter).not.toHaveBeenCalled();
    expectNoPlaintext(f.output, [SOURCE_KEY]);
  });

  it.each(['qa', 'DEV', ''])('rejects the invalid stage %j before any AWS read', async (stage) => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', stage, '--mode', 'migrate'],
      }),
    ).rejects.toThrow(/stage must be dev, test, or prod|missing.*stage/i);
    expect(f.getCallerIdentity).not.toHaveBeenCalled();
    expect(f.getSecretValue).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
  });

  it.each(['test', 'prod'])('migrates the existing %s keyring without replacing it', async (stage) => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const parameterName = `/roadmap2u/${stage}/access-code-hmac/v1`;
    const secretId = `roadmap2u/${stage}/access-code-hmac/v1`;
    const f = fixture();

    const plan = await runAccessCodeHmacMigrationCli({
      ...f.options,
      argv: ['plan', '--stage', stage, '--mode', 'migrate'],
    });

    expect(f.getSecretValue).toHaveBeenCalledWith({ SecretId: secretId });
    expect(f.describeSecret).not.toHaveBeenCalled();
    expect(f.getParameter).toHaveBeenCalledWith({
      Name: parameterName,
      WithDecryption: true,
    });
    expect(plan).toMatchObject({ mode: 'migrate', stage });
  });

  it('refuses initialize when the stage already has a source secret', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();
    const f = fixture();

    await expect(
      runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', 'test', '--mode', 'initialize'],
      }),
    ).rejects.toThrow(/source secret.*exists.*migrate/i);
    expect(f.describeSecret).toHaveBeenCalledWith({
      SecretId: 'roadmap2u/test/access-code-hmac/v1',
    });
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.generateSecretMaterial).not.toHaveBeenCalled();
  });

  it('generates initialize material only after proving the source is absent', async () => {
    const { runAccessCodeHmacMigrationCli } = await cliModule();

    for (const stage of ['test', 'prod']) {
      const parameterName = `/roadmap2u/${stage}/access-code-hmac/v1`;
      const f = fixture({ sourceExists: false });
      const plan = await runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: ['plan', '--stage', stage, '--mode', 'initialize'],
      });

      expect(f.getSecretValue).not.toHaveBeenCalled();
      expect(f.describeSecret).toHaveBeenCalledWith({
        SecretId: `roadmap2u/${stage}/access-code-hmac/v1`,
      });
      expect(f.getParameter).toHaveBeenCalledWith({
        Name: parameterName,
        WithDecryption: true,
      });
      expect(f.generateSecretMaterial).not.toHaveBeenCalled();
      expectNoPlaintext({ plan, output: f.output }, [GENERATED_KEY]);
      f.output.length = 0;

      const result = await runAccessCodeHmacMigrationCli({
        ...f.options,
        argv: [
          'apply',
          '--stage',
          stage,
          '--mode',
          'initialize',
          '--confirm-stage',
          stage,
          '--confirm-hash',
          plan.confirmationHash,
        ],
      });

      expect(f.generateSecretMaterial).toHaveBeenCalledOnce();
      expect(f.putParameter).toHaveBeenCalledOnce();
      const input = f.putParameter.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input).toMatchObject({
        Name: parameterName,
        Type: 'SecureString',
        Tier: 'Standard',
        KeyId: 'alias/aws/ssm',
        Overwrite: false,
      });
      expect(input.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
          { Key: 'roadmap2u-stage', Value: stage },
        ]),
      );
      expect(JSON.parse(input.Value as string)).toEqual({
        activeVersion: 'v1',
        v1: GENERATED_KEY,
      });
      expectNoPlaintext({ result, output: f.output }, [GENERATED_KEY, input.Value as string]);
    }
  });
});
