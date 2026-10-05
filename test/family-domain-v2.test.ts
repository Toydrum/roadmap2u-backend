import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
  assignSeat as assignFamilySeat,
  createCoverageAssignment as newCoverageAssignment,
  createEmptySeatAssignments as newEmptySeatAssignments,
  createFamilyEntitlement,
  createHousehold as newHousehold,
  createMinorConsentAcceptance,
  createPrimaryTransferProposal,
  createSupervisionLink as newSupervisionLink,
  familyEntitlementAllows,
  transferPrimaryResponsibility,
  validateHouseholdSnapshot as assertValidHouseholdSnapshot,
  type CoverageAssignmentItem,
  type AdditionalResponsibleSeatAssignmentItem,
  type HouseholdItem,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../lambda/family/model';
import { FK, householdIdForPrimary } from '../lambda/family/keys';
import { authorizeFamilyAction } from '../lambda/family/policy';
import {
  buildAssignMinorTransaction,
  buildTransferPrimaryTransaction,
  classifyFamilyTransactionCancellation,
  readHouseholdSnapshot,
} from '../lambda/family/repository';

const NOW = 1_800_000_000_000;
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

interface MutableHouseholdSnapshot {
  household: HouseholdItem;
  seats: SeatAssignmentItem[];
  supervisionLinks: SupervisionLinkItem[];
  coverages: CoverageAssignmentItem[];
}

function householdFixture(input?: {
  minorIds?: readonly string[];
  additionalResponsibleId?: string;
  additionalScope?: readonly string[];
}): MutableHouseholdSnapshot {
  const minorIds = input?.minorIds ?? ['minor-a'];
  const household = newHousehold({ primaryResponsibleId: 'adult-a', now: NOW });
  const seats: SeatAssignmentItem[] = [...newEmptySeatAssignments(household.householdId, NOW)];
  const supervisionLinks: SupervisionLinkItem[] = [];
  const coverages: CoverageAssignmentItem[] = [];

  for (const [index, minorId] of minorIds.entries()) {
    if (index > 1) break;
    seats[index] = assignFamilySeat(seats[index], minorId, 1, NOW + 1);
    supervisionLinks.push(
      newSupervisionLink({
        householdId: household.householdId,
        adultId: household.primaryResponsibleId,
        minorId,
        role: 'primary_responsible',
        now: NOW + 1,
      }),
    );
    coverages.push(
      newCoverageAssignment({
        householdId: household.householdId,
        accountId: minorId,
        seatType: 'minor',
        paidThrough: NOW + 86_400_000,
        now: NOW + 1,
      }),
    );
  }

  if (input?.additionalResponsibleId) {
    seats[2] = assignFamilySeat(
      seats[2],
      input.additionalResponsibleId,
      1,
      NOW + 1,
    );
    for (const minorId of input.additionalScope ?? []) {
      supervisionLinks.push(
        newSupervisionLink({
          householdId: household.householdId,
          adultId: input.additionalResponsibleId,
          minorId,
          role: 'additional_responsible',
          now: NOW + 1,
        }),
      );
    }
  }

  return { household, seats, supervisionLinks, coverages };
}

