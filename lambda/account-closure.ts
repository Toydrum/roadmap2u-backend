import { randomUUID } from 'node:crypto';
import { AuditWriter } from './commercial/audit';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  GetCommand,
  K,
  TransactWriteCommand,
  UpdateCommand,
  batchWriteAll,
  queryPrefixPage,
  type Deps,
  type DynamoKey,
  type FriendItem,
  type LinkItem,
} from './db';
import { instrumentHandler } from './observability';
import {
  guardianInviteClosureDeletes,
  guardianInviteFromMirror,
  type GuardianInviteMirrorItem,
} from './guardian-invites';
import {
  adultFamilyClosureBlockReason,
  adultFamilyClosureConditionChecks,
  discoverAdultFamilyClosure,
} from './family/account-closure';
import { SK } from './social/model';
import { FK, supervisionLinkId } from './family/keys';
import type {
  CoverageAssignmentItem,
  FamilyEntitlementItem,
  SeatAssignmentItem,
  SupervisionLinkItem,
} from './family/model';
import { readHouseholdSnapshot } from './family/repository';

export const ACCOUNT_CLOSURE_OPEN_GSI_PK = 'ACCOUNT_CLOSURE#OPEN';
type AccountClosureTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type AccountClosureState =
  | 'requested'
  | 'purging'
  | 'purgeComplete'
  | 'completed'
  | 'blocked';

export type AccountClosureKind = 'self_adult' | 'guardian_minor';

export type AccountClosurePhase =
  | 'familyMembership'
  | 'ownedHousehold'
  | 'familySupervisionLinks'
  | 'inboundGuardianLinks'
  | 'friendMirrors'
  | 'outgoingFriendRequests'
  | 'guardianLinks'
  | 'guardianInvites'
  | 'directMirrors'
  | 'userPartition';

export interface AccountClosureCheckpoint {
  readonly phase: AccountClosurePhase;
  readonly exclusiveStartKey?: DynamoKey;
  readonly quietPasses?: number;
}

export interface AccountClosureItem {
  readonly pk: string;
  readonly sk: 'STATE';
  readonly closureId: string;
  /** Optional only for closure records created before closure kinds were introduced. */
  readonly kind?: AccountClosureKind;
  /** Actor snapshot; guardian-minor retries are authorized against this value. */
  readonly actorSub?: string;
  readonly sub: string;
  readonly username: string;
  readonly friendCode?: string;
  readonly state: AccountClosureState;
  readonly revision: number;
  readonly requestedAt: number;
  readonly updatedAt: number;
  readonly nextAttemptAt?: number;
  readonly gsi1pk?: string;
  readonly gsi1sk?: string;
  readonly checkpoint?: AccountClosureCheckpoint;
  /** Absent on records created before Household v2 cleanup became mandatory. */
  readonly familyCleanupVersion?: typeof ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION;
  readonly purgeCompleteAt?: number;
  readonly completedAt?: number;
  readonly blockedAt?: number;
  readonly blockReason?: AccountClosureBlockReason;
  readonly ttl?: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: number;
}

export interface AccountClosureMessage {
  readonly sub: string;
  readonly closureId: string;
}

export interface AccountClosureQueue {
  enqueue(message: AccountClosureMessage, delaySeconds?: number): Promise<void>;
}

export function createAccountClosureQueue(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
): AccountClosureQueue {
  return {
    async enqueue(message, delaySeconds) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          ...(delaySeconds === undefined ? {} : { DelaySeconds: delaySeconds }),
        }),
      );
    },
  };
}

export interface AccountClosureDeps extends Deps {
  readonly auditWriter: AuditWriter;
  readonly queue: AccountClosureQueue;
  readonly nextClosureId: () => string;
  readonly nextWorkerId: () => string;
  readonly recordBlocked?: (reason: AccountClosureBlockReason) => void | Promise<void>;
}

export const ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION = 1 as const;
export type AccountClosureBlockReason =
  | 'created_family_link'
  | 'active_primary_minors'
  | 'active_additional_responsibility'
  | 'incomplete_family_state';

export function accountClosureKey(sub: string): { pk: string; sk: 'STATE' } {
  return { pk: `ACCOUNT_CLOSURE#${sub}`, sk: 'STATE' };
}

export function closureOpenSortKey(nextAttemptAt: number, sub: string): string {
  return `NEXT#${String(nextAttemptAt).padStart(13, '0')}#${sub}`;
}

export type AccountClosureProcessResult = 'ignored' | 'pending' | 'completed';

const WORKER_LEASE_MS = 60_000;
// GSI reads are eventual. With writes blocked by the closure tombstone, two
// empty full sweeps separated by this window provide a stable purge boundary.
const GSI_STABILITY_DELAY_MS = 30_000;
// Keep completed tombstones for 30 days so delayed/duplicate deliveries remain idempotent.
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isTerminalClosureState(state: AccountClosureState): boolean {
  return state === 'completed' || state === 'blocked';
}

function exactClosureLeaseCheck(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
) {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: accountClosureKey(closure.sub),
      ConditionExpression:
        'closureId = :closureId AND revision = :expectedRevision AND #state = :state AND leaseOwner = :leaseOwner',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':closureId': closure.closureId,
        ':expectedRevision': closure.revision,
        ':state': 'purging',
        ':leaseOwner': closure.leaseOwner,
      },
    },
  } as const;
}

