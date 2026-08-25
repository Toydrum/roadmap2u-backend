import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';

it('retains the existing HMAC secret before the SSM cutover', () => {
  const app = new App();
  const template = Template.fromStack(
    new RoadmapStack(app, 'Roadmap-dev-Backend', {
      env: { account: '123456789012', region: 'us-east-1' },
      stage: 'dev',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    }),
  ).toJSON();
  const secret = Object.values(template.Resources).find(
    (resource: any) =>
      resource.Type === 'AWS::SecretsManager::Secret' &&
      resource.Properties.Name === 'roadmap2u/dev/access-code-hmac/v1',
  ) as any;

  expect(secret.DeletionPolicy).toBe('Retain');
  expect(secret.UpdateReplacePolicy).toBe('Retain');
}, 20_000);
