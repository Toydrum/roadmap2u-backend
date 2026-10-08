import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ApiError,
  adultPrivacyDocument,
  type PrivateAdolescentInvitationCommand,
  type PrivateAdolescentInvitation,
  type PrivateAdolescentGuardianCommand,
  type PrivacyConsentCommand,
  type PrivacyStatus,
} from '@app/api/contracts';
import { USERNAME_PATTERN } from '@app/auth/auth-types';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ES } from '@app/i18n/es';
import { EN } from '@app/i18n/en';
import { closureAbsenceConditionCheck, requireWritableOwner, type Ctx } from '../authz';
import { K, type Deps, type ProfileItem } from '../db';
import { FK, householdIdForPrimary } from '../family/keys';
import { createEmptySeatAssignments, createHousehold } from '../family/model';
import { requireCurrentResponsiblePremium } from './parent-premium';
import {
  isDeclared,
  privacyDocumentHash,
  privacyKey,
  privacyStatusFor,
  resolvedPrivacyStatusFor,
  readPrivacyItem,
  privateAdolescentMode,
  validatePrivacyMetadata,
  privacyCalendarDate,
  type AdultPrivacyItem,
} from './consent';
import {
  assertPrivateOperator,
  decisionLedgerPut,
  privacySnapshotHash,
  privacyTableName,
} from './retention';
type Item = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
const BASE_KEYS = [
  'commandId',
  'expectedRevision',
  'language',
  'noticeVersion',
  'termsVersion',
  'cloudConsentVersion',
  'documentHash',
];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export interface InvitationItem extends PrivateAdolescentInvitation {
  pk: string;
  sk: 'STATE';
  guardianId: string;
  createdAt: number;
  requestHash: string;
  language: 'es' | 'en';
  documentHash: string;
  document: ReturnType<typeof adultPrivacyDocument>;
  representationVerifiedAt?: number;
  verificationCaseId?: string;
  verifiedBy?: string;
  attestation?: NonNullable<AdultPrivacyItem['guardianAuthorization']>['attestation'];
  gsi1pk: string;
  gsi1sk: string;
  ttl?: number;
}
export const adolescentInvitationKey = (id: string) => ({
  pk: `ADOLESCENT_INVITE#${id}`,
  sk: 'STATE' as const,
});
export interface RepresentationVerificationCommand {
  invitationId: string;
  commandId: string;
  expectedRevision: number;
  caseId: string;
  guardianId: string;
  recipientUsername: string;
  majorityAt: string;
}
export async function verifyPrivateAdolescentRepresentation(
  deps: Deps,
  command: RepresentationVerificationCommand,
  operator: { arn: string; roleArn: string },
): Promise<void> {
  assertPrivateOperator(operator);
  if (
    !command ||
    Object.keys(command).length !== 7 ||
    Object.keys(command).some(
      (key) =>
        ![
          'invitationId',
          'commandId',
          'expectedRevision',
          'caseId',
          'guardianId',
          'recipientUsername',
          'majorityAt',
        ].includes(key),
    ) ||
    !/^[a-f0-9]{64}$/.test(command.invitationId) ||
    !SAFE.test(command.commandId) ||
    !SAFE.test(command.caseId) ||
    !SAFE.test(command.guardianId) ||
    !USERNAME_PATTERN.test(command.recipientUsername) ||
    !validMajorityDate(command.majorityAt, deps.now()) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    command.expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    throw new ApiError('VALIDATION');
  const evidenceKey = {
    pk: `PRIVACY_OPERATOR#${command.invitationId}`,
    sk: `COMMAND#${command.commandId}`,
  };
  const prior = await strong<{ requestHash: string; actor: string }>(deps, evidenceKey);
  if (prior) {
    if (prior.requestHash !== digest(command) || prior.actor !== operator.arn)
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return;
  }
  const invite = await strong<InvitationItem>(deps, adolescentInvitationKey(command.invitationId));
  if (
    !invite ||
    invite.state !== 'pending_verification' ||
    invite.revision !== command.expectedRevision ||
    invite.expiresAt <= deps.now() ||
    invite.guardianId !== command.guardianId ||
    invite.recipientUsername !== command.recipientUsername ||
    invite.majorityAt !== command.majorityAt ||
    invite.documentHash !== privacyDocumentHash(invite.language) ||
    !validMajorityDate(invite.majorityAt, deps.now())
  )
    throw new ApiError('CONFLICT');
  const parent = (
    await deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: K.profile(invite.guardianId),
        ConsistentRead: true,
      }),
    )
  ).Item;
  if (!parent) throw new ApiError('FORBIDDEN');
  const context = { deps, callerId: invite.guardianId, caller: parent as unknown as Ctx['caller'] };
  const checks = await parentConditions(context, invite.guardianId);
  const now = deps.now();
  await transact(deps, [
    ...checks,
    {
      Put: {
        TableName: privacyTableName(deps),
        Item: {
          ...invite,
          state: 'authorized',
          authorizationMethod: 'operator_verified',
          revision: invite.revision + 1,
          representationVerifiedAt: now,
          verificationCaseId: command.caseId,
          verifiedBy: operator.arn,
        },
        ConditionExpression: '#state = :pending AND revision = :revision AND guardianId = :parent',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':pending': 'pending_verification',
          ':revision': invite.revision,
          ':parent': invite.guardianId,
        },
      },
    },
    {
      Put: {
        TableName: privacyTableName(deps),
        Item: {
          ...evidenceKey,
          actor: operator.arn,
          caseId: command.caseId,
          action: 'verify_representation',
          requestHash: digest(command),
          updatedAt: now,
          ttl: invite.ttl,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ]);
}
async function strong<T>(deps: Deps, key: { pk: string; sk: string }): Promise<T | undefined> {
  return (
    await deps.ddb.send(
      new GetCommand({ TableName: privacyTableName(deps), Key: key, ConsistentRead: true }),
    )
  ).Item as T | undefined;
}
const digest = (value: object) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .digest('hex');
function validateBody(value: unknown, extraKeys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('VALIDATION');
  const record = value as Record<string, unknown>;
  const keys = [...BASE_KEYS, ...extraKeys];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  )
    throw new ApiError('VALIDATION');
  validatePrivacyMetadata(record);
}
function enabled() {
  if (privateAdolescentMode() !== 'enforce') throw new ApiError('FORBIDDEN');
}
function recent(ctx: Ctx) {
  if (
    !Number.isSafeInteger(ctx.authenticatedAt) ||
    ctx.authenticatedAt! < ctx.deps.now() - 15 * 60000 ||
    ctx.authenticatedAt! > ctx.deps.now() + 30000
  )
    throw new ApiError('REAUTHENTICATION_REQUIRED');
}
function confirmedEmail(ctx: Ctx) {
  if (ctx.emailVerified !== true) throw new ApiError('EMAIL_VERIFICATION_REQUIRED');
}
function validDeclaredName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 3 &&
    value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
