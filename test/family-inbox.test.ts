import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Ctx } from '../lambda/authz';
import type { Deps, ProfileItem } from '../lambda/db';

const NOW = 1_800_000_000_000;
const mock = mockClient(DynamoDBDocumentClient);
const caller: ProfileItem = { pk: 'USER#adult-a', sk: 'PROFILE', userId: 'adult-a', username: 'ana', displayName: 'Ana', accountType: 'adult', socialEnabled: false, createdAt: 1, status: 'active' };
const ctx = (): Ctx => ({ callerId: caller.userId, caller, deps: { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'roadmap', now: () => NOW } as Deps });
const source = (over: Record<string, unknown> = {}) => ({
  pk: 'FAMILY_NOTICE#notice-a', sk: 'META', entityType: 'FamilyNotice', noticeId: 'notice-a',
  kind: 'additional_responsible_invitation', householdId: 'household-a',
  targetHouseholdRevision: 3,
  createdById: 'adult-primary', intendedAdultId: caller.userId, sourcePrimaryId: 'adult-primary', minorId: null,
  state: 'pending', createdAt: NOW - 1_000, expiresAt: NOW + 1_000, revision: 1,
  code: 'SECRET', minorIds: ['private-minor'], ...over,
});
const pointer = (s = source(), over: Record<string, unknown> = {}) => {
  const id = createHash('sha256').update(s.pk + '\0' + s.sk + '\0' + s.noticeId).digest('hex');
  return { pk: caller.pk, sk: 'FAMILY_INBOX#' + id, entityType: 'FamilyInboxPointer',
    noticeId: s.noticeId, householdId: s.householdId, kind: s.kind, ...over };
};
async function moduleApi() {
  const path = '../lambda/family/' + 'inbox';
  const mod = await import(path).catch(() => null);
  expect(mod?.getFamilyInbox).toBeTypeOf('function');
  return mod!;
}
function reads(sources: ReturnType<typeof source>[], pointers: ReturnType<typeof pointer>[], more?: object) {
  mock.on(GetCommand).callsFake(({ Key }) => ({ Item: [caller, ...sources].find((row) => row.pk === Key.pk && row.sk === Key.sk) }));
  mock.on(QueryCommand).resolves({ Items: pointers, ...(more ? { LastEvaluatedKey: more } : {}) });
}
beforeEach(() => mock.reset());

describe('account-private family inbox', () => {
  it('reads only the caller partition with strong, bounded pagination and strips secrets', async () => {
    const s = source(); const p = pointer(s); reads([s], [p], { pk: p.pk, sk: p.sk });
    const { getFamilyInbox } = await moduleApi();
    const result = await getFamilyInbox(ctx());
    expect(result.entries).toEqual([{ noticeId: 'notice-a', kind: s.kind, householdId: s.householdId,
      expectedHouseholdRevision: 3,
      state: 'pending', createdAt: s.createdAt, expiresAt: s.expiresAt, revision: 1 }]);
    expect(result.nextCursor).toBe(p.sk.slice('FAMILY_INBOX#'.length));
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private-minor|intendedAdultId/);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({ ConsistentRead: true, Limit: 50,
      ExpressionAttributeValues: { ':pk': caller.pk, ':prefix': 'FAMILY_INBOX#' } });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('does not trust foreign pointers, missing canonicals, or unrelated household membership', async () => {
    const s = source({ intendedAdultId: 'stranger' });
    reads([s], [pointer(s), pointer(s, { pk: 'USER#stranger' }), pointer(s, { noticeId: 'missing' })]);
    expect((await (await moduleApi()).getFamilyInbox(ctx())).entries).toEqual([]);
  });

  it('derives expiration at the exact boundary without mutating a pending request', async () => {
    const s = source({ expiresAt: NOW }); reads([s], [pointer(s)]);
    expect((await (await moduleApi()).getFamilyInbox(ctx())).entries[0].state).toBe('expired');
    expect(s.state).toBe('pending');
  });

  it('rejects malformed cursors before querying any family data', async () => {
    reads([], []);
    await expect((await moduleApi()).getFamilyInbox(ctx(), 'USER#stranger')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(mock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('rechecks terminal closure after loading the inbox', async () => {
    const s = source(); reads([s], [pointer(s)]);
    let profileReads = 0;
    mock.on(GetCommand, { Key: { pk: caller.pk, sk: 'PROFILE' } }).callsFake(() => ({ Item: ++profileReads === 1 ? caller : { ...caller, status: 'closing' } }));
    await expect((await moduleApi()).getFamilyInbox(ctx())).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
