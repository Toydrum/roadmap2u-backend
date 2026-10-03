import {
  ApiError,
  CONSENT_KINDS,
  FAMILY_BILLING_CONTRACT_VERSION,
  type CodeGrant,
  type CreateMinorFriendRequestRequest,
  type CreateMinorInviteCodeRequest,
  type MinorFriendActionRequest,
  type MinorFriendRequestView,
} from '@app/api/contracts';
import {
  type Ctx,
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  profileOfConsistent,
  requireWritableOwner,
  toPublic,
} from '../authz';
import { friendCode } from '../codes';
import { guardedSocialWrite } from '../commercial/social-policy';
import { K, QueryCommand, type CodeItem, type FriendItem, type ProfileItem, getItem } from '../db';
import { FK } from '../family/keys';
import {
  type AdditionalResponsibleSeatAssignmentItem,
  type CoverageAssignmentItem,
  type HouseholdSnapshot,
  type MinorSeatAssignmentItem,
  type SupervisionLinkItem,
} from '../family/model';
import { authorizeFamilyAction } from '../family/policy';
import { readHouseholdSnapshot } from '../family/repository';
import {
  MINOR_FRIEND_INVITE_TTL_MS,
  MINOR_FRIEND_REQUEST_TTL_MS,
  MINOR_SOCIAL_POLICY_VERSION,
  SK,
  activateMinorFriendship,
  canonicalFriendshipPair,
  createMinorFriendConsent,
  createMinorFriendInviteCode,
  createPendingMinorFriendship,
  friendshipSide,
  hasFourCurrentMinorFriendConsents,
  type ConsentItem,
  type FriendshipItem,
  type MinorFriendInviteCodeItem,
} from '../social/model';
import { authorizeFriendRequest, type SocialPolicyPerson } from '../social/policy';
import {
  absentConditionCheck,
  exactCodeOperation,
  getConsistent,
  guardedWrite,
  reserveCodeAttempt,
  type TransactItem,
} from './guarded-mutation';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function asExactRecord(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('VALIDATION');
  const record = body as Record<string, unknown>;
  const observed = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    throw new ApiError('VALIDATION', 'unexpected request fields');
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ApiError('VALIDATION', `${label} is invalid`);
  }
  return value;
}

function parseInviteBody(body: CreateMinorInviteCodeRequest): CreateMinorInviteCodeRequest {
  const record = asExactRecord(body, ['minorId']);
  return { minorId: identifier(record['minorId'], 'minorId') };
}

function normalizeMinorCode(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('VALIDATION', 'code required');
  const code = value.trim().toUpperCase().replace(/-/g, '');
  try {
    SK.minorInviteCode(code);
  } catch {
    throw new ApiError('CODE_INVALID');
  }
  return code;
}

function parseCreateBody(body: CreateMinorFriendRequestRequest): CreateMinorFriendRequestRequest {
  const record = asExactRecord(body, ['minorId', 'code']);
  return {
    minorId: identifier(record['minorId'], 'minorId'),
    code: normalizeMinorCode(record['code']),
  };
}

function parseActionBody(body: MinorFriendActionRequest): MinorFriendActionRequest {
  const record = asExactRecord(body, ['minorId', 'commandId', 'policyVersion']);
  const policyVersion = identifier(record['policyVersion'], 'policyVersion');
  if (policyVersion !== MINOR_SOCIAL_POLICY_VERSION) throw new ApiError('CONSENT_INCOMPLETE');
  return {
    minorId: identifier(record['minorId'], 'minorId'),
    commandId: identifier(record['commandId'], 'commandId'),
    policyVersion,
  };
}

function policyPerson(profile: ProfileItem): SocialPolicyPerson {
  return {
    accountId: profile.userId,
    accountType: profile.accountType,
    socialEnabled: profile.socialEnabled,
    status: profile.status ?? 'active',
    ...(profile.majorityAt ? { majorityAt: profile.majorityAt } : {}),
  };
}

function isExactProfile(profile: ProfileItem, expectedUserId: string): boolean {
  const key = K.profile(expectedUserId);
  return profile.pk === key.pk && profile.sk === key.sk && profile.userId === expectedUserId;
}

function currentIsoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function minorProfileGuard(ctx: Ctx, profile: ProfileItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.profile(profile.userId),
      ConditionExpression:
        `${WRITABLE_PROFILE_CONDITION} AND ` +
        '(#userId = :userId AND #accountType = :minor AND #socialEnabled = :enabled AND majorityAt = :majorityAt AND majorityAt > :today)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#userId': 'userId',
        '#accountType': 'accountType',
        '#socialEnabled': 'socialEnabled',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':userId': profile.userId,
        ':minor': 'minor',
        ':enabled': true,
        ':majorityAt': profile.majorityAt,
        ':today': currentIsoDate(ctx.deps.now()),
      },
    },
  };
}

function adultProfileGuard(ctx: Ctx, profile: ProfileItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: K.profile(profile.userId),
      ConditionExpression:
        `${WRITABLE_PROFILE_CONDITION} AND ` +
        '(#userId = :userId AND #accountType = :adult)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#userId': 'userId',
        '#accountType': 'accountType',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':userId': profile.userId,
        ':adult': 'adult',
      },
    },
  };
}

