import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

let rendered: any;

function renderedBackend(): any {
  if (rendered) return rendered;
  const app = new App();
  const stack = new RoadmapStack(app, 'Roadmap-dev-Backend', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    stage: 'dev',
    hostedZoneId: HOSTED_ZONE_ID,
  });
  rendered = Template.fromStack(stack).toJSON();
  return rendered;
}

function lambdaByName(template: any, functionName: string): [string, any] {
  const entry = Object.entries(template.Resources).find(
    ([, resource]: [string, any]) =>
      resource.Type === 'AWS::Lambda::Function' &&
      resource.Properties.FunctionName === functionName,
  ) as [string, any] | undefined;
  if (!entry) throw new Error(`missing Lambda ${functionName}`);
  return entry;
}

function roleStatements(template: any, roleLogicalId: string): any[] {
  return Object.values(template.Resources)
    .filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Policy' &&
        JSON.stringify(resource.Properties.Roles).includes(`\"Ref\":\"${roleLogicalId}\"`),
    )
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
}

describe('commercial exact HTTP routes', () => {
  it('publishes plans publicly and keeps access plus closure behind the JWT authorizer', () => {
    const template = renderedBackend();
    const routes = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::ApiGatewayV2::Route',
    ) as any[];
    const route = (key: string) =>
      routes.find((candidate) => candidate.Properties.RouteKey === key)?.Properties;

    expect(route('GET /v1/plans')).toMatchObject({ AuthorizationType: 'NONE' });
    expect(route('GET /v1/plans').AuthorizerId).toBeUndefined();
    expect(route('GET /v1/access')).toMatchObject({ AuthorizationType: 'JWT' });
    expect(route('GET /v1/access').AuthorizerId).toBeDefined();
    expect(route('DELETE /v1/me')).toMatchObject({ AuthorizationType: 'JWT' });
    expect(route('DELETE /v1/me').AuthorizerId).toEqual(
      route('GET /v1/access').AuthorizerId,
    );
  }, 20_000);

  it('gives every exact commercial route its own integration ahead of the greedy proxy', () => {
    const template = renderedBackend();
    const routes = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::ApiGatewayV2::Route',
    ) as any[];
    const route = (key: string) =>
      routes.find((candidate) => candidate.Properties.RouteKey === key)?.Properties;
    const proxyTarget = route('ANY /v1/{proxy+}').Target;

    for (const key of ['GET /v1/plans', 'GET /v1/access', 'DELETE /v1/me']) {
      expect(route(key), key).toBeDefined();
      expect(route(key).Target, key).not.toEqual(proxyTarget);
    }
    expect(route('GET /v1/plans').Target).not.toEqual(route('GET /v1/access').Target);
    expect(route('GET /v1/access').Target).not.toEqual(route('DELETE /v1/me').Target);
  }, 20_000);

  it('does not publish any payment, checkout, portal or webhook surface', () => {
    const template = renderedBackend();
    const routeKeys = Object.values(template.Resources)
      .filter((resource: any) => resource.Type === 'AWS::ApiGatewayV2::Route')
      .map((resource: any) => resource.Properties.RouteKey);
    const functionNames = Object.values(template.Resources)
      .filter((resource: any) => resource.Type === 'AWS::Lambda::Function')
      .map((resource: any) => resource.Properties.FunctionName);

    expect(JSON.stringify({ routeKeys, functionNames })).not.toMatch(
      /payments?|checkout|portal|webhook/i,
    );
  }, 20_000);
});