function exactLinkDelete(deps: AccountClosureDeps, link: LinkItem) {
  return {
    Delete: {
      TableName: deps.table,
      Key: { pk: link.pk, sk: link.sk },
      ConditionExpression: [
        'attribute_exists(pk)',
        '#kind = :kind',
        'guardianId = :guardianId',
        'minorId = :minorId',
        'linkId = :linkId',
        'createdAt = :createdAt',
        'gsi1pk = :gsi1pk',
        'gsi1sk = :gsi1sk',
      ].join(' AND '),
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':kind': link.kind,
        ':guardianId': link.guardianId,
        ':minorId': link.minorId,
        ':linkId': link.linkId,
        ':createdAt': link.createdAt,
        ':gsi1pk': link.gsi1pk,
        ':gsi1sk': link.gsi1sk,
      },
    },
  } as const;
}

function exactLinkCheck(deps: AccountClosureDeps, link: LinkItem) {
  const deletion = exactLinkDelete(deps, link).Delete;
  return { ConditionCheck: deletion } as const;
}

function removeGuardianFenceMember(
  deps: AccountClosureDeps,
  guardianSub: string,
  minorSub: string,
) {
  return {
    Update: {
      TableName: deps.table,
      Key: K.profile(guardianSub),
      UpdateExpression: 'DELETE createdMinorIds :createdMinorIds',
      ConditionExpression: [
        'attribute_exists(pk)',
        'accountType = :adult',
        '(attribute_not_exists(familyFenceVersion) OR (familyFenceVersion = :familyFenceVersion AND contains(createdMinorIds, :minorId)))',
      ].join(' AND '),
      ExpressionAttributeValues: {
        ':adult': 'adult',
        ':familyFenceVersion': 1,
        ':createdMinorIds': new Set([minorSub]),
        ':minorId': minorSub,
      },
    },
  } as const;
}

function parseClosureMessage(body: string): AccountClosureMessage | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'closureId,sub') return null;
    if (typeof record['sub'] !== 'string' || !record['sub']) return null;
    if (typeof record['closureId'] !== 'string' || !record['closureId']) return null;
    return { sub: record['sub'], closureId: record['closureId'] };
  } catch {
    return null;
  }
}

async function acquireClosureLease(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<AccountClosureItem> {
  const now = deps.now();
  const leaseOwner = deps.nextWorkerId();
  const out = await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: accountClosureKey(closure.sub),
      UpdateExpression:
        'SET leaseOwner = :leaseOwner, leaseUntil = :leaseUntil, revision = :nextRevision, updatedAt = :now',
      ConditionExpression:
        'closureId = :closureId AND revision = :expectedRevision AND #state = :state AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':closureId': closure.closureId,
        ':expectedRevision': closure.revision,
        ':state': 'purging',
        ':leaseOwner': leaseOwner,
        ':leaseUntil': now + WORKER_LEASE_MS,
        ':nextRevision': closure.revision + 1,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return out.Attributes as unknown as AccountClosureItem;
}

async function saveClosureCheckpoint(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  checkpoint: AccountClosureCheckpoint,
  delayMs = 0,
): Promise<void> {
  const now = deps.now();
  const nextAttemptAt = now + delayMs;
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: accountClosureKey(closure.sub),
      UpdateExpression:
        'SET checkpoint = :checkpoint, familyCleanupVersion = :familyCleanupVersion, revision = :nextRevision, updatedAt = :now, nextAttemptAt = :nextAttemptAt, gsi1sk = :gsi1sk REMOVE leaseOwner, leaseUntil',
      ConditionExpression:
        'closureId = :closureId AND revision = :expectedRevision AND #state = :state AND leaseOwner = :leaseOwner',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':closureId': closure.closureId,
        ':expectedRevision': closure.revision,
        ':state': 'purging',
        ':leaseOwner': closure.leaseOwner,
        ':checkpoint': checkpoint,
        ':familyCleanupVersion': ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
        ':nextRevision': closure.revision + 1,
        ':now': now,
        ':nextAttemptAt': nextAttemptAt,
        ':gsi1sk': closureOpenSortKey(nextAttemptAt, closure.sub),
      },
    }),
  );
}

