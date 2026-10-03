import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { K, type ProfileItem } from '../db';
import { FK } from './keys';
import { createEmptySeatAssignments, createHousehold, validateHouseholdSnapshot,
  type CoverageAssignmentItem, type HouseholdSnapshot, type SeatAssignmentItem } from './model';

type Item = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export const MAJORITY_GSI_PK = 'FAMILY#MAJORITY';
export function majorityGsiSk(majorityAt: string, accountId: string): string {
  return `${majorityAt}#${accountId}`;
}

function endCoverage(tableName: string, coverage: CoverageAssignmentItem, now: number): Item {
  const base = {
    TableName: tableName, Key: FK.familyCoverage(coverage.accountId),
    ConditionExpression: 'entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #state = :state AND revision = :expectedRevision',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ':entityType': 'CoverageAssignment',
      ':accountId': coverage.accountId, ':householdId': coverage.householdId,
      ':seatType': coverage.seatType, ':state': coverage.state,
      ':expectedRevision': coverage.revision },
  };
  if (coverage.state === 'ended') return { ConditionCheck: base };
  return { Update: {
    ...base,
    UpdateExpression: 'SET #state = :ended, revision = :nextRevision, updatedAt = :now',
    ExpressionAttributeValues: { ...base.ExpressionAttributeValues,
      ':ended': 'ended', ':nextRevision': coverage.revision + 1, ':now': now },
  } };
}

function releaseSeat(tableName: string, seat: SeatAssignmentItem,
  accountId: string, now: number): Item {
  return { Update: {
    TableName: tableName, Key: { pk: seat.pk, sk: seat.sk },
    UpdateExpression: 'SET #state = :empty, accountId = :none, assignedAt = :none, revision = :nextRevision, updatedAt = :now',
    ConditionExpression: 'entityType = :entityType AND householdId = :householdId AND #state = :assigned AND accountId = :accountId AND revision = :expectedRevision',
    ExpressionAttributeNames: { '#state': 'state' },
    ExpressionAttributeValues: { ':entityType': 'SeatAssignment',
      ':householdId': seat.householdId, ':assigned': 'assigned', ':empty': 'empty',
      ':accountId': accountId, ':expectedRevision': seat.revision,
      ':nextRevision': seat.revision + 1, ':none': null, ':now': now },
  } };
}

/** One CAS transaction closes supervision and coverage without touching account data or forests. */
export function buildMajorityTransition(input: {
  readonly tableName: string;
  readonly now: number;
  readonly profile: ProfileItem;
  readonly snapshot: HouseholdSnapshot;
}): Item[] {
  const { tableName, now, profile, snapshot } = input;
  validateHouseholdSnapshot(snapshot, now);
  const today = new Date(now).toISOString().slice(0, 10);
  if (profile.accountType !== 'minor' || !profile.majorityAt ||
    profile.majorityAt > today || profile.status !== 'active' ||
    profile.gsi2pk !== MAJORITY_GSI_PK ||
    profile.gsi2sk !== majorityGsiSk(profile.majorityAt, profile.userId)) {
    throw new Error('minor is not due for an indexed majority transition');
  }
  const seat = snapshot.seats.find((item) => item.seatType === 'minor' &&
    item.state === 'assigned' && item.accountId === profile.userId);
  const coverage = snapshot.coverages.find((item) => item.accountId === profile.userId);
  const links = snapshot.supervisionLinks.filter((item) => item.minorId === profile.userId &&
    item.state === 'active');
  if (!seat || !coverage || coverage.seatType !== 'minor' || links.length < 1 ||
    links.length > 2 || !links.some((link) => link.role === 'primary_responsible')) {
    throw new Error('minor household facts are incomplete');
  }
  const additionalSeat = snapshot.seats.find((item) => item.seatType === 'additional_responsible');
  const lastAdditionalScope = additionalSeat?.state === 'assigned' &&
    links.some((link) => link.role === 'additional_responsible') &&
    !snapshot.supervisionLinks.some((link) => link.role === 'additional_responsible' &&
      link.state === 'active' && link.minorId !== profile.userId);
  const additionalCoverage = lastAdditionalScope && additionalSeat.accountId
    ? snapshot.coverages.find((item) => item.accountId === additionalSeat.accountId)
    : undefined;
  const adultHousehold = createHousehold({ primaryResponsibleId: profile.userId, now });
  return [
    { Update: {
      TableName: tableName, Key: K.profile(profile.userId),
      UpdateExpression: 'SET accountType = :adult, familyFenceVersion = :fence REMOVE gsi2pk, gsi2sk',
      ConditionExpression: 'userId = :userId AND accountType = :minor AND #status = :active AND majorityAt = :majorityAt AND gsi2pk = :gsi2pk AND gsi2sk = :gsi2sk',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':userId': profile.userId, ':minor': 'minor',
        ':adult': 'adult', ':active': 'active', ':fence': 1,
        ':majorityAt': profile.majorityAt, ':gsi2pk': MAJORITY_GSI_PK,
        ':gsi2sk': profile.gsi2sk },
    } },
    { Update: {
      TableName: tableName, Key: FK.household(snapshot.household.householdId),
      UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
      ConditionExpression: 'entityType = :entityType AND primaryResponsibleId = :primaryId AND #state = :active AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'Household',
        ':primaryId': snapshot.household.primaryResponsibleId, ':active': 'active',
        ':revision': snapshot.household.revision,
        ':nextRevision': snapshot.household.revision + 1, ':now': now },
    } },
    releaseSeat(tableName, seat, profile.userId, now),
    ...links.map((link): Item => ({ Update: {
      TableName: tableName, Key: FK.supervision(profile.userId, link.adultId),
      UpdateExpression: 'SET #state = :ended, validUntil = :now, revision = :nextRevision, updatedAt = :now',
      ConditionExpression: 'entityType = :entityType AND householdId = :householdId AND minorId = :minorId AND adultId = :adultId AND #state = :active AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'SupervisionLink',
        ':householdId': snapshot.household.householdId, ':minorId': profile.userId,
        ':adultId': link.adultId, ':active': 'active', ':ended': 'ended',
        ':revision': link.revision, ':nextRevision': link.revision + 1, ':now': now },
    } })),
    endCoverage(tableName, coverage, now),
    ...(lastAdditionalScope && additionalSeat?.accountId ? [
      releaseSeat(tableName, additionalSeat, additionalSeat.accountId, now),
      ...(additionalCoverage ? [endCoverage(tableName, additionalCoverage, now)] : []),
    ] : []),
    { Put: { TableName: tableName, Item: adultHousehold,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' } },
    ...createEmptySeatAssignments(adultHousehold.householdId, now).map((item): Item => ({
      Put: { TableName: tableName, Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' },
    })),
  ];
}
