import { Arn, ArnFormat, Aws, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export type PolicyStage = 'dev' | 'test' | 'prod';

export interface StageManagedPolicies {
  readonly core: iam.ManagedPolicy;
  readonly api: iam.ManagedPolicy;
  readonly data: iam.ManagedPolicy;
  readonly commercialAccess: iam.ManagedPolicy;
  readonly edge: iam.ManagedPolicy;
  readonly observability: iam.ManagedPolicy;
  readonly runtimeBoundary: iam.ManagedPolicy;
  readonly inventoryRuntimeBoundary: iam.ManagedPolicy;
}

const ROOT_DOMAIN = 'roadmap2u.com';
const PROJECT_TAG = 'roadmap2u-project';
const STAGE_TAG = 'roadmap2u-stage';
const CLOUDFORMATION_API_TAG_KEYS = [
  PROJECT_TAG,
  STAGE_TAG,
  'aws:cloudformation:logical-id',
  'aws:cloudformation:stack-id',
  'aws:cloudformation:stack-name',
];
const CERTIFICATE_CREATE_TAG_KEYS = ['Name', PROJECT_TAG, STAGE_TAG];
const BOOTSTRAP_QUALIFIERS: Record<PolicyStage, string> = {
  dev: 'rmap2udev',
  test: 'rmap2utst',
  prod: 'rmap2uprd',
};
const COMMERCIAL_INVENTORY_TOP_LEVEL_ATTRIBUTES = [
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
] as const;

function resourceArn(
  stack: Stack,
  service: string,
  resource: string,
  resourceName?: string,
  options: { readonly region?: string; readonly account?: string } = {},
): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service,
      region: options.region ?? stack.region,
      account: options.account ?? stack.account,
      resource,
      resourceName,
    },
    stack,
  );
}

function policyArn(stack: Stack, stage: PolicyStage, name: string): string {
  return resourceArn(stack, 'iam', 'policy', `roadmap2u/${stage}/${name}`, {
    region: '',
  });
}

function roleArn(stack: Stack, stage: PolicyStage): string {
  return resourceArn(stack, 'iam', 'role', `roadmap2u/${stage}/runtime/*`, { region: '' });
}

function functionArn(stack: Stack, stage: PolicyStage, name: string): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'lambda',
      region: stack.region,
      account: stack.account,
      resource: 'function',
      resourceName: `roadmap-${name}-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function functionArns(stack: Stack, stage: PolicyStage): string[] {
  return ['pre-signup', 'post-confirmation', 'router', 'account-closure-*'].map((name) =>
    functionArn(stack, stage, name),
  );
}

function eventSourceMappingArn(stack: Stack): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'lambda',
      region: stack.region,
      account: stack.account,
      resource: 'event-source-mapping',
      resourceName: '*',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function commercialHttpFunctionArns(stack: Stack, stage: PolicyStage): string[] {
  return ['catalog', 'access-reader'].map((name) => functionArn(stack, stage, name));
}

function lambdaLogGroupArns(stack: Stack, stage: PolicyStage): string[] {
  return ['pre-signup', 'post-confirmation', 'router', 'account-closure-*'].map((name) =>
    Arn.format(
      {
        partition: Aws.PARTITION,
        service: 'logs',
        region: stack.region,
        account: stack.account,
        resource: 'log-group',
        resourceName: `/aws/lambda/roadmap-${name}-${stage}`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      stack,
    ),
  );
}

function lambdaLogArns(stack: Stack, stage: PolicyStage): string[] {
  return lambdaLogGroupArns(stack, stage).map((arn) => `${arn}:*`);
}

function commercialHttpLogGroupArns(stack: Stack, stage: PolicyStage): string[] {
  return ['catalog', 'access-reader'].map((name) =>
    Arn.format(
      {
        partition: Aws.PARTITION,
        service: 'logs',
        region: stack.region,
        account: stack.account,
        resource: 'log-group',
        resourceName: `/aws/lambda/roadmap-${name}-${stage}`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      stack,
    ),
  );
}

function accessCodeRedeemerLogGroupArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'logs',
      region: stack.region,
      account: stack.account,
      resource: 'log-group',
      resourceName: `/aws/lambda/roadmap-access-code-redeemer-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function commercialHttpLogArns(stack: Stack, stage: PolicyStage): string[] {
  return commercialHttpLogGroupArns(stack, stage).map((arn) => `${arn}:*`);
}

function commercialConfigBrokerLogGroupArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'logs',
      region: stack.region,
      account: stack.account,
      resource: 'log-group',
      resourceName: `/aws/lambda/roadmap-commercial-config-broker-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function sponsoredAccessBrokerLogGroupArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'logs',
      region: stack.region,
      account: stack.account,
      resource: 'log-group',
      resourceName: `/aws/lambda/roadmap-sponsored-access-broker-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function accessCodeParameterArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'ssm',
      region: stack.region,
      account: stack.account,
      resource: 'parameter',
      resourceName: `roadmap2u/${stage}/access-code-hmac/v1`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    },
    stack,
  );
}

function commercialInventoryExecutorLogGroupArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'logs',
      region: stack.region,
      account: stack.account,
      resource: 'log-group',
      resourceName: `/aws/lambda/roadmap-commercial-inventory-executor-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function commercialInventoryExecutorRoleNameArn(stack: Stack, stage: PolicyStage): string {
  return resourceArn(stack, 'iam', 'role', `roadmap-commercial-inventory-executor-${stage}`, {
    region: '',
  });
}

function commercialAlarmTopicArn(stack: Stack, stage: PolicyStage): string {
  return `arn:${Aws.PARTITION}:sns:${stack.region}:${stack.account}:roadmap-commercial-alerts-${stage}`;
}

function commercialAlarmArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'cloudwatch',
      region: stack.region,
      account: stack.account,
      resource: 'alarm',
      resourceName: `roadmap-commercial-${stage}-*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  );
}

function apiAccessLogArn(stack: Stack, stage: PolicyStage): string {
  return `${Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'logs',
      region: stack.region,
      account: stack.account,
      resource: 'log-group',
      resourceName: `/aws/apigateway/roadmap-api-${stage}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    },
    stack,
  )}:*`;
}

function primaryTableArns(stack: Stack, stage: PolicyStage): string[] {
  const table = resourceArn(stack, 'dynamodb', 'table', `roadmap-${stage}`);
  return [table, `${table}/index/*`];
}

function auditTableArn(stack: Stack, stage: PolicyStage): string {
  return resourceArn(stack, 'dynamodb', 'table', `roadmap-access-audit-${stage}`);
}

function accountClosureSourceQueueArn(stack: Stack, stage: PolicyStage): string {
  return resourceArn(stack, 'sqs', `roadmap-account-closure-${stage}`);
}

function accountClosureQueueArns(stack: Stack, stage: PolicyStage): string[] {
  return [
    accountClosureSourceQueueArn(stack, stage),
    resourceArn(stack, 'sqs', `roadmap-account-closure-dlq-${stage}`),
  ];
}

function accountClosureReconcileRuleArn(stack: Stack, stage: PolicyStage): string {
  return resourceArn(stack, 'events', 'rule', `roadmap-account-closure-reconciler-${stage}`);
}

function userPoolArn(stack: Stack): string {
  return resourceArn(stack, 'cognito-idp', 'userpool', '*');
}

function stageTagConditions(stage: PolicyStage): Record<string, Record<string, string>> {
  return {
    StringEquals: {
      [`aws:ResourceTag/${PROJECT_TAG}`]: 'RoadMap2U',
      [`aws:ResourceTag/${STAGE_TAG}`]: stage,
    },
  };
}

function requestTagConditions(stage: PolicyStage): Record<string, Record<string, string>> {
  return {
    StringEquals: {
      [`aws:RequestTag/${PROJECT_TAG}`]: 'RoadMap2U',
      [`aws:RequestTag/${STAGE_TAG}`]: stage,
    },
  };
}

function apiDomain(stage: PolicyStage): string {
  return stage === 'prod' ? `api.${ROOT_DOMAIN}` : `api.${stage}.${ROOT_DOMAIN}`;
}

function apiDomainTagArn(stack: Stack, stage: PolicyStage): string {
  const region = stack.region;
  return `arn:${Aws.PARTITION}:apigateway:${region}::/tags/arn%3A${Aws.PARTITION}%3Aapigateway%3A${region}%3A%3A%2Fdomainnames%2F${apiDomain(stage)}`;
}

function frontendDomain(stage: PolicyStage): string {
  return stage === 'prod' ? ROOT_DOMAIN : `${stage}.${ROOT_DOMAIN}`;
}

function certificateValidationName(domain: string): string {
  return `_${'?'.repeat(32)}.${domain}`;
}

function route53Statement(
  stack: Stack,
  stage: PolicyStage,
  hostedZoneId: string,
  tier: 'core' | 'edge',
): iam.PolicyStatement {
  const domain = tier === 'core' ? apiDomain(stage) : frontendDomain(stage);
  const recordNames =
    tier === 'edge' && stage === 'prod'
      ? [certificateValidationName(ROOT_DOMAIN), certificateValidationName(`www.${ROOT_DOMAIN}`)]
      : [domain, certificateValidationName(domain)];

  return new iam.PolicyStatement({
    sid: tier === 'core' ? 'ManageStageApiDns' : 'ManageStageFrontendDns',
    actions: ['route53:ChangeResourceRecordSets'],
    resources: [`arn:${Aws.PARTITION}:route53:::hostedzone/${hostedZoneId}`],
    conditions: {
      'ForAllValues:StringLike': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': recordNames,
      },
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsRecordTypes': ['A', 'AAAA', 'CNAME'],
        'route53:ChangeResourceRecordSetsActions': ['CREATE', 'UPSERT', 'DELETE'],
      },
    },
  });
}

function certificateStatements(stack: Stack, stage: PolicyStage): iam.PolicyStatement[] {
  const allowedDomains = [apiDomain(stage), frontendDomain(stage)];
  const allowedNames = [
    `Roadmap-${stage}-Backend/ApiCertificate`,
    `Roadmap-${stage}-Hosting/SiteCertificate`,
  ];
  if (stage === 'prod') allowedDomains.push(`www.${ROOT_DOMAIN}`);
  return [
    new iam.PolicyStatement({
      sid: 'RequestOnlyStageCertificates',
      actions: ['acm:RequestCertificate'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'acm:CertificateKeyPairOrigin': 'AWS_MANAGED',
          'acm:ValidationMethod': 'DNS',
        },
        'ForAllValues:StringEquals': { 'acm:DomainNames': allowedDomains },
        Null: {
          'acm:CertificateAuthority': 'true',
          'acm:DomainNames': 'false',
        },
      },
    }),
    new iam.PolicyStatement({
      sid: 'TagOnlyUntaggedStageCertificates',
      actions: ['acm:AddTagsToCertificate'],
      resources: [resourceArn(stack, 'acm', 'certificate', '*')],
      conditions: {
        StringEquals: {
          'acm:CertificateKeyPairOrigin': 'AWS_MANAGED',
          'aws:RequestTag/Name': allowedNames,
        },
        StringEqualsIfExists: {
          ...requestTagConditions(stage).StringEquals,
        },
        Null: {
          'aws:ResourceTag/Name': 'true',
          [`aws:ResourceTag/${PROJECT_TAG}`]: 'true',
          [`aws:ResourceTag/${STAGE_TAG}`]: 'true',
          'aws:TagKeys': 'false',
        },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': CERTIFICATE_CREATE_TAG_KEYS,
        },
      },
    }),
    new iam.PolicyStatement({
      sid: 'TagOnlyNamedStageCertificates',
      actions: ['acm:AddTagsToCertificate'],
      resources: [resourceArn(stack, 'acm', 'certificate', '*')],
      conditions: {
        StringEquals: {
          'acm:CertificateKeyPairOrigin': 'AWS_MANAGED',
          'aws:ResourceTag/Name': allowedNames,
        },
        StringEqualsIfExists: {
          ...requestTagConditions(stage).StringEquals,
        },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': [PROJECT_TAG, STAGE_TAG],
        },
        Null: {
          'aws:TagKeys': 'false',
        },
      },
    }),
    new iam.PolicyStatement({
      sid: 'ManageOnlyTaggedStageCertificates',
      actions: [
        'acm:DeleteCertificate',
        'acm:DescribeCertificate',
        'acm:ListTagsForCertificate',
        'acm:RemoveTagsFromCertificate',
      ],
      resources: [resourceArn(stack, 'acm', 'certificate', '*')],
      conditions: stageTagConditions(stage),
    }),
  ];
}

function createRuntimeBoundary(stack: Stack, stage: PolicyStage): iam.ManagedPolicy {
  return new iam.ManagedPolicy(stack, `RuntimeBoundary${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-runtime-boundary`,
    path: `/roadmap2u/${stage}/`,
    description: `Maximum runtime permissions for RoadMap2U ${stage} Lambda roles`,
    statements: [
      new iam.PolicyStatement({
        sid: 'WriteOnlyOwnFunctionLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          ...lambdaLogArns(stack, stage),
          ...commercialHttpLogArns(stack, stage),
          `${accessCodeRedeemerLogGroupArn(stack, stage)}:*`,
          `${commercialConfigBrokerLogGroupArn(stack, stage)}:*`,
          `${sponsoredAccessBrokerLogGroupArn(stack, stage)}:*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: 'UseOnlyOwnStageTable',
        actions: [
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: primaryTableArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'AppendOnlyAuditEvents',
        actions: ['dynamodb:PutItem'],
        resources: [auditTableArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'ReadOnlySponsoredAccessHmacParameter',
        actions: ['ssm:GetParameter'],
        resources: [accessCodeParameterArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'UseOnlyAccountClosureQueues',
        actions: [
          'sqs:ChangeMessageVisibility',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ReceiveMessage',
          'sqs:SendMessage',
        ],
        resources: [accountClosureSourceQueueArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'AdministerOnlyOwnTaggedUserPool',
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminUpdateUserAttributes',
        ],
        resources: [userPoolArn(stack)],
        conditions: stageTagConditions(stage),
      }),
    ],
  });
}

function createInventoryRuntimeBoundary(stack: Stack, stage: PolicyStage): iam.ManagedPolicy {
  return new iam.ManagedPolicy(stack, `InventoryRuntimeBoundary${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-inventory-runtime-boundary`,
    path: `/roadmap2u/${stage}/`,
    description: `Maximum permissions for the RoadMap2U ${stage} commercial inventory executor`,
    statements: [
      new iam.PolicyStatement({
        sid: 'WriteOnlyCommercialInventoryLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${commercialInventoryExecutorLogGroupArn(stack, stage)}:*`],
      }),
      new iam.PolicyStatement({
        sid: 'ScanOnlyCommercialInventoryProjection',
        actions: ['dynamodb:Scan'],
        resources: [primaryTableArns(stack, stage)[0]],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:Attributes': [...COMMERCIAL_INVENTORY_TOP_LEVEL_ATTRIBUTES],
          },
          StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
          Null: { 'dynamodb:Attributes': 'false' },
        },
      }),
    ],
  });
}

function createCorePolicies(
  stack: Stack,
  stage: PolicyStage,
  hostedZoneId: string,
): {
  readonly core: iam.ManagedPolicy;
  readonly api: iam.ManagedPolicy;
  readonly data: iam.ManagedPolicy;
} {
  const destructiveTableActions = stage === 'prod' ? [] : ['dynamodb:DeleteTable'];
  const destructivePoolActions = stage === 'prod' ? [] : ['cognito-idp:DeleteUserPool'];
  const destructiveQueueActions = stage === 'prod' ? [] : ['sqs:DeleteQueue'];
  const boundary = policyArn(stack, stage, `roadmap2u-${stage}-runtime-boundary`);
  const api = apiDomain(stage);
  const stagePathRole = roleArn(stack, stage);

  const core = new iam.ManagedPolicy(stack, `CfnCorePolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-core`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation core-service permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'DenyExportableStageCertificates',
        effect: iam.Effect.DENY,
        actions: ['acm:RequestCertificate'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'acm:Export': 'ENABLED',
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'CreateBoundedStageRuntimeRoles',
        actions: ['iam:CreateRole'],
        resources: [stagePathRole],
        conditions: {
          StringEquals: {
            'iam:PermissionsBoundary': boundary,
            'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
            'aws:RequestTag/roadmap2u-stage': stage,
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageRuntimeRoles',
        actions: [
          'iam:DeleteRole',
          'iam:DeleteRolePolicy',
          'iam:GetRole',
          'iam:GetRolePolicy',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
          'iam:PutRolePolicy',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:UpdateAssumeRolePolicy',
          'iam:UpdateRole',
          'iam:UpdateRoleDescription',
        ],
        resources: [stagePathRole],
      }),
      new iam.PolicyStatement({
        sid: 'SetOnlyStageRuntimeBoundary',
        actions: ['iam:PutRolePermissionsBoundary'],
        resources: [stagePathRole],
        conditions: {
          StringEquals: { 'iam:PermissionsBoundary': boundary },
        },
      }),
      new iam.PolicyStatement({
        sid: 'AttachOnlyLambdaBasicExecution',
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [stagePathRole],
        conditions: {
          StringEquals: {
            'iam:PolicyARN': `arn:${Aws.PARTITION}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'PassOnlyStageRuntimeRolesToLambda',
        actions: ['iam:PassRole'],
        resources: [stagePathRole],
        conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageFunctions',
        actions: [
          'lambda:AddPermission',
          'lambda:CreateFunction',
          'lambda:DeleteFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:GetPolicy',
          'lambda:GetRuntimeManagementConfig',
          'lambda:ListTags',
          'lambda:RemovePermission',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
        ],
        resources: functionArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'ReadOnlyStageLambdaAssets',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [
          `arn:${Aws.PARTITION}:s3:::cdk-${BOOTSTRAP_QUALIFIERS[stage]}-assets-${stack.account}-${stack.region}/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ReadOnlySelectedBootstrapVersion',
        actions: ['ssm:GetParameters'],
        resources: [
          resourceArn(
            stack,
            'ssm',
            'parameter',
            `cdk-bootstrap/${BOOTSTRAP_QUALIFIERS[stage]}/version`,
          ),
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageLogGroups',
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:TagResource',
        ],
        resources: lambdaLogArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageLogGroupTags',
        actions: ['logs:ListTagsForResource', 'logs:TagResource', 'logs:UntagResource'],
        resources: lambdaLogGroupArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'InspectLogGroupsForCloudFormation',
        actions: ['logs:DescribeLogGroups'],
        resources: ['*'],
      }),
      route53Statement(stack, stage, hostedZoneId, 'core'),
      new iam.PolicyStatement({
        sid: 'ReadStageZoneAndDnsChanges',
        actions: ['route53:GetHostedZone'],
        resources: [`arn:${Aws.PARTITION}:route53:::hostedzone/${hostedZoneId}`],
      }),
      new iam.PolicyStatement({
        sid: 'WaitForStageDnsChanges',
        actions: ['route53:GetChange'],
        resources: [`arn:${Aws.PARTITION}:route53:::change/*`],
      }),
    ],
  });

  const dataPolicy = new iam.ManagedPolicy(stack, `CfnDataPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-data`,
    path: `/roadmap2u/${stage}/`,
    // AWS::IAM::ManagedPolicy.Description is create-only; keep this deployed value stable.
    description: `CloudFormation data-service permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialConfigBrokerLogGroup',
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:TagResource',
        ],
        resources: [`${commercialConfigBrokerLogGroupArn(stack, stage)}:*`],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialConfigBrokerLogGroupTags',
        actions: ['logs:ListTagsForResource', 'logs:TagResource', 'logs:UntagResource'],
        resources: [commercialConfigBrokerLogGroupArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialConfigBrokerFunctionUrl',
        actions: [
          'lambda:AddPermission',
          'lambda:CreateFunction',
          'lambda:CreateFunctionUrlConfig',
          'lambda:DeleteFunction',
          'lambda:DeleteFunctionUrlConfig',
          'lambda:GetFunction',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:GetFunctionUrlConfig',
          'lambda:GetPolicy',
          'lambda:GetRuntimeManagementConfig',
          'lambda:ListTags',
          'lambda:RemovePermission',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:UpdateFunctionUrlConfig',
        ],
        resources: [functionArn(stack, stage, 'commercial-config-broker')],
      }),
      new iam.PolicyStatement({
        sid: 'CreateOnlyTaggedStageUserPools',
        actions: ['cognito-idp:CreateUserPool'],
        resources: ['*'],
        conditions: requestTagConditions(stage),
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyTaggedStageUserPools',
        actions: [
          'cognito-idp:CreateUserPoolClient',
          'cognito-idp:DeleteUserPoolClient',
          'cognito-idp:DescribeUserPool',
          'cognito-idp:DescribeUserPoolClient',
          'cognito-idp:ListTagsForResource',
          'cognito-idp:TagResource',
          'cognito-idp:UntagResource',
          'cognito-idp:UpdateUserPool',
          'cognito-idp:UpdateUserPoolClient',
          ...destructivePoolActions,
        ],
        resources: [userPoolArn(stack)],
        conditions: stageTagConditions(stage),
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageTable',
        actions: [
          'dynamodb:CreateTable',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:DescribeContributorInsights',
          'dynamodb:DescribeKinesisStreamingDestination',
          'dynamodb:DescribeTable',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:GetResourcePolicy',
          'dynamodb:ListTagsOfResource',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:UpdateTable',
          'dynamodb:UpdateTimeToLive',
          ...destructiveTableActions,
        ],
        resources: [...primaryTableArns(stack, stage), auditTableArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyAccountClosureQueues',
        actions: [
          'sqs:CreateQueue',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ListQueueTags',
          'sqs:SetQueueAttributes',
          'sqs:TagQueue',
          'sqs:UntagQueue',
          ...destructiveQueueActions,
        ],
        resources: accountClosureQueueArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'ManageAccountClosureEventSourceMapping',
        actions: [
          'lambda:CreateEventSourceMapping',
          'lambda:DeleteEventSourceMapping',
          'lambda:GetEventSourceMapping',
          'lambda:ListEventSourceMappings',
          'lambda:UpdateEventSourceMapping',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': stack.region },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyAccountClosureEventSourceMappingTags',
        actions: ['lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource'],
        resources: [eventSourceMappingArn(stack)],
      }),
      new iam.PolicyStatement({
        sid: 'ManageAccountClosureReconcileRule',
        actions: [
          'events:DeleteRule',
          'events:DescribeRule',
          'events:DisableRule',
          'events:EnableRule',
          'events:ListTagsForResource',
          'events:ListTargetsByRule',
          'events:PutRule',
          'events:PutTargets',
          'events:RemoveTargets',
          'events:TagResource',
          'events:UntagResource',
        ],
        resources: [accountClosureReconcileRuleArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageParameters',
        actions: [
          'ssm:AddTagsToResource',
          'ssm:DeleteParameter',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:ListTagsForResource',
          'ssm:PutParameter',
          'ssm:RemoveTagsFromResource',
        ],
        resources: [
          'region',
          'user-pool-id',
          'user-pool-client-id',
          'api-base-url',
          'contract-hash',
        ].map((name) => resourceArn(stack, 'ssm', 'parameter', `roadmap2u/${stage}/${name}`)),
      }),
      new iam.PolicyStatement({
        // The protected stage toolkit pre-provisions the exact resource-scoped log policy.
        // The five delivery actions are permission-only and cannot be resource-scoped; this
        // role can inspect that policy but cannot create, replace, or delete it.
        sid: 'ManageHttpApiAccessLogDelivery',
        actions: [
          'logs:CreateLogDelivery',
          'logs:DeleteLogDelivery',
          'logs:DescribeResourcePolicies',
          'logs:GetLogDelivery',
          'logs:ListLogDeliveries',
          'logs:UpdateLogDelivery',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:RequestedRegion': stack.region,
          },
        },
      }),
    ],
  });

  const apiPolicy = new iam.ManagedPolicy(stack, `CfnApiPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-api`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation API-service permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'CreateTaggedStageHttpApi',
        actions: ['apigateway:POST'],
        resources: [resourceArn(stack, 'apigateway', '/apis', undefined, { account: '' })],
        conditions: {
          StringEquals: {
            ...requestTagConditions(stage).StringEquals,
            'apigateway:Request/ApiName': `roadmap-api-${stage}`,
          },
          'ForAllValues:StringEquals': {
            'aws:TagKeys': CLOUDFORMATION_API_TAG_KEYS,
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyTaggedStageHttpApi',
        actions: [
          'apigateway:DELETE',
          'apigateway:GET',
          'apigateway:PATCH',
          'apigateway:POST',
          'apigateway:PUT',
        ],
        resources: [resourceArn(stack, 'apigateway', '/apis/*', undefined, { account: '' })],
        conditions: {
          ...stageTagConditions(stage),
          StringEqualsIfExists: {
            'apigateway:Request/AccessLoggingDestination': apiAccessLogArn(stack, stage),
          },
        },
      }),
      new iam.PolicyStatement({
        // The AWS::ApiGatewayV2::Stage provider invokes this literal dependent action on create.
        // Access Analyzer can lag the CloudFormation provider schema and report INVALID_ACTION.
        // Request tags are reliable during create; the parent-tag gate remains on the POST above.
        sid: 'TagOnlyCreatingStageApiStage',
        actions: ['apigateway:TagResource'],
        resources: [resourceArn(stack, 'apigateway', '/apis/*/stages', undefined, { account: '' })],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': CLOUDFORMATION_API_TAG_KEYS,
          },
          Null: {
            'aws:TagKeys': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'CreateTaggedStageApiDomain',
        actions: ['apigateway:POST'],
        resources: [resourceArn(stack, 'apigateway', '/domainnames', undefined, { account: '' })],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': CLOUDFORMATION_API_TAG_KEYS,
            'apigateway:Request/EndpointType': ['REGIONAL'],
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'TagOnlyCreatingStageApiDomain',
        actions: ['apigateway:PUT'],
        resources: [apiDomainTagArn(stack, stage)],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': CLOUDFORMATION_API_TAG_KEYS,
          },
          Null: {
            'aws:TagKeys': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageApiDomain',
        actions: [
          'apigateway:AddCertificateToDomain',
          'apigateway:DELETE',
          'apigateway:GET',
          'apigateway:PATCH',
          'apigateway:POST',
          'apigateway:PUT',
          'apigateway:RemoveCertificateFromDomain',
        ],
        resources: [
          resourceArn(stack, 'apigateway', `/domainnames/${api}`, undefined, { account: '' }),
          resourceArn(stack, 'apigateway', `/domainnames/${api}/*`, undefined, { account: '' }),
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyTaggedApiGatewayTags',
        actions: ['apigateway:DELETE', 'apigateway:GET', 'apigateway:POST'],
        resources: [resourceArn(stack, 'apigateway', '/tags/*', undefined, { account: '' })],
        conditions: stageTagConditions(stage),
      }),
      ...certificateStatements(stack, stage),
    ],
  });
  return { core, api: apiPolicy, data: dataPolicy };
}

