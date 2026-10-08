import { createHash } from 'node:crypto';
import { ApiError } from '@app/api/contracts';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { type Deps, type RecordItem } from '../db';
import type { AdultPrivacyItem } from './consent';

export const RESTORE_EXCLUSION_MS = 36 * 86400000;
export const ORDINARY_RETENTION_MS = 30 * 86400000;
type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export interface DecisionLedgerItem {
  pk: string;
  sk: 'STATE';
  userId: string;
  revision: number;
  updatedAt: number;
  snapshot: AdultPrivacyItem;
  snapshotHash: string;
}
export interface RestoreExclusionItem {
  pk: string;
  sk: 'STATE';
  userId: string;
  revision: number;
  updatedAt: number;
  scope: 'forest' | 'account';
  erasureId: string;
  cutoffRevision: number;
  holdRevision: number;
  completedAt?: number;
  ttl?: number;
}
export interface PrivacyHold {
  pk: string;
  sk: string;
  userId: string;
  caseId: string;
  state: 'active' | 'released';
  scope: 'forest' | 'account' | 'consent' | 'audit' | 'commercial';
  legalBasis: string;
  expiresAt: number;
  reviewAt: number;
}
export interface PrivacyHoldCommand {
  action: 'set' | 'release';
  userId: string;
  caseId: string;
  commandId: string;
  expectedRevision: number;
  scope?: PrivacyHold['scope'];
  legalBasis?: string;
  expiresAt?: number;
  reviewAt?: number;
}
/** Private CLI only. IAM and STS establish the operator; no HTTP handler calls this. */
export function assertPrivateOperator(operator: { arn: string; roleArn: string }): void {
  const role =
    /^arn:(aws(?:-[a-z]+)?):iam::(\d{12}):role\/roadmap2u\/(dev|test|prod)\/operators\/(roadmap2u-(?:dev|test|prod)-privacy-operator)$/.exec(
      operator.roleArn,
    );
  if (
    !role ||
    role[4] !== `roadmap2u-${role[3]}-privacy-operator` ||
    !operator.arn.startsWith(`arn:${role[1]}:sts::${role[2]}:assumed-role/${role[4]}/`) ||
    operator.arn.slice(operator.arn.lastIndexOf('/') + 1).length === 0
  )
    throw new ApiError('FORBIDDEN');
}
export async function changePrivacyHold(
  deps: Deps,
  command: PrivacyHoldCommand,
  operator: { arn: string; roleArn: string },
): Promise<void> {
  assertPrivateOperator(operator);
  const safe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const keys = [
    'action',
    'userId',
    'caseId',
    'commandId',
    'expectedRevision',
    ...(command.action === 'set' ? ['scope', 'legalBasis', 'expiresAt', 'reviewAt'] : []),
  ];
  if (
    !command ||
    !['set', 'release'].includes(command.action) ||
    Object.keys(command).length !== keys.length ||
    Object.keys(command).some((name) => !keys.includes(name)) ||
    !safe.test(command.userId) ||
    !safe.test(command.caseId) ||
    !safe.test(command.commandId) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    (command.action === 'set' &&
      (!['forest', 'account', 'consent', 'audit', 'commercial'].includes(command.scope!) ||
        typeof command.legalBasis !== 'string' ||
        !command.legalBasis.trim() ||
        command.legalBasis.length > 2000 ||
        !Number.isSafeInteger(command.expiresAt) ||
        command.expiresAt! <= deps.now() ||
        !Number.isSafeInteger(command.reviewAt) ||
        command.reviewAt! <= deps.now() ||
        command.reviewAt! > command.expiresAt!))
  )
    throw new ApiError('VALIDATION');
  const commandHash = createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .digest('hex');
  const evidenceKey = { pk: `HOLD_AUDIT#${command.userId}`, sk: `COMMAND#${command.commandId}` };
  const evidence = await strong<Record<string, unknown>>(deps, evidenceKey);
  if (evidence) {
    if (evidence['requestHash'] !== commandHash || evidence['actor'] !== operator.arn)
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return;
  }
  const [profile, closure] = await Promise.all([
    deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: { pk: `USER#${command.userId}`, sk: 'PROFILE' },
        ConsistentRead: true,
      }),
    ),
    deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: { pk: `ACCOUNT_CLOSURE#${command.userId}`, sk: 'STATE' },
        ConsistentRead: true,
      }),
    ),
  ]);
  if (
    command.action === 'set' &&
    (!profile.Item ||
      profile.Item['userId'] !== command.userId ||
      !['adult', 'minor'].includes(profile.Item['accountType'] as string) ||
      (profile.Item['status'] !== undefined && profile.Item['status'] !== 'active') ||
      closure.Item)
  )
    throw new ApiError('CONFLICT');
  const control = await readRestoreExclusion(deps, command.userId);
  if (
    (control?.revision ?? 0) !== command.expectedRevision ||
    command.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    (control?.holdRevision ?? 0) >= Number.MAX_SAFE_INTEGER
  )
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  const holdKey = { pk: `HOLD#${command.userId}`, sk: `CASE#${command.caseId}` };
  const old = await strong<PrivacyHold>(deps, holdKey);
  if (command.action === 'release' && !old) throw new ApiError('NOT_FOUND');
  if (
    old &&
    (old.userId !== command.userId ||
      old.caseId !== command.caseId ||
      !['active', 'released'].includes(old.state))
  )
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  const now = deps.now();
  const next = {
    ...old,
    ...holdKey,
    userId: command.userId,
    caseId: command.caseId,
    updatedAt: now,
    state: command.action === 'set' ? 'active' : 'released',
    ...(command.action === 'set'
      ? {
          scope: command.scope!,
          legalBasis: command.legalBasis!,
          expiresAt: command.expiresAt!,
          reviewAt: command.reviewAt!,
        }
      : {}),
    ttl: Math.ceil(
      ((command.action === 'set' ? command.expiresAt! : now) + RESTORE_EXCLUSION_MS) / 1000,
    ),
  };
  const nextControl: RestoreExclusionItem = {
    ...control,
    ...restoreExclusionKey(command.userId),
    userId: command.userId,
    revision: command.expectedRevision + 1,
    updatedAt: now,
    holdRevision: (control?.holdRevision ?? 0) + 1,
    scope: control?.scope ?? 'forest',
    erasureId: control?.erasureId ?? 'hold-control',
    cutoffRevision: control?.cutoffRevision ?? 0,
  };
  if (nextControl.cutoffRevision === 0 || nextControl.completedAt) {
    nextControl.ttl = Math.max(
      control?.ttl ?? 0,
      Math.ceil(
        ((command.action === 'set' ? command.expiresAt! : now) + RESTORE_EXCLUSION_MS) / 1000,
      ),
    );
  } else delete nextControl.ttl;
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(command.action === 'set'
            ? [
                {
                  ConditionCheck: {
                    TableName: deps.table,
                    Key: { pk: `USER#${command.userId}`, sk: 'PROFILE' },
                    ConditionExpression:
                      'userId = :user AND accountType = :kind AND (attribute_not_exists(#status) OR #status = :active)',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                      ':user': command.userId,
                      ':kind': profile.Item!['accountType'],
                      ':active': 'active',
                    },
                  },
                },
                {
                  ConditionCheck: {
                    TableName: deps.table,
                    Key: { pk: `ACCOUNT_CLOSURE#${command.userId}`, sk: 'STATE' },
                    ConditionExpression: 'attribute_not_exists(pk)',
                  },
                },
              ]
            : []),
          restoreExclusionPut(deps, nextControl, control),
          {
            Put: {
              TableName: privacyTableName(deps),
              Item: next,
              ConditionExpression: old
                ? '#state = :state AND expiresAt = :expiry'
                : 'attribute_not_exists(pk)',
              ...(old
                ? {
                    ExpressionAttributeNames: { '#state': 'state' },
                    ExpressionAttributeValues: { ':state': old.state, ':expiry': old.expiresAt },
                  }
                : {}),
            },
          },
          {
            Put: {
              TableName: privacyTableName(deps),
              Item: {
                ...evidenceKey,
                userId: command.userId,
                caseId: command.caseId,
                action: command.action,
                requestHash: commandHash,
                actor: operator.arn,
                updatedAt: now,
                ttl: next.ttl,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if ((error as Error)?.name === 'TransactionCanceledException')
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    throw error;
  }
}
export const decisionLedgerKey = (userId: string) => ({
  pk: `PRIVACY_STATE#${userId}`,
  sk: 'STATE' as const,
});
export const restoreExclusionKey = (userId: string) => ({
  pk: `RESTORE#${userId}`,
  sk: 'STATE' as const,
});
export function privacyTableName(deps: Deps): string {
  if (!deps.privacyTable || deps.privacyTable === deps.table)
    throw new ApiError('server', 'independent privacy storage unavailable');
  return deps.privacyTable;
}
export function privacySnapshotHash(snapshot: AdultPrivacyItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .digest('hex');
}
async function strong<T>(deps: Deps, key: { pk: string; sk: string }): Promise<T | undefined> {
  const result = await deps.ddb.send(
    new GetCommand({ TableName: privacyTableName(deps), Key: key, ConsistentRead: true }),
  );
  return result.Item as T | undefined;
}
export async function readDecisionLedger(
  deps: Deps,
  userId: string,
): Promise<DecisionLedgerItem | undefined> {
  if (!deps.privacyTable) return undefined;
  const item = await strong<DecisionLedgerItem>(deps, decisionLedgerKey(userId));
  if (
    item &&
    (item.pk !== decisionLedgerKey(userId).pk ||
      item.sk !== 'STATE' ||
      item.userId !== userId ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      item.snapshot?.userId !== userId ||
      item.snapshot.revision !== item.revision ||
      item.updatedAt !== item.snapshot.updatedAt ||
      item.snapshotHash !== privacySnapshotHash(item.snapshot))
  )
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  return item;
}
export function decisionLedgerPut(
  deps: Deps,
  next: AdultPrivacyItem,
  previous?: AdultPrivacyItem,
): TransactionItem {
  const item: DecisionLedgerItem = {
    ...decisionLedgerKey(next.userId),
    userId: next.userId,
    revision: next.revision,
    updatedAt: next.updatedAt,
    snapshot: next,
    snapshotHash: privacySnapshotHash(next),
  };
  return {
    Put: {
      TableName: privacyTableName(deps),
      Item: item,
      ConditionExpression: previous
        ? 'revision = :revision AND snapshotHash = :hash'
        : 'attribute_not_exists(pk)',
      ...(previous
        ? {
            ExpressionAttributeValues: {
              ':revision': previous.revision,
              ':hash': privacySnapshotHash(previous),
            },
          }
        : {}),
    },
  };
}
export async function readRestoreExclusion(
  deps: Deps,
  userId: string,
): Promise<RestoreExclusionItem | undefined> {
  if (!deps.privacyTable) return undefined;
  const item = await strong<RestoreExclusionItem>(deps, restoreExclusionKey(userId));
  if (
    item &&
    (item.pk !== restoreExclusionKey(userId).pk ||
      item.sk !== 'STATE' ||
      item.userId !== userId ||
      !['forest', 'account'].includes(item.scope) ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      !Number.isSafeInteger(item.cutoffRevision) ||
      item.cutoffRevision < 0 ||
      !Number.isSafeInteger(item.holdRevision) ||
      item.holdRevision < 0)
  )
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  return item;
}
export function restoreExclusionPut(
  deps: Deps,
  next: RestoreExclusionItem,
  previous?: RestoreExclusionItem,
): TransactionItem {
  return {
    Put: {
      TableName: privacyTableName(deps),
      Item: next,
      ConditionExpression: previous ? 'revision = :revision' : 'attribute_not_exists(pk)',
      ...(previous ? { ExpressionAttributeValues: { ':revision': previous.revision } } : {}),
    },
  };
}
export function restoreExclusionCheck(deps: Deps, item: RestoreExclusionItem): TransactionItem {
  return {
    ConditionCheck: {
      TableName: privacyTableName(deps),
      Key: restoreExclusionKey(item.userId),
      ConditionExpression: 'revision = :revision AND holdRevision = :holds AND erasureId = :id',
      ExpressionAttributeValues: {
        ':revision': item.revision,
        ':holds': item.holdRevision,
        ':id': item.erasureId,
      },
    },
  };
}
export async function activePrivacyHolds(deps: Deps, userId: string): Promise<PrivacyHold[]> {
  if (!deps.privacyTable) return [];
  const holds: PrivacyHold[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const result = await deps.ddb.send(
      new QueryCommand({
        TableName: privacyTableName(deps),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `HOLD#${userId}`, ':prefix': 'CASE#' },
        ConsistentRead: true,
        Limit: 100,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const candidate of result.Items ?? []) {
      const hold = candidate as PrivacyHold;
      if (
        hold.pk !== `HOLD#${userId}` ||
        !hold.sk.startsWith('CASE#') ||
        hold.userId !== userId ||
        !['active', 'released'].includes(hold.state) ||
        !['forest', 'account', 'consent', 'audit', 'commercial'].includes(hold.scope) ||
        typeof hold.legalBasis !== 'string' ||
        !hold.legalBasis.trim() ||
        !Number.isSafeInteger(hold.expiresAt) ||
        !Number.isSafeInteger(hold.reviewAt) ||
        hold.reviewAt > hold.expiresAt
      )
        throw new ApiError('PRIVACY_REVISION_CONFLICT');
      if (hold.state === 'active' && hold.expiresAt > deps.now()) holds.push(hold);
    }
    start = result.LastEvaluatedKey;
  } while (start);
  return holds;
}
/** Pure recovery decision: legacy/old consent epochs never override a later erasure. */
export function recordMayBeRestored(
  record: Pick<RecordItem, 'owner' | 'privacyRevision'>,
  exclusion: RestoreExclusionItem | undefined,
): boolean {
  if (!exclusion) return true;
  if (record.owner !== exclusion.userId || exclusion.scope === 'account') return false;
  if (exclusion.cutoffRevision === 0) return true;
  return (
    Number.isSafeInteger(record.privacyRevision) &&
    record.privacyRevision! > exclusion.cutoffRevision
  );
}
