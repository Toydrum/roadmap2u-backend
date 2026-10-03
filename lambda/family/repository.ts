import {
  BatchGetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { FK } from './keys';
import {
  FamilyDomainError,
  assignSeat,
  nextRevision,
  transferPrimaryResponsibility,
  validateHouseholdSnapshot,
  type CoverageAssignmentItem,
  type AdditionalResponsibleSeatAssignmentItem,
  type HouseholdItem,
  type HouseholdSnapshot,
  type MinorSeatAssignmentItem,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from './model';

export interface AssignMinorTransactionInput {
  readonly tableName: string;
  readonly household: HouseholdItem;
  readonly seat: MinorSeatAssignmentItem;
  readonly minorId: string;
  readonly primaryLink: SupervisionLinkItem;
  readonly coverage: CoverageAssignmentItem;
  readonly expectedHouseholdRevision: number;
  readonly expectedSeatRevision: number;
  readonly now: number;
}

function assertTableName(tableName: string): void {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) {
    throw new TypeError('tableName must be an explicit DynamoDB table name');
  }
}

export function buildAssignMinorTransaction(
  input: AssignMinorTransactionInput,
): TransactWriteCommandInput {
  assertTableName(input.tableName);
  const householdRevision = nextRevision(
    input.household.revision,
    input.expectedHouseholdRevision,
  );
  const assignedSeat = assignSeat(
    input.seat,
    input.minorId,
    input.expectedSeatRevision,
    input.now,
  );
  if (
    input.household.state !== 'active' ||
    input.seat.householdId !== input.household.householdId ||
    input.primaryLink.householdId !== input.household.householdId ||
    input.primaryLink.minorId !== input.minorId ||
    input.primaryLink.adultId !== input.household.primaryResponsibleId ||
    input.primaryLink.role !== 'primary_responsible' ||
    input.primaryLink.state !== 'active' ||
    input.coverage.householdId !== input.household.householdId ||
    input.coverage.accountId !== input.minorId ||
    input.coverage.seatType !== 'minor' ||
    input.coverage.state !== 'active' ||
    input.coverage.revision !== 1 ||
    input.coverage.updatedAt !== input.now ||
    !(
      input.coverage.pk === FK.familyCoverage(input.minorId).pk &&
      input.coverage.sk === FK.familyCoverage(input.minorId).sk
    )
  ) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'minor assignment items do not describe one canonical household mutation',
    );
  }

  return {
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: FK.household(input.household.householdId),
          UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :primaryResponsibleId',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': input.expectedHouseholdRevision,
            ':nextRevision': householdRevision,
            ':now': input.now,
            ':active': 'active',
            ':primaryResponsibleId': input.household.primaryResponsibleId,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: FK.minorSeat(input.household.householdId, input.seat.seatNumber),
          UpdateExpression:
            'SET #state = :assigned, accountId = :accountId, assignedAt = :now, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :empty AND accountId = :emptyAccountId',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': input.expectedSeatRevision,
            ':nextRevision': assignedSeat.revision,
            ':empty': 'empty',
            ':assigned': 'assigned',
            ':emptyAccountId': null,
            ':accountId': input.minorId,
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: input.primaryLink,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      {
        Put: {
          TableName: input.tableName,
          Item: input.coverage,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    ],
  };
}

export interface TransferPrimaryTransactionInput {
  readonly tableName: string;
  readonly household: HouseholdItem;
  readonly nextPrimaryResponsibleId: string;
  readonly additionalSeat: AdditionalResponsibleSeatAssignmentItem;
  readonly currentPrimaryLinks: readonly SupervisionLinkItem[];
  readonly nextPrimaryLinks: readonly SupervisionLinkItem[];
  readonly currentPrimaryCoverage: CoverageAssignmentItem;
  readonly nextPrimaryCoverage: CoverageAssignmentItem;
  readonly expectedHouseholdRevision: number;
  readonly now: number;
}

