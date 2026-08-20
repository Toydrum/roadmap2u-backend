import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  Ctx,
  WRITABLE_PROFILE_CONDITION,
  closureAbsenceConditionCheck,
  requireWritableOwner,
  writableOwnerConditionChecks,
} from '../authz';
import {
  CodeItem,
  Deps,
  FriendRequestItem,
  GetCommand,
  K,
  LinkItem,
  TransactWriteCommand,
} from '../db';

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type EmbeddedOwnerGuards = Record<
  string,
  { profile?: true; closure?: true }
>;

function uniqueOwnerIds(ownerIds: string[]): string[] {
  return [...new Set(ownerIds)];
}

function addressedKey(item: TransactItem): {
  table: string | undefined;
  pk: unknown;
  sk: unknown;
} {
  if (item.Put) {
    return { table: item.Put.TableName, pk: item.Put.Item?.['pk'], sk: item.Put.Item?.['sk'] };
  }
  const operation = item.Update ?? item.Delete ?? item.ConditionCheck;
  return { table: operation?.TableName, pk: operation?.Key?.['pk'], sk: operation?.Key?.['sk'] };
}

function sameAddress(
  item: TransactItem,
  table: string,
  key: { pk: string; sk: string },
): boolean {
  const addressed = addressedKey(item);
  return addressed.table === table && addressed.pk === key.pk && addressed.sk === key.sk;
}

function normalizeCondition(expression: string): string {
  return expression.replace(/\s+/g, ' ').trim();
}

function isSingleParenthesizedGroup(expression: string): boolean {
  if (!expression.startsWith('(')) return false;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0 || (depth === 0 && index < expression.length - 1)) return false;
  }
  return depth === 0;
}

function hasEquivalentWritableCondition(expression: string): boolean {
  const normalized = normalizeCondition(expression);
  const required = normalizeCondition(WRITABLE_PROFILE_CONDITION);
  if (normalized === required) return true;
  const prefix = `${required} AND `;
  return normalized.startsWith(prefix) && isSingleParenthesizedGroup(normalized.slice(prefix.length));
}

function assertEmbeddedProfileGuard(ctx: Ctx, ownerId: string, writes: TransactItem[]): void {
  const update = writes.find((item) => sameAddress(item, ctx.deps.table, K.profile(ownerId)))
    ?.Update;
  const expression = update?.ConditionExpression ?? '';
  if (
    !update ||
    !hasEquivalentWritableCondition(expression) ||
    update.ExpressionAttributeNames?.['#status'] !== 'status' ||
    update.ExpressionAttributeValues?.[':active'] !== 'active'
  ) {
    throw new Error(`owner ${ownerId} has no equivalent embedded profile guard`);
  }
}

function assertEmbeddedClosureGuard(ctx: Ctx, ownerId: string, writes: TransactItem[]): void {
  const expected = closureAbsenceConditionCheck(ctx.deps, ownerId).ConditionCheck!;
  const check = writes.find((item) =>
    sameAddress(item, ctx.deps.table, expected.Key as { pk: string; sk: string }),
  )?.ConditionCheck;
  const expression = check?.ConditionExpression ?? '';
  if (
    !check ||
    normalizeCondition(expression) !== normalizeCondition(expected.ConditionExpression!)
  ) {
    throw new Error(`owner ${ownerId} has no equivalent embedded closure guard`);
  }
}

function ownerGuards(
  ctx: Ctx,
  ownerIds: string[],
  writes: TransactItem[],
  embedded: EmbeddedOwnerGuards,
): TransactItem[] {
  return uniqueOwnerIds(ownerIds).flatMap((ownerId) => {
    const declared = embedded[ownerId] ?? {};
    if (declared.profile) assertEmbeddedProfileGuard(ctx, ownerId, writes);
    if (declared.closure) assertEmbeddedClosureGuard(ctx, ownerId, writes);
    const [profileGuard, closureGuard] = writableOwnerConditionChecks(ctx.deps, ownerId);
    return [
      ...(declared.profile ? [] : [profileGuard!]),
      ...(declared.closure ? [] : [closureGuard!]),
    ];
  });
}

function assertUniqueAddresses(items: TransactItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const addressed = addressedKey(item);
    const id = JSON.stringify([addressed.table, addressed.pk, addressed.sk]);
    if (seen.has(id)) throw new Error(`transaction addresses the same item twice: ${id}`);
    seen.add(id);
  }
}

export function isTransactionCanceled(error: unknown): boolean {
  return (error as { name?: string })?.name === 'TransactionCanceledException';
}

export async function getConsistent<T>(
  ctx: Ctx,
  key: { pk: string; sk: string },
): Promise<T | null> {
  const result = await ctx.deps.ddb.send(
    new GetCommand({ TableName: ctx.deps.table, Key: key, ConsistentRead: true }),
  );
  return (result.Item as T | undefined) ?? null;
}

async function recheckOwners(ctx: Ctx, ownerIds: string[]): Promise<void> {
  for (const ownerId of uniqueOwnerIds(ownerIds)) await requireWritableOwner(ctx, ownerId);
}

export async function guardedWrite(
  ctx: Ctx,
  ownerIds: string[],
  writes: TransactItem[],
  classifyCancellation?: () => Promise<void>,
  embedded: EmbeddedOwnerGuards = {},
): Promise<void> {
  const items = [...writes, ...ownerGuards(ctx, ownerIds, writes, embedded)];
  assertUniqueAddresses(items);
  try {
    await ctx.deps.ddb.send(
      new TransactWriteCommand({ TransactItems: items }),
    );
  } catch (error) {
    if (!isTransactionCanceled(error)) throw error;
    await recheckOwners(ctx, ownerIds);
    await classifyCancellation?.();
    throw error;
  }
}

