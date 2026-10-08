import { createHash } from 'node:crypto';
import {
  ADULT_PRIVACY_VERSIONS,
  ApiError,
  adultPrivacyDocument,
  type CloudErasureState,
  type PrivacyConsentCommand,
  type PrivacyExportPage,
  type PrivacyStatus,
  type SyncRecord,
} from '@app/api/contracts';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { type Ctx, requireWritableOwner, closureAbsenceConditionCheck } from '../authz';
import { K, type Deps, type ProfileItem, type RecordItem } from '../db';
import {
  decisionLedgerPut,
  readDecisionLedger,
  privacySnapshotHash,
  privacyTableName,
  readRestoreExclusion,
  recordMayBeRestored,
  type RestoreExclusionItem,
} from './retention';
import { ES } from '@app/i18n/es';
import { EN } from '@app/i18n/en';
import { requireResponsiblePremiumCloud, type ResponsiblePremiumCloud } from './parent-premium';

type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export interface AdultPrivacyItem {
  pk: string;
  sk: 'PRIVACY#ADULT';
  userId: string;
  revision: number;
  updatedAt: number;
  adultDeclaredAt?: number;
  declarationLanguage?: 'es' | 'en';
  declarationDocumentHash?: string;
  cloudConsent: 'absent' | 'granted' | 'revoked';
  cloudLanguage?: 'es' | 'en';
  cloudDocumentHash?: string;
  erasure: CloudErasureState;
  erasureId?: string;
  erasureRequestedAt?: number;
  erasureCompletedAt?: number;
  gsi2pk?: string;
  gsi2sk?: string;
  subjectKind?: 'adolescent_private';
  adolescentAcceptedAt?: number;
  adolescentLanguage?: 'es' | 'en';
  adolescentDocumentHash?: string;
  guardianId?: string;
  guardianConsent?: 'granted' | 'revoked' | 'ended';
  guardianLanguage?: 'es' | 'en';
  guardianDocumentHash?: string;
  guardianAuthorization?: {
    method: 'account_attestation' | 'operator_verified';
    attestation?: {
      subjectId: string;
      authenticatedAt: number;
      emailVerified: true;
      declaredName: string;
      relationship: 'parent' | 'legal_guardian';
      declaredAt: number;
    };
    verifiedAt?: number;
    caseId?: string;
    verifiedBy?: string;
  };
  majorityAt?: string;
  invitationId?: string;
}
interface PrivacyEvidence {
  pk: string;
  sk: string;
  userId: string;
  revision: number;
  updatedAt: number;
  requestHash: string;
  action: PrivacyConsentCommand['action'];
  documentHash: string;
  document: ReturnType<typeof adultPrivacyDocument>;
  authentication: 'verified_jwt_subject';
  authenticatedAt?: number;
}
export const privacyKey = (userId: string) => ({
  pk: K.user(userId),
  sk: 'PRIVACY#ADULT' as const,
});
const evidenceKey = (userId: string, commandId: string) => ({
  pk: K.user(userId),
  sk: `PRIVACY#COMMAND#${commandId}`,
});
const HASH = /^[a-f0-9]{64}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

