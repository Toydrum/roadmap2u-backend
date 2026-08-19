import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { Context } from 'aws-lambda';
import { Deps, K, ProfileItem, TransactWriteCommand, realDeps } from './db';
import { instrumentHandler } from './observability';

/**
 * Cognito PostConfirmation → the DynamoDB profile item. Self-signup is always
 * an ADULT (minors are born via AdminCreateUser in family.createChild, which
 * writes its own profile). custom:accountType is stamped here — the client
 * never writes it (defense-in-depth; GET /me stays the authz truth).
 */
let deps: Deps | null = null;

type CancellationReason = { Code?: string; Item?: Record<string, unknown> };

function stringAttribute(
  item: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = item?.[name];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'S' in value) {
    const stringValue = (value as { S?: unknown }).S;
    return typeof stringValue === 'string' ? stringValue : undefined;
  }
  return undefined;
}

function isSameSignupCancellation(error: unknown, sub: string, username: string): boolean {
  const cancellation = error as {
    name?: string;
    CancellationReasons?: CancellationReason[];
  };
  if (cancellation?.name !== 'TransactionCanceledException') return false;
  const [profileReason, reservationReason] = cancellation.CancellationReasons ?? [];
  return (
    profileReason?.Code === 'ConditionalCheckFailed' &&
    reservationReason?.Code === 'ConditionalCheckFailed' &&
    stringAttribute(profileReason.Item, 'userId') === sub &&
    stringAttribute(profileReason.Item, 'username') === username &&
    stringAttribute(reservationReason.Item, 'userId') === sub
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

  const profile: ProfileItem = {
    ...K.profile(sub),
    userId: sub,
    username,
    displayName: event.request.userAttributes['name']?.trim() || username,
    accountType: 'adult',
    socialEnabled: true,
    createdAt: d.now(),
    email: event.request.userAttributes['email'],
  };
  try {
    await d.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: d.table,
              Item: profile,
              ConditionExpression: 'attribute_not_exists(pk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
          // Cognito already guarantees login uniqueness; this guards the table
          // against races with admin-created usernames.
          {
            Put: {
              TableName: d.table,
              Item: { ...K.uniqUsername(username), userId: sub },
              ConditionExpression: 'attribute_not_exists(pk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isSameSignupCancellation(error, sub, username)) throw error;
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
