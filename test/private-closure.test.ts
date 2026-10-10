import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { requestPrivateAdolescentClosure } from '../lambda/privacy/private-closure';
import { privacySnapshotHash } from '../lambda/privacy/retention';
import { completeAccountPrivacyClosure } from '../lambda/privacy/closure';
import {
  buildPrivacyOperatorPlan,
  PRIVACY_OPERATOR_READ_ATTRIBUTES,
} from '../lambda/privacy/operator';
import { readFileSync } from 'node:fs';
import { processAccountClosureMessage } from '../lambda/account-closure';
import { AuditWriter } from '../lambda/commercial/audit';
const NOW = Date.parse('2026-10-07T16:00:00Z');
const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const rows = new Map<string, any>();
const invitationId = 'a'.repeat(64);
const command = {
  userId: 'teen',
  username: 'teen',
  guardianId: 'parent',
  invitationId,
  expectedRevision: 3,
  commandId: 'close-1',
  caseId: 'legally-verified-closure-case',
};
const plan = buildPrivacyOperatorPlan('dev', { action: 'request_private_closure', command });
const operator = {
  roleArn: plan.roleArn,
  arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-privacy-operator/verified-session',
};
const deps = () => ({
  table: plan.table,
  privacyTable: plan.privacyTable,
  userPoolId: 'pool',
  now: () => NOW,
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  cognito: new CognitoIdentityProviderClient({}),
});
function useAuthenticatedAdmission() {
  const attestation = {
    subjectId: 'parent',
    authenticatedAt: NOW - 11000,
    emailVerified: true,
    declaredName: 'Synthetic Guardian',
    relationship: 'parent',
    declaredAt: NOW - 10000,
  };
  const invite = rows.get(`ADOLESCENT_INVITE#${invitationId}/STATE`);
  delete invite.representationVerifiedAt;
  delete invite.verificationCaseId;
  Object.assign(invite, {
    authorizationMethod: 'account_attestation',
    createdAt: attestation.declaredAt,
    attestation,
  });
  const state = rows.get('USER#teen/PRIVACY#ADULT');
  state.guardianAuthorization = { method: 'account_attestation', attestation };
  Object.assign(rows.get('PRIVACY_STATE#teen/STATE'), {
    snapshot: state,
    snapshotHash: privacySnapshotHash(state),
  });
}
beforeEach(() => {
  ddb.reset();
  cognito.reset();
  rows.clear();
  rows.set('USER#teen/PROFILE', {
    pk: 'USER#teen',
    sk: 'PROFILE',
    userId: 'teen',
    username: 'teen',
    accountType: 'minor',
    privacyMode: 'adolescent_private',
    majorityAt: '2029-10-07',
    socialEnabled: false,
  });
  const state = {
    pk: 'USER#teen',
    sk: 'PRIVACY#ADULT',
    userId: 'teen',
    revision: 3,
    updatedAt: NOW - 1000,
    subjectKind: 'adolescent_private',
    guardianId: 'parent',
    guardianConsent: 'revoked',
    cloudConsent: 'revoked',
    erasure: 'none',
    majorityAt: '2029-10-07',
    invitationId,
  } as const;
  rows.set('USER#teen/PRIVACY#ADULT', state);
  rows.set('PRIVACY_STATE#teen/STATE', {
    pk: 'PRIVACY_STATE#teen',
    sk: 'STATE',
    userId: 'teen',
    revision: 3,
    updatedAt: state.updatedAt,
    snapshot: state,
    snapshotHash: privacySnapshotHash(state),
  });
  rows.set(`ADOLESCENT_INVITE#${invitationId}/STATE`, {
    pk: `ADOLESCENT_INVITE#${invitationId}`,
    sk: 'STATE',
    invitationId,
    state: 'accepted',
    revision: 3,
    adolescentId: 'teen',
    guardianId: 'parent',
    representationVerifiedAt: NOW - 10000,
    verificationCaseId: 'verified-admission',
    ttl: Math.ceil(Date.parse('2029-12-01') / 1000),
  });
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(`${input.Key.pk}/${input.Key.sk}`) }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? [])
      if (item.Put) rows.set(`${item.Put.Item.pk}/${item.Put.Item.sk}`, item.Put.Item);
    return {};
  });
});
describe('private account closure through verified support', () => {
  it.each(['operator_verified', 'account_attestation'])(
    'runs the real bounded worker after %s admission while preserving another account',
    async (method) => {
      if (method === 'account_attestation') useAuthenticatedAdmission();
      let now = NOW;
      const key = (value: any) => `${value.pk}/${value.sk}`;
      const applyUpdate = (input: any) => {
        const current = { ...rows.get(key(input.Key)) };
        const names = input.ExpressionAttributeNames ?? {},
          values = input.ExpressionAttributeValues ?? {};
        const parts = input.UpdateExpression.split(/\s+REMOVE\s+/);
        for (const pair of parts[0].replace(/^SET\s+/, '').split(', ')) {
          const [name, value] = pair.split(' = ');
          current[names[name] ?? name] = values[value];
        }
        for (const name of (parts[1] ?? '').split(', ').filter(Boolean))
          delete current[names[name] ?? name];
        rows.set(key(input.Key), current);
        return { Attributes: current };
      };
      ddb.on(UpdateCommand).callsFake(applyUpdate);
      ddb.on(TransactWriteCommand).callsFake((input) => {
        for (const item of input.TransactItems ?? []) {
          if (item.Put) rows.set(key(item.Put.Item), item.Put.Item);
          if (item.Delete) rows.delete(key(item.Delete.Key));
          if (item.Update) applyUpdate(item.Update);
        }
        return {};
      });
      ddb.on(QueryCommand).callsFake((input) => {
        const values = input.ExpressionAttributeValues ?? {};
        const pk = values[':pk'],
          prefix = values[':prefix'] ?? '';
        // The only forest rows in this fixture are primary-table USER rows.
        const items =
          input.TableName === plan.table && !input.IndexName
            ? [...rows.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix))
            : [];
        return { Items: items.slice(0, input.Limit ?? 25) };
      });
      ddb.on(BatchWriteCommand).callsFake((input) => {
        for (const operation of input.RequestItems?.[plan.table] ?? [])
          if (operation.DeleteRequest) rows.delete(key(operation.DeleteRequest.Key));
        return { UnprocessedItems: {} };
      });
      cognito.on(AdminDeleteUserCommand).callsFake(() => {
        expect([...rows.values()].filter((item) => item.pk === 'USER#teen')).toEqual([]);
        return {};
      });
      rows.set('USER#teen/REC#note', {
        pk: 'USER#teen',
        sk: 'REC#note',
        owner: 'teen',
        record: { note: 'private' },
      });
      const other = {
        pk: 'USER#other',
        sk: 'REC#note',
        owner: 'other',
        record: { note: 'preserve' },
      };
      rows.set(key(other), other);
      const base = deps();
      const worker = {
        ...base,
        now: () => now,
        queue: { enqueue: vi.fn(async () => {}) },
        nextWorkerId: () => 'worker',
        nextClosureId: () => 'unused',
        auditWriter: new AuditWriter({ ddb: base.ddb, tableName: 'audit' }),
      };
      await requestPrivateAdolescentClosure(worker, command, operator);
      const closure = rows.get('ACCOUNT_CLOSURE#teen/STATE');
      for (
        let attempt = 0;
        attempt < 24 && rows.get('ACCOUNT_CLOSURE#teen/STATE').state !== 'completed';
        attempt++
      ) {
        now += 60000;
        await processAccountClosureMessage(worker, { sub: 'teen', closureId: closure.closureId });
      }
      expect(rows.get('ACCOUNT_CLOSURE#teen/STATE').state).toBe('completed');
      expect(rows.get('RESTORE#teen/STATE')).toMatchObject({ scope: 'account', completedAt: now });
      expect(rows.has('PRIVACY_STATE#teen/STATE')).toBe(false);
      expect(rows.get(`ADOLESCENT_INVITE#${invitationId}/STATE`).state).toBe('revoked');
      expect(rows.get(key(other))).toEqual(other);
      expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    },
  );
  it('closes an automatically admitted account through projected operator metadata and a new verified rights case', async () => {
    useAuthenticatedAdmission();
    // Main-table reads cannot include forest content under the private operator policy.
    ddb.on(GetCommand).callsFake((input) => {
      const item = rows.get(`${input.Key.pk}/${input.Key.sk}`);
      return {
        Item:
          input.TableName === plan.table && item
            ? Object.fromEntries(
                Object.entries(item).filter(([name]) =>
                  PRIVACY_OPERATOR_READ_ATTRIBUTES.includes(name as any),
                ),
              )
            : item,
      };
    });
    await expect(
      requestPrivateAdolescentClosure(deps(), command, {
        ...operator,
        arn: 'arn:aws:sts::765932874577:assumed-role/router/app',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requestPrivateAdolescentClosure(deps(), { ...command, caseId: '' }, operator),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    await requestPrivateAdolescentClosure(deps(), command, operator);
    expect(rows.get('ACCOUNT_CLOSURE#teen/STATE')).toMatchObject({
      state: 'requested',
      caseId: command.caseId,
      actorSub: operator.arn,
    });
  });
  it.each([
    { subjectId: 'other-parent' },
    { emailVerified: false },
    { authenticatedAt: NOW - 20 * 60000 },
  ])(
    'rejects invalid automatic authorization evidence before a closure write: %j',
    async (invalid) => {
      useAuthenticatedAdmission();
      Object.assign(rows.get(`ADOLESCENT_INVITE#${invitationId}/STATE`).attestation, invalid);
      const state = rows.get('USER#teen/PRIVACY#ADULT');
      rows.get('PRIVACY_STATE#teen/STATE').snapshotHash = privacySnapshotHash(state);
      await expect(
        requestPrivateAdolescentClosure(deps(), command, operator),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );
  it('records a bounded durable closure without requiring Premium, cloud grant or a forest download', async () => {
    await requestPrivateAdolescentClosure(deps(), command, operator);
    expect(rows.get('ACCOUNT_CLOSURE#teen/STATE')).toMatchObject({
      kind: 'private_adolescent',
      state: 'requested',
      caseId: command.caseId,
      actorSub: operator.arn,
      gsi1pk: 'ACCOUNT_CLOSURE#OPEN',
    });
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    const count = ddb.commandCalls(TransactWriteCommand).length;
    await requestPrivateAdolescentClosure(deps(), command, operator);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(count);
    await expect(
      requestPrivateAdolescentClosure(deps(), { ...command, caseId: 'other-case' }, operator),
    ).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
  });
  it('rejects an app caller and a mismatched representative or revision before writing', async () => {
    await expect(
      requestPrivateAdolescentClosure(deps(), command, {
        ...operator,
        arn: 'arn:aws:sts::765932874577:assumed-role/router/app',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requestPrivateAdolescentClosure(deps(), { ...command, guardianId: 'other' }, operator),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      requestPrivateAdolescentClosure(deps(), { ...command, expectedRevision: 2 }, operator),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it('revokes the remaining invitation and shortens its retention only at verified physical completion', async () => {
    const updates = await completeAccountPrivacyClosure(deps(), {
      pk: 'RESTORE#teen',
      sk: 'STATE',
      userId: 'teen',
      revision: 1,
      updatedAt: NOW - 1000,
      scope: 'account',
      erasureId: 'close-1',
      cutoffRevision: 0,
      holdRevision: 0,
    });
    const invitation = updates.find(
      (item) => item.Put?.Item?.['pk'] === `ADOLESCENT_INVITE#${invitationId}`,
    )?.Put?.Item;
    expect(invitation).toMatchObject({
      state: 'revoked',
      ttl: Math.ceil((NOW + 36 * 86400000) / 1000),
    });
    expect(updates.some((item) => item.Delete?.Key?.['pk'] === 'PRIVACY_STATE#teen')).toBe(true);
  });
  it('permits every actual main-table closure fence, including the canonical household partition', async () => {
    await requestPrivateAdolescentClosure(deps(), command, operator);
    const transaction = ddb.commandCalls(TransactWriteCommand)[0].args[0].input;
    const leadingKeys = transaction.TransactItems!
      .flatMap((item) => (item.ConditionCheck?.TableName === plan.table ? [item.ConditionCheck.Key!.pk as string] : []));
    expect(leadingKeys.some((pk) => pk.startsWith('HOUSEHOLD#'))).toBe(true);
    const template = JSON.parse(readFileSync('bootstrap/privacy-operator.template.json', 'utf8'));
    const fence = template.Resources.PrivacyOperator.Properties.Policies[0].PolicyDocument.Statement.find(
      (item: any) => item.Sid === 'CheckActiveSubjectsAndDecisions',
    );
    expect(fence.Action).toBe('dynamodb:ConditionCheckItem');
    expect(fence.Condition.Null['dynamodb:LeadingKeys']).toBe('false');
    const patterns: string[] = fence.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    for (const pk of leadingKeys)
      expect(patterns.some((pattern) => pattern.endsWith('*') && pk.startsWith(pattern.slice(0, -1))), pk).toBe(true);
    expect(patterns.some((pattern) => 'UNRELATED#teen'.startsWith(pattern.slice(0, -1)))).toBe(false);
    expect(patterns.some((pattern) => 'HH#synthetic'.startsWith(pattern.slice(0, -1)))).toBe(false);
  });
  it('prepares stage-scoped IAM metadata reads and prohibits direct deletion, application flags and content access', () => {
    const template = JSON.parse(readFileSync('bootstrap/privacy-operator.template.json', 'utf8'));
    const role = template.Resources.PrivacyOperator.Properties;
    const statements = role.Policies[0].PolicyDocument.Statement;
    const reads = statements.find((item: any) => item.Sid === 'MetadataOnlyMainReads');
    expect(reads.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual([
      ...PRIVACY_OPERATOR_READ_ATTRIBUTES,
    ]);
    expect(reads.Condition.Null['dynamodb:Attributes']).toBe('false');
    expect(reads.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).not.toContain(
      'record',
    );
    for (const action of ['dynamodb:DeleteItem', 'dynamodb:Scan', 'iam:PassRole'])
      expect(statements.flatMap((item: any) => item.Action)).not.toContain(action);
    expect(
      role.AssumeRolePolicyDocument.Statement[0].Condition.Bool['aws:MultiFactorAuthPresent'],
    ).toBe('true');
  });
});