function createEdgePolicy(
  stack: Stack,
  stage: PolicyStage,
  hostedZoneId: string,
): iam.ManagedPolicy {
  const bucketArn = `arn:${Aws.PARTITION}:s3:::roadmap2u-${stage}-${stack.account}`;
  const destructiveBucketActions =
    stage === 'prod' ? [] : ['s3:DeleteBucket', 's3:DeleteBucketPolicy'];
  return new iam.ManagedPolicy(stack, `CfnEdgePolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-edge`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation edge-service permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageHostingBucket',
        actions: [
          's3:CreateBucket',
          's3:GetBucketAcl',
          's3:GetEncryptionConfiguration',
          's3:GetBucketLocation',
          's3:GetBucketPolicy',
          's3:GetBucketPublicAccessBlock',
          's3:GetBucketTagging',
          's3:GetBucketVersioning',
          's3:ListBucket',
          's3:PutEncryptionConfiguration',
          's3:PutBucketPolicy',
          's3:PutBucketPublicAccessBlock',
          's3:PutBucketTagging',
          's3:PutBucketVersioning',
          ...destructiveBucketActions,
        ],
        resources: [bucketArn],
      }),
      new iam.PolicyStatement({
        sid: 'CreateTaggedStageDistribution',
        actions: ['cloudfront:CreateDistribution', 'cloudfront:TagResource'],
        resources: ['*'],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': [PROJECT_TAG, STAGE_TAG],
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'CreateTaggedStageCloudFrontFunction',
        actions: ['cloudfront:CreateFunction', 'cloudfront:TagResource'],
        resources: ['*'],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': [PROJECT_TAG, STAGE_TAG],
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageNamedStageCloudFrontFunction',
        actions: [
          'cloudfront:DeleteFunction',
          'cloudfront:DescribeFunction',
          'cloudfront:GetFunction',
          'cloudfront:ListTagsForResource',
          'cloudfront:PublishFunction',
          'cloudfront:TagResource',
          'cloudfront:UntagResource',
          'cloudfront:UpdateFunction',
        ],
        resources: [
          resourceArn(stack, 'cloudfront', 'function', `roadmap2u-${stage}-request-router`, {
            region: '',
          }),
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyTaggedStageDistributions',
        actions: [
          'cloudfront:DeleteDistribution',
          'cloudfront:GetDistribution',
          'cloudfront:GetDistributionConfig',
          'cloudfront:ListTagsForResource',
          'cloudfront:TagResource',
          'cloudfront:UntagResource',
          'cloudfront:UpdateDistribution',
        ],
        resources: [resourceArn(stack, 'cloudfront', 'distribution', '*', { region: '' })],
        conditions: stageTagConditions(stage),
      }),
      ...certificateStatements(stack, stage),
      route53Statement(stack, stage, hostedZoneId, 'edge'),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageHostingParameters',
        actions: [
          'ssm:AddTagsToResource',
          'ssm:DeleteParameter',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:ListTagsForResource',
          'ssm:PutParameter',
          'ssm:RemoveTagsFromResource',
        ],
        resources: ['frontend-bucket', 'cloudfront-distribution-id', 'frontend-url'].map((name) =>
          resourceArn(stack, 'ssm', 'parameter', `roadmap2u/${stage}/${name}`),
        ),
      }),
    ],
  });
}

