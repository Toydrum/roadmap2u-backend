import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type BatchGetCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CONTRACT_VERSION, type SyncPushPayload } from '@app/api/contracts';
import { newSyncBase, type Tree } from '@app/db/schema';
import { accountClosureKey } from '../lambda/account-closure';
import type { Ctx } from '../lambda/authz';
import { K, type Deps, type ProfileItem, type RecordItem } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import { pushSyncFor } from '../lambda/handlers/sync';
import { createActiveAdultFriendship } from '../lambda/social/model';
import { familyV2Fixture } from './support/family-v2-fixture';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ddbMock = mockClient(DynamoDBDocumentClient);
type Row = Record<string, unknown> & { pk: string; sk: string };
const address = (key: { pk: string; sk: string }) => `${key.pk}\0${key.sk}`;

function setup(actorId = 'primary', targetId = 'minor-a') {
  let now = NOW;
  const family = familyV2Fixture({
    now,
    primaryId: 'primary',
    minorIds: ['minor-a', 'minor-b'],
    additionalResponsibleSeat: 1,
    additionalId: 'additional',
    additionalScope: ['minor-a'],
  });
  const rows = new Map<string, Row>();
  const profiles = new Map<string, ProfileItem>();
  const put = (row: { pk: string; sk: string }) => rows.set(address(row), row);
  [family.household, ...family.seats, ...family.supervisionLinks, ...family.coverages].forEach(put);
  for (const id of new Set(['primary', 'additional', 'minor-a', 'minor-b', actorId, targetId])) {
    const person: ProfileItem = {
      ...K.profile(id), userId: id, username: id, displayName: id,
      accountType: id.startsWith('minor-') ? 'minor' : 'adult',
      ...(id.startsWith('minor-') ? { majorityAt: '2030-01-01' } : {}),
      socialEnabled: true, status: 'active', createdAt: NOW - 1_000,
    };
    profiles.set(id, person);
    put(person);
  }
  put({
    pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS', revision: 1,
    quotaMode: 'off', capabilityMode: 'off',
    accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: false,
    premiumPaymentsEnabled: false, updatedAt: NOW - 1_000,
    updatedBy: 'bootstrap', reason: 'test',
  } as Row);
  put({ pk: K.user(targetId), sk: 'USAGE', state: 'active', activeTrees: 1 } as Row);
  const before: Tree = {
    ...newSyncBase(NOW - 100), id: 'tree-1', name: 'Private tree', accent: 'moss',
    order: 0, currentNodeId: null, heartId: null, archivedAt: null,
  };
  const incoming = { ...before, rev: before.rev + 1, updatedAt: NOW - 1, archivedAt: NOW - 1 };
  put({
    ...K.rec(targetId, 'trees', before.id), owner: targetId, store: 'trees', record: before,
    rev: before.rev, updatedAt: before.updatedAt, syncedAt: NOW - 100,
    gsi2pk: K.user(targetId), gsi2sk: K.chg(NOW - 100, before.id),
  } as RecordItem);
  const ctx: Ctx = {
    callerId: actorId, caller: { ...profiles.get(actorId)! },
    deps: {
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
      table: 'roadmap', userPoolId: 'pool', now: () => now,
    },
  };
  ddbMock.on(GetCommand).callsFake((input) => ({ Item: rows.get(address(input.Key as Row)) }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues ?? {};
    return { Items: [...rows.values()].filter((row) =>
      row.pk === values[':pk'] && (!values[':prefix'] || row.sk.startsWith(values[':prefix'])),
    ) };
  });
  ddbMock.on(BatchGetCommand).callsFake((input: BatchGetCommandInput) => ({
    Responses: { roadmap: input.RequestItems?.roadmap.Keys?.flatMap((key) => {
      const row = rows.get(address(key as Row));
      return row ? [row] : [];
    }) ?? [] },
  }));
  ddbMock.on(TransactWriteCommand).resolves({});
  const payload: SyncPushPayload = {
    schemaVersion: 13, contractVersion: CONTRACT_VERSION,
    mutationGroups: [{ id: 'group-1', expectedCount: 1, records: [{ store: 'trees', record: incoming }] }],
  };
  return {
    ctx, rows, put, family, targetId, payload, incoming,
    advanceTime: (time: number) => { now = time; },
    row: (key: { pk: string; sk: string }) => rows.get(address(key))!,
    legacyLink: () => put({
      ...K.link(targetId, actorId), gsi1pk: K.user(actorId), gsi1sk: `MINOR#${targetId}`,
      linkId: `${actorId}~${targetId}`, kind: 'created', guardianId: actorId,
      minorId: targetId, createdAt: NOW - 2_000,
    } as Row),
  };
}

