import { createHash } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient,
  type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { AuditWriter } from './commercial/audit';
import { K, type ProfileItem } from './db';
import { assertFamilyIdentifier, FK } from './family/keys';
import { createCoverageAssignment, createFamilyEntitlement,
  type CoverageAssignmentItem, type FamilyEntitlementItem, type HouseholdItem,
  type SeatAssignmentItem } from './family/model';
import { isTrustedRequestId } from './request-id';

type Item = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type Command = Readonly<{
  command: 'grant' | 'revoke';
  stage: 'dev' | 'test' | 'prod';
  adultId: string;
  householdId: string;
  expectedHouseholdRevision: number;
  expectedEntitlementRevision: number;
  commandId: string;
  reason: string;
}>;
type Event = Readonly<{
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string };
    authorizer?: { iam?: { userArn?: string } };
  };
}>;
type Result = Readonly<{ statusCode: number; headers: { 'content-type': string }; body: string }>;
type Deps = Readonly<{
  ddb: DynamoDBDocumentClient;
  tableName: string;
  auditWriter: AuditWriter;
  stage: 'dev' | 'test' | 'prod';
  accountId: string;
  now: () => number;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMAND_KEY = { pk: 'ADMIN#FAMILY_PILOT' } as const;
const BODY_KEYS = [
  'adultId', 'command', 'commandId', 'expectedEntitlementRevision',
  'expectedHouseholdRevision', 'householdId', 'reason', 'stage',
];

function respond(statusCode: number, payload: Record<string, unknown>): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

function parse(body: string | null | undefined, stage: Deps['stage']): Command | null {
  if (!body || Buffer.byteLength(body, 'utf8') > 4096) return null;
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== BODY_KEYS.join(',')) return null;
  if (
    (value['command'] !== 'grant' && value['command'] !== 'revoke') ||
    value['stage'] !== stage ||
    typeof value['adultId'] !== 'string' ||
    typeof value['householdId'] !== 'string' ||
    typeof value['commandId'] !== 'string' ||
    !UUID_V4.test(value['commandId']) ||
    typeof value['reason'] !== 'string' ||
    value['reason'].trim() !== value['reason'] ||
    Buffer.byteLength(value['reason'], 'utf8') < 4 ||
    Buffer.byteLength(value['reason'], 'utf8') > 256 ||
    !Number.isSafeInteger(value['expectedHouseholdRevision']) ||
    (value['expectedHouseholdRevision'] as number) < 1 ||
    !Number.isSafeInteger(value['expectedEntitlementRevision']) ||
    (value['expectedEntitlementRevision'] as number) < 0
  ) return null;
  try {
    assertFamilyIdentifier(value['adultId'], 'adultId');
    assertFamilyIdentifier(value['householdId'], 'householdId');
  } catch { return null; }
  return value as Command;
}

function commandKey(commandId: string) {
  return { ...COMMAND_KEY, sk: `COMMAND#${commandId}` };
}

function commandHash(command: Command): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function exactProfile(row: unknown, accountId: string, type: 'adult' | 'minor', today: string,
  requireActive = true): boolean {
  if (!row || typeof row !== 'object') return false;
  const profile = row as Partial<ProfileItem>;
  const key = K.profile(accountId);
  return profile.pk === key.pk && profile.sk === key.sk && profile.userId === accountId &&
    profile.accountType === type && (requireActive
      ? (profile.status ?? 'active') === 'active'
      : profile.status === undefined || profile.status === 'active' || profile.status === 'closing') &&
    (type === 'adult' ? profile.familyFenceVersion === 1
      : typeof profile.majorityAt === 'string' && profile.majorityAt > today);
}

