import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { newSyncBase, type Tree } from '@app/db/schema';
import type { Ctx } from '../lambda/authz';
import { accountClosureKey } from '../lambda/account-closure';
import type { Deps, LinkItem, ProfileItem, RecordItem } from '../lambda/db';
import { K } from '../lambda/db';
import { patchMe } from '../lambda/handlers/me';
import { pushSync, pushSyncFor } from '../lambda/handlers/sync';
import { handleEvent as handlePostConfirmation } from '../lambda/post-confirmation';

const NOW = 1_800_000_000_000;
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

function profile(userId: string, over: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId,
    displayName: userId,
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 1_000,
    ...over,
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function tree(id: string, rev = 1): Tree {
  return {
    ...newSyncBase(NOW - 100),
    id,
    rev,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
  };
}

function recordItem(owner: string, record: Tree): RecordItem {
  return {
    ...K.rec(owner, 'trees', record.id),
    gsi2pk: K.user(owner),
    gsi2sk: K.chg(NOW - 100, record.id),
    owner,
    store: 'trees',
    record,
    rev: record.rev,
    updatedAt: record.updatedAt,
    syncedAt: NOW - 100,
  };
}

function guardianLink(guardianId: string, minorId: string): LinkItem {
  return {
    ...K.link(minorId, guardianId),
    gsi1pk: K.user(guardianId),
    gsi1sk: `MINOR#${minorId}`,
    linkId: `${guardianId}~${minorId}`,
    kind: 'created',
    guardianId,
    minorId,
    createdAt: NOW - 500,
  };
}

function transactionCanceled(codes: string[]): Error & { CancellationReasons: Array<{ Code: string }> } {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function conditionChecks(transaction: ConstructorParameters<typeof TransactWriteCommand>[0]) {
  return (transaction.TransactItems ?? []).flatMap((item) =>
    item.ConditionCheck ? [item.ConditionCheck] : [],
  );
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('post-confirmation closure guard', () => {
  const event = {
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    userName: 'Rocio',
    userPoolId: 'pool-1',
    request: {
      userAttributes: { sub: 'sub-rocio', name: 'Rocio', email: 'r@example.com' },
    },
  } as unknown as Parameters<typeof handlePostConfirmation>[0];

  it('creates active profiles only when no closure tombstone exists', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});

    await handlePostConfirmation(event, deps());

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(transaction.TransactItems?.[0]?.Put?.Item).toMatchObject({
      ...K.profile('sub-rocio'),
      status: 'active',
      familyFenceVersion: 1,
    });
    expect(transaction.TransactItems?.[0]?.Put?.Item).not.toHaveProperty('createdMinorIds');
    expect(conditionChecks(transaction)).toContainEqual(
      expect.objectContaining({
        Key: accountClosureKey('sub-rocio'),
        ConditionExpression: expect.stringContaining('attribute_not_exists'),
      }),
    );
  });

  it('does not treat an idempotent-looking signup as successful when the closure guard lost', async () => {
    const racedClosure = Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        {
          Code: 'ConditionalCheckFailed',
          Item: { userId: { S: 'sub-rocio' }, username: { S: 'rocio' } },
        },
        { Code: 'ConditionalCheckFailed', Item: { userId: { S: 'sub-rocio' } } },
        { Code: 'ConditionalCheckFailed' },
      ],
    });
    ddbMock.on(TransactWriteCommand).rejects(racedClosure);

    await expect(handlePostConfirmation(event, deps())).rejects.toBe(racedClosure);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });
});

describe('patchMe closure serialization', () => {
  it('accepts a legacy profile without status through an atomic update plus closure guard', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(patchMe(ctxOf(profile('rocio')), { displayName: 'Rocío' })).resolves.toMatchObject({
      displayName: 'Rocío',
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const profileUpdate = transaction.TransactItems?.find((item) => item.Update)?.Update;
    expect(profileUpdate).toMatchObject({ Key: K.profile('rocio') });
    expect(profileUpdate?.ConditionExpression).toContain('attribute_not_exists(#status)');
    expect(profileUpdate?.ConditionExpression).toContain('#status = :active');
    expect(profileUpdate?.ExpressionAttributeValues).toMatchObject({ ':active': 'active' });
    expect(conditionChecks(transaction)).toContainEqual(
      expect.objectContaining({ Key: accountClosureKey('rocio') }),
    );
  });

  it('returns CONFLICT when closure wins the race immediately before the write', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCanceled(['ConditionalCheckFailed', 'ConditionalCheckFailed']));
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: { ...profile('rocio'), status: 'closing' } };
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      return {};
    });

    await expect(patchMe(ctxOf(profile('rocio')), { displayName: 'Rocío' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.ConsistentRead === true),
    ).toBe(true);
  });
});

