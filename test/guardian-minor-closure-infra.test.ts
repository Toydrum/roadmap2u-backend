import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

function backend(): Record<string, any> {
  const app = new App();
  const stack = new RoadmapStack(app, 'Roadmap-dev-Backend-GuardianMinorClosure', {
    env: { account: '123456789012', region: 'us-east-1' },
    stage: 'dev',
    hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  } as never);
  return Template.fromStack(stack).toJSON();
}

function resources(template: Record<string, any>, type: string): Array<[string, any]> {
  return Object.entries(template.Resources).filter(
    ([, resource]: [string, any]) => resource.Type === type,
  );
}

function lambdaByName(template: Record<string, any>, name: string): any {
  const found = resources(template, 'AWS::Lambda::Function').find(
    ([, resource]) => resource.Properties.FunctionName === name,
  );
  expect(found, `Lambda ${name} should exist`).toBeDefined();
  return found![1];
}

function roleStatementsFor(template: Record<string, any>, fn: any): any[] {
  const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
  return resources(template, 'AWS::IAM::Policy')
    .filter(([, policy]) =>
      (policy.Properties.Roles ?? []).some((role: any) => role.Ref === roleId),
    )
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

describe('guardian-minor closure infrastructure', () => {
  it('lets the router durably request closure without broad audit mutation access', () => {
    const template = backend();
    const router = lambdaByName(template, 'roadmap-router-dev');
    expect(router.Properties.Environment.Variables).toMatchObject({
      ACCOUNT_CLOSURE_QUEUE_URL: expect.anything(),
      AUDIT_TABLE_NAME: expect.anything(),
    });

    const statements = roleStatementsFor(template, router);
    const sqsAllow = statements.find(
      (statement) =>
        statement.Effect === 'Allow' &&
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          'sqs:SendMessage',
        ),
    );
    expect(sqsAllow?.Resource).toBeDefined();
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Effect: 'Allow',
          Action: 'dynamodb:PutItem',
          Resource: expect.anything(),
          Condition: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'TARGET#*' },
            StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
          },
        }),
      ]),
    );
    const auditStatements = statements.filter((statement) =>
      JSON.stringify(statement.Resource).includes('AccessAudit'),
    );
    expect(auditStatements.flatMap((statement) => statement.Action)).not.toEqual(
      expect.arrayContaining([
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
      ]),
    );
    const conditionChecks = statements.filter(
      (statement) =>
        statement.Effect === 'Allow' &&
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          'dynamodb:ConditionCheckItem',
        ),
    );
    expect(conditionChecks).toHaveLength(1);
    expect(conditionChecks[0].Condition).toEqual({
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    });
  }, 20_000);

  it('allows the shared worker to delete invite mirrors only inside TransactWriteItems', () => {
    const template = backend();
    const worker = lambdaByName(template, 'roadmap-account-closure-worker-dev');
    const statements = roleStatementsFor(template, worker);
    const deleteAllows = statements.filter(
      (statement) =>
        statement.Effect === 'Allow' &&
        (Array.isArray(statement.Action)
          ? statement.Action.includes('dynamodb:DeleteItem')
          : statement.Action === 'dynamodb:DeleteItem'),
    );

    expect(deleteAllows).toHaveLength(1);
    expect(deleteAllows[0].Condition).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['USER#*', 'CODE#G#*'],
      },
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    });
  }, 20_000);
});