/** Admission evidence; it does not verify civil identity or authorize a rights request. */
export function hasAdolescentAuthorization(item: InvitationItem): boolean {
  if (item.authorizationMethod === 'account_attestation') {
    const evidence = item.attestation;
    return (
      !!evidence &&
      evidence.subjectId === item.guardianId &&
      evidence.emailVerified === true &&
      validDeclaredName(evidence.declaredName) &&
      ['parent', 'legal_guardian'].includes(evidence.relationship) &&
      evidence.declaredAt === item.createdAt &&
      Number.isSafeInteger(evidence.authenticatedAt) &&
      evidence.authenticatedAt >= item.createdAt - 15 * 60000 &&
      evidence.authenticatedAt <= item.createdAt + 30000
    );
  }
  return (
    (item.authorizationMethod === undefined || item.authorizationMethod === 'operator_verified') &&
    Number.isSafeInteger(item.representationVerifiedAt) &&
    item.representationVerifiedAt! > 0 &&
    typeof item.verificationCaseId === 'string' &&
    SAFE.test(item.verificationCaseId)
  );
}
function validMajorityDate(value: unknown, now: number): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  const today = privacyCalendarDate(now);
  const latest = `${Number(today.slice(0, 4)) + 6}${today.slice(4)}`;
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value > today &&
    value <= latest
  );
}
function view(item: InvitationItem, now: number): PrivateAdolescentInvitation {
  return {
    invitationId: item.invitationId,
    recipientUsername: item.recipientUsername,
    majorityAt: item.majorityAt,
    state: item.state !== 'accepted' && item.expiresAt <= now ? 'expired' : item.state,
    revision: item.revision,
    expiresAt: item.expiresAt,
    ...(item.authorizationMethod ? { authorizationMethod: item.authorizationMethod } : {}),
    ...(item.adolescentId ? { adolescentId: item.adolescentId } : {}),
  };
}
async function parentConditions(ctx: Ctx, parentId: string): Promise<Item[]> {
  const parent = await requireWritableOwner(ctx, parentId);
  const state = await readPrivacyItem(ctx.deps, parentId);
  if (parent.accountType !== 'adult' || !isDeclared(state)) throw new ApiError('FORBIDDEN');
  return [
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: K.profile(parentId),
        ConditionExpression:
          'userId = :id AND accountType = :adult AND (attribute_not_exists(#status) OR #status = :active)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':id': parentId, ':adult': 'adult', ':active': 'active' },
      },
    },
    closureAbsenceConditionCheck(ctx.deps, parentId),
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: privacyKey(parentId),
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': state!.revision },
      },
    },
    {
      ConditionCheck: {
        TableName: privacyTableName(ctx.deps),
        Key: { pk: `PRIVACY_STATE#${parentId}`, sk: 'STATE' },
        ConditionExpression: 'revision = :revision AND snapshotHash = :hash',
        ExpressionAttributeValues: {
          ':revision': state!.revision,
          ':hash': privacySnapshotHash(state!),
        },
      },
    },
  ];
}
export async function guardianConditions(ctx: Ctx, state: AdultPrivacyItem): Promise<Item[]> {
  if (
    state.subjectKind !== 'adolescent_private' ||
    !state.guardianId ||
    state.guardianId === state.userId ||
    !state.majorityAt ||
    state.majorityAt <= privacyCalendarDate(ctx.deps.now()) ||
    state.guardianConsent !== 'granted' ||
    !state.guardianLanguage ||
    state.guardianDocumentHash !== privacyDocumentHash(state.guardianLanguage)
  )
    throw new ApiError('CLOUD_CONSENT_REQUIRED');
  try {
    return await parentConditions(ctx, state.guardianId);
  } catch (error) {
    if (
      error instanceof ApiError &&
      ['FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'UNAUTHENTICATED'].includes(error.code)
    )
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    throw error;
  }
}
async function transact(deps: Deps, items: Item[]) {
  try {
    await deps.ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if ((error as Error)?.name === 'TransactionCanceledException')
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    throw error;
  }
}
export async function createPrivateAdolescentInvitation(
  ctx: Ctx,
  body: PrivateAdolescentInvitationCommand,
): Promise<PrivateAdolescentInvitation> {
  enabled();
  recent(ctx);
  confirmedEmail(ctx);
  validateBody(body, [
    'recipientUsername',
    'majorityAt',
    'guardianName',
    'guardianRelationship',
    'representsMinor',
    'authorizesCloud',
  ]);
  if (
    !USERNAME_PATTERN.test(body.recipientUsername) ||
    body.recipientUsername === ctx.caller.username ||
    !validMajorityDate(body.majorityAt, ctx.deps.now()) ||
    body.representsMinor !== true ||
    body.authorizesCloud !== true ||
    !validDeclaredName(body.guardianName) ||
    !['parent', 'legal_guardian'].includes(body.guardianRelationship) ||
    body.expectedRevision !== 0
  )
    throw new ApiError('VALIDATION');
  const checks = await parentConditions(ctx, ctx.callerId);
  const id = createHash('sha256').update(`${ctx.callerId}:${body.commandId}`).digest('hex');
  const key = adolescentInvitationKey(id);
  const old = await strong<InvitationItem>(ctx.deps, key);
  if (old) {
    if (old.guardianId !== ctx.callerId || old.requestHash !== digest(body))
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return view(old, ctx.deps.now());
  }
  const premium = await requireCurrentResponsiblePremium(ctx, ctx.callerId);
  const now = ctx.deps.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const limitKey = { pk: `ADOLESCENT_GUARDIAN#${ctx.callerId}`, sk: `DAY#${day}` };
  const limit = await strong<{ requests: number }>(ctx.deps, limitKey);
  if (limit && (!Number.isSafeInteger(limit.requests) || limit.requests >= 5))
    throw new ApiError('RATE_LIMITED');
  const item: InvitationItem = {
    ...key,
    invitationId: id,
    recipientUsername: body.recipientUsername,
    guardianId: ctx.callerId,
    majorityAt: body.majorityAt,
    state: 'authorized',
    authorizationMethod: 'account_attestation',
    attestation: {
      subjectId: ctx.callerId,
      authenticatedAt: ctx.authenticatedAt!,
      emailVerified: true,
      declaredName: body.guardianName,
      relationship: body.guardianRelationship,
      declaredAt: now,
    },
    revision: 1,
    expiresAt: now + 7 * 86400000,
    createdAt: now,
    requestHash: digest(body),
    language: body.language,
    documentHash: body.documentHash,
    document: adultPrivacyDocument(body.language, body.language === 'es' ? ES : EN),
    gsi1pk: K.user(ctx.callerId),
    gsi1sk: `PRIVATE#${String(now).padStart(14, '0')}#${id}`,
    ttl: Math.ceil((now + 30 * 86400000) / 1000),
  };
  await transact(ctx.deps, [
    ...checks,
    ...premium.conditions,
    {
      Put: {
        TableName: privacyTableName(ctx.deps),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: privacyTableName(ctx.deps),
        Item: {
          ...limitKey,
          requests: (limit?.requests ?? 0) + 1,
          ttl: Math.ceil((now + 3 * 86400000) / 1000),
        },
        ConditionExpression: limit ? 'requests = :requests' : 'attribute_not_exists(pk)',
        ...(limit ? { ExpressionAttributeValues: { ':requests': limit.requests } } : {}),
      },
    },
  ]);
  return view(item, now);
}
export async function listPrivateAdolescentInvitations(
  ctx: Ctx,
): Promise<PrivateAdolescentInvitation[]> {
  const result: PrivateAdolescentInvitation[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ctx.deps.ddb.send(
      new QueryCommand({
        TableName: privacyTableName(ctx.deps),
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':pk': K.user(ctx.callerId), ':prefix': 'PRIVATE#' },
        Limit: 100,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const candidate of page.Items ?? []) {
      const item = await strong<InvitationItem>(
        ctx.deps,
        adolescentInvitationKey(candidate['invitationId'] as string),
      );
      if (item?.guardianId === ctx.callerId) {
        const metadata = view(item, ctx.deps.now());
        if (item.state === 'accepted' && item.adolescentId) {
          const profile = (
            await ctx.deps.ddb.send(
              new GetCommand({
                TableName: ctx.deps.table,
                Key: K.profile(item.adolescentId),
                ConsistentRead: true,
              }),
            )
          ).Item;
          const decision = profile ? await readPrivacyItem(ctx.deps, item.adolescentId) : undefined;
          if (
            profile &&
            decision?.guardianId === ctx.callerId &&
            decision.invitationId === item.invitationId
          ) {
            const status = privacyStatusFor(
              profile as unknown as Ctx['caller'],
              decision,
              item.language,
              ctx.deps.now(),
            );
            metadata.consentRevision = status.revision;
            metadata.guardianConsent = status.guardianConsent;
          }
        }
        result.push(metadata);
      }
    }
    start = page.LastEvaluatedKey;
    if (result.length > 500) throw new ApiError('RATE_LIMITED');
  } while (start);
  return result;
}
/** A signup container carries no family authorization. Retire only its exact,
 * untouched four canonical rows; active or historically used families stay blocked. */
async function retireUnusedSignupHousehold(ctx: Ctx, profile: ProfileItem): Promise<Item[]> {
  const householdKey = FK.household(householdIdForPrimary(profile.userId));
  const result = await ctx.deps.ddb.send(new QueryCommand({
    TableName: ctx.deps.table, KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': householdKey.pk }, ConsistentRead: true, Limit: 5,
  }));
  if (!result.Items?.length && !result.LastEvaluatedKey) {
    return [{ ConditionCheck: { TableName: ctx.deps.table, Key: householdKey,
      ConditionExpression: 'attribute_not_exists(pk)' } }];
  }
  const canonical = createHousehold({ primaryResponsibleId: profile.userId, now: profile.createdAt });
  const expected = [canonical, ...createEmptySeatAssignments(canonical.householdId, profile.createdAt)];
  if (result.LastEvaluatedKey || result.Items?.length !== expected.length ||
    expected.some(row => !result.Items?.some(item => isDeepStrictEqual(item, row))))
    throw new ApiError('CONFLICT');
  return [
    ...[FK.familyEntitlement(canonical.householdId), FK.familyCoverage(profile.userId)].map(Key => ({
      ConditionCheck: { TableName: ctx.deps.table, Key, ConditionExpression: 'attribute_not_exists(pk)' },
    })),
    ...expected.map(row => {
      const fields = Object.entries(row).filter(([name]) => name !== 'pk' && name !== 'sk');
      return { Delete: { TableName: ctx.deps.table, Key: { pk: row.pk, sk: row.sk },
        ConditionExpression: fields.map((_, i) => `#f${i} = :v${i}`).join(' AND '),
        ExpressionAttributeNames: Object.fromEntries(fields.map(([name], i) => [`#f${i}`, name])),
        ExpressionAttributeValues: Object.fromEntries(fields.map(([, value], i) => [`:v${i}`, value])),
      } };
    }),
  ];
}
export async function acceptPrivateAdolescentInvitation(
  ctx: Ctx,
  command: Extract<PrivacyConsentCommand, { action: 'accept_adolescent' }>,
): Promise<PrivacyStatus> {
  enabled();
  recent(ctx);
  confirmedEmail(ctx);
  const profile = await requireWritableOwner(ctx, ctx.callerId);
  const old = await readPrivacyItem(ctx.deps, ctx.callerId);
  const evidenceKey = { pk: K.user(ctx.callerId), sk: `PRIVACY#COMMAND#${command.commandId}` };
  const evidence = (
    await ctx.deps.ddb.send(
      new GetCommand({ TableName: ctx.deps.table, Key: evidenceKey, ConsistentRead: true }),
    )
  ).Item;
  if (evidence) {
    if (evidence['requestHash'] !== digest(command))
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return resolvedPrivacyStatusFor(ctx, profile, old, command.language);
  }
  if (
    old?.subjectKind === 'adolescent_private' &&
    profile.privacyMode === 'adolescent_private' &&
    profile.accountType === 'minor'
  ) {
    if (
      old.invitationId !== command.invitationId ||
      old.revision !== command.expectedRevision ||
      old.revision >= Number.MAX_SAFE_INTEGER ||
      !old.guardianId ||
      !old.majorityAt ||
      old.majorityAt <= privacyCalendarDate(ctx.deps.now())
    )
      throw new ApiError('CONFLICT');
    const checks = await parentConditions(ctx, old.guardianId);
    const next: AdultPrivacyItem = {
      ...old,
      revision: old.revision + 1,
      updatedAt: ctx.deps.now(),
      cloudConsent: 'revoked',
      adolescentAcceptedAt: ctx.deps.now(),
      adolescentLanguage: command.language,
      adolescentDocumentHash: command.documentHash,
    };
    await transact(ctx.deps, [
      ...checks,
      closureAbsenceConditionCheck(ctx.deps, ctx.callerId),
      {
        ConditionCheck: {
          TableName: ctx.deps.table,
          Key: K.profile(ctx.callerId),
          ConditionExpression:
            'accountType = :minor AND privacyMode = :private AND majorityAt = :date AND (attribute_not_exists(#status) OR #status = :active)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':minor': 'minor',
            ':private': 'adolescent_private',
            ':date': old.majorityAt,
            ':active': 'active',
          },
        },
      },
      {
        Put: {
          TableName: ctx.deps.table,
          Item: next,
          ConditionExpression: 'revision = :revision',
          ExpressionAttributeValues: { ':revision': old.revision },
        },
      },
      decisionLedgerPut(ctx.deps, next, old),
      {
        Put: {
          TableName: ctx.deps.table,
          Item: {
            ...evidenceKey,
            userId: ctx.callerId,
            action: command.action,
            requestHash: digest(command),
            revision: next.revision,
            updatedAt: next.updatedAt,
            document: adultPrivacyDocument(command.language, command.language === 'es' ? ES : EN),
            documentHash: command.documentHash,
            authentication: 'verified_jwt_subject',
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ]);
    return resolvedPrivacyStatusFor(ctx, profile, next, command.language);
  }
  if (
    old ||
    profile.accountType !== 'adult' ||
    profile.privacyMode ||
    command.expectedRevision !== 0 ||
    profile.createdMinorIds?.size
  )
    throw new ApiError('CONFLICT');
  const invite = await strong<InvitationItem>(
    ctx.deps,
    adolescentInvitationKey(command.invitationId),
  );
  if (
    !invite ||
    invite.state !== 'authorized' ||
    !hasAdolescentAuthorization(invite) ||
    invite.recipientUsername !== profile.username ||
    invite.guardianId === ctx.callerId ||
    invite.expiresAt <= ctx.deps.now() ||
    !validMajorityDate(invite.majorityAt, ctx.deps.now()) ||
    invite.documentHash !== privacyDocumentHash(invite.language)
  )
    throw new ApiError('FORBIDDEN');
  for (const prefix of [
    'FRIEND#',
    'FREQ#',
    'GUARDIAN#',
    'SUPERVISION#',
    'COVERAGE#FAMILY',
    'CONSENT#FAMILY',
  ]) {
    const existing = await ctx.deps.ddb.send(
      new QueryCommand({
        TableName: ctx.deps.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': K.user(ctx.callerId), ':prefix': prefix },
        ConsistentRead: true,
        Limit: 1,
      }),
    );
    if (existing.Items?.length) throw new ApiError('CONFLICT');
  }
  // The initial type is technical, not adult admission. Existing outbound
  // legacy/v2 relations and any used primary household disqualify conversion.
  const outbound = await ctx.deps.ddb.send(
    new QueryCommand({
      TableName: ctx.deps.table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': K.user(ctx.callerId) },
      Limit: 1,
    }),
  );
  if (outbound.Items?.length) throw new ApiError('CONFLICT');
  const signupHouseholdChanges = await retireUnusedSignupHousehold(ctx, profile);
  const checks = await parentConditions(ctx, invite.guardianId);
  const premium =
    invite.authorizationMethod === 'account_attestation'
      ? await requireCurrentResponsiblePremium(ctx, invite.guardianId)
      : undefined;
  const now = ctx.deps.now();
  const next: AdultPrivacyItem = {
    ...privacyKey(ctx.callerId),
    userId: ctx.callerId,
    revision: 1,
    updatedAt: now,
    cloudConsent: 'absent',
    erasure: 'none',
    subjectKind: 'adolescent_private',
    adolescentAcceptedAt: now,
    adolescentLanguage: command.language,
    adolescentDocumentHash: command.documentHash,
    guardianId: invite.guardianId,
    guardianConsent: 'granted',
    guardianLanguage: invite.language,
    guardianDocumentHash: invite.documentHash,
    guardianAuthorization:
      invite.authorizationMethod === 'account_attestation'
        ? { method: 'account_attestation', attestation: invite.attestation! }
        : {
            method: 'operator_verified',
            verifiedAt: invite.representationVerifiedAt!,
            caseId: invite.verificationCaseId!,
            ...(invite.verifiedBy ? { verifiedBy: invite.verifiedBy } : {}),
          },
    majorityAt: invite.majorityAt,
    invitationId: invite.invitationId,
  };
  const acceptedInvite = {
    ...invite,
    state: 'accepted',
    revision: invite.revision + 1,
    adolescentId: ctx.callerId,
    ttl: Math.ceil((Date.parse(`${invite.majorityAt}T12:00:00Z`) + 36 * 86400000) / 1000),
  };
  await transact(ctx.deps, [
    ...checks,
    ...(premium?.conditions ?? []),
    closureAbsenceConditionCheck(ctx.deps, ctx.callerId),
    ...signupHouseholdChanges,
    {
      Update: {
        TableName: ctx.deps.table,
        Key: K.profile(ctx.callerId),
        UpdateExpression:
          'SET accountType = :minor, socialEnabled = :disabled, privacyMode = :private, majorityAt = :date, gsi2pk = :queue, gsi2sk = :due',
        ConditionExpression:
          'userId = :id AND accountType = :adult AND attribute_not_exists(privacyMode) AND (attribute_not_exists(createdMinorIds) OR size(createdMinorIds) = :zero) AND (attribute_not_exists(#status) OR #status = :active)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':id': ctx.callerId,
          ':minor': 'minor',
          ':adult': 'adult',
          ':private': 'adolescent_private',
          ':date': invite.majorityAt,
          ':disabled': false,
          ':active': 'active',
          ':zero': 0,
          ':queue': 'PRIVACY#MAJORITY',
          ':due': `${invite.majorityAt}#${ctx.callerId}`,
        },
      },
    },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: next,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    decisionLedgerPut(ctx.deps, next),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: {
          ...evidenceKey,
          userId: ctx.callerId,
          action: command.action,
          updatedAt: now,
          revision: 1,
          requestHash: digest(command),
          documentHash: command.documentHash,
          document: adultPrivacyDocument(command.language, command.language === 'es' ? ES : EN),
          authentication: 'verified_jwt_subject',
          actorId: ctx.callerId,
          guardianId: invite.guardianId,
          verificationCaseId: invite.verificationCaseId,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: privacyTableName(ctx.deps),
        Item: acceptedInvite,
        ConditionExpression:
          '#state = :authorized AND revision = :revision AND guardianId = :parent AND ' +
          (invite.authorizationMethod === 'account_attestation'
            ? 'authorizationMethod = :method AND attestation = :attestation'
            : 'representationVerifiedAt = :verified'),
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':authorized': 'authorized',
          ':revision': invite.revision,
          ':parent': invite.guardianId,
          ...(invite.authorizationMethod === 'account_attestation'
            ? { ':method': 'account_attestation', ':attestation': invite.attestation! }
            : { ':verified': invite.representationVerifiedAt! }),
        },
      },
    },
  ]);
  return resolvedPrivacyStatusFor(
    ctx,
    {
      ...profile,
      accountType: 'minor',
      privacyMode: 'adolescent_private',
      majorityAt: invite.majorityAt,
    },
    next,
    command.language,
    now,
  );
}
export async function changePrivateAdolescentGuardianConsent(
  ctx: Ctx,
  adolescentId: string,
  body: PrivateAdolescentGuardianCommand,
): Promise<PrivacyStatus> {
  if (body?.action !== 'revoke_guardian') enabled();
  recent(ctx);
  if (!SAFE.test(adolescentId)) throw new ApiError('VALIDATION');
  validateBody(body, [
    'action',
    ...(body.action === 'grant_guardian' ? ['representsMinor', 'authorizesCloud'] : []),
  ]);
  if (
    !['grant_guardian', 'revoke_guardian'].includes(body.action) ||
    (body.action === 'grant_guardian' &&
      (body.representsMinor !== true || body.authorizesCloud !== true))
  )
    throw new ApiError('VALIDATION');
  const profile = await requireWritableOwner(ctx, adolescentId);
  const old = await readPrivacyItem(ctx.deps, adolescentId);
  if (
    !old ||
    old.subjectKind !== 'adolescent_private' ||
    old.guardianId !== ctx.callerId ||
    profile.privacyMode !== 'adolescent_private' ||
    !old.majorityAt ||
    old.majorityAt <= privacyCalendarDate(ctx.deps.now())
  )
    throw new ApiError('FORBIDDEN');
  const checks = await parentConditions(ctx, ctx.callerId);
  const evidenceKey = {
    pk: K.user(adolescentId),
    sk: `PRIVACY#GUARDIAN#${ctx.callerId}#${body.commandId}`,
  };
  const prior = (
    await ctx.deps.ddb.send(
      new GetCommand({ TableName: ctx.deps.table, Key: evidenceKey, ConsistentRead: true }),
    )
  ).Item;
  if (prior) {
    if (prior['requestHash'] !== digest(body)) throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return resolvedPrivacyStatusFor(ctx, profile, old, body.language);
  }
  if (old.revision !== body.expectedRevision || old.revision >= Number.MAX_SAFE_INTEGER)
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  const now = ctx.deps.now();
  const next: AdultPrivacyItem = {
    ...old,
    revision: old.revision + 1,
    updatedAt: now,
    guardianConsent: body.action === 'grant_guardian' ? 'granted' : 'revoked',
    guardianDocumentHash: body.documentHash,
    guardianLanguage: body.language,
    cloudConsent: 'revoked',
  };
  await transact(ctx.deps, [
    ...checks,
    closureAbsenceConditionCheck(ctx.deps, adolescentId),
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: K.profile(adolescentId),
        ConditionExpression:
          'privacyMode = :private AND accountType = :minor AND majorityAt = :date AND (attribute_not_exists(#status) OR #status = :active)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':private': 'adolescent_private',
          ':minor': 'minor',
          ':date': old.majorityAt,
          ':active': 'active',
        },
      },
    },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: next,
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': old.revision },
      },
    },
    decisionLedgerPut(ctx.deps, next, old),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: {
          ...evidenceKey,
          userId: adolescentId,
          actorId: ctx.callerId,
          action: body.action,
          requestHash: digest(body),
          revision: next.revision,
          updatedAt: now,
          documentHash: body.documentHash,
          document: adultPrivacyDocument(body.language, body.language === 'es' ? ES : EN),
          authentication: 'verified_jwt_subject',
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ]);
  return resolvedPrivacyStatusFor(ctx, profile, next, body.language);
}
