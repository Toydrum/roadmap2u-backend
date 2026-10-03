import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { accountClosureKey } from '../lambda/account-closure';
import type { Ctx } from '../lambda/authz';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import { getForest } from '../lambda/handlers/forests';
import {
  activateMinorFriendship,
  createActiveAdultFriendship,
  createMinorFriendConsent,
  createPendingMinorFriendship,
  MINOR_SOCIAL_POLICY_VERSION,
  SK,
} from '../lambda/social/model';
import { familyV2Fixture, type FamilyV2Fixture } from './support/family-v2-fixture';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ddbMock = mockClient(DynamoDBDocumentClient);

type Relationship =
  | 'self'
  | 'primary_supervision'
  | 'additional_supervision'
  | 'adult_friend'
  | 'minor_friend'
  | null;

type AuthzModule = {
  resolveRelationship?: (ctx: Ctx, targetId: string) => Promise<Relationship>;
};

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
    status: 'active',
    createdAt: NOW - 1_000,
    ...over,
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function activeMinorFriendship(leftId: string, rightId: string) {
  const friendship = createPendingMinorFriendship({
    requesterId: leftId,
    recipientId: rightId,
    requestCycleId: 'cycle-1',
    now: NOW - 1_000,
    expiresAt: NOW + 86_400_000,
  });
  const consents = [
    createMinorFriendConsent({
      friendship,
      kind: 'requester_action',
      actorId: leftId,
      subjectMinorId: leftId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 900,
    }),
    createMinorFriendConsent({
      friendship,
      kind: 'requester_responsible_approval',
      actorId: 'responsible-a',
      subjectMinorId: leftId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 800,
    }),
    createMinorFriendConsent({
      friendship,
      kind: 'recipient_acceptance',
      actorId: rightId,
      subjectMinorId: rightId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 700,
    }),
    createMinorFriendConsent({
      friendship,
      kind: 'recipient_responsible_approval',
      actorId: 'responsible-b',
      subjectMinorId: rightId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 600,
    }),
  ];
  return activateMinorFriendship(friendship, consents, NOW - 500);
}