async function blockClosure(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  reason: AccountClosureBlockReason,
  guards: readonly AccountClosureTransactItem[] = [],
): Promise<void> {
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, blockedAt = :now, blockReason = :blockReason REMOVE gsi1pk, gsi1sk, nextAttemptAt, leaseOwner, leaseUntil, checkpoint',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState AND leaseOwner = :leaseOwner',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purging',
              ':leaseOwner': closure.leaseOwner,
              ':nextState': 'blocked',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':blockReason': reason,
            },
          },
        },
        ...guards,
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-blocked-${closure.revision + 1}`,
          action: 'account_closure.blocked',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            reason,
            from: 'purging',
            to: 'blocked',
          },
        }),
      ],
    }),
  );
  await Promise.resolve(deps.recordBlocked?.(reason)).catch(() => undefined);
}

async function blockClosureOnCreatedLink(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  link: LinkItem,
): Promise<void> {
  await blockClosure(deps, closure, 'created_family_link', [exactLinkCheck(deps, link)]);
}

async function readFamilyCoverage(
  deps: AccountClosureDeps,
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

function exactSupervisionDelete(
  deps: AccountClosureDeps,
  link: SupervisionLinkItem,
): AccountClosureTransactItem {
  return {
    Delete: {
      TableName: deps.table,
      Key: { pk: link.pk, sk: link.sk },
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk AND linkId = :linkId AND householdId = :householdId AND adultId = :adultId AND minorId = :minorId AND #role = :role AND #state = :state AND revision = :revision AND validFrom = :validFrom AND validUntil = :validUntil',
      ExpressionAttributeNames: { '#role': 'role', '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'SupervisionLink',
        ':gsi1pk': link.gsi1pk,
        ':gsi1sk': link.gsi1sk,
        ':linkId': link.linkId,
        ':householdId': link.householdId,
        ':adultId': link.adultId,
        ':minorId': link.minorId,
        ':role': link.role,
        ':state': link.state,
        ':revision': link.revision,
        ':validFrom': link.validFrom,
        ':validUntil': link.validUntil,
      },
    },
  };
}

function exactSupervisionCheck(
  deps: AccountClosureDeps,
  link: SupervisionLinkItem,
): AccountClosureTransactItem {
  const deletion = exactSupervisionDelete(deps, link).Delete!;
  return {
    ConditionCheck: {
      ...deletion,
      ConditionExpression: deletion.ConditionExpression!,
    },
  };
}

function exactCoverageDelete(
  deps: AccountClosureDeps,
  coverage: CoverageAssignmentItem,
): AccountClosureTransactItem {
  return {
    Delete: {
      TableName: deps.table,
      Key: FK.familyCoverage(coverage.accountId),
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #state = :state AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'CoverageAssignment',
        ':accountId': coverage.accountId,
        ':householdId': coverage.householdId,
        ':seatType': coverage.seatType,
        ':state': coverage.state,
        ':revision': coverage.revision,
      },
    },
  };
}

function exactSeatCheck(
  deps: AccountClosureDeps,
  seat: SeatAssignmentItem,
): AccountClosureTransactItem {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: { pk: seat.pk, sk: seat.sk },
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND seatType = :seatType AND #state = :state AND accountId = :accountId AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'SeatAssignment',
        ':householdId': seat.householdId,
        ':seatType': seat.seatType,
        ':state': seat.state,
        ':accountId': seat.accountId,
        ':revision': seat.revision,
      },
    },
  };
}

async function purgeFamilyMembership(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<'continue' | 'blocked'> {
  if ((closure.kind ?? 'self_adult') === 'self_adult') {
    const discovery = await discoverAdultFamilyClosure(deps, closure.sub);
    const reason = adultFamilyClosureBlockReason(discovery);
    if (reason) {
      await blockClosure(
        deps,
        closure,
        reason,
        adultFamilyClosureConditionChecks(deps.table, discovery),
      );
      return 'blocked';
    }
    await saveClosureCheckpoint(deps, closure, { phase: 'ownedHousehold' });
    return 'continue';
  }

  const coverage = await readFamilyCoverage(deps, closure.sub);
  if (!coverage) {
    await saveClosureCheckpoint(deps, closure, { phase: 'familySupervisionLinks' });
    return 'continue';
  }
  if (coverage.accountId !== closure.sub || coverage.seatType !== 'minor') {
    throw new Error('minor closure has a non-minor family coverage');
  }
  const snapshot = await readHouseholdSnapshot(
    { ddb: deps.ddb, tableName: deps.table, now: deps.now },
    coverage.householdId,
  );
  const seat = snapshot?.seats.find(
    (candidate) =>
      candidate.seatType === 'minor' &&
      candidate.state === 'assigned' &&
      candidate.accountId === closure.sub,
  );
  if (
    !snapshot ||
    !seat ||
    snapshot.household.state !== 'active' ||
    snapshot.household.primaryResponsibleId !== closure.actorSub
  ) {
    throw new Error('minor closure family authority changed before detach');
  }
  const links = snapshot.supervisionLinks.filter(
    (link) =>
      link.householdId === coverage.householdId &&
      link.minorId === closure.sub &&
      link.state === 'active',
  );
  const additionalSeat = snapshot.seats.find(
    (candidate) => candidate.seatType === 'additional_responsible',
  );
  const additionalId = additionalSeat?.state === 'assigned'
    ? additionalSeat.accountId
    : null;
  const releasesAdditional =
    additionalId !== null &&
    links.some(
      (link) =>
        link.adultId === additionalId &&
        link.role === 'additional_responsible' &&
        link.state === 'active',
    ) &&
    !snapshot.supervisionLinks.some(
      (link) =>
        link.adultId === additionalId &&
        link.minorId !== closure.sub &&
        link.role === 'additional_responsible' &&
        link.state === 'active',
    );
  const additionalCoverage = releasesAdditional
    ? snapshot.coverages.find((item) => item.accountId === additionalId) ?? null
    : null;
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        exactClosureLeaseCheck(deps, closure),
        {
          Update: {
            TableName: deps.table,
            Key: FK.household(snapshot.household.householdId),
            UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
            ConditionExpression:
              'entityType = :entityType AND householdId = :householdId AND primaryResponsibleId = :primaryResponsibleId AND #state = :active AND revision = :expectedRevision',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':entityType': 'Household',
              ':householdId': snapshot.household.householdId,
              ':primaryResponsibleId': closure.actorSub,
              ':active': 'active',
              ':expectedRevision': snapshot.household.revision,
              ':nextRevision': snapshot.household.revision + 1,
              ':now': now,
            },
          },
        },
        {
          Update: {
            TableName: deps.table,
            Key: { pk: seat.pk, sk: seat.sk },
            UpdateExpression:
              'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
            ConditionExpression:
              'entityType = :entityType AND householdId = :householdId AND seatType = :minor AND #state = :assigned AND accountId = :minorId AND revision = :expectedRevision',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':entityType': 'SeatAssignment',
              ':householdId': snapshot.household.householdId,
              ':minor': 'minor',
              ':assigned': 'assigned',
              ':empty': 'empty',
              ':minorId': closure.sub,
              ':emptyAccountId': null,
              ':emptyAssignedAt': null,
              ':expectedRevision': seat.revision,
              ':nextRevision': seat.revision + 1,
              ':now': now,
            },
          },
        },
        ...(releasesAdditional && additionalSeat && additionalId
          ? [
              {
                Update: {
                  TableName: deps.table,
                  Key: FK.additionalSeat(snapshot.household.householdId),
                  UpdateExpression:
                    'SET #state = :empty, accountId = :emptyAccountId, assignedAt = :emptyAssignedAt, updatedAt = :now, revision = :nextRevision',
                  ConditionExpression:
                    'entityType = :entityType AND householdId = :householdId AND seatType = :seatType AND #state = :assigned AND accountId = :additionalId AND revision = :expectedRevision',
                  ExpressionAttributeNames: { '#state': 'state' },
                  ExpressionAttributeValues: {
                    ':entityType': 'SeatAssignment',
                    ':householdId': snapshot.household.householdId,
                    ':seatType': 'additional_responsible',
                    ':assigned': 'assigned',
                    ':empty': 'empty',
                    ':additionalId': additionalId,
                    ':emptyAccountId': null,
                    ':emptyAssignedAt': null,
                    ':expectedRevision': additionalSeat.revision,
                    ':nextRevision': additionalSeat.revision + 1,
                    ':now': now,
                  },
                },
              } satisfies AccountClosureTransactItem,
            ]
          : []),
        ...(additionalCoverage && additionalCoverage.state !== 'ended'
          ? [
              {
                Update: {
                  TableName: deps.table,
                  Key: FK.familyCoverage(additionalCoverage.accountId),
                  UpdateExpression:
                    'SET #state = :ended, revision = :nextRevision, updatedAt = :now',
                  ConditionExpression:
                    'entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #state = :expectedState AND revision = :expectedRevision',
                  ExpressionAttributeNames: { '#state': 'state' },
                  ExpressionAttributeValues: {
                    ':entityType': 'CoverageAssignment',
                    ':accountId': additionalCoverage.accountId,
                    ':householdId': snapshot.household.householdId,
                    ':seatType': 'additional_responsible',
                    ':expectedState': additionalCoverage.state,
                    ':ended': 'ended',
                    ':expectedRevision': additionalCoverage.revision,
                    ':nextRevision': additionalCoverage.revision + 1,
                    ':now': now,
                  },
                },
              } satisfies AccountClosureTransactItem,
            ]
          : []),
        exactCoverageDelete(deps, coverage),
        ...links.map((link) => exactSupervisionDelete(deps, link)),
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-family-detached-${snapshot.household.revision + 1}`,
          action: 'account_closure.family_detached',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            householdId: snapshot.household.householdId,
            from: 'assigned',
            to: 'detached',
          },
        }),
      ],
    }),
  );
  await saveClosureCheckpoint(deps, closure, { phase: 'familySupervisionLinks' });
  return 'continue';
}

