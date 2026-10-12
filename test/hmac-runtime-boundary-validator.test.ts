import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type BoundaryValidatorModule = {
  validateHmacRuntimeBoundary(options: {
    readonly mode: 'ssm' | 'secrets-manager';
    readonly parameterResource?: string;
    readonly policyDocument: Record<string, unknown>;
    readonly retainedSecretResource?: string;
  }): void;
};

const MODULE_PATH = join(
  process.cwd(),
  'scripts',
  'validate-hmac-runtime-boundary.mjs',
);
const PARAMETER_RESOURCE =
  'arn:aws:ssm:us-east-1:765932874577:parameter/roadmap2u/dev/access-code-hmac/v1';
const SECRET_RESOURCE =
  'arn:aws:secretsmanager:us-east-1:765932874577:secret:roadmap2u/dev/access-code-hmac/v1-*';

async function validatorModule(): Promise<BoundaryValidatorModule> {
  return import(pathToFileURL(MODULE_PATH).href) as Promise<BoundaryValidatorModule>;
}

function ssmStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Sid: 'ReadOnlySponsoredAccessHmacParameter',
    Effect: 'Allow',
    Action: 'ssm:GetParameter',
    Resource: PARAMETER_RESOURCE,
    ...overrides,
  };
}

function secretStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Sid: 'ReadOnlyRetainedSponsoredAccessHmacSecretDuringMigration',
    Effect: 'Allow',
    Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
    Resource: SECRET_RESOURCE,
    ...overrides,
  };
}

function validate(
  validateHmacRuntimeBoundary: BoundaryValidatorModule['validateHmacRuntimeBoundary'],
  statements: ReadonlyArray<Record<string, unknown>>,
  mode: 'ssm' | 'secrets-manager' = 'ssm',
): void {
  validateHmacRuntimeBoundary({
    mode,
    parameterResource: mode === 'ssm' ? PARAMETER_RESOURCE : undefined,
    policyDocument: { Version: '2012-10-17', Statement: statements },
    retainedSecretResource: SECRET_RESOURCE,
  });
}

describe('HMAC runtime-boundary validator', () => {
  it('accepts only the exact SSM transition statements alongside unrelated permissions', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();

    expect(() =>
      validate(validateHmacRuntimeBoundary, [
        { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: '*' },
        ssmStatement(),
        secretStatement(),
      ]),
    ).not.toThrow();
  });

  it('accepts an SSM-only boundary for a stage initialized without a legacy secret', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [ssmStatement()],
    };

    expect(() =>
      validateHmacRuntimeBoundary({
        mode: 'ssm',
        parameterResource: PARAMETER_RESOURCE,
        policyDocument,
      }),
    ).not.toThrow();
    expect(() =>
      validateHmacRuntimeBoundary({
        mode: 'ssm',
        parameterResource: PARAMETER_RESOURCE,
        policyDocument: {
          ...policyDocument,
          Statement: [ssmStatement(), secretStatement()],
        },
      }),
    ).toThrow('Expected 0 Secrets Manager allow statement(s)');
  });

  it('still requires the exact secret resource in legacy mode', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();

    expect(() =>
      validateHmacRuntimeBoundary({
        mode: 'secrets-manager',
        policyDocument: { Version: '2012-10-17', Statement: [secretStatement()] },
      }),
    ).toThrow('retainedSecretResource is required in secrets-manager mode');
  });

  it('accepts the exact legacy Secrets Manager statement and no SSM authority', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();

    expect(() => validate(validateHmacRuntimeBoundary, [secretStatement()], 'secrets-manager')).not.toThrow();
  });

  it.each([
    {
      name: 'mixed-case broad SSM authority',
      statement: { Effect: 'Allow', Action: 'SSM:GetParameter', Resource: '*' },
    },
    {
      name: 'question-mark action wildcard',
      statement: { Effect: 'Allow', Action: 'ss?:GetParameter', Resource: '*' },
    },
    {
      name: 'relevant explicit deny',
      statement: { Effect: 'Deny', Action: 'SSM:GetParameter', Resource: PARAMETER_RESOURCE },
    },
    {
      name: 'allow NotAction',
      statement: { Effect: 'Allow', NotAction: 'logs:CreateLogGroup', Resource: '*' },
    },
  ])('rejects $name', async ({ statement }) => {
    const { validateHmacRuntimeBoundary } = await validatorModule();

    expect(() =>
      validate(validateHmacRuntimeBoundary, [ssmStatement(), secretStatement(), statement]),
    ).toThrow();
  });

  it('rejects a condition or extra action on an expected statement', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();

    expect(() =>
      validate(validateHmacRuntimeBoundary, [
        ssmStatement({ Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } }),
        secretStatement(),
      ]),
    ).toThrow();
    expect(() =>
      validate(validateHmacRuntimeBoundary, [
        ssmStatement({ Action: ['ssm:GetParameter', 'ssm:GetParameters'] }),
        secretStatement(),
      ]),
    ).toThrow();
  });
});

const STRIPE_PARAMETER_RESOURCES = [
  'arn:aws:ssm:us-east-1:765932874577:parameter/roadmap2u/dev/stripe/config',
  'arn:aws:ssm:us-east-1:765932874577:parameter/roadmap2u/dev/stripe/webhook-secret',
] as const;

function stripeStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Sid: 'ReadOnlyStageStripeParameters',
    Effect: 'Allow',
    Action: 'ssm:GetParameter',
    Resource: STRIPE_PARAMETER_RESOURCES,
    ...overrides,
  };
}

function boundaryWithStripe(mode: 'ssm' | 'secrets-manager', statement = stripeStatement()) {
  return [
    ...(mode === 'ssm' ? [ssmStatement()] : []),
    secretStatement(),
    statement,
  ];
}

describe('HMAC validation with the installed Stripe parameter authority', () => {
  it.each(['ssm', 'secrets-manager'] as const)(
    'accepts the two exact same-stage Stripe parameters in %s mode',
    async (mode) => {
      const { validateHmacRuntimeBoundary } = await validatorModule();
      expect(() => validate(validateHmacRuntimeBoundary, boundaryWithStripe(mode), mode)).not.toThrow();
    },
  );

  it('accepts the exact Stripe statement in an SSM stage without a retained secret', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    expect(() => validateHmacRuntimeBoundary({
      mode: 'ssm',
      parameterResource: PARAMETER_RESOURCE,
      policyDocument: { Statement: [ssmStatement(), stripeStatement()] },
    })).not.toThrow();
  });

  const invalidStripeAuthorities = [
    { name: 'resource wildcard', overrides: { Resource: STRIPE_PARAMETER_RESOURCES[0].replace('/config', '/*') } },
    { name: 'missing signing parameter', overrides: { Resource: [STRIPE_PARAMETER_RESOURCES[0]] } },
    { name: 'extra parameter', overrides: { Resource: [...STRIPE_PARAMETER_RESOURCES, PARAMETER_RESOURCE] } },
    { name: 'cross-stage parameter', overrides: { Resource: STRIPE_PARAMETER_RESOURCES.map((r) => r.replace('/dev/', '/test/')) } },
    { name: 'cross-account parameter', overrides: { Resource: STRIPE_PARAMETER_RESOURCES.map((r) => r.replace('765932874577', '123456789012')) } },
    { name: 'cross-region parameter', overrides: { Resource: STRIPE_PARAMETER_RESOURCES.map((r) => r.replace('us-east-1', 'us-west-2')) } },
    { name: 'bulk read', overrides: { Action: ['ssm:GetParameter', 'ssm:GetParameters'] } },
    { name: 'write permission', overrides: { Action: ['ssm:GetParameter', 'ssm:PutParameter'] } },
    { name: 'NotResource', overrides: { NotResource: '*' } },
    { name: 'condition', overrides: { Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } } },
    { name: 'unrecognized Sid', overrides: { Sid: 'OtherSsmAuthority' } },
    { name: 'duplicate resource', overrides: { Resource: [STRIPE_PARAMETER_RESOURCES[0], STRIPE_PARAMETER_RESOURCES[0]] } },
  ];
  for (const mode of ['ssm', 'secrets-manager'] as const) {
    it.each(invalidStripeAuthorities)(`rejects $name in ${mode} mode`, async ({ overrides }) => {
      const { validateHmacRuntimeBoundary } = await validatorModule();
      expect(() => validate(validateHmacRuntimeBoundary, boundaryWithStripe(mode, stripeStatement(overrides)), mode)).toThrow();
    });

    it(`rejects duplicate Stripe statements in ${mode} mode`, async () => {
      const { validateHmacRuntimeBoundary } = await validatorModule();
      expect(() => validate(validateHmacRuntimeBoundary, [...boundaryWithStripe(mode), stripeStatement()], mode)).toThrow();
    });
  }

  it('still requires the HMAC parameter in SSM mode when Stripe authority is present', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    expect(() => validate(validateHmacRuntimeBoundary, [secretStatement(), stripeStatement()])).toThrow();
  });

  it('still forbids HMAC SSM authority in legacy Secrets Manager mode', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    expect(() => validate(validateHmacRuntimeBoundary, boundaryWithStripe('ssm'), 'secrets-manager')).toThrow();
  });

  it('rejects Stripe authority when its stage cannot be derived from the expected HMAC resource', async () => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    const unknownHmacResource = PARAMETER_RESOURCE.replace('/access-code-hmac/v1', '/other-hmac');
    expect(() => validateHmacRuntimeBoundary({
      mode: 'ssm',
      parameterResource: unknownHmacResource,
      policyDocument: { Statement: [ssmStatement({ Resource: unknownHmacResource }), stripeStatement()] },
    })).toThrow();
  });

  it.each([
    { name: 'region', find: 'us-east-1', replacement: 'us-east-*' },
    { name: 'partition', find: 'arn:aws:', replacement: 'arn:aws*:' },
  ])('rejects wildcard $name in the expected authority context', async ({ find, replacement }) => {
    const { validateHmacRuntimeBoundary } = await validatorModule();
    expect(() => validateHmacRuntimeBoundary({
      mode: 'ssm',
      parameterResource: PARAMETER_RESOURCE.replace(find, replacement),
      policyDocument: { Statement: [
        ssmStatement({ Resource: PARAMETER_RESOURCE.replace(find, replacement) }),
        stripeStatement({ Resource: STRIPE_PARAMETER_RESOURCES.map((r) => r.replace(find, replacement)) }),
      ] },
    })).toThrow();
  });
});
