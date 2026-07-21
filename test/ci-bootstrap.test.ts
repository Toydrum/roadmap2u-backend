import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import * as infrastructure from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const CiBootstrapStack = (infrastructure as unknown as Record<string, any>)[
  'RoadmapCiBootstrapStack'
];

function bootstrapTemplate(): Template {
  expect(CiBootstrapStack).toBeTypeOf('function');
  const app = new App();
  return Template.fromStack(
    new CiBootstrapStack(app, 'Roadmap-CiBootstrap', {
      env: { account: ACCOUNT, region: 'us-east-1' },
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      githubOwner: 'Toydrum',
      githubOwnerId: '61118847',
      backendRepository: 'roadmap2u-backend',
      backendRepositoryId: '1307128632',
      frontendRepository: 'RoadMap2U',
      frontendRepositoryId: '741787733',
      operationsPrincipalArn: `arn:aws:iam::${ACCOUNT}:user/Hector-admin`,
    }),
  );
}

describe('GitHub OIDC bootstrap', () => {
  it('reuses the existing GitHub provider and trusts immutable repo identities', () => {
    const template = bootstrapTemplate();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.resourceCountIs('AWS::IAM::Role', 12);

    const rendered = JSON.stringify(template.toJSON());
    for (const stage of ['dev', 'test', 'prod']) {
      expect(rendered).toContain(`roadmap2u-${stage}-backend-deploy`);
      expect(rendered).toContain(`roadmap2u-${stage}-frontend-deploy`);
      expect(rendered).toContain(
        `repo:Toydrum@61118847/roadmap2u-backend@1307128632:environment:${stage}`,
      );
      expect(rendered).toContain(
        `repo:Toydrum@61118847/RoadMap2U@741787733:environment:${stage}`,
      );
      expect(template.toJSON().Outputs).toHaveProperty(`${stage}BackendRoleArn`);
      expect(template.toJSON().Outputs).toHaveProperty(`${stage}FrontendRoleArn`);
    }
    expect(rendered).not.toContain('AdministratorAccess');
    expect(rendered).toContain('roadmap2u-prod-dns-plan');
    expect(rendered).toContain('roadmap2u-prod-dns-cutover');
    expect(template.toJSON().Outputs).toHaveProperty('prodDnsPlanRoleArn');
    expect(rendered).toContain(
      'repo:Toydrum@61118847/roadmap2u-backend@1307128632:environment:prod-dns-cutover',
    );
    expect(template.toJSON().Outputs).toHaveProperty('prodDnsCutoverRoleArn');
    expect(rendered).toContain('cloudfront:GetDistribution');
    expect(rendered).toContain('acm:DescribeCertificate');
    expect(rendered).toContain('route53:ChangeResourceRecordSets');
    expect(rendered).toContain('route53:GetChange');
    expect(rendered).toContain('/roadmap2u/prod/dns-cutover-backup');
  });

  it('creates an MFA-only break-glass role that can delete only dev/test workload stacks', () => {
    const rendered = bootstrapTemplate().toJSON();
    const role = Object.values(rendered.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Role' &&
        resource.Properties.RoleName === 'roadmap2u-nonprod-break-glass',
    ) as any;
    const policy = Object.values(rendered.Resources).find(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Policy' &&
        resource.Properties.PolicyName === 'NonProdBreakGlassPolicy',
    ) as any;

    expect(role).toBeDefined();
    expect(role.Properties.Path).toBe('/roadmap2u/operations/');
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
      `arn:aws:iam::${ACCOUNT}:user/Hector-admin`,
    );
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
      'aws:MultiFactorAuthPresent',
    );
    expect(policy).toBeDefined();
    const statement = policy.Properties.PolicyDocument.Statement[0];
    expect(statement.Action).toEqual([
      'cloudformation:DeleteStack',
      'cloudformation:DescribeStackEvents',
      'cloudformation:DescribeStacks',
    ]);
    const resources = JSON.stringify(statement.Resource);
    for (const stage of ['dev', 'test']) {
      expect(resources).toContain(`stack/Roadmap-${stage}-Backend/*`);
      expect(resources).toContain(`stack/Roadmap-${stage}-Hosting/*`);
    }
    expect(resources).not.toContain('Roadmap-prod-');
    expect(JSON.stringify(policy)).not.toContain('iam:PassRole');
    const bucketAccess = policy.Properties.PolicyDocument.Statement.find(
      (candidate: any) => candidate.Sid === 'ListOnlyNonProdHostingVersions',
    );
    const objectAccess = policy.Properties.PolicyDocument.Statement.find(
      (candidate: any) => candidate.Sid === 'DeleteOnlyNonProdHostingVersions',
    );
    expect(bucketAccess.Action).toEqual([
      's3:GetBucketLocation',
      's3:ListBucket',
      's3:ListBucketVersions',
    ]);
    expect(objectAccess.Action).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion']);
    for (const stage of ['dev', 'test']) {
      expect(JSON.stringify(bucketAccess.Resource)).toContain(`roadmap2u-${stage}-${ACCOUNT}`);
      expect(JSON.stringify(objectAccess.Resource)).toContain(`roadmap2u-${stage}-${ACCOUNT}/*`);
    }
    expect(JSON.stringify([bucketAccess, objectAccess])).not.toContain('roadmap2u-prod-');
    expect(rendered.Outputs).toHaveProperty('nonProdBreakGlassRoleArn');
  });

  it('creates one stage-scoped MFA smoke cleanup role without infrastructure mutation', () => {
    const rendered = bootstrapTemplate().toJSON();
    for (const stage of ['dev', 'test', 'prod']) {
      const role = Object.values(rendered.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::IAM::Role' &&
          resource.Properties.RoleName === `roadmap2u-${stage}-smoke-cleanup`,
      ) as any;
      const policy = Object.values(rendered.Resources).find(
        (resource: any) =>
          resource.Type === 'AWS::IAM::Policy' &&
          resource.Properties.PolicyName === `SmokeCleanupPolicy-${stage}`,
      ) as any;

      expect(role).toBeDefined();
      expect(role.Properties.Path).toBe(`/roadmap2u/${stage}/operations/`);
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
        `arn:aws:iam::${ACCOUNT}:user/Hector-admin`,
      );
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
        'aws:MultiFactorAuthPresent',
      );
      expect(policy).toBeDefined();
      const statements = policy.Properties.PolicyDocument.Statement;
      const cognito = statements.find((statement: any) =>
        JSON.stringify(statement.Action).includes('cognito-idp:AdminDeleteUser'),
      );
      const dynamo = statements.find((statement: any) =>
        JSON.stringify(statement.Action).includes('dynamodb:DeleteItem'),
      );
      expect(cognito.Action).toEqual([
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser',
      ]);
      expect(dynamo.Action).toEqual(['dynamodb:DeleteItem', 'dynamodb:Query']);
      expect(JSON.stringify(statements)).not.toContain('dynamodb:BatchWriteItem');
      const policyJson = JSON.stringify(statements);
      expect(policyJson).toContain(`table/roadmap-${stage}`);
      expect(policyJson).toContain(`/roadmap2u/${stage}/user-pool-id`);
      for (const other of ['dev', 'test', 'prod'].filter((value) => value !== stage)) {
        expect(policyJson).not.toContain(`table/roadmap-${other}`);
        expect(policyJson).not.toContain(`/roadmap2u/${other}/user-pool-id`);
      }
      expect(policyJson).not.toContain('table/*');
      expect(policyJson).not.toMatch(/dynamodb:(CreateTable|UpdateTable|DeleteTable)/);
      expect(policyJson).not.toContain('cloudformation:');
      expect(policyJson).toContain('aws:ResourceTag/roadmap2u-project');
      expect(policyJson).toContain('RoadMap2U');
      expect(rendered.Outputs).toHaveProperty(`${stage}SmokeCleanupRoleArn`);
    }
  });

  it('uses a bootstrapless synthesizer for the control-plane stack', () => {
    expect(infrastructure.createCiBootstrapSynthesizer).toBeTypeOf('function');
    expect(infrastructure.createCiBootstrapSynthesizer()).toBeInstanceOf(
      BootstraplessSynthesizer,
    );
  });

  it('selects the stage-specific CDK bootstrap roles and version parameter', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());
    const qualifiers = {
      dev: 'rmap2udev',
      test: 'rmap2utst',
      prod: 'rmap2uprd',
    } as const;

    for (const [stage, qualifier] of Object.entries(qualifiers)) {
      for (const purpose of ['deploy', 'file-publishing']) {
        expect(rendered).toContain(`cdk-${qualifier}-${purpose}-role-${ACCOUNT}-us-east-1`);
      }
      expect(rendered).not.toContain(`cdk-${qualifier}-image-publishing-role-${ACCOUNT}-us-east-1`);
      expect(rendered).not.toContain(`cdk-${qualifier}-lookup-role-${ACCOUNT}-us-east-1`);
      expect(rendered).not.toContain(`cdk-${qualifier}-cfn-exec-role-${ACCOUNT}-us-east-1`);
      expect(rendered).toContain(`/cdk-bootstrap/${qualifier}/version`);
      expect(infrastructure.bootstrapQualifierFor(stage as keyof typeof qualifiers)).toBe(
        qualifier,
      );
    }
    expect(rendered).not.toContain(`cdk-hnb659fds-deploy-role-${ACCOUNT}-us-east-1`);
  });

  it('creates stage-scoped execution policies and runtime permission boundaries', () => {
    const template = bootstrapTemplate().toJSON();
    const managedPolicies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    expect(managedPolicies).toHaveLength(15);
    expect(new Set(managedPolicies.map((policy) => policy.Properties.ManagedPolicyName)).size).toBe(
      15,
    );
    for (const stage of ['dev', 'test', 'prod']) {
      const stagePolicies = managedPolicies.filter(
        (policy) => policy.Properties.Path === `/roadmap2u/${stage}/`,
      );
      expect(stagePolicies.map((policy) => policy.Properties.ManagedPolicyName).sort()).toEqual([
        `roadmap2u-${stage}-cfn-api`,
        `roadmap2u-${stage}-cfn-core`,
        `roadmap2u-${stage}-cfn-data`,
        `roadmap2u-${stage}-cfn-edge`,
        `roadmap2u-${stage}-runtime-boundary`,
      ]);

      const serialized = JSON.stringify(stagePolicies);
      expect(serialized).toContain(`/roadmap2u/${stage}/`);
      expect(serialized).toContain(`/roadmap2u/${stage}/runtime/*`);
      expect(serialized).toContain(`roadmap-${stage}`);
      expect(serialized).toContain(`roadmap2u-stage`);
      expect(serialized).not.toContain('AdministratorAccess');
      expect(serialized).not.toMatch(/ses:\*/i);

      const core = stagePolicies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-core`,
      );
      const statements = core.Properties.PolicyDocument.Statement;
      const genericRoleManagement = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageRuntimeRoles',
      );
      const boundaryManagement = statements.find(
        (statement: any) => statement.Sid === 'SetOnlyStageRuntimeBoundary',
      );
      expect(genericRoleManagement.Action).not.toContain('iam:PutRolePermissionsBoundary');
      expect(boundaryManagement.Action).toBe('iam:PutRolePermissionsBoundary');
      expect(boundaryManagement.Condition.StringEquals['iam:PermissionsBoundary']).toEqual(
        expect.objectContaining({ 'Fn::Join': expect.any(Array) }),
      );
      expect(JSON.stringify(boundaryManagement.Condition)).toContain(
        `/roadmap2u/${stage}/roadmap2u-${stage}-runtime-boundary`,
      );
      for (const sid of [
        'CreateBoundedStageRuntimeRoles',
        'ManageOnlyStageRuntimeRoles',
        'SetOnlyStageRuntimeBoundary',
        'AttachOnlyLambdaBasicExecution',
        'PassOnlyStageRuntimeRolesToLambda',
      ]) {
        const statement = statements.find((candidate: any) => candidate.Sid === sid);
        expect(JSON.stringify(statement.Resource)).toContain(
          `:role/roadmap2u/${stage}/runtime/*`,
        );
        expect(JSON.stringify(statement.Resource)).not.toContain(
          `roadmap2u-${stage}-backend-deploy`,
        );
      }
    }

    const prodActions = managedPolicies
      .filter((policy) => policy.Properties.Path === '/roadmap2u/prod/')
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement: any) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );
    expect(prodActions).not.toContain('s3:DeleteBucket');
    expect(prodActions).not.toContain('dynamodb:DeleteTable');
    expect(prodActions).not.toContain('cognito-idp:DeleteUserPool');
  });

  it('keeps policy-size headroom below the IAM 6144-character limit', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];
    for (const policy of policies) {
      expect(
        JSON.stringify(policy.Properties.PolicyDocument).length,
        policy.Properties.ManagedPolicyName,
      ).toBeLessThanOrEqual(6000);
    }
  });

  it('preserves immutable descriptions on stage-named managed policies', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const data = policies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-data`,
      );
      expect(data.Properties.Description).toBe(
        `CloudFormation data-service permissions for RoadMap2U ${stage}`,
      );
    }
  });

  it('keeps Cognito lifecycle permissions in the attached data policy to preserve API policy headroom', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const api = policies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-api`,
      );
      const data = policies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-data`,
      );
      const apiStatements = api.Properties.PolicyDocument.Statement;
      const dataStatements = data.Properties.PolicyDocument.Statement;

      expect(
        dataStatements.find((statement: any) => statement.Sid === 'CreateOnlyTaggedStageUserPools'),
      ).toBeDefined();
      expect(
        dataStatements.find((statement: any) => statement.Sid === 'ManageOnlyTaggedStageUserPools'),
      ).toBeDefined();
      expect(
        apiStatements.some((statement: any) => statement.Sid.includes('StageUserPools')),
      ).toBe(false);
    }
  });

  it('uses valid CloudWatch Logs ARN formatting in stage policies', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());
    expect(rendered).toContain(':log-group:/aws/lambda/roadmap-');
    expect(rendered).not.toContain(':log-group//aws/');
  });

  it('keeps account policy mutation out of stage roles after toolkit log bootstrap', () => {
    const managedPolicies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];
    const expectedActions = [
      'logs:CreateLogDelivery',
      'logs:DeleteLogDelivery',
      'logs:DescribeResourcePolicies',
      'logs:GetLogDelivery',
      'logs:ListLogDeliveries',
      'logs:UpdateLogDelivery',
    ];
    const expectedStatement = {
      Action: expectedActions,
      Condition: {
        StringEquals: {
          'aws:RequestedRegion': 'us-east-1',
        },
      },
      Effect: 'Allow',
      Resource: '*',
      Sid: 'ManageHttpApiAccessLogDelivery',
    };

    for (const stage of ['dev', 'test', 'prod']) {
      const stagePolicies = managedPolicies.filter(
        (policy) => policy.Properties.Path === `/roadmap2u/${stage}/`,
      );
      const allStatements = stagePolicies.flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement,
      );
      const matchingStatements = allStatements.filter((statement: any) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some(
          (action: string) => expectedActions.includes(action),
        ),
      );
      const allActions = allStatements.flatMap((statement: any) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );
      const apiPolicy = stagePolicies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-api`,
      );
      const dataPolicy = stagePolicies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-data`,
      );

      for (const forbiddenAction of [
        'logs:*',
        'logs:DeleteAccountPolicy',
        'logs:DeleteResourcePolicy',
        'logs:PutAccountPolicy',
        'logs:PutResourcePolicy',
      ]) {
        expect(allActions).not.toContain(forbiddenAction);
      }
      expect(
        dataPolicy.Properties.PolicyDocument.Statement.find(
          (statement: any) => statement.Sid === 'ManageHttpApiAccessLogDelivery',
        ),
      ).toEqual(expectedStatement);
      expect(
        apiPolicy.Properties.PolicyDocument.Statement.find(
          (statement: any) => statement.Sid === 'ManageHttpApiAccessLogDelivery',
        ),
      ).toBeUndefined();
      expect(matchingStatements).toEqual([expectedStatement]);
    }
  });

  it('allows both CloudFormation log-tag ARN forms while every mutation stays stage-scoped', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::ManagedPolicy' &&
        resource.Properties.ManagedPolicyName.endsWith('-cfn-core'),
    ) as any[];
    for (const policy of policies) {
      const stage = policy.Properties.ManagedPolicyName.match(
        /^roadmap2u-(dev|test|prod)-cfn-core$/,
      )?.[1];
      expect(stage).toBeDefined();
      const statements = policy.Properties.PolicyDocument.Statement;
      const discovery = statements.find(
        (statement: any) => statement.Sid === 'InspectLogGroupsForCloudFormation',
      );
      const mutation = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageLogGroups',
      );
      const tagging = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageLogGroupTags',
      );
      expect(discovery).toMatchObject({
        Action: 'logs:DescribeLogGroups',
        Effect: 'Allow',
        Resource: '*',
      });
      expect(mutation.Action).not.toContain('logs:DescribeLogGroups');
      expect(mutation.Action).toEqual([
        'logs:CreateLogGroup',
        'logs:DeleteLogGroup',
        'logs:PutRetentionPolicy',
        'logs:TagResource',
      ]);
      expect(mutation.Resource).toHaveLength(3);
      expect(mutation.Resource).not.toContain('*');
      expect(tagging.Action).toEqual([
        'logs:ListTagsForResource',
        'logs:TagResource',
        'logs:UntagResource',
      ]);
      expect(tagging.Resource).toHaveLength(3);
      expect(tagging.Resource).not.toContain('*');

      const mutationResources = JSON.stringify(mutation.Resource);
      const taggingResources = JSON.stringify(tagging.Resource);
      for (const logGroupName of [
        `/aws/lambda/roadmap-pre-signup-${stage}`,
        `/aws/lambda/roadmap-post-confirmation-${stage}`,
        `/aws/lambda/roadmap-router-${stage}`,
      ]) {
        expect(mutationResources).toContain(`${logGroupName}:*`);
        expect(taggingResources).toContain(logGroupName);
        expect(taggingResources).not.toContain(`${logGroupName}:*`);
      }
      expect(mutationResources).not.toContain('/aws/apigateway/');
      expect(taggingResources).not.toContain('/aws/apigateway/');
      for (const otherStage of ['dev', 'test', 'prod'].filter((value) => value !== stage)) {
        expect(mutationResources).not.toContain(`-${otherStage}:*`);
        expect(taggingResources).not.toContain(`-${otherStage}`);
      }
    }
  });

  it('uses valid Lambda function ARNs in stage execution policies', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());
    expect(rendered).toContain(':function:roadmap-pre-signup-');
    expect(rendered).toContain(':function:roadmap-post-confirmation-');
    expect(rendered).toContain(':function:roadmap-router-');
    expect(rendered).not.toContain(':function/roadmap-');
  });

  it('lets CloudFormation read only the selected stage Lambda asset objects', () => {
    const template = bootstrapTemplate().toJSON();
    const qualifiers = { dev: 'rmap2udev', test: 'rmap2utst', prod: 'rmap2uprd' } as const;
    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const [stage, qualifier] of Object.entries(qualifiers)) {
      const core = policies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-core`,
      );
      const statement = core.Properties.PolicyDocument.Statement.find(
        (candidate: any) => candidate.Sid === 'ReadOnlyStageLambdaAssets',
      );
      expect(statement.Action).toEqual(['s3:GetObject', 's3:GetObjectVersion']);
      expect(JSON.stringify(statement.Resource)).toContain(
        `cdk-${qualifier}-assets-${ACCOUNT}-us-east-1/*`,
      );
      for (const other of Object.values(qualifiers).filter((value) => value !== qualifier)) {
        expect(JSON.stringify(statement.Resource)).not.toContain(`cdk-${other}-assets-`);
      }
    }
  });

  it('lets CloudFormation resolve only its selected toolkit bootstrap version', () => {
    const template = bootstrapTemplate().toJSON();
    const qualifiers = { dev: 'rmap2udev', test: 'rmap2utst', prod: 'rmap2uprd' } as const;
    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const [stage, qualifier] of Object.entries(qualifiers)) {
      const core = policies.find(
        (policy) => policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-core`,
      );
      const statement = core.Properties.PolicyDocument.Statement.find(
        (candidate: any) => candidate.Sid === 'ReadOnlySelectedBootstrapVersion',
      );

      expect(statement).toEqual({
        Action: 'ssm:GetParameters',
        Effect: 'Allow',
        Resource: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              `:ssm:us-east-1:${ACCOUNT}:parameter/cdk-bootstrap/${qualifier}/version`,
            ],
          ],
        },
        Sid: 'ReadOnlySelectedBootstrapVersion',
      });
      for (const other of Object.values(qualifiers).filter((value) => value !== qualifier)) {
        expect(JSON.stringify(statement.Resource)).not.toContain(`/cdk-bootstrap/${other}/`);
      }
    }
  });

  it('limits Route 53 and IAM mutations to the selected stage', () => {
    const managedPolicies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];
    const byStage = (stage: string) =>
      JSON.stringify(
        managedPolicies.filter((policy) => policy.Properties.Path === `/roadmap2u/${stage}/`),
      );

    expect(byStage('dev')).toContain('api.dev.roadmap2u.com');
    expect(byStage('dev')).toContain('dev.roadmap2u.com');
    expect(byStage('test')).toContain('api.test.roadmap2u.com');
    expect(byStage('test')).toContain('test.roadmap2u.com');

    const prodPolicies = managedPolicies.filter(
      (policy) => policy.Properties.Path === '/roadmap2u/prod/',
    );
    const prod = JSON.stringify(prodPolicies);
    const prodRoute53Names = prodPolicies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => statement.Action === 'route53:ChangeResourceRecordSets')
      .flatMap(
        (statement: any) =>
          statement.Condition['ForAllValues:StringLike'][
            'route53:ChangeResourceRecordSetsNormalizedRecordNames'
          ],
      );
    expect(prod).toContain('api.roadmap2u.com');
    expect(prodRoute53Names).not.toContain('roadmap2u.com');
    expect(prodRoute53Names).not.toContain('www.roadmap2u.com');
    expect(prod).toContain('iam:PermissionsBoundary');
    expect(prod).not.toContain('iam:DeleteRolePermissionsBoundary');
  });

  it('lets workload stacks manage only their declared public SSM parameters', () => {
    const managedPolicies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const statements = managedPolicies
        .filter((policy) => policy.Properties.Path === `/roadmap2u/${stage}/`)
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      const core = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageParameters',
      );
      const edge = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageHostingParameters',
      );
      const coreResources = JSON.stringify(core.Resource);
      const edgeResources = JSON.stringify(edge.Resource);

      for (const name of [
        'region',
        'user-pool-id',
        'user-pool-client-id',
        'api-base-url',
        'contract-hash',
      ]) {
        expect(coreResources).toContain(`/roadmap2u/${stage}/${name}`);
      }
      for (const name of [
        'frontend-bucket',
        'cloudfront-distribution-id',
        'frontend-url',
      ]) {
        expect(edgeResources).toContain(`/roadmap2u/${stage}/${name}`);
      }
      const combined = `${coreResources}${edgeResources}`;
      expect(combined).not.toContain(`/roadmap2u/${stage}/*`);
      expect(combined).not.toContain('release');
      expect(combined).not.toContain('dns-cutover-backup');
      for (const statement of [core, edge]) {
        expect(statement.Action).toEqual(
          expect.arrayContaining([
            'ssm:GetParameters',
            'ssm:ListTagsForResource',
            'ssm:RemoveTagsFromResource',
          ]),
        );
      }
    }
  });

  it('includes the exact CloudFormation registry read actions for Lambda and DynamoDB', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const byName = (suffix: string) =>
        policies.find(
          (policy) =>
            policy.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-${suffix}`,
        );
      const functionStatement = byName('core').Properties.PolicyDocument.Statement.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageFunctions',
      );
      expect(functionStatement.Action).toEqual(
        expect.arrayContaining([
          'lambda:GetFunctionCodeSigningConfig',
          'lambda:GetFunctionRecursionConfig',
          'lambda:GetFunctionScalingConfig',
          'lambda:GetPolicy',
          'lambda:GetRuntimeManagementConfig',
        ]),
      );
      expect(JSON.stringify(functionStatement.Resource)).toContain(`function:roadmap-router-${stage}`);

      const tableStatement = byName('data').Properties.PolicyDocument.Statement.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageTable',
      );
      expect(tableStatement.Action).toEqual(
        expect.arrayContaining([
          'dynamodb:DescribeContributorInsights',
          'dynamodb:DescribeKinesisStreamingDestination',
          'dynamodb:GetResourcePolicy',
        ]),
      );
      expect(JSON.stringify(tableStatement.Resource)).toContain(`table/roadmap-${stage}`);
    }
  });

  it('uses API Gateway request and resource tags to prevent cross-stage API mutation', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::ManagedPolicy' &&
        resource.Properties.ManagedPolicyName.endsWith('-cfn-api'),
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const policy = policies.find(
        (candidate) => candidate.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-api`,
      );
      const statements = policy.Properties.PolicyDocument.Statement;
      const createApi = statements.find(
        (statement: any) => statement.Sid === 'CreateTaggedStageHttpApi',
      );
      const createDomain = statements.find(
        (statement: any) => statement.Sid === 'CreateTaggedStageApiDomain',
      );
      const manageApi = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyTaggedStageHttpApi',
      );
      const domain = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageApiDomain',
      );
      const initialDomainTag = statements.find(
        (statement: any) => statement.Sid === 'TagOnlyCreatingStageApiDomain',
      );
      const initialStageTag = statements.find(
        (statement: any) => statement.Sid === 'TagOnlyCreatingStageApiStage',
      );

      expect(createApi.Action).toBe('apigateway:POST');
      expect(createApi.Condition.StringEquals).toMatchObject({
        'apigateway:Request/ApiName': `roadmap-api-${stage}`,
        'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
        'aws:RequestTag/roadmap2u-stage': stage,
      });
      const cloudFormationApiTagKeys = [
        'roadmap2u-project',
        'roadmap2u-stage',
        'aws:cloudformation:logical-id',
        'aws:cloudformation:stack-id',
        'aws:cloudformation:stack-name',
      ];
      expect(createApi.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(
        cloudFormationApiTagKeys,
      );
      expect(createDomain.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(
        cloudFormationApiTagKeys,
      );
      expect(createDomain.Condition['ForAllValues:StringEquals'][
        'apigateway:Request/EndpointType'
      ]).toEqual(['REGIONAL']);
      expect(initialDomainTag).toBeDefined();
      const expectedDomain =
        stage === 'prod' ? 'api.roadmap2u.com' : `api.${stage}.roadmap2u.com`;
      const encodedDomainTagResource = JSON.stringify(initialDomainTag.Resource);
      expect(initialDomainTag.Action).toBe('apigateway:PUT');
      expect(encodedDomainTagResource).toContain(':apigateway:us-east-1::/tags/arn%3A');
      expect(encodedDomainTagResource).toContain(
        `%3Aapigateway%3Aus-east-1%3A%3A%2Fdomainnames%2F${expectedDomain}`,
      );
      expect(encodedDomainTagResource).not.toContain('/tags/*');
      expect(initialDomainTag.Condition.StringEquals).toEqual({
        'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
        'aws:RequestTag/roadmap2u-stage': stage,
      });
      expect(initialDomainTag.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(
        cloudFormationApiTagKeys,
      );
      expect(initialDomainTag.Condition.Null).toEqual({ 'aws:TagKeys': 'false' });
      expect(JSON.stringify(initialDomainTag.Condition)).not.toContain('aws:ResourceTag');
      expect(initialStageTag).toBeDefined();
      expect(initialStageTag.Action).toBe('apigateway:TagResource');
      expect(JSON.stringify(initialStageTag.Resource)).toContain(
        ':apigateway:us-east-1::/apis/*/stages',
      );
      expect(JSON.stringify(initialStageTag.Resource)).not.toContain('/tags/*');
      expect(initialStageTag.Condition.StringEquals).toEqual({
        'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
        'aws:RequestTag/roadmap2u-stage': stage,
      });
      expect(JSON.stringify(initialStageTag.Condition)).not.toContain('aws:ResourceTag');
      expect(initialStageTag.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual(
        cloudFormationApiTagKeys,
      );
      expect(initialStageTag.Condition.Null).toEqual({ 'aws:TagKeys': 'false' });
      const literalStageTagStatements = statements.filter((statement: any) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
          'apigateway:TagResource',
        ),
      );
      expect(literalStageTagStatements).toEqual([initialStageTag]);
      expect(manageApi.Condition.StringEquals).toMatchObject({
        'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
        'aws:ResourceTag/roadmap2u-stage': stage,
      });
      expect(
        JSON.stringify(
          manageApi.Condition.StringEqualsIfExists[
            'apigateway:Request/AccessLoggingDestination'
          ],
        ),
      ).toContain(`:log-group:/aws/apigateway/roadmap-api-${stage}:*`);
      expect(manageApi.Action).not.toEqual(
        expect.arrayContaining(['apigateway:TagResource', 'apigateway:UntagResource']),
      );
      expect(JSON.stringify(manageApi.Resource)).toContain(':apigateway:us-east-1::/apis/*');
      expect(JSON.stringify(domain.Resource)).toContain(
        stage === 'prod' ? '/domainnames/api.roadmap2u.com' : `/domainnames/api.${stage}.roadmap2u.com`,
      );
      const conditionlessApiMutation = statements.find(
        (statement: any) =>
          JSON.stringify(statement.Resource).includes('/apis/*') &&
          JSON.stringify(statement.Action).match(/apigateway:(DELETE|PATCH|POST|PUT)/) &&
          !statement.Condition,
      );
      expect(conditionlessApiMutation).toBeUndefined();
    }
  });

  it('scopes taggable CloudFront distributions separately from opaque edge resources', () => {
    const managedPolicies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::ManagedPolicy' &&
        resource.Properties.ManagedPolicyName === 'roadmap2u-dev-cfn-edge' &&
        resource.Properties.Path === '/roadmap2u/dev/',
    ) as any[];
    const statements = managedPolicies[0].Properties.PolicyDocument.Statement;
    const distributionCreate = statements.find(
      (statement: any) => statement.Sid === 'CreateTaggedStageDistribution',
    );
    const functionCreate = statements.find(
      (statement: any) => statement.Sid === 'CreateTaggedStageCloudFrontFunction',
    );
    const functionManage = statements.find(
      (statement: any) => statement.Sid === 'ManageNamedStageCloudFrontFunction',
    );

    expect(distributionCreate.Action).toEqual([
      'cloudfront:CreateDistribution',
      'cloudfront:TagResource',
    ]);
    expect(distributionCreate.Condition.StringEquals).toMatchObject({
      'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
      'aws:RequestTag/roadmap2u-stage': 'dev',
    });
    expect(distributionCreate.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
      'roadmap2u-project',
      'roadmap2u-stage',
    ]);
    expect(functionCreate).toMatchObject({
      Action: ['cloudfront:CreateFunction', 'cloudfront:TagResource'],
      Resource: '*',
    });
    expect(functionCreate.Condition.StringEquals).toMatchObject({
      'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
      'aws:RequestTag/roadmap2u-stage': 'dev',
    });
    expect(functionCreate.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
      'roadmap2u-project',
      'roadmap2u-stage',
    ]);
    expect(JSON.stringify(statements)).not.toMatch(
      /cloudfront:(Create|Get|Update|Delete)(OriginAccessControl|ResponseHeadersPolicy)/,
    );
    expect(JSON.stringify(functionManage.Resource)).toContain(
      ':cloudfront::123456789012:function/roadmap2u-dev-request-router',
    );
    expect(functionManage.Action).not.toContain('cloudfront:CreateFunction');
    expect(functionManage.Action).toEqual(
      expect.arrayContaining([
        'cloudfront:ListTagsForResource',
        'cloudfront:TagResource',
        'cloudfront:UntagResource',
      ]),
    );
    const distributionManage = statements.find(
      (statement: any) => statement.Sid === 'ManageOnlyTaggedStageDistributions',
    );
    expect(distributionManage.Action).toContain('cloudfront:ListTagsForResource');
  });

  it('uses IAM action names exercised by CloudFormation for API Gateway and S3', () => {
    const template = bootstrapTemplate().toJSON();
    const rendered = JSON.stringify(template);
    expect(rendered).toContain('apigateway:TagResource');
    expect(rendered).not.toContain('apigateway:UntagResource');
    expect(rendered).not.toContain('s3:GetBucketEncryption');
    expect(rendered).not.toContain('s3:PutBucketEncryption');
    expect(rendered).toContain('s3:GetEncryptionConfiguration');
    expect(rendered).toContain('s3:PutEncryptionConfiguration');
    expect(rendered).toContain(':apigateway:us-east-1::/tags/*');
    const edgePolicies = Object.values(template.Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::ManagedPolicy' &&
        resource.Properties.ManagedPolicyName.endsWith('-cfn-edge'),
    ) as any[];
    for (const policy of edgePolicies) {
      const bucket = policy.Properties.PolicyDocument.Statement.find(
        (statement: any) => statement.Sid === 'ManageOnlyStageHostingBucket',
      );
      expect(bucket.Action).toEqual(
        expect.arrayContaining(['s3:GetBucketAcl', 's3:ListBucket']),
      );
    }
  });

  it('requests only public DNS certificates for stage domains and safely bootstraps their tags', () => {
    const policies = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::ManagedPolicy',
    ) as any[];
    for (const policy of policies.filter((candidate) =>
      candidate.Properties.PolicyDocument.Statement.some(
        (statement: any) => statement.Sid === 'RequestOnlyStageCertificates',
      ),
    )) {
      const stage = policy.Properties.ManagedPolicyName.includes('-dev-')
        ? 'dev'
        : policy.Properties.ManagedPolicyName.includes('-test-')
          ? 'test'
          : 'prod';
      const statements = policy.Properties.PolicyDocument.Statement;
      const request = statements.find(
        (statement: any) => statement.Sid === 'RequestOnlyStageCertificates',
      );
      const corePolicy = policies.find(
        (candidate) =>
          candidate.Properties.ManagedPolicyName === `roadmap2u-${stage}-cfn-core`,
      );
      const denyExport = corePolicy.Properties.PolicyDocument.Statement.find(
        (statement: any) => statement.Sid === 'DenyExportableStageCertificates',
      );
      const initialTag = statements.find(
        (statement: any) => statement.Sid === 'TagOnlyUntaggedStageCertificates',
      );
      const ownershipTag = statements.find(
        (statement: any) => statement.Sid === 'TagOnlyNamedStageCertificates',
      );
      const manage = statements.find(
        (statement: any) => statement.Sid === 'ManageOnlyTaggedStageCertificates',
      );

      const apiDomain = stage === 'prod' ? 'api.roadmap2u.com' : `api.${stage}.roadmap2u.com`;
      const frontendDomain = stage === 'prod' ? 'roadmap2u.com' : `${stage}.roadmap2u.com`;
      const allowedDomains =
        stage === 'prod'
          ? [apiDomain, frontendDomain, 'www.roadmap2u.com']
          : [apiDomain, frontendDomain];

      expect(request.Action).toBe('acm:RequestCertificate');
      expect(request.Resource).toBe('*');
      expect(request.Condition.StringEquals).toMatchObject({
        'acm:CertificateKeyPairOrigin': 'AWS_MANAGED',
        'acm:ValidationMethod': 'DNS',
      });
      expect(request.Condition['ForAllValues:StringEquals']['acm:DomainNames']).toEqual(
        allowedDomains,
      );
      expect(request.Condition.Null).toEqual({
        'acm:CertificateAuthority': 'true',
        'acm:DomainNames': 'false',
      });
      expect(JSON.stringify(request.Condition)).not.toContain('aws:RequestTag');

      expect(denyExport).toEqual({
        Action: 'acm:RequestCertificate',
        Condition: {
          StringEquals: {
            'acm:Export': 'ENABLED',
          },
        },
        Effect: 'Deny',
        Resource: '*',
        Sid: 'DenyExportableStageCertificates',
      });

      expect(initialTag.Action).toBe('acm:AddTagsToCertificate');
      expect(JSON.stringify(initialTag.Resource)).toContain(
        ':acm:us-east-1:123456789012:certificate/*',
      );
      expect(initialTag.Condition.StringEquals).toMatchObject({
        'acm:CertificateKeyPairOrigin': 'AWS_MANAGED',
        'aws:RequestTag/Name': [
          `Roadmap-${stage}-Backend/ApiCertificate`,
          `Roadmap-${stage}-Hosting/SiteCertificate`,
        ],
      });
      expect(initialTag.Condition.StringEqualsIfExists).toEqual({
        'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
        'aws:RequestTag/roadmap2u-stage': stage,
      });
      expect(initialTag.Condition.Null).toEqual({
        'aws:ResourceTag/Name': 'true',
        'aws:ResourceTag/roadmap2u-project': 'true',
        'aws:ResourceTag/roadmap2u-stage': 'true',
        'aws:TagKeys': 'false',
      });
      expect(initialTag.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
        'Name',
        'roadmap2u-project',
        'roadmap2u-stage',
      ]);

      expect(ownershipTag.Action).toBe('acm:AddTagsToCertificate');
      expect(ownershipTag.Condition.StringEquals['acm:CertificateKeyPairOrigin']).toBe(
        'AWS_MANAGED',
      );
      expect(ownershipTag.Condition.StringEquals['aws:ResourceTag/Name']).toEqual([
        `Roadmap-${stage}-Backend/ApiCertificate`,
        `Roadmap-${stage}-Hosting/SiteCertificate`,
      ]);
      expect(ownershipTag.Condition.StringEqualsIfExists).toEqual({
        'aws:RequestTag/roadmap2u-project': 'RoadMap2U',
        'aws:RequestTag/roadmap2u-stage': stage,
      });
      expect(ownershipTag.Condition['ForAllValues:StringEquals']['aws:TagKeys']).toEqual([
        'roadmap2u-project',
        'roadmap2u-stage',
      ]);
      expect(ownershipTag.Condition.Null['aws:TagKeys']).toBe('false');

      expect(manage.Action).not.toContain('acm:AddTagsToCertificate');
      expect(manage.Condition.StringEquals).toMatchObject({
        'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
        'aws:ResourceTag/roadmap2u-stage': stage,
      });
    }
  });

  it('places all GitHub deployment roles in their stage path', () => {
    const roles = Object.values(bootstrapTemplate().toJSON().Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::IAM::Role' &&
        JSON.stringify(resource.Properties.AssumeRolePolicyDocument).includes(
          'sts:AssumeRoleWithWebIdentity',
        ),
    ) as any[];

    expect(roles).toHaveLength(8);
    for (const role of roles) {
      const stage = role.Properties.RoleName.includes('-dev-')
        ? 'dev'
        : role.Properties.RoleName.includes('-test-')
          ? 'test'
          : 'prod';
      expect(role.Properties.Path).toBe(`/roadmap2u/${stage}/`);
    }
  });

  it('uses distribution resource tags to scope frontend and DNS CloudFront access', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());

    expect(rendered).toContain('aws:ResourceTag/roadmap2u-project');
    expect(rendered).toContain('aws:ResourceTag/roadmap2u-stage');
    for (const stage of ['dev', 'test', 'prod']) {
      expect(rendered).toContain(stage);
    }
  });

  it('scopes release markers to repo and stage, including the prior-stage promotion proof', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());

    for (const repo of ['backend', 'frontend']) {
      for (const stage of ['dev', 'test', 'prod']) {
        expect(rendered).toContain(`/roadmap2u/${stage}/${repo}-release-sha`);
        expect(rendered).toContain(`/roadmap2u/${stage}/${repo}-releases/*`);
      }
    }
    expect(rendered).toContain('/roadmap2u/dev/backend-releases/*');
    expect(rendered).toContain('/roadmap2u/test/backend-releases/*');
    expect(rendered).toContain('/roadmap2u/dev/frontend-releases/*');
    expect(rendered).toContain('/roadmap2u/test/frontend-releases/*');
  });

  it('writes and reads only the selected stage backend release manifest', () => {
    const template = bootstrapTemplate().toJSON();
    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const manifestPath = `/roadmap2u/${stage}/backend-release-manifests/*`;
      const otherStages = ['dev', 'test', 'prod'].filter((candidate) => candidate !== stage);
      const backendWrite = policies
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .find((statement: any) => statement.Sid === `WriteBackendReleaseProof${stage}`);
      const backendRead = policies
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .find((statement: any) => statement.Sid === `ReadReleaseProofAndPublicConfig${stage}`);
      const frontendRead = policies
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .find((statement: any) => statement.Sid === `ReadFrontendConfigAndReleaseProof${stage}`);

      expect(backendWrite).toBeDefined();
      expect(backendRead).toBeDefined();
      expect(frontendRead).toBeDefined();
      expect(JSON.stringify(backendWrite.Resource)).toContain(manifestPath);
      expect(JSON.stringify(backendRead.Resource)).toContain(manifestPath);
      expect(JSON.stringify(frontendRead.Resource)).toContain(manifestPath);
      for (const other of otherStages) {
        expect(JSON.stringify(backendWrite.Resource)).not.toContain(
          `/roadmap2u/${other}/backend-release-manifests/`,
        );
        expect(JSON.stringify(backendRead.Resource)).not.toContain(
          `/roadmap2u/${other}/backend-release-manifests/`,
        );
        expect(JSON.stringify(frontendRead.Resource)).not.toContain(
          `/roadmap2u/${other}/backend-release-manifests/`,
        );
      }
    }
  });

  it('lets frontend validate only the selected stage backend release marker', () => {
    const template = bootstrapTemplate().toJSON();
    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];

    for (const stage of ['dev', 'test', 'prod']) {
      const frontendRead = policies
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
        .find((statement: any) => statement.Sid === `ReadFrontendConfigAndReleaseProof${stage}`);

      expect(frontendRead).toBeDefined();
      expect(JSON.stringify(frontendRead.Resource)).toContain(
        `/roadmap2u/${stage}/backend-releases/*`,
      );
      for (const other of ['dev', 'test', 'prod'].filter((candidate) => candidate !== stage)) {
        expect(JSON.stringify(frontendRead.Resource)).not.toContain(
          `/roadmap2u/${other}/backend-releases/`,
        );
      }
    }
  });

  it('grants backend deploy roles only read access to inspect log retention', () => {
    const statements = Object.values(bootstrapTemplate().toJSON().Resources)
      .filter((resource: any) => resource.Type === 'AWS::IAM::Policy')
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);

    for (const stage of ['dev', 'test', 'prod']) {
      const retentionRead = statements.find(
        (statement: any) => statement.Sid === `InspectStageLogRetention${stage}`,
      );
      expect(retentionRead).toEqual({
        Action: 'logs:DescribeLogGroups',
        Effect: 'Allow',
        Resource: '*',
        Sid: `InspectStageLogRetention${stage}`,
      });
    }
    expect(JSON.stringify(statements)).not.toMatch(/logs:(Delete|PutRetention|Create)/);
  });

  it('lets the dedicated DNS role write only the captured DNS backup', () => {
    const rendered = bootstrapTemplate().toJSON();
    const statements = Object.values(rendered.Resources)
      .filter((resource: any) => resource.Type === 'AWS::IAM::Policy')
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
    const backupWrite = statements.find(
      (statement: any) => statement.Sid === 'PersistOnlyProductionDnsBackup',
    );

    expect(backupWrite).toBeDefined();
    expect(backupWrite.Action).toBe('ssm:PutParameter');
    expect(JSON.stringify(backupWrite.Resource)).toContain('/roadmap2u/prod/dns-cutover-backup');
    expect(JSON.stringify(backupWrite.Resource)).not.toContain('release-sha');
    expect(JSON.stringify(backupWrite.Resource)).not.toContain('cloudfront-distribution-id');
  });

  it('keeps the DNS planning role read-only and the mutating role apply-only', () => {
    const rendered = bootstrapTemplate().toJSON();
    const roleEntries = Object.entries(rendered.Resources).filter(
      ([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Role',
    );
    const logicalIdFor = (roleName: string) =>
      roleEntries.find(
        ([, resource]: [string, any]) => resource.Properties.RoleName === roleName,
      )?.[0];
    const actionsFor = (logicalId: string | undefined) =>
      Object.values(rendered.Resources)
        .filter(
          (resource: any) =>
            resource.Type === 'AWS::IAM::Policy' &&
            JSON.stringify(resource.Properties.Roles).includes(`\"Ref\":\"${logicalId}\"`),
        )
        .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement)
        .flatMap((statement: any) =>
          Array.isArray(statement.Action) ? statement.Action : [statement.Action],
        );

    const planActions = actionsFor(logicalIdFor('roadmap2u-prod-dns-plan'));
    const applyActions = actionsFor(logicalIdFor('roadmap2u-prod-dns-cutover'));
    expect(planActions).toContain('route53:ListResourceRecordSets');
    expect(planActions).toContain('cloudfront:GetDistribution');
    expect(planActions).toContain('acm:DescribeCertificate');
    expect(planActions).not.toContain('route53:ChangeResourceRecordSets');
    expect(planActions).not.toContain('ssm:PutParameter');
    expect(applyActions).toContain('route53:ChangeResourceRecordSets');
    expect(applyActions).toContain('ssm:PutParameter');

    const planRole = roleEntries.find(
      ([, resource]: [string, any]) => resource.Properties.RoleName === 'roadmap2u-prod-dns-plan',
    )?.[1] as any;
    const applyRole = roleEntries.find(
      ([, resource]: [string, any]) =>
        resource.Properties.RoleName === 'roadmap2u-prod-dns-cutover',
    )?.[1] as any;
    expect(JSON.stringify(planRole.Properties.AssumeRolePolicyDocument)).toContain(
      'environment:prod',
    );
    expect(JSON.stringify(planRole.Properties.AssumeRolePolicyDocument)).not.toContain(
      'environment:prod-dns-cutover',
    );
    expect(JSON.stringify(applyRole.Properties.AssumeRolePolicyDocument)).toContain(
      'environment:prod-dns-cutover',
    );
    expect(JSON.stringify(applyRole.Properties.AssumeRolePolicyDocument)).not.toContain(
      'environment:prod\"',
    );
  });
});