async function familyEntitlementOf(
  deps: AccountClosureDeps,
  householdId: string,
): Promise<FamilyEntitlementItem | null> {
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: FK.familyEntitlement(householdId),
      ConsistentRead: true,
    }),
  );
  const item = result.Item as Partial<FamilyEntitlementItem> | undefined;
  return item?.entityType === 'FamilyEntitlement' && item.householdId === householdId
    ? item as FamilyEntitlementItem
    : null;
}

function exactInactiveEntitlementCheck(
  deps: AccountClosureDeps,
  householdId: string,
  entitlement: FamilyEntitlementItem | null,
): AccountClosureTransactItem {
  if (!entitlement) {
    return {
      ConditionCheck: {
        TableName: deps.table,
        Key: FK.familyEntitlement(householdId),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    };
  }
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: FK.familyEntitlement(householdId),
      ConditionExpression:
        'attribute_exists(pk) AND entityType = :entityType AND householdId = :householdId AND #state = :ended AND revision = :revision',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entityType': 'FamilyEntitlement',
        ':householdId': householdId,
        ':ended': 'ended',
        ':revision': entitlement.revision,
      },
    },
  };
}

async function closeOwnedHousehold(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<'continue' | 'blocked'> {
  if ((closure.kind ?? 'self_adult') !== 'self_adult') {
    await saveClosureCheckpoint(deps, closure, { phase: 'familySupervisionLinks' });
    return 'continue';
  }
  const discovery = await discoverAdultFamilyClosure(deps, closure.sub);
  const reason = adultFamilyClosureBlockReason(discovery);
  if (reason) {
    await blockClosure(
      deps,
      closure,
      reason,
      adultFamilyClosureConditionChecks(deps.table, discovery),
    );
    return 'blocked';
  }
  const owned = [...discovery.snapshots]
    .filter(
      (snapshot) =>
        snapshot.household.primaryResponsibleId === closure.sub &&
        snapshot.household.state === 'active',
    )
    .sort((left, right) =>
      left.household.householdId.localeCompare(right.household.householdId),
    )[0];
  if (!owned) {
    await saveClosureCheckpoint(deps, closure, { phase: 'familySupervisionLinks' });
    return 'continue';
  }
  if (owned.seats.some((seat) => seat.state !== 'empty' || seat.accountId !== null)) {
    await blockClosure(
      deps,
      closure,
      'incomplete_family_state',
      [
        ...owned.seats.map((seat) => exactSeatCheck(deps, seat)),
      ],
    );
    return 'blocked';
  }
  const entitlement = await familyEntitlementOf(deps, owned.household.householdId);
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        exactClosureLeaseCheck(deps, closure),
        {
          Update: {
            TableName: deps.table,
            Key: FK.household(owned.household.householdId),
            UpdateExpression:
              'SET #state = :closed, revision = :nextRevision, updatedAt = :now',
            ConditionExpression:
              'entityType = :entityType AND householdId = :householdId AND primaryResponsibleId = :primaryResponsibleId AND #state = :active AND revision = :expectedRevision',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':entityType': 'Household',
              ':householdId': owned.household.householdId,
              ':primaryResponsibleId': closure.sub,
              ':active': 'active',
              ':closed': 'closed',
              ':expectedRevision': owned.household.revision,
              ':nextRevision': owned.household.revision + 1,
              ':now': now,
            },
          },
        },
        ...owned.seats.map((seat) => exactSeatCheck(deps, seat)),
        ...(entitlement && entitlement.state !== 'ended'
          ? [
              {
                Update: {
                  TableName: deps.table,
                  Key: FK.familyEntitlement(owned.household.householdId),
                  UpdateExpression:
                    'SET #state = :ended, revision = :nextRevision, updatedAt = :now',
                  ConditionExpression:
                    'entityType = :entityType AND householdId = :householdId AND #state = :expectedState AND revision = :expectedRevision',
                  ExpressionAttributeNames: { '#state': 'state' },
                  ExpressionAttributeValues: {
                    ':entityType': 'FamilyEntitlement',
                    ':householdId': owned.household.householdId,
                    ':expectedState': entitlement.state,
                    ':ended': 'ended',
                    ':expectedRevision': entitlement.revision,
                    ':nextRevision': entitlement.revision + 1,
                    ':now': now,
                  },
                },
              } satisfies AccountClosureTransactItem,
            ]
          : [exactInactiveEntitlementCheck(deps, owned.household.householdId, entitlement)]),
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-household-closed-${owned.household.revision + 1}`,
          action: 'account_closure.household_closed',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            householdId: owned.household.householdId,
            from: 'active',
            to: 'closed',
          },
        }),
      ],
    }),
  );
  await saveClosureCheckpoint(deps, closure, { phase: 'ownedHousehold' });
  return 'continue';
}

function isCanonicalSupervisionForAdult(link: SupervisionLinkItem, adultId: string): boolean {
  const expected = FK.supervision(link.minorId, adultId);
  const expectedIndex = FK.supervisionByAdult(adultId, link.minorId);
  return (
    link.entityType === 'SupervisionLink' &&
    link.pk === expected.pk &&
    link.sk === expected.sk &&
    link.gsi1pk === expectedIndex.gsi1pk &&
    link.gsi1sk === expectedIndex.gsi1sk &&
    link.adultId === adultId &&
    link.linkId === supervisionLinkId(link.householdId, link.minorId, adultId)
  );
}

async function purgeFamilySupervisionLink(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<{ delaySeconds?: number; blocked?: true }> {
  if ((closure.kind ?? 'self_adult') !== 'self_adult') {
    await saveClosureCheckpoint(deps, closure, { phase: 'inboundGuardianLinks' });
    return {};
  }
  const page = await queryPrefixPage<SupervisionLinkItem>(
    deps,
    K.user(closure.sub),
    'SUPERVISION#',
    { index: 'gsi1', limit: 1 },
  );
  const link = page.items[0];
  if (link) {
    if (!isCanonicalSupervisionForAdult(link, closure.sub)) {
      throw new Error('account closure discovered a non-canonical supervision link');
    }
    if (link.state === 'active') {
      await blockClosure(
        deps,
        closure,
        link.role === 'primary_responsible'
          ? 'active_primary_minors'
          : 'active_additional_responsibility',
        [exactSupervisionCheck(deps, link)],
      );
      return { blocked: true };
    }
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          exactClosureLeaseCheck(deps, closure),
          exactSupervisionDelete(deps, link),
        ],
      }),
    );
    await saveClosureCheckpoint(deps, closure, {
      phase: 'familySupervisionLinks',
      quietPasses: 0,
    });
    return {};
  }
  if ((closure.checkpoint?.quietPasses ?? 0) < 1) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: 'familySupervisionLinks', quietPasses: 1 },
      GSI_STABILITY_DELAY_MS,
    );
    return { delaySeconds: GSI_STABILITY_DELAY_MS / 1000 };
  }
  await saveClosureCheckpoint(deps, closure, { phase: 'inboundGuardianLinks' });
  return {};
}

/**
 * Removes links stored inside the closing account's own partition. Created
 * links also remove the minor from the external guardian's authoritative set.
 */
async function purgeInboundGuardianLink(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<'continue' | 'blocked'> {
  const page = await queryPrefixPage<LinkItem>(deps, K.user(closure.sub), 'GUARDIAN#', {
    limit: 1,
    consistentRead: true,
  });
  const link = page.items[0];
  if (!link) {
    await saveClosureCheckpoint(deps, closure, { phase: 'friendMirrors' });
    return 'continue';
  }
  if ((closure.kind ?? 'self_adult') === 'self_adult' && link.kind === 'created') {
    await blockClosureOnCreatedLink(deps, closure, link);
    return 'blocked';
  }
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        exactClosureLeaseCheck(deps, closure),
        exactLinkDelete(deps, link),
        ...(link.kind === 'created'
          ? [removeGuardianFenceMember(deps, link.guardianId, link.minorId)]
          : []),
      ],
    }),
  );
  // The exact delete is the checkpoint: a retry re-queries from the beginning.
  await saveClosureCheckpoint(deps, closure, { phase: 'inboundGuardianLinks' });
  return 'continue';
}

async function purgeFriendMirrorPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const page = await queryPrefixPage<FriendItem>(deps, K.user(closure.sub), 'FRIEND#', {
    limit: 25,
    exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    consistentRead: true,
  });
  const deletes = page.items.flatMap((edge) => {
    const otherId = edge.userA === closure.sub ? edge.userB : edge.userA;
    return otherId === closure.sub
      ? []
      : [{ DeleteRequest: { Key: K.friend(otherId, closure.sub) } }];
  });
  await batchWriteAll(deps, deletes);
  await saveClosureCheckpoint(
    deps,
    closure,
    page.lastEvaluatedKey
      ? { phase: 'friendMirrors', exclusiveStartKey: page.lastEvaluatedKey }
      : { phase: 'outgoingFriendRequests' },
  );
}

async function purgeIndexedMirrorPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
  prefix: 'FREQ#' | 'MINOR#',
  currentPhase: 'outgoingFriendRequests' | 'guardianLinks',
  nextPhase: 'guardianLinks' | 'guardianInvites',
): Promise<number | undefined> {
  const page = await queryPrefixPage<{ pk: string; sk: string }>(
    deps,
    K.user(closure.sub),
    prefix,
    {
      index: 'gsi1',
      limit: 25,
      exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    },
  );
  await batchWriteAll(
    deps,
    page.items.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
  );
  if (page.lastEvaluatedKey) {
    await saveClosureCheckpoint(deps, closure, {
      phase: currentPhase,
      exclusiveStartKey: page.lastEvaluatedKey,
      quietPasses: 0,
    });
    return undefined;
  }
  if (page.items.length) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: currentPhase, quietPasses: 0 },
      GSI_STABILITY_DELAY_MS,
    );
    return GSI_STABILITY_DELAY_MS / 1000;
  }
  if ((closure.checkpoint?.quietPasses ?? 0) < 1) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: currentPhase, quietPasses: 1 },
      GSI_STABILITY_DELAY_MS,
    );
    return GSI_STABILITY_DELAY_MS / 1000;
  }
  await saveClosureCheckpoint(deps, closure, { phase: nextPhase });
  return undefined;
}

/** GSI-discovered links are always deleted exactly; never through BatchWrite. */
async function purgeOutgoingGuardianLink(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<{ delaySeconds?: number; blocked?: true }> {
  const page = await queryPrefixPage<LinkItem>(deps, K.user(closure.sub), 'MINOR#', {
    index: 'gsi1',
    limit: 1,
  });
  const link = page.items[0];
  if (link) {
    if ((closure.kind ?? 'self_adult') === 'self_adult' && link.kind === 'created') {
      await blockClosureOnCreatedLink(deps, closure, link);
      return { blocked: true };
    }
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          exactClosureLeaseCheck(deps, closure),
          exactLinkDelete(deps, link),
          ...(link.kind === 'created'
            ? [removeGuardianFenceMember(deps, link.guardianId, link.minorId)]
            : []),
        ],
      }),
    );
    await saveClosureCheckpoint(deps, closure, { phase: 'guardianLinks', quietPasses: 0 });
    return {};
  }
  if ((closure.checkpoint?.quietPasses ?? 0) < 1) {
    await saveClosureCheckpoint(
      deps,
      closure,
      { phase: 'guardianLinks', quietPasses: 1 },
      GSI_STABILITY_DELAY_MS,
    );
    return { delaySeconds: GSI_STABILITY_DELAY_MS / 1000 };
  }
  await saveClosureCheckpoint(deps, closure, { phase: 'guardianInvites' });
  return {};
}

async function purgeGuardianInvitePage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  // One mirrored co-guardian invite expands to CODE + issuer mirror + minor
  // mirror. A 25-record page produces at most 75 of DynamoDB's 100 actions.
  const page = await queryPrefixPage<GuardianInviteMirrorItem>(
    deps,
    K.user(closure.sub),
    'GINVITE#',
    {
      limit: 25,
      exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
      consistentRead: true,
    },
  );
  if (page.items.length) {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: page.items.flatMap((mirror) =>
          guardianInviteClosureDeletes(deps, guardianInviteFromMirror(mirror)),
        ),
      }),
    );
    await saveClosureCheckpoint(
      deps,
      closure,
      page.lastEvaluatedKey
        ? { phase: 'guardianInvites', exclusiveStartKey: page.lastEvaluatedKey }
        : { phase: 'guardianInvites' },
    );
    return;
  }
  await saveClosureCheckpoint(deps, closure, { phase: 'directMirrors' });
}

async function purgeDirectMirrors(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  let minorInviteKeys: Array<{ pk: string; sk: string }> = [];
  if (closure.kind === 'guardian_minor' && closure.friendCode) {
    try {
      minorInviteKeys = [SK.minorInviteCode(closure.friendCode)];
    } catch {
      // Legacy friend codes used a wider alphabet and only have CODE#F mirrors.
    }
  }
  const keys = [
    K.uniqUsername(closure.username),
    ...(closure.friendCode
      ? [
          K.codeF(closure.friendCode),
          ...minorInviteKeys,
        ]
      : []),
  ];
  await batchWriteAll(
    deps,
    keys.map((key) => ({ DeleteRequest: { Key: key } })),
  );
  await saveClosureCheckpoint(deps, closure, { phase: 'userPartition' });
}

async function purgeUserPartitionPage(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<'complete' | 'pending' | 'blocked'> {
  const page = await queryPrefixPage<{ pk: string; sk: string }>(deps, K.user(closure.sub), '', {
    limit: 25,
    exclusiveStartKey: closure.checkpoint?.exclusiveStartKey,
    consistentRead: true,
  });
  if (page.items.some(({ sk }) => sk.startsWith('GUARDIAN#'))) {
    return (await purgeInboundGuardianLink(deps, closure)) === 'blocked'
      ? 'blocked'
      : 'pending';
  }
  await batchWriteAll(
    deps,
    page.items.map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
  );
  if (page.items.length) {
    await saveClosureCheckpoint(
      deps,
      closure,
      page.lastEvaluatedKey
        ? { phase: 'userPartition', exclusiveStartKey: page.lastEvaluatedKey }
        : { phase: 'userPartition' },
    );
    return 'pending';
  }
  return 'complete';
}

async function markPurgeComplete(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, purgeCompleteAt = :now, nextAttemptAt = :now, gsi1sk = :gsi1sk REMOVE leaseOwner, leaseUntil, checkpoint',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState AND leaseOwner = :leaseOwner',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purging',
              ':leaseOwner': closure.leaseOwner,
              ':nextState': 'purgeComplete',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':gsi1sk': closureOpenSortKey(now, closure.sub),
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-purgeComplete-${closure.revision + 1}`,
          action: 'account_closure.purge_complete',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: { closureId: closure.closureId, from: 'purging', to: 'purgeComplete' },
        }),
      ],
    }),
  );
}