function requireCurrentMinor(profile: ProfileItem | null, expectedUserId: string, now: number): ProfileItem {
  if (!profile || !isExactProfile(profile, expectedUserId) || profile.accountType !== 'minor') {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  if ((profile.status ?? 'active') !== 'active') throw new ApiError('CONFLICT');
  if (!profile.socialEnabled) throw new ApiError('FORBIDDEN', 'social features are off');
  const majorityBoundary = profile.majorityAt
    ? Date.parse(`${profile.majorityAt}T00:00:00.000Z`)
    : Number.NaN;
  if (!Number.isFinite(majorityBoundary) || majorityBoundary <= now) {
    throw new ApiError('CONFLICT', 'minor authority is no longer current');
  }
  const decision = authorizeFriendRequest({
    actor: policyPerson(profile),
    target: policyPerson(profile),
    action: 'create',
    now,
  });
  if (!decision.allowed) throw new ApiError(decision.code);
  return profile;
}

function exactMinorCodeOperation(
  ctx: Ctx,
  item: MinorFriendInviteCodeItem,
  operation: 'check' | 'delete',
  validAt?: number,
): TransactItem {
  const common = {
    TableName: ctx.deps.table,
    Key: { pk: item.pk, sk: item.sk },
    ConditionExpression: [
      'attribute_exists(pk)',
      'entityType = :entityType',
      '#kind = :kind',
      '#code = :code',
      'minorId = :minorId',
      'issuedById = :issuedById',
      'createdAt = :createdAt',
      'expiresAt = :expiresAt',
      '#ttl = :ttl',
      ...(validAt === undefined ? [] : ['expiresAt > :now']),
    ].join(' AND '),
    ExpressionAttributeNames: { '#kind': 'kind', '#code': 'code', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':entityType': 'MinorFriendInviteCode',
      ':kind': 'minor_friend',
      ':code': item.code,
      ':minorId': item.minorId,
      ':issuedById': item.issuedById,
      ':createdAt': item.createdAt,
      ':expiresAt': item.expiresAt,
      ':ttl': item.ttl,
      ...(validAt === undefined ? {} : { ':now': validAt }),
    },
  };
  return operation === 'check' ? { ConditionCheck: common } : { Delete: common };
}

function isExactCurrentMinorCode(
  item: MinorFriendInviteCodeItem,
  code: string,
  now: number,
): boolean {
  try {
    const key = SK.minorInviteCode(code);
    return (
      item.pk === key.pk &&
      item.sk === key.sk &&
      item.entityType === 'MinorFriendInviteCode' &&
      item.kind === 'minor_friend' &&
      item.code === code &&
      IDENTIFIER_PATTERN.test(item.minorId) &&
      IDENTIFIER_PATTERN.test(item.issuedById) &&
      Number.isSafeInteger(item.createdAt) &&
      item.createdAt <= now &&
      Number.isSafeInteger(item.expiresAt) &&
      item.expiresAt > item.createdAt &&
      item.expiresAt - item.createdAt <= MINOR_FRIEND_INVITE_TTL_MS &&
      item.ttl === Math.floor(item.expiresAt / 1_000)
    );
  } catch {
    return false;
  }
}

function pendingFriendshipUpdate(
  ctx: Ctx,
  friendship: FriendshipItem,
  nextRevision: number,
): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: { pk: friendship.pk, sk: friendship.sk },
      UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'friendshipId = :friendshipId',
        'userA = :userA',
        'userB = :userB',
        'friendshipClass = :friendshipClass',
        '#state = :pending',
        'requestId = :requestId',
        'requestCycleId = :requestCycleId',
        'requesterId = :requesterId',
        'recipientId = :recipientId',
        'revision = :expectedRevision',
        'createdAt = :createdAt',
        'updatedAt = :updatedAt',
        'expiresAt = :expiresAt',
        'activatedAt = :activatedAt',
        'endedAt = :endedAt',
        'expiresAt > :now',
      ].join(' AND '),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'Friendship',
        ':friendshipId': friendship.friendshipId,
        ':userA': friendship.userA,
        ':userB': friendship.userB,
        ':friendshipClass': 'minor_minor',
        ':pending': 'pending',
        ':requestId': friendship.requestId,
        ':requestCycleId': friendship.requestCycleId,
        ':requesterId': friendship.requesterId,
        ':recipientId': friendship.recipientId,
        ':expectedRevision': friendship.revision,
        ':nextRevision': nextRevision,
        ':createdAt': friendship.createdAt,
        ':updatedAt': friendship.updatedAt,
        ':expiresAt': friendship.expiresAt,
        ':activatedAt': friendship.activatedAt,
        ':endedAt': friendship.endedAt,
        ':now': ctx.deps.now(),
      },
    },
  };
}

function consumeMinorCodePointer(
  ctx: Ctx,
  profile: ProfileItem,
  code: string,
): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: K.profile(profile.userId),
      UpdateExpression: 'REMOVE friendCode',
      ConditionExpression:
        `${WRITABLE_PROFILE_CONDITION} AND ` +
        '(#userId = :userId AND #accountType = :minor AND #socialEnabled = :enabled AND majorityAt = :majorityAt AND majorityAt > :today AND friendCode = :code)',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#userId': 'userId',
        '#accountType': 'accountType',
        '#socialEnabled': 'socialEnabled',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':userId': profile.userId,
        ':minor': 'minor',
        ':enabled': true,
        ':majorityAt': profile.majorityAt,
        ':today': currentIsoDate(ctx.deps.now()),
        ':code': code,
      },
    },
  };
}

function consentPut(ctx: Ctx, consent: ConsentItem): TransactItem {
  return {
    Put: {
      TableName: ctx.deps.table,
      Item: consent,
      ConditionExpression: 'attribute_not_exists(pk) OR requestCycleId <> :requestCycleId',
      ExpressionAttributeValues: { ':requestCycleId': consent.requestCycleId },
    },
  };
}

function sameConsent(left: ConsentItem, right: ConsentItem): boolean {
  return (
    left.pk === right.pk &&
    left.sk === right.sk &&
    left.entityType === right.entityType &&
    left.friendshipId === right.friendshipId &&
    left.requestId === right.requestId &&
    left.requestCycleId === right.requestCycleId &&
    left.side === right.side &&
    left.kind === right.kind &&
    left.actorId === right.actorId &&
    left.subjectMinorId === right.subjectMinorId &&
    left.policyVersion === right.policyVersion &&
    Number.isSafeInteger(left.revision) &&
    left.revision > 0 &&
    Number.isSafeInteger(left.recordedAt) &&
    left.recordedAt === right.recordedAt
  );
}

function isExactCurrentConsent(
  friendship: FriendshipItem,
  expectedKind: ConsentItem['kind'],
  row: ConsentItem | null,
  now: number,
): row is ConsentItem {
  if (!row || !Number.isSafeInteger(now) || row.recordedAt > now) return false;
  const subjectMinorId =
    expectedKind === 'requester_action' || expectedKind === 'requester_responsible_approval'
      ? friendship.requesterId
      : friendship.recipientId;
  if (!subjectMinorId) return false;
  try {
    const expected = createMinorFriendConsent({
      friendship,
      kind: expectedKind,
      actorId: row.actorId,
      subjectMinorId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: row.recordedAt,
    });
    return sameConsent(row, expected);
  } catch {
    return false;
  }
}

function exactConsentPut(
  ctx: Ctx,
  consent: ConsentItem,
  previous: ConsentItem | undefined,
): TransactItem {
  if (!previous) return consentPut(ctx, consent);
  return {
    Put: {
      TableName: ctx.deps.table,
      Item: consent,
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'friendshipId = :friendshipId',
        'requestId = :requestId',
        'requestCycleId = :requestCycleId',
        '#side = :side',
        '#kind = :kind',
        'actorId = :actorId',
        'subjectMinorId = :subjectMinorId',
        'policyVersion = :policyVersion',
        'revision = :revision',
        'recordedAt = :recordedAt',
      ].join(' AND '),
      ExpressionAttributeNames: { '#side': 'side', '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':entityType': 'Consent',
        ':friendshipId': previous.friendshipId,
        ':requestId': previous.requestId,
        ':requestCycleId': previous.requestCycleId,
        ':side': previous.side,
        ':kind': previous.kind,
        ':actorId': previous.actorId,
        ':subjectMinorId': previous.subjectMinorId,
        ':policyVersion': previous.policyVersion,
        ':revision': previous.revision,
        ':recordedAt': previous.recordedAt,
      },
    },
  };
}

interface ResponsibleAuthority {
  readonly actor: ProfileItem;
  readonly minorId: string;
  readonly snapshot: HouseholdSnapshot;
  readonly role: 'primary_responsible' | 'additional_responsible';
  readonly minorSeat: MinorSeatAssignmentItem;
  readonly supervision: SupervisionLinkItem;
  readonly minorCoverage: CoverageAssignmentItem;
  readonly actorCoverage?: CoverageAssignmentItem;
  readonly additionalSeat?: AdditionalResponsibleSeatAssignmentItem;
}

