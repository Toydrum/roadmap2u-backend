import { Arn, ArnFormat, Aws, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export type PolicyStage = 'dev' | 'test' | 'prod';

export interface StageManagedPolicies {
  readonly core: iam.ManagedPolicy;
  readonly api: iam.ManagedPolicy;
  readonly data: iam.ManagedPolicy;
  readonly edge: iam.ManagedPolicy;
  readonly runtimeBoundary: iam.ManagedPolicy;
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

function functionArns(stack: Stack, stage: PolicyStage): string[] {
  return ['pre-signup', 'post-confirmation', 'router'].map((name) =>
    Arn.format(
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
    ),
  );
}

function lambdaLogGroupArns(stack: Stack, stage: PolicyStage): string[] {
  return ['pre-signup', 'post-confirmation', 'router'].map((name) =>
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

function apiLogGroupArn(stack: Stack, stage: PolicyStage): string {
  return Arn.format(
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
  );
}

function apiLogArn(stack: Stack, stage: PolicyStage): string {
  return `${apiLogGroupArn(stack, stage)}:*`;
}

function tableArns(stack: Stack, stage: PolicyStage): string[] {
  const table = resourceArn(stack, 'dynamodb', 'table', `roadmap-${stage}`);
  return [table, `${table}/index/*`];
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
      ? [
          certificateValidationName(ROOT_DOMAIN),
          certificateValidationName(`www.${ROOT_DOMAIN}`),
        ]
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
        resources: lambdaLogArns(stack, stage),
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
          'dynamodb:Scan',
          'dynamodb:UpdateItem',
        ],
        resources: tableArns(stack, stage),
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
        ],
        resources: [...lambdaLogArns(stack, stage), apiLogArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'ManageOnlyStageLogGroupTags',
        actions: ['logs:ListTagsForResource', 'logs:TagResource', 'logs:UntagResource'],
        resources: [...lambdaLogGroupArns(stack, stage), apiLogGroupArn(stack, stage)],
      }),
      new iam.PolicyStatement({
        sid: 'InspectLogGroupsForCloudFormation',
        actions: ['logs:DescribeLogGroups'],
        resources: ['*'],
      }),
    ],
  });

  const dataPolicy = new iam.ManagedPolicy(stack, `CfnDataPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-data`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation data-service permissions for RoadMap2U ${stage}`,
    statements: [
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
        resources: tableArns(stack, stage),
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
    ],
  });

  const apiPolicy = new iam.ManagedPolicy(stack, `CfnApiPolicy${stage}`, {
    managedPolicyName: `roadmap2u-${stage}-cfn-api`,
    path: `/roadmap2u/${stage}/`,
    description: `CloudFormation API-service permissions for RoadMap2U ${stage}`,
    statements: [
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
        conditions: stageTagConditions(stage),
      }),
      new iam.PolicyStatement({
        sid: 'CreateTaggedStageApiDomain',
        actions: ['apigateway:POST'],
        resources: [
          resourceArn(stack, 'apigateway', '/domainnames', undefined, { account: '' }),
        ],
        conditions: {
          ...requestTagConditions(stage),
          'ForAllValues:StringEquals': {
            'aws:TagKeys': CLOUDFORMATION_API_TAG_KEYS,
            'apigateway:Request/EndpointType': ['REGIONAL'],
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
          resourceArn(
            stack,
            'cloudfront',
            'function',
            `roadmap2u-${stage}-request-router`,
            { region: '' },
          ),
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
        resources: [
          'frontend-bucket',
          'cloudfront-distribution-id',
          'frontend-url',
        ].map((name) => resourceArn(stack, 'ssm', 'parameter', `roadmap2u/${stage}/${name}`)),
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
  const { core, api, data } = createCorePolicies(stack, stage, hostedZoneId);
  const edge = createEdgePolicy(stack, stage, hostedZoneId);
  return { core, api, data, edge, runtimeBoundary };
}
