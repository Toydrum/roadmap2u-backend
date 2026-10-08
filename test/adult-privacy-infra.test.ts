import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RoadmapStack } from '../lib/roadmap-stack';
describe('adult privacy infrastructure', () => {
  it.each(['dev', 'test', 'prod'] as const)(
    'keeps %s privacy decisions separate and deploys compatible guards with bounded maintenance',
    (stage) => {
      const app = new App();
      const stack = new RoadmapStack(app, `Privacy-${stage}`, {
        stage,
        hostedZoneId: 'Z0123456789ABCDEFGHIJ',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack).toJSON();
      expect(template.Parameters.AdultPrivacyMode).toMatchObject({
        Type: 'String',
        Default: 'off',
        AllowedValues: ['off', 'enforce'],
      });
      expect(template.Parameters.PrivateAdolescentMode).toMatchObject({
        Type: 'String',
        Default: 'off',
        AllowedValues: ['off', 'enforce'],
      });
      expect(template.Rules.PrivateAdolescentsRequireAdultPrivacy).toEqual({
        Assertions: [
          {
            Assert: {
              'Fn::Or': [
                { 'Fn::Equals': [{ Ref: 'PrivateAdolescentMode' }, 'off'] },
                { 'Fn::Equals': [{ Ref: 'AdultPrivacyMode' }, 'enforce'] },
              ],
            },
            AssertDescription: 'Private adolescents require adult privacy enforcement.',
          },
        ],
      });
      const resources = Object.entries(template.Resources) as [string, any][];
      const privacy = resources.find(
        ([, r]) =>
          r.Type === 'AWS::DynamoDB::Table' &&
          r.Properties.TableName === `roadmap-privacy-${stage}`,
      );
      expect(privacy).toBeDefined();
      expect(privacy![1].DeletionPolicy).toBe('RetainExceptOnCreate');
      expect(privacy![1].UpdateReplacePolicy).toBe('Retain');
      expect(privacy![1].Properties.TimeToLiveSpecification).toEqual({
        AttributeName: 'ttl',
        Enabled: true,
      });
      const router = resources.find(
        ([, r]) =>
          r.Type === 'AWS::Lambda::Function' &&
          r.Properties.FunctionName === `roadmap-router-${stage}`,
      )![1];
      expect(router.Properties.Environment.Variables).toMatchObject({
        ADULT_PRIVACY_MODE: { Ref: 'AdultPrivacyMode' },
        PRIVATE_ADOLESCENT_MODE: { Ref: 'PrivateAdolescentMode' },
        PRIVACY_TABLE_NAME: { Ref: privacy![0] },
      });
      expect(privacy![1].Properties.GlobalSecondaryIndexes[0].IndexName).toBe('gsi1');
      const worker = resources.find(
        ([, r]) =>
          r.Type === 'AWS::Lambda::Function' &&
          r.Properties.FunctionName === `roadmap-account-closure-privacy-${stage}`,
      );
      expect(worker).toBeDefined();
      expect(worker![1].Properties.Environment.Variables.ADULT_PRIVACY_MODE).toEqual({
        Ref: 'AdultPrivacyMode',
      });
      expect(worker![1].Properties.Environment.Variables.PRIVATE_ADOLESCENT_MODE).toEqual({
        Ref: 'PrivateAdolescentMode',
      });
      for (const name of [
        `roadmap-account-closure-request-${stage}`,
        `roadmap-account-closure-worker-${stage}`,
      ]) {
        const closure = resources.find(
          ([, r]) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === name,
        );
        expect(closure, name).toBeDefined();
        expect(closure![1].Properties.Environment.Variables.ADULT_PRIVACY_MODE).toEqual({
          Ref: 'AdultPrivacyMode',
        });
      }
      const roleId = worker![1].Properties.Role['Fn::GetAtt'][0];
      const policies = resources.filter(
        ([, r]) =>
          r.Type === 'AWS::IAM::Policy' &&
          r.Properties.Roles.some((ref: any) => ref.Ref === roleId),
      );
      const statements = policies
        .flatMap(([, r]) => r.Properties.PolicyDocument.Statement)
        .filter((s: any) => s.Effect === 'Allow');
      expect(
        statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])),
      ).not.toContain('dynamodb:Scan');
      expect(
        statements
          .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
          .some((action) => action.startsWith('cognito-idp:')),
      ).toBe(false);
      expect(
        resources.some(
          ([, r]) =>
            r.Type === 'AWS::Events::Rule' &&
            r.Properties.ScheduleExpression === 'rate(5 minutes)' &&
            r.Properties.Targets.some((target: any) =>
              JSON.stringify(target.Arn).includes(worker![0]),
            ),
        ),
      ).toBe(true);
    },
    30000,
  );
});
