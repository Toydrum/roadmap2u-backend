import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ApiError } from '@app/api/contracts';
import { K, type Deps } from '../db';
import type { AccountClosureItem } from '../account-closure';
import { adolescentInvitationKey, type InvitationItem } from './adolescents';
import {
  activePrivacyHolds,
  readRestoreExclusion,
  restoreExclusionPut,
  restoreExclusionCheck,
  restoreExclusionKey,
  privacyTableName,
  RESTORE_EXCLUSION_MS,
  decisionLedgerKey,
  readDecisionLedger,
  type RestoreExclusionItem,
  type PrivacyHold,
} from './retention';
type TxItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
function closureCheck(deps: Deps, closure: AccountClosureItem): TxItem {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: { pk: closure.pk, sk: closure.sk },
      ConditionExpression: 'closureId = :id AND revision = :revision AND #state = :state',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':id': closure.closureId,
        ':revision': closure.revision,
        ':state': closure.state,
      },
    },
  };
}
async function archiveConsentPage(
  deps: Deps,
  closure: AccountClosureItem,
  control: RestoreExclusionItem,
  holds: PrivacyHold[],
): Promise<boolean> {
  if (!holds.some((hold) => hold.scope === 'consent')) return true;
  const key = { pk: `CONSENT_ARCHIVE#${closure.sub}`, sk: 'STATE' };
  const metadata = (
    await deps.ddb.send(
      new GetCommand({ TableName: privacyTableName(deps), Key: key, ConsistentRead: true }),
    )
  ).Item;
  if (metadata?.['closureId'] === closure.closureId && metadata['complete'] === true) return true;
  const cursor = metadata?.['cursor'];
  if (
    cursor &&
    (cursor.pk !== K.user(closure.sub) ||
      typeof cursor.sk !== 'string' ||
      !cursor.sk.startsWith('PRIVACY#'))
  )
    throw new ApiError('PRIVACY_REVISION_CONFLICT');
  const page = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      ConsistentRead: true,
      Limit: 20,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': K.user(closure.sub),
        ':prefix': 'PRIVACY#',
      },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }),
  );
  if ((page.Items?.length ?? 0) > 20) throw new ApiError('server');
  const ttl = Math.ceil(
    Math.max(...holds.filter((hold) => hold.scope === 'consent').map((hold) => hold.expiresAt)) /
      1000,
  );
  const copies: TxItem[] = (page.Items ?? []).map((item) => {
    if (
      item['pk'] !== K.user(closure.sub) ||
      item['userId'] !== closure.sub ||
      typeof item['sk'] !== 'string' ||
      !item['sk'].startsWith('PRIVACY#')
    )
      throw new ApiError('PRIVACY_REVISION_CONFLICT');
    const permitted = [
      'userId',
      'revision',
      'updatedAt',
      'action',
      'documentHash',
      'document',
      'authentication',
      'authenticatedAt',
      'adultDeclaredAt',
      'declarationLanguage',
      'declarationDocumentHash',
      'cloudConsent',
      'cloudLanguage',
      'cloudDocumentHash',
      'erasure',
      'subjectKind',
      'adolescentAcceptedAt',
      'adolescentLanguage',
      'adolescentDocumentHash',
      'guardianId',
      'guardianConsent',
      'guardianLanguage',
      'guardianDocumentHash',
      'guardianAuthorization',
      'majorityAt',
      'invitationId',
      'actorId',
      'verificationCaseId',
    ];
    const minimum = Object.fromEntries(
      Object.entries(item).filter(([name]) => permitted.includes(name)),
    );
    return {
      Put: {
        TableName: privacyTableName(deps),
        Item: {
          ...minimum,
          pk: key.pk,
          sk: item['sk'],
          closureId: closure.closureId,
          retainUntil: ttl * 1000,
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR closureId = :id',
        ExpressionAttributeValues: { ':id': closure.closureId },
      },
    };
  });
  const complete = !page.LastEvaluatedKey;
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        closureCheck(deps, closure),
        restoreExclusionCheck(deps, control),
        ...copies,
        {
          Put: {
            TableName: privacyTableName(deps),
            Item: {
              ...key,
              closureId: closure.closureId,
              revision: (metadata?.['revision'] ?? 0) + 1,
              complete,
              ...(page.LastEvaluatedKey ? { cursor: page.LastEvaluatedKey } : {}),
              ttl,
            },
            ConditionExpression: metadata ? 'revision = :revision' : 'attribute_not_exists(pk)',
            ...(metadata
              ? { ExpressionAttributeValues: { ':revision': metadata['revision'] } }
              : {}),
          },
        },
      ],
    }),
  );
  return complete;
}
/** Called before destructive phases. New holds serialize against the closure request. */
export async function prepareAccountPrivacyClosure(
  deps: Deps,
  closure: AccountClosureItem,
): Promise<{ blocked: boolean; control?: RestoreExclusionItem }> {
  if (!deps.privacyTable) return { blocked: false };
  let control = await readRestoreExclusion(deps, closure.sub);
  const holds = await activePrivacyHolds(deps, closure.sub);
  if (holds.some((hold) => hold.scope === 'forest' || hold.scope === 'account'))
    return { blocked: true };
  if (!control || control.scope !== 'account' || control.erasureId !== closure.closureId) {
    const next: RestoreExclusionItem = {
      ...restoreExclusionKey(closure.sub),
      userId: closure.sub,
      revision: (control?.revision ?? 0) + 1,
      updatedAt: deps.now(),
      holdRevision: control?.holdRevision ?? 0,
      scope: 'account',
      erasureId: closure.closureId,
      cutoffRevision: control?.cutoffRevision ?? 0,
    };
    if (next.revision > Number.MAX_SAFE_INTEGER) throw new ApiError('PRIVACY_REVISION_CONFLICT');
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [closureCheck(deps, closure), restoreExclusionPut(deps, next, control)],
      }),
    );
    control = next;
  }
  const archived = await archiveConsentPage(deps, closure, control, holds);
  return { blocked: !archived, control };
}
export async function completeAccountPrivacyClosure(
  deps: Deps,
  control?: RestoreExclusionItem,
): Promise<TxItem[]> {
  if (!control) return [];
  const ledger = await readDecisionLedger(deps, control.userId);
  const inviteId = ledger?.snapshot.invitationId;
  const invitation = inviteId
    ? ((
        await deps.ddb.send(
          new GetCommand({
            TableName: privacyTableName(deps),
            Key: adolescentInvitationKey(inviteId),
            ConsistentRead: true,
          }),
        )
      ).Item as InvitationItem | undefined)
    : undefined;
  const ttl = Math.ceil((deps.now() + RESTORE_EXCLUSION_MS) / 1000);
  return [
    restoreExclusionPut(
      deps,
      {
        ...control,
        revision: control.revision + 1,
        updatedAt: deps.now(),
        completedAt: deps.now(),
        ttl,
      },
      control,
    ),
    ...(invitation?.adolescentId === control.userId
      ? [
          {
            Put: {
              TableName: privacyTableName(deps),
              Item: {
                ...invitation,
                state: 'revoked',
                revision: invitation.revision + 1,
                ttl: Math.min(invitation.ttl ?? ttl, ttl),
              },
              ConditionExpression: 'revision = :revision AND adolescentId = :id',
              ExpressionAttributeValues: {
                ':revision': invitation.revision,
                ':id': control.userId,
              },
            },
          } as TxItem,
        ]
      : []),
    ...(ledger
      ? [
          {
            Delete: {
              TableName: privacyTableName(deps),
              Key: decisionLedgerKey(control.userId),
              ConditionExpression: 'revision = :revision AND snapshotHash = :hash',
              ExpressionAttributeValues: {
                ':revision': ledger.revision,
                ':hash': ledger.snapshotHash,
              },
            },
          } as TxItem,
        ]
      : []),
  ];
}
