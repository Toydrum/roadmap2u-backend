import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapCiBootstrapStack, RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

function backend(stage: 'dev' | 'test' | 'prod' = 'dev'): any {
  const app = new App();
  return Template.fromStack(
    new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
      env: { account: ACCOUNT, region: 'us-east-1' },
      stage,
      hostedZoneId: HOSTED_ZONE_ID,
    }),
  ).toJSON();
}

function bootstrap(): any {
  const app = new App();
  return Template.fromStack(
    new RoadmapCiBootstrapStack(app, 'Roadmap-CiBootstrap', {
      env: { account: ACCOUNT, region: 'us-east-1' },
      hostedZoneId: HOSTED_ZONE_ID,
      githubOwner: 'Toydrum',
      githubOwnerId: '61118847',
      backendRepository: 'roadmap2u-backend',
      backendRepositoryId: '1307128632',
      frontendRepository: 'RoadMap2U',
      frontendRepositoryId: '741787733',
      operationsPrincipalArn: `arn:aws:iam::${ACCOUNT}:user/Hector-admin`,
    }),
  ).toJSON();
}

function functionByName(template: any, name: string): [string, any] {
  const found = Object.entries(template.Resources).find(
    ([, resource]: [string, any]) =>
      resource.Type === 'AWS::Lambda::Function' && resource.Properties.FunctionName === name,
  ) as [string, any] | undefined;
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function roleStatements(template: any, roleId: string): any[] {
  return Object.values(template.Resources)
    .filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Policy' &&
        JSON.stringify(resource.Properties.Roles).includes(`\"Ref\":\"${roleId}\"`),
    )
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
}

function statementBySid(statements: any[], sid: string): any {
  const statement = statements.find((candidate) => candidate.Sid === sid);
  if (!statement) throw new Error(`missing IAM statement ${sid}`);
  return statement;
}

