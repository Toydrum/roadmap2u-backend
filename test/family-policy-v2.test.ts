import { describe, expect, it } from 'vitest';
import {
  assignSeat,
  createCoverageAssignment,
  createEmptySeatAssignments,
  createHousehold,
  createSupervisionLink,
  type CoverageAssignmentItem,
  type HouseholdItem,
  type HouseholdSnapshot,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../lambda/family/model';

const NOW = 1_800_000_000_000;

type PolicyModule = {
  authorizeFamilyAction: (input: unknown) => unknown;
};

async function loadPolicy(): Promise<PolicyModule | null> {
  const modulePath = '../lambda/family/' + 'policy';
  return import(modulePath).catch(() => null) as Promise<PolicyModule | null>;
}

interface MutableHouseholdSnapshot {
  household: HouseholdItem;
  seats: SeatAssignmentItem[];
  supervisionLinks: SupervisionLinkItem[];
  coverages: CoverageAssignmentItem[];
}

function familyFixture(): MutableHouseholdSnapshot {
  const household = createHousehold({ primaryResponsibleId: 'adult-primary', now: NOW });
  const seats: SeatAssignmentItem[] = [
    ...createEmptySeatAssignments(household.householdId, NOW),
  ];
  seats[0] = assignSeat(seats[0], 'minor-a', 1, NOW + 1);
  seats[1] = assignSeat(seats[1], 'minor-b', 1, NOW + 1);
  seats[2] = assignSeat(seats[2], 'adult-additional', 1, NOW + 1);

  const supervisionLinks: SupervisionLinkItem[] = [
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-primary',
      minorId: 'minor-a',
      role: 'primary_responsible',
      now: NOW + 1,
    }),
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-primary',
      minorId: 'minor-b',
      role: 'primary_responsible',
      now: NOW + 1,
    }),
    createSupervisionLink({
      householdId: household.householdId,
      adultId: 'adult-additional',
      minorId: 'minor-a',
      role: 'additional_responsible',
      now: NOW + 1,
    }),
  ];

  const coverages: CoverageAssignmentItem[] = [
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-primary',
      seatType: 'primary_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    }),
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'minor-a',
      seatType: 'minor',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    }),
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'minor-b',
      seatType: 'minor',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    }),
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-additional',
      seatType: 'additional_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    }),
  ];

  return { household, seats, supervisionLinks, coverages };
}

const actor = (
  accountId: string,
  accountType: 'adult' | 'minor',
  status: 'active' | 'closing' = 'active',
) => ({ accountId, accountType, status, socialEnabled: true });

async function authorize(
  overrides: Record<string, unknown> = {},
  snapshot: HouseholdSnapshot = familyFixture(),
) {
  const policy = await loadPolicy();
  expect(policy?.authorizeFamilyAction).toBeTypeOf('function');
  return policy?.authorizeFamilyAction({
    actor: actor('adult-primary', 'adult'),
    action: 'read_household',
    household: snapshot,
    expectedHouseholdRevision: snapshot.household.revision,
    now: NOW + 2,
    ...overrides,
  });
}

