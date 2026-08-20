import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
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
  /** Missing on legacy profiles and therefore treated exactly like `active`. */
  status?: 'active' | 'closing';
  email?: string;
  /** Current friend code (CODE#F item is the authority; this is the pointer). */
  friendCode?: string;
  /** Short-lived lease for Cognito mutations that must serialize with closure. */
  identityLeaseOwner?: string;
  identityLeaseUntil?: number;
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
  /** New family invites have discoverable closure mirrors; legacy codes omit it. */
  closureMirrorVersion?: 1;
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

export type DynamoKey = Record<string, unknown>;

export interface QueryPrefixPageOptions {
  index?: 'gsi1' | 'gsi2';
  limit?: number;
  exclusiveStartKey?: DynamoKey;
  consistentRead?: boolean;
}

export interface QueryPage<T> {
  items: T[];
  lastEvaluatedKey?: DynamoKey;
}

export async function queryPrefixPage<T>(
  deps: Deps,
  pk: string,
  skPrefix: string,
  opts?: QueryPrefixPageOptions,
): Promise<QueryPage<T>> {
  if (opts?.index && opts.consistentRead) {
    throw new Error('ConsistentRead is not supported for a global secondary index');
  }
  const pkName = opts?.index ? `${opts.index}pk` : 'pk';
  const skName = opts?.index ? `${opts.index}sk` : 'sk';
  const skUsed = Boolean(skPrefix);
  const out = await deps.ddb.send(
    new QueryCommand({
      TableName: deps.table,
      IndexName: opts?.index,
      KeyConditionExpression: skPrefix ? '#pk = :pk AND begins_with(#sk, :prefix)' : '#pk = :pk',
      ExpressionAttributeNames: skUsed ? { '#pk': pkName, '#sk': skName } : { '#pk': pkName },
      ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':prefix': skPrefix } : { ':pk': pk },
      Limit: opts?.limit,
      ExclusiveStartKey: opts?.exclusiveStartKey,
      ConsistentRead: opts?.consistentRead,
    }),
  );
  return {
    items: (out.Items ?? []) as T[],
    lastEvaluatedKey: out.LastEvaluatedKey,
  };
}

export async function queryPrefix<T>(
  deps: Deps,
  pk: string,
  skPrefix: string,
  opts?: Pick<QueryPrefixPageOptions, 'index'>,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: DynamoKey | undefined;
  do {
    const page = await queryPrefixPage<T>(deps, pk, skPrefix, {
      index: opts?.index,
      exclusiveStartKey,
    });
    items.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export type BatchWriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

const BATCH_WRITE_MAX_ATTEMPTS = 8;
const BATCH_WRITE_BASE_DELAY_MS = 25;
const BATCH_WRITE_MAX_DELAY_MS = 1000;

export class BatchWriteUnprocessedItemsError extends Error {
  readonly attempts: number;
  readonly remainingCount: number;

  constructor(attempts: number, remainingCount: number) {
    super(`DynamoDB left ${remainingCount} unprocessed item(s) after ${attempts} attempts`);
    this.name = 'BatchWriteUnprocessedItemsError';
    this.attempts = attempts;
    this.remainingCount = remainingCount;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function batchWriteAll(deps: Deps, requests: BatchWriteRequest[]): Promise<void> {
  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25);
    let attempts = 0;
    while (pending.length) {
      attempts += 1;
      const out = await deps.ddb.send(
        new BatchWriteCommand({
          RequestItems: { [deps.table]: pending },
        }),
      );
      pending = out.UnprocessedItems?.[deps.table] ?? [];
      if (pending.length) {
        if (attempts >= BATCH_WRITE_MAX_ATTEMPTS) {
          throw new BatchWriteUnprocessedItemsError(attempts, pending.length);
        }
        const ceiling = Math.min(
          BATCH_WRITE_MAX_DELAY_MS,
          BATCH_WRITE_BASE_DELAY_MS * 2 ** (attempts - 1),
        );
        await wait(Math.floor(Math.random() * ceiling));
      }
    }
  }
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
