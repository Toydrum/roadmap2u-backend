import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { K, type ProfileItem } from '../lambda/db';
import { getForest } from '../lambda/handlers/forests';
import { requirePrimaryMinorAuthority } from '../lambda/family/minor-authority';
import { guardedWrite } from '../lambda/handlers/guarded-mutation';
import { getHousehold } from '../lambda/handlers/household';
import { getAdultFriendCode } from '../lambda/handlers/social';
import { getFriends } from '../lambda/handlers/friends';

const ddb = mockClient(DynamoDBDocumentClient);
const rows = new Map<string, any>();
const profile = (id: string, privateOnly = false): ProfileItem => ({
  ...K.profile(id),
  userId: id,
  username: id,
  displayName: id,
  accountType: 'adult',
  socialEnabled: true,
  createdAt: 1,
  ...(privateOnly ? { privacyMode: 'adolescent_private' as const } : {}),
});
const context = (id: string) => ({
  callerId: id,
  caller: rows.get(`USER#${id}/PROFILE`) as ProfileItem,
  deps: {
    table: 'main',
    userPoolId: 'pool',
    now: () => 1_800_000_000_000,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
  },
});
beforeEach(() => {
  ddb.reset();
  rows.clear();
  for (const [id, privateOnly] of [
    ['parent', false],
    ['private', true],
  ] as const) {
    const p = profile(id, privateOnly);
    rows.set(`${p.pk}/${p.sk}`, p);
  }
  // Even restored socialEnabled=true / legacy friendship and created links cannot grant access.
  rows.set('USER#private/FRIEND#parent', {
    ...K.friend('private', 'parent'),
    userA: 'parent',
    userB: 'private',
  });
  rows.set('USER#private/GUARDIAN#parent', {
    ...K.link('private', 'parent'),
    guardianId: 'parent',
    minorId: 'private',
    kind: 'created',
  });
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(`${input.Key.pk}/${input.Key.sk}`) }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const item of input.TransactItems ?? []) {
      const operation = item.ConditionCheck ?? item.Update;
      if (
        operation?.ConditionExpression?.includes('attribute_not_exists(privacyMode)') &&
        rows.get(`${operation.Key.pk}/${operation.Key.sk}`)?.privacyMode
      ) {
        throw Object.assign(new Error('private account changed during operation'), {
          name: 'TransactionCanceledException',
        });
      }
    }
    for (const item of input.TransactItems ?? [])
      if (item.Put) rows.set(`${item.Put.Item.pk}/${item.Put.Item.sk}`, item.Put.Item);
    return {};
  });
});
describe('private accounts remain isolated after adulthood and restored relations', () => {
  it.each([
    ['private', 'parent'],
    ['parent', 'private'],
  ])('denies foreign forest %s -> %s before reading its content', async (caller, target) => {
    await expect(getForest(context(caller), target)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('does not let a representative export or administer private content through a legacy created link', async () => {
    await expect(
      requirePrimaryMinorAuthority(
        context('parent').deps,
        profile('parent'),
        'private',
        'export_minor',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects direct social and household reads even if a restored profile says social is enabled', async () => {
    await expect(getAdultFriendCode(context('private'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(getHousehold(context('private'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getFriends(context('private'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('omits private identities from legacy friends and both request lists', async () => {
    ddb
      .on(QueryCommand)
      .callsFake((input) => ({
        Items:
          input.ExpressionAttributeValues?.[':prefix'] === 'FRIEND#'
            ? [{ friendshipId: 'old-friend', userA: 'parent', userB: 'private' }]
            : [
                {
                  requestId: 'old-request',
                  fromId: 'private',
                  toId: 'private',
                  expiresAt: context('parent').deps.now() + 1000,
                },
              ],
      }));
    expect(await getFriends(context('parent'))).toEqual({
      friends: [],
      incoming: [],
      outgoing: [],
    });
  });
  it('fences a concurrent change to private mode in social/family writes', async () => {
    const ctx = context('parent');
    rows.set('USER#parent/PROFILE', profile('parent', true));
    await expect(
      guardedWrite(
        ctx,
        ['parent'],
        [{ Put: { TableName: 'main', Item: { pk: 'USER#parent', sk: 'FRIEND#new' } } }],
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rows.has('USER#parent/FRIEND#new')).toBe(false);
  });
});
