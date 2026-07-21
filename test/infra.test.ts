import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { calculateContractHash, RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

const templates = new Map<string, Template>();

function backendTemplate(stage: 'dev' | 'test' | 'prod'): Template {
  const cached = templates.get(stage);
  if (cached) return cached;
  const app = new App();
  const stack = new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
    env: { account: ACCOUNT, region: 'us-east-1' },
    stage,
    hostedZoneId: HOSTED_ZONE_ID,
  } as never);
  const template = Template.fromStack(stack);
  templates.set(stage, template);
  return template;
}

describe('stage backend infrastructure', () => {
  it.each([
    ['dev', ['https://dev.roadmap2u.com', 'http://localhost:4200', 'http://localhost:8826']],
    ['test', ['https://test.roadmap2u.com', 'http://localhost:4200', 'http://localhost:8826']],
    ['prod', ['https://roadmap2u.com']],
  ] as const)('uses the exact %s resource names and CORS allowlist', (stage, origins) => {
    const template = backendTemplate(stage);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `roadmap-${stage}`,
    });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: `roadmap-users-${stage}`,
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: `roadmap-api-${stage}`,
      CorsConfiguration: {
        AllowOrigins: origins,
      },
    });
  });

  it('uses username-only Cognito and disposable dev data', () => {
    const template = backendTemplate('dev').toJSON();
    const pool = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::Cognito::UserPool',
    ) as any;
    const table = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::DynamoDB::Table',
    ) as any;

    expect(pool.Properties.AliasAttributes).toBeUndefined();
    expect(pool.Properties.AutoVerifiedAttributes).toEqual(['email']);
    expect(pool.Properties.UsernameConfiguration).toEqual({ CaseSensitive: false });
    expect(pool.Properties.UserPoolTags).toMatchObject({
      'roadmap2u-project': 'RoadMap2U',
      'roadmap2u-stage': 'dev',
    });
    expect(pool.Properties.VerificationMessageTemplate.DefaultEmailOption).toBe(
      'CONFIRM_WITH_CODE',
    );
    expect(pool.Properties.EmailConfiguration).toEqual({
      EmailSendingAccount: 'COGNITO_DEFAULT',
    });
    expect(pool.Properties.DeletionProtection).toBe('INACTIVE');
    expect(pool.DeletionPolicy).toBe('Delete');
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
    expect(table.Properties.DeletionProtectionEnabled).toBe(false);
    expect(table.DeletionPolicy).toBe('Delete');

    const clients = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::Cognito::UserPoolClient',
    ) as any[];
    expect(clients).toHaveLength(1);
    expect(clients[0].Properties.GenerateSecret).toBe(false);
    expect(clients[0].Properties.PreventUserExistenceErrors).toBe('ENABLED');
    expect(clients[0].Properties.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(clients[0].Properties.AllowedOAuthFlowsUserPoolClient).toBe(false);
    expect(clients[0].Properties.AllowedOAuthFlows).toBeUndefined();
    expect(clients[0].Properties.AllowedOAuthScopes).toBeUndefined();
    expect(clients[0].Properties.CallbackURLs).toBeUndefined();
    expect(clients[0].Properties.WriteAttributes).toEqual(['email', 'name']);
    expect(clients[0].Properties.WriteAttributes).not.toContain('custom:accountType');

    const postConfirmationPolicy = Object.values(template.Resources)
      .filter((resource: any) => resource.Type === 'AWS::IAM::Policy')
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement)
      .find((statement: any) =>
        JSON.stringify(statement.Action).includes('cognito-idp:AdminUpdateUserAttributes'),
      );
    expect(postConfirmationPolicy.Condition.StringEquals).toMatchObject({
      'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
      'aws:ResourceTag/roadmap2u-stage': 'dev',
    });
  });

  it.each([
    ['dev', 7],
    ['test', 14],
    ['prod', 30],
  ] as const)('retains %s Lambda logs for %d days and imports protected API logs', (stage, days) => {
    const template = backendTemplate(stage).toJSON();
    const logGroups = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::Logs::LogGroup',
    ) as any[];
    const lambdaLogs = logGroups.filter((resource) =>
      JSON.stringify(resource.Properties.LogGroupName).includes('/aws/lambda/'),
    );
    const apiLogs = logGroups.filter((resource) =>
      JSON.stringify(resource.Properties.LogGroupName).includes('/aws/apigateway/'),
    );

    expect(lambdaLogs).toHaveLength(3);
    expect(apiLogs).toHaveLength(0);
    expect(logGroups.every((resource) => resource.Properties.RetentionInDays === days)).toBe(true);

    const apiStage = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::ApiGatewayV2::Stage',
    ) as any;
    const destination = apiStage.Properties.AccessLogSettings.DestinationArn;
    const accessLogs = JSON.stringify(apiStage.Properties.AccessLogSettings);
    const serializedDestination = JSON.stringify(destination);
    expect(serializedDestination).toContain(`RoadMap2U-${stage}-ApiAccessLogGroupName`);
    expect(serializedDestination).not.toContain('ApiAccessLogGroupArn');
    expect(serializedDestination.match(/:\\u002a|:\*/g) ?? []).toHaveLength(1);
    expect(serializedDestination).not.toContain(':*:*');
    expect(accessLogs).toContain('$context.requestId');
    expect(accessLogs).toContain('$context.status');
    expect(accessLogs).not.toMatch(/authorization|identity|requestbody|header/i);
  });

  it.each(['dev', 'test', 'prod'] as const)(
    'places %s runtime roles under the stage path and applies the runtime boundary',
    (stage) => {
      const template = backendTemplate(stage).toJSON();
      const functions = Object.values(template.Resources).filter(
        (resource: any) => resource.Type === 'AWS::Lambda::Function',
      ) as any[];

      expect(functions).toHaveLength(3);
      for (const fn of functions) {
        const roleLogicalId = fn.Properties.Role['Fn::GetAtt'][0] as string;
        const role = template.Resources[roleLogicalId] as any;
        expect(role.Properties.Path).toBe(`/roadmap2u/${stage}/runtime/`);
        expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
          `/roadmap2u/${stage}/roadmap2u-${stage}-runtime-boundary`,
        );
        expect(role.Properties.Tags).toEqual(
          expect.arrayContaining([
            { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
            { Key: 'roadmap2u-stage', Value: stage },
          ]),
        );
      }
    },
  );

  it('uses no SES resources or permissions', () => {
    for (const stage of ['dev', 'test', 'prod'] as const) {
      const rendered = JSON.stringify(backendTemplate(stage).toJSON());
      expect(rendered).not.toContain('AWS::SES::');
      expect(rendered).not.toMatch(/ses:\*/i);
      expect(rendered).not.toMatch(/ses:[A-Za-z]/);
    }
  });

  it('runs both auth-contract triggers and permits Cognito to invoke each Lambda', () => {
    const template = backendTemplate('dev').toJSON();
    const [poolId, pool] = Object.entries(template.Resources).find(
      ([, resource]: [string, any]) => resource.Type === 'AWS::Cognito::UserPool',
    ) as [string, any];
    const functions = Object.entries(template.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::Lambda::Function',
    ) as [string, any][];
    const [preSignUpId, preSignUp] =
      functions.find(
        ([, resource]) => resource.Properties.FunctionName === 'roadmap-pre-signup-dev',
      ) ?? [];
    const [postConfirmationId, postConfirmation] =
      functions.find(
        ([, resource]) => resource.Properties.FunctionName === 'roadmap-post-confirmation-dev',
      ) ?? [];
    const cognitoPermissions = Object.values(template.Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::Lambda::Permission' &&
        resource.Properties.Principal === 'cognito-idp.amazonaws.com',
    ) as any[];

    expect(preSignUp).toBeDefined();
    expect(postConfirmation).toBeDefined();
    expect(pool.Properties.LambdaConfig).toEqual({
      PreSignUp: { 'Fn::GetAtt': [preSignUpId, 'Arn'] },
      PostConfirmation: { 'Fn::GetAtt': [postConfirmationId, 'Arn'] },
    });
    expect(cognitoPermissions).toHaveLength(2);
    expect(cognitoPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Properties: expect.objectContaining({
            Action: 'lambda:InvokeFunction',
            Principal: 'cognito-idp.amazonaws.com',
            FunctionName: { 'Fn::GetAtt': [preSignUpId, 'Arn'] },
            SourceArn: { 'Fn::GetAtt': [poolId, 'Arn'] },
          }),
        }),
        expect.objectContaining({
          Properties: expect.objectContaining({
            Action: 'lambda:InvokeFunction',
            Principal: 'cognito-idp.amazonaws.com',
            FunctionName: { 'Fn::GetAtt': [postConfirmationId, 'Arn'] },
            SourceArn: { 'Fn::GetAtt': [poolId, 'Arn'] },
          }),
        }),
      ]),
    );

    const preSignUpRoleId = preSignUp.Properties.Role['Fn::GetAtt'][0] as string;
    const preSignUpRole = template.Resources[preSignUpRoleId] as any;
    expect(preSignUpRole.Type).toBe('AWS::IAM::Role');
    expect(JSON.stringify(preSignUpRole.Properties.ManagedPolicyArns)).toContain(
      ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    );
    expect(preSignUpRole.Properties.Policies).toBeUndefined();
  });

  it('retains and protects production identity and data', () => {
    const template = backendTemplate('prod').toJSON();
    const pool = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::Cognito::UserPool',
    ) as any;
    const table = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::DynamoDB::Table',
    ) as any;

    expect(pool.Properties.DeletionProtection).toBe('ACTIVE');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(table.DeletionPolicy).toBe('Retain');
  });

  it.each([
    ['dev', 'api.dev.roadmap2u.com'],
    ['test', 'api.test.roadmap2u.com'],
    ['prod', 'api.roadmap2u.com'],
  ] as const)('maps the %s API custom domain in Route 53', (stage, domainName) => {
    const template = backendTemplate(stage);

    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: domainName,
      DomainNameConfigurations: Match.arrayWith([
        Match.objectLike({ EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }),
      ]),
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('publishes the public client configuration and JWT authorizer', () => {
    const template = backendTemplate('dev');
    for (const name of [
      'region',
      'user-pool-id',
      'user-pool-client-id',
      'api-base-url',
      'contract-hash',
    ]) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/roadmap2u/dev/${name}`,
        Type: 'String',
      });
    }
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: Match.objectLike({ Audience: Match.anyValue(), Issuer: Match.anyValue() }),
    });
  });

  it('uses the same canonical cross-platform contract hash as the release script', () => {
    const scriptHash = execFileSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'contracts-hash.mjs')],
      { encoding: 'utf8' },
    ).trim();
    expect(calculateContractHash()).toBe(scriptHash);
    expect(scriptHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
