import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../lambda/authz';
import { accountClosureKey, type AccessItem } from '../lambda/commercial/model';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import {
  createMinorFriendRequest,
  getMinorFriendRequests,
  mintMinorInviteCode,
  recordMinorAcceptance,
  recordResponsibleApproval,
  rejectMinorFriendRequest,
  revokeMinorFriendship,
} from '../lambda/handlers/social';
import {
  MINOR_FRIEND_INVITE_TTL_MS,
  MINOR_SOCIAL_POLICY_VERSION,
  SK,
  createMinorFriendConsent,
  createMinorFriendInviteCode,
  createPendingMinorFriendship,
  type ConsentItem,
  type FriendshipItem,
} from '../lambda/social/model';
import { familyV2Fixture, type FamilyV2Fixture } from './support/family-v2-fixture';
import { minorSocialInternals } from '../lambda/handlers/minor-social';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);
type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function deps(): Deps {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
}

function profile(userId: string, accountType: 'adult' | 'minor' = 'minor'): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId,
    displayName: userId,
    accountType,
    socialEnabled: true,
    status: 'active',
    createdAt: NOW - 10_000,
    ...(accountType === 'minor' ? { majorityAt: '2030-01-01' } : {}),
  };
}

function ctxOf(caller: ProfileItem): Ctx {
  return { callerId: caller.userId, caller, deps: deps() };
}

function flags() {
  return {
    pk: 'COMMERCIAL#CONFIG',
    sk: 'FLAGS',
    revision: 1,
    quotaMode: 'off',
    capabilityMode: 'off',
    accessCodeIssuanceEnabled: false,
    accessCodeRedemptionEnabled: false,
    premiumPaymentsEnabled: false,
    updatedAt: NOW - 1,
    updatedBy: 'test',
    reason: 'minor friendship fixture',
  };
}

function access(ownerSub: string): AccessItem {
  return {
    pk: K.user(ownerSub),
    sk: 'ACCESS',
    ownerSub,
    effectivePlanKey: 'free',
    catalogVersion: '2026-09-family-v1',
    status: 'active',
    activeSources: [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
    limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
    capabilities: { cloudSync: false, social: false, family: false },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: NOW + 60_000,
    updatedAt: NOW - 1,
  };
}

function installReads(items: readonly unknown[], families: readonly FamilyV2Fixture[] = []): void {
  const familyItems = families.flatMap((family) => [
    family.household,
    ...family.seats,
    ...family.supervisionLinks,
    ...family.coverages,
  ]);
  const byKey = new Map(
    [...items, ...familyItems].map((item) => {
      const keyed = item as { pk: string; sk: string };
      return [JSON.stringify({ pk: keyed.pk, sk: keyed.sk }), item] as const;
    }),
  );
  // Existing ACCESS fixtures must reflect seeded coverage. These tests assert
  // social transactions, not the separate lazy ACCESS materialization path.
  for (const family of families) {
    for (const coverage of family.coverages) {
      const key = JSON.stringify({ pk: K.user(coverage.accountId), sk: 'ACCESS' });
      if (byKey.has(key)) {
        byKey.set(key, deriveAccessItem(coverage.accountId, NOW, undefined, [], { coverage }));
      }
    }
  }
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: byKey.get(JSON.stringify(input.Key)),
  }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues?.[':pk'];
    const prefix = input.ExpressionAttributeValues?.[':prefix'];
    if (typeof pk === 'string' && pk.startsWith('HOUSEHOLD#')) {
      const family = families.find((candidate) => candidate.household.pk === pk);
      return { Items: family ? [family.household, ...family.seats] : [] };
    }
    if (typeof pk === 'string' && typeof prefix === 'string' && prefix === 'SUPERVISION#') {
      return {
        Items: families
          .flatMap((family) => family.supervisionLinks)
          .filter((link) => link.pk === pk),
      };
    }
    return { Items: [] };
  });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const keys = input.RequestItems?.['roadmap']?.Keys ?? [];
    return {
      Responses: {
        roadmap: keys.flatMap((key: Record<string, unknown>) => {
          const value = byKey.get(JSON.stringify(key));
          return value ? [value] : [];
        }),
      },
    };
  });
  ddbMock.on(TransactWriteCommand).resolves({});
}

