import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapCiBootstrapStack } from '../lib/roadmap-stack';

const ACCOUNT = '765932874577';
const template = () => Template.fromStack(new RoadmapCiBootstrapStack(new App(), 'Roadmap-CiBootstrap', {
  env: { account: ACCOUNT, region: 'us-east-1' }, hostedZoneId: 'Z08619612LYY2MSBEZSCQ',
  githubOwner: 'Toydrum', githubOwnerId: '61118847', backendRepository: 'roadmap2u-backend', backendRepositoryId: '1307128632',
  frontendRepository: 'RoadMap2U', frontendRepositoryId: '741787733', operationsPrincipalArn: `arn:aws:iam::${ACCOUNT}:user/Hector-admin`,
})).toJSON();

describe('PROD access-code control plane readiness', () => {
  it('accepts the actual HMAC store of each immutable application artifact', () => {
    const manifest = JSON.parse(readFileSync('shared/backend-release-capabilities.json', 'utf8'));
    const source = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const declarations = [...source.matchAll(/^\s*([a-z|]+)\) EXPECTED_STORE="([a-z0-9-]+)"/gm)];
    for (const stage of ['dev', 'test', 'prod']) {
      const stores = declarations.filter(match => match[1].split('|').includes(stage)).map(match => match[2]);
      expect(stores, `one fail-closed store for ${stage}`).toEqual([manifest.accessCodeHmacStores[stage]]);
    }
  });

  it('allows the PROD runtime to read only its SSM HMAC parameter', () => {
    const policy = Object.values(template().Resources).find((r: any) => r.Type === 'AWS::IAM::ManagedPolicy'
      && r.Properties.ManagedPolicyName === 'roadmap2u-prod-runtime-boundary') as any;
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements.find((s: any) => s.Sid === 'ReadOnlySponsoredAccessHmacParameter')).toMatchObject({ Effect: 'Allow', Action: 'ssm:GetParameter' });
    expect(JSON.stringify(statements.find((s: any) => s.Sid === 'ReadOnlySponsoredAccessHmacParameter').Resource)).toContain('parameter/roadmap2u/prod/access-code-hmac/v1');
    expect(JSON.stringify(statements)).not.toContain('secretsmanager:');
  });

  it('lets the PROD workflow inspect SSM metadata without reading key material', () => {
    const resources = template().Resources;
    const roleId = Object.entries(resources).find(([, r]: any) => r.Type === 'AWS::IAM::Role'
      && r.Properties.RoleName === 'roadmap2u-prod-backend-deploy')?.[0];
    expect(roleId).toBeTruthy();
    const policies = Object.values(resources).filter((r: any) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((role: any) => role.Ref === roleId)) as any[];
    const statements = policies.flatMap(r => r.Properties.PolicyDocument.Statement);
    const tags = statements.find((s: any) => s.Sid === 'InspectSponsoredAccessHmacTagsprod');
    expect(tags).toMatchObject({ Effect: 'Allow' });
    expect(JSON.stringify(tags.Resource)).toContain('parameter/roadmap2u/prod/access-code-hmac/v1');
    const hmacInspection = statements.filter((s: any) => s.Sid?.startsWith('InspectSponsoredAccessHmac'));
    expect(hmacInspection.flatMap((s: any) => [s.Action].flat())).not.toContain('ssm:GetParameter');
  });
});