async function deleteIdentityAndComplete(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  try {
    await deps.cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: deps.userPoolId,
        Username: closure.username,
      }),
    );
  } catch (error) {
    if ((error as { name?: string })?.name !== 'UserNotFoundException') throw error;
  }
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, completedAt = :now, ttl = :ttl REMOVE gsi1pk, gsi1sk, nextAttemptAt, leaseOwner, leaseUntil, checkpoint',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purgeComplete',
              ':nextState': 'completed',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':ttl': Math.ceil((now + COMPLETED_RETENTION_MS) / 1000),
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-completed-${closure.revision + 1}`,
          action: 'account_closure.completed',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: { closureId: closure.closureId, from: 'purgeComplete', to: 'completed' },
        }),
      ],
    }),
  );
}

async function reopenLegacyPurgeCompleteForFamilyCleanup(
  deps: AccountClosureDeps,
  closure: AccountClosureItem,
): Promise<void> {
  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(closure.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, nextAttemptAt = :now, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk, checkpoint = :checkpoint, familyCleanupVersion = :familyCleanupVersion REMOVE purgeCompleteAt, leaseOwner, leaseUntil',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState AND attribute_not_exists(familyCleanupVersion)',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': 'purgeComplete',
              ':nextState': 'purging',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':gsi1pk': ACCOUNT_CLOSURE_OPEN_GSI_PK,
              ':gsi1sk': closureOpenSortKey(now, closure.sub),
              ':checkpoint': { phase: 'familyMembership' },
              ':familyCleanupVersion': ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-familyCleanup-${closure.revision + 1}`,
          action: 'account_closure.family_cleanup_reopened',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            from: 'purgeComplete',
            to: 'purging',
            familyCleanupVersion: ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
          },
        }),
      ],
    }),
  );
}

