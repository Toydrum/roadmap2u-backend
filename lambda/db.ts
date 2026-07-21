import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { AccountType, GuardianLinkKind, SyncRecord, SyncStore } from '@app/api/contracts';

/**
 * Single-table access layer for `roadmap` — key builders + item shapes per
 * docs/backend-contract.md §6. Handlers receive everything through `Deps` so
 * tests can inject mocked clients and a frozen clock.
 */

export interface Deps {
  ddb: DynamoDBDocumentClient;
  cognito: CognitoIdentityProviderClient;
  table: string;
  userPoolId: string;
  now(): number;
}

export function realDeps(): Deps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    ddb,
    cognito: new CognitoIdentityProviderClient({}),
    table: process.env['TABLE_NAME'] ?? 'roadmap',
    userPoolId: process.env['USER_POOL_ID'] ?? '',
    now: () => Date.now(),
  };
}

// ── Item shapes ─────────────────────────────────────────────────────────────

export interface ProfileItem {
  pk: string;
  sk: 'PROFILE';
  userId: string;
  username: string;
  displayName: string;
  accountType: AccountType;
  socialEnabled: boolean;
  createdAt: number;
  email?: string;
  /** Current friend code (CODE#F item is the authority; this is the pointer). */
  friendCode?: string;
}

export interface LinkItem {
  pk: string; // USER#<minorId>
  sk: string; // GUARDIAN#<guardianId>
  gsi1pk: string; // USER#<guardianId>
  gsi1sk: string; // MINOR#<minorId>
  linkId: string;
  kind: GuardianLinkKind;
  guardianId: string;
  minorId: string;
  createdAt: number;
}

export interface FriendItem {
  pk: string; // USER#<me>
  sk: string; // FRIEND#<other>
  friendshipId: string;
  userA: string;
  userB: string;
  createdAt: number;
}

export interface FriendRequestItem {
  pk: string; // USER#<toId>
  sk: string; // FREQ#<requestId>
  gsi1pk: string; // USER#<fromId>
  gsi1sk: string; // FREQ#<requestId>
  requestId: string;
  fromId: string;
  toId: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
}

export interface CodeItem {
  pk: string; // CODE#F#<code> | CODE#G#<code>
  sk: 'CODE';
  code: string;
  kind: 'friend' | 'coGuardian' | 'linkExisting';
  userId: string;
  minorId?: string;
  expiresAt: number;
  ttl: number;
}

export interface RecordItem {
  pk: string; // USER#<owner>
  sk: string; // REC#<store>#<id>
  gsi2pk: string; // USER#<owner>
  gsi2sk: string; // CHG#<paddedSyncedAt>#<id>
  owner: string;
  store: SyncStore;
  record: SyncRecord['record'];
  rev: number;
  /** Mirrors record.updatedAt — the LWW tiebreak lives in the condition
   *  expression, and DynamoDB can only compare top-level attributes. */
  updatedAt: number;
  syncedAt: number;
}

export interface RateItem {
  pk: string;
  sk: string;
  count: number;
  ttl: number;
}

// ── Key builders ────────────────────────────────────────────────────────────

export const K = {
  user: (id: string) => `USER#${id}`,
  profile: (id: string) => ({ pk: `USER#${id}`, sk: 'PROFILE' as const }),
  uniqUsername: (username: string) => ({ pk: `UNIQ#USERNAME#${username.toLowerCase()}`, sk: 'UNIQ' }),
  link: (minorId: string, guardianId: string) => ({
    pk: `USER#${minorId}`,
    sk: `GUARDIAN#${guardianId}`,
  }),
  friend: (me: string, other: string) => ({ pk: `USER#${me}`, sk: `FRIEND#${other}` }),
  freq: (toId: string, requestId: string) => ({ pk: `USER#${toId}`, sk: `FREQ#${requestId}` }),
  codeF: (code: string) => ({ pk: `CODE#F#${code}`, sk: 'CODE' as const }),
  codeG: (code: string) => ({ pk: `CODE#G#${code}`, sk: 'CODE' as const }),
  rec: (owner: string, store: SyncStore, id: string) => ({
    pk: `USER#${owner}`,
    sk: `REC#${store}#${id}`,
  }),
  chg: (syncedAt: number, id: string) => `CHG#${String(syncedAt).padStart(14, '0')}#${id}`,
  rate: (userId: string, bucket: number) => ({ pk: `USER#${userId}`, sk: `RATE#codes#${bucket}` }),
};

