import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Ctx } from '../lambda/authz';
import type { CodeItem, Deps, LinkItem, ProfileItem } from '../lambda/db';
import { K } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import {
  assignSeat,
  createCoverageAssignment,
  createEmptySeatAssignments,
  createFamilyEntitlement,
  createHousehold,
  createSupervisionLink,
  type CoverageAssignmentItem,
  type FamilyEntitlementItem,
  type HouseholdItem,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../lambda/family/model';
import { acceptFamilyInvite, createChild, exportChild } from '../lambda/handlers/family';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

interface FamilyFixture {
  household: HouseholdItem;
  seats: SeatAssignmentItem[];
  supervisionLinks: SupervisionLinkItem[];
  coverages: CoverageAssignmentItem[];
  entitlement: FamilyEntitlementItem;
  profiles: Map<string, ProfileItem>;
}

function profile(userId: string, accountType: 'adult' | 'minor' = 'adult'): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId.replace(/[^a-z0-9_]/g, '_'),
    displayName: userId,
    accountType,
    socialEnabled: accountType === 'adult',
    createdAt: NOW - 10_000,
    status: 'active',
    ...(accountType === 'adult' ? { familyFenceVersion: 1 as const } : {}),
  };
}

function family(input: {
  primaryId: string;
  minorIds?: readonly string[];
  additionalSeat?: 0 | 1;
}): FamilyFixture {
  const minorIds = input.minorIds ?? [];
  const household = createHousehold({ primaryResponsibleId: input.primaryId, now: NOW - 5_000 });
  const seats: SeatAssignmentItem[] = [...createEmptySeatAssignments(household.householdId, NOW - 5_000)];
  const supervisionLinks: SupervisionLinkItem[] = [];
  const coverages: CoverageAssignmentItem[] = [
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: input.primaryId,
      seatType: 'primary_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW - 4_000,
    }),
  ];
  const profiles = new Map<string, ProfileItem>([[input.primaryId, profile(input.primaryId)]]);

  for (const [index, minorId] of minorIds.entries()) {
    seats[index] = assignSeat(seats[index]!, minorId, 1, NOW - 4_000);
    supervisionLinks.push(
      createSupervisionLink({
        householdId: household.householdId,
        adultId: input.primaryId,
        minorId,
        role: 'primary_responsible',
        now: NOW - 4_000,
      }),
    );
    coverages.push(
      createCoverageAssignment({
        householdId: household.householdId,
        accountId: minorId,
        seatType: 'minor',
        paidThrough: NOW + 86_400_000,
        now: NOW - 4_000,
      }),
    );
    profiles.set(minorId, profile(minorId, 'minor'));
  }

  return {
    household,
    seats,
    supervisionLinks,
    coverages,
    entitlement: createFamilyEntitlement({
      householdId: household.householdId,
      offerKey: input.additionalSeat === 1
        ? minorIds.length > 1
          ? 'family_2_minors_1_additional_responsible'
          : 'family_1_minor_1_additional_responsible'
        : minorIds.length > 1
          ? 'family_2_minors'
          : 'family_1_minor',
      paidThrough: NOW + 86_400_000,
      now: NOW - 4_000,
      source: 'test_seed',
    }),
    profiles,
  };
}

function legacyLink(guardianId: string, minorId: string, kind: LinkItem['kind']): LinkItem {
  return {
    ...K.link(minorId, guardianId),
    gsi1pk: K.user(guardianId),
    gsi1sk: `MINOR#${minorId}`,
    linkId: `${guardianId}~${minorId}`,
    kind,
    guardianId,
    minorId,
    createdAt: NOW - 3_000,
  };
}

function context(caller: ProfileItem): Ctx {
  const deps: Deps = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
  return {
    callerId: caller.userId,
    caller,
    authenticatedAt: NOW - 60_000,
    deps,
  };
}

