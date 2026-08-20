import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { isDeepStrictEqual } from 'node:util';
import { AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { Context } from 'aws-lambda';
import { Deps, K, ProfileItem, TransactWriteCommand, realDeps } from './db';
import { instrumentHandler } from './observability';
import { accountClosureKey } from './account-closure';
import { deriveAccessItem } from './commercial/access-resolver';

/**
 * Cognito PostConfirmation → the DynamoDB profile item. Self-signup is always
 * an ADULT (minors are born via AdminCreateUser in family.createChild, which
 * writes its own profile). custom:accountType is stamped here — the client
 * never writes it (defense-in-depth; GET /me stays the authz truth).
 */
let deps: Deps | null = null;

type CancellationReason = { Code?: string; Item?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CancellationReason.Item may be returned in either DocumentClient or raw AV form. */
function decodeAttribute(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeAttribute);
  if (!isRecord(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const tag = keys[0];
    const encoded = value[tag];
    if (tag === 'S' && typeof encoded === 'string') return encoded;
    if (tag === 'N' && typeof encoded === 'string') return Number(encoded);
    if (tag === 'BOOL' && typeof encoded === 'boolean') return encoded;
    if (tag === 'NULL' && encoded === true) return null;
    if (tag === 'L' && Array.isArray(encoded)) return encoded.map(decodeAttribute);
    if (tag === 'M' && isRecord(encoded)) return decodeItem(encoded);
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, nested]) => [name, decodeAttribute(nested)]),
  );
}

function decodeItem(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item) return undefined;
  return Object.fromEntries(
    Object.entries(item).map(([name, value]) => [name, decodeAttribute(value)]),
  );
}

function isSameSignupCancellation(
  error: unknown,
  expectedProfile: ProfileItem,
  username: string,
): boolean {
  const cancellation = error as {
    name?: string;
    CancellationReasons?: CancellationReason[];
  };
  if (cancellation?.name !== 'TransactionCanceledException') return false;
  const reasons = cancellation.CancellationReasons ?? [];
  if (reasons.length !== 5) return false;
  const [profileReason, reservationReason, accessReason, usageReason, closureReason] = reasons;
  if (
    profileReason?.Code !== 'ConditionalCheckFailed' ||
    reservationReason?.Code !== 'ConditionalCheckFailed' ||
    accessReason?.Code !== 'ConditionalCheckFailed' ||
    usageReason?.Code !== 'ConditionalCheckFailed' ||
    closureReason?.Code !== 'None' ||
    closureReason.Item !== undefined
  ) {
    return false;
  }

  const profile = decodeItem(profileReason.Item);
  const createdAt = profile?.['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    return false;
  }
  const sub = expectedProfile.userId;
  return (
    isDeepStrictEqual(profile, { ...expectedProfile, createdAt }) &&
    isDeepStrictEqual(decodeItem(reservationReason.Item), {
      ...K.uniqUsername(username),
      userId: sub,
    }) &&
    isDeepStrictEqual(
      decodeItem(accessReason.Item),
      deriveAccessItem(sub, createdAt, undefined, []),
    ) &&
    isDeepStrictEqual(decodeItem(usageReason.Item), {
      pk: K.user(sub),
      sk: 'USAGE',
      state: 'active',
      activeTrees: 0,
    })
  );
}

export async function handleEvent(
  event: PostConfirmationTriggerEvent,
  injected?: Deps,
): Promise<PostConfirmationTriggerEvent> {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;
  const d = injected ?? (deps ??= realDeps());
  const sub = event.request.userAttributes['sub'];
  const username = event.userName.toLowerCase();
  const createdAt = d.now();

  const email = event.request.userAttributes['email'];
  const profile: ProfileItem = {
    ...K.profile(sub),
    userId: sub,
    username,
    displayName: event.request.userAttributes['name']?.trim() || username,
    accountType: 'adult',
    socialEnabled: true,
    createdAt,
    status: 'active',
    familyFenceVersion: 1,
    ...(email ? { email } : {}),
  };
  try {
    await d.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: d.table,
              Item: profile,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          // Cognito already guarantees login uniqueness; this guards the table
          // against races with admin-created usernames.
          {
            Put: {
              TableName: d.table,
              Item: { ...K.uniqUsername(username), userId: sub },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          {
            Put: {
              TableName: d.table,
              Item: deriveAccessItem(sub, createdAt, undefined, []),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          {
            Put: {
              TableName: d.table,
              Item: { pk: K.user(sub), sk: 'USAGE', state: 'active', activeTrees: 0 },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          {
            ConditionCheck: {
              TableName: d.table,
              Key: accountClosureKey(sub),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isSameSignupCancellation(error, profile, username)) throw error;
  }
  await d.cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      UserAttributes: [{ Name: 'custom:accountType', Value: 'adult' }],
    }),
  );
  return event;
}

export const handler = instrumentHandler(
  'post-confirmation',
  (event: PostConfirmationTriggerEvent, _context?: Context) => handleEvent(event),
);