export function buildTransferPrimaryTransaction(
  input: TransferPrimaryTransactionInput,
): TransactWriteCommandInput {
  assertTableName(input.tableName);
  const next = transferPrimaryResponsibility(
    input.household,
    input.nextPrimaryResponsibleId,
    input.expectedHouseholdRevision,
    input.now,
  );
  const minorIds = input.currentPrimaryLinks
    .map((link) => link.minorId)
    .sort((left, right) => left.localeCompare(right));
  const uniqueMinorIds = new Set(minorIds);
  const nextByMinor = new Map(
    input.nextPrimaryLinks.map((link) => [link.minorId, link] as const),
  );
  if (
    minorIds.length < 1 ||
    minorIds.length > 2 ||
    uniqueMinorIds.size !== minorIds.length ||
    input.nextPrimaryLinks.length !== minorIds.length ||
    nextByMinor.size !== minorIds.length ||
    input.additionalSeat.householdId !== input.household.householdId ||
    input.additionalSeat.state !== 'assigned' ||
    input.additionalSeat.accountId !== input.nextPrimaryResponsibleId ||
    input.currentPrimaryCoverage.householdId !== input.household.householdId ||
    input.currentPrimaryCoverage.accountId !== input.household.primaryResponsibleId ||
    input.currentPrimaryCoverage.seatType !== 'primary_responsible' ||
    input.currentPrimaryCoverage.state === 'ended' ||
    input.nextPrimaryCoverage.householdId !== input.household.householdId ||
    input.nextPrimaryCoverage.accountId !== input.nextPrimaryResponsibleId ||
    input.nextPrimaryCoverage.seatType !== 'additional_responsible' ||
    input.nextPrimaryCoverage.state === 'ended'
  ) {
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'primary transfer requires one complete current and successor supervision set',
    );
  }
  for (const currentLink of input.currentPrimaryLinks) {
    const successor = nextByMinor.get(currentLink.minorId);
    if (
      currentLink.householdId !== input.household.householdId ||
      currentLink.adultId !== input.household.primaryResponsibleId ||
      currentLink.role !== 'primary_responsible' ||
      currentLink.state !== 'active' ||
      currentLink.validUntil !== null ||
      !successor ||
      successor.householdId !== input.household.householdId ||
      successor.adultId !== input.nextPrimaryResponsibleId ||
      successor.role !== 'additional_responsible' ||
      successor.state !== 'active' ||
      successor.validUntil !== null
    ) {
      throw new FamilyDomainError(
        'INVALID_FAMILY_STATE',
        'primary transfer supervision sets do not address the same seated minors',
      );
    }
  }

  const supervisionUpdates = minorIds.flatMap((minorId) => {
    const currentLink = input.currentPrimaryLinks.find((link) => link.minorId === minorId)!;
    const successor = nextByMinor.get(minorId)!;
    return [
      {
        Update: {
          TableName: input.tableName,
          Key: FK.supervision(minorId, input.household.primaryResponsibleId),
          UpdateExpression:
            'SET #state = :ended, validUntil = :now, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :active AND #role = :primaryRole AND householdId = :householdId AND adultId = :currentPrimaryResponsibleId AND minorId = :minorId',
          ExpressionAttributeNames: { '#state': 'state', '#role': 'role' },
          ExpressionAttributeValues: {
            ':expectedRevision': currentLink.revision,
            ':nextRevision': nextRevision(currentLink.revision, currentLink.revision),
            ':active': 'active',
            ':ended': 'ended',
            ':primaryRole': 'primary_responsible',
            ':householdId': input.household.householdId,
            ':currentPrimaryResponsibleId': input.household.primaryResponsibleId,
            ':minorId': minorId,
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: FK.supervision(minorId, input.nextPrimaryResponsibleId),
          UpdateExpression:
            'SET #role = :primaryRole, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :active AND #role = :additionalRole AND householdId = :householdId AND adultId = :nextPrimaryResponsibleId AND minorId = :minorId',
          ExpressionAttributeNames: { '#state': 'state', '#role': 'role' },
          ExpressionAttributeValues: {
            ':expectedRevision': successor.revision,
            ':nextRevision': nextRevision(successor.revision, successor.revision),
            ':active': 'active',
            ':additionalRole': 'additional_responsible',
            ':primaryRole': 'primary_responsible',
            ':householdId': input.household.householdId,
            ':nextPrimaryResponsibleId': input.nextPrimaryResponsibleId,
            ':minorId': minorId,
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
        },
      },
    ];
  });
  return {
    TransactItems: [
      {
        Update: {
          TableName: input.tableName,
          Key: FK.household(input.household.householdId),
          UpdateExpression:
            'SET primaryResponsibleId = :nextPrimaryResponsibleId, revision = :nextRevision, updatedAt = :now',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :currentPrimaryResponsibleId',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':currentPrimaryResponsibleId': input.household.primaryResponsibleId,
            ':nextPrimaryResponsibleId': next.primaryResponsibleId,
            ':expectedRevision': input.expectedHouseholdRevision,
            ':nextRevision': next.revision,
            ':now': input.now,
            ':active': 'active',
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: FK.additionalSeat(input.household.householdId),
          UpdateExpression:
            'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state = :assigned AND accountId = :nextPrimaryResponsibleId',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': input.additionalSeat.revision,
            ':nextRevision': nextRevision(
              input.additionalSeat.revision,
              input.additionalSeat.revision,
            ),
            ':assigned': 'assigned',
            ':empty': 'empty',
            ':emptyAccountId': null,
            ':emptyAssignedAt': null,
            ':nextPrimaryResponsibleId': input.nextPrimaryResponsibleId,
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      ...supervisionUpdates,
      {
        Update: {
          TableName: input.tableName,
          Key: FK.familyCoverage(input.household.primaryResponsibleId),
          UpdateExpression:
            'SET #state = :ended, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state <> :ended AND householdId = :householdId AND accountId = :accountId AND seatType = :primarySeatType',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': input.currentPrimaryCoverage.revision,
            ':nextRevision': nextRevision(
              input.currentPrimaryCoverage.revision,
              input.currentPrimaryCoverage.revision,
            ),
            ':ended': 'ended',
            ':householdId': input.household.householdId,
            ':accountId': input.household.primaryResponsibleId,
            ':primarySeatType': 'primary_responsible',
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
      {
        Update: {
          TableName: input.tableName,
          Key: FK.familyCoverage(input.nextPrimaryResponsibleId),
          UpdateExpression:
            'SET seatType = :primarySeatType, updatedAt = :now, revision = :nextRevision',
          ConditionExpression:
            'revision = :expectedRevision AND #state <> :ended AND householdId = :householdId AND accountId = :accountId AND seatType = :additionalSeatType',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':expectedRevision': input.nextPrimaryCoverage.revision,
            ':nextRevision': nextRevision(
              input.nextPrimaryCoverage.revision,
              input.nextPrimaryCoverage.revision,
            ),
            ':ended': 'ended',
            ':householdId': input.household.householdId,
            ':accountId': input.nextPrimaryResponsibleId,
            ':additionalSeatType': 'additional_responsible',
            ':primarySeatType': 'primary_responsible',
            ':now': input.now,
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    ],
  };
}

export type FamilyTransactionOperation = 'assign_minor' | 'transfer_primary';
export type FamilyTransactionCancellationKind =
  | 'stale_household_revision'
  | 'seat_conflict'
  | 'supervision_conflict'
  | 'coverage_conflict'
  | 'ambiguous'
  | 'unknown_transaction_cancellation';

export interface FamilyTransactionCancellation {
  readonly kind: FamilyTransactionCancellationKind;
}

export function classifyFamilyTransactionCancellation(
  operation: FamilyTransactionOperation,
  error: unknown,
): FamilyTransactionCancellation | null {
  const cancellation = error as {
    readonly name?: string;
    readonly CancellationReasons?: readonly { readonly Code?: string }[];
  };
  if (cancellation?.name !== 'TransactionCanceledException') return null;
  const reasons = cancellation.CancellationReasons;
  if (!reasons) return { kind: 'unknown_transaction_cancellation' };
  const failed = reasons.flatMap((reason, index) =>
    reason.Code === 'ConditionalCheckFailed' ? [index] : [],
  );
  if (failed.length > 1) return { kind: 'ambiguous' };
  if (failed.length === 0) return { kind: 'unknown_transaction_cancellation' };
  const index = failed[0];
  if (index === 0) return { kind: 'stale_household_revision' };
  if (operation === 'transfer_primary') return { kind: 'unknown_transaction_cancellation' };
  if (index === 1) return { kind: 'seat_conflict' };
  if (index === 2) return { kind: 'supervision_conflict' };
  if (index === 3) return { kind: 'coverage_conflict' };
  return { kind: 'unknown_transaction_cancellation' };
}

export interface FamilyRepositoryDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
}

function seatOrder(seat: SeatAssignmentItem): number {
  if (seat.seatType === 'minor') return seat.seatNumber - 1;
  return 2;
}

export async function readHouseholdSnapshot(
  deps: FamilyRepositoryDeps,
  householdId: string,
): Promise<HouseholdSnapshot | null> {
  assertTableName(deps.tableName);
  const householdPartition = FK.household(householdId).pk;
  const core = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': householdPartition },
      ConsistentRead: true,
    }),
  );
  const rows = (core.Items ?? []) as Array<HouseholdItem | SeatAssignmentItem>;
  const household = rows.find(
    (item): item is HouseholdItem => item.entityType === 'Household' && item.sk === 'META',
  );
  if (!household) {
    if (rows.length === 0) return null;
    throw new FamilyDomainError(
      'INVALID_FAMILY_STATE',
      'household partition exists without canonical metadata',
    );
  }
  const seats = rows
    .filter((item): item is SeatAssignmentItem => item.entityType === 'SeatAssignment')
    .sort((left, right) => seatOrder(left) - seatOrder(right));
  const minorIds = seats.flatMap((seat) =>
    seat.seatType === 'minor' && seat.accountId !== null ? [seat.accountId] : [],
  );
  const supervisionPages = await Promise.all(
    minorIds.map((minorId) =>
      deps.ddb.send(
        new QueryCommand({
          TableName: deps.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': FK.supervision(minorId, household.primaryResponsibleId).pk,
            ':prefix': 'SUPERVISION#',
          },
          ConsistentRead: true,
        }),
      ),
    ),
  );
  const supervisionLinks = supervisionPages
    .flatMap((page) => (page.Items ?? []) as SupervisionLinkItem[])
    .filter((link) => link.householdId === household.householdId)
    .sort((left, right) => left.sk.localeCompare(right.sk));

  const participantIds = [
    household.primaryResponsibleId,
    ...seats.flatMap((seat) => (seat.accountId === null ? [] : [seat.accountId])),
  ].filter((accountId, index, all) => all.indexOf(accountId) === index);
  const coverageRead = await deps.ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [deps.tableName]: {
          Keys: participantIds.map((accountId) => FK.familyCoverage(accountId)),
          ConsistentRead: true,
        },
      },
    }),
  );
  if ((coverageRead.UnprocessedKeys?.[deps.tableName]?.Keys?.length ?? 0) > 0) {
    throw new Error('family snapshot coverage read was incomplete');
  }
  const coverages = (
    (coverageRead.Responses?.[deps.tableName] ?? []) as CoverageAssignmentItem[]
  ).sort((left, right) => left.accountId.localeCompare(right.accountId));
  const snapshot: HouseholdSnapshot = { household, seats, supervisionLinks, coverages };
  validateHouseholdSnapshot(snapshot, deps.now());
  return snapshot;
}
