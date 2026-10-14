import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const STAGES = ['dev', 'test', 'prod'] as const;
const templates = new Map<string, any>();
function backend(stage: (typeof STAGES)[number]) {
  if (!templates.has(stage)) {
    const app = new App();
    const stack = new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
      env: { account: ACCOUNT, region: 'us-east-1' },
      stage,
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    });
    templates.set(stage, Template.fromStack(stack).toJSON());
  }
  return templates.get(stage);
}
function resources(template: any, type: string): any[] {
  return Object.values(template.Resources).filter((resource: any) => resource.Type === type);
}
function functionByName(template: any, name: string) {
  return resources(template, 'AWS::Lambda::Function').find(
    (resource) => resource.Properties.FunctionName === name,
  )?.Properties;
}
function statementsFor(template: any, functionName: string): any[] {
  const fn = functionByName(template, functionName);
  expect(fn, functionName).toBeDefined();
  const role = fn.Role['Fn::GetAtt'][0];
  return resources(template, 'AWS::IAM::Policy')
    .filter((resource) => resource.Properties.Roles?.some((ref: any) => ref.Ref === role))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
}

describe.each(STAGES)('individual billing infrastructure %s', (stage) => {
  it('supplies a trusted access stage and permits only protected clock metadata reads', () => {
    const template=backend(stage), fn=functionByName(template,`roadmap-access-reader-${stage}`);
    expect(fn.Environment.Variables.COMMERCIAL_STAGE).toBe(stage);
    const read=statementsFor(template,`roadmap-access-reader-${stage}`).find(s=>s.Sid === 'ReadCommercialAccessItems');
    const attributes=read.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'];
    expect(attributes).toEqual(expect.arrayContaining(['testClock','bindingId','testClockId','customerId','stripeAccountId','clockRevision','frozenTimeSeconds','providerReadyEvidence','syntheticFixture','stage','liveMode']));
    expect(attributes).not.toEqual(expect.arrayContaining(['apiKey']));
  },60_000);
  it('publishes exact signed webhook/public catalog and JWT owner routes, preserving legacy paths', () => {
    const template = backend(stage);
    const routes = resources(template, 'AWS::ApiGatewayV2::Route').map((r) => r.Properties);
    const route = (key: string) => routes.find((r) => r.RouteKey === key);
    for (const key of ['GET /v1/billing/individual/catalog', 'POST /v1/billing/stripe/webhook']) {
      expect(route(key), key).toMatchObject({ AuthorizationType: 'NONE' });
      expect(route(key)?.AuthorizerId).toBeUndefined();
    }
    for (const key of ['GET /v1/billing/individual/summary', 'POST /v1/billing/individual/checkout', 'POST /v1/billing/individual/portal']) {
      expect(route(key), key).toMatchObject({ AuthorizationType: 'JWT' });
      expect(route(key)?.AuthorizerId).toEqual(route('GET /v1/access')?.AuthorizerId);
      expect(route(key)?.Target).not.toEqual(route('ANY /v1/{proxy+}')?.Target);
    }
    expect(route('GET /v1/plans')).toMatchObject({ AuthorizationType: 'NONE' });
    expect(route('DELETE /v1/me')).toMatchObject({ AuthorizationType: 'JWT' });
    expect(resources(template, 'AWS::DynamoDB::Table')).toHaveLength(3);
    expect(resources(template, 'AWS::Cognito::UserPool')).toHaveLength(1);
  }, 60_000);

  it('retains encrypted durable queues, partial failures and three bounded reconciliation schedules', () => {
    const template = backend(stage);
    const queues = resources(template, 'AWS::SQS::Queue').map((r) => r.Properties);
    const inbox = queues.find((q) => q.QueueName === `roadmap-billing-events-${stage}`);
    const dlq = queues.find((q) => q.QueueName === `roadmap-billing-events-dlq-${stage}`);
    expect(inbox).toMatchObject({ SqsManagedSseEnabled: true, VisibilityTimeout: 360, MessageRetentionPeriod: 345600, RedrivePolicy: { maxReceiveCount: 5 } });
    expect(dlq).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 });
    const worker = functionByName(template, `roadmap-billing-worker-${stage}`);
    expect(worker).toMatchObject({ Runtime: 'nodejs22.x', Timeout: 60 });
    expect(resources(template, 'AWS::Lambda::EventSourceMapping')).toContainEqual(
      expect.objectContaining({ Properties: expect.objectContaining({ BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'] }) }),
    );
    const schedules = resources(template, 'AWS::Events::Rule').map((r) => r.Properties);
    for (const [mode, expression] of [['pending', 'rate(1 minute)'], ['subscriptions', 'rate(15 minutes)'], ['audit', 'rate(1 day)']]) {
      const rule = schedules.find((r) => r.Name === `roadmap-billing-${mode}-${stage}`);
      expect(rule).toMatchObject({ ScheduleExpression: expression, State: 'ENABLED' });
      expect(JSON.parse(rule.Targets[0].Input)).toEqual({ mode });
    }
  }, 60_000);

  it('separates webhook, financial writer and API permissions with exact stage secrets and no scans', () => {
    const template = backend(stage);
    const webhook = statementsFor(template, `roadmap-billing-webhook-${stage}`);
    const api = statementsFor(template, `roadmap-billing-api-${stage}`);
    const worker = statementsFor(template, `roadmap-billing-worker-${stage}`);
    const reconciler = statementsFor(template, `roadmap-billing-reconciler-${stage}`);
    const serialized = JSON.stringify({ webhook, api, worker, reconciler });
    expect(serialized).not.toMatch(/dynamodb:Scan|ssm:GetParametersByPath|secretsmanager:/);
    for (const list of [webhook, api, worker, reconciler]) {
      expect(list).toContainEqual(expect.objectContaining({ Effect: 'Deny', Condition: expect.objectContaining({ 'ForAnyValue:StringEquals': { 'dynamodb:LeadingKeys': 'COMMERCIAL#CONFIG' } }) }));
    }
    const secretResources = (list: any[]) => list.filter((s) => [s.Action].flat().includes('ssm:GetParameter')).map((s) => JSON.stringify(s.Resource)).join('');
    expect(secretResources(webhook)).toContain(`roadmap2u/${stage}/stripe/webhook-secret`);
    expect(secretResources(webhook)).not.toContain(`roadmap2u/${stage}/stripe/config`);
    for (const list of [api, worker, reconciler]) expect(secretResources(list)).toContain(`roadmap2u/${stage}/stripe/config`);
    expect(JSON.stringify(webhook)).not.toContain('PRIVACY_STATE#');
    expect(JSON.stringify(api)).toContain('PRIVACY_STATE#');
    expect(worker).toContainEqual(expect.objectContaining({ Sid: 'WriteIndividualSubscriptionProjection', Action: 'dynamodb:PutItem', Condition: expect.objectContaining({ StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' } }) }));
    expect(JSON.stringify(api)).not.toContain('WriteIndividualSubscriptionProjection');
  }, 60_000);

  it('alarms on billing delays, duplicate mappings, blocked closure and sustained provider errors', () => {
    const template = backend(stage);
    const alarms = resources(template, 'AWS::CloudWatch::Alarm').map((r) => r.Properties);
    for (const key of ['billing-dlq-visible', 'billing-queue-age', 'billing-pending-event-age', 'billing-reconciliation-lag', 'billing-duplicate-subscription', 'billing-mapping-conflict', 'billing-closure-blocked', 'billing-signature-errors', 'billing-stripe-errors', 'billing-configuration-errors']) {
      const alarm = alarms.find((a) => a.AlarmName === `roadmap-commercial-${stage}-${key}`);
      expect(alarm, key).toBeDefined();
      expect(alarm.AlarmActions).toHaveLength(1);
      expect(alarm.TreatMissingData).toBe('notBreaching');
    }
    expect(alarms.find((a) => a.AlarmName.endsWith('billing-queue-age'))?.Threshold).toBe(300);
    expect(alarms.find((a) => a.AlarmName.endsWith('billing-reconciliation-lag'))?.Threshold).toBe(1800);
    expect(resources(template, 'AWS::SSM::Parameter').every((r) => !r.Properties.Name.includes('/stripe/'))).toBe(true);
  }, 60_000);

  it('permits durable provider history only behind a transactional financial lease fence', () => {
    const template = backend(stage);
    for (const name of [`roadmap-billing-api-${stage}`, `roadmap-billing-worker-${stage}`, `roadmap-billing-reconciler-${stage}`, `roadmap-account-closure-worker-${stage}`]) {
      const checks = statementsFor(template, name).filter((statement) => statement.Effect === 'Allow'
        && [statement.Action].flat().includes('dynamodb:ConditionCheckItem')
        && [statement.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']].flat().includes('BILLING#*'));
      expect(checks, `${name} requires the same owner lease used by history checkpoints`).not.toHaveLength(0);
      for (const check of checks) {
        expect(check.Condition.StringEquals).toEqual({ 'dynamodb:EnclosingOperation': 'TransactWriteItems' });
        expect(check.Resource).not.toBe('*');
      }
    }
    expect(JSON.stringify(statementsFor(template, `roadmap-billing-webhook-${stage}`))).not.toContain('ConditionCheckItem');
  }, 60_000);
});
