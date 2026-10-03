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
} from '../../lambda/family/model';

export interface FamilyV2Fixture {
  readonly household: HouseholdItem;
  readonly seats: SeatAssignmentItem[];
  readonly supervisionLinks: SupervisionLinkItem[];
  readonly coverages: CoverageAssignmentItem[];
  readonly entitlement: FamilyEntitlementItem;
}

export function familyV2Fixture(input: {
  readonly now: number;
  readonly primaryId: string;
  readonly minorIds?: readonly string[];
  readonly additionalResponsibleSeat?: 0 | 1;
  readonly additionalId?: string;
  readonly additionalScope?: readonly string[];
}): FamilyV2Fixture {
  const minorIds = input.minorIds ?? [];
  const createdAt = input.now - 5_000;
  const household = createHousehold({
    primaryResponsibleId: input.primaryId,
    now: createdAt,
  });
  const seats = [...createEmptySeatAssignments(household.householdId, createdAt)];
  const supervisionLinks: SupervisionLinkItem[] = [];
  const coverages: CoverageAssignmentItem[] = [
    createCoverageAssignment({
      householdId: household.householdId,
      accountId: input.primaryId,
      seatType: 'primary_responsible',
      paidThrough: input.now + 86_400_000,
      now: createdAt,
    }),
  ];
  for (const [index, minorId] of minorIds.entries()) {
    const seat = seats[index];
    if (!seat || seat.seatType !== 'minor') throw new Error('invalid minor fixture seat');
    seats[index] = assignSeat(seat, minorId, seat.revision, createdAt);
    supervisionLinks.push(
      createSupervisionLink({
        householdId: household.householdId,
        adultId: input.primaryId,
        minorId,
        role: 'primary_responsible',
        now: createdAt,
      }),
    );
    coverages.push(
      createCoverageAssignment({
        householdId: household.householdId,
        accountId: minorId,
        seatType: 'minor',
        paidThrough: input.now + 86_400_000,
        now: createdAt,
      }),
    );
  }
  const additionalResponsibleSeat = input.additionalResponsibleSeat ?? 0;
  if (input.additionalId) {
    if (additionalResponsibleSeat !== 1) {
      throw new Error('an additional fixture requires an additional-responsible seat');
    }
    const additionalSeat = seats[2];
    if (!additionalSeat || additionalSeat.seatType !== 'additional_responsible') {
      throw new Error('invalid additional fixture seat');
    }
    seats[2] = assignSeat(
      additionalSeat,
      input.additionalId,
      additionalSeat.revision,
      createdAt,
    );
    coverages.push(
      createCoverageAssignment({
        householdId: household.householdId,
        accountId: input.additionalId,
        seatType: 'additional_responsible',
        paidThrough: input.now + 86_400_000,
        now: createdAt,
      }),
    );
    for (const minorId of input.additionalScope ?? minorIds) {
      if (!minorIds.includes(minorId)) throw new Error('additional scope must target a seated minor');
      supervisionLinks.push(
        createSupervisionLink({
          householdId: household.householdId,
          adultId: input.additionalId,
          minorId,
          role: 'additional_responsible',
          now: createdAt,
        }),
      );
    }
  }
  return {
    household,
    seats,
    supervisionLinks,
    coverages,
    entitlement: createFamilyEntitlement({
      householdId: household.householdId,
      offerKey: additionalResponsibleSeat === 1
        ? minorIds.length > 1
          ? 'family_2_minors_1_additional_responsible'
          : 'family_1_minor_1_additional_responsible'
        : minorIds.length > 1
          ? 'family_2_minors'
          : 'family_1_minor',
      paidThrough: input.now + 86_400_000,
      now: createdAt,
      source: 'test_seed',
    }),
  };
}
