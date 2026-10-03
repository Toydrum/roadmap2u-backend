import { GetCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { K, queryPrefix, type Deps } from '../db';
import { FK, householdIdForPrimary } from './keys';
import type {
  CoverageAssignmentItem,
  HouseholdSnapshot,
  SeatAssignmentItem,
  SupervisionLinkItem,
} from './model';
import { readHouseholdSnapshot } from './repository';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type AdultFamilyClosureBlockReason =
  | 'active_primary_minors'
  | 'active_additional_responsibility'
  | 'incomplete_family_state';

export interface AdultFamilyClosureDiscovery {
  readonly accountId: string;
  readonly coverage: CoverageAssignmentItem | null;
  readonly snapshots: readonly HouseholdSnapshot[];
  readonly indexedSupervisionLinks: readonly SupervisionLinkItem[];
}

async function coverageOf(
  deps: Pick<Deps, 'ddb' | 'table'>,
  accountId: string,
): Promise<CoverageAssignmentItem | null> {
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: FK.familyCoverage(accountId),
      ConsistentRead: true,
    }),
  );
  const item = result.Item as Partial<CoverageAssignmentItem> | undefined;
  return item?.entityType === 'CoverageAssignment' &&
    item.pk === FK.familyCoverage(accountId).pk &&
    item.sk === FK.familyCoverage(accountId).sk
    ? item as CoverageAssignmentItem
    : null;
}

export async function discoverAdultFamilyClosure(
  deps: Deps,
  accountId: string,
): Promise<AdultFamilyClosureDiscovery> {
  const [coverage, indexedSupervisionLinks] = await Promise.all([
    coverageOf(deps, accountId),
    queryPrefix<SupervisionLinkItem>(deps, K.user(accountId), 'SUPERVISION#', {
      index: 'gsi1',
    }),
  ]);
  const householdIds = new Set<string>([householdIdForPrimary(accountId)]);
  if (coverage) householdIds.add(coverage.householdId);
  for (const link of indexedSupervisionLinks) {
    if (
      link.entityType === 'SupervisionLink' &&
      link.adultId === accountId &&
      typeof link.householdId === 'string'
    ) {
      householdIds.add(link.householdId);
    }
  }
  const snapshots = (
    await Promise.all(
      [...householdIds].map((householdId) =>
        readHouseholdSnapshot(
          { ddb: deps.ddb, tableName: deps.table, now: deps.now },
          householdId,
        ),
      ),
    )
  ).filter((snapshot): snapshot is HouseholdSnapshot => snapshot !== null);
  return { accountId, coverage, snapshots, indexedSupervisionLinks };
}

function assignedMinorCount(snapshot: HouseholdSnapshot): number {
  return snapshot.seats.filter(
    (seat) =>
      seat.seatType === 'minor' && seat.state === 'assigned' && seat.accountId !== null,
  ).length;
}

export function adultFamilyClosureBlockReason(
  discovery: AdultFamilyClosureDiscovery,
): AdultFamilyClosureBlockReason | null {
  const { accountId, coverage, snapshots, indexedSupervisionLinks } = discovery;
  if (coverage && !snapshots.some((item) => item.household.householdId === coverage.householdId)) {
    return 'incomplete_family_state';
  }
  for (const link of indexedSupervisionLinks) {
    if (link.adultId !== accountId || link.state !== 'active') continue;
    return link.role === 'primary_responsible'
      ? 'active_primary_minors'
      : 'active_additional_responsibility';
  }
  for (const snapshot of snapshots) {
    if (snapshot.household.primaryResponsibleId === accountId && assignedMinorCount(snapshot) > 0) {
      return snapshot.household.state === 'active'
        ? 'active_primary_minors'
        : 'incomplete_family_state';
    }
    const occupiesAdditionalSeat = snapshot.seats.some(
      (seat) =>
        seat.seatType === 'additional_responsible' &&
        seat.state === 'assigned' &&
        seat.accountId === accountId,
    );
    if (occupiesAdditionalSeat) {
      return snapshot.household.state === 'active'
        ? 'active_additional_responsibility'
        : 'incomplete_family_state';
    }
  }
  if (
    coverage?.state !== undefined &&
    coverage.state !== 'ended' &&
    coverage.seatType === 'additional_responsible'
  ) {
    return 'active_additional_responsibility';
  }
  return null;
}