describe('family domain v2', () => {
  it('derives a stable opaque household id from the original primary account', () => {
    const first = householdIdForPrimary('primary-account-a');
    expect(householdIdForPrimary('primary-account-a')).toBe(first);
    expect(householdIdForPrimary('primary-account-b')).not.toBe(first);
    expect(first).toMatch(/^hh_[0-9a-f]{64}$/);
    expect(first).not.toContain('primary-account-a');
  });

  it('uses fixed single-table keys for the household, seats, supervision and coverage', () => {
    expect(FK.household('household-a')).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'META',
    });
    expect(FK.minorSeat('household-a', 1)).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'SEAT#MINOR#1',
    });
    expect(FK.minorSeat('household-a', 2)).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'SEAT#MINOR#2',
    });
    expect(FK.additionalSeat('household-a')).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'SEAT#ADDITIONAL',
    });
    expect(FK.supervision('minor-a', 'adult-a')).toEqual({
      pk: 'USER#minor-a',
      sk: 'SUPERVISION#adult-a',
    });
    expect(FK.supervisionByAdult('adult-a', 'minor-a')).toEqual({
      gsi1pk: 'USER#adult-a',
      gsi1sk: 'SUPERVISION#minor-a',
    });
    expect(FK.familyCoverage('minor-a')).toEqual({
      pk: 'USER#minor-a',
      sk: 'COVERAGE#FAMILY',
    });
    expect(FK.familyEntitlement('household-a')).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'ENTITLEMENT#FAMILY',
    });
    expect(FK.minorConsent('minor-a')).toEqual({
      pk: 'USER#minor-a',
      sk: 'CONSENT#FAMILY_ONBOARDING',
    });
    expect(FK.primaryTransfer('household-a')).toEqual({
      pk: 'HOUSEHOLD#household-a',
      sk: 'TRANSFER#PRIMARY',
    });
  });

  it('derives paid family capacity from the exact offer and fails closed outside it', () => {
    const entitlement = createFamilyEntitlement({
      householdId: 'household-a',
      offerKey: 'family_1_minor_1_additional_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW,
      source: 'test_seed',
    });

    expect(entitlement).toMatchObject({
      ...FK.familyEntitlement('household-a'),
      entityType: 'FamilyEntitlement',
      minorSeats: 1,
      additionalResponsibleSeat: 1,
      revision: 1,
      state: 'active',
    });
    expect(
      familyEntitlementAllows(entitlement, { minorSeats: 1, additionalResponsibleSeat: 1 }, NOW),
    ).toBe(true);
    expect(
      familyEntitlementAllows(entitlement, { minorSeats: 2, additionalResponsibleSeat: 0 }, NOW),
    ).toBe(false);
    expect(() =>
      createFamilyEntitlement({
        householdId: 'household-a',
        offerKey: 'premium_individual',
        paidThrough: NOW + 86_400_000,
        now: NOW,
        source: 'test_seed',
      }),
    ).toThrow(/family offer/i);
  });

  it('keeps invited pilot capacity active without inventing a payment date', () => {
    const entitlement = createFamilyEntitlement({
      householdId: 'household-a',
      source: 'sponsored_pilot',
      now: NOW,
    });
    const coverage = newCoverageAssignment({
      householdId: 'household-a',
      accountId: 'adult-a',
      seatType: 'primary_responsible',
      source: 'sponsored_pilot',
      now: NOW,
    });

    expect(entitlement).toMatchObject({
      source: 'sponsored_pilot',
      offerKey: null,
      minorSeats: 2,
      additionalResponsibleSeat: 1,
      paidThrough: null,
    });
    expect(coverage).toMatchObject({ source: 'sponsored_pilot', paidThrough: null });
    expect(
      familyEntitlementAllows(
        entitlement,
        { minorSeats: 2, additionalResponsibleSeat: 1 },
        NOW + 20 * 365 * 86_400_000,
      ),
    ).toBe(true);
  });

  it('materializes immutable minor consent and a two-party primary transfer proposal', () => {
    const consent = createMinorConsentAcceptance({
      householdId: 'household-a',
      minorId: 'minor-a',
      actorId: 'adult-a',
      majorityAt: '2035-01-01',
      declarationVersion: 'declaration-v1',
      consentVersion: 'consent-v1',
      commandId: '9c09f76b-246a-4f0d-a188-8ba97f7f518d',
      policyVersion: 'family-policy-v2',
      now: NOW,
    });
    expect(consent).toMatchObject({
      ...FK.minorConsent('minor-a'),
      entityType: 'MinorConsentAcceptance',
      actorId: 'adult-a',
      declarationVersion: 'declaration-v1',
      consentVersion: 'consent-v1',
    });

    const proposal = createPrimaryTransferProposal({
      householdId: 'household-a',
      currentPrimaryId: 'adult-a',
      newPrimaryId: 'adult-b',
      householdRevision: 3,
      commandId: '9c09f76b-246a-4f0d-a188-8ba97f7f518d',
      now: NOW,
      expiresAt: NOW + 900_000,
    });
    expect(proposal).toMatchObject({
      ...FK.primaryTransfer('household-a'),
      entityType: 'PrimaryTransferProposal',
      state: 'pending',
      currentPrimaryId: 'adult-a',
      newPrimaryId: 'adult-b',
      acceptedById: null,
      revision: 1,
    });
  });

  it('creates one active primary household with exactly three empty commercial seats', () => {
    const household = newHousehold({ primaryResponsibleId: 'adult-a', now: NOW });
    const householdId = householdIdForPrimary('adult-a');
    expect(household).toEqual({
      pk: `HOUSEHOLD#${householdId}`,
      sk: 'META',
      entityType: 'Household',
      householdId,
      primaryResponsibleId: 'adult-a',
      country: 'MX',
      state: 'active',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const seats = newEmptySeatAssignments(householdId, NOW);
    expect(seats).toHaveLength(3);
    expect(seats.map((seat) => seat['sk'])).toEqual([
      'SEAT#MINOR#1',
      'SEAT#MINOR#2',
      'SEAT#ADDITIONAL',
    ]);
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seatType: 'minor', seatNumber: 1, accountId: null }),
        expect.objectContaining({ seatType: 'minor', seatNumber: 2, accountId: null }),
        expect.objectContaining({
          seatType: 'additional_responsible',
          accountId: null,
        }),
      ]),
    );
    expect(
      seats.every(
        (seat) =>
          seat['entityType'] === 'SeatAssignment' &&
          seat['state'] === 'empty' &&
          seat['revision'] === 1 &&
          seat['assignedAt'] === null &&
          seat['updatedAt'] === NOW,
      ),
    ).toBe(true);
  });

  it('lets exactly one of two competing seat assignments win the expected revision', () => {
    let current = newEmptySeatAssignments('household-a', NOW)[0];
    current = assignFamilySeat(current, 'minor-a', 1, NOW + 1);
    expect(current).toMatchObject({
      state: 'assigned',
      accountId: 'minor-a',
      revision: 2,
      assignedAt: NOW + 1,
      updatedAt: NOW + 1,
    });

    expect(() => assignFamilySeat(current, 'minor-b', 1, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'STALE_REVISION' }),
    );
  });

  it('lets exactly one of two competing primary transfers win without changing household id', () => {
    let current = newHousehold({ primaryResponsibleId: 'adult-a', now: NOW });
    const householdId = current['householdId'];
    current = transferPrimaryResponsibility(current, 'adult-b', 1, NOW + 1);
    expect(current).toMatchObject({
      householdId,
      primaryResponsibleId: 'adult-b',
      revision: 2,
      updatedAt: NOW + 1,
    });

    expect(() =>
      transferPrimaryResponsibility(current, 'adult-c', 1, NOW + 1),
    ).toThrowError(expect.objectContaining({ code: 'STALE_REVISION' }));
  });

  it('accepts a household with one assigned minor, one matching primary link and one family coverage', () => {
    const household = newHousehold({ primaryResponsibleId: 'adult-a', now: NOW });
    const householdId = household.householdId;
    const seats = newEmptySeatAssignments(householdId, NOW);
    seats[0] = assignFamilySeat(seats[0], 'minor-a', 1, NOW + 1);
    const primaryLink = newSupervisionLink({
      householdId,
      adultId: 'adult-a',
      minorId: 'minor-a',
      role: 'primary_responsible',
      now: NOW + 1,
    });
    const coverage = newCoverageAssignment({
      householdId,
      accountId: 'minor-a',
      seatType: 'minor',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    });

    expect(primaryLink).toMatchObject({
      pk: 'USER#minor-a',
      sk: 'SUPERVISION#adult-a',
      gsi1pk: 'USER#adult-a',
      gsi1sk: 'SUPERVISION#minor-a',
      householdId,
      role: 'primary_responsible',
      state: 'active',
      revision: 1,
    });
    expect(coverage).toMatchObject({
      pk: 'USER#minor-a',
      sk: 'COVERAGE#FAMILY',
      householdId,
      accountId: 'minor-a',
      seatType: 'minor',
      state: 'active',
      revision: 1,
    });
    expect(() =>
      assertValidHouseholdSnapshot(
        { household, seats, supervisionLinks: [primaryLink], coverages: [coverage] },
        NOW + 1,
      ),
    ).not.toThrow();
  });

  it('rejects a third minor seat, a duplicate additional seat and identity in an empty seat', () => {
    const thirdMinor = householdFixture({ minorIds: ['minor-a', 'minor-b'] });
    thirdMinor.seats.push({
      ...thirdMinor.seats[1],
      sk: 'SEAT#MINOR#3',
      seatNumber: 3,
      accountId: 'minor-c',
      state: 'assigned',
    } as never);
    expect(() => assertValidHouseholdSnapshot(thirdMinor, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );

    const duplicateAdditional = householdFixture({
      additionalResponsibleId: 'adult-b',
      additionalScope: ['minor-a'],
    });
    duplicateAdditional.seats.push({ ...duplicateAdditional.seats[2] });
    expect(() => assertValidHouseholdSnapshot(duplicateAdditional, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );

    const identityInEmptySeat = householdFixture();
    identityInEmptySeat.seats[1] = {
      ...identityInEmptySeat.seats[1],
      accountId: 'ghost-minor',
    };
    expect(() => assertValidHouseholdSnapshot(identityInEmptySeat, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('requires exactly one active primary supervision link for every assigned minor', () => {
    const missingPrimary = householdFixture();
    missingPrimary.supervisionLinks.splice(0, 1);
    expect(() => assertValidHouseholdSnapshot(missingPrimary, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );

    const duplicatePrimary = householdFixture();
    duplicatePrimary.supervisionLinks.push(
      newSupervisionLink({
        householdId: duplicatePrimary.household.householdId,
        adultId: 'adult-c',
        minorId: 'minor-a',
        role: 'primary_responsible',
        now: NOW + 1,
      }),
    );
    expect(() => assertValidHouseholdSnapshot(duplicatePrimary, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('accepts additional-responsible scope over one or both seated minors only', () => {
    const oneMinorScope = householdFixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-b',
      additionalScope: ['minor-a'],
    });
    expect(() => assertValidHouseholdSnapshot(oneMinorScope, NOW + 1)).not.toThrow();

    const twoMinorScope = householdFixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-b',
      additionalScope: ['minor-a', 'minor-b'],
    });
    expect(() => assertValidHouseholdSnapshot(twoMinorScope, NOW + 1)).not.toThrow();

    const emptyScope = householdFixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-b',
      additionalScope: [],
    });
    expect(() => assertValidHouseholdSnapshot(emptyScope, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );

    const outsiderScope = householdFixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-b',
      additionalScope: ['minor-outside'],
    });
    expect(() => assertValidHouseholdSnapshot(outsiderScope, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('rejects two active family coverages for the same account even across households', () => {
    const snapshot = householdFixture();
    snapshot.coverages.push({
      ...snapshot.coverages[0],
      householdId: 'household-other',
      revision: 2,
    });

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it.each(['additional_responsible', 'primary_responsible'] as const)(
    'accepts an empty personal household whose owner is %s in another household',
    (seatType) => {
      const snapshot = householdFixture({ minorIds: [] });
      snapshot.coverages = [newCoverageAssignment({
        householdId: 'household-other',
        accountId: snapshot.household.primaryResponsibleId,
        seatType,
        source: 'sponsored_pilot',
        now: NOW,
      })];

      expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).not.toThrow();
      for (const action of ['create_minor', 'create_minor_link_request', 'invite_additional_responsible'] as const) {
        expect(authorizeFamilyAction({
          actor: { accountId: 'adult-a', accountType: 'adult', status: 'active', socialEnabled: true },
          action, household: snapshot, now: NOW + 1,
        })).toEqual({ allowed: false, code: 'PAYMENT_REQUIRED' });
      }
    },
  );

  it('rejects foreign primary coverage when the personal household still has an assigned minor', () => {
    const snapshot = householdFixture();
    snapshot.coverages.push(newCoverageAssignment({
      householdId: 'household-other',
      accountId: snapshot.household.primaryResponsibleId,
      seatType: 'additional_responsible',
      source: 'sponsored_pilot',
      now: NOW,
    }));

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it.each([
    ['a different adult', 'adult-other', 'additional_responsible'],
    ['minor coverage for the primary adult', 'adult-a', 'minor'],
  ] as const)('rejects foreign coverage for %s in an empty personal household', (_label, accountId, seatType) => {
    const snapshot = householdFixture({ minorIds: [] });
    snapshot.coverages = [newCoverageAssignment({
      householdId: 'household-other', accountId, seatType,
      source: 'sponsored_pilot', now: NOW,
    })];

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('rejects two current coverages for the owner of an empty personal household', () => {
    const snapshot = householdFixture({ minorIds: [] });
    snapshot.coverages = ['household-other', snapshot.household.householdId].map((householdId) =>
      newCoverageAssignment({
        householdId, accountId: snapshot.household.primaryResponsibleId,
        seatType: 'primary_responsible', source: 'sponsored_pilot', now: NOW,
      }),
    );

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('rejects a seated minor whose only current coverage belongs to another household', () => {
    const snapshot = householdFixture();
    snapshot.coverages[0] = { ...snapshot.coverages[0], householdId: 'household-other' };

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('rejects foreign coverage in an empty household that is not the primary adult personal household', () => {
    const snapshot = householdFixture({ minorIds: [] });
    snapshot.household = {
      ...snapshot.household, ...FK.household('household-transferred'),
      householdId: 'household-transferred',
    };
    snapshot.seats = newEmptySeatAssignments(snapshot.household.householdId, NOW);
    snapshot.coverages = [newCoverageAssignment({
      householdId: 'household-other', accountId: 'adult-a',
      seatType: 'primary_responsible', source: 'sponsored_pilot', now: NOW,
    })];

    expect(() => assertValidHouseholdSnapshot(snapshot, NOW + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FAMILY_STATE' }),
    );
  });

  it('builds an atomic minor assignment with seat CAS and a fixed family-coverage claim', () => {
    const household = newHousehold({ primaryResponsibleId: 'adult-a', now: NOW });
    const seat = newEmptySeatAssignments(household.householdId, NOW)[0];
    const primaryLink = newSupervisionLink({
      householdId: household.householdId,
      adultId: household.primaryResponsibleId,
      minorId: 'minor-a',
      role: 'primary_responsible',
      now: NOW + 1,
    });
    const coverage = newCoverageAssignment({
      householdId: household.householdId,
      accountId: 'minor-a',
      seatType: 'minor',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    });

    const transaction = buildAssignMinorTransaction({
      tableName: 'roadmap-dev',
      household,
      seat,
      minorId: 'minor-a',
      primaryLink,
      coverage,
      expectedHouseholdRevision: 1,
      expectedSeatRevision: 1,
      now: NOW + 1,
    });
    expect(transaction.TransactItems).toHaveLength(4);
    const [householdWrite, seatWrite, linkWrite, coverageWrite] =
      transaction.TransactItems ?? [];

    expect(householdWrite?.['Update']).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: `HOUSEHOLD#${household.householdId}`, sk: 'META' },
      UpdateExpression: 'SET revision = :nextRevision, updatedAt = :now',
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :primaryResponsibleId',
      ExpressionAttributeValues: expect.objectContaining({
        ':expectedRevision': 1,
        ':nextRevision': 2,
        ':primaryResponsibleId': 'adult-a',
      }),
    });
    expect(seatWrite?.['Update']).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: `HOUSEHOLD#${household.householdId}`, sk: 'SEAT#MINOR#1' },
      ConditionExpression:
        'revision = :expectedRevision AND #state = :empty AND accountId = :emptyAccountId',
      ExpressionAttributeValues: expect.objectContaining({
        ':expectedRevision': 1,
        ':nextRevision': 2,
        ':accountId': 'minor-a',
        ':emptyAccountId': null,
      }),
    });
    expect(linkWrite?.['Put']).toMatchObject({
      TableName: 'roadmap-dev',
      Item: primaryLink,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
    expect(coverageWrite?.['Put']).toMatchObject({
      TableName: 'roadmap-dev',
      Item: expect.objectContaining({
        pk: 'USER#minor-a',
        sk: 'COVERAGE#FAMILY',
        accountId: 'minor-a',
      }),
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
  });

  it('serializes two competing primary transfers on the same household revision', () => {
    const snapshot = householdFixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalResponsibleId: 'adult-b',
      additionalScope: ['minor-a', 'minor-b'],
    });
    const household = snapshot.household;
    const currentPrimaryCoverage = newCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-a',
      seatType: 'primary_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    });
    const nextPrimaryCoverage = newCoverageAssignment({
      householdId: household.householdId,
      accountId: 'adult-b',
      seatType: 'additional_responsible',
      paidThrough: NOW + 86_400_000,
      now: NOW + 1,
    });
    const common = {
      tableName: 'roadmap-dev',
      household,
      additionalSeat: snapshot.seats.find(
        (seat): seat is AdditionalResponsibleSeatAssignmentItem =>
          seat.seatType === 'additional_responsible',
      )!,
      currentPrimaryLinks: snapshot.supervisionLinks.filter(
        (link) => link.role === 'primary_responsible',
      ),
      nextPrimaryLinks: snapshot.supervisionLinks.filter(
        (link) => link.role === 'additional_responsible',
      ),
      currentPrimaryCoverage,
      nextPrimaryCoverage,
      expectedHouseholdRevision: 1,
      now: NOW + 2,
    } as const;
    const first = buildTransferPrimaryTransaction({
      ...common,
      nextPrimaryResponsibleId: 'adult-b',
    });

    const firstUpdate = first.TransactItems?.[0]?.['Update'];
    expect(first.TransactItems).toHaveLength(8);
    expect(firstUpdate).toMatchObject({
      TableName: 'roadmap-dev',
      Key: { pk: `HOUSEHOLD#${household.householdId}`, sk: 'META' },
      UpdateExpression:
        'SET primaryResponsibleId = :nextPrimaryResponsibleId, revision = :nextRevision, updatedAt = :now',
      ConditionExpression:
        'revision = :expectedRevision AND #state = :active AND primaryResponsibleId = :currentPrimaryResponsibleId',
      ExpressionAttributeValues: expect.objectContaining({
        ':currentPrimaryResponsibleId': 'adult-a',
        ':nextPrimaryResponsibleId': 'adult-b',
        ':expectedRevision': 1,
        ':nextRevision': 2,
      }),
    });
    expect(first.TransactItems?.[1]?.['Update']).toMatchObject({
      Key: FK.additionalSeat(household.householdId),
      ConditionExpression:
        'revision = :expectedRevision AND #state = :assigned AND accountId = :nextPrimaryResponsibleId',
      ExpressionAttributeValues: expect.objectContaining({
        ':expectedRevision': 2,
        ':nextRevision': 3,
        ':nextPrimaryResponsibleId': 'adult-b',
      }),
    });
    const supervisionUpdates = first.TransactItems?.slice(2, 6) ?? [];
    expect(supervisionUpdates).toHaveLength(4);
    expect(
      supervisionUpdates.filter(
        (item) => item['Update']?.ExpressionAttributeValues?.[':ended'] === 'ended',
      ),
    ).toHaveLength(2);
    expect(
      supervisionUpdates.filter(
        (item) =>
          item['Update']?.UpdateExpression?.startsWith('SET #role = :primaryRole'),
      ),
    ).toHaveLength(2);
    expect(
      supervisionUpdates.every(
        (item) =>
          item['Update']?.ConditionExpression?.includes('revision = :expectedRevision') &&
          item['Update']?.ConditionExpression?.includes('householdId = :householdId'),
      ),
    ).toBe(true);
    expect(first.TransactItems?.[6]?.['Update']).toMatchObject({
      Key: FK.familyCoverage('adult-a'),
      ExpressionAttributeValues: expect.objectContaining({ ':ended': 'ended' }),
    });
    expect(first.TransactItems?.[7]?.['Update']).toMatchObject({
      Key: FK.familyCoverage('adult-b'),
      ExpressionAttributeValues: expect.objectContaining({
        ':primarySeatType': 'primary_responsible',
      }),
    });
  });

  it('classifies transaction cancellation positions without inventing a winner', () => {
    const cancelled = (...codes: string[]) =>
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: codes.map((Code) => ({ Code })),
      });

    expect(
      classifyFamilyTransactionCancellation(
        'assign_minor',
        cancelled('ConditionalCheckFailed', 'None', 'None', 'None'),
      ),
    ).toEqual({ kind: 'stale_household_revision' });
    expect(
      classifyFamilyTransactionCancellation(
        'assign_minor',
        cancelled('None', 'ConditionalCheckFailed', 'None', 'None'),
      ),
    ).toEqual({ kind: 'seat_conflict' });
    expect(
      classifyFamilyTransactionCancellation(
        'assign_minor',
        cancelled('None', 'None', 'ConditionalCheckFailed', 'None'),
      ),
    ).toEqual({ kind: 'supervision_conflict' });
    expect(
      classifyFamilyTransactionCancellation(
        'assign_minor',
        cancelled('None', 'None', 'None', 'ConditionalCheckFailed'),
      ),
    ).toEqual({ kind: 'coverage_conflict' });
    expect(
      classifyFamilyTransactionCancellation(
        'assign_minor',
        cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed', 'None', 'None'),
      ),
    ).toEqual({ kind: 'ambiguous' });
    expect(
      classifyFamilyTransactionCancellation(
        'transfer_primary',
        cancelled('ConditionalCheckFailed'),
      ),
    ).toEqual({ kind: 'stale_household_revision' });
    expect(classifyFamilyTransactionCancellation('assign_minor', new Error('network'))).toBeNull();
  });

  it('assembles household snapshots only from strongly consistent base-table reads', async () => {
    const snapshot = householdFixture();
    const foreignHistory: SupervisionLinkItem = {
      ...newSupervisionLink({
        householdId: 'household-before-transfer',
        adultId: 'adult-before-transfer',
        minorId: 'minor-a',
        role: 'primary_responsible',
        now: NOW - 10,
      }),
      state: 'ended',
      validUntil: NOW - 1,
      updatedAt: NOW - 1,
    };
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk = input.ExpressionAttributeValues?.[':pk'];
      if (pk === `HOUSEHOLD#${snapshot.household.householdId}`) {
        return { Items: [snapshot.household, ...snapshot.seats] };
      }
      if (pk === 'USER#minor-a') {
        return { Items: [...snapshot.supervisionLinks, foreignHistory] };
      }
      return { Items: [] };
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'roadmap-dev': snapshot.coverages },
    });

    const result = await readHouseholdSnapshot(
      {
        ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        tableName: 'roadmap-dev',
        now: () => NOW + 1,
      },
      snapshot.household.householdId,
    );

    expect(result).toEqual(snapshot);
    expect(
      ddbMock
        .commandCalls(QueryCommand)
        .every((call) => call.args[0].input.ConsistentRead === true),
    ).toBe(true);
    const coverageRead = ddbMock.commandCalls(BatchGetCommand)[0].args[0].input;
    expect(coverageRead.RequestItems?.['roadmap-dev']).toMatchObject({
      ConsistentRead: true,
      Keys: expect.arrayContaining([
        { pk: 'USER#adult-a', sk: 'COVERAGE#FAMILY' },
        { pk: 'USER#minor-a', sk: 'COVERAGE#FAMILY' },
      ]),
    });
  });
});