describe('commercial route runtime isolation', () => {
  it('gives the public catalog no data, identity, queue, config or secret permission', () => {
    const template = renderedBackend();
    const [, catalog] = lambdaByName(template, 'roadmap-catalog-dev');
    const roleId = catalog.Properties.Role['Fn::GetAtt'][0] as string;
    const role = template.Resources[roleId];
    const statements = roleStatements(template, roleId);
    const serialized = JSON.stringify(statements);

    expect(catalog.Properties.Environment).toBeUndefined();
    expect(role.Properties.ManagedPolicyArns).toHaveLength(1);
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(
      'AWSLambdaBasicExecutionRole',
    );
    expect(serialized).not.toMatch(/dynamodb:|ssm:|secretsmanager:|cognito-idp:|sqs:/i);
  }, 20_000);

  it('restricts the access reader to owner reads and transaction-enclosed materialization', () => {
    const template = renderedBackend();
    const [, access] = lambdaByName(template, 'roadmap-access-reader-dev');
    const roleId = access.Properties.Role['Fn::GetAtt'][0] as string;
    const statements = roleStatements(template, roleId);
    const bySid = (sid: string) => statements.find((statement) => statement.Sid === sid);
    const tableResource = bySid('ReadCommercialAccessItems').Resource;
    const safeAttributes = bySid('ReadCommercialAccessItems')?.Condition?.[
      'ForAllValues:StringEquals'
    ]?.['dynamodb:Attributes'];

    expect(access.Properties.Environment.Variables).toEqual({
      TABLE_NAME: { Ref: expect.stringMatching(/^Table/) },
    });
    expect(bySid('ReadCommercialAccessItems')).toMatchObject({
      Action: 'dynamodb:GetItem',
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['USER#*', 'ACCOUNT_CLOSURE#*'],
        },
      },
    });
    expect(bySid('QueryCommercialAccessGrants')).toMatchObject({
      Action: 'dynamodb:Query',
      Resource: tableResource,
      Condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'USER#*' },
        'ForAllValues:StringEquals': {
          'dynamodb:Attributes': safeAttributes,
        },
        StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      },
    });
    expect(bySid('MaterializeCommercialAccess')).toMatchObject({
      Action: ['dynamodb:ConditionCheckItem', 'dynamodb:PutItem'],
      Resource: tableResource,
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['USER#*', 'ACCOUNT_CLOSURE#*'],
        },
        'ForAllValues:StringEquals': {
          'dynamodb:Attributes': safeAttributes,
        },
        StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
      },
    });

    expect(safeAttributes).toEqual(
      expect.arrayContaining([
        'pk',
        'sk',
        'userId',
        'ownerSub',
        'grantId',
        'activeTrees',
        'effectivePlanKey',
      ]),
    );
    expect(JSON.stringify(safeAttributes)).not.toMatch(
      /title|note|email|displayName|username|record/i,
    );

    const serialized = JSON.stringify(statements);
    expect(serialized).not.toMatch(
      /dynamodb:(?:Scan|DeleteItem|UpdateItem|BatchGetItem|BatchWriteItem|DescribeTable)/,
    );
    expect(serialized).not.toMatch(/ssm:|secretsmanager:|cognito-idp:|sqs:/i);
    expect(serialized).not.toContain('/index/');
  }, 20_000);

  it('gives account closure request only its reads, enclosed writes, audit append and queue send', () => {
    const template = renderedBackend();
    const [, closure] = lambdaByName(template, 'roadmap-account-closure-request-dev');
    const roleId = closure.Properties.Role['Fn::GetAtt'][0] as string;
    const statements = roleStatements(template, roleId);
    const bySid = (sid: string) => statements.find((statement) => statement.Sid === sid);

    expect(closure.Properties.Environment.Variables).toMatchObject({
      TABLE_NAME: { Ref: expect.stringMatching(/^Table/) },
      AUDIT_TABLE_NAME: { Ref: expect.stringMatching(/^AccessAuditTable/) },
      ACCOUNT_CLOSURE_QUEUE_URL: { Ref: expect.stringMatching(/^AccountClosureQueue/) },
    });
    expect(closure.Properties.Environment.Variables).not.toHaveProperty('USER_POOL_ID');
    expect(bySid('ReadAccountClosureRequestState')).toMatchObject({
      Action: 'dynamodb:GetItem',
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['USER#*', 'ACCOUNT_CLOSURE#*'],
        },
      },
    });
    expect(bySid('TransactOnlyAccountClosureRequestState')).toMatchObject({
      Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      Condition: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['USER#*', 'ACCOUNT_CLOSURE#*'],
        },
        StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
      },
    });
    expect(bySid('TransactOnlyAccountClosureRequestAudit')).toMatchObject({
      Action: 'dynamodb:PutItem',
      Condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'TARGET#*' },
        StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
      },
    });
    expect(bySid('SendOnlyAccountClosureRequest')).toMatchObject({
      Action: 'sqs:SendMessage',
    });

    const serialized = JSON.stringify(statements);
    expect(serialized).not.toMatch(
      /dynamodb:(?:Scan|DeleteItem|BatchGetItem|BatchWriteItem|DescribeTable|Query)/,
    );
    expect(serialized).not.toMatch(/ssm:|secretsmanager:|cognito-idp:/i);
  }, 20_000);
});