/** Opaque-to-the-client composite ids — parseable server-side for addressing. */
export const composite = {
  linkId: (guardianId: string, minorId: string) => `${guardianId}~${minorId}`,
  parseLinkId: (linkId: string): { guardianId: string; minorId: string } | null => {
    const [guardianId, minorId] = linkId.split('~');
    return guardianId && minorId ? { guardianId, minorId } : null;
  },
  friendshipId: (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`),
  parseFriendshipId: (id: string): { a: string; b: string } | null => {
    const [a, b] = id.split('~');
    return a && b ? { a, b } : null;
  },
};

// ── Small operation helpers (thin — handlers own the logic) ─────────────────

export async function getItem<T>(deps: Deps, key: { pk: string; sk: string }): Promise<T | null> {
  const out = await deps.ddb.send(new GetCommand({ TableName: deps.table, Key: key }));
  return (out.Item as T | undefined) ?? null;
}

export async function putItem(deps: Deps, item: Record<string, unknown>): Promise<void> {
  await deps.ddb.send(new PutCommand({ TableName: deps.table, Item: item }));
}

export async function deleteItem(deps: Deps, key: { pk: string; sk: string }): Promise<void> {
  await deps.ddb.send(new DeleteCommand({ TableName: deps.table, Key: key }));
}

export async function queryPrefix<T>(
  deps: Deps,
  pk: string,
  skPrefix: string,
  opts?: { index?: 'gsi1' | 'gsi2'; limit?: number; after?: string },
): Promise<T[]> {
  const pkName = opts?.index ? `${opts.index}pk` : 'pk';
  const skName = opts?.index ? `${opts.index}sk` : 'sk';
  // '' = whole partition (deleteChild's purge). REAL DynamoDB rejects an
  // empty string inside begins_with (0.0.115 S2) — the in-memory double
  // accepted it, so the bug only fired in the cloud: pk-only query instead.
  const condition = opts?.after
    ? `#pk = :pk AND #sk > :after`
    : skPrefix
      ? `#pk = :pk AND begins_with(#sk, :prefix)`
      : `#pk = :pk`;
  const skUsed = Boolean(opts?.after) || Boolean(skPrefix);
  const out = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      IndexName: opts?.index,
      KeyConditionExpression: condition,
      ExpressionAttributeNames: skUsed ? { '#pk': pkName, '#sk': skName } : { '#pk': pkName },
      ExpressionAttributeValues: opts?.after
        ? { ':pk': pk, ':after': opts.after }
        : skPrefix
          ? { ':pk': pk, ':prefix': skPrefix }
          : { ':pk': pk },
      Limit: opts?.limit,
    }),
  );
  return (out.Items ?? []) as T[];
}

/** Code-guessing brake, shared by EVERY code redemption (friend requests +
 *  family invites — 0.0.115 S1 closed the family gap): 5 bad redemptions per
 *  rolling hour → RATE_LIMITED. Read-first, bump-on-failure — successful
 *  redemptions never count. One shared bucket per user: a guesser can't get
 *  5 friend guesses AND 5 family guesses. */
export async function readRateCount(deps: Deps, userId: string): Promise<number> {
  const bucket = Math.floor(deps.now() / 3_600_000);
  const item = await getItem<RateItem>(deps, K.rate(userId, bucket));
  return item?.count ?? 0;
}

export async function bumpBadAttempt(deps: Deps, userId: string): Promise<void> {
  const bucket = Math.floor(deps.now() / 3_600_000);
  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: K.rate(userId, bucket),
      UpdateExpression: 'ADD #c :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': Math.ceil(deps.now() / 1000) + 7200 },
    }),
  );
}

export { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand };
