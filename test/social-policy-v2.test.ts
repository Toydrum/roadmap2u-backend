import { describe, expect, it } from 'vitest';
import {
  assignSeat,
  createCoverageAssignment,
  createEmptySeatAssignments,
  createHousehold,
  createSupervisionLink,
  type CoverageAssignmentItem,
  type HouseholdSnapshot,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../lambda/family/model';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

type SocialPolicyModule = {
  authorizeFriendRequest(input: unknown): unknown;
  authorizeForestVisit(input: unknown): unknown;
};

async function loadPolicy(): Promise<SocialPolicyModule | null> {
  const modulePath = '../lambda/social/' + 'policy';
  return import(modulePath).catch(() => null) as Promise<SocialPolicyModule | null>;
}

const person = (
  accountId: string,
  accountType: 'adult' | 'minor',
  options: {
    socialEnabled?: boolean;
    status?: 'active' | 'closing';
    majorityAt?: string;
  } = {},
) => ({
  accountId,
  accountType,
  socialEnabled: options.socialEnabled ?? true,
  status: options.status ?? 'active',
  ...(options.majorityAt ? { majorityAt: options.majorityAt } : {}),
});

function familyFixture(): HouseholdSnapshot {
  const household = createHousehold({ primaryResponsibleId: 'adult-primary', now: NOW - 100 });
  const seats: SeatAssignmentItem[] = [
    ...createEmptySeatAssignments(household.householdId, NOW - 100),
  ];
  seats[0] = assignSeat(seats[0], 'minor-a', 1, NOW - 90);
  seats[1] = assignSeat(seats[1], 'minor-b', 1, NOW - 90);
  seats[2] = assignSeat(seats[2], 'adult-additional', 1, NOW - 90);
  const supervisionLinks: SupervisionLinkItem[] = [
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-primary',
      minorId: 'minor-a',
      role: 'primary_responsible',
      now: NOW - 90,
    }),
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-primary',
      minorId: 'minor-b',
      role: 'primary_responsible',
      now: NOW - 90,
    }),
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-additional',
      minorId: 'minor-a',
      role: 'additional_responsible',
      now: NOW - 90,
    }),
  ];
  const coverages: CoverageAssignmentItem[] = [
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-primary',
      seatType: 'primary_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW - 90,
    }),
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-additional',
      seatType: 'additional_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW - 90,
    }),
    ...['minor-a', 'minor-b'].map((accountId) =>
      createCoverageAssignment({
        householdId: household.householdId,
        accountId,
        seatType: 'minor',
        paidThrough: NOW + 86_400_000,
        now: NOW - 90,
      }),
    ),
  ];
  return { household, seats, supervisionLinks, coverages };
}

const friendship = (
  userA: string,
  userB: string,
  friendshipClass: 'adult_adult' | 'minor_minor',
  state: 'active' | 'revoked' = 'active',
) => ({ friendshipId: [userA, userB].sort().join('~'), userA, userB, friendshipClass, state });

