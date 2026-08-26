import { describe, expect, it, vi } from 'vitest';
import {
  createDynamoAccessCodeRedemptionDeps,
  createDynamoSponsoredAccessBrokerDeps,
  type AccessCodeDynamoOptions,
} from '../lambda/commercial/access-code-dynamo';

const PARAMETER_NAME = '/roadmap2u/dev/access-code-hmac/v1';
const PARAMETER_ARN =
  'arn:aws:ssm:us-east-1:123456789012:parameter/roadmap2u/dev/access-code-hmac/v1';
const V1_KEY = 'a'.repeat(64);
const V2_KEY = 'b'.repeat(64);
const PARAMETER_VALUE = JSON.stringify({ activeVersion: 'v2', v1: V1_KEY, v2: V2_KEY });

interface ParameterResponse {
  readonly Parameter: {
    readonly Name: string;
    readonly Type: 'String' | 'SecureString';
    readonly Value?: string;
    readonly Version: number;
    readonly LastModifiedDate: Date;
    readonly ARN: string;
    readonly DataType: 'text';
  };
  readonly $metadata: {
    readonly httpStatusCode: number;
    readonly requestId: string;
    readonly attempts: number;
    readonly totalRetryDelay: number;
  };
}

function parameterResponse(
  value?: string,
  type: 'String' | 'SecureString' = 'SecureString',
): ParameterResponse {
  return {
    Parameter: {
      Name: PARAMETER_NAME,
      Type: type,
      ...(value === undefined ? {} : { Value: value }),
      Version: 1,
      LastModifiedDate: new Date('2026-08-25T00:00:00.000Z'),
      ARN: PARAMETER_ARN,
      DataType: 'text',
    },
    $metadata: {
      httpStatusCode: 200,
      requestId: '11111111-2222-4333-8444-555555555555',
      attempts: 1,
      totalRetryDelay: 0,
    },
  };
}

function optionsWith(response: ParameterResponse) {
  const send = vi.fn(async (_command: unknown) => response);
  const options = {
    ddb: { send: vi.fn() },
    ssm: { send },
    tableName: 'roadmap-dev',
    auditTableName: 'roadmap-access-audit-dev',
    parameterName: PARAMETER_NAME,
    stage: 'dev',
    now: () => Date.parse('2026-08-25T00:00:00.000Z'),
  } as unknown as AccessCodeDynamoOptions;
  return { options, send };
}

function expectEncryptedParameterRead(send: ReturnType<typeof vi.fn>): void {
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0]?.[0] as
    | { readonly constructor: { readonly name: string }; readonly input: unknown }
    | undefined;
  expect(command?.constructor.name).toBe('GetParameterCommand');
  expect(command?.input).toEqual({
    Name: PARAMETER_NAME,
    WithDecryption: true,
  });
}

describe('access-code HMAC SSM adapter', () => {
  it('reads the requested redemption key from a decrypted SecureString parameter', async () => {
    const { options, send } = optionsWith(parameterResponse(PARAMETER_VALUE));
    const deps = createDynamoAccessCodeRedemptionDeps(options);

    const key = await deps.readSecretKey('v1');

    expect(Buffer.from(key ?? [])).toEqual(Buffer.from(V1_KEY));
    expectEncryptedParameterRead(send);
  });

  it('rejects a redemption key read when Parameter.Value is absent', async () => {
    const { options, send } = optionsWith(parameterResponse());
    const deps = createDynamoAccessCodeRedemptionDeps(options);

    await expect(deps.readSecretKey('v1')).rejects.toThrow();
    expectEncryptedParameterRead(send);
  });

  it('rejects plaintext String parameters even when the keyring is valid', async () => {
    const { options, send } = optionsWith(parameterResponse(PARAMETER_VALUE, 'String'));
    const deps = createDynamoAccessCodeRedemptionDeps(options);

    await expect(deps.readSecretKey('v1')).rejects.toThrow(/SecureString/i);
    expectEncryptedParameterRead(send);
  });

  it('reads the active issuance key from a decrypted SecureString parameter', async () => {
    const { options, send } = optionsWith(parameterResponse(PARAMETER_VALUE));
    const deps = createDynamoSponsoredAccessBrokerDeps(options, []);

    const active = await deps.readActiveSecretKey();

    expect(active).toEqual({ version: 'v2', key: Buffer.from(V2_KEY) });
    expectEncryptedParameterRead(send);
  });

  it('rejects an active issuance key read when Parameter.Value is absent', async () => {
    const { options, send } = optionsWith(parameterResponse());
    const deps = createDynamoSponsoredAccessBrokerDeps(options, []);

    await expect(deps.readActiveSecretKey()).rejects.toThrow();
    expectEncryptedParameterRead(send);
  });
});
