import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { COMMON_ACCOUNT_VERSIONS, commonAccountPrivacyDocument, ADULT_PRIVACY_VERSIONS } from '@app/api/contracts';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { changePrivacyConsent, getPrivacyStatus, requireCloudConsent, requireAdultAdmission, privacyDocumentHash, requireOwnAccountAdmission, exportOwnPrivacy } from '../lambda/privacy/consent';
import { handleEvent } from '../lambda/router';
import { verifyPrivateAdolescentRepresentation } from '../lambda/privacy/adolescents';
import { PRIVACY_OPERATOR_READ_ATTRIBUTES } from '../lambda/privacy/operator';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

const NOW = 1_800_000_000_000;
const OWNER = 'common-owner';
const ddb = mockClient(DynamoDBDocumentClient);
let rows: Map<string, Record<string, unknown>>;
const key = (item: { pk?: unknown; sk?: unknown }) => `${item.pk}/${item.sk}`;
const profile = (): ProfileItem => ({ ...K.profile(OWNER), userId: OWNER, username: OWNER, displayName: OWNER, accountType: 'adult', socialEnabled: true, createdAt: NOW - 1000, status: 'active' });
const deps = (): Deps => ({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}), table: 'main', privacyTable: 'privacy', userPoolId: 'pool', now: () => NOW });
const ctx = () => ({ callerId: OWNER, caller: rows.get(key(K.profile(OWNER))) as unknown as ProfileItem, authenticatedAt: NOW - 1000, emailVerified: true, deps: deps() });
const commonCommand = (action: string, revision = 0, overrides: Record<string, unknown> = {}) => ({ action, commandId: `${action}-${revision}`, expectedRevision: revision, language: 'es', documentFamily: 'common', ...COMMON_ACCOUNT_VERSIONS, documentHash: createHash('sha256').update(JSON.stringify(commonAccountPrivacyDocument('es'))).digest('hex'), ...(action === 'accept_account_terms' ? { acceptTerms: true } : action === 'grant_cloud' ? { accepted: true } : {}), ...overrides });
async function enroll() { return changePrivacyConsent(ctx(), commonCommand('accept_account_terms')); }

beforeEach(() => {
  vi.stubEnv('ADULT_PRIVACY_MODE', 'enforce'); ddb.reset();
  rows = new Map([[key(K.profile(OWNER)), profile() as unknown as Record<string, unknown>]]);
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(key(input.Key ?? {})) }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).callsFake((input) => { for (const item of input.TransactItems ?? []) { if (item.Put?.Item) rows.set(key(item.Put.Item), item.Put.Item); if (item.Delete?.Key) rows.delete(key(item.Delete.Key)); } return {}; });
});
afterEach(() => vi.unstubAllEnvs());