describe('sponsored access code infrastructure', () => {
  it.each(['dev', 'test', 'prod'] as const)(
    'creates an AWS-generated versioned %s HMAC secret without plaintext',
    (stage) => {
      const template = backend(stage);
      const secret = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::SecretsManager::Secret' &&
          resource.Properties.Name === `roadmap2u/${stage}/access-code-hmac/v1`,
      ) as any;

      expect(secret.Properties.GenerateSecretString).toMatchObject({
        SecretStringTemplate: JSON.stringify({ activeVersion: 'v1' }),
        GenerateStringKey: 'v1',
        ExcludePunctuation: true,
        PasswordLength: 64,
      });
      expect(secret.Properties.SecretString).toBeUndefined();
      expect(JSON.stringify(template)).not.toContain('RM2U1.');
    },
    20_000,
  );

  it(
    'renders redemption throttling with CloudFormation route-setting field names',
    () => {
      const template = backend();
      const defaultStage = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::ApiGatewayV2::Stage' &&
          resource.Properties.StageName === '$default',
      ) as any;

      expect(defaultStage.Properties.RouteSettings).toEqual({
        'POST /v1/access-codes/redeem': {
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2,
        },
      });
      expect(JSON.stringify(defaultStage.Properties.RouteSettings)).not.toMatch(
        /throttling(?:Burst|Rate)Limit/,
      );
    },
    20_000,
  );

  it('exposes JWT-only redemption and an isolated IAM-only operator broker', () => {
    const template = backend();
    const [redeemerId, redeemer] = functionByName(template, 'roadmap-access-code-redeemer-dev');
    const [brokerId, broker] = functionByName(template, 'roadmap-sponsored-access-broker-dev');
    const routes = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::ApiGatewayV2::Route',
    ) as any[];
    const route = (key: string) =>
      routes.find((candidate) => candidate.Properties.RouteKey === key)?.Properties;
    const functionUrl = Object.values(template.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::Lambda::Url' &&
        resource.Properties.TargetFunctionArn?.['Fn::GetAtt']?.[0] === brokerId,
    ) as any;

    expect(route('POST /v1/access-codes/redeem')).toMatchObject({
      AuthorizationType: 'JWT',
    });
    expect(route('POST /v1/access-codes/redeem').AuthorizerId).toBeDefined();
    expect(route('POST /v1/access-codes/redeem').Target).not.toEqual(
      route('ANY /v1/{proxy+}').Target,
    );
    const redeemerIntegration = Object.entries(template.Resources).find(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::ApiGatewayV2::Integration' &&
        JSON.stringify(resource.Properties.IntegrationUri).includes(redeemerId),
    ) as [string, any] | undefined;
    expect(redeemerIntegration).toBeDefined();
    expect(JSON.stringify(route('POST /v1/access-codes/redeem').Target)).toContain(
      redeemerIntegration?.[0],
    );
    expect(functionUrl.Properties).toMatchObject({ AuthType: 'AWS_IAM' });
    expect(functionUrl.Properties.Cors).toBeUndefined();

    for (const fn of [redeemer, broker]) {
      expect(fn.Properties.Environment.Variables).toMatchObject({
        TABLE_NAME: { Ref: expect.stringMatching(/^Table/) },
        AUDIT_TABLE_NAME: { Ref: expect.stringMatching(/^AccessAuditTable/) },
        ACCESS_CODE_SECRET_ID: { Ref: expect.stringMatching(/^AccessCodeHmacSecret/) },
        COMMERCIAL_STAGE: 'dev',
      });
    }
    expect(JSON.parse(broker.Properties.Environment.Variables.SPONSORED_ACCESS_ALLOWLIST)).toEqual([
      {
        accountId: ACCOUNT,
        roleName: 'roadmap2u-dev-sponsored-access-operator',
        stage: 'dev',
        commands: ['issue-code', 'revoke-code', 'extend-grant', 'revoke-grant', 'metadata'],
      },
    ]);

    const redeemerRoleId = redeemer.Properties.Role['Fn::GetAtt'][0] as string;
    const brokerRoleId = broker.Properties.Role['Fn::GetAtt'][0] as string;
    const redeemerStatements = roleStatements(template, redeemerRoleId);
    const brokerStatements = roleStatements(template, brokerRoleId);
    const redeemerPolicy = JSON.stringify(redeemerStatements);
    const brokerPolicy = JSON.stringify(brokerStatements);
    expect(redeemerPolicy).toMatch(/dynamodb:GetItem/);
    expect(redeemerPolicy).toMatch(/dynamodb:UpdateItem/);
    expect(redeemerPolicy).toMatch(/dynamodb:ConditionCheckItem/);
    expect(redeemerPolicy).toContain('TransactWriteItems');
    expect(brokerPolicy).toMatch(/dynamodb:GetItem/);
    expect(brokerPolicy).toMatch(/dynamodb:ConditionCheckItem/);
    expect(brokerPolicy).toContain('TransactWriteItems');
    expect(redeemerPolicy).toMatch(/secretsmanager:GetSecretValue/);
    expect(brokerPolicy).toMatch(/secretsmanager:GetSecretValue/);
    expect(redeemerPolicy).not.toMatch(/secretsmanager:(?:Put|Update|Delete)/);
    expect(brokerPolicy).not.toMatch(/secretsmanager:(?:Put|Update|Delete)/);

    expect(
      statementBySid(brokerStatements, 'ReadSponsoredAccessState').Condition,
    ).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [
          'COMMERCIAL#CONFIG',
          'ACCESS_CODE#*',
          'ADMIN#SPONSORED',
          'USER#*',
        ],
      },
    });
    expect(
      statementBySid(redeemerStatements, 'ReadSponsoredAccessRedemptionState').Condition,
    ).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': [
          'COMMERCIAL#CONFIG',
          'ACCESS_CODE#*',
          'ACCOUNT_CLOSURE#*',
          'USER#*',
        ],
      },
    });
    expect(
      statementBySid(redeemerStatements, 'ConsumeSponsoredAccessAttempt').Condition,
    ).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': 'ACCESS_CODE_ATTEMPT#*',
      },
    });

    expect(template.Outputs).toHaveProperty('SponsoredAccessBrokerFunctionUrl');
    expect(template.Outputs).toHaveProperty('SponsoredAccessBrokerFunctionArn');
  }, 20_000);

  it('creates one MFA-only operator per stage with broker URL invocation only', () => {
    const template = bootstrap();
    for (const stage of ['dev', 'test', 'prod']) {
      const role = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::IAM::Role' &&
          resource.Properties.RoleName === `roadmap2u-${stage}-sponsored-access-operator`,
      ) as any;
      const roleId = Object.entries(template.Resources).find(([, value]) => value === role)?.[0];
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
        'aws:MultiFactorAuthPresent',
      );
      const statements = roleStatements(template, roleId as string);
      const serialized = JSON.stringify(statements);
      expect(serialized).toContain(`:function:roadmap-sponsored-access-broker-${stage}`);
      expect(serialized).toContain('lambda:InvokeFunctionUrl');
      expect(serialized).toContain('lambda:InvokedViaFunctionUrl');
      expect(serialized).not.toMatch(/dynamodb:|secretsmanager:/i);
      expect(template.Outputs).toHaveProperty(`${stage}SponsoredAccessOperatorRoleArn`);
      const deployPolicy = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::IAM::ManagedPolicy' &&
          resource.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-commercial-access`,
      ) as any;
      const deployStatements = deployPolicy.Properties.PolicyDocument.Statement;
      expect(JSON.stringify(deployStatements)).toContain(
        `:function:roadmap-access-code-redeemer-${stage}`,
      );
      expect(JSON.stringify(deployStatements)).toContain(
        `:function:roadmap-sponsored-access-broker-${stage}`,
      );
      expect(JSON.stringify(deployStatements)).toContain(
        `secret:roadmap2u/${stage}/access-code-hmac/v1-*`,
      );
      expect(
        deployStatements.find(
          (statement: any) => statement.Sid === 'GenerateOnlySponsoredAccessSecretPassword',
        ),
      ).toEqual({
        Action: 'secretsmanager:GetRandomPassword',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
        Effect: 'Allow',
        Resource: '*',
        Sid: 'GenerateOnlySponsoredAccessSecretPassword',
      });
      expect(
        deployStatements
          .filter(
            (statement: any) =>
              statement.Sid !== 'GenerateOnlySponsoredAccessSecretPassword',
          )
          .every((statement: any) => statement.Resource !== '*'),
      ).toBe(true);
      expect(template.Outputs).toHaveProperty(`${stage}CfnCommercialAccessPolicyArn`);
    }
  });
});