function installReads(input: {
  families: readonly FamilyFixture[];
  extraProfiles?: readonly ProfileItem[];
  legacyLinks?: readonly LinkItem[];
  codeItem?: CodeItem;
}): void {
  const legacyLinks = [...(input.legacyLinks ?? [])];
  const profiles = new Map<string, ProfileItem>();
  const coverages: CoverageAssignmentItem[] = [];
  const supervisionLinks: SupervisionLinkItem[] = [];
  for (const current of input.families) {
    for (const [id, item] of current.profiles) profiles.set(id, item);
    coverages.push(...current.coverages);
    supervisionLinks.push(...current.supervisionLinks);
  }
  for (const item of input.extraProfiles ?? []) profiles.set(item.userId, item);

  ddbMock.on(QueryCommand).callsFake((command) => {
    const values = command.ExpressionAttributeValues as Record<string, string> | undefined;
    const pk = values?.[':pk'];
    const prefix = values?.[':prefix'] ?? '';
    if (command.IndexName === 'gsi1') {
      return {
        Items: legacyLinks.filter(
          (item) => item.gsi1pk === pk && item.gsi1sk.startsWith(prefix),
        ),
      };
    }
    for (const current of input.families) {
      if (pk === FK.household(current.household.householdId).pk) {
        return { Items: [current.household, ...current.seats] };
      }
    }
    if (typeof pk === 'string' && pk.startsWith('USER#')) {
      return {
        Items: [...supervisionLinks, ...legacyLinks].filter(
          (item) => item.pk === pk && item.sk.startsWith(prefix),
        ),
      };
    }
    return { Items: [] };
  });

  ddbMock.on(BatchGetCommand).callsFake((command) => {
    const keys = (command.RequestItems?.['roadmap']?.Keys ?? []) as Array<{
      pk: string;
      sk: string;
    }>;
    return {
      Responses: {
        roadmap: coverages.filter((coverage) =>
          keys.some((key) => key.pk === coverage.pk && key.sk === coverage.sk),
        ),
      },
    };
  });

  ddbMock.on(GetCommand).callsFake((command) => {
    const key = command.Key as { pk: string; sk: string };
    if (key.sk.startsWith('RATE#codes#')) return {};
    if (input.codeItem && key.pk === input.codeItem.pk && key.sk === input.codeItem.sk) {
      return { Item: input.codeItem };
    }
    const oldLink = legacyLinks.find((item) => item.pk === key.pk && item.sk === key.sk);
    if (oldLink) return { Item: oldLink };
    if (key.sk === 'PROFILE') {
      const item = profiles.get(key.pk.slice('USER#'.length));
      return item ? { Item: item } : {};
    }
    if (key.sk === 'COVERAGE#FAMILY') {
      const item = coverages.find((coverage) => coverage.pk === key.pk && coverage.sk === key.sk);
      return item ? { Item: item } : {};
    }
    for (const current of input.families) {
      if (
        key.pk === FK.familyEntitlement(current.household.householdId).pk &&
        key.sk === FK.familyEntitlement(current.household.householdId).sk
      ) {
        return { Item: current.entitlement };
      }
    }
    return {};
  });
  ddbMock.on(TransactWriteCommand).resolves({});
}

function transaction(index = 0) {
  return ddbMock.commandCalls(TransactWriteCommand)[index]?.args[0].input.TransactItems ?? [];
}