export async function processAccountClosureMessage(
  deps: AccountClosureDeps,
  message: AccountClosureMessage,
): Promise<AccountClosureProcessResult> {
  const result = await deps.ddb.send(
    new GetCommand({
      TableName: deps.table,
      Key: accountClosureKey(message.sub),
      ConsistentRead: true,
    }),
  );
  const closure = result.Item as AccountClosureItem | undefined;
  if (!closure || closure.closureId !== message.closureId) return 'ignored';
  if (isTerminalClosureState(closure.state)) {
    return closure.state === 'completed' ? 'completed' : 'pending';
  }
  const observedAt = deps.now();
  if (typeof closure.nextAttemptAt === 'number' && closure.nextAttemptAt > observedAt) {
    const delaySeconds = Math.min(
      900,
      Math.max(1, Math.ceil((closure.nextAttemptAt - observedAt) / 1000)),
    );
    await deps.queue.enqueue(message, delaySeconds);
    return 'pending';
  }
  if (closure.state === 'purgeComplete') {
    if (closure.familyCleanupVersion !== ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION) {
      await reopenLegacyPurgeCompleteForFamilyCleanup(deps, closure);
      await deps.queue.enqueue(message);
      return 'pending';
    }
    await deleteIdentityAndComplete(deps, closure);
    return 'completed';
  }
  if (closure.state === 'purging') {
    let leased: AccountClosureItem;
    try {
      leased = await acquireClosureLease(deps, closure);
    } catch (error) {
      if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return 'pending';
      }
      throw error;
    }
    let continuationDelay: number | undefined;
    const phase = leased.familyCleanupVersion === ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION
      ? leased.checkpoint?.phase
      : 'familyMembership';
    switch (phase) {
      case 'familyMembership':
        if ((await purgeFamilyMembership(deps, leased)) === 'blocked') return 'pending';
        break;
      case 'ownedHousehold':
        if ((await closeOwnedHousehold(deps, leased)) === 'blocked') return 'pending';
        break;
      case 'familySupervisionLinks':
        {
          const outcome = await purgeFamilySupervisionLink(deps, leased);
          if (outcome.blocked) return 'pending';
          continuationDelay = outcome.delaySeconds;
        }
        break;
      case 'inboundGuardianLinks':
        if ((await purgeInboundGuardianLink(deps, leased)) === 'blocked') return 'pending';
        break;
      case 'friendMirrors':
        await purgeFriendMirrorPage(deps, leased);
        break;
      case 'outgoingFriendRequests':
        continuationDelay = await purgeIndexedMirrorPage(
          deps,
          leased,
          'FREQ#',
          'outgoingFriendRequests',
          'guardianLinks',
        );
        break;
      case 'guardianLinks':
        {
          const outcome = await purgeOutgoingGuardianLink(deps, leased);
          if (outcome.blocked) return 'pending';
          continuationDelay = outcome.delaySeconds;
        }
        break;
      case 'guardianInvites':
        await purgeGuardianInvitePage(deps, leased);
        break;
      case 'directMirrors':
        await purgeDirectMirrors(deps, leased);
        break;
      case 'userPartition':
        {
          const outcome = await purgeUserPartitionPage(deps, leased);
          if (outcome === 'blocked') return 'pending';
          if (outcome === 'complete') {
            await markPurgeComplete(deps, leased);
          }
        }
        break;
      default:
        throw new Error('invalid account closure checkpoint');
    }
    if (continuationDelay === undefined) await deps.queue.enqueue(message);
    else await deps.queue.enqueue(message, continuationDelay);
    return 'pending';
  }
  if (closure.state !== 'requested') return 'pending';

  const now = deps.now();
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: deps.table,
            Key: accountClosureKey(message.sub),
            UpdateExpression:
              'SET #state = :nextState, revision = :nextRevision, updatedAt = :now, nextAttemptAt = :now, gsi1sk = :gsi1sk, checkpoint = :checkpoint, familyCleanupVersion = :familyCleanupVersion',
            ConditionExpression:
              'closureId = :closureId AND revision = :expectedRevision AND #state = :expectedState',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':closureId': closure.closureId,
              ':expectedRevision': closure.revision,
              ':expectedState': closure.state,
              ':nextState': 'purging',
              ':nextRevision': closure.revision + 1,
              ':now': now,
              ':gsi1sk': closureOpenSortKey(now, closure.sub),
              ':checkpoint': { phase: 'familyMembership' },
              ':familyCleanupVersion': ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
            },
          },
        },
        deps.auditWriter.transactPut({
          targetKind: 'USER',
          targetId: closure.sub,
          timestamp: now,
          requestId: `${closure.closureId}-purging-${closure.revision + 1}`,
          action: 'account_closure.purging',
          actor: 'system:account-closure-worker',
          subject: closure.sub,
          details: {
            closureId: closure.closureId,
            kind: closure.kind ?? 'self_adult',
            ...(closure.actorSub ? { actorSub: closure.actorSub } : {}),
            from: closure.state,
            to: 'purging',
          },
        }),
      ],
    }),
  );
  await deps.queue.enqueue(message);
  return 'pending';
}