async function requireResponsibleAuthority(
  ctx: Ctx,
  actor: ProfileItem,
  minorId: string,
  action: 'approve_minor_friendship' | 'revoke_minor_friendship',
): Promise<ResponsibleAuthority> {
  if (!isExactProfile(actor, actor.userId) || actor.accountType !== 'adult') {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  const minorCoverage = await getConsistent<CoverageAssignmentItem>(ctx, FK.familyCoverage(minorId));
  if (
    !minorCoverage ||
    minorCoverage.entityType !== 'CoverageAssignment' ||
    minorCoverage.accountId !== minorId ||
    minorCoverage.seatType !== 'minor'
  ) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  const snapshot = await readHouseholdSnapshot(
    { ddb: ctx.deps.ddb, tableName: ctx.deps.table, now: ctx.deps.now },
    minorCoverage.householdId,
  );
  if (!snapshot) throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  const decision = authorizeFamilyAction({
    actor: {
      accountId: actor.userId,
      accountType: actor.accountType,
      status: actor.status ?? 'active',
      socialEnabled: actor.socialEnabled,
    },
    action,
    household: snapshot,
    targetAccountId: minorId,
    expectedHouseholdRevision: snapshot.household.revision,
    now: ctx.deps.now(),
  });
  if (!decision.allowed || decision.actorRole === 'minor_self') {
    throw new ApiError(
      decision.allowed ? 'RESPONSIBLE_SCOPE_REQUIRED' : decision.code,
    );
  }
  const minorSeat = snapshot.seats.find(
    (seat): seat is MinorSeatAssignmentItem =>
      seat.seatType === 'minor' && seat.state === 'assigned' && seat.accountId === minorId,
  );
  const supervision = snapshot.supervisionLinks.find(
    (link) =>
      link.adultId === actor.userId &&
      link.minorId === minorId &&
      link.role === decision.actorRole &&
      link.state === 'active' &&
      link.validUntil === null &&
      link.validFrom <= ctx.deps.now(),
  );
  const actorCoverage = snapshot.coverages.find(
    (coverage) =>
      coverage.accountId === actor.userId &&
      coverage.householdId === snapshot.household.householdId &&
      coverage.state !== 'ended',
  );
  const canonicalMinorCoverage = snapshot.coverages.find(
    (coverage) =>
      coverage.accountId === minorId &&
      coverage.householdId === snapshot.household.householdId &&
      coverage.seatType === 'minor',
  );
  const additionalSeat =
    decision.actorRole === 'additional_responsible'
      ? snapshot.seats.find(
          (seat): seat is AdditionalResponsibleSeatAssignmentItem =>
            seat.seatType === 'additional_responsible' &&
            seat.state === 'assigned' &&
            seat.accountId === actor.userId,
        )
      : undefined;
  const requiresCurrentActorCoverage =
    decision.actorRole !== 'primary_responsible' || action !== 'revoke_minor_friendship';
  if (
    !minorSeat ||
    !supervision ||
    (requiresCurrentActorCoverage && !actorCoverage) ||
    !canonicalMinorCoverage ||
    (decision.actorRole === 'additional_responsible' && !additionalSeat)
  ) {
    throw new ApiError('RESPONSIBLE_SCOPE_REQUIRED');
  }
  return {
    actor,
    minorId,
    snapshot,
    role: decision.actorRole,
    minorSeat,
    supervision,
    minorCoverage: canonicalMinorCoverage,
    ...(actorCoverage ? { actorCoverage } : {}),
    ...(additionalSeat ? { additionalSeat } : {}),
  };
}

export async function requireMinorFriendOversight(ctx: Ctx, minorId: string): Promise<void> {
  await requireResponsibleAuthority(ctx, ctx.caller, minorId, 'revoke_minor_friendship');
}

function coverageConditionCheck(
  ctx: Ctx,
  coverage: CoverageAssignmentItem,
  mustBeCurrent: boolean,
): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: { pk: coverage.pk, sk: coverage.sk },
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'accountId = :accountId',
        'householdId = :householdId',
        'seatType = :seatType',
        '#state = :state',
        'revision = :revision',
        'paidThrough = :paidThrough',
        'graceUntil = :graceUntil',
        ...(mustBeCurrent
          ? ['(((#state = :active OR #state = :scheduledEnd) AND paidThrough > :now) OR (#state = :grace AND graceUntil > :now))']
          : []),
      ].join(' AND '),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'CoverageAssignment',
        ':accountId': coverage.accountId,
        ':householdId': coverage.householdId,
        ':seatType': coverage.seatType,
        ':state': coverage.state,
        ':revision': coverage.revision,
        ':paidThrough': coverage.paidThrough,
        ':graceUntil': coverage.graceUntil,
        ...(mustBeCurrent
          ? {
              ':active': 'active',
              ':scheduledEnd': 'scheduled_end',
              ':grace': 'grace',
              ':now': ctx.deps.now(),
            }
          : {}),
      },
    },
  };
}

function responsibleAuthorityChecks(ctx: Ctx, authority: ResponsibleAuthority): TransactItem[] {
  const household = authority.snapshot.household;
  const seat = authority.minorSeat;
  const link = authority.supervision;
  return [
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: { pk: household.pk, sk: household.sk },
        ConditionExpression:
          'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND primaryResponsibleId = :primaryResponsibleId AND #state = :active AND revision = :revision',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'Household',
          ':householdId': household.householdId,
          ':primaryResponsibleId': household.primaryResponsibleId,
          ':active': 'active',
          ':revision': household.revision,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: { pk: seat.pk, sk: seat.sk },
        ConditionExpression:
          'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND seatType = :minorSeat AND #state = :assigned AND accountId = :minorId AND seatNumber = :seatNumber AND revision = :revision',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'SeatAssignment',
          ':householdId': household.householdId,
          ':minorSeat': 'minor',
          ':assigned': 'assigned',
          ':minorId': authority.minorId,
          ':seatNumber': seat.seatNumber,
          ':revision': seat.revision,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: ctx.deps.table,
        Key: { pk: link.pk, sk: link.sk },
        ConditionExpression: [
          'attribute_exists(pk)',
          'entityType = :entityType',
          'linkId = :linkId',
          'householdId = :householdId',
          'adultId = :adultId',
          'minorId = :minorId',
          '#role = :role',
          '#state = :active',
          'revision = :revision',
          'validFrom = :validFrom',
          'validFrom <= :now',
          'validUntil = :noEnd',
        ].join(' AND '),
        ExpressionAttributeNames: { '#role': 'role', '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'SupervisionLink',
          ':linkId': link.linkId,
          ':householdId': household.householdId,
          ':adultId': authority.actor.userId,
          ':minorId': authority.minorId,
          ':role': authority.role,
          ':active': 'active',
          ':revision': link.revision,
          ':validFrom': link.validFrom,
          ':now': ctx.deps.now(),
          ':noEnd': null,
        },
      },
    },
    coverageConditionCheck(ctx, authority.minorCoverage, false),
    ...(authority.actorCoverage
      ? [coverageConditionCheck(ctx, authority.actorCoverage, true)]
      : []),
    ...(authority.additionalSeat
      ? [
          {
            ConditionCheck: {
              TableName: ctx.deps.table,
              Key: { pk: authority.additionalSeat.pk, sk: authority.additionalSeat.sk },
              ConditionExpression:
                'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND seatType = :seatType AND #state = :assigned AND accountId = :adultId AND revision = :revision',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':entityType': 'SeatAssignment',
                ':householdId': household.householdId,
                ':seatType': 'additional_responsible',
                ':assigned': 'assigned',
                ':adultId': authority.actor.userId,
                ':revision': authority.additionalSeat.revision,
              },
            },
          } satisfies TransactItem,
        ]
      : []),
    adultProfileGuard(ctx, authority.actor),
    closureAbsenceConditionCheck(ctx.deps, authority.actor.userId),
  ];
}

function transactAddress(item: TransactItem): string {
  if (item.Put) {
    return JSON.stringify([
      item.Put.TableName,
      item.Put.Item?.['pk'],
      item.Put.Item?.['sk'],
    ]);
  }
  const operation = item.Update ?? item.Delete ?? item.ConditionCheck;
  return JSON.stringify([
    operation?.TableName,
    operation?.Key?.['pk'],
    operation?.Key?.['sk'],
  ]);
}

