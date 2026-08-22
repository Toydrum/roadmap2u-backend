import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { calculateContractHash, RoadmapStack } from '../lib/roadmap-stack';
import { AuditWriter } from '../lambda/commercial/audit';

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
  it('keeps CORS preflight unauthenticated while application routes require JWT', () => {
    const template = backendTemplate('dev').toJSON();
    const routes = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::ApiGatewayV2::Route',
    ) as any[];
    const preflight = routes.find(
      (resource) => resource.Properties.RouteKey === 'OPTIONS /v1/{proxy+}',
    );
    const application = routes.find(
      (resource) => resource.Properties.RouteKey === 'ANY /v1/{proxy+}',
    );

    expect(preflight).toBeDefined();
    expect(preflight.Properties.AuthorizationType).toBe('NONE');
    expect(preflight.Properties.AuthorizerId).toBeUndefined();
    expect(preflight.Properties.Target).toBeDefined();
    expect(application.Properties.AuthorizationType).toBe('JWT');
    expect(application.Properties.AuthorizerId).toBeDefined();
    expect(preflight.Properties.Target).toEqual(application.Properties.Target);
  }, 20_000);

  it.each([
    ['dev', ['https://dev.roadmap2u.com', 'http://localhost:4200', 'http://localhost:8826']],
    ['test', ['https://test.roadmap2u.com', 'http://localhost:4200', 'http://localhost:8826']],
    ['prod', ['https://roadmap2u.com']],
  ] as const)(
    'uses the exact %s resource names and CORS allowlist',
    (stage, origins) => {
      const template = backendTemplate(stage);

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `roadmap-${stage}`,
      });
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `roadmap-access-audit-${stage}`,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
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
    },
    20_000,
  );

  it('uses username-only Cognito and disposable dev data', () => {
    const template = backendTemplate('dev').toJSON();
    const pool = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::Cognito::UserPool',
    ) as any;
    const table = Object.values(template.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::DynamoDB::Table' && resource.Properties.TableName === 'roadmap-dev',
    ) as any;
    const auditTable = Object.values(template.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        resource.Properties.TableName === 'roadmap-access-audit-dev',
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
    expect(auditTable.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
    expect(auditTable.Properties.DeletionProtectionEnabled).toBe(false);
    expect(auditTable.DeletionPolicy).toBe('Delete');

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
  ] as const)(
    'retains %s Lambda logs for %d days and imports protected API logs',
    (stage, days) => {
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

      expect(lambdaLogs.map((resource) => resource.Properties.LogGroupName).sort()).toEqual(
        [
          `/aws/lambda/roadmap-access-code-redeemer-${stage}`,
          `/aws/lambda/roadmap-access-reader-${stage}`,
          `/aws/lambda/roadmap-account-closure-reconciler-${stage}`,
          `/aws/lambda/roadmap-account-closure-request-${stage}`,
          `/aws/lambda/roadmap-account-closure-worker-${stage}`,
          `/aws/lambda/roadmap-catalog-${stage}`,
          `/aws/lambda/roadmap-commercial-config-broker-${stage}`,
          `/aws/lambda/roadmap-commercial-inventory-executor-${stage}`,
          `/aws/lambda/roadmap-post-confirmation-${stage}`,
          `/aws/lambda/roadmap-pre-signup-${stage}`,
          `/aws/lambda/roadmap-router-${stage}`,
          `/aws/lambda/roadmap-sponsored-access-broker-${stage}`,
        ].sort(),
      );
      expect(apiLogs).toHaveLength(0);
      expect(logGroups.every((resource) => resource.Properties.RetentionInDays === days)).toBe(
        true,
      );

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
    },
  );

  it.each(['dev', 'test', 'prod'] as const)(
    'places %s runtime roles under the stage path and applies the runtime boundary',
    (stage) => {
      const template = backendTemplate(stage).toJSON();
      const functions = Object.values(template.Resources).filter(
        (resource: any) => resource.Type === 'AWS::Lambda::Function',
      ) as any[];

      expect(functions.map((fn) => fn.Properties.FunctionName).sort()).toEqual(
        [
          `roadmap-access-code-redeemer-${stage}`,
          `roadmap-access-reader-${stage}`,
          `roadmap-account-closure-reconciler-${stage}`,
          `roadmap-account-closure-request-${stage}`,
          `roadmap-account-closure-worker-${stage}`,
          `roadmap-catalog-${stage}`,
          `roadmap-commercial-config-broker-${stage}`,
          `roadmap-commercial-inventory-executor-${stage}`,
          `roadmap-post-confirmation-${stage}`,
          `roadmap-pre-signup-${stage}`,
          `roadmap-router-${stage}`,
          `roadmap-sponsored-access-broker-${stage}`,
        ].sort(),
      );
      for (const fn of functions) {
        const roleLogicalId = fn.Properties.Role['Fn::GetAtt'][0] as string;
        const role = template.Resources[roleLogicalId] as any;
        expect(role.Properties.Path).toBe(`/roadmap2u/${stage}/runtime/`);
        const boundaryName =
          fn.Properties.FunctionName === `roadmap-commercial-inventory-executor-${stage}`
            ? `roadmap2u-${stage}-inventory-runtime-boundary`
            : `roadmap2u-${stage}-runtime-boundary`;
        expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
          `/roadmap2u/${stage}/${boundaryName}`,
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
    const preSignUpPolicies = Object.values(template.Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Policy' &&
        JSON.stringify(resource.Properties.Roles).includes(preSignUpRoleId),
    ) as any[];
    expect(preSignUpPolicies).toHaveLength(1);
    expect(preSignUpPolicies[0].Properties.PolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Sid: 'DenyCommercialConfigWrites',
        Effect: 'Deny',
      }),
    ]);
  });

  it('retains and protects production identity and data', () => {
    const template = backendTemplate('prod').toJSON();
    const pool = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::Cognito::UserPool',
    ) as any;
    const table = Object.values(template.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        resource.Properties.TableName === 'roadmap-prod',
    ) as any;
    const auditTable = Object.values(template.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        resource.Properties.TableName === 'roadmap-access-audit-prod',
    ) as any;

    expect(pool.Properties.DeletionProtection).toBe('ACTIVE');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(auditTable.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(auditTable.Properties.DeletionProtectionEnabled).toBe(true);
    expect(auditTable.DeletionPolicy).toBe('Retain');
    expect(auditTable.UpdateReplacePolicy).toBe('Retain');
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

  it.each(['dev', 'test', 'prod'] as const)(
    'exposes the %s commercial config broker only through an AWS_IAM Function URL',
    (stage) => {
      const rendered = backendTemplate(stage).toJSON();
      const [functionId, fn] = Object.entries(rendered.Resources).find(
        ([, resource]: [string, any]) =>
          resource.Type === 'AWS::Lambda::Function' &&
          resource.Properties.FunctionName === `roadmap-commercial-config-broker-${stage}`,
      ) as [string, any];
      const functionUrl = Object.values(rendered.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::Lambda::Url' &&
          resource.Properties.TargetFunctionArn?.['Fn::GetAtt']?.[0] === functionId,
      ) as any;

      expect(fn).toBeDefined();
      expect(fn.Properties.Environment.Variables).toMatchObject({
        TABLE_NAME: { Ref: expect.stringMatching(/^Table/) },
        AUDIT_TABLE_NAME: { Ref: expect.stringMatching(/^AccessAuditTable/) },
        COMMERCIAL_STAGE: stage,
        COMMERCIAL_CONFIG_ALLOWLIST: expect.any(String),
      });
      expect(JSON.parse(fn.Properties.Environment.Variables.COMMERCIAL_CONFIG_ALLOWLIST)).toEqual([
        {
          accountId: ACCOUNT,
          roleName: `roadmap2u-${stage}-commercial-migration`,
          stage,
          commands: ['bootstrap-flags', 'freeze-cutover'],
        },
        {
          accountId: ACCOUNT,
          roleName: `roadmap2u-${stage}-commercial-flag-operator`,
          stage,
          commands: ['set-flags'],
        },
      ]);
      expect(functionUrl.Properties.AuthType).toBe('AWS_IAM');
      expect(functionUrl.Properties.Cors).toBeUndefined();
      expect(rendered.Outputs).toHaveProperty('CommercialConfigBrokerFunctionUrl');
      expect(rendered.Outputs).toHaveProperty('CommercialConfigBrokerFunctionArn');
      expect(rendered.Outputs).not.toHaveProperty('CommercialConfigBrokerApiRoute');
    },
    20_000,
  );

  it('gives only the broker role config writes and explicitly denies them to other writers', () => {
    const rendered = backendTemplate('dev').toJSON();
    const functions = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::Lambda::Function',
    ) as any[];
    const policies = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];
    const broker = functions.find(
      (fn) => fn.Properties.FunctionName === 'roadmap-commercial-config-broker-dev',
    );
    const brokerRoleId = broker.Properties.Role['Fn::GetAtt'][0] as string;
    const auditTableId = Object.entries(rendered.Resources).find(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        resource.Properties.TableName === 'roadmap-access-audit-dev',
    )?.[0];
    if (!auditTableId) throw new Error('audit table should exist');
    const brokerPolicy = policies.find((policy) =>
      JSON.stringify(policy.Properties.Roles).includes(brokerRoleId),
    );
    const brokerStatements = brokerPolicy.Properties.PolicyDocument.Statement;
    const brokerJson = JSON.stringify(brokerStatements);

    expect(brokerJson).not.toContain('dynamodb:TransactWriteItems');
    expect(brokerJson).not.toContain('dynamodb:Scan');
    expect(brokerJson).toContain('dynamodb:GetItem');
    expect(brokerJson).toContain('COMMERCIAL#CONFIG');
    expect(auditTableId).toBeDefined();
    expect(brokerJson).toContain(auditTableId);
    expect(brokerJson).toContain('TARGET#*');
    expect(brokerJson).not.toContain('AUDIT#*');
    expect(brokerJson).not.toContain('cognito-idp:');
    expect(brokerJson).not.toContain('secretsmanager:');
    expect(brokerStatements.some((statement: any) => statement.Effect === 'Deny')).toBe(false);

    for (const functionName of [
      'roadmap-pre-signup-dev',
      'roadmap-router-dev',
      'roadmap-post-confirmation-dev',
      'roadmap-account-closure-worker-dev',
      'roadmap-account-closure-reconciler-dev',
    ]) {
      const fn = functions.find((candidate) => candidate.Properties.FunctionName === functionName);
      const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
      const rolePolicies = policies.filter((policy) =>
        JSON.stringify(policy.Properties.Roles).includes(roleId),
      );
      const deny = rolePolicies
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .find((statement: any) => statement.Sid === 'DenyCommercialConfigWrites');
      expect(deny?.Effect, functionName).toBe('Deny');
      expect(JSON.stringify(deny?.Condition), functionName).toContain('COMMERCIAL#CONFIG');
    }

    const auditWriter = new AuditWriter({
      ddb: { send: async () => ({}) } as never,
      tableName: 'roadmap-access-audit-dev',
    });
    const auditKey = auditWriter.transactPut({
      targetKind: 'CONFIG',
      targetId: 'dev',
      timestamp: 1_755_631_800_000,
      requestId: 'function-url-request-1',
      action: 'commercial_config.flags_changed',
      actor: 'arn:aws:sts::765932874577:assumed-role/example/session',
      subject: 'COMMERCIAL#CONFIG/FLAGS',
    }).Put.Item.pk;
    const configWrites = brokerStatements.find(
      (statement: any) => statement.Sid === 'TransactOnlyCommercialConfig',
    );
    expect(configWrites.Action).toEqual(['dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(configWrites.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'dynamodb:LeadingKeys': 'COMMERCIAL#CONFIG',
      },
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    });
    expect(JSON.stringify(configWrites.Resource)).not.toContain(auditTableId);

    const auditWrites = brokerStatements.find(
      (statement: any) => statement.Sid === 'TransactOnlyCommercialAudit',
    );
    expect(auditWrites.Action).toBe('dynamodb:PutItem');
    expect(auditWrites.Condition).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': 'TARGET#*',
      },
      StringEquals: {
        'dynamodb:EnclosingOperation': 'TransactWriteItems',
      },
    });
    expect(auditKey).toMatch(/^TARGET#/);
    expect(JSON.stringify(auditWrites.Resource)).toContain(auditTableId);

    const brokerWriteAllows = brokerStatements.filter((statement: any) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some(
        (action: string) =>
          [
            'dynamodb:ConditionCheckItem',
            'dynamodb:DeleteItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
          ].includes(action),
      ),
    );
    expect(brokerWriteAllows).toHaveLength(2);
    for (const statement of brokerWriteAllows) {
      expect(statement.Condition.StringEquals['dynamodb:EnclosingOperation']).toBe(
        'TransactWriteItems',
      );
    }
  });

  it('grants post-confirmation only its transaction-scoped Put and closure guard', () => {
    const rendered = backendTemplate('dev').toJSON();
    const functions = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::Lambda::Function',
    ) as any[];
    const policies = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];

    const postConfirmation = functions.find(
      (candidate) => candidate.Properties.FunctionName === 'roadmap-post-confirmation-dev',
    );
    const postRoleId = postConfirmation.Properties.Role['Fn::GetAtt'][0] as string;
    const postAllows = policies
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(postRoleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => statement.Effect !== 'Deny');
    const postWrites = postAllows.filter((statement: any) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some(
        (action: string) => action.startsWith('dynamodb:'),
      ),
    );
    expect(postWrites).toHaveLength(1);
    expect(postWrites[0].Action).toEqual(['dynamodb:ConditionCheckItem', 'dynamodb:PutItem']);
    expect(postWrites[0].Condition).toEqual({
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    });
    expect(JSON.stringify(postWrites[0].Resource)).toContain('Table');
    expect(JSON.stringify(postWrites[0])).not.toContain('roadmap-access-audit-dev');
    expect(JSON.stringify(postWrites)).not.toMatch(
      /dynamodb:(?:BatchWriteItem|DeleteItem|UpdateItem|TransactWriteItems)/,
    );

    const router = functions.find(
      (candidate) => candidate.Properties.FunctionName === 'roadmap-router-dev',
    );
    const routerRoleId = router.Properties.Role['Fn::GetAtt'][0] as string;
    const routerAllows = policies
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(routerRoleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => statement.Effect !== 'Deny');
    expect(JSON.stringify(routerAllows)).toContain('dynamodb:ConditionCheckItem');
    expect(JSON.stringify(routerAllows)).not.toContain('dynamodb:TransactWriteItems');
    expect(JSON.stringify(routerAllows)).not.toContain('dynamodb:Scan');
  });

  it('allows the closure worker to append audit events only inside TransactWrite', () => {
    const rendered = backendTemplate('dev').toJSON();
    const functions = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::Lambda::Function',
    ) as any[];
    const policies = Object.values(rendered.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];
    const auditTableId = Object.entries(rendered.Resources).find(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::DynamoDB::Table' &&
        resource.Properties.TableName === 'roadmap-access-audit-dev',
    )?.[0];
    if (!auditTableId) throw new Error('audit table should exist');
    const worker = functions.find(
      (candidate) => candidate.Properties.FunctionName === 'roadmap-account-closure-worker-dev',
    );
    const roleId = worker.Properties.Role['Fn::GetAtt'][0] as string;
    const statements = policies
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => statement.Effect !== 'Deny');
    const auditWrites = statements.filter(
      (statement: any) =>
        JSON.stringify(statement.Resource).includes(auditTableId) &&
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          'dynamodb:PutItem',
        ),
    );
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0].Action).toBe('dynamodb:PutItem');
    expect(auditWrites[0].Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'TARGET#*' },
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    });
    expect(JSON.stringify(auditWrites)).not.toContain('dynamodb:TransactWriteItems');
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