function createCommercialAccessPolicy(stack: Stack, stage: PolicyStage): iam.ManagedPolicy {
  const standardFunctionActions = [
    'lambda:AddPermission',
    'lambda:CreateFunction',
    'lambda:DeleteFunction',
    'lambda:GetFunction',
    'lambda:GetFunctionCodeSigningConfig',
    'lambda:GetFunctionConfiguration',
    'lambda:GetFunctionRecursionConfig',
    'lambda:GetFunctionScalingConfig',
    'lambda:GetPolicy',
    'lambda:GetRuntimeManagementConfig',
    'lambda:ListTags',
    'lambda:RemovePermission',
    'lambda:TagResource',
    'lambda:UntagResource',
    'lambda:UpdateFunctionCode',
    'lambda:UpdateFunctionConfiguration',
  ];
  return new iam.ManagedPolicy(stack, `CfnCommercialAccessPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-commercial-access`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation sponsored-access permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'ManageOnlyAccessCodeRedeemerFunction',
        actions: standardFunctionActions,
        resources: [functionArn(stack, stage, 'access-code-redeemer')],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlySponsoredAccessBrokerFunctionUrl',
        actions: [
          ...standardFunctionActions,
          'lambda:CreateFunctionUrlConfig',
          'lambda:DeleteFunctionUrlConfig',
          'lambda:GetFunctionUrlConfig',
          'lambda:UpdateFunctionUrlConfig',
        ],
        resources: [functionArn(stack, stage, 'sponsored-access-broker')],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlySponsoredAccessLogGroups',
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:TagResource',
        ],
        resources: [
          `${accessCodeRedeemerLogGroupArn(stack, stage)}:*`,
          `${sponsoredAccessBrokerLogGroupArn(stack, stage)}:*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlySponsoredAccessLogGroupTags',
        actions: ['logs:ListTagsForResource', 'logs:TagResource', 'logs:UntagResource'],
        resources: [
          accessCodeRedeemerLogGroupArn(stack, stage),
          sponsoredAccessBrokerLogGroupArn(stack, stage),
        ],
      }),
    ],
  });
}

function createObservabilityPolicy(stack: Stack, stage: PolicyStage): iam.ManagedPolicy {
  const topicArn = commercialAlarmTopicArn(stack, stage);
  const inventoryBoundary = policyArn(
    stack,
    stage,
    `roadmap2u-${stage}-inventory-runtime-boundary`,
  );
  const inventoryRoleArn = resourceArn(
    stack,
    'iam',
    'role',
    `roadmap2u/${stage}/runtime/roadmap-commercial-inventory-executor-${stage}`,
    { region: '' },
  );
  const inventoryRoleNameArn = commercialInventoryExecutorRoleNameArn(stack, stage);
  const topicActions = [
    'sns:CreateTopic',
    'sns:GetTopicAttributes',
    'sns:ListTagsForResource',
    'sns:SetTopicAttributes',
    'sns:TagResource',
    'sns:UntagResource',
    ...(stage === 'prod' ? [] : ['sns:DeleteTopic']),
  ];
  const alarmActions = [
    'cloudwatch:DescribeAlarms',
    'cloudwatch:ListTagsForResource',
    'cloudwatch:PutMetricAlarm',
    'cloudwatch:TagResource',
    'cloudwatch:UntagResource',
    'cloudwatch:DeleteAlarms',
  ];

  return new iam.ManagedPolicy(stack, `CfnObservabilityPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-observability`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation observability permissions for RoadMap2U ${stage}`,
    statements: [
      new iam.PolicyStatement({
        sid: 'CreateBoundedCommercialInventoryRole',
        actions: ['iam:CreateRole'],
        resources: [inventoryRoleArn],
        conditions: {
          StringEquals: {
            'iam:PermissionsBoundary': inventoryBoundary,
            'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
            'aws:RequestTag/roadmap2u-stage': stage,
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'SetCommercialInventoryRuntimeBoundary',
        actions: ['iam:PutRolePermissionsBoundary'],
        resources: [inventoryRoleArn, inventoryRoleNameArn],
        conditions: {
          StringEquals: { 'iam:PermissionsBoundary': inventoryBoundary },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyNamedCommercialInventoryRole',
        actions: [
          'iam:DeleteRole',
          'iam:DeleteRolePolicy',
          'iam:GetRole',
          'iam:GetRolePolicy',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
          'iam:ListRoleTags',
          'iam:PutRolePolicy',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:UpdateAssumeRolePolicy',
          'iam:UpdateRole',
          'iam:UpdateRoleDescription',
        ],
        resources: [inventoryRoleNameArn],
      }),
      new iam.PolicyStatement({
        sid: 'AttachOnlyLambdaBasicExecutionToNamedCommercialInventoryRole',
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [inventoryRoleNameArn],
        conditions: {
          StringEquals: {
            'iam:PolicyARN': `arn:${Aws.PARTITION}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
          },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialInventoryFunctionUrl',
        actions: [
          'lambda:AddPermission',
          'lambda:CreateFunction',
          'lambda:CreateFunctionUrlConfig',
          'lambda:DeleteFunction',
          'lambda:DeleteFunctionUrlConfig',
          'lambda:GetFunction',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:GetFunctionUrlConfig',
          'lambda:GetPolicy',
          'lambda:GetRuntimeManagementConfig',
          'lambda:ListTags',
          'lambda:RemovePermission',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:UpdateFunctionUrlConfig',
        ],
        resources: [functionArn(stack, stage, 'commercial-inventory-executor')],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialHttpFunctions',
        actions: [
          'lambda:AddPermission',
          'lambda:CreateFunction',
          'lambda:DeleteFunction',
          'lambda:GetFunction',
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:GetPolicy',
          'lambda:GetRuntimeManagementConfig',
          'lambda:ListTags',
          'lambda:RemovePermission',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
        ],
        resources: commercialHttpFunctionArns(stack, stage),
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialHttpLogGroups',
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:TagResource',
        ],
        resources: [
          ...commercialHttpLogArns(stack, stage),
          `${commercialInventoryExecutorLogGroupArn(stack, stage)}:*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialHttpLogGroupTags',
        actions: ['logs:ListTagsForResource', 'logs:TagResource', 'logs:UntagResource'],
        resources: [
          ...commercialHttpLogGroupArns(stack, stage),
          commercialInventoryExecutorLogGroupArn(stack, stage),
        ],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialAlarmTopic',
        actions: topicActions,
        resources: [topicArn],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialAlarmSubscriptions',
        actions: [
          'sns:GetSubscriptionAttributes',
          'sns:ListSubscriptionsByTopic',
          'sns:SetSubscriptionAttributes',
          'sns:Subscribe',
          'sns:Unsubscribe',
        ],
        resources: [topicArn, `${topicArn}:*`],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyCommercialAlarms',
        actions: alarmActions,
        resources: [commercialAlarmArn(stack, stage)],
      }),
    ],
  });
}

export function createStageManagedPolicies(
  stack: Stack,
  stage: PolicyStage,
  hostedZoneId: string,
): StageManagedPolicies {
  const runtimeBoundary = createRuntimeBoundary(stack, stage);
  const inventoryRuntimeBoundary = createInventoryRuntimeBoundary(stack, stage);
  const { core, api, data } = createCorePolicies(stack, stage, hostedZoneId);
  const commercialAccess = createCommercialAccessPolicy(stack, stage);
  const edge = createEdgePolicy(stack, stage, hostedZoneId);
  const observability = createObservabilityPolicy(stack, stage);
  return {
    core,
    api,
    data,
    commercialAccess,
    edge,
    observability,
    runtimeBoundary,
    inventoryRuntimeBoundary,
  };
}
