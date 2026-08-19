import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Ctx } from '../lambda/authz';
import {
  Deps,
  FriendItem,
  K,
  LinkItem,
  ProfileItem,
  batchWriteAll,
  queryPrefix,
  queryPrefixPage,
} from '../lambda/db';
import { deleteChild } from '../lambda/handlers/family';

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => 1_800_000_000_000,
  };
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DynamoDB hardening', () => {
  it('queryPrefix consumes every page when a partition exceeds 1 MiB', async () => {
    const payload = 'x'.repeat(350_000);
    const firstPage = [
      { pk: 'USER#owner', sk: 'REC#nodes#a', id: 'a', payload },
      { pk: 'USER#owner', sk: 'REC#nodes#b', id: 'b', payload },
    ];
    const secondPage = [
      { pk: 'USER#owner', sk: 'REC#nodes#c', id: 'c', payload },
      { pk: 'USER#owner', sk: 'REC#nodes#d', id: 'd', payload },
    ];
    const cursor = { pk: 'USER#owner', sk: 'REC#nodes#b' };
    expect(Buffer.byteLength(JSON.stringify([...firstPage, ...secondPage]))).toBeGreaterThan(
      1024 * 1024,
    );
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: firstPage, LastEvaluatedKey: cursor })
      .resolvesOnce({ Items: secondPage });

    const records = await queryPrefix<{ id: string }>(deps(), 'USER#owner', 'REC#nodes#');

    expect(records.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual(cursor);
  });

  it('queryPrefixPage returns one bounded page with its continuation key', async () => {
    const previousCursor = { pk: 'USER#owner', sk: 'REC#nodes#before' };
    const nextCursor = { pk: 'USER#owner', sk: 'REC#nodes#a' };
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'USER#owner', sk: 'REC#nodes#a', id: 'a' }],
      LastEvaluatedKey: nextCursor,
    });

    const page = await queryPrefixPage<{ id: string }>(deps(), 'USER#owner', 'REC#nodes#', {
      limit: 1,
      exclusiveStartKey: previousCursor,
      consistentRead: true,
    });

    expect(page).toEqual({
      items: [{ pk: 'USER#owner', sk: 'REC#nodes#a', id: 'a' }],
      lastEvaluatedKey: nextCursor,
    });
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: previousCursor,
      ConsistentRead: true,
    });
  });

  it('queryPrefixPage rejects consistent reads against a GSI before sending', async () => {
    await expect(
      queryPrefixPage(deps(), 'USER#owner', 'MINOR#', {
        index: 'gsi1',
        consistentRead: true,
      }),
    ).rejects.toThrow('ConsistentRead is not supported for a global secondary index');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('batchWriteAll splits writes into DynamoDB batches of at most 25 operations', async () => {
    const requests = Array.from({ length: 60 }, (_, index) => ({
      DeleteRequest: { Key: { pk: 'USER#owner', sk: `REC#nodes#${index}` } },
    }));
    ddbMock.on(BatchWriteCommand).resolves({});

    await batchWriteAll(deps(), requests);

    const batchSizes = ddbMock
      .commandCalls(BatchWriteCommand)
      .map(({ args }) => args[0].input.RequestItems?.['roadmap']?.length);
    expect(batchSizes).toEqual([25, 25, 10]);
  });

  it('batchWriteAll retries only the operations DynamoDB leaves unprocessed', async () => {
    const requests = Array.from({ length: 3 }, (_, index) => ({
      DeleteRequest: { Key: { pk: 'USER#owner', sk: `REC#nodes#${index}` } },
    }));
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { roadmap: [requests[1]!] } })
      .resolvesOnce({});

    await batchWriteAll(deps(), requests);

    const sent = ddbMock
      .commandCalls(BatchWriteCommand)
      .map(({ args }) => args[0].input.RequestItems?.['roadmap']);
    expect(sent).toEqual([requests, [requests[1]]]);
  });

  it('batchWriteAll waits with exponential full jitter between retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const request = {
      DeleteRequest: { Key: { pk: 'USER#owner', sk: 'REC#nodes#1' } },
    };
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { roadmap: [request] } })
      .resolvesOnce({ UnprocessedItems: { roadmap: [request] } })
      .resolvesOnce({});

    const write = batchWriteAll(deps(), [request]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(11);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(24);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(write).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(3);
  });

  it('batchWriteAll fails explicitly after eight attempts leave operations unprocessed', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const request = {
      DeleteRequest: { Key: { pk: 'USER#owner', sk: 'REC#nodes#1' } },
    };
    let sends = 0;
    ddbMock.on(BatchWriteCommand).callsFake(async () => {
      sends += 1;
      if (sends > 8) throw new Error('a ninth BatchWrite must never be sent');
      return { UnprocessedItems: { roadmap: [request] } };
    });

    const write = batchWriteAll(deps(), [request]);
    const outcome = write.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();

    const { error } = await outcome;
    expect(error).toMatchObject({
      name: 'BatchWriteUnprocessedItemsError',
      attempts: 8,
      remainingCount: 1,
    });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(8);
  });

  it('deleteChild retries an unprocessed deletion before reporting success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const guardian: ProfileItem = {
      ...K.profile('guardian'),
      userId: 'guardian',
      username: 'guardian',
      displayName: 'Guardian',
      accountType: 'adult',
      socialEnabled: true,
      createdAt: 1,
    };
    const child: ProfileItem = {
      ...K.profile('child'),
      userId: 'child',
      username: 'child-name',
      displayName: 'Child',
      accountType: 'minor',
      socialEnabled: false,
      createdAt: 2,
    };
    const guardianLink: LinkItem = {
      ...K.link('child', 'guardian'),
      gsi1pk: K.user('guardian'),
      gsi1sk: 'MINOR#child',
      linkId: 'guardian~child',
      kind: 'created',
      guardianId: 'guardian',
      minorId: 'child',
      createdAt: 3,
    };
    const friendEdge: FriendItem = {
      ...K.friend('child', 'friend'),
      friendshipId: 'child~friend',
      userA: 'child',
      userB: 'friend',
      createdAt: 4,
    };
    const pendingDelete = { DeleteRequest: { Key: K.friend('friend', 'child') } };
    const context: Ctx = { callerId: 'guardian', caller: guardian, deps: deps() };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === guardianLink.pk && key.sk === guardianLink.sk) return { Item: guardianLink };
      if (key.pk === child.pk && key.sk === child.sk) return { Item: child };
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string>;
      if (values[':prefix'] === 'FRIEND#') return { Items: [friendEdge] };
      return { Items: [{ pk: child.pk, sk: child.sk }] };
    });
    cognitoMock.on(AdminDeleteUserCommand).resolves({});
    ddbMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { roadmap: [pendingDelete] } })
      .resolvesOnce({});

    const deletion = deleteChild(context, 'child');
    await vi.runAllTimersAsync();

    await expect(deletion).resolves.toBeUndefined();
    const batches = ddbMock
      .commandCalls(BatchWriteCommand)
      .map(({ args }) => args[0].input.RequestItems?.['roadmap']);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([pendingDelete]);
  });
});