function puts(index = 0): Array<Record<string, unknown>> {
  return transaction(index).flatMap((item) =>
    item.Put?.Item ? [item.Put.Item as Record<string, unknown>] : [],
  );
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('family legacy adapter', () => {
  it('rejects legacy identity administration by a former v2 primary', async () => {
    const current = family({ primaryId: 'adult-current', minorIds: ['minor-a'] });
    const former = profile('adult-former');
    const staleLink = legacyLink('adult-former', 'minor-a', 'created');
    installReads({
      families: [current],
      extraProfiles: [former],
      legacyLinks: [staleLink],
    });

    await expect(exportChild(context(former), 'minor-a')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('authorizes the current v2 primary even when its legacy compatibility link is invited', async () => {
    const current = family({ primaryId: 'adult-current', minorIds: ['minor-a'] });
    const compatibilityLink = legacyLink('adult-current', 'minor-a', 'invited');
    installReads({ families: [current], legacyLinks: [compatibilityLink] });

    await expect(exportChild(context(current.profiles.get('adult-current')!), 'minor-a'))
      .resolves.toMatchObject({
        app: 'roadmap2u',
        data: {
          trees: [],
          nodes: [],
        },
      });
  });

  it('reserves at most five concurrent legacy invite lookups atomically', async () => {
    const home = family({ primaryId: 'adult-primary' });
    installReads({ families: [home] });
    const rateKey = K.rate('adult-primary', Math.floor(NOW / 3_600_000));
    let reservations = 0;
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      const rateUpdate = input.TransactItems?.find((item) =>
        item.Update?.Key?.['pk'] === rateKey.pk && item.Update.Key['sk'] === rateKey.sk
      )?.Update;
      if (!rateUpdate) return {};
      if (reservations >= 5) {
        throw Object.assign(new Error('rate limit reached'), {
          name: 'TransactionCanceledException',
        });
      }
      reservations += 1;
      return {};
    });

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async (_, attempt) => {
        try {
          await acceptFamilyInvite(context(home.profiles.get('adult-primary')!), {
            code: `RACE00${attempt}`,
          });
          return 'OK';
        } catch (error) {
          return (error as { code?: string; name?: string }).code ??
            (error as { name?: string }).name ??
            'UNKNOWN';
        }
      }),
    );

    expect(outcomes.sort()).toEqual([
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'RATE_LIMITED',
    ]);
    const codeReads = ddbMock.commandCalls(GetCommand).filter((call) =>
      (call.args[0].input.Key as { pk?: string } | undefined)?.pk?.startsWith('CODE#G#'),
    );
    expect(codeReads).toHaveLength(5);
    expect(reservations).toBe(5);
  });

  it('creates legacy children through v2 authority without fabricating consent evidence', async () => {
    const home = family({ primaryId: 'adult-primary' });
    installReads({ families: [home] });
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'minor-new' }] },
    });

    const result = await createChild(context(home.profiles.get('adult-primary')!), {
      username: 'child_one',
      displayName: 'Child One',
    });

    expect(result).toMatchObject({
      child: {
        userId: 'minor-new',
        username: 'child_one',
        displayName: 'Child One',
        accountType: 'minor',
      },
      tempPassword: expect.any(String),
    });
    expect(puts()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'SupervisionLink',
        householdId: home.household.householdId,
        adultId: 'adult-primary',
        minorId: 'minor-new',
        role: 'primary_responsible',
      }),
      expect.objectContaining({
        entityType: 'CoverageAssignment',
        householdId: home.household.householdId,
        accountId: 'minor-new',
        seatType: 'minor',
      }),
      expect.objectContaining({
        ...K.link('minor-new', 'adult-primary'),
        kind: 'created',
      }),
    ]));
    expect(puts().some((item) => item['entityType'] === 'MinorConsentAcceptance')).toBe(false);
    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.minorSeat(home.household.householdId, 1),
        }),
      }),
    ]));
  });

  it('maps a redeemed coGuardian code to one scoped additional responsible and an invited legacy link', async () => {
    const home = family({
      primaryId: 'adult-primary',
      minorIds: ['minor-a'],
      additionalSeat: 1,
    });
    const additional = profile('adult-additional');
    const issuerLink = legacyLink('adult-primary', 'minor-a', 'created');
    const codeItem: CodeItem = {
      ...K.codeG('COGUARD1'),
      code: 'COGUARD1',
      kind: 'coGuardian',
      userId: 'adult-primary',
      minorId: 'minor-a',
      closureMirrorVersion: 1,
      expiresAt: NOW + 86_400_000,
      ttl: Math.ceil((NOW + 86_400_000) / 1_000),
    };
    installReads({
      families: [home],
      extraProfiles: [additional],
      legacyLinks: [issuerLink],
      codeItem,
    });

    const result = await acceptFamilyInvite(context(additional), { code: codeItem.code });

    expect(result).toMatchObject({
      kind: 'invited',
      user: { userId: 'minor-a', accountType: 'minor' },
    });
    expect(puts(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'SupervisionLink',
        householdId: home.household.householdId,
        adultId: 'adult-additional',
        minorId: 'minor-a',
        role: 'additional_responsible',
      }),
      expect.objectContaining({
        entityType: 'CoverageAssignment',
        accountId: 'adult-additional',
        seatType: 'additional_responsible',
      }),
      expect.objectContaining({
        ...K.link('minor-a', 'adult-additional'),
        kind: 'invited',
      }),
    ]));
    expect(transaction(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.additionalSeat(home.household.householdId),
        }),
      }),
    ]));
  });

  it('turns linkExisting redemption into a pending request without granting authority', async () => {
    const source = family({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = family({ primaryId: 'adult-target' });
    const sourceLegacyLink = legacyLink('adult-source', 'minor-a', 'created');
    const codeItem: CodeItem = {
      ...K.codeG('LINKOLD1'),
      code: 'LINKOLD1',
      kind: 'linkExisting',
      userId: 'adult-target',
      closureMirrorVersion: 1,
      expiresAt: NOW + 86_400_000,
      ttl: Math.ceil((NOW + 86_400_000) / 1_000),
    };
    installReads({
      families: [source, target],
      legacyLinks: [sourceLegacyLink],
      codeItem,
    });

    const result = await acceptFamilyInvite(context(source.profiles.get('minor-a')!), {
      code: codeItem.code,
    });

    expect(result).toMatchObject({
      kind: 'invited',
      user: { userId: 'adult-target', accountType: 'adult' },
    });
    expect(puts(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'FamilyNotice',
        kind: 'minor_link_request',
        state: 'pending',
        householdId: target.household.householdId,
        sourceHouseholdId: source.household.householdId,
        sourcePrimaryId: 'adult-source',
        minorId: 'minor-a',
      }),
    ]));
    expect(puts(1).some((item) =>
      item['pk'] === K.link('minor-a', 'adult-target').pk &&
      item['sk'] === K.link('minor-a', 'adult-target').sk
    )).toBe(false);
    expect(puts(1).some((item) => item['entityType'] === 'SupervisionLink')).toBe(false);
    expect(transaction(1).some((item) =>
      item.Update?.Key?.['sk'] === 'SEAT#MINOR#1' ||
      item.Update?.Key?.['sk'] === 'SEAT#MINOR#2' ||
      item.Update?.Key?.['sk'] === 'COVERAGE#FAMILY'
    )).toBe(false);
  });
});