describe('social policy v2', () => {
  it.each([
    ['adult', 'adult', { allowed: true, friendshipClass: 'adult_adult' }],
    ['minor', 'minor', { allowed: true, friendshipClass: 'minor_minor' }],
    ['adult', 'minor', { allowed: false, code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' }],
    ['minor', 'adult', { allowed: false, code: 'ADULT_MINOR_FRIENDSHIP_FORBIDDEN' }],
  ] as const)('classifies %s to %s without a third account class', async (left, right, expected) => {
    const policy = await loadPolicy();
    expect(policy?.authorizeFriendRequest).toBeTypeOf('function');
    expect(
      policy!.authorizeFriendRequest({
        actor: person('actor', left),
        target: person('target', right),
        action: 'create',
        now: NOW,
      }),
    ).toEqual(expected);
  });

  it('allows an adult friendship only over the exact two adult forests', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');
    const direct = friendship('adult-friend', 'adult-primary', 'adult_adult');
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-friend', 'adult'),
        target: person('adult-primary', 'adult'),
        friendship: direct,
        household: familyFixture(),
        now: NOW,
      }),
    ).toEqual({ allowed: true, relationship: 'adult_friend' });
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-friend', 'adult'),
        target: person('adult-additional', 'adult'),
        friendship: direct,
        household: familyFixture(),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-friend', 'adult'),
        target: person('minor-a', 'minor'),
        friendship: direct,
        household: familyFixture(),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('rejects a friendship row whose id is not the canonical pair of its endpoints', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-a', 'adult'),
        target: person('adult-b', 'adult'),
        friendship: {
          ...friendship('adult-a', 'adult-b', 'adult_adult'),
          friendshipId: 'adult-a~adult-c',
        },
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('limits an additional responsible to the exact minor scope', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');
    const snapshot = familyFixture();
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-additional', 'adult'),
        target: person('minor-a', 'minor'),
        household: snapshot,
        now: NOW,
      }),
    ).toEqual({ allowed: true, relationship: 'additional_supervision' });
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-additional', 'adult'),
        target: person('minor-b', 'minor'),
        household: snapshot,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('ends responsible forest access at the declared majority boundary', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');

    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-primary', 'adult'),
        target: person('minor-a', 'minor', { majorityAt: '2026-08-31' }),
        household: familyFixture(),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('hides a supervised forest as soon as the minor account starts closing', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');

    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-primary', 'adult'),
        target: person('minor-a', 'minor', { status: 'closing', majorityAt: '2030-01-01' }),
        household: familyFixture(),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('blocks create, accept and visit when social is off but permits cleanup', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeFriendRequest).toBeTypeOf('function');
    const actor = person('adult-a', 'adult', { socialEnabled: false });
    const target = person('adult-b', 'adult');
    for (const action of ['create', 'accept'] as const) {
      expect(policy!.authorizeFriendRequest({ actor, target, action, now: NOW })).toEqual({
        allowed: false,
        code: 'FORBIDDEN',
      });
    }
    for (const action of ['remove', 'decline', 'cancel'] as const) {
      expect(policy!.authorizeFriendRequest({ actor, target, action, now: NOW })).toEqual({
        allowed: true,
        friendshipClass: 'adult_adult',
      });
    }
    expect(
      policy!.authorizeForestVisit({
        actor,
        target,
        friendship: friendship('adult-a', 'adult-b', 'adult_adult'),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('blocks new social authority during account closure but permits removal', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeFriendRequest).toBeTypeOf('function');
    const actor = person('adult-a', 'adult', { status: 'closing' });
    const target = person('adult-b', 'adult');
    expect(policy!.authorizeFriendRequest({ actor, target, action: 'create', now: NOW })).toEqual({
      allowed: false,
      code: 'CONFLICT',
    });
    expect(policy!.authorizeFriendRequest({ actor, target, action: 'remove', now: NOW })).toEqual({
      allowed: true,
      friendshipClass: 'adult_adult',
    });
  });

  it('fails closed once a minor has reached the declared majority boundary', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeFriendRequest).toBeTypeOf('function');
    expect(
      policy!.authorizeFriendRequest({
        actor: person('minor-a', 'minor', { majorityAt: '2026-08-31' }),
        target: person('minor-b', 'minor', { majorityAt: '2030-01-01' }),
        action: 'create',
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'CONFLICT' });
  });

  it('rejects foreign friendship ids and revoked supervision links without enumeration', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-a', 'adult'),
        target: person('adult-b', 'adult'),
        friendship: friendship('adult-a', 'adult-foreign', 'adult_adult'),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });

    const snapshot = familyFixture();
    const links = [...snapshot.supervisionLinks];
    const index = links.findIndex(
      (link) => link.adultId === 'adult-additional' && link.minorId === 'minor-a',
    );
    links[index] = {
      ...links[index],
      state: 'revoked',
      revision: 2,
      validUntil: NOW - 1,
      updatedAt: NOW - 1,
    };
    links.push(
      createSupervisionLink({
        householdId: snapshot.household.householdId,
        adultId: 'adult-additional',
        minorId: 'minor-b',
        role: 'additional_responsible',
        now: NOW - 1,
      }),
    );
    const revokedSnapshot = { ...snapshot, supervisionLinks: links };
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-additional', 'adult'),
        target: person('minor-a', 'minor'),
        household: revokedSnapshot,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
    expect(
      policy!.authorizeForestVisit({
        actor: person('adult-additional', 'adult'),
        target: person('minor-foreign', 'minor'),
        household: revokedSnapshot,
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('allows minor forest visits only through an exact active minor friendship', async () => {
    const policy = await loadPolicy();
    expect(policy?.authorizeForestVisit).toBeTypeOf('function');
    const actor = person('minor-a', 'minor', { majorityAt: '2030-01-01' });
    const target = person('minor-b', 'minor', { majorityAt: '2031-01-01' });
    expect(
      policy!.authorizeForestVisit({
        actor,
        target,
        friendship: friendship('minor-a', 'minor-b', 'minor_minor'),
        now: NOW,
      }),
    ).toEqual({ allowed: true, relationship: 'minor_friend' });
    expect(
      policy!.authorizeForestVisit({
        actor,
        target,
        friendship: friendship('minor-a', 'minor-b', 'minor_minor', 'revoked'),
        now: NOW,
      }),
    ).toEqual({ allowed: false, code: 'NOT_FOUND' });
  });
});