function uniqueWrites(items: readonly TransactItem[]): TransactItem[] {
  const seen = new Map<string, string>();
  return items.filter((item) => {
    const address = transactAddress(item);
    const serialized = JSON.stringify(item);
    const previous = seen.get(address);
    if (previous !== undefined) {
      if (previous !== serialized) {
        throw new Error(`conflicting transaction guards for ${address}`);
      }
      return false;
    }
    seen.set(address, serialized);
    return true;
  });
}

function exactConsentCheck(ctx: Ctx, consent: ConsentItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: ctx.deps.table,
      Key: { pk: consent.pk, sk: consent.sk },
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'friendshipId = :friendshipId',
        'requestId = :requestId',
        'requestCycleId = :requestCycleId',
        '#side = :side',
        '#kind = :kind',
        'actorId = :actorId',
        'subjectMinorId = :subjectMinorId',
        'policyVersion = :policyVersion',
        'revision = :revision',
        'recordedAt = :recordedAt',
      ].join(' AND '),
      ExpressionAttributeNames: { '#side': 'side', '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':entityType': 'Consent',
        ':friendshipId': consent.friendshipId,
        ':requestId': consent.requestId,
        ':requestCycleId': consent.requestCycleId,
        ':side': consent.side,
        ':kind': consent.kind,
        ':actorId': consent.actorId,
        ':subjectMinorId': consent.subjectMinorId,
        ':policyVersion': consent.policyVersion,
        ':revision': consent.revision,
        ':recordedAt': consent.recordedAt,
      },
    },
  };
}

function activationUpdate(ctx: Ctx, before: FriendshipItem, after: FriendshipItem): TransactItem {
  const update = pendingFriendshipUpdate(ctx, before, after.revision).Update!;
  return {
    Update: {
      ...update,
      UpdateExpression:
        'SET #state = :active, revision = :nextRevision, updatedAt = :now, activatedAt = :now, expiresAt = :nextExpiresAt',
      ExpressionAttributeValues: {
        ...update.ExpressionAttributeValues,
        ':active': 'active',
        ':nextExpiresAt': after.expiresAt,
      },
    },
  };
}

function friendMirror(friendship: FriendshipItem, me: string, other: string): FriendItem {
  return {
    ...K.friend(me, other),
    friendshipId: friendship.friendshipId,
    userA: friendship.userA,
    userB: friendship.userB,
    createdAt: friendship.activatedAt ?? friendship.updatedAt,
  };
}

function isExactPendingFriendship(item: FriendshipItem, now: number): boolean {
  if (
    !Number.isSafeInteger(now) ||
    item.entityType !== 'Friendship' ||
    item.friendshipClass !== 'minor_minor' ||
    item.state !== 'pending' ||
    !item.requestId ||
    !item.requestCycleId ||
    !item.requesterId ||
    !item.recipientId ||
    item.expiresAt === null ||
    item.expiresAt <= now ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1 ||
    !Number.isSafeInteger(item.createdAt) ||
    !Number.isSafeInteger(item.updatedAt) ||
    !Number.isSafeInteger(item.expiresAt) ||
    item.createdAt > item.updatedAt ||
    item.updatedAt > now ||
    item.expiresAt <= item.createdAt ||
    item.expiresAt - item.createdAt > MINOR_FRIEND_REQUEST_TTL_MS ||
    item.activatedAt !== null ||
    item.endedAt !== null ||
    !IDENTIFIER_PATTERN.test(item.requestCycleId)
  ) {
    return false;
  }
  try {
    const pair = canonicalFriendshipPair(item.requesterId, item.recipientId);
    const key = SK.friendship(pair.userA, pair.userB);
    return (
      item.friendshipId === pair.friendshipId &&
      item.requestId === `minor-friend:${pair.friendshipId}` &&
      item.userA === pair.userA &&
      item.userB === pair.userB &&
      item.pk === key.pk &&
      item.sk === key.sk
    );
  } catch {
    return false;
  }
}

function isReplaceableMinorFriendship(item: FriendshipItem, now: number): boolean {
  try {
    const pair = canonicalFriendshipPair(item.userA, item.userB);
    const key = SK.friendship(pair.userA, pair.userB);
    const terminal = item.state === 'rejected' || item.state === 'revoked' || item.state === 'expired';
    const expiredPending =
      item.state === 'pending' && item.expiresAt !== null && item.expiresAt <= now;
    return (
      item.entityType === 'Friendship' &&
      item.pk === key.pk &&
      item.sk === key.sk &&
      item.friendshipId === pair.friendshipId &&
      item.userA === pair.userA &&
      item.userB === pair.userB &&
      item.friendshipClass === 'minor_minor' &&
      item.requestId === `minor-friend:${pair.friendshipId}` &&
      item.requestCycleId !== null &&
      item.requesterId !== null &&
      item.recipientId !== null &&
      Number.isSafeInteger(item.revision) &&
      item.revision > 0 &&
      (terminal || expiredPending)
    );
  } catch {
    return false;
  }
}

function friendshipPut(
  ctx: Ctx,
  friendship: FriendshipItem,
  previous: FriendshipItem | null,
): TransactItem {
  if (!previous) {
    return {
      Put: {
        TableName: ctx.deps.table,
        Item: friendship,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    };
  }
  const expiredPending = previous.state === 'pending';
  return {
    Put: {
      TableName: ctx.deps.table,
      Item: friendship,
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'friendshipId = :friendshipId',
        'userA = :userA',
        'userB = :userB',
        'friendshipClass = :friendshipClass',
        '#state = :previousState',
        'requestId = :previousRequestId',
        'requestCycleId = :previousRequestCycleId',
        'requesterId = :previousRequesterId',
        'recipientId = :previousRecipientId',
        'revision = :previousRevision',
        'createdAt = :previousCreatedAt',
        'updatedAt = :previousUpdatedAt',
        'expiresAt = :previousExpiresAt',
        'activatedAt = :previousActivatedAt',
        'endedAt = :previousEndedAt',
        ...(expiredPending ? ['expiresAt <= :now'] : []),
      ].join(' AND '),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'Friendship',
        ':friendshipId': previous.friendshipId,
        ':userA': previous.userA,
        ':userB': previous.userB,
        ':friendshipClass': 'minor_minor',
        ':previousState': previous.state,
        ':previousRequestId': previous.requestId,
        ':previousRequestCycleId': previous.requestCycleId,
        ':previousRequesterId': previous.requesterId,
        ':previousRecipientId': previous.recipientId,
        ':previousRevision': previous.revision,
        ':previousCreatedAt': previous.createdAt,
        ':previousUpdatedAt': previous.updatedAt,
        ':previousExpiresAt': previous.expiresAt,
        ':previousActivatedAt': previous.activatedAt,
        ':previousEndedAt': previous.endedAt,
        ...(expiredPending ? { ':now': ctx.deps.now() } : {}),
      },
    },
  };
}

function parseMinorRequestId(requestId: string): { friendshipId: string; userA: string; userB: string } | null {
  const prefix = 'minor-friend:';
  if (!requestId.startsWith(prefix)) return null;
  const pairId = requestId.slice(prefix.length);
  const pieces = pairId.split('~');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
  try {
    const pair = canonicalFriendshipPair(pieces[0], pieces[1]);
    return pair.friendshipId === pairId ? pair : null;
  } catch {
    return null;
  }
}