function exactCoverage(row: unknown, accountId: string, householdId: string,
  seatType: CoverageAssignmentItem['seatType']): row is CoverageAssignmentItem {
  if (!row || typeof row !== 'object') return false;
  const item = row as Partial<CoverageAssignmentItem>;
  const key = FK.familyCoverage(accountId);
  return item.pk === key.pk && item.sk === key.sk && item.entityType === 'CoverageAssignment' &&
    item.accountId === accountId && item.householdId === householdId &&
    item.seatType === seatType && Number.isSafeInteger(item.revision) && (item.revision ?? 0) > 0;
}

function coverageWrite(deps: Deps, command: Command, accountId: string,
  seatType: CoverageAssignmentItem['seatType'], existing: CoverageAssignmentItem | null,
  now: number): Item {
  const key = FK.familyCoverage(accountId);
  if (command.command === 'revoke') {
    if (!existing || existing.source !== 'sponsored_pilot' || existing.state !== 'active') {
      throw new Error('conflict');
    }
    return { Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: 'SET #state = :ended, revision = :nextRevision, updatedAt = :now',
      ConditionExpression: 'entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #source = :source AND #state = :active AND revision = :expectedRevision',
      ExpressionAttributeNames: { '#state': 'state', '#source': 'source' },
      ExpressionAttributeValues: {
        ':entityType': 'CoverageAssignment', ':accountId': accountId,
        ':householdId': command.householdId, ':seatType': seatType,
        ':source': 'sponsored_pilot', ':active': 'active', ':ended': 'ended',
        ':expectedRevision': existing.revision, ':nextRevision': existing.revision + 1,
        ':now': now,
      },
    } };
  }
  if (existing && (existing.source !== 'sponsored_pilot' || existing.state !== 'ended')) {
    throw new Error('conflict');
  }
  const item = { ...createCoverageAssignment({ householdId: command.householdId,
    accountId, seatType, source: 'sponsored_pilot', now }), revision: existing ? existing.revision + 1 : 1 };
  return { Put: {
    TableName: deps.tableName, Item: item,
    ConditionExpression: existing
      ? 'entityType = :entityType AND accountId = :accountId AND householdId = :householdId AND seatType = :seatType AND #source = :source AND #state = :ended AND revision = :expectedRevision'
      : 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    ...(existing ? {
      ExpressionAttributeNames: { '#source': 'source', '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'CoverageAssignment', ':accountId': accountId,
        ':householdId': command.householdId, ':seatType': seatType,
        ':source': 'sponsored_pilot', ':ended': 'ended', ':expectedRevision': existing.revision },
    } : {}),
  } };
}

function entitlementWrite(deps: Deps, command: Command,
  existing: FamilyEntitlementItem | null, now: number): Item {
  const key = FK.familyEntitlement(command.householdId);
  if (command.command === 'revoke') {
    if (!existing || existing.source !== 'sponsored_pilot' || existing.state !== 'active') {
      throw new Error('conflict');
    }
    return { Update: {
      TableName: deps.tableName, Key: key,
      UpdateExpression: 'SET #state = :ended, revision = :nextRevision, updatedAt = :now',
      ConditionExpression: 'entityType = :entityType AND householdId = :householdId AND #source = :source AND #state = :active AND revision = :expectedRevision',
      ExpressionAttributeNames: { '#source': 'source', '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'FamilyEntitlement',
        ':householdId': command.householdId, ':source': 'sponsored_pilot',
        ':active': 'active', ':ended': 'ended',
        ':expectedRevision': existing.revision, ':nextRevision': existing.revision + 1, ':now': now },
    } };
  }
  if (existing && (existing.source !== 'sponsored_pilot' || existing.state !== 'ended')) {
    throw new Error('conflict');
  }
  const item = { ...createFamilyEntitlement({ householdId: command.householdId,
    source: 'sponsored_pilot', now }), revision: existing ? existing.revision + 1 : 1 };
  return { Put: {
    TableName: deps.tableName, Item: item,
    ConditionExpression: existing
      ? 'entityType = :entityType AND householdId = :householdId AND #source = :source AND #state = :ended AND revision = :expectedRevision'
      : 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    ...(existing ? {
      ExpressionAttributeNames: { '#source': 'source', '#state': 'state' },
      ExpressionAttributeValues: { ':entityType': 'FamilyEntitlement',
        ':householdId': command.householdId, ':source': 'sponsored_pilot',
        ':ended': 'ended', ':expectedRevision': existing.revision },
    } : {}),
  } };
}

