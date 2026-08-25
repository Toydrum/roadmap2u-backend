import {
  Aws,
  CfnCondition,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { DeploymentStage } from './roadmap-stack';

const ALARM_PERIOD = Duration.minutes(5);

export interface AlarmedFunction {
  readonly key: string;
  readonly function: lambda.IFunction;
}

export interface CommercialObservabilityProps {
  readonly stage: DeploymentStage;
  readonly functions: readonly AlarmedFunction[];
  readonly api: apigatewayv2.IHttpApi;
  readonly accountClosureQueue: sqs.IQueue;
  readonly accountClosureDlq: sqs.IQueue;
}

export interface CommercialObservability {
  readonly topic: sns.Topic;
  readonly syntheticAlarm: cloudwatch.Alarm;
}

function metric(
  namespace: string,
  metricName: string,
  dimensionsMap: Record<string, string>,
  statistic = 'Sum',
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    namespace,
    metricName,
    dimensionsMap,
    statistic,
    period: ALARM_PERIOD,
  });
}

export function createCommercialObservability(
  scope: Construct,
  id: string,
  props: CommercialObservabilityProps,
): CommercialObservability {
  const emailParameter = new CfnParameter(scope, 'AlarmNotificationEmail', {
    type: 'String',
    default: '',
    noEcho: true,
    maxLength: 254,
    allowedPattern: '^$|^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    constraintDescription:
      'Alarm notification email must be empty or a valid email address',
  });
  const hasAlarmNotificationEmail = new CfnCondition(
    scope,
    'HasAlarmNotificationEmail',
    {
      expression: Fn.conditionNot(
        Fn.conditionEquals(emailParameter.valueAsString, ''),
      ),
    },
  );
  const topic = new sns.Topic(scope, `${id}Topic`, {
    topicName: `roadmap-commercial-alerts-${props.stage}`,
    enforceSSL: true,
  });
  if (props.stage === 'prod') topic.applyRemovalPolicy(RemovalPolicy.RETAIN);
  topic.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowOnlyStageCloudWatchAlarms',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [topic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: {
          'aws:SourceArn': `arn:${Aws.PARTITION}:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:roadmap-commercial-${props.stage}-*`,
        },
      },
    }),
  );
  const emailSubscription = new sns.CfnSubscription(
    scope,
    `${id}EmailSubscription`,
    {
      topicArn: topic.topicArn,
      protocol: 'email',
      endpoint: emailParameter.valueAsString,
    },
  );
  emailSubscription.cfnOptions.condition = hasAlarmNotificationEmail;

  const topicAction = new cloudwatchActions.SnsAction(topic);
  const alarms: cloudwatch.Alarm[] = [];
  const createAlarm = (
    alarmId: string,
    alarmName: string,
    alarmMetric: cloudwatch.IMetric,
    threshold = 1,
  ): cloudwatch.Alarm => {
    const alarm = new cloudwatch.Alarm(scope, `${id}${alarmId}`, {
      alarmName: `roadmap-commercial-${props.stage}-${alarmName}`,
      metric: alarmMetric,
      threshold,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(topicAction);
    alarms.push(alarm);
    return alarm;
  };

  if (props.stage === 'prod') {
    for (const [index, target] of props.functions.entries()) {
      createAlarm(
        `LambdaErrors${index}`,
        `lambda-${target.key}-errors`,
        metric('AWS/Lambda', 'Errors', { FunctionName: target.function.functionName }),
      );
    }
  }

  if (props.stage !== 'test') {
    createAlarm(
      'Api5xx',
      'api-5xx',
      metric('AWS/ApiGateway', '5xx', { ApiId: props.api.apiId }),
    );
  }

  if (props.stage === 'prod') {
    createAlarm(
      'AccountClosureQueueAge',
      'account-closure-queue-age',
      metric(
        'AWS/SQS',
        'ApproximateAgeOfOldestMessage',
        { QueueName: props.accountClosureQueue.queueName },
        'Maximum',
      ),
      600,
    );
    createAlarm(
      'AccountClosureDlqVisible',
      'account-closure-dlq-visible',
      metric(
        'AWS/SQS',
        'ApproximateNumberOfMessagesVisible',
        { QueueName: props.accountClosureDlq.queueName },
        'Maximum',
      ),
    );
    createAlarm(
      'ConfigurationDrift',
      'configuration-drift',
      metric('RoadMap2U', 'ConfigurationDrift', { stage: props.stage }),
    );
    createAlarm(
      'CommercialConfigurationUnavailable',
      'configuration-unavailable',
      metric('RoadMap2U', 'CommercialConfigurationUnavailable', { stage: props.stage }),
    );
  }
  const syntheticAlarm = createAlarm(
    'Synthetic',
    'synthetic',
    metric('RoadMap2U', 'CommercialSyntheticAlarm', { stage: props.stage }),
  );

  const expectedAlarmCount: Record<DeploymentStage, number> = {
    dev: 2,
    test: 1,
    prod: 8,
  };
  if (alarms.length !== expectedAlarmCount[props.stage]) {
    throw new Error('commercial alarm inventory exceeds or misses its stage budget');
  }

  return { topic, syntheticAlarm };
}