export function exactCodeOperation(
  deps: Deps,
  item: CodeItem,
  operation: 'check' | 'delete',
): TransactItem {
  const expression = [
    'attribute_exists(pk)',
    '#code = :code',
    '#kind = :kind',
    '#userId = :userId',
    'expiresAt = :expiresAt',
    '#ttl = :ttl',
    item.minorId === undefined ? 'attribute_not_exists(#minorId)' : '#minorId = :minorId',
    item.closureMirrorVersion === undefined
      ? 'attribute_not_exists(#closureMirrorVersion)'
      : '#closureMirrorVersion = :closureMirrorVersion',
  ].join(' AND ');
  const common = {
    TableName: deps.table,
    Key: { pk: item.pk, sk: item.sk },
    ConditionExpression: expression,
    ExpressionAttributeNames: {
      '#code': 'code',
      '#kind': 'kind',
      '#userId': 'userId',
      '#ttl': 'ttl',
      '#minorId': 'minorId',
      '#closureMirrorVersion': 'closureMirrorVersion',
    },
    ExpressionAttributeValues: {
      ':code': item.code,
      ':kind': item.kind,
      ':userId': item.userId,
      ':expiresAt': item.expiresAt,
      ':ttl': item.ttl,
      ...(item.minorId === undefined ? {} : { ':minorId': item.minorId }),
      ...(item.closureMirrorVersion === undefined
        ? {}
        : { ':closureMirrorVersion': item.closureMirrorVersion }),
    },
  };
  return operation === 'check' ? { ConditionCheck: common } : { Delete: common };
}

export function exactRequestOperation(
  deps: Deps,
  item: FriendRequestItem,
  operation: 'check' | 'delete',
): TransactItem {
  const common = {
    TableName: deps.table,
    Key: { pk: item.pk, sk: item.sk },
    ConditionExpression:
      'attribute_exists(pk) AND gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk AND requestId = :requestId AND fromId = :fromId AND toId = :toId AND createdAt = :createdAt AND expiresAt = :expiresAt AND #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':requestId': item.requestId,
      ':fromId': item.fromId,
      ':toId': item.toId,
      ':gsi1pk': item.gsi1pk,
      ':gsi1sk': item.gsi1sk,
      ':createdAt': item.createdAt,
      ':expiresAt': item.expiresAt,
      ':ttl': item.ttl,
    },
  };
  return operation === 'check' ? { ConditionCheck: common } : { Delete: common };
}

export function absentConditionCheck(
  deps: Deps,
  key: { pk: string; sk: string },
): TransactItem {
  return {
    ConditionCheck: {
      TableName: deps.table,
      Key: key,
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

export function exactLinkOperation(
  deps: Deps,
  link: LinkItem,
  operation: 'check' | 'delete',
): TransactItem {
  const common = {
    TableName: deps.table,
    Key: { pk: link.pk, sk: link.sk },
    ConditionExpression:
      'attribute_exists(pk) AND gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk AND linkId = :linkId AND #kind = :kind AND guardianId = :guardianId AND minorId = :minorId AND createdAt = :createdAt',
    ExpressionAttributeNames: { '#kind': 'kind' },
    ExpressionAttributeValues: {
      ':gsi1pk': link.gsi1pk,
      ':gsi1sk': link.gsi1sk,
      ':linkId': link.linkId,
      ':kind': link.kind,
      ':guardianId': link.guardianId,
      ':minorId': link.minorId,
      ':createdAt': link.createdAt,
    },
  };
  return operation === 'check' ? { ConditionCheck: common } : { Delete: common };
}

export function sameRequest(a: FriendRequestItem, b: FriendRequestItem): boolean {
  return (
    a.pk === b.pk &&
    a.sk === b.sk &&
    a.gsi1pk === b.gsi1pk &&
    a.gsi1sk === b.gsi1sk &&
    a.requestId === b.requestId &&
    a.fromId === b.fromId &&
    a.toId === b.toId &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt &&
    a.ttl === b.ttl
  );
}

export function sameLink(a: LinkItem, b: LinkItem): boolean {
  return (
    a.pk === b.pk &&
    a.sk === b.sk &&
    a.gsi1pk === b.gsi1pk &&
    a.gsi1sk === b.gsi1sk &&
    a.linkId === b.linkId &&
    a.kind === b.kind &&
    a.guardianId === b.guardianId &&
    a.minorId === b.minorId &&
    a.createdAt === b.createdAt
  );
}

export function sameCode(a: CodeItem, b: CodeItem): boolean {
  return (
    a.pk === b.pk &&
    a.sk === b.sk &&
    a.code === b.code &&
    a.kind === b.kind &&
    a.userId === b.userId &&
    a.minorId === b.minorId &&
    a.closureMirrorVersion === b.closureMirrorVersion &&
    a.expiresAt === b.expiresAt &&
    a.ttl === b.ttl
  );
}

export async function recordBadAttempt(ctx: Ctx): Promise<void> {
  const bucket = Math.floor(ctx.deps.now() / 3_600_000);
  await guardedWrite(ctx, [ctx.callerId], [
    {
      Update: {
        TableName: ctx.deps.table,
        Key: K.rate(ctx.callerId, bucket),
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': Math.ceil(ctx.deps.now() / 1_000) + 7_200,
        },
      },
    },
  ]);
}
