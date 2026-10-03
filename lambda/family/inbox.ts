import { createHash } from 'node:crypto';
import {
  ApiError,
  FAMILY_BILLING_CONTRACT_VERSION,
  type FamilyInboxEntry,
  type FamilyInboxView,
} from '@app/api/contracts';
import { requireWritableOwner, type Ctx } from '../authz';
import { GetCommand, QueryCommand, K } from '../db';
import type { TransactItem } from '../handlers/guarded-mutation';
import { assertFamilyIdentifier, FK } from './keys';

const PREFIX = 'FAMILY_INBOX#';
const CURSOR = /^[a-f0-9]{64}$/;
const STATES = new Set(['pending', 'approved', 'accepted', 'rejected', 'revoked', 'expired']);
const KINDS = new Set([
  'minor_link_request',
  'additional_responsible_invitation',
  'primary_transfer',
]);

interface InboxSource {
  readonly pk: string;
  readonly sk: string;
  readonly householdId: string;
  readonly kind?: FamilyInboxEntry['kind'];
  readonly noticeId?: string;
  readonly commandId: string;
}

function pointerId(pk: string, sk: string, noticeId: string): string {
  return createHash('sha256')
    .update(pk + '\0' + sk + '\0' + noticeId)
    .digest('hex');
}

/** Stored in the SAME transaction as the canonical proposal, never best-effort.
 * Callers must include writableOwnerConditionChecks for every recipient. */
export function familyInboxWrites(
  ctx: Ctx,
  source: InboxSource,
  recipientIds: readonly (string | null)[],
): TransactItem[] {
  const noticeId = source.noticeId ?? source.commandId;
  return [...new Set(recipientIds.filter((id): id is string => id !== null))].map((accountId) => ({
    Put: {
      TableName: ctx.deps.table,
      Item: {
        pk: K.user(accountId),
        sk: PREFIX + pointerId(source.pk, source.sk, noticeId),
        entityType: 'FamilyInboxPointer',
        noticeId,
        householdId: source.householdId,
        kind: source.kind ?? 'primary_transfer',
      },
    },
  }));
}

async function entryFor(
  ctx: Ctx,
  pointer: Record<string, unknown>,
): Promise<FamilyInboxEntry | null> {
  if (
    pointer['pk'] !== K.user(ctx.callerId) ||
    pointer['entityType'] !== 'FamilyInboxPointer' ||
    typeof pointer['noticeId'] !== 'string' ||
    typeof pointer['householdId'] !== 'string' ||
    !KINDS.has(String(pointer['kind']))
  )
    return null;
  const noticeId = pointer['noticeId'];
  const householdId = pointer['householdId'];
  try {
    assertFamilyIdentifier(noticeId, 'noticeId');
    assertFamilyIdentifier(householdId, 'householdId');
  } catch {
    return null;
  }
  const transfer = pointer['kind'] === 'primary_transfer';
  const key = transfer
    ? FK.primaryTransfer(householdId)
    : { pk: 'FAMILY_NOTICE#' + noticeId, sk: 'META' };
  if (pointer['sk'] !== PREFIX + pointerId(key.pk, key.sk, noticeId)) return null;
  const { Item: source } = await ctx.deps.ddb.send(
    new GetCommand({ TableName: ctx.deps.table, Key: key, ConsistentRead: true }),
  );
  if (
    !source ||
    source['pk'] !== key.pk ||
    source['sk'] !== key.sk ||
    source['householdId'] !== householdId ||
    source[transfer ? 'commandId' : 'noticeId'] !== noticeId ||
    source['entityType'] !== (transfer ? 'PrimaryTransferProposal' : 'FamilyNotice') ||
    (!transfer && source['kind'] !== pointer['kind']) ||
    !STATES.has(source['state'])
  )
    return null;
  const recipients = transfer
    ? [source['currentPrimaryId'], source['newPrimaryId']]
    : [
        source['createdById'],
        source['sourcePrimaryId'],
        source['intendedAdultId'],
        source['minorId'],
      ];
  if (!recipients.includes(ctx.callerId)) return null;
  if (
    !['createdAt', 'expiresAt', 'revision'].every(
      (field) => Number.isSafeInteger(source[field]) && source[field] >= 0,
    ) ||
    source['revision'] < 1 ||
    !Number.isSafeInteger(source[transfer ? 'householdRevision' : 'targetHouseholdRevision']) ||
    (source[transfer ? 'householdRevision' : 'targetHouseholdRevision'] as number) < 1 ||
    source['expiresAt'] <= source['createdAt']
  )
    return null;
  const state =
    (source['state'] === 'pending' || source['state'] === 'approved') &&
    source['expiresAt'] <= ctx.deps.now()
      ? 'expired'
      : source['state'];
  // Deliberate allowlist: never spread the source (it contains bearer codes).
  return {
    noticeId,
    kind: pointer['kind'] as FamilyInboxEntry['kind'],
    householdId,
    expectedHouseholdRevision: source[transfer ? 'householdRevision' : 'targetHouseholdRevision'] as number,
    state,
    createdAt: source['createdAt'],
    expiresAt: source['expiresAt'],
    revision: source['revision'],
  };
}

/** Paginated account-private discovery; no scan, household expansion or commercial gate. */
export async function getFamilyInbox(ctx: Ctx, cursor?: string): Promise<FamilyInboxView> {
  if (cursor !== undefined && !CURSOR.test(cursor)) throw new ApiError('VALIDATION');
  await requireWritableOwner(ctx, ctx.callerId);
  const pk = K.user(ctx.callerId);
  const result = await ctx.deps.ddb.send(
    new QueryCommand({
      TableName: ctx.deps.table,
      ConsistentRead: true,
      Limit: 50,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': PREFIX },
      ...(cursor ? { ExclusiveStartKey: { pk, sk: PREFIX + cursor } } : {}),
    }),
  );
  const entries = await Promise.all((result.Items ?? []).map((row) => entryFor(ctx, row)));
  await requireWritableOwner(ctx, ctx.callerId);
  const last = result.LastEvaluatedKey;
  const tail =
    last?.['pk'] === pk && typeof last['sk'] === 'string' && last['sk'].startsWith(PREFIX)
      ? last['sk'].slice(PREFIX.length)
      : null;
  return {
    contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
    entries: entries.filter((entry): entry is FamilyInboxEntry => entry !== null),
    nextCursor: tail && CURSOR.test(tail) ? tail : null,
  };
}
