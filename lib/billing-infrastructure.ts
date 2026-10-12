import { Aws, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMERCIAL_FLAGS_ATTRIBUTES } from '../lambda/commercial/flags';
import { bundledAwsSdkEsm } from './lambda-bundling';
import type { DeploymentStage } from './roadmap-stack';

const here = dirname(fileURLToPath(import.meta.url));
interface BillingInfrastructureProps {
  stage: DeploymentStage;
  table: dynamodb.ITable;
  privacyTable: dynamodb.ITable;
  api: apigatewayv2.HttpApi;
  authorizer: apigatewayv2.IHttpRouteAuthorizer;
  createRole: (id: string) => iam.Role;
  createLogGroup: (id: string, name: string) => logs.LogGroup;
  denyConfigWrites: (role: iam.Role) => void;
  accessAttributes: readonly string[];
  accountClosureWorker: NodejsFunction;
}
export interface BillingInfrastructure {
  queue: sqs.Queue;
  dlq: sqs.Queue;
  functions: { key: string; fn: NodejsFunction }[];
  logGroups: logs.ILogGroup[];
  routes: apigatewayv2.HttpRoute[];
}

function leadingKeys(keys: string[]) {
  return { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': keys } };
}
export function billingParameterArn(stack: Stack, stage: DeploymentStage, name: 'config' | 'webhook-secret') {
  return `arn:${Aws.PARTITION}:ssm:${stack.region}:${stack.account}:parameter/roadmap2u/${stage}/stripe/${name}`;
}

/** Adds financial consumers without replacing existing identity, privacy or forest resources. */
export function createBillingInfrastructure(scope: Stack, props: BillingInfrastructureProps): BillingInfrastructure {
  const { stage, table, privacyTable } = props;
  const removalPolicy = stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
  const dlq = new sqs.Queue(scope, 'BillingEventsDlq', {
    queueName: `roadmap-billing-events-dlq-${stage}`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
    removalPolicy,
  });
  const queue = new sqs.Queue(scope, 'BillingEventsQueue', {
    queueName: `roadmap-billing-events-${stage}`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(4),
    visibilityTimeout: Duration.seconds(360),
    deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    removalPolicy,
  });
  const functions: { key: string; fn: NodejsFunction }[] = [];
  const logGroups: logs.ILogGroup[] = [];
  const financialKeys = ['BILLING#*', `STRIPE#*#${stage}#*`];
  const eventKeys = [`STRIPE_EVENT#*#${stage}#*`];
  const readFinancial = (role: iam.Role, consumer: boolean) => {
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadFinancialJournalAndActor',
      actions: ['dynamodb:GetItem'],
      resources: [table.tableArn],
      conditions: leadingKeys([...financialKeys, ...(consumer ? eventKeys : []), 'USER#*', 'ACCOUNT_CLOSURE#*']),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'QueryOnlyFinancialHistoryAndAccessGrants',
      actions: ['dynamodb:Query'],
      resources: [table.tableArn],
      conditions: leadingKeys(['BILLING#*', ...(consumer ? ['USER#*'] : [])]),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadBillingPrivacyFences',
      actions: ['dynamodb:GetItem'],
      resources: [privacyTable.tableArn],
      conditions: leadingKeys(['RESTORE#*', 'PRIVACY_STATE#*']),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteOnlyFinancialJournalAndMappings',
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [table.tableArn],
      conditions: leadingKeys([...financialKeys, ...(consumer ? eventKeys : [])]),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'TransactBillingActorClosureAndLeaseFences',
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [table.tableArn],
      conditions: {
        ...leadingKeys(['USER#*', 'ACCOUNT_CLOSURE#*', 'BILLING#*']),
        StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
      },
    }));
  };
  const readSecret = (role: iam.Role, name: 'config' | 'webhook-secret') => {
    role.addToPolicy(new iam.PolicyStatement({
      sid: name === 'config' ? 'ReadBillingProviderConfiguration' : 'ReadOnlyWebhookSignatureConfiguration',
      actions: ['ssm:GetParameter'],
      resources: [billingParameterArn(scope, stage, name)],
    }));
  };
  const createFunction = (kind: string, entry: string, timeout: number, signatureOnly = false) => {
    const name = `roadmap-billing-${kind}-${stage}`;
    const role = props.createRole(`Billing${kind}Role`);
    props.denyConfigWrites(role);
    const logGroup = props.createLogGroup(`Billing${kind}Logs`, name);
    const fn = new NodejsFunction(scope, `Billing${kind}`, {
      functionName: name,
      entry: join(here, `../lambda/billing/${entry}.ts`),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(timeout),
      role,
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        STAGE: stage,
        BILLING_EVENT_QUEUE_URL: queue.queueUrl,
        ...(signatureOnly
          ? { STRIPE_WEBHOOK_SECRET_PARAMETER: `/roadmap2u/${stage}/stripe/webhook-secret` }
          : { STRIPE_CONFIG_PARAMETER: `/roadmap2u/${stage}/stripe/config`, PRIVACY_TABLE_NAME: privacyTable.tableName }),
      },
      bundling: bundledAwsSdkEsm(join(here, '../tsconfig.json')),
    });
    readSecret(role, signatureOnly ? 'webhook-secret' : 'config');
    functions.push({ key: kind, fn });
    logGroups.push(logGroup);
    return { fn, role };
  };
  const api = createFunction('api', 'handler', 30);
  readFinancial(api.role, false);
  api.role.addToPolicy(new iam.PolicyStatement({
    sid: 'ReadIndividualPurchaseControls',
    actions: ['dynamodb:GetItem'],
    resources: [table.tableArn],
    conditions: {
      'ForAllValues:StringEquals': {
        'dynamodb:LeadingKeys': ['COMMERCIAL#CONFIG'],
        'dynamodb:Attributes': [...COMMERCIAL_FLAGS_ATTRIBUTES],
      },
      Null: { 'dynamodb:Attributes': 'false' },
    },
  }));
  const webhook = createFunction('webhook', 'webhook', 15, true);
  webhook.role.addToPolicy(new iam.PolicyStatement({
    sid: 'DurablyAcceptOnlyStripeEventInbox',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [table.tableArn],
    conditions: leadingKeys(eventKeys),
  }));
  queue.grantSendMessages(webhook.role);
  const worker = createFunction('worker', 'worker', 60);
  const reconciler = createFunction('reconciler', 'reconciler', 60);
  for (const consumer of [worker, reconciler]) {
    readFinancial(consumer.role, true);
    consumer.role.addToPolicy(new iam.PolicyStatement({
      // The financial writer produces SUBSCRIPTION#INDIVIDUAL; AccessResolver alone materializes ACCESS.
      // IAM restricts partition/attributes/transaction, and the repository fixes the sort keys.
      sid: 'WriteIndividualSubscriptionProjection',
      actions: ['dynamodb:PutItem'],
      resources: [table.tableArn],
      conditions: {
        ...leadingKeys(['USER#*']),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...props.accessAttributes] },
        StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
        Null: { 'dynamodb:Attributes': 'false' },
      },
    }));
  }
  reconciler.role.addToPolicy(new iam.PolicyStatement({
    sid: 'QueryOnlyDueBillingPartitions',
    actions: ['dynamodb:Query'],
    resources: [`${table.tableArn}/index/gsi1`],
    conditions: leadingKeys([`BILLING#EVENTS#${stage}`, `BILLING#OWNERS#${stage}`]),
  }));
  queue.grantSendMessages(reconciler.role);
  worker.fn.addEventSource(new SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true }));
  for (const [mode, schedule] of [
    ['pending', events.Schedule.rate(Duration.minutes(1))],
    ['subscriptions', events.Schedule.rate(Duration.minutes(15))],
    ['audit', events.Schedule.rate(Duration.days(1))],
  ] as const) {
    new events.Rule(scope, `Billing${mode}Schedule`, {
      ruleName: `roadmap-billing-${mode}-${stage}`,
      schedule,
      targets: [new eventTargets.LambdaFunction(reconciler.fn, {
        event: events.RuleTargetInput.fromObject({ mode }),
        retryAttempts: 2,
        maxEventAge: Duration.minutes(30),
      })],
    });
  }
  props.accountClosureWorker.addEnvironment('STRIPE_CONFIG_PARAMETER', `/roadmap2u/${stage}/stripe/config`);
  props.accountClosureWorker.addEnvironment('STAGE', stage);
  readSecret(props.accountClosureWorker.role as iam.Role, 'config');
  props.accountClosureWorker.addToRolePolicy(new iam.PolicyStatement({
    sid: 'TransactOnlyAccountClosureFinancialJournal',
    actions: ['dynamodb:PutItem'],
    resources: [table.tableArn],
    conditions: {
      ...leadingKeys(financialKeys),
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    },
  }));
  props.accountClosureWorker.addToRolePolicy(new iam.PolicyStatement({
    sid: 'TransactOnlyAccountClosureBillingLeaseFence',
    actions: ['dynamodb:ConditionCheckItem'],
    resources: [table.tableArn],
    conditions: {
      ...leadingKeys(['BILLING#*']),
      StringEquals: { 'dynamodb:EnclosingOperation': 'TransactWriteItems' },
    },
  }));

  const integration = new HttpLambdaIntegration('IndividualBillingIntegration', api.fn);
  const routes: apigatewayv2.HttpRoute[] = [];
  for (const [path, method, authenticated] of [
    ['/v1/billing/individual/catalog', apigatewayv2.HttpMethod.GET, false],
    ['/v1/billing/individual/summary', apigatewayv2.HttpMethod.GET, true],
    ['/v1/billing/individual/checkout', apigatewayv2.HttpMethod.POST, true],
    ['/v1/billing/individual/portal', apigatewayv2.HttpMethod.POST, true],
  ] as const) {
    routes.push(...props.api.addRoutes({ path, methods: [method], integration, ...(authenticated ? { authorizer: props.authorizer } : {}) }));
  }
  routes.push(...props.api.addRoutes({
    path: '/v1/billing/stripe/webhook',
    methods: [apigatewayv2.HttpMethod.POST],
    integration: new HttpLambdaIntegration('StripeWebhookIntegration', webhook.fn),
  }));
  logGroups.push(props.accountClosureWorker.logGroup);
  return { queue, dlq, functions, logGroups, routes };
}