function installFamilyReads(
  actor: ProfileItem,
  target: ProfileItem,
  family: FamilyV2Fixture,
): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
    if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
    const coverage = family.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
    return coverage ? { Item: coverage } : {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
    if (values?.[':pk'] === FK.household(family.household.householdId).pk) {
      return { Items: [family.household, ...family.seats] };
    }
    if (values?.[':prefix'] === 'SUPERVISION#') {
      return {
        Items: family.supervisionLinks.filter(
          (link) => link.pk === values[':pk'] && link.sk.startsWith(values[':prefix']),
        ),
      };
    }
    return { Items: [] };
  });
  ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: family.coverages } });
}

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRelationship — forest authorization v2', () => {
  it('resolves the authenticated account as self without external authority', async () => {
    const authz = (await import('../lambda/authz')) as AuthzModule;

    expect(authz.resolveRelationship).toBeTypeOf('function');
    await expect(authz.resolveRelationship!(ctxOf(profile('adult-a')), 'adult-a')).resolves.toBe(
      'self',
    );
  });

  it('resolves an exact active adult friendship from the canonical social row', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = createActiveAdultFriendship({
      leftAccountId: actor.userId,
      rightAccountId: target.userId,
      now: NOW - 500,
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBe(
      'adult_friend',
    );
  });

  it('resolves an exact active friendship between two accounts that are still minors', async () => {
    const actor = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const target = profile('minor-b', { accountType: 'minor', majorityAt: '2031-01-01' });
    const friendship = activeMinorFriendship(actor.userId, target.userId);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBe(
      'minor_friend',
    );
  });

  it('resolves current primary supervision for the exact seated minor', async () => {
    const actor = profile('primary-a');
    const target = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const family = familyV2Fixture({
      now: NOW,
      primaryId: actor.userId,
      minorIds: [target.userId],
    });
    installFamilyReads(actor, target, family);
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBe(
      'primary_supervision',
    );
  });

  it('limits additional supervision to the exact assigned minor', async () => {
    const actor = profile('additional-a');
    const allowedTarget = profile('minor-a', {
      accountType: 'minor',
      majorityAt: '2030-01-01',
    });
    const deniedTarget = profile('minor-b', {
      accountType: 'minor',
      majorityAt: '2031-01-01',
    });
    const family = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-a',
      minorIds: [allowedTarget.userId, deniedTarget.userId],
      additionalResponsibleSeat: 1,
      additionalId: actor.userId,
      additionalScope: [allowedTarget.userId],
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    installFamilyReads(actor, allowedTarget, family);
    await expect(authz.resolveRelationship!(ctxOf(actor), allowedTarget.userId)).resolves.toBe(
      'additional_supervision',
    );

    ddbMock.reset();
    installFamilyReads(actor, deniedTarget, family);
    await expect(authz.resolveRelationship!(ctxOf(actor), deniedTarget.userId)).resolves.toBeNull();
  });

  it('does not treat a legacy friend mirror as forest authority', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === K.friend(actor.userId, target.userId).pk && key.sk === K.friend(actor.userId, target.userId).sk) {
        return {
          Item: {
            ...key,
            friendshipId: 'adult-a~adult-b',
            userA: 'adult-a',
            userB: 'adult-b',
            createdAt: NOW - 500,
          },
        };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBeNull();
  });

  it('does not resolve a remote relationship after the target starts account closure', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = createActiveAdultFriendship({
      leftAccountId: actor.userId,
      rightAccountId: target.userId,
      now: NOW - 500,
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === accountClosureKey(target.userId).pk && key.sk === accountClosureKey(target.userId).sk) {
        return { Item: { ...key, state: 'requested' } };
      }
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBeNull();
  });

  it('does not disguise an operational friendship read failure as an absent relationship', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const failure = new TypeError('dynamodb transport failed');
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        throw failure;
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).rejects.toBe(failure);
  });

  it('serves the stripped forest view through a canonical adult friendship', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = createActiveAdultFriendship({
      leftAccountId: actor.userId,
      rightAccountId: target.userId,
      now: NOW - 500,
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return {
          Item: {
            pk: key.pk,
            sk: key.sk,
            revision: 1,
            quotaMode: 'off',
            capabilityMode: 'off',
            accessCodeIssuanceEnabled: false,
            accessCodeRedemptionEnabled: false,
            premiumPaymentsEnabled: false,
            updatedAt: NOW - 1,
            updatedBy: 'test',
            reason: 'forest relationship fixture',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(actor), target.userId)).resolves.toMatchObject({
      detail: 'stripped',
      owner: { userId: target.userId },
      trees: [],
      nodes: [],
    });
  });

  it('serves the same stripped view through a canonical minor friendship', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const actor = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const target = profile('minor-b', { accountType: 'minor', majorityAt: '2031-01-01' });
    const friendship = activeMinorFriendship(actor.userId, target.userId);
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return {
          Item: {
            pk: key.pk,
            sk: key.sk,
            revision: 1,
            quotaMode: 'off',
            capabilityMode: 'off',
            accessCodeIssuanceEnabled: false,
            accessCodeRedemptionEnabled: false,
            premiumPaymentsEnabled: false,
            updatedAt: NOW - 1,
            updatedBy: 'test',
            reason: 'forest relationship fixture',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(actor), target.userId)).resolves.toMatchObject({
      detail: 'stripped',
      owner: { userId: target.userId },
      trees: [],
      nodes: [],
    });
  });

  it('keeps NOT_FOUND when the viewer starts account closure during a friend visit', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = createActiveAdultFriendship({
      leftAccountId: actor.userId,
      rightAccountId: target.userId,
      now: NOW - 500,
    });
    let actorClosureReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === accountClosureKey(actor.userId).pk && key.sk === accountClosureKey(actor.userId).sk) {
        actorClosureReads += 1;
        return actorClosureReads === 1 ? {} : { Item: { ...key, state: 'requested' } };
      }
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
        return {
          Item: {
            pk: key.pk,
            sk: key.sk,
            revision: 1,
            quotaMode: 'off',
            capabilityMode: 'off',
            accessCodeIssuanceEnabled: false,
            accessCodeRedemptionEnabled: false,
            premiumPaymentsEnabled: false,
            updatedAt: NOW - 1,
            updatedBy: 'test',
            reason: 'forest relationship fixture',
          },
        };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(actor), target.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('serves full detail through current primary supervision', async () => {
    const actor = profile('primary-a');
    const target = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const family = familyV2Fixture({
      now: NOW,
      primaryId: actor.userId,
      minorIds: [target.userId],
    });
    installFamilyReads(actor, target, family);

    await expect(getForest(ctxOf(actor), target.userId)).resolves.toMatchObject({
      detail: 'full',
      owner: { userId: target.userId, socialEnabled: true },
      trees: [],
      nodes: [],
    });
  });

  it('returns NOT_FOUND for every adult-minor friendship-shaped attempt', async () => {
    const actor = profile('adult-a');
    const target = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const forgedFriendship = createActiveAdultFriendship({
      leftAccountId: actor.userId,
      rightAccountId: target.userId,
      now: NOW - 500,
    });
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: forgedFriendship };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(getForest(ctxOf(actor), target.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      ddbMock.commandCalls(QueryCommand).filter((call) =>
        String(call.args[0].input.ExpressionAttributeValues?.[':prefix']).startsWith('REC#'),
      ),
    ).toHaveLength(0);
  });

  it('does not serve a supervised forest when the owner profile changes after authorization', async () => {
    const actor = profile('primary-a');
    const target = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const family = familyV2Fixture({
      now: NOW,
      primaryId: actor.userId,
      minorIds: [target.userId],
    });
    let targetProfileReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') {
        targetProfileReads += 1;
        return targetProfileReads === 1
          ? { Item: target }
          : { Item: { ...target, userId: 'minor-other' } };
      }
      const coverage = family.coverages.find((item) => item.pk === key.pk && item.sk === key.sk);
      return coverage ? { Item: coverage } : {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
      if (values?.[':pk'] === FK.household(family.household.householdId).pk) {
        return { Items: [family.household, ...family.seats] };
      }
      if (values?.[':prefix'] === 'SUPERVISION#') {
        return {
          Items: family.supervisionLinks.filter(
            (link) => link.pk === values[':pk'] && link.sk.startsWith(values[':prefix']),
          ),
        };
      }
      return { Items: [] };
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: family.coverages } });

    await expect(getForest(ctxOf(actor), target.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('revalidates additional supervision immediately before reading forest records', async () => {
    const actor = profile('additional-a');
    const target = profile('minor-a', { accountType: 'minor', majorityAt: '2030-01-01' });
    const activeFamily = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-a',
      minorIds: [target.userId],
      additionalResponsibleSeat: 1,
      additionalId: actor.userId,
      additionalScope: [target.userId],
    });
    const revokedFamily = familyV2Fixture({
      now: NOW,
      primaryId: 'primary-a',
      minorIds: [target.userId],
    });
    let familyRead = 0;
    let recordReads = 0;
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      const coverage = activeFamily.coverages.find(
        (item) => item.pk === key.pk && item.sk === key.sk && item.accountId === target.userId,
      );
      return coverage ? { Item: coverage } : {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string> | undefined;
      const prefix = values?.[':prefix'];
      if (values?.[':pk'] === FK.household(activeFamily.household.householdId).pk) {
        familyRead += 1;
        const current = familyRead === 1 ? activeFamily : revokedFamily;
        return { Items: [current.household, ...current.seats] };
      }
      if (prefix === 'SUPERVISION#') {
        const current = familyRead === 1 ? activeFamily : revokedFamily;
        return {
          Items: current.supervisionLinks.filter(
            (link) => link.pk === values?.[':pk'] && link.sk.startsWith(prefix),
          ),
        };
      }
      if (prefix?.startsWith('REC#')) recordReads += 1;
      return { Items: [] };
    });
    ddbMock.on(BatchGetCommand).callsFake(() => {
      const current = familyRead === 1 ? activeFamily : revokedFamily;
      return { Responses: { roadmap: current.coverages } };
    });

    await expect(getForest(ctxOf(actor), target.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(recordReads).toBe(0);
  });

  it('rejects a malformed entity stored at the canonical friendship key', async () => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = {
      ...createActiveAdultFriendship({
        leftAccountId: actor.userId,
        rightAccountId: target.userId,
        now: NOW - 500,
      }),
      entityType: 'Consent',
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBeNull();
  });

  it.each([
    ['missing activation timestamp', { activatedAt: null }],
    ['contradictory end timestamp', { endedAt: NOW - 100 }],
    ['invalid revision', { revision: 0 }],
  ])('rejects an active friendship with %s', async (_label, mutation) => {
    const actor = profile('adult-a');
    const target = profile('adult-b');
    const friendship = {
      ...createActiveAdultFriendship({
        leftAccountId: actor.userId,
        rightAccountId: target.userId,
        now: NOW - 500,
      }),
      ...mutation,
    };
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key as { pk: string; sk: string };
      if (key.pk === K.profile(actor.userId).pk && key.sk === 'PROFILE') return { Item: actor };
      if (key.pk === K.profile(target.userId).pk && key.sk === 'PROFILE') return { Item: target };
      if (key.pk === SK.friendship(actor.userId, target.userId).pk && key.sk === 'META') {
        return { Item: friendship };
      }
      return {};
    });
    const authz = (await import('../lambda/authz')) as AuthzModule;

    await expect(authz.resolveRelationship!(ctxOf(actor), target.userId)).resolves.toBeNull();
  });
});