export async function handleAccountClosureQueueEvent(
  event: Pick<SQSEvent, 'Records'>,
  deps: AccountClosureDeps,
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const message = parseClosureMessage(record.body);
    if (!message) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await processAccountClosureMessage(deps, message);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function realAccountClosureWorkerDeps(): AccountClosureDeps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    ddb,
    cognito: new CognitoIdentityProviderClient({}),
    table: requiredEnvironment('TABLE_NAME'),
    userPoolId: requiredEnvironment('USER_POOL_ID'),
    now: Date.now,
    auditWriter: new AuditWriter({
      ddb,
      tableName: requiredEnvironment('AUDIT_TABLE_NAME'),
    }),
    queue: createAccountClosureQueue(
      new SQSClient({}),
      requiredEnvironment('ACCOUNT_CLOSURE_QUEUE_URL'),
    ),
    nextClosureId: randomUUID,
    nextWorkerId: randomUUID,
  };
}

let workerDeps: AccountClosureDeps | undefined;

export function createAccountClosureWorkerHandler(
  resolveDeps: () => AccountClosureDeps,
): (event: SQSEvent, context?: Context) => Promise<SQSBatchResponse> {
  return instrumentHandler(
    'account-closure-worker',
    (event: SQSEvent, _context?: Context) =>
      handleAccountClosureQueueEvent(event, resolveDeps()),
  );
}

export const handler = createAccountClosureWorkerHandler(
  () => (workerDeps ??= realAccountClosureWorkerDeps()),
);