/** Sanitized JSON logs become metrics without granting runtimes cloudwatch:PutMetricData. */
export function createBillingObservability(scope: Stack, stage: DeploymentStage, billing: BillingInfrastructure, topic: sns.ITopic): void {
  const action = new SnsAction(topic);
  const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, sustained = false) => {
    const result = new cloudwatch.Alarm(scope, `BillingAlarm${id}`, {
      alarmName: `roadmap-commercial-${stage}-billing-${id}`,
      metric,
      threshold,
      evaluationPeriods: sustained ? 2 : 1,
      datapointsToAlarm: sustained ? 2 : 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    result.addAlarmAction(action);
  };
  alarm('dlq-visible', billing.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }), 0);
  alarm('queue-age', billing.queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), statistic: 'Maximum' }), 300);
  for (const [metricName, id, threshold, statistic, sustained] of [
    ['PendingEventAgeSeconds', 'pending-event-age', 300, 'Maximum', false],
    ['ReconciliationLagSeconds', 'reconciliation-lag', 1800, 'Maximum', false],
    ['DuplicateSubscription', 'duplicate-subscription', 0, 'Sum', false],
    ['MappingConflict', 'mapping-conflict', 0, 'Sum', false],
    ['AccountClosureBillingBlocked', 'closure-blocked', 0, 'Sum', false],
    ['SignatureError', 'signature-errors', 4, 'Sum', true],
    ['StripeError', 'stripe-errors', 4, 'Sum', true],
    ['ConfigurationError', 'configuration-errors', 4, 'Sum', true],
  ] as const) {
    for (const [index, logGroup] of billing.logGroups.entries()) {
      new logs.MetricFilter(scope, `BillingMetric${metricName}${index}`, {
        logGroup,
        filterPattern: logs.FilterPattern.all(logs.FilterPattern.stringValue('$.billingMetric', '=', metricName), logs.FilterPattern.exists('$.value')),
        metricNamespace: `RoadMap2U/Billing/${stage}`,
        metricName,
        metricValue: '$.value',
        unit: statistic === 'Maximum' ? cloudwatch.Unit.SECONDS : cloudwatch.Unit.COUNT,
      });
    }
    alarm(id, new cloudwatch.Metric({ namespace: `RoadMap2U/Billing/${stage}`, metricName, statistic, period: Duration.minutes(5) }), threshold, sustained);
  }
  for (const { key, fn } of billing.functions) {
    alarm(`${key}-lambda-errors`, fn.metricErrors({ period: Duration.minutes(5) }), 0);
  }
}