async function readMinorRequest(ctx: Ctx, requestId: string): Promise<FriendshipItem> {
  const pair = parseMinorRequestId(requestId);
  if (!pair) throw new ApiError('NOT_FOUND');
  const item = await getConsistent<FriendshipItem>(ctx, SK.friendship(pair.userA, pair.userB));
  if (!item || item.requestId !== requestId || !isExactPendingFriendship(item, ctx.deps.now())) {
    throw new ApiError('NOT_FOUND');
  }
  return item;
}

async function readCurrentConsents(ctx: Ctx, friendship: FriendshipItem): Promise<ConsentItem[]> {
  const now = ctx.deps.now();
  const rows = await Promise.all(
    CONSENT_KINDS.map((kind) => {
      const subject =
        kind === 'requester_action' || kind === 'requester_responsible_approval'
          ? friendship.requesterId!
          : friendship.recipientId!;
      return getConsistent<ConsentItem>(
        ctx,
        SK.consent(friendship.userA, friendship.userB, subject, kind),
      );
    }),
  );
  return rows.filter(
    (row, index): row is ConsentItem =>
      isExactCurrentConsent(friendship, CONSENT_KINDS[index]!, row, now),
  );
}

function minorFriendRequestView(
  friendship: FriendshipItem,
  requester: ProfileItem,
  recipient: ProfileItem,
  consents: readonly ConsentItem[],
): MinorFriendRequestView {
  if (friendship.expiresAt === null) throw new ApiError('CONFLICT', 'request expiry is missing');
  const order = new Map(CONSENT_KINDS.map((kind, index) => [kind, index]));
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    requestId: friendship.requestId!,
    friendshipClass: 'minor_minor',
    state: friendship.state,
    requester: toPublic(requester, false),
    recipient: toPublic(recipient, false),
    consents: [...consents]
      .sort((left, right) => (order.get(left.kind) ?? 0) - (order.get(right.kind) ?? 0))
      .map(({ kind, recordedAt }) => ({ kind, recordedAt })),
    expiresAt: friendship.expiresAt,
    revision: friendship.revision,
  };
}

function minorRequestPointer(minorId: string, friendship: FriendshipItem) {
  return {
    pk: K.user(minorId), sk: `MFR#${friendship.friendshipId}`,
    entityType: 'MinorFriendRequestPointer', minorId,
    requestId: friendship.requestId, requestCycleId: friendship.requestCycleId,
    friendshipId: friendship.friendshipId,
  };
}

/** Read-only discovery for the two minors and their current responsible adults. */
export async function getMinorFriendRequests(ctx: Ctx, minorId: string): Promise<MinorFriendRequestView[]> {
  identifier(minorId, 'minorId');
  await requireWritableOwner(ctx, ctx.callerId);
  const minor = await profileOfConsistent(ctx.deps, minorId);
  if (!minor || !isExactProfile(minor, minorId) || minor.accountType !== 'minor') {
    throw new ApiError('NOT_FOUND');
  }
  if (ctx.callerId === minorId) {
    if (ctx.caller.accountType !== 'minor') throw new ApiError('NOT_FOUND');
  } else {
    await requireResponsibleAuthority(ctx, ctx.caller, minorId, 'revoke_minor_friendship');
  }
  const result = await ctx.deps.ddb.send(new QueryCommand({
    TableName: ctx.deps.table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': K.user(minorId), ':prefix': 'MFR#' },
    ConsistentRead: true,
    Limit: 100,
  }));
  const views: MinorFriendRequestView[] = [];
  for (const row of result.Items ?? []) {
    if (row['pk'] !== K.user(minorId) || row['entityType'] !== 'MinorFriendRequestPointer' ||
      row['minorId'] !== minorId || typeof row['friendshipId'] !== 'string' ||
      row['sk'] !== `MFR#${row['friendshipId']}` || typeof row['requestId'] !== 'string') continue;
    const pair = parseMinorRequestId(row['requestId']);
    if (!pair || pair.friendshipId !== row['friendshipId']) continue;
    const friendship = await getConsistent<FriendshipItem>(ctx, SK.friendship(pair.userA, pair.userB));
    if (!friendship || friendship.requestId !== row['requestId'] ||
      friendship.requestCycleId !== row['requestCycleId'] ||
      !isExactPendingFriendship(friendship, ctx.deps.now()) ||
      (friendship.requesterId !== minorId && friendship.recipientId !== minorId)) continue;
    const [requester, recipient, consents] = await Promise.all([
      profileOfConsistent(ctx.deps, friendship.requesterId!),
      profileOfConsistent(ctx.deps, friendship.recipientId!),
      readCurrentConsents(ctx, friendship),
    ]);
    if (!requester || !recipient) continue;
    views.push(minorFriendRequestView(friendship, requester, recipient, consents));
  }
  return views;
}

function embeddedMinorProfiles(profiles: readonly ProfileItem[]) {
  return Object.fromEntries(profiles.map((profile) => [profile.userId, { profile: true as const }]));
}

export async function mintMinorInviteCode(
  ctx: Ctx,
  body: CreateMinorInviteCodeRequest,
): Promise<CodeGrant> {
  const request = parseInviteBody(body);
  const authority = ctx.callerId === request.minorId
    ? null
    : await requireResponsibleAuthority(
        ctx,
        ctx.caller,
        request.minorId,
        'approve_minor_friendship',
      );
  const minor = requireCurrentMinor(
    await profileOfConsistent(ctx.deps, request.minorId),
    request.minorId,
    ctx.deps.now(),
  );
  let code = friendCode();
  while (code === minor.friendCode) code = friendCode();
  const now = ctx.deps.now();
  const grant = createMinorFriendInviteCode({
    code,
    minorId: minor.userId,
    issuedById: ctx.callerId,
    now,
    expiresAt: now + MINOR_FRIEND_INVITE_TTL_MS,
  });
  let previousMinor: MinorFriendInviteCodeItem | null = null;
  let previousLegacy: CodeItem | null = null;
  let previousMinorKey: { pk: string; sk: 'CODE' } | null = null;
  if (minor.friendCode) {
    try {
      previousMinorKey = SK.minorInviteCode(minor.friendCode);
    } catch {
      previousMinorKey = null;
    }
    [previousMinor, previousLegacy] = await Promise.all([
      previousMinorKey
        ? getItem<MinorFriendInviteCodeItem>(ctx.deps, previousMinorKey)
        : Promise.resolve(null),
      getItem<CodeItem>(ctx.deps, K.codeF(minor.friendCode)),
    ]);
  }
  const writes: TransactItem[] = [
    {
      Put: {
        TableName: ctx.deps.table,
        Item: grant,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Update: {
        TableName: ctx.deps.table,
        Key: K.profile(minor.userId),
        UpdateExpression: 'SET friendCode = :code',
        ConditionExpression:
          `${WRITABLE_PROFILE_CONDITION} AND ` +
          `(#userId = :userId AND #accountType = :minor AND #socialEnabled = :enabled AND majorityAt = :majorityAt AND majorityAt > :today AND ${
            minor.friendCode ? 'friendCode = :previousCode' : 'attribute_not_exists(friendCode)'
          })`,
        ExpressionAttributeNames: {
          '#status': 'status',
          '#userId': 'userId',
          '#accountType': 'accountType',
          '#socialEnabled': 'socialEnabled',
        },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':userId': minor.userId,
          ':minor': 'minor',
          ':enabled': true,
          ':majorityAt': minor.majorityAt,
          ':today': currentIsoDate(now),
          ':code': code,
          ...(minor.friendCode ? { ':previousCode': minor.friendCode } : {}),
        },
      },
    },
  ];
  if (minor.friendCode) {
    if (previousMinorKey) {
      writes.push(
        previousMinor &&
        previousMinor.entityType === 'MinorFriendInviteCode' &&
        previousMinor.kind === 'minor_friend' &&
        previousMinor.minorId === minor.userId
          ? exactMinorCodeOperation(ctx, previousMinor, 'delete')
          : absentConditionCheck(ctx.deps, previousMinorKey),
      );
    }
    writes.push(
      previousLegacy &&
      previousLegacy.kind === 'friend' &&
      previousLegacy.userId === minor.userId
        ? exactCodeOperation(ctx.deps, previousLegacy, 'delete')
        : absentConditionCheck(ctx.deps, K.codeF(minor.friendCode)),
    );
  }
  await guardedSocialWrite(
    ctx,
    'create',
    [minor.userId],
    uniqueWrites([
      ...writes,
      ...(authority ? responsibleAuthorityChecks(ctx, authority) : []),
    ]),
    undefined,
    { [minor.userId]: { profile: true } },
  );
  return { code, expiresAt: grant.expiresAt };
}