describe('family authorization policy v2', () => {
  it('grants the primary responsible every administrative action', async () => {
    for (const action of [
      'read_household',
      'create_minor',
      'approve_minor_link',
      'invite_additional_responsible',
      'replace_additional_scope',
      'revoke_additional_responsible',
      'transfer_primary_responsibility',
    ]) {
      await expect(
        authorize({ action, targetAccountId: action.includes('minor') ? 'minor-a' : undefined }),
      ).resolves.toEqual({ allowed: true, actorRole: 'primary_responsible' });
    }
  });

  it('preserves primary safety actions even without paid family coverage', async () => {
    const snapshot = familyFixture();
    snapshot.coverages = snapshot.coverages.filter(
      (coverage) => coverage.accountId !== 'adult-primary',
    );

    for (const action of [
      'manage_minor_recovery',
      'revoke_minor_friendship',
      'export_minor',
      'delete_minor',
    ]) {
      await expect(
        authorize({ action, targetAccountId: 'minor-a' }, snapshot),
      ).resolves.toEqual({ allowed: true, actorRole: 'primary_responsible' });
    }
  });

  it('limits an additional responsible to covered minors in the assigned scope', async () => {
    await expect(
      authorize({
        actor: actor('adult-additional', 'adult'),
        action: 'accompany_minor_forest',
        targetAccountId: 'minor-a',
      }),
    ).resolves.toEqual({ allowed: true, actorRole: 'additional_responsible' });

    await expect(
      authorize({
        actor: actor('adult-additional', 'adult'),
        action: 'approve_minor_friendship',
        targetAccountId: 'minor-b',
      }),
    ).resolves.toEqual({ allowed: false, code: 'RESPONSIBLE_SCOPE_REQUIRED' });
  });

  it('lets the exact additional adult accept, but never initiate, a primary transfer', async () => {
    await expect(
      authorize({
        actor: actor('adult-additional', 'adult'),
        action: 'accept_primary_transfer',
        targetAccountId: 'adult-additional',
      }),
    ).resolves.toEqual({ allowed: true, actorRole: 'additional_responsible' });

    await expect(
      authorize({
        actor: actor('adult-additional', 'adult'),
        action: 'transfer_primary_responsibility',
        targetAccountId: 'adult-additional',
      }),
    ).resolves.toEqual({ allowed: false, code: 'FORBIDDEN' });

    await expect(
      authorize({
        actor: actor('adult-additional', 'adult'),
        action: 'accept_primary_transfer',
        targetAccountId: 'adult-other',
      }),
    ).resolves.toEqual({ allowed: false, code: 'FORBIDDEN' });
  });

  it('revokes additional authority when the paid seat ends', async () => {
    const snapshot = familyFixture();
    snapshot.coverages = snapshot.coverages.map((coverage) =>
      coverage.accountId === 'adult-additional'
        ? { ...coverage, state: 'ended', paidThrough: NOW, updatedAt: NOW + 2 }
        : coverage,
    );

    await expect(
      authorize(
        {
          actor: actor('adult-additional', 'adult'),
          action: 'accompany_minor_forest',
          targetAccountId: 'minor-a',
        },
        snapshot,
      ),
    ).resolves.toEqual({ allowed: false, code: 'PAYMENT_REQUIRED' });
  });

  it('does not revive a revoked supervision link from stale role claims', async () => {
    const snapshot = familyFixture();
    snapshot.supervisionLinks = snapshot.supervisionLinks.map((link) =>
      link.role === 'additional_responsible'
        ? {
            ...link,
            state: 'revoked',
            revision: link.revision + 1,
            validUntil: NOW + 2,
            updatedAt: NOW + 2,
          }
        : link,
    );
    snapshot.supervisionLinks = [
      ...snapshot.supervisionLinks,
      createSupervisionLink({
        householdId: snapshot.household.householdId,
        adultId: 'adult-additional',
        minorId: 'minor-b',
        role: 'additional_responsible',
        now: NOW + 2,
      }),
    ];

    await expect(
      authorize(
        {
          actor: actor('adult-additional', 'adult'),
          action: 'accompany_minor_forest',
          targetAccountId: 'minor-a',
        },
        snapshot,
      ),
    ).resolves.toEqual({ allowed: false, code: 'RESPONSIBLE_SCOPE_REQUIRED' });
  });

  it('lets a minor use only self-service forest actions', async () => {
    await expect(
      authorize({
        actor: actor('minor-a', 'minor'),
        action: 'read_household',
      }),
    ).resolves.toEqual({ allowed: true, actorRole: 'minor_self' });

    await expect(
      authorize({
        actor: actor('minor-a', 'minor'),
        action: 'accompany_minor_forest',
        targetAccountId: 'minor-a',
      }),
    ).resolves.toEqual({ allowed: true, actorRole: 'minor_self' });

    await expect(
      authorize({
        actor: actor('minor-a', 'minor'),
        action: 'approve_minor_friendship',
        targetAccountId: 'minor-a',
      }),
    ).resolves.toEqual({ allowed: false, code: 'FORBIDDEN' });
  });

  it('does not inherit household access from an adult friendship', async () => {
    await expect(
      authorize({
        actor: actor('adult-friend', 'adult'),
        action: 'read_household',
      }),
    ).resolves.toEqual({ allowed: false, code: 'FORBIDDEN' });
  });

  it('hides foreign household minors from every family role', async () => {
    await expect(
      authorize({ action: 'manage_minor_recovery', targetAccountId: 'minor-foreign' }),
    ).resolves.toEqual({ allowed: false, code: 'NOT_FOUND' });
  });

  it('rejects stale household revisions before evaluating permissions', async () => {
    await expect(
      authorize({ expectedHouseholdRevision: 99 }),
    ).resolves.toEqual({ allowed: false, code: 'STALE_REVISION' });
  });

  it('rejects incompatible account types and closing accounts', async () => {
    await expect(
      authorize({ actor: actor('adult-primary', 'minor') }),
    ).resolves.toEqual({ allowed: false, code: 'ACCOUNT_TYPE_INCOMPATIBLE' });

    await expect(
      authorize({ actor: actor('adult-primary', 'adult', 'closing') }),
    ).resolves.toEqual({ allowed: false, code: 'CONFLICT' });
  });
});
