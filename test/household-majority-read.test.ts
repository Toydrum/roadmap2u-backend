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
} from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Ctx } from '../lambda/authz';
import type { Deps, ProfileItem } from '../lambda/db';
import { createCoverageAssignment, type CoverageAssignmentItem } from '../lambda/family/model';
import { createMinorFromLegacy, getHousehold } from '../lambda/handlers/household';
import { familyV2Fixture, type FamilyV2Fixture } from './support/family-v2-fixture';
import { installFamilyV2Reads } from './support/family-v2-reads';

const NOW = 1_800_000_000_000;
const SUBJECT = 'new-adult';
const FORMER_PRIMARY = 'former-primary';
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function profile(userId: string, accountType: 'adult' | 'minor' = 'adult'): ProfileItem {
  return {
    pk: `USER#${userId}`,
    sk: 'PROFILE',
    userId,
    username: userId,
    displayName: userId,
    accountType,
    status: 'active',
    socialEnabled: false,
    createdAt: NOW - 10_000,
    majorityAt: accountType === 'minor' ? '2035-01-01' : '2027-01-15',
    familyFenceVersion: 1,
  };
}

function context(accountType: 'adult' | 'minor' = 'adult'): Ctx {
  const deps: Deps = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
  return { callerId: SUBJECT, caller: profile(SUBJECT, accountType), authenticatedAt: NOW - 60_000, deps };
}

function endedMinorCoverage(
  householdId: string,
  source: 'sponsored_pilot' | 'subscription_projection' = 'sponsored_pilot',
): CoverageAssignmentItem {
  const input = { householdId, accountId: SUBJECT, seatType: 'minor' as const, now: NOW - 5_000 };
  const coverage = source === 'sponsored_pilot'
    ? createCoverageAssignment({ ...input, source })
    : createCoverageAssignment({ ...input, source, paidThrough: NOW + 86_400_000 });
  return { ...coverage, state: 'ended', revision: 2, updatedAt: NOW - 1_000 };
}

function installReads(ctx: Ctx, families: readonly FamilyV2Fixture[]): void {
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  for (const family of families) {
    installFamilyV2Reads(ddbMock, family, [ctx.caller, profile(FORMER_PRIMARY)]);
  }
  const coverages = [...new Map(families.flatMap(family => family.coverages)
    .map(row => [`${row.pk}/${row.sk}`, row])).values()];
  ddbMock.on(BatchGetCommand).callsFake((input: BatchGetCommandInput) => ({
    Responses: Object.fromEntries(Object.entries(input.RequestItems ?? {}).map(([table, request]) => [
      table, coverages.filter(row => request.Keys?.some(key => key.pk === row.pk && key.sk === row.sk)),
    ])),
  }));
}

function postMajorityFamilies(
  source: 'sponsored_pilot' | 'subscription_projection' = 'sponsored_pilot',
): [FamilyV2Fixture, FamilyV2Fixture] {
  const former = familyV2Fixture({ now: NOW, primaryId: FORMER_PRIMARY });
  const coverage = endedMinorCoverage(former.household.householdId, source);
  const own = familyV2Fixture({ now: NOW, primaryId: SUBJECT });
  return [
    { ...former, coverages: [...former.coverages, coverage] },
    { ...own, coverages: [coverage] },
  ];
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('household reads after reaching majority', () => {
  it.each(['sponsored_pilot', 'subscription_projection'] as const)(
    'returns the new adult personal household while retaining ended %s minor coverage',
    async source => {
      const ctx = context();
      const families = postMajorityFamilies(source);
      installReads(ctx, families);

      await expect(getHousehold(ctx)).resolves.toMatchObject({
        householdId: families[1].household.householdId,
        myRole: 'primary_responsible',
        primaryResponsible: { userId: SUBJECT, accountType: 'adult' },
        familyCoverage: null,
        minors: [],
        additionalResponsible: null,
        availableMinorSeats: 2,
        additionalResponsibleSeatAvailable: true,
      });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(cognitoMock.calls()).toHaveLength(0);
    },
  );

  it('returns NOT_FOUND when the new adult personal household is missing', async () => {
    const ctx = context();
    const [former] = postMajorityFamilies();
    installReads(ctx, [former]);

    await expect(getHousehold(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('keeps a supervised minor in the existing household after pilot revocation', async () => {
    const ctx = context('minor');
    const former = familyV2Fixture({ now: NOW, primaryId: FORMER_PRIMARY, minorIds: [SUBJECT] });
    installReads(ctx, [{ ...former, coverages: former.coverages.map(row => ({ ...row, state: 'ended' })) }]);

    await expect(getHousehold(ctx)).resolves.toMatchObject({
      householdId: former.household.householdId,
      primaryResponsible: { userId: FORMER_PRIMARY },
      minors: [{ user: { userId: SUBJECT, accountType: 'minor' }, coverageState: 'ended' }],
    });
  });

  it.each(['active', 'grace'] as const)(
    'denies an adult still seated as a minor with %s coverage',
    async state => {
      const ctx = context();
      const former = familyV2Fixture({ now: NOW, primaryId: FORMER_PRIMARY, minorIds: [SUBJECT] });
      const own = familyV2Fixture({ now: NOW, primaryId: SUBJECT });
      const coverage = { ...former.coverages[1]!, state, graceUntil: state === 'grace' ? NOW + 86_400_000 : null };
      installReads(ctx, [
        { ...former, coverages: [former.coverages[0]!, coverage] },
        { ...own, coverages: [coverage] },
      ]);

      await expect(getHousehold(ctx)).rejects.toMatchObject({ code: 'ACCOUNT_TYPE_INCOMPATIBLE' });
    },
  );

  it('keeps coverage authorization for a seated additional responsible after revocation', async () => {
    const ctx = context();
    const former = familyV2Fixture({
      now: NOW, primaryId: FORMER_PRIMARY, minorIds: ['minor-a'],
      additionalResponsibleSeat: 1, additionalId: SUBJECT,
    });
    const own = familyV2Fixture({ now: NOW, primaryId: SUBJECT });
    const endedCoverage = { ...former.coverages.find(row => row.accountId === SUBJECT)!, state: 'ended' as const };
    installReads(ctx, [
      { ...former, coverages: former.coverages.map(row => row.accountId === SUBJECT ? endedCoverage : row) },
      { ...own, coverages: [endedCoverage] },
    ]);

    await expect(getHousehold(ctx)).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('does not let the new adult create a minor without their own family coverage', async () => {
    const ctx = context();
    installReads(ctx, postMajorityFamilies());

    await expect(createMinorFromLegacy(ctx, { username: 'child_one', displayName: 'Child' }))
      .rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(cognitoMock.calls()).toHaveLength(0);
  });
});
