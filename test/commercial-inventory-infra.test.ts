import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  RoadmapCiBootstrapStack,
  RoadmapStack,
} from '../lib/roadmap-stack';

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
      resource.Type === 'AWS::Lambda::Function' &&
      resource.Properties.FunctionName === name,
  ) as [string, any] | undefined;
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function roleStatements(template: any, roleId: string): any[] {
  return Object.values(template.Resources)
    .filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Policy' &&
        JSON.stringify(resource.Properties.Roles).includes(`"Ref":"${roleId}"`),
    )
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
}

describe('commercial inventory executor infrastructure', () => {
  it.each(['dev', 'test', 'prod'] as const)(
    'preserves the existing %s stateful resource and role identities without replacement',
    (stage) => {
      const template = backend(stage);
      const expectedState = [
        ['Users0A0EEA89', 'AWS::Cognito::UserPool', 'UserPoolName', `roadmap-users-${stage}`],
        ['UsersWebA39D1A70', 'AWS::Cognito::UserPoolClient', 'ClientName', `roadmap-web-${stage}`],
        ['TableCD117FA1', 'AWS::DynamoDB::Table', 'TableName', `roadmap-${stage}`],
        [
          'AccessAuditTable50039365',
          'AWS::DynamoDB::Table',
          'TableName',
          `roadmap-access-audit-${stage}`,
        ],
        [
          'AccountClosureDlq8983AF6D',
          'AWS::SQS::Queue',
          'QueueName',
          `roadmap-account-closure-dlq-${stage}`,
        ],
        [
          'AccountClosureQueue02FB3434',
          'AWS::SQS::Queue',
          'QueueName',
          `roadmap-account-closure-${stage}`,
        ],
      ] as const;
      for (const [logicalId, type, nameProperty, physicalName] of expectedState) {
        expect(template.Resources[logicalId]).toMatchObject({
          Type: type,
          Properties: { [nameProperty]: physicalName },
        });
      }
      expect(template.Resources.UsersWebA39D1A70.Properties.GenerateSecret).toBe(false);

      for (const logicalId of [
        'PreSignUpRole33A7FED2',
        'PostConfirmationRoleBD0B0389',
        'CommercialConfigBrokerRole83C20186',
        'AccountClosureWorkerRoleA236FD5C',
        'AccountClosureReconcilerRole881B8108',
        'RouterRole4AB001A6',
        'CatalogRole0D3BB0F5',
        'AccessReaderRoleDDBBEDBC',
        'AccountClosureRequestRole1C519EFD',
      ]) {
        expect(template.Resources[logicalId]?.Type).toBe('AWS::IAM::Role');
      }
    },
    20_000,
  );

  it.each(['dev', 'test', 'prod'] as const)(
    'creates the isolated %s executor, IAM Function URL, log retention and 80%% duration alarm',
    (stage) => {
      const template = backend(stage);
      const functionName = `roadmap-commercial-inventory-executor-${stage}`;
      const [functionId, fn] = functionByName(template, functionName);
      const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
      const role = template.Resources[roleId];
      const statements = roleStatements(template, roleId);
      const tableId = Object.entries(template.Resources).find(
        ([, resource]: [string, any]) =>
          resource.Type === 'AWS::DynamoDB::Table' &&
          resource.Properties.TableName === `roadmap-${stage}`,
      )?.[0];
      const scan = statements.find(
        (statement: any) => statement.Sid === 'ScanOnlyCommercialInventoryProjection',
      );
      const functionUrl = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::Lambda::Url' &&
          resource.Properties.TargetFunctionArn?.['Fn::GetAtt']?.[0] === functionId,
      ) as any;
      const logGroup = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::Logs::LogGroup' &&
          resource.Properties.LogGroupName === `/aws/lambda/${functionName}`,
      ) as any;
      const durationAlarm = Object.values(template.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::CloudWatch::Alarm' &&
          resource.Properties.MetricName === 'Duration' &&
          JSON.stringify(resource.Properties.Dimensions).includes(functionId),
      ) as any;

      expect(fn.Properties).toMatchObject({
        FunctionName: functionName,
        MemorySize: 1024,
        Timeout: 900,
      });
      expect(fn.Properties.Environment.Variables).toEqual({
        TABLE_NAME: { Ref: expect.stringMatching(/^Table/) },
        COMMERCIAL_STAGE: stage,
        COMMERCIAL_INVENTORY_ALLOWLIST: JSON.stringify([
          {
            accountId: ACCOUNT,
            roleName: `roadmap2u-${stage}-commercial-migration`,
            stage,
          },
        ]),
      });
      expect(functionUrl.Properties).toMatchObject({ AuthType: 'AWS_IAM' });
      expect(functionUrl.Properties.Cors).toBeUndefined();
      expect(role.Properties.Path).toBe(`/roadmap2u/${stage}/runtime/`);
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
        `/roadmap2u/${stage}/roadmap2u-${stage}-inventory-runtime-boundary`,
      );
      expect(scan).toMatchObject({
        Action: 'dynamodb:Scan',
        Condition: {
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': [
              'accountType',
              'createdAt',
              'gsi2pk',
              'gsi2sk',
              'owner',
              'pk',
              'record',
              'rev',
              'sk',
              'status',
              'store',
              'syncedAt',
              'timestamp',
              'updatedAt',
            ],
          },
          StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
          Null: { 'dynamodb:Attributes': 'false' },
        },
      });
      expect(scan.Resource).toEqual({ 'Fn::GetAtt': [tableId, 'Arn'] });
      expect(JSON.stringify(scan.Resource)).not.toContain('/index/');
      expect(JSON.stringify(statements)).not.toMatch(
        /dynamodb:(?:GetItem|PutItem|UpdateItem|DeleteItem|Query|Batch|Transact)/,
      );
      expect(JSON.stringify(statements)).not.toMatch(/ssm:|secretsmanager:|sqs:|cognito-idp:/i);
      expect(logGroup.Properties.RetentionInDays).toBe(
        { dev: 7, test: 14, prod: 30 }[stage],
      );
      expect(durationAlarm.Properties).toMatchObject({
        Threshold: 720_000,
        Statistic: 'Maximum',
      });
      expect(template.Outputs).toHaveProperty('CommercialInventoryExecutorFunctionUrl');
      expect(template.Outputs).toHaveProperty('CommercialInventoryExecutorFunctionArn');
    },
    20_000,
  );

  it('keeps record off MigrationRole and gives it only the two exact inventory Function URL permissions', () => {
    const template = bootstrap();
    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const migration = policies.find(
        (policy) => policy.Properties.PolicyName === `CommercialMigrationPolicy-${stage}`,
      );
      const statements = migration.Properties.PolicyDocument.Statement;
      const inventoryArn = `:function:roadmap-commercial-inventory-executor-${stage}`;
      const inventoryInvoke = statements.filter((statement: any) =>
        JSON.stringify(statement.Resource).includes(inventoryArn),
      );

      expect(inventoryInvoke).toHaveLength(2);
      expect(inventoryInvoke).toContainEqual(
        expect.objectContaining({
          Action: 'lambda:InvokeFunctionUrl',
          Condition: {
            StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' },
          },
        }),
      );
      expect(inventoryInvoke).toContainEqual(
        expect.objectContaining({
          Action: 'lambda:InvokeFunction',
          Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
        }),
      );
      const requestedAttributes = statements.flatMap(
        (statement: any) =>
          statement.Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes'] ?? [],
      );
      expect(requestedAttributes).not.toContain('record');
      expect(statements.find((statement: any) => statement.Sid === 'ScanOnlyFamilyFenceProjection'))
        .toBeDefined();

      const flagPolicy = policies.find(
        (policy) => policy.Properties.PolicyName === `CommercialFlagOperatorPolicy-${stage}`,
      );
      expect(JSON.stringify(flagPolicy)).not.toContain(inventoryArn);
    }
  });

  it('uses a dedicated least-privilege boundary without adding Scan to the global runtime boundary', () => {
    const template = bootstrap();
    const managed = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const globalBoundary = managed.find(
        (policy) =>
          policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-runtime-boundary`,
      );
      const inventoryBoundary = managed.find(
        (policy) =>
          policy.Properties.ManagedPolicyName ===
          `roadmap2u-${stage}-inventory-runtime-boundary`,
      );
      expect(JSON.stringify(globalBoundary.Properties.PolicyDocument)).not.toContain(
        'dynamodb:Scan',
      );
      expect(inventoryBoundary).toBeDefined();
      const statements = inventoryBoundary.Properties.PolicyDocument.Statement;
      expect(statements.map((statement: any) => statement.Sid).sort()).toEqual([
        'ScanOnlyCommercialInventoryProjection',
        'WriteOnlyCommercialInventoryLogs',
      ]);
      expect(JSON.stringify(statements)).not.toMatch(
        /dynamodb:(?:GetItem|PutItem|UpdateItem|DeleteItem|Query|Batch|Transact)/,
      );
      expect(JSON.stringify(statements)).toContain(`table/roadmap-${stage}`);
      expect(JSON.stringify(statements)).toContain(
        `/aws/lambda/roadmap-commercial-inventory-executor-${stage}`,
      );
      expect(JSON.stringify(inventoryBoundary.Properties.PolicyDocument).length)
        .toBeLessThanOrEqual(6_144);
    }
  });
});