describe('sync closure serialization', () => {
  it('puts a self record and both writable-owner guards in one transaction', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    const incoming = tree('self-tree');

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: incoming }],
      }),
    ).resolves.toMatchObject({ applied: ['self-tree'] });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    const put = transaction.TransactItems?.find((item) => item.Put)?.Put;
    expect(put?.Item).toMatchObject({ ...K.rec('rocio', 'trees', 'self-tree'), owner: 'rocio' });
    expect(put?.ConditionExpression).toContain('rev < :rev');
    expect(conditionChecks(transaction).map((guard) => guard.Key)).toEqual([
      K.profile('rocio'),
      accountClosureKey('rocio'),
    ]);
  });

  it('returns CONFLICT instead of STALE_REV when closure wins the self-write race', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed']));
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile('rocio', { status: 'active' }) };
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      return {};
    });

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: tree('raced-tree') }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('still detects closure from consistent reads when cancellation reasons are absent', async () => {
    const cancelled = Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
    });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile('rocio', { status: 'closing' }) };
      if (key.pk === accountClosureKey('rocio').pk) {
        return { Item: { ...accountClosureKey('rocio'), state: 'requested' } };
      }
      return {};
    });

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: tree('unknown-reasons') }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('classifies a genuine LWW loss as STALE_REV after consistent guard reads', async () => {
    const incoming = tree('stale-tree', 1);
    const winner = recordItem('rocio', { ...incoming, rev: 5, updatedAt: incoming.updatedAt + 10 });
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None']));
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile('rocio', { status: 'active' }) };
      if (key.pk === accountClosureKey('rocio').pk) return {};
      if (key.pk === winner.pk && key.sk === winner.sk) return { Item: winner };
      return {};
    });

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: incoming }],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [{ id: 'stale-tree', reason: 'STALE_REV' }],
      serverRecords: [{ store: 'trees', record: winner.record }],
    });
    const consistentReads = ddbMock
      .commandCalls(GetCommand)
      .filter((call) => call.args[0].input.ConsistentRead === true);
    expect(consistentReads.map((call) => call.args[0].input.Key)).toEqual([
      K.profile('rocio'),
      accountClosureKey('rocio'),
      K.rec('rocio', 'trees', 'stale-tree'),
    ]);
  });

  it('does not mask a non-conditional transaction cancellation as STALE_REV', async () => {
    const transactionConflict = transactionCanceled(['TransactionConflict', 'None', 'None']);
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(TransactWriteCommand).rejects(transactionConflict);

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: tree('retry-me') }],
      }),
    ).rejects.toBe(transactionConflict);
  });

  it('does not mask a malformed stored winner as STALE_REV', async () => {
    const incoming = tree('corrupt-winner', 1);
    const malformedWinner = {
      ...recordItem('rocio', { ...incoming, rev: 5 }),
      rev: undefined,
    } as unknown as RecordItem;
    const cancelled = transactionCanceled(['ConditionalCheckFailed', 'None', 'None']);
    ddbMock.on(TransactWriteCommand).rejects(cancelled);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.sk === 'PROFILE') return { Item: profile('rocio', { status: 'active' }) };
      if (key.pk === accountClosureKey('rocio').pk) return {};
      if (key.pk === malformedWinner.pk && key.sk === malformedWinner.sk) {
        return { Item: malformedWinner };
      }
      return {};
    });

    await expect(
      pushSync(ctxOf(profile('rocio')), {
        schemaVersion: 3,
        records: [{ store: 'trees', record: incoming }],
      }),
    ).rejects.toBe(cancelled);
  });

  it('guards caller, minor and their current guardian link in the same write transaction', async () => {
    const link = guardianLink('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      return key.pk === link.pk && key.sk === link.sk ? { Item: link } : {};
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await expect(
      pushSyncFor(ctxOf(profile('rocio')), 'nico', {
        schemaVersion: 3,
        records: [{ store: 'trees', record: tree('minor-tree') }],
      }),
    ).resolves.toMatchObject({ applied: ['minor-tree'] });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(conditionChecks(transaction).map((guard) => guard.Key)).toEqual([
      K.profile('rocio'),
      accountClosureKey('rocio'),
      K.profile('nico'),
      accountClosureKey('nico'),
      K.link('nico', 'rocio'),
    ]);
  });

  it('returns NOT_FOUND when the guardian link disappears during the write', async () => {
    const link = guardianLink('rocio', 'nico');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === link.pk && key.sk === link.sk) {
        return input.ConsistentRead ? {} : { Item: link };
      }
      if (key.sk === 'PROFILE') {
        const userId = key.pk.replace('USER#', '');
        return { Item: profile(userId, { status: 'active' }) };
      }
      return {};
    });
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCanceled(['None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed']));

    await expect(
      pushSyncFor(ctxOf(profile('rocio')), 'nico', {
        schemaVersion: 3,
        records: [{ store: 'trees', record: tree('minor-race') }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
