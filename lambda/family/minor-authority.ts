import { ApiError } from '@app/api/contracts';
import { GetCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { K, type Deps, type LinkItem, type ProfileItem } from '../db';
import { FK } from './keys';
import type {
  HouseholdItem,
  MinorSeatAssignmentItem,
  SupervisionLinkItem,
} from './model';
import { authorizeFamilyAction, type FamilyAction } from './policy';
import { readHouseholdSnapshot } from './repository';

export type PrimaryMinorAction = Extract<
  FamilyAction,
  'manage_minor_recovery' | 'manage_minor_identity' | 'export_minor' | 'delete_minor'
>;

export type PrimaryMinorAuthority =
  | {
      readonly model: 'legacy';
      readonly link: LinkItem;
    }
  | {
      readonly model: 'household_v2';
      readonly household: HouseholdItem;
      readonly seat: MinorSeatAssignmentItem;
      readonly supervision: SupervisionLinkItem;
    };

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

async function readConsistent<T>(
  deps: Pick<Deps, 'ddb' | 'table'>,
  key: { readonly pk: string; readonly sk: string },
): Promise<T | null> {
  const result = await deps.ddb.send(
    new GetCommand({ TableName: deps.table, Key: key, ConsistentRead: true }),
  );
  return (result.Item as T | undefined) ?? null;
}

/**
 * Resolves sensitive minor authority from Household v2 whenever the minor has
 * entered that model. A legacy created-link fallback remains only for accounts
 * that have not been migrated yet.
 */
export async function requirePrimaryMinorAuthority(
  deps: Pick<Deps, 'ddb' | 'table' | 'now'>,
  actor: ProfileItem,
  minorId: string,
  action: PrimaryMinorAction,
): Promise<PrimaryMinorAuthority> {
  const coverage = await readConsistent<{ householdId?: unknown }>(
    deps,
    FK.familyCoverage(minorId),
  );
  if (!coverage) {
    const link = await readConsistent<LinkItem>(deps, K.link(minorId, actor.userId));
    if (!link) throw new ApiError('NOT_FOUND');
    if (
      link.kind !== 'created' ||
      link.guardianId !== actor.userId ||
      link.minorId !== minorId
    ) {
      throw new ApiError('FORBIDDEN', 'only the current primary responsible administers identity');
    }
    return { model: 'legacy', link };
  }
  if (typeof coverage.householdId !== 'string') {
    throw new ApiError('FORBIDDEN', 'family authority is not canonical');
  }

  const minor = await readConsistent<ProfileItem>(deps, K.profile(minorId));
  if (!minor || minor.accountType !== 'minor' ||
    (minor.majorityAt !== undefined &&
      minor.majorityAt <= new Date(deps.now()).toISOString().slice(0, 10))) {
    throw new ApiError('NOT_FOUND');
  }

  const snapshot = await readHouseholdSnapshot(
    { ddb: deps.ddb, tableName: deps.table, now: deps.now },
    coverage.householdId,
  );
  if (!snapshot) throw new ApiError('FORBIDDEN', 'family authority is not canonical');
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
    now: deps.now(),
  });
  if (!decision.allowed) throw new ApiError(decision.code);
  if (decision.actorRole !== 'primary_responsible') throw new ApiError('FORBIDDEN');

  const seat = snapshot.seats.find(
    (candidate): candidate is MinorSeatAssignmentItem =>
      candidate.seatType === 'minor' &&
      candidate.state === 'assigned' &&
      candidate.accountId === minorId,
  );
  const supervision = snapshot.supervisionLinks.find(
    (candidate) =>
      candidate.minorId === minorId &&
      candidate.adultId === actor.userId &&
      candidate.role === 'primary_responsible' &&
      candidate.state === 'active' &&
      candidate.validUntil === null,
  );
  if (!seat || !supervision) throw new ApiError('CONFLICT', 'family authority is incomplete');
  return {
    model: 'household_v2',
    household: snapshot.household,
    seat,
    supervision,
  };
}

export function primaryMinorAuthorityChecks(
  tableName: string,
  authority: Extract<PrimaryMinorAuthority, { readonly model: 'household_v2' }>,
): TransactItem[] {
  return [
    {
      ConditionCheck: {
        TableName: tableName,
        Key: FK.household(authority.household.householdId),
        ConditionExpression:
          'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND primaryResponsibleId = :primaryResponsibleId AND #state = :active AND revision = :revision',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'Household',
          ':householdId': authority.household.householdId,
          ':primaryResponsibleId': authority.household.primaryResponsibleId,
          ':active': 'active',
          ':revision': authority.household.revision,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { pk: authority.seat.pk, sk: authority.seat.sk },
        ConditionExpression:
          'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND seatType = :seatType AND #state = :assigned AND accountId = :minorId AND revision = :revision',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'SeatAssignment',
          ':householdId': authority.household.householdId,
          ':seatType': 'minor',
          ':assigned': 'assigned',
          ':minorId': authority.seat.accountId,
          ':revision': authority.seat.revision,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: { pk: authority.supervision.pk, sk: authority.supervision.sk },
        ConditionExpression:
          'attribute_exists(pk) AND entityType = :entityType AND linkId = :linkId AND householdId = :householdId AND adultId = :adultId AND minorId = :minorId AND #role = :role AND #state = :active AND revision = :revision AND validUntil = :noEnd',
        ExpressionAttributeNames: { '#role': 'role', '#state': 'state' },
        ExpressionAttributeValues: {
          ':entityType': 'SupervisionLink',
          ':linkId': authority.supervision.linkId,
          ':householdId': authority.household.householdId,
          ':adultId': authority.supervision.adultId,
          ':minorId': authority.supervision.minorId,
          ':role': 'primary_responsible',
          ':active': 'active',
          ':revision': authority.supervision.revision,
          ':noEnd': null,
        },
      },
    },
  ];
}

export function samePrimaryMinorAuthority(
  left: PrimaryMinorAuthority,
  right: PrimaryMinorAuthority,
): boolean {
  if (left.model !== right.model) return false;
  if (left.model === 'legacy' && right.model === 'legacy') {
    return (
      left.link.pk === right.link.pk &&
      left.link.sk === right.link.sk &&
      left.link.linkId === right.link.linkId &&
      left.link.kind === right.link.kind &&
      left.link.guardianId === right.link.guardianId &&
      left.link.minorId === right.link.minorId &&
      left.link.createdAt === right.link.createdAt
    );
  }
  if (left.model !== 'household_v2' || right.model !== 'household_v2') return false;
  return (
    left.household.householdId === right.household.householdId &&
    left.household.primaryResponsibleId === right.household.primaryResponsibleId &&
    left.household.revision === right.household.revision &&
    left.seat.pk === right.seat.pk &&
    left.seat.sk === right.seat.sk &&
    left.seat.accountId === right.seat.accountId &&
    left.seat.revision === right.seat.revision &&
    left.supervision.pk === right.supervision.pk &&
    left.supervision.sk === right.supervision.sk &&
    left.supervision.linkId === right.supervision.linkId &&
    left.supervision.revision === right.supervision.revision &&
    left.supervision.state === right.supervision.state
  );
}