function cancelled() {
  return Object.assign(new Error('conditional conflict'), {
    name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
}

describe('sync supervised forest writes v2', () => {
  beforeEach(() => ddbMock.reset());

  it.each(['primary', 'additional'])('allows only the exact current %s scope without legacy links', async (actor) => {
    const s = setup(actor);
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).resolves.toMatchObject({ applied: ['tree-1'] });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    const checks = items.flatMap((item) => item.ConditionCheck ? [item.ConditionCheck] : []);
    expect(checks.map((check) => check.Key)).toEqual(expect.arrayContaining([
      K.profile(actor), accountClosureKey(actor), K.profile(s.targetId), accountClosureKey(s.targetId),
      FK.household(s.family.household.householdId), FK.minorSeat(s.family.household.householdId, 1),
      FK.supervision(s.targetId, actor), FK.familyCoverage(actor), FK.familyCoverage(s.targetId),
      ...(actor === 'additional' ? [FK.additionalSeat(s.family.household.householdId)] : []),
    ]));
    for (const key of [FK.household(s.family.household.householdId), FK.supervision(s.targetId, actor), FK.familyCoverage(actor)]) {
      const check = checks.find((item) => address(item.Key as Row) === address(key))!;
      expect(Object.values(check.ExpressionAttributeNames ?? {})).toContain('revision');
      expect(Object.values(check.ExpressionAttributeValues ?? {})).toContain(s.row(key).revision);
    }
    const minorGuard = checks.find((item) => item.Key?.pk === K.user(s.targetId) && item.Key?.sk === 'PROFILE')!;
    expect(Object.values(minorGuard.ExpressionAttributeValues!)).toContain('minor');
    expect(Object.values(minorGuard.ExpressionAttributeValues!)).toContain('2030-01-01');
    expect(checks.some((item) => String(item.Key?.sk).startsWith('GUARDIAN#'))).toBe(false);
    const keys = items.map((item) => address((item.Put?.Item ?? item.Update?.Key ?? item.ConditionCheck?.Key) as Row));
    expect(new Set(keys).size).toBe(keys.length);
    expect(ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.ConsistentRead)).toBe(true);
  });

  it('uses the same v2 authority for a legacy flat batch', async () => {
    const s = setup('additional');
    await expect(pushSyncFor(s.ctx, s.targetId, {
      schemaVersion: 13, records: [{ store: 'trees', record: s.incoming }],
    })).resolves.toMatchObject({ applied: ['tree-1'] });
  });

  it('denies an additional responsible for A writing B despite a legacy mirror', async () => {
    const s = setup('additional', 'minor-b');
    s.legacyLink();
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('does not authorize an old guardian link without Household v2', async () => {
    const s = setup();
    s.legacyLink();
    s.rows.delete(address(FK.familyCoverage(s.targetId)));
    await expect(pushSyncFor(s.ctx, s.targetId, { schemaVersion: 13, records: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not inherit a friend primary account scope or allow writing the adult friend', async () => {
    const s = setup('visitor');
    s.put(createActiveAdultFriendship({ leftAccountId: 'visitor', rightAccountId: 'primary', now: NOW - 500 }));
    for (const target of ['primary', 'additional', 'minor-a', 'minor-b']) {
      await expect(pushSyncFor(s.ctx, target, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['minor-a', 'minor-b'])('never allows %s to use the supervised write route', async (actor) => {
    const s = setup(actor);
    s.legacyLink();
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['2026-09-04', 'bad-date', undefined])('fails closed for majority date %s', async (majorityAt) => {
    const s = setup();
    s.legacyLink();
    s.row(K.profile(s.targetId)).majorityAt = majorityAt;
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['actor-type', 'minor-type', 'actor-closing', 'minor-closure', 'coverage-ended', 'scope-revoked'])('denies current invalid authority: %s', async (change) => {
    const s = setup('additional');
    s.legacyLink();
    if (change === 'actor-type') s.row(K.profile('additional')).accountType = 'minor';
    if (change === 'minor-type') s.row(K.profile(s.targetId)).accountType = 'adult';
    if (change === 'actor-closing') s.row(K.profile('additional')).status = 'closing';
    if (change === 'minor-closure') s.put(accountClosureKey(s.targetId));
    if (change === 'coverage-ended') s.row(FK.familyCoverage('additional')).state = 'ended';
    if (change === 'scope-revoked') {
      Object.assign(s.row(FK.supervision(s.targetId, 'additional')), { state: 'revoked', validUntil: NOW });
    }
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['scope', 'household', 'coverage', 'minor-profile'])('stops retrying when %s changes during commit', async (change) => {
    const s = setup('additional');
    s.legacyLink();
    ddbMock.on(TransactWriteCommand).callsFake(() => {
      if (change === 'scope') s.row(FK.supervision(s.targetId, 'additional')).revision = 2;
      if (change === 'household') s.row(FK.household(s.family.household.householdId)).revision = 2;
      if (change === 'coverage') s.row(FK.familyCoverage('additional')).state = 'ended';
      if (change === 'minor-profile') s.row(K.profile(s.targetId)).accountType = 'adult';
      throw cancelled();
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('does not return a stale private record after supervision is revoked', async () => {
    const s = setup('additional');
    s.legacyLink();
    const stored = s.row(K.rec(s.targetId, 'trees', 'tree-1'));
    stored.rev = s.incoming.rev + 1;
    stored.updatedAt = NOW;
    stored.record = { ...s.incoming, rev: stored.rev, updatedAt: NOW };
    ddbMock.on(GetCommand).callsFake((input) => {
      const row = s.rows.get(address(input.Key as Row));
      if (input.Key?.sk === 'REC#trees#tree-1') s.row(FK.familyCoverage('additional')).state = 'ended';
      return { Item: row };
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('does not accept a concurrent marker after supervision is revoked', async () => {
    const s = setup('additional');
    s.legacyLink();
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      const marker = input.TransactItems?.find((item) => item.Put?.Item?.sk === 'MUTATION#group-1')?.Put?.Item;
      expect(marker).toBeDefined();
      s.put(marker as Row);
      s.row(FK.familyCoverage('additional')).state = 'ended';
      throw cancelled();
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('checks paid coverage again at commit time', async () => {
    const s = setup('additional');
    s.legacyLink();
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === 'FLAGS') s.advanceTime(NOW + 86_400_000);
      return { Item: s.rows.get(address(input.Key as Row)) };
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a minor coverage moved to another household between strong reads', async () => {
    const s = setup();
    ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: s.family.coverages.map((row) =>
      row.accountId === s.targetId ? { ...row, householdId: 'different-household', state: 'ended' } : row,
    ) } });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(['grace', 'scheduled_end'])('preserves authorized accompaniment under %s coverage', async (state) => {
    const s = setup('additional');
    Object.assign(s.row(FK.familyCoverage('additional')), {
      state, graceUntil: state === 'grace' ? NOW + 60_000 : null,
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).resolves.toMatchObject({ applied: ['tree-1'] });
  });

  it('checks the majority boundary again at commit time', async () => {
    const s = setup();
    s.row(K.profile(s.targetId)).majorityAt = '2026-09-05';
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === 'FLAGS') s.advanceTime(Date.parse('2026-09-05T00:00:00.000Z'));
      return { Item: s.rows.get(address(input.Key as Row)) };
    });
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('preserves an operational DynamoDB failure instead of turning it into a denial', async () => {
    const s = setup();
    const unavailable = Object.assign(new Error('unavailable'), { name: 'InternalServerError' });
    ddbMock.on(QueryCommand).rejects(unavailable);
    await expect(pushSyncFor(s.ctx, s.targetId, s.payload)).rejects.toBe(unavailable);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