describe('common account privacy admission', () => {
  it('records only affirmative account terms, with immutable document and server identity', async () => {
    expect(await enroll()).toMatchObject({ accountAdmission: 'standard', accountTermsAccepted: true, adultDeclared: false, cloudConsent: 'absent', canUseCloud: false, revision: 1 });
    const state = rows.get(`${K.user(OWNER)}/PRIVACY#ADULT`)!;
    expect(state).toMatchObject({ accountTermsAcceptedAt: NOW, accountTermsLanguage: 'es' });
    expect(state).not.toHaveProperty('adultDeclaredAt');
    const evidence = rows.get(`${K.user(OWNER)}/PRIVACY#COMMAND#accept_account_terms-0`)!;
    expect(evidence).toMatchObject({ userId: OWNER, action: 'accept_account_terms', document: commonAccountPrivacyDocument('es'), authentication: 'verified_jwt_subject' });
  });

  it.each([{ acceptTerms: false }, { documentHash: 'f'.repeat(64) }, { termsVersion: 'forged' }, { userId: 'another' }, { documentFamily: 'legacy' }])('rejects invalid common acceptance without writing: %j', async (change) => {
    await expect(changePrivacyConsent(ctx(), commonCommand('accept_account_terms', 0, change))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('replays exact acceptance and rejects command reuse and stale revisions', async () => {
    const first = await enroll(); const count = ddb.commandCalls(TransactWriteCommand).length;
    expect(await enroll()).toEqual(first); expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(count);
    await expect(changePrivacyConsent(ctx(), commonCommand('accept_account_terms', 0, { expectedRevision: 1 }))).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
    await expect(changePrivacyConsent(ctx(), commonCommand('grant_cloud', 0))).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
  });

  it('requires an explicit separate common cloud grant, without declaring adulthood', async () => {
    await enroll(); await expect(requireCloudConsent(ctx(), OWNER)).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
    expect(await changePrivacyConsent(ctx(), commonCommand('grant_cloud', 1))).toMatchObject({ accountAdmission: 'standard', adultDeclared: false, cloudConsent: 'granted', canUseCloud: true });
    expect(await requireCloudConsent(ctx(), OWNER)).toMatchObject({ revision: 2 });
    await changePrivacyConsent(ctx(), commonCommand('revoke_cloud', 2));
    await expect(requireCloudConsent(ctx(), OWNER)).rejects.toMatchObject({ code: 'CLOUD_CONSENT_REQUIRED' });
  });

  it('does not grant common cloud from an unenrolled profile', async () => {
    await expect(changePrivacyConsent(ctx(), commonCommand('grant_cloud'))).rejects.toMatchObject({ code: 'ACCOUNT_TERMS_REQUIRED' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['off', 'enforce'])('allows common own admission while denying family/social authority in %s mode', async (mode) => {
    await enroll(); vi.stubEnv('ADULT_PRIVACY_MODE', mode);
    await expect(requireOwnAccountAdmission(ctx())).resolves.toBeUndefined();
    await expect(requireAdultAdmission(ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const path of ['/friends', '/family/household']) {
      const result = await handleEvent({ rawPath: `/v1${path}`, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: OWNER } } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer, deps());
      expect(result.statusCode).toBe(403);
    }
    await changePrivacyConsent(ctx(), commonCommand('grant_cloud', 1));
    const sync = await handleEvent({ rawPath: '/v1/sync/changes', requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: OWNER } } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer, deps());
    expect(sync.statusCode).toBe(200); expect(JSON.parse(sync.body)).toMatchObject({ changes: [] });
  });

  it('denies common enrollment for existing private/minor/closing profiles', async () => {
    for (const change of [{ accountType: 'minor' }, { privacyMode: 'adolescent_private' }, { status: 'closing' }]) {
      rows.set(key(K.profile(OWNER)), { ...profile(), ...change });
      await expect(enroll()).rejects.toMatchObject({ code: change.status ? 'CONFLICT' : 'FORBIDDEN' });
    }
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('preserves valid historical adulthood and cloud evidence when common terms are accepted', async () => {
    const legacy = { ...ADULT_PRIVACY_VERSIONS, language: 'es', documentHash: privacyDocumentHash('es') };
    await changePrivacyConsent(ctx(), { ...legacy, action: 'declare_adult', commandId: 'legacy-adult', expectedRevision: 0, declareAdult: true, acceptTerms: true });
    await changePrivacyConsent(ctx(), { ...legacy, action: 'grant_cloud', commandId: 'legacy-cloud', expectedRevision: 1, accepted: true });
    expect(await changePrivacyConsent(ctx(), commonCommand('accept_account_terms', 2))).toMatchObject({ adultDeclared: true, cloudConsent: 'granted', canUseCloud: true, accountAdmission: 'standard' });
    expect((await getPrivacyStatus(ctx())).adultDeclared).toBe(true);
  });

  it('exports common decisions and prevents restored stale admission from overriding the ledger', async () => {
    await enroll(); const previous = structuredClone(rows.get(`${K.user(OWNER)}/PRIVACY#ADULT`)!);
    await changePrivacyConsent(ctx(), commonCommand('grant_cloud', 1));
    ddb.on(QueryCommand).resolves({ Items: [...rows.values()].filter((item) => item.pk === K.user(OWNER)) });
    const exported = await exportOwnPrivacy(ctx());
    expect(exported.privacy.some((item) => item.accountTermsAcceptedAt === NOW)).toBe(true);
    expect(exported.privacy.some((item) => item.action === 'accept_account_terms' && item.documentFamily === 'common')).toBe(true);
    rows.set(`${K.user(OWNER)}/PRIVACY#ADULT`, previous);
    await expect(requireOwnAccountAdmission(ctx())).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
  });

  it('does not migrate common enrollment through the historical private invitation path', async () => {
    vi.stubEnv('PRIVATE_ADOLESCENT_MODE', 'enforce');
    await enroll(); const before = ddb.commandCalls(TransactWriteCommand).length;
    await expect(changePrivacyConsent(ctx(), { action: 'accept_adolescent', commandId: 'private-attempt', expectedRevision: 1, language: 'es', ...ADULT_PRIVACY_VERSIONS, documentHash: privacyDocumentHash('es'), invitationId: 'a'.repeat(64), acceptTerms: true, understandsPrivacy: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(before);
    expect(rows.get(key(K.profile(OWNER)))?.privacyMode).toBeUndefined();
  });

  it('verifies an existing invitation for a historical guardian with common evidence only with the full metadata projection', async () => {
    const legacy = { ...ADULT_PRIVACY_VERSIONS, language: 'es', documentHash: privacyDocumentHash('es') };
    await changePrivacyConsent(ctx(), { ...legacy, action: 'declare_adult', commandId: 'legacy-guardian', expectedRevision: 0, declareAdult: true, acceptTerms: true });
    await changePrivacyConsent(ctx(), commonCommand('accept_account_terms', 1));
    await changePrivacyConsent(ctx(), commonCommand('grant_cloud', 2));
    const invitationId = 'b'.repeat(64);
    rows.set(`ADOLESCENT_INVITE#${invitationId}/STATE`, { pk: `ADOLESCENT_INVITE#${invitationId}`, sk: 'STATE', invitationId, state: 'pending_verification', revision: 1, guardianId: OWNER, recipientUsername: 'legacy_teen', majorityAt: '2030-01-01', expiresAt: NOW + 86400000, language: 'es', documentHash: privacyDocumentHash('es') });
    const command = { invitationId, commandId: 'verified-existing-invitation', expectedRevision: 1, caseId: 'verified-case', guardianId: OWNER, recipientUsername: 'legacy_teen', majorityAt: '2030-01-01' };
    const operator = { roleArn: 'arn:aws:iam::765932874577:role/roadmap2u/dev/operators/roadmap2u-dev-privacy-operator', arn: 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-privacy-operator/test' };
    const commonFields = new Set(['accountTermsAcceptedAt', 'accountTermsLanguage', 'accountTermsDocumentHash', 'cloudDocumentFamily']);
    let allowed: readonly string[] = PRIVACY_OPERATOR_READ_ATTRIBUTES.filter((field) => !commonFields.has(field));
    ddb.on(GetCommand).callsFake((input) => {
      const item = rows.get(key(input.Key ?? {}));
      return { Item: item && input.TableName === 'main' ? Object.fromEntries(Object.entries(item).filter(([field]) => allowed.includes(field))) : item };
    });
    const before = ddb.commandCalls(TransactWriteCommand).length;
    await expect(verifyPrivateAdolescentRepresentation(deps(), command, operator)).rejects.toMatchObject({ code: 'PRIVACY_REVISION_CONFLICT' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(before);
    allowed = PRIVACY_OPERATOR_READ_ATTRIBUTES;
    await expect(verifyPrivateAdolescentRepresentation(deps(), command, operator)).resolves.toBeUndefined();
    expect(rows.get(`ADOLESCENT_INVITE#${invitationId}/STATE`)).toMatchObject({ state: 'authorized', authorizationMethod: 'operator_verified' });
  });
});
