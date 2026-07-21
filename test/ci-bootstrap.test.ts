import { App } from 'aws-cdk-lib';
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
      backendRepository: 'roadmap2u-backend',
      frontendRepository: 'RoadMap2U',
    }),
  );
}

describe('GitHub OIDC bootstrap', () => {
  it('creates one GitHub provider and a repo-specific role for every environment', () => {
    const template = bootstrapTemplate();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.resourceCountIs('AWS::IAM::Role', 8);

    const rendered = JSON.stringify(template.toJSON());
    for (const stage of ['dev', 'test', 'prod']) {
      expect(rendered).toContain(`roadmap2u-${stage}-backend-deploy`);
      expect(rendered).toContain(`roadmap2u-${stage}-frontend-deploy`);
      expect(rendered).toContain(`repo:Toydrum/roadmap2u-backend:environment:${stage}`);
      expect(rendered).toContain(`repo:Toydrum/RoadMap2U:environment:${stage}`);
      expect(template.toJSON().Outputs).toHaveProperty(`${stage}BackendRoleArn`);
      expect(template.toJSON().Outputs).toHaveProperty(`${stage}FrontendRoleArn`);
    }
    expect(rendered).not.toContain('AdministratorAccess');
    expect(rendered).toContain('roadmap2u-prod-dns-plan');
    expect(rendered).toContain('roadmap2u-prod-dns-cutover');
    expect(template.toJSON().Outputs).toHaveProperty('prodDnsPlanRoleArn');
    expect(rendered).toContain('repo:Toydrum/roadmap2u-backend:environment:prod-dns-cutover');
    expect(template.toJSON().Outputs).toHaveProperty('prodDnsCutoverRoleArn');
    expect(rendered).toContain('cloudfront:GetDistribution');
    expect(rendered).toContain('acm:DescribeCertificate');
    expect(rendered).toContain('route53:ChangeResourceRecordSets');
    expect(rendered).toContain('route53:GetChange');
    expect(rendered).toContain('/roadmap2u/prod/dns-cutover-backup');
  });

  it('selects the stage-specific CDK bootstrap roles and version parameter', () => {
    const rendered = JSON.stringify(bootstrapTemplate().toJSON());
    const qualifiers = {
      dev: 'rmap2udev',
      test: 'rmap2utst',
      prod: 'rmap2uprd',
    } as const;

    for (const [stage, qualifier] of Object.entries(qualifiers)) {
      for (const purpose of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
        expect(rendered).toContain(`cdk-${qualifier}-${purpose}-role-${ACCOUNT}-us-east-1`);
      }
      expect(rendered).not.toContain(`cdk-${qualifier}-cfn-exec-role-${ACCOUNT}-us-east-1`);
      expect(rendered).toContain(`/cdk-bootstrap/${qualifier}/version`);
      expect(infrastructure.bootstrapQualifierFor(stage as keyof typeof qualifiers)).toBe(
        qualifier,
      );
    }
    expect(rendered).not.toContain(`cdk-hnb659fds-deploy-role-${ACCOUNT}-us-east-1`);
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
