import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
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

function alarmMetricUnits(template: any): number {
  return Object.values(template.Resources)
    .filter((resource: any) => resource.Type === 'AWS::CloudWatch::Alarm')
    .reduce((total: number, alarm: any) => {
      const metricQueries = alarm.Properties.Metrics as any[] | undefined;
      if (!metricQueries) return total + 1;
      return (
        total +
        metricQueries.filter((query) => query.MetricStat?.Metric !== undefined).length
      );
    }, 0);
}

describe('commercial alarms', () => {
  it.each([
    [
      'dev',
      2,
      ['api-5xx', 'synthetic'],
    ],
    ['test', 1, ['synthetic']],
    [
      'prod',
      8,
      [
        'lambda-pre-signup-errors',
        'lambda-post-confirmation-errors',
        'api-5xx',
        'account-closure-queue-age',
        'account-closure-dlq-visible',
        'configuration-drift',
        'configuration-unavailable',
        'synthetic',
      ],
    ],
  ] as const)(
    'caps %s at %i alarm-metrics with only stage-critical signals',
    (stage, expectedMetricUnits, expectedAlarmNames) => {
      const template = renderedBackend(stage);
      const alarms = Object.values(template.Resources).filter(
        (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
      ) as any[];

      expect(alarmMetricUnits(template)).toBe(expectedMetricUnits);
      expect(
        alarms.map((alarm) => alarm.Properties.AlarmName).sort(),
      ).toEqual(
        expectedAlarmNames.map((name) => `roadmap-commercial-${stage}-${name}`).sort(),
      );
    },
    20_000,
  );

  it('creates one HTTPS-only topic and disables the conditional subscription by default', () => {
    const template = renderedBackend();
    const topics = Object.entries(template.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SNS::Topic',
    );
    const topicPolicies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SNS::TopicPolicy',
    ) as any[];

    expect(topics).toHaveLength(1);
    expect((topics[0]?.[1] as any).Properties.TopicName).toBe('roadmap-commercial-alerts-dev');
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
        statement.Effect === 'Allow' && statement.Principal?.Service === 'cloudwatch.amazonaws.com',
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

  it('keeps only the two Cognito-trigger error alarms in production', () => {
    const resources = renderedBackend('prod').Resources;
    const lambdaAlarms = Object.entries(resources).filter(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::CloudWatch::Alarm' &&
        resource.Properties.Namespace === 'AWS/Lambda',
    ) as [string, any][];

    expect(
      lambdaAlarms.map(([, alarm]) => alarm.Properties.AlarmName).sort(),
    ).toEqual(
      [
        'roadmap-commercial-prod-lambda-pre-signup-errors',
        'roadmap-commercial-prod-lambda-post-confirmation-errors',
      ].sort(),
    );
    expect(lambdaAlarms.map(([logicalId]) => logicalId)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CommercialObservabilityLambdaErrors0[A-F0-9]{8}$/),
        expect.stringMatching(/^CommercialObservabilityLambdaErrors1[A-F0-9]{8}$/),
      ]),
    );
  }, 20_000);

  it('uses only cost-capped critical signals and no DynamoDB math alarms', () => {
    const devAlarms = Object.values(renderedBackend('dev').Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];
    const prodAlarms = Object.values(renderedBackend('prod').Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];

    expect(
      devAlarms.map((alarm) => [alarm.Properties.Namespace, alarm.Properties.MetricName]),
    ).toEqual(
      expect.arrayContaining([
        ['AWS/ApiGateway', '5xx'],
        ['RoadMap2U', 'CommercialSyntheticAlarm'],
      ]),
    );
    expect(
      prodAlarms.map((alarm) => [alarm.Properties.Namespace, alarm.Properties.MetricName]),
    ).toEqual(
      expect.arrayContaining([
        ['AWS/Lambda', 'Errors'],
        ['AWS/ApiGateway', '5xx'],
        ['AWS/SQS', 'ApproximateAgeOfOldestMessage'],
        ['AWS/SQS', 'ApproximateNumberOfMessagesVisible'],
        ['RoadMap2U', 'ConfigurationDrift'],
        ['RoadMap2U', 'CommercialConfigurationUnavailable'],
        ['RoadMap2U', 'CommercialSyntheticAlarm'],
      ]),
    );
    for (const alarm of [...devAlarms, ...prodAlarms]) {
      expect(alarm.Properties.Namespace).not.toBe('AWS/DynamoDB');
      expect(alarm.Properties.MetricName).not.toBe('Duration');
      expect(alarm.Properties.MetricName).not.toBe('Throttles');
      expect(alarm.Properties.Metrics).toBeUndefined();
    }
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
      const metricQueries = alarm.Properties.Metrics?.filter((query: any) => query.MetricStat);
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

  it('retains the production topic but deletes reproducible alarms with the stack', () => {
    const template = renderedBackend('prod');
    const topics = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SNS::Topic',
    ) as any[];
    const alarms = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::CloudWatch::Alarm',
    ) as any[];

    expect(topics).toHaveLength(1);
    expect(topics[0].DeletionPolicy).toBe('Retain');
    expect(topics[0].UpdateReplacePolicy).toBe('Retain');
    expect(alarms).toHaveLength(8);
    for (const alarm of alarms) {
      expect(alarm.DeletionPolicy).not.toBe('Retain');
      expect(alarm.UpdateReplacePolicy).not.toBe('Retain');
    }
  }, 20_000);
});