export async function createMinorFriendRequest(
  ctx: Ctx,
  body: CreateMinorFriendRequestRequest,
): Promise<MinorFriendRequestView> {
  const request = parseCreateBody(body);
  if (ctx.caller.accountType !== 'minor' || ctx.callerId !== request.minorId) {
    throw new ApiError('ADULT_MINOR_FRIENDSHIP_FORBIDDEN');
  }
  if (!isExactProfile(ctx.caller, ctx.callerId)) throw new ApiError('UNAUTHENTICATED');

  await reserveCodeAttempt(ctx);
  const grant = await getConsistent<MinorFriendInviteCodeItem>(ctx, SK.minorInviteCode(request.code));
  if (!grant || !isExactCurrentMinorCode(grant, request.code, ctx.deps.now())) {
    throw new ApiError('CODE_INVALID');
  }
  if (grant.expiresAt <= ctx.deps.now()) throw new ApiError('CODE_EXPIRED');
  if (grant.minorId === ctx.callerId) throw new ApiError('VALIDATION', 'that is your own code');
  const recipient = await profileOfConsistent(ctx.deps, grant.minorId);
  let target: ProfileItem;
  try {
    target = requireCurrentMinor(recipient, grant.minorId, ctx.deps.now());
  } catch {
    throw new ApiError('CODE_INVALID');
  }
  if (target.friendCode !== grant.code) throw new ApiError('CODE_INVALID');
  const requester = requireCurrentMinor(ctx.caller, ctx.callerId, ctx.deps.now());
  const decision = authorizeFriendRequest({
    actor: policyPerson(requester),
    target: policyPerson(target),
    action: 'create',
    now: ctx.deps.now(),
  });
  if (!decision.allowed || decision.friendshipClass !== 'minor_minor') {
    throw new ApiError(decision.allowed ? 'CONFLICT' : decision.code);
  }
  const pair = canonicalFriendshipPair(requester.userId, target.userId);
  const existing = await getConsistent<FriendshipItem>(ctx, SK.friendship(pair.userA, pair.userB));
  if (existing && !isReplaceableMinorFriendship(existing, ctx.deps.now())) {
    throw new ApiError('CONFLICT', 'friendship or request already exists');
  }

  const now = ctx.deps.now();
  if (grant.expiresAt <= now) throw new ApiError('CODE_EXPIRED');
  const pending = createPendingMinorFriendship({
    requesterId: requester.userId,
    recipientId: target.userId,
    requestCycleId: `cycle-${friendCode(16)}`,
    now,
    expiresAt: now + MINOR_FRIEND_REQUEST_TTL_MS,
  });
  const friendship: FriendshipItem = {
    ...pending,
    revision: existing ? existing.revision + 2 : 2,
  };
  const consent = createMinorFriendConsent({
    friendship: pending,
    kind: 'requester_action',
    actorId: requester.userId,
    subjectMinorId: requester.userId,
    policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    now,
  });
  const participants = [requester, target];
  await guardedSocialWrite(
    ctx,
    'create',
    participants.map(({ userId }) => userId),
    [
      friendshipPut(ctx, friendship, existing),
      ...[requester.userId, target.userId].map((minorId): TransactItem => ({ Put: {
        TableName: ctx.deps.table, Item: minorRequestPointer(minorId, friendship),
      } })),
      consentPut(ctx, consent),
      exactMinorCodeOperation(ctx, grant, 'delete', now),
      absentConditionCheck(ctx.deps, K.friend(pair.userA, pair.userB)),
      absentConditionCheck(ctx.deps, K.friend(pair.userB, pair.userA)),
      minorProfileGuard(ctx, requester),
      consumeMinorCodePointer(ctx, target, grant.code),
    ],
    undefined,
    embeddedMinorProfiles(participants),
  );
  return minorFriendRequestView(friendship, requester, target, [consent]);
}