async function get(deps: Deps, key: { pk: string; sk: string }): Promise<unknown> {
  const result = await deps.ddb.send(new GetCommand({ TableName: deps.tableName,
    Key: key, ConsistentRead: true }));
  return result.Item;
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && (error.message === 'conflict' ||
    error.name === 'TransactionCanceledException' || error.name === 'ConditionalCheckFailedException');
}

/** Function URL with AWS_IAM only; the app router has no pilot mutation route. */
export function createFamilyPilotBroker(deps: Deps) {
  return async (event: Event): Promise<Result> => {
    const actor = event.requestContext?.authorizer?.iam?.userArn;
    const expectedActor = new RegExp(`^arn:aws:sts::${deps.accountId}:assumed-role/roadmap2u-${deps.stage}-family-pilot-operator/[A-Za-z0-9_+=,.@-]{2,64}$`);
    if (!actor || !expectedActor.test(actor)) return respond(403, { error: 'FORBIDDEN' });
    if (event.requestContext?.http?.method !== 'POST' || event.isBase64Encoded) {
      return respond(400, { error: 'VALIDATION' });
    }
    const requestId = event.requestContext?.requestId;
    const command = parse(event.body, deps.stage);
    if (!command || !requestId || !isTrustedRequestId(requestId)) {
      return respond(400, { error: 'VALIDATION' });
    }
    const hash = commandHash(command);
    const replay = async (): Promise<Result | null> => {
      const existing = await get(deps, commandKey(command.commandId)) as
        { commandHash?: string; actor?: string; command?: string } | undefined;
      if (!existing) return null;
      return existing.commandHash === hash && existing.actor === actor &&
        existing.command === command.command
        ? respond(200, { command: command.command, householdId: command.householdId, idempotent: true })
        : respond(409, { error: 'CONFLICT' });
    };
    const prior = await replay();
    if (prior) return prior;
    try {
      const now = deps.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const keys = [K.profile(command.adultId), FK.household(command.householdId),
        FK.minorSeat(command.householdId, 1), FK.minorSeat(command.householdId, 2),
        FK.additionalSeat(command.householdId), FK.familyEntitlement(command.householdId)];
      const [adultRow, householdRow, ...otherRows] = await Promise.all(keys.map((key) => get(deps, key)));
      const [minor1, minor2, additional, entitlementRow] = otherRows as
        [SeatAssignmentItem | undefined, SeatAssignmentItem | undefined,
          SeatAssignmentItem | undefined, FamilyEntitlementItem | undefined];
      const household = householdRow as HouseholdItem | undefined;
      if (!exactProfile(adultRow, command.adultId, 'adult', today,
        command.command === 'grant') ||
        !household || household.pk !== FK.household(command.householdId).pk ||
        household.sk !== 'META' || household.entityType !== 'Household' ||
        household.primaryResponsibleId !== command.adultId || household.country !== 'MX' ||
        household.state !== 'active' ||
        household.revision !== command.expectedHouseholdRevision) throw new Error('conflict');
      const seatRows = [minor1, minor2, additional];
      if (seatRows.some((seat, index) => !seat || seat.pk !== household.pk ||
        seat.sk !== (index === 0 ? 'SEAT#MINOR#1' : index === 1 ? 'SEAT#MINOR#2' : 'SEAT#ADDITIONAL') ||
        seat.entityType !== 'SeatAssignment' || seat.householdId !== command.householdId ||
        (seat.state !== 'empty' && seat.state !== 'assigned') ||
        (seat.state === 'assigned' && typeof seat.accountId !== 'string') ||
        (seat.state === 'empty' && seat.accountId !== null))) throw new Error('conflict');
      const entitlement = entitlementRow ?? null;
      if ((entitlement?.revision ?? 0) !== command.expectedEntitlementRevision ||
        (command.command === 'revoke' && !entitlement)) throw new Error('conflict');
      const participants: { accountId: string; seatType: CoverageAssignmentItem['seatType'] }[] = [
        { accountId: command.adultId, seatType: 'primary_responsible' },
        ...seatRows.flatMap((seat) => seat?.state === 'assigned' && seat.accountId
          ? [{ accountId: seat.accountId, seatType: seat.seatType }]
          : []),
      ];
      const participantRows = await Promise.all(participants.map(async (participant) => ({
        ...participant,
        profile: await get(deps, K.profile(participant.accountId)),
        coverage: await get(deps, FK.familyCoverage(participant.accountId)),
      })));
      if (participantRows.some((row) =>
        (command.command === 'grant' && !exactProfile(row.profile, row.accountId,
          row.seatType === 'minor' ? 'minor' : 'adult', today)) ||
        (row.coverage !== undefined && !exactCoverage(row.coverage,
          row.accountId, command.householdId, row.seatType)))) throw new Error('conflict');

      const items: Item[] = [
        ...(command.command === 'grant' ? participantRows.map((row) => ({ ConditionCheck: {
          TableName: deps.tableName,
          Key: K.profile(row.accountId),
          ConditionExpression:
            'attribute_exists(pk) AND userId = :accountId AND accountType = :accountType AND (#status = :active OR attribute_not_exists(#status)) AND ' +
            (row.seatType === 'minor' ? 'majorityAt > :today' : 'familyFenceVersion = :familyFenceVersion'),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':accountId': row.accountId,
            ':accountType': row.seatType === 'minor' ? 'minor' : 'adult',
            ':active': 'active',
            ...(row.seatType === 'minor' ? { ':today': today } : { ':familyFenceVersion': 1 }),
          },
        } })) : []),
        { ConditionCheck: {
          TableName: deps.tableName, Key: FK.household(command.householdId),
          ConditionExpression: 'entityType = :entityType AND primaryResponsibleId = :adultId AND #state = :active AND revision = :revision',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':entityType': 'Household', ':adultId': command.adultId,
            ':active': 'active', ':revision': command.expectedHouseholdRevision },
        } },
        ...seatRows.map((seat) => ({ ConditionCheck: {
          TableName: deps.tableName, Key: { pk: seat!.pk, sk: seat!.sk },
          ConditionExpression: 'entityType = :entityType AND householdId = :householdId AND #state = :state AND accountId = :accountId AND revision = :revision',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':entityType': 'SeatAssignment',
            ':householdId': command.householdId, ':state': seat!.state,
            ':accountId': seat!.accountId, ':revision': seat!.revision },
        } })),
        entitlementWrite(deps, command, entitlement, now),
        ...participantRows.map((row) => coverageWrite(deps, command, row.accountId,
          row.seatType, row.coverage as CoverageAssignmentItem | null ?? null, now)),
        { Put: {
          TableName: deps.tableName,
          Item: { ...commandKey(command.commandId), entityType: 'FamilyPilotCommand',
            command: command.command, commandHash: hash, actor, adultId: command.adultId,
            householdId: command.householdId, reason: command.reason, createdAt: now },
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        } },
        deps.auditWriter.transactPut({ targetKind: 'FAMILY_PILOT', targetId: command.householdId,
          timestamp: now, requestId, action: command.command, actor,
          subject: command.adultId,
          details: { commandId: command.commandId, reason: command.reason,
            participants: participants.map((row) => row.accountId) } }),
      ];
      await deps.ddb.send(new TransactWriteCommand({ TransactItems: items }));
      return respond(200, { command: command.command, householdId: command.householdId,
        participantCount: participants.length, idempotent: false });
    } catch (error) {
      if (!isConflict(error)) throw error;
      return (await replay()) ?? respond(409, { error: 'CONFLICT' });
    }
  };
}
