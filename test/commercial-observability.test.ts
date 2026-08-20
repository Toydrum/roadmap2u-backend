import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
const DYNAMODB_OPERATIONS = [
  'GetItem',
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'Query',
  'Scan',
  'BatchGetItem',
  'BatchWriteItem',
  'TransactWriteItems',
];
const templates = new Map<string, any>();

function renderedBackend(stage: 'dev' | 'test' | 'prod' = 'dev') {
  const cached = templates.get(stage);
  if (cached) return cached;
  const app = new App();
  const stack = new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
    env: { account: ACCOUNT, region: 'us-east-1' },
    stage,
    hostedZoneId: HOSTED_ZONE_ID,
  });
  const template = Template.fromStack(stack).toJSON();
  templates.set(stage, template);
  return template;
}

describe('commercial alarms', () => {
  it('creates one HTTPS-only topic and disables the conditional subscription by default', () => {
    const template = renderedBackend();
    const topics = Object.entries(template.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SNS::Topic',
    );
    const topicPolicies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SNS::TopicPolicy',
    ) as any[];

    expect(topics).toHaveLength(1);
    expect((topics[0]?.[1] as any).Properties.TopicName).toBe(
      'roadmap-commercial-alerts-dev',
    );
    const topicStatements = topicPolicies.flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
    expect(topicStatements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Action: 'sns:Publish',
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );
    const cloudWatchPublish = topicStatements.find(
      (statement) =>
        statement.Effect === 'Allow' &&
        statement.Principal?.Service === 'cloudwatch.amazonaws.com',
    );
    expect(cloudWatchPublish).toMatchObject({
      Action: 'sns:Publish',
      Condition: {
        StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
      },
    });
    expect(JSON.stringify(cloudWatchPublish.Condition.ArnLike)).toContain(
      'alarm:roadmap-commercial-dev-*',
    );
    expect(template.Parameters.AlarmNotificationEmail).toMatchObject({
      Type: 'String',
      Default: '',
      NoEcho: true,
      MaxLength: 254,
    });
    expect(template.Conditions.HasAlarmNotificationEmail).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'AlarmNotificationEmail' }, ''] }],
    });
    const subscriptions = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SNS::Subscription',
    ) as any[];
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].Condition).toBe('HasAlarmNotificationEmail');
  }, 20_000);

  it('keeps the email out of the synthesized template and resolves it only as a NoEcho parameter', () => {
    const template = renderedBackend();
    const subscriptions = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SNS::Subscription',
    ) as any[];

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].Properties).toMatchObject({
      Protocol: 'email',
      Endpoint: { Ref: 'AlarmNotificationEmail' },
    });
    expect(JSON.stringify(template)).not.toContain('alerts@example.invalid');
  }, 20_000);

  it('bounds the deployment parameter without exposing invalid input', () => {
    const parameter = renderedBackend().Parameters.AlarmNotificationEmail;
    const allowed = new RegExp(parameter.AllowedPattern);

    expect(allowed.test('')).toBe(true);
    expect(allowed.test('alerts@example.invalid')).toBe(true);
    expect(allowed.test('private-secret-address')).toBe(false);
    expect(parameter.ConstraintDescription).toBe(
      'Alarm notification email must be empty or a valid email address',
    );
  }, 20_000);

  it('covers every real Lambda plus API, both tables, queues and commercial metrics', () => {
    const template = renderedBackend();
    const functions = Object.entries(template.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::Lambda::Function',
    ) as [string, any][];
    const tables = Object.entries(template.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::DynamoDB::Table',
    ) as [string, any][];
    const alarms = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];
    expect(functions).toHaveLength(6);
    for (const metricName of ['Errors', 'Throttles']) {
      const matching = alarms.filter(
        (alarm) =>
          alarm.Properties.Namespace === 'AWS/Lambda' &&
          alarm.Properties.MetricName === metricName,
      );
      expect(matching).toHaveLength(functions.length);
      expect(
        matching.map((alarm) => JSON.stringify(alarm.Properties.Dimensions)).sort(),
      ).toEqual(
        functions
          .map(([id]) => JSON.stringify([{ Name: 'FunctionName', Value: { Ref: id } }]))
          .sort(),
      );
    }
    const durationAlarms = alarms.filter(
      (alarm) =>
        alarm.Properties.Namespace === 'AWS/Lambda' &&
        alarm.Properties.MetricName === 'Duration',
    );
    expect(durationAlarms).toHaveLength(functions.length);
    for (const [functionId, functionResource] of functions) {
      const durationAlarm = durationAlarms.find(
        (alarm) =>
          JSON.stringify(alarm.Properties.Dimensions) ===
          JSON.stringify([{ Name: 'FunctionName', Value: { Ref: functionId } }]),
      );
      expect(durationAlarm).toBeDefined();
      expect(durationAlarm.Properties.Statistic).toBe('Maximum');
      expect(durationAlarm.Properties.Threshold).toBe(
        functionResource.Properties.Timeout * 800,
      );
    }

    expect(tables).toHaveLength(2);
    for (const [tableId] of tables) {
      for (const metricName of ['ThrottledRequests', 'SystemErrors']) {
        const matchingAlarms = alarms.filter((alarm) =>
          (alarm.Properties.Metrics ?? []).some(
            (query: any) => query.MetricStat?.Metric?.MetricName === metricName,
          ),
        );
        const tableAlarm = matchingAlarms.find((alarm) =>
          alarm.Properties.Metrics.some((query: any) =>
            query.MetricStat?.Metric?.Dimensions?.some(
              (dimension: any) =>
                dimension.Name === 'TableName' && dimension.Value?.Ref === tableId,
            ),
          ),
        );
        expect(tableAlarm).toBeDefined();

        const expression = tableAlarm.Properties.Metrics.find(
          (query: any) => query.Expression === 'SUM(METRICS())',
        );
        const operationMetrics = tableAlarm.Properties.Metrics.filter(
          (query: any) => query.MetricStat?.Metric?.MetricName === metricName,
        );
        expect(expression).toMatchObject({ Expression: 'SUM(METRICS())', ReturnData: true });
        expect(operationMetrics).toHaveLength(DYNAMODB_OPERATIONS.length);
        expect(
          operationMetrics.map((query: any) =>
            query.MetricStat.Metric.Dimensions.find(
              (dimension: any) => dimension.Name === 'Operation',
            )?.Value,
          ).sort(),
        ).toEqual([...DYNAMODB_OPERATIONS].sort());
        for (const query of operationMetrics) {
          expect(query.MetricStat.Metric.Namespace).toBe('AWS/DynamoDB');
          expect(query.MetricStat.Period).toBe(300);
          expect(query.MetricStat.Metric.Dimensions).toHaveLength(2);
          expect(query.MetricStat.Metric.Dimensions).toContainEqual({
            Name: 'TableName',
            Value: { Ref: tableId },
          });
        }
      }
      expect(
        alarms.filter(
          (alarm) =>
            alarm.Properties.Namespace === 'AWS/DynamoDB' &&
            alarm.Properties.MetricName === 'TransactionConflict' &&
            JSON.stringify(alarm.Properties.Dimensions) ===
              JSON.stringify([{ Name: 'TableName', Value: { Ref: tableId } }]),
        ),
      ).toHaveLength(1);
    }

    expect(
      alarms.flatMap((alarm) => alarm.Properties.Metrics ?? []).filter(
        (query: any) =>
          ['ThrottledRequests', 'SystemErrors'].includes(
            query.MetricStat?.Metric?.MetricName,
          ) && query.MetricStat.Metric.Dimensions.length === 1,
      ),
    ).toHaveLength(0);

    expect(
      alarms.filter(
        (alarm) => alarm.Properties.Namespace === 'AWS/ApiGateway' && alarm.Properties.MetricName === '5xx',
      ),
    ).toHaveLength(1);
    expect(
      alarms.filter(
        (alarm) =>
          alarm.Properties.Namespace === 'AWS/ApiGateway' &&
          ['429', 'Throttles', 'ThrottleCount'].includes(alarm.Properties.MetricName),
      ),
    ).toHaveLength(0);
    const queueAgeAlarms = alarms.filter(
      (alarm) =>
        alarm.Properties.Namespace === 'AWS/SQS' &&
        alarm.Properties.MetricName === 'ApproximateAgeOfOldestMessage' &&
        alarm.Properties.Threshold === 600,
    );
    expect(queueAgeAlarms).toHaveLength(1);
    expect(queueAgeAlarms[0].Properties.Statistic).toBe('Maximum');
    const dlqVisibleAlarms = alarms.filter(
      (alarm) =>
        alarm.Properties.Namespace === 'AWS/SQS' &&
        alarm.Properties.MetricName === 'ApproximateNumberOfMessagesVisible',
    );
    expect(dlqVisibleAlarms).toHaveLength(1);
    expect(dlqVisibleAlarms[0].Properties.Statistic).toBe('Maximum');
    for (const metricName of [
      'ConfigurationDrift',
      'CommercialConfigurationUnavailable',
      'CommercialSyntheticAlarm',
    ]) {
      expect(
        alarms.filter(
          (alarm) => alarm.Properties.Namespace === 'RoadMap2U' && alarm.Properties.MetricName === metricName,
        ),
      ).toHaveLength(1);
    }
    expect(alarms).toHaveLength(functions.length * 3 + tables.length * 3 + 6);
  }, 20_000);

  it('uses one five-minute policy and the same topic action on every alarm', () => {
    const template = renderedBackend();
    const [topicId] = Object.entries(template.Resources).find(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SNS::Topic',
    ) as [string, any];
    const alarms = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];

    for (const alarm of alarms) {
      const metricQueries = alarm.Properties.Metrics?.filter(
        (query: any) => query.MetricStat,
      );
      if (metricQueries) {
        for (const query of metricQueries) expect(query.MetricStat.Period).toBe(300);
      } else {
        expect(alarm.Properties.Period).toBe(300);
      }
      expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
      expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(alarm.Properties.AlarmName).toMatch(/^roadmap-commercial-dev-/);
    }
    expect(alarms.map((alarm) => alarm.Properties.AlarmName)).toContain(
      'roadmap-commercial-dev-synthetic',
    );
  }, 20_000);

  it('retains the production topic and alarms when a stack is replaced or deleted', () => {
    const template = renderedBackend('prod');
    const protectedResources = Object.values(template.Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::SNS::Topic' || resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];

    expect(protectedResources).toHaveLength(31);
    for (const resource of protectedResources) {
      expect(resource.DeletionPolicy).toBe('Retain');
      expect(resource.UpdateReplacePolicy).toBe('Retain');
    }
  }, 20_000);
});