export async function recordMinorAcceptance(
  ctx: Ctx,
  requestId: string,
  body: MinorFriendActionRequest,
): Promise<MinorFriendRequestView> {
  const request = parseActionBody(body);
  const friendship = await readMinorRequest(ctx, requestId);
  if (
    ctx.caller.accountType !== 'minor' ||
    ctx.callerId !== request.minorId ||
    friendship.recipientId !== request.minorId
  ) {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  const [requester, recipient, existingConsents] = await Promise.all([
    profileOfConsistent(ctx.deps, friendship.requesterId!),
    profileOfConsistent(ctx.deps, friendship.recipientId!),
    readCurrentConsents(ctx, friendship),
  ]);
  const left = requireCurrentMinor(requester, friendship.requesterId!, ctx.deps.now());
  const right = requireCurrentMinor(recipient, friendship.recipientId!, ctx.deps.now());
  const decision = authorizeFriendRequest({
    actor: policyPerson(right),
    target: policyPerson(left),
    action: 'accept',
    now: ctx.deps.now(),
  });
  if (!decision.allowed || decision.friendshipClass !== 'minor_minor') {
    throw new ApiError(decision.allowed ? 'CONFLICT' : decision.code);
  }
  const kind = 'recipient_acceptance' as const;
  const existing = existingConsents.find((consent) => consent.kind === kind);
  if (existing) {
    const expected = createMinorFriendConsent({
      friendship,
      kind,
      actorId: ctx.callerId,
      subjectMinorId: request.minorId,
      policyVersion: request.policyVersion,
      now: existing.recordedAt,
    });
    if (!sameConsent(existing, expected)) throw new ApiError('CONSENT_INCOMPLETE');
    return activateMinorFriendshipIfReady(
      ctx,
      friendship,
      left,
      right,
      existingConsents,
    );
  }
  const consent = createMinorFriendConsent({
    friendship,
    kind,
    actorId: ctx.callerId,
    subjectMinorId: request.minorId,
    policyVersion: request.policyVersion,
    now: ctx.deps.now(),
  });
  const updated: FriendshipItem = {
    ...friendship,
    revision: friendship.revision + 1,
    updatedAt: ctx.deps.now(),
  };
  const participants = [left, right];
  await guardedSocialWrite(
    ctx,
    'accept',
    participants.map(({ userId }) => userId),
    [
      consentPut(ctx, consent),
      pendingFriendshipUpdate(ctx, friendship, updated.revision),
      ...participants.map((profile) => minorProfileGuard(ctx, profile)),
    ],
    undefined,
    embeddedMinorProfiles(participants),
  );
  return activateMinorFriendshipIfReady(
    ctx,
    updated,
    left,
    right,
    [...existingConsents, consent],
  );
}

async function activateMinorFriendshipIfReady(
  ctx: Ctx,
  friendship: FriendshipItem,
  requester: ProfileItem,
  recipient: ProfileItem,
  consents: readonly ConsentItem[],
): Promise<MinorFriendRequestView> {
  if (!hasFourCurrentMinorFriendConsents(friendship, consents, ctx.deps.now())) {
    return minorFriendRequestView(friendship, requester, recipient, consents);
  }
  const requesterApproval = consents.find(
    (consent) => consent.kind === 'requester_responsible_approval',
  );
  const recipientApproval = consents.find(
    (consent) => consent.kind === 'recipient_responsible_approval',
  );
  if (!requesterApproval || !recipientApproval) throw new ApiError('CONSENT_INCOMPLETE');
  const [requesterResponsible, recipientResponsible] = await Promise.all([
    profileOfConsistent(ctx.deps, requesterApproval.actorId),
    profileOfConsistent(ctx.deps, recipientApproval.actorId),
  ]);
  if (
    !requesterResponsible ||
    !recipientResponsible ||
    requesterResponsible.accountType !== 'adult' ||
    recipientResponsible.accountType !== 'adult'
  ) {
    throw new ApiError('CONSENT_INCOMPLETE');
  }
  const authorityResults = await Promise.allSettled([
    requireResponsibleAuthority(
      ctx,
      requesterResponsible,
      friendship.requesterId!,
      'approve_minor_friendship',
    ),
    requireResponsibleAuthority(
      ctx,
      recipientResponsible,
      friendship.recipientId!,
      'approve_minor_friendship',
    ),
  ]);
  for (const result of authorityResults) {
    if (result.status === 'rejected' && !(result.reason instanceof ApiError)) {
      throw result.reason;
    }
  }
  if (authorityResults.some((result) => result.status === 'rejected')) {
    throw new ApiError('CONSENT_INCOMPLETE');
  }
  const authorities = authorityResults.map((result) => {
    if (result.status !== 'fulfilled') throw new ApiError('CONSENT_INCOMPLETE');
    return result.value;
  }) as unknown as readonly [ResponsibleAuthority, ResponsibleAuthority];

  const active = activateMinorFriendship(friendship, consents, ctx.deps.now());
  const mirrors = [
    friendMirror(active, active.userA, active.userB),
    friendMirror(active, active.userB, active.userA),
  ];
  const writes = uniqueWrites([
    activationUpdate(ctx, friendship, active),
    ...consents.map((consent) => exactConsentCheck(ctx, consent)),
    ...mirrors.map(
      (mirror): TransactItem => ({
        Put: {
          TableName: ctx.deps.table,
          Item: mirror,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      }),
    ),
    minorProfileGuard(ctx, requester),
    minorProfileGuard(ctx, recipient),
    ...authorities.flatMap((authority) => responsibleAuthorityChecks(ctx, authority)),
  ]);
  try {
    await guardedSocialWrite(
      ctx,
      'accept',
      [requester.userId, recipient.userId],
      writes,
      undefined,
      embeddedMinorProfiles([requester, recipient]),
    );
    return minorFriendRequestView(active, requester, recipient, consents);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'CONFLICT') throw error;
    const current = await getConsistent<FriendshipItem>(
      ctx,
      SK.friendship(friendship.userA, friendship.userB),
    );
    if (
      current &&
      isExactActiveMinorFriendship(current, friendship.friendshipId, ctx.deps.now()) &&
      current.requestId === friendship.requestId &&
      current.requestCycleId === friendship.requestCycleId
    ) {
      return minorFriendRequestView(current, requester, recipient, consents);
    }
    throw error;
  }
}

export async function recordResponsibleApproval(
  ctx: Ctx,
  requestId: string,
  body: MinorFriendActionRequest,
): Promise<MinorFriendRequestView> {
  const request = parseActionBody(body);
  if (!isExactProfile(ctx.caller, ctx.callerId) || ctx.caller.accountType !== 'adult') {
    throw new ApiError('ACCOUNT_TYPE_INCOMPATIBLE');
  }
  const friendship = await readMinorRequest(ctx, requestId);
  if (request.minorId !== friendship.requesterId && request.minorId !== friendship.recipientId) {
    throw new ApiError('NOT_FOUND');
  }
  const [requesterRow, recipientRow, existingConsents] = await Promise.all([
    profileOfConsistent(ctx.deps, friendship.requesterId!),
    profileOfConsistent(ctx.deps, friendship.recipientId!),
    readCurrentConsents(ctx, friendship),
  ]);
  const requester = requireCurrentMinor(requesterRow, friendship.requesterId!, ctx.deps.now());
  const recipient = requireCurrentMinor(recipientRow, friendship.recipientId!, ctx.deps.now());
  const pairDecision = authorizeFriendRequest({
    actor: policyPerson(requester),
    target: policyPerson(recipient),
    action: 'accept',
    now: ctx.deps.now(),
  });
  if (!pairDecision.allowed || pairDecision.friendshipClass !== 'minor_minor') {
    throw new ApiError(pairDecision.allowed ? 'CONFLICT' : pairDecision.code);
  }
  const authority = await requireResponsibleAuthority(
    ctx,
    ctx.caller,
    request.minorId,
    'approve_minor_friendship',
  );
  const kind =
    request.minorId === friendship.requesterId
      ? 'requester_responsible_approval' as const
      : 'recipient_responsible_approval' as const;
  const previous = existingConsents.find((consent) => consent.kind === kind);
  if (
    previous &&
    previous.actorId === ctx.callerId &&
    previous.subjectMinorId === request.minorId &&
    previous.policyVersion === MINOR_SOCIAL_POLICY_VERSION
  ) {
    return activateMinorFriendshipIfReady(
      ctx,
      friendship,
      requester,
      recipient,
      existingConsents,
    );
  }
  const freshConsent = createMinorFriendConsent({
    friendship,
    kind,
    actorId: ctx.callerId,
    subjectMinorId: request.minorId,
    policyVersion: request.policyVersion,
    now: ctx.deps.now(),
  });
  const consent: ConsentItem = previous
    ? { ...freshConsent, revision: previous.revision + 1 }
    : freshConsent;
  const updated: FriendshipItem = {
    ...friendship,
    revision: friendship.revision + 1,
    updatedAt: ctx.deps.now(),
  };
  const participants = [requester, recipient];
  await guardedSocialWrite(
    ctx,
    'accept',
    participants.map(({ userId }) => userId),
    uniqueWrites([
      exactConsentPut(ctx, consent, previous),
      pendingFriendshipUpdate(ctx, friendship, updated.revision),
      ...participants.map((profile) => minorProfileGuard(ctx, profile)),
      ...responsibleAuthorityChecks(ctx, authority),
    ]),
    undefined,
    embeddedMinorProfiles(participants),
  );
  const nextConsents = [
    ...existingConsents.filter((candidate) => candidate.kind !== kind),
    consent,
  ];
  return activateMinorFriendshipIfReady(
    ctx,
    updated,
    requester,
    recipient,
    nextConsents,
  );
}

function terminalPendingUpdate(
  ctx: Ctx,
  friendship: FriendshipItem,
  state: 'rejected' | 'expired',
): TransactItem {
  const update = pendingFriendshipUpdate(ctx, friendship, friendship.revision + 1).Update!;
  const stateToken = state === 'rejected' ? ':rejected' : ':expired';
  return {
    Update: {
      ...update,
      UpdateExpression:
        `SET #state = ${stateToken}, revision = :nextRevision, updatedAt = :now, endedAt = :now`,
      ExpressionAttributeValues: {
        ...update.ExpressionAttributeValues,
        [stateToken]: state,
      },
    },
  };
}

export async function rejectMinorFriendRequest(
  ctx: Ctx,
  requestId: string,
  body: MinorFriendActionRequest,
): Promise<void> {
  const request = parseActionBody(body);
  const friendship = await readMinorRequest(ctx, requestId);
  if (request.minorId !== friendship.requesterId && request.minorId !== friendship.recipientId) {
    throw new ApiError('NOT_FOUND');
  }
  let authority: ResponsibleAuthority | null = null;
  if (ctx.caller.accountType === 'minor') {
    if (ctx.callerId !== request.minorId || !isExactProfile(ctx.caller, ctx.callerId)) {
      throw new ApiError('NOT_FOUND');
    }
  } else if (ctx.caller.accountType === 'adult') {
    authority = await requireResponsibleAuthority(
      ctx,
      ctx.caller,
      request.minorId,
      'revoke_minor_friendship',
    );
  } else {
    throw new ApiError('NOT_FOUND');
  }
  const writes = uniqueWrites([
    terminalPendingUpdate(ctx, friendship, 'rejected'),
    ...(authority ? responsibleAuthorityChecks(ctx, authority) : []),
  ]);
  await guardedWrite(
    ctx,
    [friendship.userA, friendship.userB],
    writes,
  );
}

function parseFriendshipId(friendshipId: string): { userA: string; userB: string } | null {
  const pieces = friendshipId.split('~');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
  try {
    const pair = canonicalFriendshipPair(pieces[0], pieces[1]);
    return pair.friendshipId === friendshipId ? pair : null;
  } catch {
    return null;
  }
}

function isExactActiveMinorFriendship(
  friendship: FriendshipItem,
  friendshipId: string,
  now: number,
): boolean {
  const pair = parseFriendshipId(friendshipId);
  if (!pair) return false;
  const key = SK.friendship(pair.userA, pair.userB);
  if (
    friendship.entityType !== 'Friendship' ||
    friendship.pk !== key.pk ||
    friendship.sk !== key.sk ||
    friendship.friendshipId !== friendshipId ||
    friendship.userA !== pair.userA ||
    friendship.userB !== pair.userB ||
    friendship.friendshipClass !== 'minor_minor' ||
    friendship.state !== 'active' ||
    friendship.requestId !== `minor-friend:${friendshipId}` ||
    friendship.requestCycleId === null ||
    friendship.requesterId === null ||
    friendship.recipientId === null ||
    friendship.expiresAt === null ||
    friendship.activatedAt === null ||
    friendship.endedAt !== null ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(friendship.revision) ||
    friendship.revision < 1 ||
    !Number.isSafeInteger(friendship.createdAt) ||
    !Number.isSafeInteger(friendship.updatedAt) ||
    !Number.isSafeInteger(friendship.expiresAt) ||
    !Number.isSafeInteger(friendship.activatedAt) ||
    friendship.createdAt > friendship.activatedAt ||
    friendship.activatedAt > friendship.updatedAt ||
    friendship.updatedAt > now ||
    friendship.expiresAt <= friendship.createdAt ||
    friendship.expiresAt - friendship.createdAt > MINOR_FRIEND_REQUEST_TTL_MS ||
    !IDENTIFIER_PATTERN.test(friendship.requestCycleId)
  ) {
    return false;
  }
  try {
    return canonicalFriendshipPair(
      friendship.requesterId,
      friendship.recipientId,
    ).friendshipId === friendshipId;
  } catch {
    return false;
  }
}

function revokeActiveUpdate(ctx: Ctx, friendship: FriendshipItem): TransactItem {
  return {
    Update: {
      TableName: ctx.deps.table,
      Key: { pk: friendship.pk, sk: friendship.sk },
      UpdateExpression:
        'SET #state = :revoked, revision = :nextRevision, updatedAt = :now, endedAt = :now',
      ConditionExpression: [
        'attribute_exists(pk)',
        'entityType = :entityType',
        'friendshipId = :friendshipId',
        'userA = :userA',
        'userB = :userB',
        'friendshipClass = :friendshipClass',
        '#state = :active',
        'requestId = :requestId',
        'requestCycleId = :requestCycleId',
        'requesterId = :requesterId',
        'recipientId = :recipientId',
        'revision = :expectedRevision',
        'createdAt = :createdAt',
        'updatedAt = :updatedAt',
        'expiresAt = :expiresAt',
        'activatedAt = :activatedAt',
        'endedAt = :endedAt',
      ].join(' AND '),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'Friendship',
        ':friendshipId': friendship.friendshipId,
        ':userA': friendship.userA,
        ':userB': friendship.userB,
        ':friendshipClass': 'minor_minor',
        ':active': 'active',
        ':revoked': 'revoked',
        ':requestId': friendship.requestId,
        ':requestCycleId': friendship.requestCycleId,
        ':requesterId': friendship.requesterId,
        ':recipientId': friendship.recipientId,
        ':expectedRevision': friendship.revision,
        ':nextRevision': friendship.revision + 1,
        ':createdAt': friendship.createdAt,
        ':updatedAt': friendship.updatedAt,
        ':expiresAt': friendship.expiresAt,
        ':activatedAt': friendship.activatedAt,
        ':endedAt': friendship.endedAt,
        ':now': ctx.deps.now(),
      },
    },
  };
}

