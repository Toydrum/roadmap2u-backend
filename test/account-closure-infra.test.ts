import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
const templates = new Map<'dev' | 'prod', Record<string, any>>();

function backend(stage: 'dev' | 'prod' = 'dev'): Record<string, any> {
  const cached = templates.get(stage);
  if (cached) return cached;
  const app = new App();
  const stack = new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
    env: { account: ACCOUNT, region: 'us-east-1' },
    stage,
    hostedZoneId: HOSTED_ZONE_ID,
  } as never);
  const template = Template.fromStack(stack).toJSON();
  templates.set(stage, template);
  return template;
}

function resources(template: Record<string, any>, type: string): Array<[string, any]> {
  return Object.entries(template.Resources).filter(([, resource]: [string, any]) =>
    resource.Type === type,
  );
}

function lambdaByName(template: Record<string, any>, name: string): [string, any] {
  const found = resources(template, 'AWS::Lambda::Function').find(
    ([, resource]) => resource.Properties.FunctionName === name,
  );
  expect(found, `Lambda ${name} should exist`).toBeDefined();
  return found!;
}

function roleStatementsFor(template: Record<string, any>, fn: any): any[] {
  const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
  return resources(template, 'AWS::IAM::Policy')
    .filter(([, policy]) =>
      (policy.Properties.Roles ?? []).some((role: any) => role.Ref === roleId),
    )
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

function statementActions(statements: any[]): string[] {
  return statements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
}

describe('account closure infrastructure', () => {
  it('uses an encrypted source queue with a longer-lived DLQ and bounded retries', () => {
    const template = backend();
    const queues = resources(template, 'AWS::SQS::Queue');
    const [, source] = queues.find(
      ([, queue]) => queue.Properties.QueueName === 'roadmap-account-closure-dev',
    ) ?? [];
    const [dlqId, dlq] = queues.find(
      ([, queue]) => queue.Properties.QueueName === 'roadmap-account-closure-dlq-dev',
    ) ?? [];

    expect(source).toBeDefined();
    expect(dlq).toBeDefined();
    expect(source.Properties).toMatchObject({
      MessageRetentionPeriod: 4 * 24 * 60 * 60,
      VisibilityTimeout: 6 * 60,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
        maxReceiveCount: 5,
      },
    });
    expect(dlq.Properties).toMatchObject({
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
    });

    const queuePolicies = resources(template, 'AWS::SQS::QueuePolicy').map(
      ([, policy]) => policy,
    );
    const serialized = JSON.stringify(queuePolicies);
    expect(serialized).toContain('aws:SecureTransport');
    expect(serialized).toContain('false');
  }, 20_000);

  it('wires partial SQS failures, scheduled reconciliation, and least-privilege roles', () => {
    const template = backend();
    const [workerId, worker] = lambdaByName(
      template,
      'roadmap-account-closure-worker-dev',
    );
    const [reconcilerId, reconciler] = lambdaByName(
      template,
      'roadmap-account-closure-reconciler-dev',
    );
    expect(worker.Properties.Timeout).toBe(60);
    expect(worker.Properties.Environment.Variables).toMatchObject({
      TABLE_NAME: expect.anything(),
      USER_POOL_ID: expect.anything(),
      AUDIT_TABLE_NAME: expect.anything(),
      ACCOUNT_CLOSURE_QUEUE_URL: expect.anything(),
    });
    expect(reconciler.Properties.Environment.Variables).toMatchObject({
      TABLE_NAME: expect.anything(),
      ACCOUNT_CLOSURE_QUEUE_URL: expect.anything(),
    });
    expect(reconciler.Properties.Environment.Variables.USER_POOL_ID).toBeUndefined();
    expect(reconciler.Properties.Environment.Variables.AUDIT_TABLE_NAME).toBeUndefined();

    const mappings = resources(template, 'AWS::Lambda::EventSourceMapping');
    expect(mappings).toHaveLength(1);
    expect(mappings[0][1].Properties).toMatchObject({
      BatchSize: 1,
      FunctionName: { Ref: workerId },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    const rules = resources(template, 'AWS::Events::Rule');
    expect(rules).toHaveLength(1);
    expect(rules[0][1].Properties).toMatchObject({
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: [expect.objectContaining({ Arn: { 'Fn::GetAtt': [reconcilerId, 'Arn'] } })],
    });

    const workerStatements = roleStatementsFor(template, worker);
    const workerAllowStatements = workerStatements.filter(
      (statement) => statement.Effect !== 'Deny',
    );
    const workerActions = statementActions(workerAllowStatements);
    expect(workerActions).toEqual(
      expect.arrayContaining([
        'dynamodb:BatchWriteItem',
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:ReceiveMessage',
        'sqs:SendMessage',
        'cognito-idp:AdminDeleteUser',
      ]),
    );
    expect(workerActions).not.toContain('cognito-idp:AdminCreateUser');
    expect(workerActions).not.toContain('cognito-idp:AdminSetUserPassword');
    expect(workerActions.filter((action) => action.startsWith('cognito-idp:'))).toEqual([
      'cognito-idp:AdminDeleteUser',
    ]);
    expect(workerActions).not.toContain('dynamodb:Scan');
    const transactionalDeletes = workerAllowStatements.filter((statement) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
        'dynamodb:DeleteItem',
      ),
    );
    expect(transactionalDeletes).toHaveLength(1);
    expect(transactionalDeletes[0].Condition).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['USER#*', 'CODE#G#*'],
      },
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    });

    const reconcilerStatements = roleStatementsFor(template, reconciler);
    const reconcilerAllowStatements = reconcilerStatements.filter(
      (statement) => statement.Effect !== 'Deny',
    );
    const reconcilerActions = statementActions(reconcilerAllowStatements);
    expect(reconcilerActions).toEqual(
      expect.arrayContaining(['dynamodb:Query', 'sqs:SendMessage']),
    );
    for (const forbidden of [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:BatchWriteItem',
      'sqs:ReceiveMessage',
      'sqs:DeleteMessage',
      'cognito-idp:AdminDeleteUser',
    ]) {
      expect(reconcilerActions).not.toContain(forbidden);
    }
    expect(JSON.stringify(reconcilerStatements)).not.toContain('roadmap-access-audit-dev');
    expect(JSON.stringify(reconcilerStatements)).not.toContain('userpool/');
  });

  it('retains both closure queues in production', () => {
    const template = backend('prod');
    const queues = resources(template, 'AWS::SQS::Queue').map(([, queue]) => queue);
    expect(queues).toHaveLength(2);
    for (const queue of queues) {
      expect(queue.DeletionPolicy).toBe('Retain');
      expect(queue.UpdateReplacePolicy).toBe('Retain');
    }
  }, 20_000);
});
