import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Deps } from '../lambda/db';
import { K } from '../lambda/db';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { accessKey } from '../lambda/commercial/model';
import { accountClosureKey } from '../lambda/account-closure';
import { handleEvent as handlePostConfirmation } from '../lambda/post-confirmation';

const NOW = 1_800_000_000_000;
const FIRST_PROVISIONED_AT = NOW - 5_000;
const SUB = 'sub-rocio';
const USERNAME = 'rocio';
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
}

const event = {
  triggerSource: 'PostConfirmation_ConfirmSignUp',
  userName: 'Rocio',
  userPoolId: 'pool-1',
  request: {
    userAttributes: { sub: SUB, name: 'Rocío', email: 'r@example.com' },
  },
} as unknown as Parameters<typeof handlePostConfirmation>[0];

function canonicalProfile(createdAt: number) {
  return {
    ...K.profile(SUB),
    userId: SUB,
    username: USERNAME,
    displayName: 'Rocío',
    accountType: 'adult',
    socialEnabled: true,
    createdAt,
    status: 'active',
    familyFenceVersion: 1,
    email: 'r@example.com',
  };
}

function completeCancellation(overrides?: {
  profile?: Record<string, unknown>;
  username?: Record<string, unknown>;
  access?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}) {
  return Object.assign(new Error('commercial signup state already exists'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      {
        Code: 'ConditionalCheckFailed',
        Item: overrides?.profile ?? canonicalProfile(FIRST_PROVISIONED_AT),
      },
      {
        Code: 'ConditionalCheckFailed',
        Item: overrides?.username ?? { ...K.uniqUsername(USERNAME), userId: SUB },
      },
      {
        Code: 'ConditionalCheckFailed',
        Item: overrides?.access ?? deriveAccessItem(SUB, FIRST_PROVISIONED_AT, undefined, []),
      },
      {
        Code: 'ConditionalCheckFailed',
        Item: overrides?.usage ?? {
          pk: K.user(SUB),
          sk: 'USAGE',
          state: 'active',
          activeTrees: 0,
        },
      },
      { Code: 'None' },
    ],
  });
}

function rawAttribute(value: unknown): Record<string, unknown> {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(rawAttribute) };
  if (typeof value === 'object' && value !== null) return { M: rawItem(value) };
  throw new Error(`unsupported raw attribute: ${String(value)}`);
}

function rawItem(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([name, nested]) => [name, rawAttribute(nested)]),
  );
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('post-confirmation commercial state', () => {
  it('creates PROFILE, username, canonical Free ACCESS and zero USAGE atomically before Cognito', async () => {
    const order: string[] = [];
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      order.push('dynamodb');
      return {};
    });
    cognitoMock.on(AdminUpdateUserAttributesCommand).callsFake(() => {
      order.push('cognito');
      return {};
    });

    await expect(handlePostConfirmation(event, deps())).resolves.toBe(event);

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const puts = (transaction.TransactItems ?? []).flatMap((item) =>
      item.Put ? [item.Put] : [],
    );
    expect(puts).toHaveLength(4);
    expect(puts.map((put) => put.Item)).toEqual([
      {
        ...K.profile(SUB),
        userId: SUB,
        username: USERNAME,
        displayName: 'Rocío',
        accountType: 'adult',
        socialEnabled: true,
        createdAt: NOW,
        status: 'active',
        familyFenceVersion: 1,
        email: 'r@example.com',
      },
      { ...K.uniqUsername(USERNAME), userId: SUB },
      deriveAccessItem(SUB, NOW, undefined, []),
      { pk: K.user(SUB), sk: 'USAGE', state: 'active', activeTrees: 0 },
    ]);
    expect(puts.map((put) => put.Item?.['sk'])).toEqual([
      'PROFILE',
      'UNIQ',
      accessKey(SUB).sk,
      'USAGE',
    ]);
    expect(
      puts.every(
        (put) =>
          put.ConditionExpression === 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      ),
    ).toBe(true);
    expect(
      puts.every((put) => put.ReturnValuesOnConditionCheckFailure === 'ALL_OLD'),
    ).toBe(true);
    expect(transaction.TransactItems?.at(-1)?.ConditionCheck).toMatchObject({
      Key: accountClosureKey(SUB),
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(order).toEqual(['dynamodb', 'cognito']);
  });

  it('accepts a retry only when every pre-existing signup item is the same canonical state', async () => {
    ddbMock.on(TransactWriteCommand).rejects(completeCancellation());
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    await expect(handlePostConfirmation(event, deps())).resolves.toBe(event);

    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });

  it('accepts the same complete retry when DynamoDB exposes raw AttributeValue items', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      completeCancellation({
        profile: rawItem(canonicalProfile(FIRST_PROVISIONED_AT)),
        username: rawItem({ ...K.uniqUsername(USERNAME), userId: SUB }),
        access: rawItem(deriveAccessItem(SUB, FIRST_PROVISIONED_AT, undefined, [])),
        usage: rawItem({ pk: K.user(SUB), sk: 'USAGE', state: 'active', activeTrees: 0 }),
      }),
    );
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    await expect(handlePostConfirmation(event, deps())).resolves.toBe(event);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });

  it('keeps an omitted email canonical across creation and an idempotent retry', async () => {
    const withoutEmail = {
      ...event,
      request: { userAttributes: { sub: SUB, name: 'Rocío' } },
    } as Parameters<typeof handlePostConfirmation>[0];
    const profileWithoutEmail = canonicalProfile(FIRST_PROVISIONED_AT);
    delete (profileWithoutEmail as { email?: string }).email;
    ddbMock
      .on(TransactWriteCommand)
      .rejects(completeCancellation({ profile: profileWithoutEmail }));
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    await expect(handlePostConfirmation(withoutEmail, deps())).resolves.toBe(withoutEmail);

    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(1);
  });

  it.each([
    [
      'partial state',
      () => {
        const error = completeCancellation();
        error.CancellationReasons[3] = { Code: 'None' };
        return error;
      },
    ],
    [
      'another username owner',
      () => completeCancellation({ username: { ...K.uniqUsername(USERNAME), userId: 'other' } }),
    ],
    [
      'legacy profile without active status',
      () => {
        const { status: _status, ...legacy } = canonicalProfile(FIRST_PROVISIONED_AT);
        return completeCancellation({ profile: legacy });
      },
    ],
    [
      'non-Free ACCESS revision',
      () =>
        completeCancellation({
          access: {
            ...deriveAccessItem(SUB, FIRST_PROVISIONED_AT, undefined, []),
            revision: 2,
          },
        }),
    ],
    [
      'nonzero USAGE',
      () =>
        completeCancellation({
          usage: { pk: K.user(SUB), sk: 'USAGE', state: 'active', activeTrees: 1 },
        }),
    ],
  ])('rejects %s and never stamps Cognito', async (_label, cancellation) => {
    const error = cancellation();
    ddbMock.on(TransactWriteCommand).rejects(error);

    await expect(handlePostConfirmation(event, deps())).rejects.toBe(error);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });
});