export async function revokeMinorFriendship(ctx: Ctx, friendshipId: string): Promise<void> {
  const pair = parseFriendshipId(friendshipId);
  if (!pair) throw new ApiError('NOT_FOUND');
  const friendship = await getConsistent<FriendshipItem>(
    ctx,
    SK.friendship(pair.userA, pair.userB),
  );
  if (!friendship || !isExactActiveMinorFriendship(friendship, friendshipId, ctx.deps.now())) {
    throw new ApiError('NOT_FOUND');
  }
  let authority: ResponsibleAuthority | null = null;
  if (ctx.caller.accountType === 'minor') {
    if (
      !isExactProfile(ctx.caller, ctx.callerId) ||
      (ctx.callerId !== pair.userA && ctx.callerId !== pair.userB)
    ) {
      throw new ApiError('NOT_FOUND');
    }
  } else if (ctx.caller.accountType === 'adult') {
    for (const minorId of [pair.userA, pair.userB]) {
      try {
        authority = await requireResponsibleAuthority(
          ctx,
          ctx.caller,
          minorId,
          'revoke_minor_friendship',
        );
        break;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Keep the pair private and try the other participant.
      }
    }
    if (!authority) throw new ApiError('NOT_FOUND');
  } else {
    throw new ApiError('NOT_FOUND');
  }
  await guardedWrite(
    ctx,
    [pair.userA, pair.userB],
    uniqueWrites([
      revokeActiveUpdate(ctx, friendship),
      { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.userA, pair.userB) } },
      { Delete: { TableName: ctx.deps.table, Key: K.friend(pair.userB, pair.userA) } },
      ...(authority ? responsibleAuthorityChecks(ctx, authority) : []),
    ]),
  );
}

export const minorSocialInternals = {
  activateMinorFriendshipIfReady,
  exactMinorCodeOperation,
  isExactPendingFriendship,
  minorProfileGuard,
  parseMinorRequestId,
  readCurrentConsents,
  requireResponsibleAuthority,
  responsibleAuthorityChecks,
};
