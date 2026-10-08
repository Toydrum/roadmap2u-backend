import { createHash } from 'node:crypto';
import { ApiError } from '@app/api/contracts';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { K, type Deps, type ProfileItem } from '../db';
import {
  ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
  ACCOUNT_CLOSURE_OPEN_GSI_PK,
  accountClosureKey,
  closureOpenSortKey,
  type AccountClosureItem,
} from '../account-closure';
import { FK, householdIdForPrimary } from '../family/keys';
import { privacyCalendarDate, privacyKey, readPrivacyItem } from './consent';
import {
  adolescentInvitationKey,
  hasAdolescentAuthorization,
  type InvitationItem,
} from './adolescents';
import { assertPrivateOperator, privacySnapshotHash, privacyTableName } from './retention';

export interface PrivateClosureCommand {
  userId: string;
  username: string;
  guardianId: string;
  invitationId: string;
  expectedRevision: number;
  commandId: string;
  caseId: string;
}
/** A reviewed legal request, never a parental daily-content permission or app route. */
export async function requestPrivateAdolescentClosure(
  deps: Deps,
  command: PrivateClosureCommand,
  operator: { arn: string; roleArn: string },
): Promise<void> {
  assertPrivateOperator(operator);
  const keys = [
    'userId',
    'username',
    'guardianId',
    'invitationId',
    'expectedRevision',
    'commandId',
    'caseId',
  ];
  const safe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (
    !command ||
    Object.keys(command).length !== keys.length ||
    Object.keys(command).some((key) => !keys.includes(key)) ||
    !['userId', 'username', 'guardianId', 'commandId', 'caseId'].every(
      (name) =>
        typeof command[name as keyof PrivateClosureCommand] === 'string' &&
        safe.test(command[name as keyof PrivateClosureCommand] as string),
    ) ||
    !/^[a-f0-9]{64}$/.test(command.invitationId) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  )
    throw new ApiError('VALIDATION');
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .digest('hex');
  const closureKey = accountClosureKey(command.userId);
  const old = (
    await deps.ddb.send(
      new GetCommand({ TableName: deps.table, Key: closureKey, ConsistentRead: true }),
    )
  ).Item;
  if (old) {
    if (
      old['kind'] !== 'private_adolescent' ||
      old['requestHash'] !== digest ||
      old['actorSub'] !== operator.arn
    )
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    return;
  }
  const profile = (
    await deps.ddb.send(
      new GetCommand({
        TableName: deps.table,
        Key: K.profile(command.userId),
        ConsistentRead: true,
      }),
    )
  ).Item as ProfileItem | undefined;
  const state = await readPrivacyItem(deps, command.userId);
  const invite = (
    await deps.ddb.send(
      new GetCommand({
        TableName: privacyTableName(deps),
        Key: adolescentInvitationKey(command.invitationId),
        ConsistentRead: true,
      }),
    )
  ).Item as InvitationItem | undefined;
  if (
    !profile ||
    profile.userId !== command.userId ||
    profile.username !== command.username ||
    profile.accountType !== 'minor' ||
    profile.privacyMode !== 'adolescent_private' ||
    (profile.status !== undefined && profile.status !== 'active') ||
    !state ||
    state.subjectKind !== 'adolescent_private' ||
    state.revision !== command.expectedRevision ||
    state.invitationId !== command.invitationId ||
    state.guardianId !== command.guardianId ||
    !state.majorityAt ||
    state.majorityAt <= privacyCalendarDate(deps.now()) ||
    profile.majorityAt !== state.majorityAt ||
    !invite ||
    invite.state !== 'accepted' ||
    invite.adolescentId !== command.userId ||
    invite.guardianId !== command.guardianId ||
    !hasAdolescentAuthorization(invite)
  )
    throw new ApiError('CONFLICT');
  const now = deps.now();
  const closure: AccountClosureItem & { requestHash: string; caseId: string } = {
    ...closureKey,
    sub: command.userId,
    username: command.username,
    actorSub: operator.arn,
    kind: 'private_adolescent',
    closureId: `privacy-${createHash('sha256').update(`${command.userId}:${command.commandId}`).digest('hex')}`,
    state: 'requested',
    revision: 1,
    requestedAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    gsi1pk: ACCOUNT_CLOSURE_OPEN_GSI_PK,
    gsi1sk: closureOpenSortKey(now, command.userId),
    checkpoint: { phase: 'familyMembership' },
    familyCleanupVersion: ACCOUNT_CLOSURE_FAMILY_CLEANUP_VERSION,
    requestHash: digest,
    caseId: command.caseId,
  };
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.table,
              Item: closure,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: deps.table,
              Key: K.profile(command.userId),
              UpdateExpression: 'SET #status = :closing',
              ConditionExpression:
                'userId = :id AND username = :username AND accountType = :minor AND privacyMode = :private AND majorityAt = :date AND (attribute_not_exists(#status) OR #status = :active)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':id': command.userId,
                ':username': command.username,
                ':minor': 'minor',
                ':private': 'adolescent_private',
                ':date': state.majorityAt,
                ':active': 'active',
                ':closing': 'closing',
              },
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: privacyKey(command.userId),
              ConditionExpression: 'revision = :revision',
              ExpressionAttributeValues: { ':revision': state.revision },
            },
          },
          {
            ConditionCheck: {
              TableName: privacyTableName(deps),
              Key: { pk: `PRIVACY_STATE#${command.userId}`, sk: 'STATE' },
              ConditionExpression: 'revision = :revision AND snapshotHash = :hash',
              ExpressionAttributeValues: {
                ':revision': state.revision,
                ':hash': privacySnapshotHash(state),
              },
            },
          },
          {
            ConditionCheck: {
              TableName: privacyTableName(deps),
              Key: adolescentInvitationKey(command.invitationId),
              ConditionExpression:
                'revision = :revision AND adolescentId = :id AND guardianId = :guardian',
              ExpressionAttributeValues: {
                ':revision': invite.revision,
                ':id': command.userId,
                ':guardian': command.guardianId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: FK.familyCoverage(command.userId),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            ConditionCheck: {
              TableName: deps.table,
              Key: FK.household(householdIdForPrimary(command.userId)),
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
  // The existing durable outbox reconciler enqueues it. No extra Cognito/SQS authority is granted to this operator.
}
