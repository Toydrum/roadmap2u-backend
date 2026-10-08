import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type TransactGetCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { ADULT_PRIVACY_VERSIONS, type PrivacyConsentCommand } from '@app/api/contracts';
import { K, type ProfileItem } from '../lambda/db';
import {
  createPrivateAdolescentInvitation,
  listPrivateAdolescentInvitations,
  changePrivateAdolescentGuardianConsent,
  verifyPrivateAdolescentRepresentation,
} from '../lambda/privacy/adolescents';
import {
  changePrivacyConsent,
  getPrivacyStatus,
  privacyDocumentHash,
  requireCloudConsent,
  cloudConsentConditions,
  recheckCloudConsent,
  privacyCalendarDate,
} from '../lambda/privacy/consent';
import { privacySnapshotHash } from '../lambda/privacy/retention';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { pushSync } from '../lambda/handlers/sync';
import { handleEvent } from '../lambda/router';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { CONTRACT_VERSION } from '@app/api/contracts';
import { SCHEMA_VERSION, newSyncBase } from '@app/db/schema';
import { FK, householdIdForPrimary } from '../lambda/family/keys';
const NOW = Date.parse('2026-10-07T16:00:00Z');
const ddb = mockClient(DynamoDBDocumentClient);
const rows = new Map<string, any>();
const profile = (id: string): ProfileItem => ({
  ...K.profile(id),
  userId: id,
  username: id,
  displayName: id,
  accountType: 'adult',
  socialEnabled: false,
  createdAt: NOW,
  status: 'active',
  familyFenceVersion: 1,
});
const ctx = (id: string) => ({
  callerId: id,
  caller: rows.get(`main/USER#${id}/PROFILE`) as ProfileItem,
  authenticatedAt: NOW,
  emailVerified: true,
  deps: {
    table: 'main',
    privacyTable: 'privacy',
    userPoolId: 'pool',
    now: () => NOW,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
  },
});
const metadata = (id: string, revision = 0) => ({
  commandId: id,
  expectedRevision: revision,
  language: 'es' as const,
  ...ADULT_PRIVACY_VERSIONS,
  documentHash: privacyDocumentHash('es'),
});
function key(table: string, item: any) {
  return `${table}/${item.pk}/${item.sk}`;
}
beforeEach(() => {
  vi.stubEnv('ADULT_PRIVACY_MODE', 'enforce');
  vi.stubEnv('PRIVATE_ADOLESCENT_MODE', 'enforce');
  ddb.reset();
  rows.clear();
  for (const id of ['parent', 'teen', 'other']) rows.set(key('main', profile(id)), profile(id));
  rows.set('main/USER#parent/SUBSCRIPTION#INDIVIDUAL', {
    pk: 'USER#parent',
    sk: 'SUBSCRIPTION#INDIVIDUAL',
    entityType: 'SubscriptionSource',
    ownerSub: 'parent',
    sourceId: 'parent-premium',
    state: 'active',
    paidThrough: NOW + 86_400_000,
    graceUntil: null,
    revision: 1,
    updatedAt: NOW,
  });
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(key(input.TableName!, input.Key)) }));
  ddb.on(TransactGetCommand).callsFake((input: TransactGetCommandInput) => ({
    Responses: input.TransactItems?.map((item) => ({
      Item: rows.get(key(item.Get!.TableName!, item.Get!.Key)),
    })),
  }));
  ddb.on(QueryCommand).callsFake((input) => ({
    Items: [...rows.entries()]
      .filter(
        ([k, row]) =>
          k.startsWith(`${input.TableName}/`) &&
          (input.IndexName ? row.gsi1pk : row.pk) === input.ExpressionAttributeValues?.[':pk'] &&
          (!input.ExpressionAttributeValues?.[':prefix'] ||
            (input.IndexName ? row.gsi1sk : row.sk).startsWith(
              input.ExpressionAttributeValues[':prefix'],
            )),
      )
      .map(([, row]) => row),
  }));
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? []) {
      if (item.Put) rows.set(key(item.Put.TableName!, item.Put.Item), item.Put.Item);
      if (item.Update) {
        const row = { ...rows.get(key(item.Update.TableName!, item.Update.Key)) };
        const set = item.Update.UpdateExpression?.split('REMOVE')[0].replace(/^SET /, '') ?? '';
        for (const pair of set.split(',')) {
          const [name, value] = pair.trim().split(/\s*=\s*/);
          if (value?.startsWith(':'))
            row[item.Update.ExpressionAttributeNames?.[name] ?? name] =
              item.Update.ExpressionAttributeValues?.[value];
        }
        rows.set(key(item.Update.TableName!, item.Update.Key), row);
      }
    }
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());
async function declareParent() {
  await changePrivacyConsent(ctx('parent'), {
    ...metadata('parent-decl'),
    action: 'declare_adult',
    declareAdult: true,
    acceptTerms: true,
  });
}
async function invitation() {
  await declareParent();
  return createPrivateAdolescentInvitation(ctx('parent'), {
    ...metadata('invite-1'),
    recipientUsername: 'teen',
    guardianName: 'María Pérez',
    guardianRelationship: 'parent',
    majorityAt: '2029-10-07',
    representsMinor: true,
    authorizesCloud: true,
  });
}
function authorize(id: string) {
  const row = rows.get(`privacy/ADOLESCENT_INVITE#${id}/STATE`);
  delete row.attestation;
  rows.set(`privacy/ADOLESCENT_INVITE#${id}/STATE`, {
    ...row,
    state: 'authorized',
    authorizationMethod: 'operator_verified',
    revision: row.revision + 1,
    representationVerifiedAt: NOW,
    verificationCaseId: 'verified-case-1',
  });
}
const acceptance = (id: string): PrivacyConsentCommand => ({
  ...metadata('teen-admission'),
  action: 'accept_adolescent',
  invitationId: id,
  acceptTerms: true,
  understandsPrivacy: true,
});
describe('private adolescent admission', () => {
  it.each(['account_attestation', 'operator_verified', 'legacy_operator_verified'] as const)(
    'serializes a complete authorization condition for %s acceptance',
    async (method) => {
      const invite = await invitation();
      if (method !== 'account_attestation') authorize(invite.invitationId);
      const stored = rows.get(`privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`);
      if (method === 'legacy_operator_verified') delete stored.authorizationMethod;
      await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
      const command = ddb.commandCalls(TransactWriteCommand).at(-1)!.args[0];
      const put = command.input.TransactItems!.find(
        (item) =>
          item.Put?.TableName === 'privacy' &&
          item.Put.Item?.pk === `ADOLESCENT_INVITE#${invite.invitationId}`,
      )!.Put!;
      // Exercise the same AWS serialization option as the runtime. A document
      // client mock accepts undefined values and does not validate expressions.
      const values = marshall(put.ExpressionAttributeValues!, { removeUndefinedValues: true });
      const required = [...new Set(put.ConditionExpression!.match(/:[A-Za-z0-9_]+/g))].sort();
      expect(Object.keys(values).sort()).toEqual(required);
      if (method === 'account_attestation') {
        expect(stored.representationVerifiedAt).toBeUndefined();
        expect(put.ConditionExpression).toMatch(/authorizationMethod\s*=/);
        expect(put.ConditionExpression).toMatch(/attestation\s*=/);
        expect(Object.values(put.ExpressionAttributeValues!)).toContainEqual(stored.attestation);
      } else {
        expect(put.ConditionExpression).toMatch(/representationVerifiedAt\s*=/);
        expect(Object.values(put.ExpressionAttributeValues!)).toContain(NOW);
      }
    },
  );
  it.each([true, 'true', false, 'false', undefined, 'True', 1])(
    'takes email confirmation only from verified authorizer claims: %s',
    async (emailVerified) => {
      await declareParent();
      const response = await handleEvent(
        {
          rawPath: '/v1/privacy/adolescents',
          requestContext: {
            http: { method: 'POST' },
            authorizer: {
              jwt: {
                claims: {
                  sub: 'parent',
                  auth_time: String(NOW / 1000),
                  email_verified: emailVerified,
                },
              },
            },
          },
          body: JSON.stringify({
            ...metadata('jwt-invite'),
            recipientUsername: 'teen',
            majorityAt: '2029-10-07',
            guardianName: 'María Pérez',
            guardianRelationship: 'parent',
            representsMinor: true,
            authorizesCloud: true,
          }),
        } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
        ctx('parent').deps,
      );
      if (emailVerified === true || emailVerified === 'true') {
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          state: 'authorized',
          authorizationMethod: 'account_attestation',
        });
      } else {
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body)).toMatchObject({
          error: { code: 'EMAIL_VERIFICATION_REQUIRED' },
        });
        expect([...rows.keys()].some((key) => key.includes('ADOLESCENT_INVITE#'))).toBe(false);
      }
    },
  );
  it.each([
    { guardianName: '' },
    { guardianRelationship: 'friend' },
    { representsMinor: false },
    { authorizesCloud: false },
    { emailVerified: true },
    { representationVerifiedAt: NOW },
  ])('rejects missing declarations and client-supplied verification: %j', async (overrides) => {
    await declareParent();
    await expect(
      createPrivateAdolescentInvitation(ctx('parent'), {
        ...metadata('invalid-attestation'),
        recipientUsername: 'teen',
        majorityAt: '2029-10-07',
        guardianName: 'María Pérez',
        guardianRelationship: 'parent',
        representsMinor: true,
        authorizesCloud: true,
        ...overrides,
      } as any),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect([...rows.keys()].some((key) => key.includes('ADOLESCENT_INVITE#'))).toBe(false);
  });
  it('does not issue an invitation when responsible Premium changes during its conditional write', async () => {
    await declareParent();
    ddb.on(TransactWriteCommand).callsFake((input) => {
      expect(
        input.TransactItems.some(
          (item: any) => item.ConditionCheck?.Key?.sk === 'SUBSCRIPTION#INDIVIDUAL',
        ),
      ).toBe(true);
      throw Object.assign(new Error('conditional Premium revocation'), {
        name: 'TransactionCanceledException',
      });
    });
    await expect(
      createPrivateAdolescentInvitation(ctx('parent'), {
        ...metadata('raced-invite'),
        recipientUsername: 'teen',
        majorityAt: '2029-10-07',
        guardianName: 'María Pérez',
        guardianRelationship: 'parent',
        representsMinor: true,
        authorizesCloud: true,
      }),
    ).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
    expect([...rows.keys()].some((key) => key.includes('ADOLESCENT_INVITE#'))).toBe(false);
  });
  it('keeps identical invitation retries stable and denies a changed declaration', async () => {
    const invite = await invitation();
    expect(await invitation()).toEqual(invite);
    await expect(
      createPrivateAdolescentInvitation(ctx('parent'), {
        ...metadata('invite-1'),
        recipientUsername: 'teen',
        majorityAt: '2029-10-07',
        guardianName: 'Otro nombre',
        guardianRelationship: 'parent',
        representsMinor: true,
        authorizesCloud: true,
      }),
    ).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
  });
  it('admits the exact confirmed adolescent from an authenticated declaration without an operator', async () => {
    const invite = await invitation();
    expect(invite).toMatchObject({
      state: 'authorized',
      authorizationMethod: 'account_attestation',
    });
    const item = rows.get(`privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`);
    expect(item.attestation).toEqual({
      subjectId: 'parent',
      authenticatedAt: NOW,
      emailVerified: true,
      declaredName: 'María Pérez',
      relationship: 'parent',
      declaredAt: NOW,
    });
    expect(item.representationVerifiedAt).toBeUndefined();
    expect(item.verificationCaseId).toBeUndefined();
    expect(item.verifiedBy).toBeUndefined();
    expect(await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId))).toMatchObject({
      scope: 'adolescent_private',
      privateOnly: true,
      canUseCloud: false,
    });
    expect(rows.get('main/USER#teen/PRIVACY#ADULT').guardianAuthorization).toEqual({
      method: 'account_attestation',
      attestation: item.attestation,
    });
    expect([...rows.keys()].some((key) => key.includes('PRIVACY_OPERATOR#'))).toBe(false);
  });
  it.each([false, undefined])(
    'rejects an unconfirmed responsible email: %s',
    async (emailVerified) => {
      await declareParent();
      await expect(
        createPrivateAdolescentInvitation(
          { ...ctx('parent'), emailVerified },
          {
            ...metadata('unconfirmed'),
            recipientUsername: 'teen',
            majorityAt: '2029-10-07',
            guardianName: 'María Pérez',
            guardianRelationship: 'parent',
            representsMinor: true,
            authorizesCloud: true,
          },
        ),
      ).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
      expect([...rows.keys()].some((key) => key.includes('ADOLESCENT_INVITE#'))).toBe(false);
    },
  );
  it('rejects stale authentication even when the bearer is renewed', async () => {
    await declareParent();
    await expect(
      createPrivateAdolescentInvitation(
        { ...ctx('parent'), authenticatedAt: NOW - 16 * 60000 },
        {
          ...metadata('stale'),
          recipientUsername: 'teen',
          majorityAt: '2029-10-07',
          guardianName: 'María Pérez',
          guardianRelationship: 'parent',
          representsMinor: true,
          authorizesCloud: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
  });
  it('requires current Premium before issuing an invitation', async () => {
    await declareParent();
    rows.delete('main/USER#parent/SUBSCRIPTION#INDIVIDUAL');
    await expect(
      createPrivateAdolescentInvitation(ctx('parent'), {
        ...metadata('free-parent'),
        recipientUsername: 'teen',
        majorityAt: '2029-10-07',
        guardianName: 'María Pérez',
        guardianRelationship: 'parent',
        representsMinor: true,
        authorizesCloud: true,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });
  it('requires the recipient email to be confirmed and its session recent', async () => {
    const invite = await invitation();
    await expect(
      changePrivacyConsent(
        { ...ctx('teen'), emailVerified: false },
        acceptance(invite.invitationId),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    await expect(
      changePrivacyConsent(
        { ...ctx('teen'), authenticatedAt: NOW - 16 * 60000 },
        acceptance(invite.invitationId),
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect(rows.get('main/USER#teen/PROFILE').accountType).toBe('adult');
  });
  it('does not authorize a legacy pending invitation by reading or accepting it', async () => {
    const invite = await invitation();
    const key = `privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`;
    const item = rows.get(key);
    delete item.attestation;
    delete item.authorizationMethod;
    rows.set(key, { ...item, state: 'pending_verification' });
    expect((await listPrivateAdolescentInvitations(ctx('parent')))[0].state).toBe(
      'pending_verification',
    );
    await expect(
      changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rows.get(key).state).toBe('pending_verification');
  });
  it('keeps both consents but denies private cloud when the responsible adult has no Premium', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    rows.delete('main/USER#parent/SUBSCRIPTION#INDIVIDUAL');
    expect(await getPrivacyStatus(ctx('teen'))).toMatchObject({
      guardianConsent: 'granted',
      cloudConsent: 'granted',
      canUseCloud: false,
      cloudCoverage: { kind: 'responsible_premium', state: 'unavailable' },
    });
    await expect(requireCloudConsent(ctx('teen'), 'teen')).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(rows.get('main/USER#teen/PROFILE').accountType).toBe('minor');
    expect(
      await import('../lambda/privacy/consent').then(({ exportOwnPrivacy }) =>
        exportOwnPrivacy(ctx('teen')),
      ),
    ).toMatchObject({ userId: 'teen' });
  });
  it('fences the responsible adult ACCESS and paid sources without granting the adolescent Premium', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    const guard = (await requireCloudConsent(ctx('teen'), 'teen'))!;
    expect(
      cloudConsentConditions(ctx('teen').deps, guard).map((item) => item.ConditionCheck?.Key),
    ).toEqual(
      expect.arrayContaining([
        { pk: 'USER#parent', sk: 'ACCESS' },
        { pk: 'USER#parent', sk: 'SUBSCRIPTION#INDIVIDUAL' },
        { pk: 'USER#parent', sk: 'COVERAGE#FAMILY' },
      ]),
    );
    expect(await getPrivacyStatus(ctx('teen'))).toMatchObject({
      canUseCloud: true,
      cloudCoverage: { kind: 'responsible_premium', state: 'active', validUntil: NOW + 86_400_000 },
    });
    expect(rows.has('main/USER#teen/ACCESS')).toBe(false);
    expect(rows.has('main/USER#teen/GRANT#private-cloud')).toBe(false);
  });
  it('rechecks expiry and a paid-source revocation even when the responsible adult ACCESS was not updated', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    const guard = (await requireCloudConsent(ctx('teen'), 'teen'))!;
    const expired = { ...ctx('teen'), deps: { ...ctx('teen').deps, now: () => NOW + 86_400_000 } };
    await expect(recheckCloudConsent(expired, guard)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    const source = rows.get('main/USER#parent/SUBSCRIPTION#INDIVIDUAL');
    rows.set('main/USER#parent/SUBSCRIPTION#INDIVIDUAL', {
      ...source,
      state: 'revoked',
      revision: 2,
    });
    await expect(recheckCloudConsent(ctx('teen'), guard)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(rows.get('main/USER#teen/PRIVACY#ADULT').cloudConsent).toBe('granted');
  });
  it('requires authorization before the named adolescent can accept a legacy invitation', async () => {
    const invite = await invitation();
    const key = `privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`;
    const item = rows.get(key);
    delete item.authorizationMethod;
    delete item.attestation;
    rows.set(key, { ...item, state: 'pending_verification' });
    await expect(
      changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    authorize(invite.invitationId);
    await expect(
      changePrivacyConsent(ctx('other'), acceptance(invite.invitationId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rows.get('main/USER#teen/PROFILE').accountType).toBe('adult');
  });
  it('creates a private minor without family links or Premium, with cloud still requiring their separate choice', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    const accepted = await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    expect(accepted).toMatchObject({
      scope: 'adolescent_private',
      privateOnly: true,
      guardianConsent: 'granted',
      canUseCloud: false,
    });
    expect(rows.get('main/USER#teen/PROFILE')).toMatchObject({
      accountType: 'minor',
      socialEnabled: false,
      privacyMode: 'adolescent_private',
    });
    expect(
      [...rows.keys()]
        .filter((k) => k.startsWith('main/'))
        .some((k) => /GUARDIAN#|FAMILY_COVERAGE|SUPERVISION#|ENTITLEMENT/.test(k)),
    ).toBe(false);
    const granted = await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', accepted.revision),
      action: 'grant_cloud',
      accepted: true,
    });
    expect(granted.canUseCloud).toBe(true);
    expect((await listPrivateAdolescentInvitations(ctx('parent')))[0]).toMatchObject({
      adolescentId: 'teen',
      state: 'accepted',
    });
  });
  it.each(['2033-10-08', '2026-10-07', '2029-02-30'])(
    'rejects dates outside the 12-to-17 admission range or invalid dates: %s',
    async (majorityAt) => {
      await declareParent();
      await expect(
        createPrivateAdolescentInvitation(ctx('parent'), {
          ...metadata('bad-invite'),
          recipientUsername: 'teen',
          guardianName: 'María Pérez',
          guardianRelationship: 'parent',
          majorityAt,
          representsMinor: true,
          authorizesCloud: true,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    },
  );
  it('does not convert an account that already declared itself adult', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('adult-decl'),
      action: 'declare_adult',
      declareAdult: true,
      acceptTerms: true,
    });
    await expect(
      changePrivacyConsent(ctx('teen'), {
        ...acceptance(invite.invitationId),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('withdrawal by the representative stops cloud, while replaying admission cannot restore it', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    await expect(
      changePrivateAdolescentGuardianConsent(ctx('other'), 'teen', {
        ...metadata('rogue', 2),
        action: 'revoke_guardian',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const revoked = await changePrivateAdolescentGuardianConsent(ctx('parent'), 'teen', {
      ...metadata('parent-revoke', 2),
      action: 'revoke_guardian',
    });
    expect(revoked).toMatchObject({
      guardianConsent: 'revoked',
      canUseCloud: false,
      privateOnly: true,
    });
    await expect(requireCloudConsent(ctx('teen'), 'teen')).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
    expect(await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId))).toMatchObject({
      revision: 3,
      canUseCloud: false,
    });
  });
  it('fences the representative’s account and decision in every cloud write', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('teen-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    const guard = (await requireCloudConsent(ctx('teen'), 'teen'))!;
    const keys = cloudConsentConditions(ctx('teen').deps, guard).map(
      (item) => item.ConditionCheck?.Key,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        K.profile('parent'),
        { pk: 'ACCOUNT_CLOSURE#parent', sk: 'STATE' },
        { pk: 'PRIVACY_STATE#parent', sk: 'STATE' },
      ]),
    );
    rows.set('main/ACCOUNT_CLOSURE#parent/STATE', { state: 'requested' });
    await expect(requireCloudConsent(ctx('teen'), 'teen')).rejects.toMatchObject({
      code: 'CLOUD_CONSENT_REQUIRED',
    });
    expect(await getPrivacyStatus(ctx('teen'))).toMatchObject({ canUseCloud: false });
  });
  it('requires renewed personal acceptance after the explanation changes, without reviving a withdrawn authorization', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivateAdolescentGuardianConsent(ctx('parent'), 'teen', {
      ...metadata('withdraw', 1),
      action: 'revoke_guardian',
    });
    const old = rows.get('main/USER#teen/PRIVACY#ADULT');
    const stale = { ...old, adolescentDocumentHash: '0'.repeat(64) };
    rows.set('main/USER#teen/PRIVACY#ADULT', stale);
    rows.set('privacy/PRIVACY_STATE#teen/STATE', {
      pk: 'PRIVACY_STATE#teen',
      sk: 'STATE',
      userId: 'teen',
      revision: stale.revision,
      updatedAt: stale.updatedAt,
      snapshot: stale,
      snapshotHash: privacySnapshotHash(stale),
    });
    expect(await getPrivacyStatus(ctx('teen'))).toMatchObject({
      adolescentUnderstood: false,
      canUseCloud: false,
    });
    await expect(
      changePrivacyConsent(ctx('teen'), {
        ...metadata('stale-cloud', 2),
        action: 'grant_cloud',
        accepted: true,
      }),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
    const renewed = await changePrivacyConsent(ctx('teen'), {
      ...acceptance(invite.invitationId),
      commandId: 'renew-explanation',
      expectedRevision: 2,
    });
    expect(renewed).toMatchObject({
      adolescentUnderstood: true,
      guardianConsent: 'revoked',
      cloudConsent: 'revoked',
      canUseCloud: false,
    });
    await expect(
      changePrivacyConsent(ctx('teen'), {
        ...metadata('still-revoked', 3),
        action: 'grant_cloud',
        accepted: true,
      }),
    ).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });
  it('rejects conversion of an existing primary household even when its secondary index is empty', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    const item = { ...FK.household(householdIdForPrimary('teen')), primaryResponsibleId: 'teen' };
    rows.set(key('main', item), item);
    await expect(
      changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(rows.get('main/USER#teen/PROFILE').accountType).toBe('adult');
  });
  it('ends parental authority at 18 and keeps the forest and private restriction after personal adult consent', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    const due = ctx('teen');
    due.deps.now = () => Date.parse('2029-10-07T12:00:00Z');
    rows.set('main/USER#teen/REC#nodes/note', { note: 'private forest survives' });
    await expect(
      changePrivateAdolescentGuardianConsent(
        { ...ctx('parent'), authenticatedAt: due.deps.now(), deps: due.deps },
        'teen',
        { ...metadata('too-late', 1), action: 'revoke_guardian' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireCloudConsent(due, 'teen')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const result = await changePrivacyConsent(due, {
      ...metadata('adult-now', 1),
      action: 'declare_adult',
      declareAdult: true,
      acceptTerms: true,
    });
    expect(result).toMatchObject({
      scope: 'adult',
      adultDeclared: true,
      guardianConsent: 'ended',
      canUseCloud: false,
      privateOnly: true,
    });
    expect(rows.get('main/USER#teen/PROFILE')).toMatchObject({
      accountType: 'adult',
      socialEnabled: false,
    });
    expect(rows.get('main/USER#teen/REC#nodes/note')).toEqual({ note: 'private forest survives' });
  });
  it('uses the Mexican civil date for age boundaries', () => {
    expect(privacyCalendarDate(Date.parse('2026-10-08T03:00:00Z'))).toBe('2026-10-07');
  });
  it('keeps private minors on Free even if an old personal Premium source survived technical admission', async () => {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    const subscription = {
      ...rows.get('main/USER#parent/SUBSCRIPTION#INDIVIDUAL'),
      pk: 'USER#teen',
      ownerSub: 'teen',
      sourceId: 'old-personal-source',
    };
    const access = deriveAccessItem('teen', NOW, undefined, [], {
      subscription,
      ownerProfile: rows.get('main/USER#teen/PROFILE'),
    });
    expect(access).toMatchObject({
      effectivePlanKey: 'free',
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    });
  });
  async function privateSyncFixture() {
    const invite = await invitation();
    authorize(invite.invitationId);
    await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId));
    await changePrivacyConsent(ctx('teen'), {
      ...metadata('own-cloud', 1),
      action: 'grant_cloud',
      accepted: true,
    });
    rows.set('main/COMMERCIAL#CONFIG/FLAGS', {
      pk: 'COMMERCIAL#CONFIG',
      sk: 'FLAGS',
      revision: 1,
      quotaMode: 'enforce',
      capabilityMode: 'enforce',
      accessCodeIssuanceEnabled: false,
      accessCodeRedemptionEnabled: false,
      premiumPaymentsEnabled: false,
      updatedAt: NOW,
      updatedBy: 'test',
      reason: 'privacy sync check',
    });
    rows.set('main/USER#teen/USAGE', {
      pk: 'USER#teen',
      sk: 'USAGE',
      state: 'active',
      activeTrees: 0,
      activeGeneration: 'private-gen',
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'private-sync-group',
          expectedCount: 1,
          records: [
            {
              store: 'checkins' as const,
              record: {
                ...newSyncBase(NOW),
                id: 'private-checkin',
                feeling: 'sunny' as const,
                note: 'synthetic private note',
                treeId: null,
                nodeId: null,
              },
            },
          ],
        },
      ],
    };
  }
  it('syncs through the real handler with parent Premium and writes only the private Free account', async () => {
    const payload = await privateSyncFixture();
    ddb.resetHistory();
    expect(await pushSync(ctx('teen'), payload)).toMatchObject({ applied: ['private-checkin'] });
    const writes = ddb
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? []);
    expect(rows.get(key('main', K.rec('teen', 'checkins', 'private-checkin')))?.record.note).toBe(
      'synthetic private note',
    );
    expect(rows.get('main/USER#teen/ACCESS')?.effectivePlanKey).toBe('free');
    expect(
      writes.flatMap((item) =>
        item.Put ? [item.Put.Item?.pk] : item.Update ? [item.Update.Key?.pk] : [],
      ),
    ).not.toContain('USER#parent');
    expect(
      writes.some(
        (item) =>
          item.ConditionCheck?.Key?.pk === 'USER#parent' &&
          item.ConditionCheck.Key?.sk === 'SUBSCRIPTION#INDIVIDUAL',
      ),
    ).toBe(true);
    expect([...rows.keys()].some((item) => item.startsWith('main/USER#teen/GRANT#'))).toBe(false);
  });
  it('rejects the real sync transaction if parent Premium is revoked at its conditional write', async () => {
    const payload = await privateSyncFixture();
    ddb.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      if (
        input.TransactItems?.some(
          (item) => item.Put?.Item?.sk === K.rec('teen', 'checkins', 'private-checkin').sk,
        )
      ) {
        const parent = rows.get('main/USER#parent/SUBSCRIPTION#INDIVIDUAL');
        rows.set('main/USER#parent/SUBSCRIPTION#INDIVIDUAL', {
          ...parent,
          state: 'cancelled',
          revision: parent.revision + 1,
        });
        throw Object.assign(new Error('source changed at commit'), {
          name: 'TransactionCanceledException',
          CancellationReasons: input.TransactItems.map((item) => ({
            Code:
              item.ConditionCheck?.Key?.sk === 'SUBSCRIPTION#INDIVIDUAL'
                ? 'ConditionalCheckFailed'
                : 'None',
          })),
        });
      }
      for (const item of input.TransactItems ?? [])
        if (item.Put) rows.set(key(item.Put.TableName!, item.Put.Item), item.Put.Item);
      return {};
    });
    await expect(pushSync(ctx('teen'), payload)).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    });
    expect(rows.has(key('main', K.rec('teen', 'checkins', 'private-checkin')))).toBe(false);
    expect(rows.has('main/USER#teen/MUTATION#private-sync-group')).toBe(false);
  });
  it('only the exact private IAM operator can verify representation and append its case evidence', async () => {
    const invite = await invitation();
    const key = `privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`;
    const item = rows.get(key);
    delete item.authorizationMethod;
    delete item.attestation;
    rows.set(key, { ...item, state: 'pending_verification' });
    const command = {
      invitationId: invite.invitationId,
      commandId: 'verify-1',
      expectedRevision: 1,
      caseId: 'reviewed-case-1',
      guardianId: 'parent',
      recipientUsername: 'teen',
      majorityAt: '2029-10-07',
    };
    const operator = {
      roleArn:
        'arn:aws:iam::123456789012:role/roadmap2u/dev/operators/roadmap2u-dev-privacy-operator',
      arn: 'arn:aws:sts::123456789012:assumed-role/roadmap2u-dev-privacy-operator/verified-session',
    };
    await expect(
      verifyPrivateAdolescentRepresentation(ctx('parent').deps, command, {
        ...operator,
        arn: 'arn:aws:sts::123456789012:assumed-role/router/app',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyPrivateAdolescentRepresentation(
        ctx('parent').deps,
        { ...command, recipientUsername: 'other' },
        operator,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await verifyPrivateAdolescentRepresentation(ctx('parent').deps, command, operator);
    expect(rows.get(`privacy/ADOLESCENT_INVITE#${invite.invitationId}/STATE`)).toMatchObject({
      state: 'authorized',
      verificationCaseId: 'reviewed-case-1',
    });
    expect(await changePrivacyConsent(ctx('teen'), acceptance(invite.invitationId))).toMatchObject({
      scope: 'adolescent_private',
    });
  });
});