function exactCoverageCheck(
  tableName: string,
  accountId: string,
  coverage: CoverageAssignmentItem | null,
): TransactItem {
  if (!coverage) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: FK.familyCoverage(accountId),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    };
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: FK.familyCoverage(accountId),
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #state = :state AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'CoverageAssignment',
        ':accountId': accountId,
        ':householdId': coverage.householdId,
        ':seatType': coverage.seatType,
        ':state': coverage.state,
        ':revision': coverage.revision,
      },
    },
  };
}

function exactHouseholdCheck(tableName: string, snapshot: HouseholdSnapshot): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: FK.household(snapshot.household.householdId),
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND primaryResponsibleId = :primaryResponsibleId AND #state = :state AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'Household',
        ':householdId': snapshot.household.householdId,
        ':primaryResponsibleId': snapshot.household.primaryResponsibleId,
        ':state': snapshot.household.state,
        ':revision': snapshot.household.revision,
      },
    },
  };
}

function exactSeatCheck(tableName: string, seat: SeatAssignmentItem): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: seat.pk, sk: seat.sk },
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND seatType = :seatType AND #state = :state AND accountId = :expectedAccountId AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'SeatAssignment',
        ':householdId': seat.householdId,
        ':seatType': seat.seatType,
        ':state': seat.state,
        ':expectedAccountId': seat.accountId,
        ':revision': seat.revision,
      },
    },
  };
}

function exactActiveSupervisionCheck(
  tableName: string,
  accountId: string,
  link: SupervisionLinkItem,
): TransactItem {
  const key = FK.supervision(link.minorId, accountId);
  const index = FK.supervisionByAdult(accountId, link.minorId);
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk AND linkId = :linkId AND householdId = :householdId AND adultId = :adultId AND minorId = :minorId AND #role = :role AND #state = :state AND revision = :revision AND validFrom = :validFrom AND validUntil = :validUntil',
      ExpressionAttributeNames: { '#role': 'role', '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'SupervisionLink',
        ':gsi1pk': index.gsi1pk,
        ':gsi1sk': index.gsi1sk,
        ':linkId': link.linkId,
        ':householdId': link.householdId,
        ':adultId': accountId,
        ':minorId': link.minorId,
        ':role': link.role,
        ':state': 'active',
        ':revision': link.revision,
        ':validFrom': link.validFrom,
        ':validUntil': null,
      },
    },
  };
}

/** Exact guards make the preflight decision race-safe with assignment/revocation. */
export function adultFamilyClosureConditionChecks(
  tableName: string,
  discovery: AdultFamilyClosureDiscovery,
): TransactItem[] {
  const checks: TransactItem[] = [
    exactCoverageCheck(tableName, discovery.accountId, discovery.coverage),
    ...discovery.indexedSupervisionLinks
      .filter((link) => link.state === 'active')
      .map((link) => exactActiveSupervisionCheck(tableName, discovery.accountId, link)),
  ];
  for (const snapshot of discovery.snapshots) {
    checks.push(exactHouseholdCheck(tableName, snapshot));
    const additionalSeat = snapshot.seats.find(
      (seat) => seat.seatType === 'additional_responsible',
    );
    if (additionalSeat) checks.push(exactSeatCheck(tableName, additionalSeat));
    if (snapshot.household.primaryResponsibleId === discovery.accountId) {
      checks.push(
        ...snapshot.seats
          .filter((seat) => seat.seatType === 'minor')
          .map((seat) => exactSeatCheck(tableName, seat)),
      );
    }
  }
  return checks;
}
