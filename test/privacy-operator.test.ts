import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildPrivacyOperatorPlan,
  confirmPrivacyOperatorPlan,
  constrainPrivacyOperatorReads,
} from '../lambda/privacy/operator';
import { assertPrivateOperator } from '../lambda/privacy/retention';
const request = {
  action: 'verify_representation',
  command: {
    invitationId: 'a'.repeat(64),
    commandId: 'verify-1',
    caseId: 'verified-case-1',
    expectedRevision: 1,
    guardianId: 'adult-id',
    recipientUsername: 'teen',
    majorityAt: '2029-10-07',
  },
};
describe('bounded private operator plans', () => {
  it('binds exact stage, actor, subject metadata, revision and case into a reproducible offline hash', () => {
    const plan = buildPrivacyOperatorPlan('dev', request);
    expect(plan.table).toBe('roadmap-dev');
    expect(buildPrivacyOperatorPlan('test', request).hash).not.toBe(plan.hash);
    expect(
      buildPrivacyOperatorPlan('dev', {
        ...request,
        command: { ...request.command, recipientUsername: 'other' },
      }).hash,
    ).not.toBe(plan.hash);
    expect(buildPrivacyOperatorPlan('dev', JSON.parse(JSON.stringify(request))).hash).toBe(
      plan.hash,
    );
    expect(() => confirmPrivacyOperatorPlan(plan, 'prod', plan.hash)).toThrow();
    expect(() => confirmPrivacyOperatorPlan(plan, 'dev', '0'.repeat(64))).toThrow();
    expect(() => confirmPrivacyOperatorPlan(plan, 'dev', plan.hash)).not.toThrow();
  });
  it.each([
    { ...request, action: 'grant_premium' },
    { ...request, command: { ...request.command, recipientUsername: 'teen#other' } },
    { ...request, command: { ...request.command, guardianId: 123 } },
    { ...request, command: { ...request.command, extra: true } },
  ])('rejects unrelated or ambiguous instructions', (invalid) => {
    expect(() => buildPrivacyOperatorPlan('dev', invalid)).toThrow();
  });
  it('rejects another operator, stage-mismatched role and ordinary app identities', () => {
    const roleArn = buildPrivacyOperatorPlan('dev', request).roleArn;
    expect(() =>
      assertPrivateOperator({
        roleArn,
        arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-privacy-operator/session',
      }),
    ).not.toThrow();
    expect(() =>
      assertPrivateOperator({
        roleArn: roleArn.replace('operators/roadmap2u-dev', 'operators/roadmap2u-test'),
        arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-test-privacy-operator/session',
      }),
    ).toThrow();
  });
  it('adds a metadata projection before the SDK can send a main-table read', async () => {
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
    );
    constrainPrivacyOperatorReads(client, 'roadmap-dev');
    let sent: any;
    client.middlewareStack.add(
      () => async (args) => {
        sent = args.input;
        return { response: {}, output: { $metadata: {}, Item: undefined } };
      },
      { name: 'captureOffline', step: 'initialize', priority: 'low' },
    );
    await client.send(
      new GetCommand({ TableName: 'roadmap-dev', Key: { pk: 'USER#adult', sk: 'PROFILE' } }),
    );
    expect(Object.values(sent.ExpressionAttributeNames)).toContain('userId');
    expect(Object.values(sent.ExpressionAttributeNames)).toContain('guardianAuthorization');
    expect(Object.values(sent.ExpressionAttributeNames)).not.toContain('record');
    expect(Object.values(sent.ExpressionAttributeNames)).not.toContain('note');
    expect(sent.ProjectionExpression).toContain('#meta0');
  });
});