export function adultPrivacyMode(): 'off' | 'enforce' {
  const mode = process.env['ADULT_PRIVACY_MODE'] ?? 'off';
  if (mode !== 'off' && mode !== 'enforce')
    throw new ApiError('server', 'privacy configuration unavailable');
  return mode;
}
export function privacyDocumentHash(language: 'es' | 'en'): string {
  return createHash('sha256')
    .update(JSON.stringify(adultPrivacyDocument(language, language === 'es' ? ES : EN)))
    .digest('hex');
}
async function strong<T>(deps: Deps, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.ddb.send(
    new GetCommand({ TableName: deps.table, Key: key, ConsistentRead: true }),
  );
  return response.Item as T | undefined;
}
export async function readPrivacyItem(
  deps: Deps,
  userId: string,
): Promise<AdultPrivacyItem | undefined> {
  let item: AdultPrivacyItem | undefined;
  let matched = false;
  // A concurrent transaction may fall between these strong reads. Retry a
  // bounded number of times; persistent disagreement is a restore fence.
  for (let attempt = 0; attempt < 3; attempt++) {
    item = await strong<AdultPrivacyItem>(deps, privacyKey(userId));
    const ledger = await readDecisionLedger(deps, userId);
    matched = ledger
      ? !!item &&
        ledger.revision === item.revision &&
        ledger.snapshotHash === privacySnapshotHash(item)
      : !item || !deps.privacyTable;
    if (matched) break;
  }
  if (!matched)
    throw new ApiError(
      'PRIVACY_REVISION_CONFLICT',
      'live privacy decisions differ from restored data',
    );
  if (
    item &&
    (item.pk !== K.user(userId) ||
      item.sk !== 'PRIVACY#ADULT' ||
      item.userId !== userId ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      !Number.isSafeInteger(item.updatedAt) ||
      !['absent', 'granted', 'revoked'].includes(item.cloudConsent) ||
      !['none', 'requested', 'purging', 'blocked', 'completed'].includes(item.erasure))
  ) {
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  }
  return item;
}
export function isDeclared(item: AdultPrivacyItem | undefined): boolean {
  return (
    !!item &&
    Number.isSafeInteger(item.adultDeclaredAt) &&
    (item.declarationLanguage === 'es' || item.declarationLanguage === 'en') &&
    item.declarationDocumentHash === privacyDocumentHash(item.declarationLanguage)
  );
}
function cloudIsCurrent(item: AdultPrivacyItem): boolean {
  return (
    item.cloudConsent === 'granted' &&
    (item.cloudLanguage === 'es' || item.cloudLanguage === 'en') &&
    item.cloudDocumentHash === privacyDocumentHash(item.cloudLanguage)
  );
}
export function privateAdolescentMode(): 'off' | 'enforce' {
  const mode = process.env['PRIVATE_ADOLESCENT_MODE'] ?? 'off';
  if (mode !== 'off' && mode !== 'enforce') throw new ApiError('server');
  return mode;
}
/** Admission dates are Mexican civil dates, independent of the Lambda timezone. */
export function privacyCalendarDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}
export function adolescentAdmission(
  profile: Pick<ProfileItem, 'accountType' | 'privacyMode' | 'majorityAt'>,
  item: AdultPrivacyItem | undefined,
  now: number,
): boolean {
  return (
    profile.accountType === 'minor' &&
    profile.privacyMode === 'adolescent_private' &&
    item?.subjectKind === 'adolescent_private' &&
    item.majorityAt === profile.majorityAt &&
    !!item.majorityAt &&
    item.majorityAt > privacyCalendarDate(now) &&
    Number.isSafeInteger(item.adolescentAcceptedAt)
  );
}
export function privacyStatusFor(
  profile: Pick<ProfileItem, 'userId' | 'accountType' | 'privacyMode' | 'majorityAt'>,
  item: AdultPrivacyItem | undefined,
  language: 'es' | 'en' = 'es',
  now = Date.now(),
): PrivacyStatus {
  const declared = profile.accountType === 'adult' && isDeclared(item);
  const adolescent = adolescentAdmission(profile, item, now);
  const guardianCurrent =
    adolescent &&
    item?.guardianConsent === 'granted' &&
    !!item.guardianLanguage &&
    item.guardianDocumentHash === privacyDocumentHash(item.guardianLanguage);
  const adolescentUnderstood =
    adolescent &&
    !!item?.adolescentLanguage &&
    item.adolescentDocumentHash === privacyDocumentHash(item.adolescentLanguage);
  const current = item ? cloudIsCurrent(item) && (!adolescent || adolescentUnderstood) : false;
  const consent =
    item?.cloudConsent === 'granted' && (!(declared || guardianCurrent) || !current)
      ? 'version_review_required'
      : (item?.cloudConsent ?? 'absent');
  const erasure = item?.erasure ?? 'none';
  return {
    userId: profile.userId,
    scope:
      profile.accountType === 'adult' ? 'adult' : adolescent ? 'adolescent_private' : 'unsupported',
    enforcement: adultPrivacyMode(),
    revision: item?.revision ?? 0,
    adultDeclared: declared,
    cloudConsent: consent,
    canUseCloud:
      (declared || (guardianCurrent && privateAdolescentMode() === 'enforce')) &&
      current &&
      (erasure === 'none' || erasure === 'completed'),
    erasure,
    versions: ADULT_PRIVACY_VERSIONS,
    documentHash: privacyDocumentHash(language),
    updatedAt: item?.updatedAt ?? null,
    ...(profile.privacyMode === 'adolescent_private'
      ? {
          privateOnly: true,
          majorityAt: profile.majorityAt,
          invitationId: item?.invitationId,
          adolescentUnderstood,
          guardianConsent: !adolescent
            ? ('ended' as const)
            : item?.guardianConsent === 'revoked'
              ? ('revoked' as const)
              : guardianCurrent
                ? ('granted' as const)
                : ('version_review_required' as const),
        }
      : {}),
  };
}
export async function getPrivacyStatus(ctx: Ctx, language?: string): Promise<PrivacyStatus> {
  if (language !== undefined && language !== 'es' && language !== 'en')
    throw new ApiError('VALIDATION');
  const profile = await strong<ProfileItem>(ctx.deps, K.profile(ctx.callerId));
  if (!profile || profile.userId !== ctx.callerId) throw new ApiError('UNAUTHENTICATED');
  const item = await readPrivacyItem(ctx.deps, ctx.callerId);
  return resolvedPrivacyStatusFor(ctx, profile, item, language ?? 'es');
}
export async function resolvedPrivacyStatusFor(
  ctx: Ctx,
  profile: Pick<ProfileItem, 'userId' | 'accountType' | 'privacyMode' | 'majorityAt'>,
  item: AdultPrivacyItem | undefined,
  language: 'es' | 'en',
  observedAt = ctx.deps.now(),
): Promise<PrivacyStatus> {
  const status = privacyStatusFor(profile, item, language, observedAt);
  if (status.privateOnly) {
    status.cloudCoverage = { kind: 'responsible_premium', state: 'unavailable', validUntil: null };
  }
  if (status.scope === 'adolescent_private' && status.guardianConsent === 'granted') {
    try {
      const { guardianConditions } = await import('./adolescents');
      await guardianConditions(ctx, item!);
      const coverage = await requireResponsiblePremiumCloud(ctx, item!);
      status.cloudCoverage = {
        kind: 'responsible_premium',
        state: 'active',
        validUntil: coverage.sourceValidUntil,
      };
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !['CLOUD_CONSENT_REQUIRED', 'CAPABILITY_REQUIRED'].includes(error.code)
      )
        throw error;
      status.canUseCloud = false;
      if (error.code === 'CLOUD_CONSENT_REQUIRED') status.guardianConsent = 'revoked';
    }
  }
  return status;
}
export function validatePrivacyMetadata(record: Record<string, unknown>): void {
  if (
    typeof record['commandId'] !== 'string' ||
    !COMMAND_ID.test(record['commandId']) ||
    !Number.isSafeInteger(record['expectedRevision']) ||
    (record['expectedRevision'] as number) < 0 ||
    (record['language'] !== 'es' && record['language'] !== 'en') ||
    Object.entries(ADULT_PRIVACY_VERSIONS).some(([key, version]) => record[key] !== version) ||
    record['documentHash'] !== privacyDocumentHash(record['language'] as 'es' | 'en')
  )
    throw new ApiError('VALIDATION');
}
function parseCommand(value: unknown): PrivacyConsentCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('VALIDATION');
  const record = value as Record<string, unknown>;
  const keys = [
    'action',
    'commandId',
    'expectedRevision',
    'language',
    'noticeVersion',
    'termsVersion',
    'cloudConsentVersion',
    'documentHash',
  ];
  if (record['action'] === 'declare_adult') keys.push('declareAdult', 'acceptTerms');
  else if (record['action'] === 'grant_cloud') keys.push('accepted');
  else if (record['action'] === 'accept_adolescent')
    keys.push('invitationId', 'acceptTerms', 'understandsPrivacy');
  else if (record['action'] !== 'revoke_cloud' && record['action'] !== 'erase_cloud')
    throw new ApiError('VALIDATION');
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record['commandId'] !== 'string' ||
    !COMMAND_ID.test(record['commandId']) ||
    !Number.isSafeInteger(record['expectedRevision']) ||
    (record['expectedRevision'] as number) < 0 ||
    (record['language'] !== 'es' && record['language'] !== 'en') ||
    Object.entries(ADULT_PRIVACY_VERSIONS).some(([key, version]) => record[key] !== version) ||
    typeof record['documentHash'] !== 'string' ||
    !HASH.test(record['documentHash']) ||
    record['documentHash'] !== privacyDocumentHash(record['language'] as 'es' | 'en') ||
    (record['action'] === 'declare_adult' &&
      (record['declareAdult'] !== true || record['acceptTerms'] !== true)) ||
    (record['action'] === 'grant_cloud' && record['accepted'] !== true) ||
    (record['action'] === 'accept_adolescent' &&
      (record['acceptTerms'] !== true ||
        record['understandsPrivacy'] !== true ||
        typeof record['invitationId'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record['invitationId'])))
  )
    throw new ApiError('VALIDATION');
  return record as unknown as PrivacyConsentCommand;
}
function requestHash(command: PrivacyConsentCommand): string {
  const sorted = Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
function replayMatches(
  evidence: PrivacyEvidence,
  userId: string,
  command: PrivacyConsentCommand,
): boolean {
  const expected = evidenceKey(userId, command.commandId);
  return (
    evidence.pk === expected.pk &&
    evidence.sk === expected.sk &&
    evidence.userId === userId &&
    evidence.requestHash === requestHash(command)
  );
}
export async function changePrivacyConsent(ctx: Ctx, body: unknown): Promise<PrivacyStatus> {
  const command = parseCommand(body);
  if (command.action === 'accept_adolescent') {
    const { acceptPrivateAdolescentInvitation } = await import('./adolescents');
    return acceptPrivateAdolescentInvitation(ctx, command);
  }
  privacyTableName(ctx.deps);
  const profile = await requireWritableOwner(ctx, ctx.callerId);
  const old = await readPrivacyItem(ctx.deps, ctx.callerId);
  const duePrivate =
    profile.privacyMode === 'adolescent_private' &&
    !!profile.majorityAt &&
    profile.majorityAt <= privacyCalendarDate(ctx.deps.now());
  const adolescent = adolescentAdmission(profile, old, ctx.deps.now());
  if (
    profile.userId !== ctx.callerId ||
    (profile.accountType !== 'adult' &&
      !adolescent &&
      !(duePrivate && command.action === 'declare_adult') &&
      !(
        profile.privacyMode === 'adolescent_private' &&
        ['revoke_cloud', 'erase_cloud'].includes(command.action)
      ))
  )
    throw new ApiError('FORBIDDEN');
  if (command.action === 'declare_adult' && profile.accountType !== 'adult' && !duePrivate)
    throw new ApiError('FORBIDDEN');
  const previous = await strong<PrivacyEvidence>(
    ctx.deps,
    evidenceKey(ctx.callerId, command.commandId),
  );
  if (previous) {
    if (!replayMatches(previous, ctx.callerId, command))
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return resolvedPrivacyStatusFor(ctx, profile, old, command.language);
  }
  if ((old?.revision ?? 0) !== command.expectedRevision)
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  if ((old?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  if (command.action === 'grant_cloud' && !adolescent && !isDeclared(old))
    throw new ApiError('ADULT_DECLARATION_REQUIRED');
  if (command.action === 'grant_cloud' && adolescent && privateAdolescentMode() !== 'enforce')
    throw new ApiError('FORBIDDEN');
  const guardianChecks =
    adolescent && command.action === 'grant_cloud'
      ? await (await import('./adolescents')).guardianConditions(ctx, old!)
      : [];
  if (
    adolescent &&
    command.action === 'grant_cloud' &&
    !privacyStatusFor(profile, old, command.language, ctx.deps.now()).adolescentUnderstood
  )
    throw new ApiError('VALIDATION');
  if (command.action === 'grant_cloud' && old && !['none', 'completed'].includes(old.erasure))
    throw new ApiError('PRIVACY_ERASURE_PENDING');
  const now = ctx.deps.now();
  const next: AdultPrivacyItem = {
    ...old,
    ...privacyKey(ctx.callerId),
    userId: ctx.callerId,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: now,
    cloudConsent: old?.cloudConsent ?? 'absent',
    erasure: old?.erasure ?? 'none',
  };
  if (command.action === 'declare_adult')
    Object.assign(next, {
      adultDeclaredAt: now,
      declarationLanguage: command.language,
      declarationDocumentHash: command.documentHash,
      ...(duePrivate ? { guardianConsent: 'ended', cloudConsent: 'revoked' } : {}),
    });
  if (command.action === 'grant_cloud')
    Object.assign(next, {
      cloudConsent: 'granted',
      cloudLanguage: command.language,
      cloudDocumentHash: command.documentHash,
    });
  if (command.action === 'revoke_cloud' || command.action === 'erase_cloud')
    next.cloudConsent = 'revoked';
  if (command.action === 'erase_cloud')
    Object.assign(next, {
      erasure: 'requested',
      erasureId: command.commandId,
      erasureRequestedAt: now,
      gsi2pk: 'PRIVACY#ERASURE',
      gsi2sk: `NEXT#${String(now).padStart(14, '0')}#${ctx.callerId}`,
    });
  const evidence: PrivacyEvidence = {
    ...evidenceKey(ctx.callerId, command.commandId),
    userId: ctx.callerId,
    revision: next.revision,
    updatedAt: now,
    action: command.action,
    requestHash: requestHash(command),
    documentHash: command.documentHash,
    document: adultPrivacyDocument(command.language, command.language === 'es' ? ES : EN),
    authentication: 'verified_jwt_subject',
    ...(ctx.authenticatedAt === undefined ? {} : { authenticatedAt: ctx.authenticatedAt }),
  };
  const transaction: TransactionItem[] = [
    ...(duePrivate && profile.accountType === 'minor' && command.action === 'declare_adult'
      ? [
          {
            Update: {
              TableName: ctx.deps.table,
              Key: K.profile(ctx.callerId),
              UpdateExpression:
                'SET accountType = :adult, familyFenceVersion = :fence REMOVE gsi2pk, gsi2sk',
              ConditionExpression:
                'accountType = :minor AND privacyMode = :private AND majorityAt = :date AND #status = :active',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':minor': 'minor',
                ':adult': 'adult',
                ':private': 'adolescent_private',
                ':date': profile.majorityAt,
                ':active': 'active',
                ':fence': 1,
              },
            },
          },
        ]
      : [
          {
            ConditionCheck: {
              TableName: ctx.deps.table,
              Key: K.profile(ctx.callerId),
              ConditionExpression:
                'attribute_exists(pk) AND accountType = :kind AND (attribute_not_exists(#status) OR #status = :active)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':kind': profile.accountType, ':active': 'active' },
            },
          },
        ]),
    closureAbsenceConditionCheck(ctx.deps, ctx.callerId),
    {
      Put: {
        TableName: ctx.deps.table,
        Item: next,
        ConditionExpression: old ? 'revision = :revision' : 'attribute_not_exists(pk)',
        ...(old ? { ExpressionAttributeValues: { ':revision': old.revision } } : {}),
      },
    },
    {
      Put: {
        TableName: ctx.deps.table,
        Item: evidence,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    decisionLedgerPut(ctx.deps, next, old),
    ...guardianChecks,
  ];
  try {
    await ctx.deps.ddb.send(new TransactWriteCommand({ TransactItems: transaction }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
    await requireWritableOwner(ctx, ctx.callerId);
    const concurrent = await strong<PrivacyEvidence>(
      ctx.deps,
      evidenceKey(ctx.callerId, command.commandId),
    );
    if (!concurrent || !replayMatches(concurrent, ctx.callerId, command))
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return resolvedPrivacyStatusFor(
      ctx,
      profile,
      await readPrivacyItem(ctx.deps, ctx.callerId),
      command.language,
      ctx.deps.now(),
    );
  }
  if (command.action === 'erase_cloud') {
    const { processCloudErasurePage } = await import('./erasure');
    const processed = await processCloudErasurePage(ctx.deps, ctx.callerId);
    return resolvedPrivacyStatusFor(ctx, profile, processed, command.language);
  }
  return resolvedPrivacyStatusFor(
    ctx,
    duePrivate && command.action === 'declare_adult'
      ? { ...profile, accountType: 'adult' }
      : profile,
    next,
    command.language,
    now,
  );
}
export interface CloudConsentGuard {
  userId: string;
  revision: number;
  documentHash: string;
  snapshotHash: string;
  exclusion?: RestoreExclusionItem;
  additionalConditions?: TransactionItem[];
  responsiblePremium?: ResponsiblePremiumCloud;
}
export async function requireAdultAdmission(ctx: Ctx): Promise<void> {
  if (adultPrivacyMode() === 'off') return;
  const profile = await requireWritableOwner(ctx, ctx.callerId);
  const state = await readPrivacyItem(ctx.deps, ctx.callerId);
  if (adolescentAdmission(profile, state, ctx.deps.now())) return;
  if (profile.accountType !== 'adult') throw new ApiError('FORBIDDEN');
  if (!isDeclared(state)) throw new ApiError('ADULT_DECLARATION_REQUIRED');
}
export async function requireCloudConsent(
  ctx: Ctx,
  userId: string,
): Promise<CloudConsentGuard | undefined> {
  const mode = adultPrivacyMode();
  if (mode === 'off' && !ctx.deps.privacyTable) return undefined;
  const state = await readPrivacyItem(ctx.deps, userId);
  // Compatibility applies only to accounts that have never enrolled. An
  // explicit withdrawal or cancellation always remains effective.
  if (mode === 'off' && !state) return undefined;
  const profile = await requireWritableOwner(ctx, userId);
  const status = privacyStatusFor(profile, state, 'es', ctx.deps.now());
  if (status.scope === 'unsupported') throw new ApiError('FORBIDDEN');
  if (status.scope === 'adult' && !status.adultDeclared)
    throw new ApiError('ADULT_DECLARATION_REQUIRED');
  if (status.scope === 'adolescent_private' && privateAdolescentMode() !== 'enforce')
    throw new ApiError('FORBIDDEN');
  const additionalConditions =
    status.scope === 'adolescent_private'
      ? await (await import('./adolescents')).guardianConditions(ctx, state!)
      : [];
  if (!['none', 'completed'].includes(status.erasure))
    throw new ApiError('PRIVACY_ERASURE_PENDING');
  if (!status.canUseCloud || !state?.cloudDocumentHash)
    throw new ApiError('CLOUD_CONSENT_REQUIRED');
  const responsiblePremium =
    status.scope === 'adolescent_private'
      ? await requireResponsiblePremiumCloud(ctx, state)
      : undefined;
  const exclusion = await readRestoreExclusion(ctx.deps, userId);
  if (
    exclusion &&
    (exclusion.scope === 'account' ||
      (exclusion.cutoffRevision > 0 &&
        (!exclusion.completedAt || state.revision <= exclusion.cutoffRevision)))
  ) {
    throw new ApiError('PRIVACY_ERASURE_PENDING');
  }
  return {
    userId,
    revision: state.revision,
    documentHash: state.cloudDocumentHash,
    snapshotHash: privacySnapshotHash(state),
    additionalConditions,
    ...(responsiblePremium ? { responsiblePremium } : {}),
    ...(exclusion ? { exclusion } : {}),
  };
}
/** A fresh grant cannot authorize content resurrected from a previously erased epoch. */
export function assertCloudRecords(
  guard: CloudConsentGuard | undefined,
  records: readonly (RecordItem | undefined)[],
): void {
  if (!guard) return;
  if (
    records.some(
      (record) =>
        record && (record.owner !== guard.userId || !recordMayBeRestored(record, guard.exclusion)),
    )
  ) {
    throw new ApiError('PRIVACY_ERASURE_PENDING');
  }
}
export function cloudConsentConditions(deps: Deps, guard: CloudConsentGuard): TransactionItem[] {
  if (guard.responsiblePremium && guard.responsiblePremium.validUntil <= deps.now())
    throw new ApiError('CAPABILITY_REQUIRED');
  return [
    {
      ConditionCheck: {
        TableName: deps.table,
        Key: privacyKey(guard.userId),
        ConditionExpression:
          'revision = :revision AND cloudConsent = :granted AND cloudDocumentHash = :hash AND (erasure = :none OR erasure = :completed)',
        ExpressionAttributeValues: {
          ':revision': guard.revision,
          ':granted': 'granted',
          ':hash': guard.documentHash,
          ':none': 'none',
          ':completed': 'completed',
        },
      },
    },
    {
      ConditionCheck: {
        TableName: privacyTableName(deps),
        Key: { pk: `PRIVACY_STATE#${guard.userId}`, sk: 'STATE' },
        ConditionExpression: 'revision = :revision AND snapshotHash = :hash',
        ExpressionAttributeValues: { ':revision': guard.revision, ':hash': guard.snapshotHash },
      },
    },
    {
      ConditionCheck: {
        TableName: privacyTableName(deps),
        Key: { pk: `RESTORE#${guard.userId}`, sk: 'STATE' },
        ConditionExpression: guard.exclusion ? 'revision = :revision' : 'attribute_not_exists(pk)',
        ...(guard.exclusion
          ? { ExpressionAttributeValues: { ':revision': guard.exclusion.revision } }
          : {}),
      },
    },
    ...(guard.additionalConditions ?? []),
    ...(guard.responsiblePremium?.conditions ?? []),
  ];
}
export async function recheckCloudConsent(
  ctx: Ctx,
  expected: CloudConsentGuard | undefined,
): Promise<void> {
  if (!expected) return;
  const current = await requireCloudConsent(ctx, expected.userId);
  if (
    !current ||
    current.revision !== expected.revision ||
    current.documentHash !== expected.documentHash
  )
    throw new ApiError('CLOUD_CONSENT_REQUIRED');
}

/** ARCO export is self-scoped and does not depend on Premium or cloud consent. */
export async function exportOwnPrivacy(ctx: Ctx, cursor?: string): Promise<PrivacyExportPage> {
  const profile = await requireWritableOwner(ctx, ctx.callerId);
  if (!profile || profile.userId !== ctx.callerId) throw new ApiError('UNAUTHENTICATED');
  const exclusion = await readRestoreExclusion(ctx.deps, ctx.callerId);
  if (exclusion?.scope === 'account') throw new ApiError('UNAUTHENTICATED');
  let start: { pk: string; sk: string } | undefined;
  if (cursor) {
    try {
      start = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof start;
    } catch {
      throw new ApiError('VALIDATION');
    }
    if (
      !start ||
      Object.keys(start).length !== 2 ||
      start.pk !== K.user(ctx.callerId) ||
      typeof start.sk !== 'string'
    )
      throw new ApiError('VALIDATION');
  }
  const response = await ctx.deps.ddb.send(
    new QueryCommand({
      TableName: ctx.deps.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': K.user(ctx.callerId) },
      ConsistentRead: true,
      Limit: 100,
      ...(start ? { ExclusiveStartKey: start } : {}),
    }),
  );
  const records: SyncRecord[] = [];
  const privacy: Readonly<Record<string, unknown>>[] = [];
  for (const value of response.Items ?? []) {
    if (value['pk'] !== K.user(ctx.callerId)) throw new ApiError('server');
    if (typeof value['sk'] === 'string' && value['sk'].startsWith('REC#')) {
      const record = value as RecordItem;
      if (record.owner !== ctx.callerId) throw new ApiError('server');
      if (!exclusion?.completedAt || recordMayBeRestored(record, exclusion))
        records.push({ store: record.store, record: record.record } as SyncRecord);
    } else if (typeof value['sk'] === 'string' && value['sk'].startsWith('PRIVACY#')) {
      const { pk: _pk, sk, requestHash: _requestHash, ...ownEvidence } = value;
      privacy.push({ evidenceId: sk, ...ownEvidence });
    }
  }
  await requireWritableOwner(ctx, ctx.callerId);
  const latestExclusion = await readRestoreExclusion(ctx.deps, ctx.callerId);
  if ((latestExclusion?.revision ?? 0) !== (exclusion?.revision ?? 0))
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  return {
    formatVersion: 1,
    userId: ctx.callerId,
    exportedAt: ctx.deps.now(),
    account: {
      username: profile.username,
      displayName: profile.displayName,
      ...(profile.email === undefined ? {} : { email: profile.email }),
      createdAt: profile.createdAt,
    },
    records,
    privacy,
    cursor: response.LastEvaluatedKey
      ? Buffer.from(
          JSON.stringify({
            pk: response.LastEvaluatedKey['pk'],
            sk: response.LastEvaluatedKey['sk'],
          }),
        ).toString('base64url')
      : null,
  };
}
