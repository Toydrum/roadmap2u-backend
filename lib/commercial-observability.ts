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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { DeploymentStage } from './roadmap-stack';

const ALARM_PERIOD = Duration.minutes(5);
const DYNAMODB_OPERATIONS = [
  'GetItem',
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'Query',
  'Scan',
  'BatchGetItem',
  'BatchWriteItem',
  'TransactGetItems',
  'TransactWriteItems',
] as const;

export interface AlarmedFunction {
  readonly key: string;
  readonly function: lambda.IFunction;
  readonly durationWarningMilliseconds: number;
}

export interface AlarmedTable {
  readonly key: string;
  readonly table: dynamodb.ITable;
}

export interface CommercialObservabilityProps {
  readonly stage: DeploymentStage;
  readonly functions: readonly AlarmedFunction[];
  readonly api: apigatewayv2.IHttpApi;
  readonly tables: readonly AlarmedTable[];
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

function dynamodbOperationTotal(
  tableName: string,
  metricName: 'ThrottledRequests' | 'SystemErrors',
): cloudwatch.MathExpression {
  const usingMetrics = Object.fromEntries(
    DYNAMODB_OPERATIONS.map((operation, index) => [
      `operation${index}`,
      metric('AWS/DynamoDB', metricName, { TableName: tableName, Operation: operation }),
    ]),
  );
  return new cloudwatch.MathExpression({
    expression: 'SUM(METRICS())',
    usingMetrics,
    period: ALARM_PERIOD,
    label: `${metricName} across DynamoDB operations`,
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
    if (props.stage === 'prod') alarm.applyRemovalPolicy(RemovalPolicy.RETAIN);
    alarms.push(alarm);
    return alarm;
  };

  for (const [index, target] of props.functions.entries()) {
    if (
      !Number.isInteger(target.durationWarningMilliseconds) ||
      target.durationWarningMilliseconds <= 0
    ) {
      throw new Error('commercial Lambda duration threshold is invalid');
    }
    createAlarm(
      `LambdaErrors${index}`,
      `lambda-${target.key}-errors`,
      metric('AWS/Lambda', 'Errors', { FunctionName: target.function.functionName }),
    );
    createAlarm(
      `LambdaThrottles${index}`,
      `lambda-${target.key}-throttles`,
      metric('AWS/Lambda', 'Throttles', { FunctionName: target.function.functionName }),
    );
    createAlarm(
      `LambdaDuration${index}`,
      `lambda-${target.key}-duration`,
      metric(
        'AWS/Lambda',
        'Duration',
        { FunctionName: target.function.functionName },
        'Maximum',
      ),
      target.durationWarningMilliseconds,
    );
  }

  createAlarm(
    'Api5xx',
    'api-5xx',
    metric('AWS/ApiGateway', '5xx', { ApiId: props.api.apiId }),
  );

  for (const [index, target] of props.tables.entries()) {
    createAlarm(
      `DynamoThrottles${index}`,
      `dynamodb-${target.key}-throttled`,
      dynamodbOperationTotal(target.table.tableName, 'ThrottledRequests'),
    );
    createAlarm(
      `DynamoSystemErrors${index}`,
      `dynamodb-${target.key}-system-errors`,
      dynamodbOperationTotal(target.table.tableName, 'SystemErrors'),
    );
    createAlarm(
      `DynamoTransactionConflicts${index}`,
      `dynamodb-${target.key}-transaction-conflicts`,
      metric('AWS/DynamoDB', 'TransactionConflict', {
        TableName: target.table.tableName,
      }),
    );
  }

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
  const syntheticAlarm = createAlarm(
    'Synthetic',
    'synthetic',
    metric('RoadMap2U', 'CommercialSyntheticAlarm', { stage: props.stage }),
  );

  // Keep this invariant local to the construct so a newly supplied Lambda cannot
  // silently lose its Errors alarm.
  if (
    alarms.length !==
    props.functions.length * 3 + props.tables.length * 3 + 6
  ) {
    throw new Error('commercial alarm inventory is incomplete');
  }

  return { topic, syntheticAlarm };
}