function transaction(index: number) {
  return ddbMock.commandCalls(TransactWriteCommand)[index]?.args[0].input.TransactItems ?? [];
}

beforeEach(() => {
  ddbMock.reset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('minor friendship handler v2', () => {
  it('mints a 24-hour one-use code for the signed-in minor and fences its profile pointer', async () => {
    const minor = profile('minor-a');
    installReads([minor, flags(), access(minor.userId)]);

    const grant = await mintMinorInviteCode(ctxOf(minor), { minorId: minor.userId });

    expect(grant.expiresAt).toBe(NOW + MINOR_FRIEND_INVITE_TTL_MS);
    expect(grant.code).toMatch(/^[2346790CDFGHJKMNPQRTVWXZ]{8}$/);
    const writes = transaction(0);
    expect(writes).toContainEqual(
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            ...SK.minorInviteCode(grant.code),
            entityType: 'MinorFriendInviteCode',
            minorId: minor.userId,
            issuedById: minor.userId,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      }),
    );
    const profileUpdate = writes.find((item) => item.Update?.Key?.['sk'] === 'PROFILE')?.Update;
    expect(profileUpdate?.UpdateExpression).toContain('friendCode = :code');
    expect(profileUpdate?.ConditionExpression).toContain('#accountType = :minor');
    expect(profileUpdate?.ConditionExpression).toContain('majorityAt > :today');
  });

  it('fails closed when a minor profile has no declared majority boundary', async () => {
    const minor = { ...profile('minor-a'), majorityAt: undefined };
    installReads([minor]);

    await expect(
      mintMinorInviteCode(ctxOf(minor), { minorId: minor.userId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rotates a legacy minor friend pointer into the new one-use code namespace', async () => {
    const minor = { ...profile('minor-a'), friendCode: 'FRIEND12' };
    const legacyCode = {
      ...K.codeF('FRIEND12'),
      code: 'FRIEND12',
      kind: 'friend' as const,
      userId: minor.userId,
      expiresAt: NOW + 60_000,
      ttl: Math.ceil((NOW + 60_000) / 1_000),
    };
    installReads([minor, legacyCode, flags(), access(minor.userId)]);

    const grant = await mintMinorInviteCode(ctxOf(minor), { minorId: minor.userId });

    expect(grant.code).not.toBe('FRIEND12');
    expect(transaction(0).flatMap((item) => item.Delete ? [item.Delete.Key] : []))
      .toContainEqual(K.codeF('FRIEND12'));
  });

  it('atomically consumes the code, creates pending META revision 2, and records requester action', async () => {
    const requester = profile('minor-z');
    const recipient = { ...profile('minor-a'), friendCode: 'CDFGHJKM' };
    const code = createMinorFriendInviteCode({
      code: 'CDFGHJKM',
      minorId: recipient.userId,
      issuedById: recipient.userId,
      now: NOW - 1_000,
      expiresAt: NOW + 60_000,
    });
    installReads([
      code,
      recipient,
      flags(),
      access(requester.userId),
      access(recipient.userId),
    ]);

    const view = await createMinorFriendRequest(ctxOf(requester), {
      minorId: requester.userId,
      code: code.code,
    });

    expect(view).toMatchObject({
      requestId: 'minor-friend:minor-a~minor-z',
      friendshipClass: 'minor_minor',
      state: 'pending',
      revision: 2,
      consents: [{ kind: 'requester_action', recordedAt: NOW }],
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    const writes = transaction(1);
    expect(writes.find((item) => item.Put?.Item?.['entityType'] === 'Friendship')?.Put?.Item)
      .toMatchObject({ state: 'pending', revision: 2 });
    expect(writes.find((item) => item.Put?.Item?.['entityType'] === 'Consent')?.Put?.Item)
      .toMatchObject({ kind: 'requester_action', actorId: requester.userId });
    expect(writes.filter((item) => item.Put?.Item?.['entityType'] === 'MinorFriendRequestPointer'))
      .toHaveLength(2);
    expect(writes.find((item) => item.Delete?.Key?.['pk'] === code.pk)?.Delete?.ConditionExpression)
      .toContain('expiresAt > :now');
  });

  it('lists a pending four-consent request only from the minor account pointer', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const pending = { ...createPendingMinorFriendship({
      requesterId: requester.userId, recipientId: recipient.userId,
      requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000,
    }), revision: 2 } satisfies FriendshipItem;
    const consent = createMinorFriendConsent({ friendship: pending, kind: 'requester_action',
      actorId: requester.userId, subjectMinorId: requester.userId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 });
    installReads([requester, recipient, pending, consent]);
    ddbMock.on(QueryCommand).callsFake((input) => ({ Items:
      input.ExpressionAttributeValues?.[':prefix'] === 'MFR#' ? [{
        pk: K.user(requester.userId), sk: `MFR#${pending.friendshipId}`,
        entityType: 'MinorFriendRequestPointer', minorId: requester.userId,
        friendshipId: pending.friendshipId, requestId: pending.requestId,
        requestCycleId: pending.requestCycleId,
      }] : [],
    }));
    const result = await getMinorFriendRequests(ctxOf(requester), requester.userId);
    expect(result).toMatchObject([{ requestId: pending.requestId, state: 'pending',
      consents: [{ kind: 'requester_action' }] }]);
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      ConsistentRead: true, ExpressionAttributeValues: { ':pk': K.user(requester.userId), ':prefix': 'MFR#' },
    });
  });

  it('records only the recipient minor acceptance and leaves two-of-four pending', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 2,
    } satisfies FriendshipItem;
    const requesterConsent = createMinorFriendConsent({
      friendship: pending,
      kind: 'requester_action',
      actorId: requester.userId,
      subjectMinorId: requester.userId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 900,
    }) satisfies ConsentItem;
    installReads([
      pending,
      requester,
      recipient,
      requesterConsent,
      flags(),
      access(requester.userId),
      access(recipient.userId),
    ]);

    const view = await recordMinorAcceptance(ctxOf(recipient), pending.requestId!, {
      minorId: recipient.userId,
      commandId: 'accept-cycle-1',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    expect(view.state).toBe('pending');
    expect(view.revision).toBe(3);
    expect(view.consents.map((consent) => consent.kind)).toEqual([
      'requester_action',
      'recipient_acceptance',
    ]);
    const writes = transaction(0);
    expect(writes.find((item) => item.Put?.Item?.['kind'] === 'recipient_acceptance')?.Put?.Item)
      .toMatchObject({ actorId: recipient.userId, subjectMinorId: recipient.userId });
    const friendshipUpdate = writes.find((item) => item.Update?.Key?.['sk'] === 'META')?.Update;
    expect(friendshipUpdate?.ConditionExpression).toContain('createdAt = :createdAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('updatedAt = :updatedAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('activatedAt = :activatedAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('endedAt = :endedAt');
    expect(friendshipUpdate?.ExpressionAttributeValues).toMatchObject({
      ':createdAt': pending.createdAt,
      ':updatedAt': pending.updatedAt,
      ':activatedAt': null,
      ':endedAt': null,
    });
  });

  it('omits structurally invalid consent rows from the current request evidence', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 2,
    } satisfies FriendshipItem;
    const malformed = {
      ...createMinorFriendConsent({
        friendship: pending,
        kind: 'requester_action',
        actorId: requester.userId,
        subjectMinorId: requester.userId,
        policyVersion: MINOR_SOCIAL_POLICY_VERSION,
        now: NOW - 900,
      }),
      actorId: recipient.userId,
    } satisfies ConsentItem;
    installReads([malformed]);

    const consents = await minorSocialInternals.readCurrentConsents(ctxOf(requester), pending);

    expect(consents).toEqual([]);
  });

  it.each([
    ['zero revision', { revision: 0 }],
    ['premature activation marker', { activatedAt: NOW - 100 }],
    ['request window above the maximum', { expiresAt: NOW + 15 * 24 * 60 * 60 * 1_000 }],
  ])('rejects a pending friendship with %s', (_label, overrides) => {
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: 'minor-z',
        recipientId: 'minor-a',
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      ...overrides,
    } as FriendshipItem;

    expect(minorSocialInternals.isExactPendingFriendship(pending, NOW)).toBe(false);
  });

  it('rejects a rotated or orphaned minor code even when its code row still exists', async () => {
    const requester = profile('minor-z');
    const recipient = { ...profile('minor-a'), friendCode: 'NPQRTVWX' };
    const code = createMinorFriendInviteCode({
      code: 'CDFGHJKM',
      minorId: recipient.userId,
      issuedById: recipient.userId,
      now: NOW - 1_000,
      expiresAt: NOW + 60_000,
    });
    installReads([code, recipient]);

    await expect(
      createMinorFriendRequest(ctxOf(requester), {
        minorId: requester.userId,
        code: code.code,
      }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('starts a fresh request cycle after rejection without accepting old consent rows', async () => {
    const requester = profile('minor-z');
    const recipient = { ...profile('minor-a'), friendCode: 'CDFGHJKM' };
    const code = createMinorFriendInviteCode({
      code: 'CDFGHJKM',
      minorId: recipient.userId,
      issuedById: recipient.userId,
      now: NOW - 1_000,
      expiresAt: NOW + 60_000,
    });
    const rejected = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-old',
        now: NOW - 10_000,
        expiresAt: NOW - 5_000,
      }),
      state: 'rejected' as const,
      revision: 4,
      updatedAt: NOW - 5_000,
      endedAt: NOW - 5_000,
    } satisfies FriendshipItem;
    installReads([
      code,
      rejected,
      recipient,
      flags(),
      access(requester.userId),
      access(recipient.userId),
    ]);

    const view = await createMinorFriendRequest(ctxOf(requester), {
      minorId: requester.userId,
      code: code.code,
    });

    expect(view).toMatchObject({ state: 'pending', revision: 6 });
    expect(view.consents.map((consent) => consent.kind)).toEqual(['requester_action']);
    const metaPut = transaction(1).find((item) => item.Put?.Item?.['entityType'] === 'Friendship')?.Put;
    expect(metaPut?.ConditionExpression).toContain('#state = :previousState');
    expect(metaPut?.ExpressionAttributeValues).toMatchObject({
      ':previousState': 'rejected',
      ':previousRevision': 4,
    });
  });

  it('lets a current responsible mint the minor code without impersonating the minor', async () => {
    const primary = profile('adult-primary', 'adult');
    const minor = profile('minor-a');
    const family = familyV2Fixture({
      now: NOW,
      primaryId: primary.userId,
      minorIds: [minor.userId],
    });
    installReads([primary, minor, flags(), access(minor.userId)], [family]);

    const grant = await mintMinorInviteCode(ctxOf(primary), { minorId: minor.userId });

    const writes = transaction(0);
    expect(writes.find((item) => item.Put?.Item?.['kind'] === 'minor_friend')?.Put?.Item)
      .toMatchObject({ code: grant.code, minorId: minor.userId, issuedById: primary.userId });
    expect(writes).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: expect.objectContaining({ pk: K.user(minor.userId), sk: `SUPERVISION#${primary.userId}` }),
        }),
      }),
    );
  });

  it('records an exact primary-responsible approval with current household authority guards', async () => {
    const primary = profile('adult-primary', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const family = familyV2Fixture({
      now: NOW,
      primaryId: primary.userId,
      minorIds: [requester.userId],
    });
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 2,
    } satisfies FriendshipItem;
    const requesterConsent = createMinorFriendConsent({
      friendship: pending,
      kind: 'requester_action',
      actorId: requester.userId,
      subjectMinorId: requester.userId,
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      now: NOW - 900,
    });
    installReads(
      [pending, primary, requester, recipient, requesterConsent, flags(), access(requester.userId), access(recipient.userId)],
      [family],
    );

    const view = await recordResponsibleApproval(ctxOf(primary), pending.requestId!, {
      minorId: requester.userId,
      commandId: 'primary-approves-cycle-1',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    expect(view.state).toBe('pending');
    expect(view.consents.map((consent) => consent.kind)).toEqual([
      'requester_action',
      'requester_responsible_approval',
    ]);
    const writes = transaction(0);
    expect(writes.find((item) => item.Put?.Item?.['kind'] === 'requester_responsible_approval')?.Put?.Item)
      .toMatchObject({ actorId: primary.userId, subjectMinorId: requester.userId });
    expect(writes).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({ Key: { pk: family.household.pk, sk: 'META' } }),
      }),
    );
    expect(writes).toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: expect.objectContaining({ pk: K.user(requester.userId), sk: `SUPERVISION#${primary.userId}` }),
        }),
      }),
    );
    const payerCoverage = writes.find(
      (item) =>
        item.ConditionCheck?.Key?.['pk'] === K.user(primary.userId) &&
        item.ConditionCheck.Key['sk'] === 'COVERAGE#FAMILY',
    )?.ConditionCheck;
    expect(payerCoverage?.ConditionExpression).toContain('paidThrough > :now');
    expect(payerCoverage?.ConditionExpression).toContain('graceUntil > :now');
  });

  it('denies an additional responsible whose current scope does not include that minor', async () => {
    const primary = profile('adult-primary', 'adult');
    const additional = profile('adult-additional', 'adult');
    const requester = profile('minor-z');
    const sibling = profile('minor-sibling');
    const recipient = profile('minor-a');
    const family = familyV2Fixture({
      now: NOW,
      primaryId: primary.userId,
      minorIds: [requester.userId, sibling.userId],
      additionalResponsibleSeat: 1,
      additionalId: additional.userId,
      additionalScope: [sibling.userId],
    });
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 2,
    } satisfies FriendshipItem;
    installReads([pending, primary, additional, requester, sibling, recipient], [family]);

    await expect(
      recordResponsibleApproval(ctxOf(additional), pending.requestId!, {
        minorId: requester.userId,
        commandId: 'out-of-scope-approval',
        policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSIBLE_SCOPE_REQUIRED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('uses four exact consent and both current family authorities in the activation transaction', async () => {
    const primaryA = profile('adult-primary-a', 'adult');
    const primaryB = profile('adult-primary-b', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
    const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 4,
    } satisfies FriendshipItem;
    const existing = [
      createMinorFriendConsent({
        friendship: pending,
        kind: 'requester_action',
        actorId: requester.userId,
        subjectMinorId: requester.userId,
        policyVersion: MINOR_SOCIAL_POLICY_VERSION,
        now: NOW - 900,
      }),
      createMinorFriendConsent({
        friendship: pending,
        kind: 'requester_responsible_approval',
        actorId: primaryA.userId,
        subjectMinorId: requester.userId,
        policyVersion: MINOR_SOCIAL_POLICY_VERSION,
        now: NOW - 800,
      }),
      createMinorFriendConsent({
        friendship: pending,
        kind: 'recipient_acceptance',
        actorId: recipient.userId,
        subjectMinorId: recipient.userId,
        policyVersion: MINOR_SOCIAL_POLICY_VERSION,
        now: NOW - 700,
      }),
    ];
    installReads(
      [
        pending,
        primaryA,
        primaryB,
        requester,
        recipient,
        ...existing,
        flags(),
        access(requester.userId),
        access(recipient.userId),
      ],
      [familyA, familyB],
    );

    const view = await recordResponsibleApproval(ctxOf(primaryB), pending.requestId!, {
      minorId: recipient.userId,
      commandId: 'recipient-primary-approves',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    expect(view.state).toBe('active');
    expect(view.revision).toBe(6);
    const activation = transaction(1);
    expect(activation.filter((item) => item.ConditionCheck?.Key?.['sk']?.startsWith('CONSENT#')))
      .toHaveLength(4);
    expect(activation.filter((item) => item.Put?.Item?.['sk']?.startsWith('FRIEND#')))
      .toHaveLength(2);
    expect(activation.find((item) => item.Update?.Key?.['sk'] === 'META')?.Update)
      .toMatchObject({
        ExpressionAttributeValues: expect.objectContaining({ ':pending': 'pending', ':active': 'active' }),
      });
    const householdKeys = new Set(
      activation.flatMap((item) =>
        item.ConditionCheck?.Key?.['pk']?.startsWith('HOUSEHOLD#') && item.ConditionCheck.Key['sk'] === 'META'
          ? [item.ConditionCheck.Key['pk']]
          : [],
      ),
    );
    expect(householdKeys).toEqual(new Set([familyA.household.pk, familyB.household.pk]));
  });

  it('also activates when the recipient acceptance is the fourth evidence', async () => {
    const primaryA = profile('adult-primary-a', 'adult');
    const primaryB = profile('adult-primary-b', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
    const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
    const pending = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      revision: 4,
    } satisfies FriendshipItem;
    const existing = [
      createMinorFriendConsent({ friendship: pending, kind: 'requester_action', actorId: requester.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 }),
      createMinorFriendConsent({ friendship: pending, kind: 'requester_responsible_approval', actorId: primaryA.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 800 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_responsible_approval', actorId: primaryB.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 700 }),
    ];
    installReads([
      pending,
      primaryA,
      primaryB,
      requester,
      recipient,
      ...existing,
      flags(),
      access(requester.userId),
      access(recipient.userId),
    ], [familyA, familyB]);

    const view = await recordMinorAcceptance(ctxOf(recipient), pending.requestId!, {
      minorId: recipient.userId,
      commandId: 'recipient-final-acceptance',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    expect(view).toMatchObject({ state: 'active', revision: 6 });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it('heals a pending request when all four consents already exist after a prior lost activation race', async () => {
    const primaryA = profile('adult-primary-a', 'adult');
    const primaryB = profile('adult-primary-b', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
    const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
    const pending = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      revision: 5,
    } satisfies FriendshipItem;
    const consents = [
      createMinorFriendConsent({ friendship: pending, kind: 'requester_action', actorId: requester.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 }),
      createMinorFriendConsent({ friendship: pending, kind: 'requester_responsible_approval', actorId: primaryA.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 800 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_acceptance', actorId: recipient.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 700 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_responsible_approval', actorId: primaryB.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 600 }),
    ];
    installReads([
      pending,
      primaryA,
      primaryB,
      requester,
      recipient,
      ...consents,
      flags(),
      access(requester.userId),
      access(recipient.userId),
    ], [familyA, familyB]);

    const view = await recordMinorAcceptance(ctxOf(recipient), pending.requestId!, {
      minorId: recipient.userId,
      commandId: 'retry-recipient-acceptance',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    expect(view).toMatchObject({ state: 'active', revision: 6 });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it.each(['minor-z', 'minor-a', 'adult-primary-a', 'adult-primary-b'])(
    'cannot activate a fully consented request while %s closes their account', async (closingId) => {
      const primaryA = profile('adult-primary-a', 'adult');
      const primaryB = profile('adult-primary-b', 'adult');
      const requester = profile('minor-z');
      const recipient = profile('minor-a');
      const participants = [requester, recipient, primaryA, primaryB];
      const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
      const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
      const pending = {
        ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
        revision: 5,
      } satisfies FriendshipItem;
      const consents = [
        createMinorFriendConsent({ friendship: pending, kind: 'requester_action', actorId: requester.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 }),
        createMinorFriendConsent({ friendship: pending, kind: 'requester_responsible_approval', actorId: primaryA.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 800 }),
        createMinorFriendConsent({ friendship: pending, kind: 'recipient_acceptance', actorId: recipient.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 700 }),
        createMinorFriendConsent({ friendship: pending, kind: 'recipient_responsible_approval', actorId: primaryB.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 600 }),
      ];
      installReads([
        pending, ...participants, ...consents, flags(), access(requester.userId), access(recipient.userId),
      ], [familyA, familyB]);
      let closing = false;
      const closingProfile = participants.find((person) => person.userId === closingId)!;
      ddbMock.on(GetCommand, { Key: K.profile(closingId) }).callsFake(() => ({
        Item: { ...closingProfile, status: closing ? 'closing' : 'active' },
      }));
      ddbMock.on(GetCommand, { Key: accountClosureKey(closingId) }).callsFake(() => ({
        Item: closing ? { ...accountClosureKey(closingId), state: 'requested' } : undefined,
      }));
      ddbMock.on(TransactWriteCommand).callsFake(() => {
        closing = true;
        throw Object.assign(new Error('account closure won the activation race'), { name: 'TransactionCanceledException' });
      });

      await expect(recordMinorAcceptance(ctxOf(recipient), pending.requestId!, {
        minorId: recipient.userId, commandId: 'accept-during-closure', policyVersion: MINOR_SOCIAL_POLICY_VERSION,
      })).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
      const activation = transaction(0);
      for (const participant of participants) {
        const guard = activation.find((item) => item.ConditionCheck?.Key?.['pk'] === K.user(participant.userId) && item.ConditionCheck.Key['sk'] === 'PROFILE')?.ConditionCheck;
        expect(guard?.ConditionExpression).toContain('#status = :active');
        expect(guard?.ConditionExpression).toContain(`#accountType = :${participant.accountType}`);
        expect(guard?.ExpressionAttributeValues?.[`:${participant.accountType}`]).toBe(participant.accountType);
        expect(activation).toContainEqual({ ConditionCheck: expect.objectContaining({
          Key: accountClosureKey(participant.userId),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }) });
      }
      expect(activation.filter((item) => item.ConditionCheck?.Key?.['sk']?.startsWith('CONSENT#'))).toHaveLength(4);
    },
  );

  it('converges two concurrent activation attempts to one active transition', async () => {
    const primaryA = profile('adult-primary-a', 'adult');
    const primaryB = profile('adult-primary-b', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
    const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
    const pending = {
      ...createPendingMinorFriendship({
        requesterId: requester.userId,
        recipientId: recipient.userId,
        requestCycleId: 'cycle-1',
        now: NOW - 1_000,
        expiresAt: NOW + 60_000,
      }),
      revision: 5,
    } satisfies FriendshipItem;
    const consents = [
      createMinorFriendConsent({ friendship: pending, kind: 'requester_action', actorId: requester.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 }),
      createMinorFriendConsent({ friendship: pending, kind: 'requester_responsible_approval', actorId: primaryA.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 800 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_acceptance', actorId: recipient.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 700 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_responsible_approval', actorId: primaryB.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 600 }),
    ];
    const dynamic = new Map<string, unknown>();
    for (const item of [pending, primaryA, primaryB, requester, recipient, ...consents, flags(), access(requester.userId), access(recipient.userId), ...familyA.coverages, ...familyB.coverages]) {
      const keyed = item as { pk: string; sk: string };
      dynamic.set(JSON.stringify({ pk: keyed.pk, sk: keyed.sk }), item);
    }
    installReads([...dynamic.values()], [familyA, familyB]);
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: dynamic.get(JSON.stringify(input.Key)) }));
    let activationCount = 0;
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
      const update = input.TransactItems?.find(
        (item: TransactionItem) => item.Update?.Key?.['sk'] === 'META',
      )?.Update;
      if (!update) return {};
      if (activationCount > 0) {
        const error = new Error('lost activation race');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      activationCount += 1;
      const active = { ...pending, state: 'active' as const, revision: 6, updatedAt: NOW, activatedAt: NOW };
      dynamic.set(JSON.stringify(SK.friendship(requester.userId, recipient.userId)), active);
      return {};
    });

    const outcomes = await Promise.all([
      minorSocialInternals.activateMinorFriendshipIfReady(ctxOf(recipient), pending, requester, recipient, consents),
      minorSocialInternals.activateMinorFriendshipIfReady(ctxOf(recipient), pending, requester, recipient, consents),
    ]);

    expect(activationCount).toBe(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((view) => view.state === 'active' && view.revision === 6)).toBe(true);
  });

  it('propagates an operational family lookup failure during activation', async () => {
    const primaryA = profile('adult-primary-a', 'adult');
    const primaryB = profile('adult-primary-b', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const familyA = familyV2Fixture({ now: NOW, primaryId: primaryA.userId, minorIds: [requester.userId] });
    const familyB = familyV2Fixture({ now: NOW, primaryId: primaryB.userId, minorIds: [recipient.userId] });
    const pending = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      revision: 5,
    } satisfies FriendshipItem;
    const consents = [
      createMinorFriendConsent({ friendship: pending, kind: 'requester_action', actorId: requester.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 900 }),
      createMinorFriendConsent({ friendship: pending, kind: 'requester_responsible_approval', actorId: primaryA.userId, subjectMinorId: requester.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 800 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_acceptance', actorId: recipient.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 700 }),
      createMinorFriendConsent({ friendship: pending, kind: 'recipient_responsible_approval', actorId: primaryB.userId, subjectMinorId: recipient.userId, policyVersion: MINOR_SOCIAL_POLICY_VERSION, now: NOW - 600 }),
    ];
    installReads([
      pending,
      primaryA,
      primaryB,
      requester,
      recipient,
      ...consents,
      ...familyA.coverages,
      ...familyB.coverages,
    ], [familyA, familyB]);
    ddbMock.on(QueryCommand).rejects(new Error('ddb family lookup unavailable'));

    await expect(
      minorSocialInternals.activateMinorFriendshipIfReady(
        ctxOf(recipient),
        pending,
        requester,
        recipient,
        consents,
      ),
    ).rejects.toThrow('ddb family lookup unavailable');
  });

  it('lets either participating minor reject a pending request without social capability', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const pending = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      revision: 3,
    } satisfies FriendshipItem;
    installReads([pending, requester, recipient]);

    await rejectMinorFriendRequest(ctxOf(requester), pending.requestId!, {
      minorId: requester.userId,
      commandId: 'requester-rejects',
      policyVersion: MINOR_SOCIAL_POLICY_VERSION,
    });

    const update = transaction(0).find((item) => item.Update?.Key?.['sk'] === 'META')?.Update;
    expect(update?.UpdateExpression).toContain('#state = :rejected');
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ':pending': 'pending',
      ':rejected': 'rejected',
      ':nextRevision': 4,
    });
  });

  it('lets a participating minor revoke the active relationship and both legacy mirrors', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const active = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      state: 'active' as const,
      revision: 6,
      updatedAt: NOW - 100,
      activatedAt: NOW - 100,
    } satisfies FriendshipItem;
    installReads([active, requester, recipient]);

    await revokeMinorFriendship(ctxOf(requester), active.friendshipId);

    const writes = transaction(0);
    const friendshipUpdate = writes.find((item) => item.Update?.Key?.['sk'] === 'META')?.Update;
    expect(friendshipUpdate?.ExpressionAttributeValues)
      .toMatchObject({ ':active': 'active', ':revoked': 'revoked', ':nextRevision': 7 });
    expect(friendshipUpdate?.ConditionExpression).toContain('createdAt = :createdAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('updatedAt = :updatedAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('expiresAt = :expiresAt');
    expect(friendshipUpdate?.ConditionExpression).toContain('endedAt = :endedAt');
    expect(writes.flatMap((item) => item.Delete ? [item.Delete.Key] : [])).toEqual(
      expect.arrayContaining([
        K.friend(requester.userId, recipient.userId),
        K.friend(recipient.userId, requester.userId),
      ]),
    );
  });

  it('lets the primary responsible revoke after paid coverage ends', async () => {
    const primary = profile('adult-primary', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const baseFamily = familyV2Fixture({
      now: NOW,
      primaryId: primary.userId,
      minorIds: [recipient.userId],
    });
    const family: FamilyV2Fixture = {
      ...baseFamily,
      coverages: baseFamily.coverages.filter(
        (coverage) => coverage.accountId !== primary.userId,
      ),
    };
    const active = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      state: 'active' as const,
      revision: 6,
      updatedAt: NOW - 100,
      activatedAt: NOW - 100,
    } satisfies FriendshipItem;
    installReads([active, primary], [family]);

    await revokeMinorFriendship(ctxOf(primary), active.friendshipId);

    const writes = transaction(0);
    expect(writes).toContainEqual(expect.objectContaining({
      ConditionCheck: expect.objectContaining({
        Key: expect.objectContaining({
          pk: K.user(recipient.userId),
          sk: `SUPERVISION#${primary.userId}`,
        }),
      }),
    }));
    expect(writes.some((item) =>
      item.ConditionCheck?.Key?.['pk'] === K.user(primary.userId) &&
      item.ConditionCheck?.Key?.['sk'] === 'COVERAGE#FAMILY'
    )).toBe(false);
  });

  it('refuses to revoke an active row that already carries a terminal marker', async () => {
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const malformed = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      state: 'active' as const,
      revision: 6,
      updatedAt: NOW - 100,
      activatedAt: NOW - 100,
      endedAt: NOW - 50,
    } satisfies FriendshipItem;
    installReads([malformed]);

    await expect(revokeMinorFriendship(ctxOf(requester), malformed.friendshipId))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('propagates an operational family lookup failure while a responsible adult revokes', async () => {
    const primary = profile('adult-primary', 'adult');
    const requester = profile('minor-z');
    const recipient = profile('minor-a');
    const family = familyV2Fixture({ now: NOW, primaryId: primary.userId, minorIds: [recipient.userId] });
    const active = {
      ...createPendingMinorFriendship({ requesterId: requester.userId, recipientId: recipient.userId, requestCycleId: 'cycle-1', now: NOW - 1_000, expiresAt: NOW + 60_000 }),
      state: 'active' as const,
      revision: 6,
      updatedAt: NOW - 100,
      activatedAt: NOW - 100,
    } satisfies FriendshipItem;
    installReads([active, primary, ...family.coverages], [family]);
    ddbMock.on(QueryCommand).rejects(new Error('ddb supervision unavailable'));

    await expect(revokeMinorFriendship(ctxOf(primary), active.friendshipId))
      .rejects.toThrow('ddb supervision unavailable');
  });
});
