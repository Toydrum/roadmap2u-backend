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
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Ctx } from '../lambda/authz';
import { accountClosureKey } from '../lambda/account-closure';
import { FAMILY_BILLING_FLAG_DEFAULTS } from '../lambda/commercial/flags';
import type { CodeItem, Deps, ProfileItem } from '../lambda/db';
import { K } from '../lambda/db';
import { FK } from '../lambda/family/keys';
import {
  assignSeat,
  createCoverageAssignment,
  createEmptySeatAssignments,
  createFamilyEntitlement,
  createHousehold,
  createPrimaryTransferProposal,
  createSupervisionLink,
  type CoverageAssignmentItem,
  type FamilyEntitlementItem,
  type HouseholdItem,
  type PrimaryTransferProposalItem,
  type SeatAssignmentItem,
  type SupervisionLinkItem,
} from '../lambda/family/model';
import {
  acceptMinorLinkRequest,
  acceptAdditionalResponsible,
  approveMinorLinkRequest,
  createMinorLinkRequest,
  createMinor,
  getHousehold,
  inviteAdditionalResponsible,
  replaceAdditionalScope,
  revokeAdditionalResponsible,
  transferPrimaryResponsibility,
} from '../lambda/handlers/household';

const NOW = 1_800_000_000_000;
const COMMAND_ID = '9c09f76b-246a-4f0d-a188-8ba97f7f518d';
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

interface FamilyFixture {
  household: HouseholdItem;
  seats: SeatAssignmentItem[];
  links: SupervisionLinkItem[];
  coverages: CoverageAssignmentItem[];
  entitlement: FamilyEntitlementItem | null;
  profiles: Map<string, ProfileItem>;
}

function profile(userId: string, accountType: 'adult' | 'minor' = 'adult'): ProfileItem {
  return {
    ...K.profile(userId),
    userId,
    username: userId.replace(/[^a-z0-9_]/g, '_'),
    displayName: userId,
    accountType,
    socialEnabled: true,
    createdAt: NOW - 10_000,
    status: 'active',
    ...(accountType === 'adult' ? { familyFenceVersion: 1 as const } :
      { majorityAt: '2030-01-01' }),
  };
}

function fixture(input?: {
  primaryId?: string;
  minorIds?: readonly string[];
  additionalId?: string;
  additionalScope?: readonly string[];
  offerKey?:
    | 'family_1_minor'
    | 'family_2_minors'
    | 'family_1_minor_1_additional_responsible'
    | 'family_2_minors_1_additional_responsible';
  noEntitlement?: boolean;
  sponsoredPilot?: boolean;
}): FamilyFixture {
  const primaryId = input?.primaryId ?? 'adult-primary';
  const minorIds = input?.minorIds ?? [];
  const household = createHousehold({ primaryResponsibleId: primaryId, now: NOW - 5_000 });
  const seats: SeatAssignmentItem[] = [...createEmptySeatAssignments(household.householdId, NOW - 5_000)];
  const links: SupervisionLinkItem[] = [];
  const coverages: CoverageAssignmentItem[] = [
    input?.sponsoredPilot
      ? createCoverageAssignment({ householdId: household.householdId, accountId: primaryId,
          seatType: 'primary_responsible', source: 'sponsored_pilot', now: NOW - 4_000 })
      : createCoverageAssignment({ householdId: household.householdId, accountId: primaryId,
          seatType: 'primary_responsible', paidThrough: NOW + 86_400_000, now: NOW - 4_000 }),
  ];
  const profiles = new Map<string, ProfileItem>([
    [primaryId, profile(primaryId)],
  ]);

  for (const [index, minorId] of minorIds.entries()) {
    seats[index] = assignSeat(seats[index], minorId, 1, NOW - 4_000);
    links.push(
      createSupervisionLink({
        householdId: household.householdId,
        adultId: primaryId,
        minorId,
        role: 'primary_responsible',
        now: NOW - 4_000,
      }),
    );
    coverages.push(
      input?.sponsoredPilot
        ? createCoverageAssignment({ householdId: household.householdId, accountId: minorId,
            seatType: 'minor', source: 'sponsored_pilot', now: NOW - 4_000 })
        : createCoverageAssignment({ householdId: household.householdId, accountId: minorId,
            seatType: 'minor', paidThrough: NOW + 86_400_000, now: NOW - 4_000 }),
    );
    profiles.set(minorId, profile(minorId, 'minor'));
  }

  if (input?.additionalId) {
    seats[2] = assignSeat(seats[2], input.additionalId, 1, NOW - 4_000);
    profiles.set(input.additionalId, profile(input.additionalId));
    coverages.push(
      input.sponsoredPilot
        ? createCoverageAssignment({ householdId: household.householdId,
            accountId: input.additionalId, seatType: 'additional_responsible',
            source: 'sponsored_pilot', now: NOW - 4_000 })
        : createCoverageAssignment({ householdId: household.householdId,
            accountId: input.additionalId, seatType: 'additional_responsible',
            paidThrough: NOW + 86_400_000, now: NOW - 4_000 }),
    );
    for (const minorId of input.additionalScope ?? []) {
      links.push(
        createSupervisionLink({
          householdId: household.householdId,
          adultId: input.additionalId,
          minorId,
          role: 'additional_responsible',
          now: NOW - 4_000,
        }),
      );
    }
  }

  const offerKey = input?.offerKey ?? (minorIds.length > 1 ? 'family_2_minors' : 'family_1_minor');
  return {
    household,
    seats,
    links,
    coverages,
    entitlement: input?.noEntitlement
      ? null
      : input?.sponsoredPilot
        ? createFamilyEntitlement({ householdId: household.householdId,
            now: NOW - 4_000, source: 'sponsored_pilot' })
        : createFamilyEntitlement({
            householdId: household.householdId,
            offerKey,
            paidThrough: NOW + 86_400_000,
            now: NOW - 4_000,
            source: 'test_seed',
          }),
    profiles,
  };
}

function context(
  family: FamilyFixture,
  callerId = 'adult-primary',
  authenticatedAt = NOW - 60_000,
): Ctx {
  const caller = family.profiles.get(callerId) ?? profile(callerId);
  const deps: Deps = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
  return { callerId, caller, authenticatedAt, deps };
}

function baseCommand(householdId: string) {
  return {
    householdId,
    expectedHouseholdRevision: 1,
    commandId: COMMAND_ID,
    policyVersion: 'family-policy-v2',
  };
}

function minorCommand(householdId: string, versions = {
  declarationVersion: 'declaration-v1',
  consentVersion: 'consent-v1',
}) {
  return {
    ...baseCommand(householdId),
    username: 'child_one',
    country: 'MX',
    majorityAt: '2035-01-01',
    ...versions,
  };
}

function invitation(family: FamilyFixture, intendedAdultId = 'adult-additional') {
  return {
    pk: 'FAMILY_NOTICE#invitation-a',
    sk: 'META',
    entityType: 'FamilyNotice',
    noticeId: 'invitation-a',
    kind: 'additional_responsible_invitation',
    householdId: family.household.householdId,
    targetHouseholdRevision: family.household.revision,
    createdById: 'adult-primary',
    minorId: null,
    minorIds: ['minor-a'],
    sourceHouseholdId: family.household.householdId,
    sourceHouseholdRevision: 1,
    sourcePrimaryId: 'adult-primary',
    intendedAdultId,
    acceptedById: null,
    sourceApprovalCommandId: null,
    sourceApprovedAt: null,
    acceptanceCommandId: null,
    state: 'pending',
    createdAt: NOW - 1_000,
    expiresAt: NOW + 86_400_000,
    revision: 1,
    commandId: COMMAND_ID,
    policyVersion: 'family-policy-v2',
    code: null,
  };
}

function installReads(
  family: FamilyFixture,
  options: {
    notice?: Record<string, unknown>;
    transfer?: PrimaryTransferProposalItem | null;
    rateCount?: number;
    codeItem?: CodeItem;
    minorLinkingEnabled?: boolean;
  } = {},
): void {
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
    const pk = values?.[':pk'];
    if (pk === FK.household(family.household.householdId).pk) {
      return { Items: [family.household, ...family.seats] };
    }
    if (typeof pk === 'string' && pk.startsWith('USER#')) {
      return { Items: family.links.filter((link) => link.pk === pk) };
    }
    return { Items: [] };
  });
  ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: family.coverages } });
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (key.pk === 'COMMERCIAL#CONFIG' && key.sk === 'FLAGS') {
      return { Item: {
        pk: key.pk, sk: key.sk, revision: 1, quotaMode: 'off', capabilityMode: 'off',
        accessCodeIssuanceEnabled: false, accessCodeRedemptionEnabled: false,
        premiumPaymentsEnabled: false, ...FAMILY_BILLING_FLAG_DEFAULTS,
        minorLinkingEnabled: options.minorLinkingEnabled ?? true,
        updatedAt: NOW, updatedBy: 'test', reason: 'family scope control',
      } };
    }
    if (
      key.pk === K.rate('adult-primary', Math.floor(NOW / 3_600_000)).pk &&
      key.sk === K.rate('adult-primary', Math.floor(NOW / 3_600_000)).sk
    ) {
      return options.rateCount === undefined
        ? {}
        : { Item: { ...key, count: options.rateCount } };
    }
    if (options.codeItem && key.pk === options.codeItem.pk && key.sk === options.codeItem.sk) {
      return { Item: options.codeItem };
    }
    if (key.pk === FK.familyEntitlement(family.household.householdId).pk && key.sk === 'ENTITLEMENT#FAMILY') {
      return family.entitlement ? { Item: family.entitlement } : {};
    }
    if (key.pk === FK.primaryTransfer(family.household.householdId).pk && key.sk === 'TRANSFER#PRIMARY') {
      return options.transfer ? { Item: options.transfer } : {};
    }
    if (key.pk === 'FAMILY_NOTICE#invitation-a') {
      return options.notice ? { Item: options.notice } : {};
    }
    if (key.sk === 'PROFILE') {
      const accountId = key.pk.slice('USER#'.length);
      const item = family.profiles.get(accountId);
      return item ? { Item: item } : {};
    }
    if (key.sk === 'COVERAGE#FAMILY') {
      const accountId = key.pk.slice('USER#'.length);
      const item = family.coverages.find((coverage) => coverage.accountId === accountId);
      return item ? { Item: item } : {};
    }
    return {};
  });
  ddbMock.on(TransactWriteCommand).resolves({});
}

function minorLinkNotice(
  source: FamilyFixture,
  target: FamilyFixture,
  state: 'pending' | 'approved' | 'accepted',
) {
  return {
    pk: 'FAMILY_NOTICE#request-a',
    sk: 'META' as const,
    entityType: 'FamilyNotice' as const,
    noticeId: 'request-a',
    kind: 'minor_link_request' as const,
    householdId: target.household.householdId,
    targetHouseholdRevision: target.household.revision,
    createdById: target.household.primaryResponsibleId,
    minorId: 'minor-a',
    minorIds: ['minor-a'],
    sourceHouseholdId: source.household.householdId,
    sourceHouseholdRevision: source.household.revision,
    sourcePrimaryId: source.household.primaryResponsibleId,
    intendedAdultId: null,
    acceptedById: state === 'accepted' ? target.household.primaryResponsibleId : null,
    sourceApprovalCommandId: state === 'pending' ? null : COMMAND_ID,
    sourceApprovedAt: state === 'pending' ? null : NOW - 30_000,
    acceptanceCommandId: state === 'accepted' ? COMMAND_ID : null,
    state,
    createdAt: NOW - 60_000,
    expiresAt: NOW + 86_400_000,
    revision: state === 'pending' ? 1 : state === 'approved' ? 2 : 3,
    commandId: COMMAND_ID,
    policyVersion: 'family-policy-v2' as const,
    code: 'LINKA1',
  };
}

function installLinkReads(
  source: FamilyFixture,
  target: FamilyFixture,
  notice: ReturnType<typeof minorLinkNotice>,
  options: {
    rateCount?: number;
    codeItem?: CodeItem;
  } = {},
): void {
  const families = [source, target];
  const allCoverages = families.flatMap((family) => family.coverages);
  const allLinks = families.flatMap((family) => family.links);
  const allProfiles = new Map(
    families.flatMap((family) => [...family.profiles.entries()]),
  );
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
    const pk = values?.[':pk'];
    for (const family of families) {
      if (pk === FK.household(family.household.householdId).pk) {
        return { Items: [family.household, ...family.seats] };
      }
    }
    if (typeof pk === 'string' && pk.startsWith('USER#')) {
      return { Items: allLinks.filter((link) => link.pk === pk) };
    }
    return { Items: [] };
  });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const keys = (input.RequestItems?.['roadmap']?.Keys ?? []) as Array<{
      pk: string;
      sk: string;
    }>;
    return {
      Responses: {
        roadmap: allCoverages.filter((coverage) =>
          keys.some((key) => key.pk === coverage.pk && key.sk === coverage.sk),
        ),
      },
    };
  });
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { pk: string; sk: string };
    if (
      key.pk === K.rate(target.household.primaryResponsibleId, Math.floor(NOW / 3_600_000)).pk &&
      key.sk === K.rate(target.household.primaryResponsibleId, Math.floor(NOW / 3_600_000)).sk
    ) {
      return options.rateCount === undefined
        ? {}
        : { Item: { ...key, count: options.rateCount } };
    }
    if (options.codeItem && key.pk === options.codeItem.pk && key.sk === options.codeItem.sk) {
      return { Item: options.codeItem };
    }
    if (key.pk === notice.pk && key.sk === notice.sk) return { Item: notice };
    for (const family of families) {
      if (
        key.pk === FK.familyEntitlement(family.household.householdId).pk &&
        key.sk === FK.familyEntitlement(family.household.householdId).sk
      ) {
        return family.entitlement ? { Item: family.entitlement } : {};
      }
    }
    if (key.sk === 'PROFILE') {
      const item = allProfiles.get(key.pk.slice('USER#'.length));
      return item ? { Item: item } : {};
    }
    if (key.sk === 'COVERAGE#FAMILY') {
      const item = allCoverages.find((coverage) => coverage.pk === key.pk);
      return item ? { Item: item } : {};
    }
    return {};
  });
  ddbMock.on(TransactWriteCommand).resolves({});
}

function transaction(index = 0) {
  return ddbMock.commandCalls(TransactWriteCommand)[index]?.args[0].input.TransactItems ?? [];
}

function conditionKeys(index = 0) {
  return transaction(index).flatMap((item) => item.ConditionCheck?.Key ? [item.ConditionCheck.Key] : []);
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('family security controls', () => {
  it('limits an additional responsible household view to assigned minors', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(family);

    const view = await getHousehold(context(family, 'adult-additional'));

    expect(view.minors.map((minor) => minor.user.userId)).toEqual(['minor-a']);
  });

  it('requires recent authentication before creating a minor identity', async () => {
    const family = fixture();
    installReads(family);
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'minor-new' }] },
    });

    await expect(
      createMinor(
        context(family, 'adult-primary', NOW - 10 * 60_000),
        minorCommand(family.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects noncanonical legal versions before any identity or database I/O', async () => {
    const family = fixture();

    await expect(
      createMinor(context(family), minorCommand(family.household.householdId, {
        declarationVersion: 'invented-v99',
        consentVersion: 'consent-v1',
      })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('requires a purchased minor allowance before calling Cognito', async () => {
    const family = fixture({ noEntitlement: true });
    installReads(family);

    await expect(
      createMinor(context(family), minorCommand(family.household.householdId)),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });

    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('binds minor creation to entitlement and persists immutable consent evidence', async () => {
    const family = fixture();
    family.profiles.set('minor-new', profile('minor-new', 'minor'));
    installReads(family);
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'minor-new' }] },
    });

    await createMinor(context(family), minorCommand(family.household.householdId));

    const items = transaction();
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: FK.familyEntitlement(family.household.householdId),
          ConditionExpression: expect.stringContaining('minorSeats >= :requiredMinorSeats'),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            ...FK.minorConsent('minor-new'),
            entityType: 'MinorConsentAcceptance',
            actorId: 'adult-primary',
            declarationVersion: 'declaration-v1',
            consentVersion: 'consent-v1',
            commandId: COMMAND_ID,
          }),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      }),
    ]));
  });

  it('creates a minor under an invited pilot without inventing a payment date', async () => {
    const family = fixture({ sponsoredPilot: true });
    family.profiles.set('minor-new', profile('minor-new', 'minor'));
    installReads(family);
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'minor-new' }] },
    });

    await createMinor(context(family), minorCommand(family.household.householdId));

    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          Key: FK.familyEntitlement(family.household.householdId),
          ExpressionAttributeValues: expect.objectContaining({ ':source': 'sponsored_pilot' }),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({ Item: expect.objectContaining({
          ...FK.familyCoverage('minor-new'), source: 'sponsored_pilot', paidThrough: null,
        }) }),
      }),
    ]));
  });

  it.each([true, false])('sends valid DynamoDB expression bindings when creating a minor (pilot=%s)', async (sponsoredPilot) => {
    const family = fixture({ sponsoredPilot });
    family.profiles.set('minor-new', profile('minor-new', 'minor'));
    installReads(family);
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'minor-new' }] },
    });
    cognitoMock.on(AdminDeleteUserCommand).resolves({});
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      for (const item of input.TransactItems ?? []) {
        const operation = item.ConditionCheck ?? item.Put ?? item.Update ?? item.Delete;
        if (!operation) throw new Error('missing transaction operation');
        const expression = [operation.ConditionExpression,
          'UpdateExpression' in operation ? operation.UpdateExpression : undefined].filter(Boolean).join(' ');
        // DynamoDB rejects unused bindings as well as missing ones, before committing any rows.
        const values = [...new Set(expression.match(/:[A-Za-z0-9_]+/g) ?? [])].sort();
        const names = [...new Set(expression.match(/#[A-Za-z0-9_]+/g) ?? [])].sort();
        expect(Object.keys(operation.ExpressionAttributeValues ?? {}).sort()).toEqual(values);
        expect(Object.keys(operation.ExpressionAttributeNames ?? {}).sort()).toEqual(names);
      }
      return {};
    });

    await expect(createMinor(context(family), minorCommand(family.household.householdId)))
      .resolves.toMatchObject({ minor: { accountType: 'minor', userId: 'minor-new' } });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rate-limits the sixth v2 minor-link code attempt before reading the code', async () => {
    const target = fixture();
    installReads(target);
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('rate limit reached'), {
      name: 'TransactionCanceledException',
    }));

    await expect(
      createMinorLinkRequest(context(target), {
        ...baseCommand(target.household.householdId),
        code: 'WRONGONE',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const codeReads = ddbMock.commandCalls(GetCommand).filter(
      (call) => (call.args[0].input.Key as { pk?: string } | undefined)?.pk === K.codeG('WRONGONE').pk,
    );
    expect(codeReads).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('allows only five sequential invalid v2 code lookups in the shared hour bucket', async () => {
    const target = fixture();
    const rateKey = K.rate('adult-primary', Math.floor(NOW / 3_600_000));
    let badAttempts = 0;
    installReads(target);
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      if (input.TransactItems?.some((item) =>
        item.Update?.Key?.['pk'] === rateKey.pk && item.Update.Key['sk'] === rateKey.sk
      )) {
        if (badAttempts >= 5) {
          throw Object.assign(new Error('rate limit reached'), {
            name: 'TransactionCanceledException',
          });
        }
        badAttempts += 1;
      }
      return {};
    });

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await createMinorLinkRequest(context(target), {
          ...baseCommand(target.household.householdId),
          code: `WRONG0${attempt}`,
        });
      } catch (error) {
        outcomes.push((error as { code: string }).code);
      }
    }

    expect(outcomes).toEqual([
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'RATE_LIMITED',
    ]);
    expect(badAttempts).toBe(5);
    const codeReads = ddbMock.commandCalls(GetCommand).filter((call) =>
      (call.args[0].input.Key as { pk?: string } | undefined)?.pk?.startsWith('CODE#G#'),
    );
    expect(codeReads).toHaveLength(5);
  });

  it('reserves at most five concurrent v2 code lookups atomically', async () => {
    const target = fixture();
    installReads(target);
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
          await createMinorLinkRequest(context(target), {
            ...baseCommand(target.household.householdId),
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

  it.each([
    {
      label: 'invalid',
      code: 'WRONGONE',
      expectedCode: 'CODE_INVALID',
      codeItem: undefined,
    },
    {
      label: 'expired',
      code: 'EXPIRED1',
      expectedCode: 'CODE_EXPIRED',
      codeItem: {
        ...K.codeG('EXPIRED1'),
        code: 'EXPIRED1',
        kind: 'linkExisting',
        userId: 'adult-source',
        minorId: 'minor-a',
        expiresAt: NOW - 1,
        ttl: Math.ceil((NOW - 1) / 1_000),
      } satisfies CodeItem,
    },
  ])('records an $label v2 minor-link code in the shared bad-attempt bucket', async ({
    code,
    expectedCode,
    codeItem,
  }) => {
    const target = fixture();
    installReads(target, { rateCount: 0, codeItem });

    await expect(
      createMinorLinkRequest(context(target), {
        ...baseCommand(target.household.householdId),
        code,
      }),
    ).rejects.toMatchObject({ code: expectedCode });

    const rateKey = K.rate('adult-primary', Math.floor(NOW / 3_600_000));
    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: rateKey,
          UpdateExpression: expect.stringContaining('ADD #count :one'),
        }),
      }),
    ]));
  });

  it('treats a guardian code with a missing source household as a bad attempt', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = fixture();
    const missingSourceId = fixture({ primaryId: 'adult-missing' }).household.householdId;
    const minorCoverageIndex = source.coverages.findIndex(
      (coverage) => coverage.accountId === 'minor-a',
    );
    source.coverages[minorCoverageIndex] = {
      ...source.coverages[minorCoverageIndex]!,
      householdId: missingSourceId,
    };
    const notice = minorLinkNotice(source, target, 'pending');
    const codeItem: CodeItem = {
      ...K.codeG('STALEA1'),
      code: 'STALEA1',
      kind: 'linkExisting',
      userId: 'adult-source',
      minorId: 'minor-a',
      expiresAt: NOW + 86_400_000,
      ttl: Math.ceil((NOW + 86_400_000) / 1_000),
    };
    installLinkReads(source, target, notice, { rateCount: 0, codeItem });

    await expect(
      createMinorLinkRequest(context(target), {
        ...baseCommand(target.household.householdId),
        code: codeItem.code,
      }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });

    const rateKey = K.rate('adult-primary', Math.floor(NOW / 3_600_000));
    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({ Key: rateKey }),
      }),
    ]));
  });

  it('charges one atomic lookup budget for a valid minor-link request', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = fixture();
    const notice = minorLinkNotice(source, target, 'pending');
    const codeItem: CodeItem = {
      ...K.codeG('LINKA1'),
      code: 'LINKA1',
      kind: 'linkExisting',
      userId: 'adult-source',
      minorId: 'minor-a',
      expiresAt: NOW + 86_400_000,
      ttl: Math.ceil((NOW + 86_400_000) / 1_000),
    };
    installLinkReads(source, target, notice, { rateCount: 0, codeItem });

    await expect(
      createMinorLinkRequest(context(target), {
        ...baseCommand(target.household.householdId),
        code: ' link-a1 ',
      }),
    ).resolves.toMatchObject({
      state: 'pending',
      minor: expect.objectContaining({ userId: 'minor-a' }),
    });

    const rateKey = K.rate('adult-primary', Math.floor(NOW / 3_600_000));
    const rateReads = ddbMock.commandCalls(GetCommand).filter((call) => {
      const key = call.args[0].input.Key as { pk?: string; sk?: string } | undefined;
      return key?.pk === rateKey.pk && key.sk === rateKey.sk;
    });
    expect(rateReads).toHaveLength(0);
    expect(transaction(1).flatMap((item) => item.Put?.Item?.['entityType'] === 'FamilyInboxPointer' ? [item.Put.Item['pk']] : []).sort())
      .toEqual(['USER#adult-primary', 'USER#adult-source', 'USER#minor-a']);
    // Every recipient partition is fenced against closure in the same write.
    expect(conditionKeys(1)).toEqual(expect.arrayContaining([
      K.profile('adult-source'), accountClosureKey('adult-source'),
      K.profile('minor-a'), accountClosureKey('minor-a'),
    ]));
    expect(transaction(0).some((item) =>
      item.Update?.Key?.['pk'] === rateKey.pk && item.Update.Key['sk'] === rateKey.sk
    )).toBe(true);
    expect(transaction(1).some((item) =>
      item.Update?.Key?.['pk'] === rateKey.pk && item.Update.Key['sk'] === rateKey.sk
    )).toBe(false);
  });

  it('requires recent source-primary authentication before approving a minor link', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = fixture({ primaryId: 'adult-target' });
    const notice = minorLinkNotice(source, target, 'pending');
    installLinkReads(source, target, notice);

    await expect(
      approveMinorLinkRequest(
        context(source, 'adult-source', NOW - 10 * 60_000),
        notice.noticeId,
        baseCommand(target.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('keeps the minor in the source household until the target accepts current versions', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = fixture({ primaryId: 'adult-target' });
    const notice = minorLinkNotice(source, target, 'pending');
    installLinkReads(source, target, notice);

    await approveMinorLinkRequest(
      context(source, 'adult-source'),
      notice.noticeId,
      baseCommand(target.household.householdId),
    );

    const items = transaction();
    expect(items.some((item) => item.Update?.Key?.['sk'] === 'SEAT#MINOR#1')).toBe(false);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: { pk: notice.pk, sk: notice.sk },
          ConditionExpression: expect.stringContaining('#state = :pending'),
        }),
      }),
    ]));
  });

  it('returns the approved minor-link result on an exact source retry without writing again', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const target = fixture({ primaryId: 'adult-target' });
    const notice = minorLinkNotice(source, target, 'approved');
    installLinkReads(source, target, notice);

    await expect(
      approveMinorLinkRequest(
        context(source, 'adult-source'),
        notice.noticeId,
        baseCommand(target.household.householdId),
      ),
    ).resolves.toMatchObject({ requestId: notice.noticeId, state: 'approved' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires target entitlement and persists versioned recipient acceptance on link', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const unpaidTarget = fixture({ primaryId: 'adult-target', noEntitlement: true });
    const unpaidNotice = minorLinkNotice(source, unpaidTarget, 'approved');
    installLinkReads(source, unpaidTarget, unpaidNotice);

    await expect(
      acceptMinorLinkRequest(
        context(unpaidTarget, 'adult-target'),
        unpaidNotice.noticeId,
        {
          ...baseCommand(unpaidTarget.household.householdId),
          responsibilityVersion: 'minor-link-responsibility-v1',
          privacyVersion: 'minor-link-privacy-v1',
        },
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    ddbMock.reset();
    const paidTarget = fixture({ primaryId: 'adult-target' });
    const paidNotice = minorLinkNotice(source, paidTarget, 'approved');
    installLinkReads(source, paidTarget, paidNotice);

    await acceptMinorLinkRequest(
      context(paidTarget, 'adult-target'),
      paidNotice.noticeId,
      {
        ...baseCommand(paidTarget.household.householdId),
        responsibilityVersion: 'minor-link-responsibility-v1',
        privacyVersion: 'minor-link-privacy-v1',
      },
    );

    expect(conditionKeys()).toContainEqual(FK.familyEntitlement(paidTarget.household.householdId));
    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            entityType: 'MinorLinkAcceptance',
            requestId: paidNotice.noticeId,
            sourcePrimaryId: 'adult-source',
            targetPrimaryId: 'adult-target',
            responsibilityVersion: 'minor-link-responsibility-v1',
            privacyVersion: 'minor-link-privacy-v1',
          }),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      }),
    ]));
  });

  it.each([
    ['ended', 'primary_responsible'], ['revoked', 'primary_responsible'],
    ['ended', 'additional_responsible'], ['revoked', 'additional_responsible'],
  ] as const)('accepts a newly approved return link after a %s %s interval', async (state, role) => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'], sponsoredPilot: true });
    const target = fixture({ primaryId: 'adult-target', minorIds: ['retained-minor'], sponsoredPilot: true });
    const notice = minorLinkNotice(source, target, 'approved');
    const historical = { ...createSupervisionLink({
      householdId: role === 'primary_responsible' ? target.household.householdId : source.household.householdId,
      adultId: 'adult-target', minorId: 'minor-a', role, now: NOW - 20_000,
    }), state, revision: 7, validUntil: NOW - 10_000, updatedAt: NOW - 10_000 };
    installLinkReads(source, target, notice);
    ddbMock.on(GetCommand, { Key: FK.supervision('minor-a', 'adult-target') }).resolves({ Item: historical });
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      const staleInsert = input.TransactItems?.some(item => item.Put?.Item?.['pk'] === historical.pk && item.Put.Item['sk'] === historical.sk);
      if (staleInsert) throw Object.assign(new Error('historical supervision already exists'), { name: 'TransactionCanceledException' });
      return {};
    });

    await expect(acceptMinorLinkRequest(context(target, 'adult-target'), notice.noticeId, {
      ...baseCommand(target.household.householdId), responsibilityVersion: 'minor-link-responsibility-v1', privacyVersion: 'minor-link-privacy-v1',
    })).resolves.toMatchObject({ householdId: target.household.householdId });

    const update = transaction().find(item => item.Update?.Key?.['pk'] === historical.pk && item.Update.Key['sk'] === historical.sk)?.Update;
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ':expectedRevision': 7, ':nextRevision': 8, ':previousState': state, ':previousRole': role,
      ':previousHouseholdId': historical.householdId, ':targetHouseholdId': target.household.householdId,
      ':adultId': 'adult-target', ':minorId': 'minor-a', ':active': 'active', ':primaryRole': 'primary_responsible', ':now': NOW, ':noEnd': null,
    });
    expect(update?.ConditionExpression).toContain('revision = :expectedRevision');
    expect(update?.ConditionExpression).toContain('#state = :previousState');
    expect(update?.ConditionExpression).toContain('#role = :previousRole');
    expect(update?.ConditionExpression).toContain('householdId = :previousHouseholdId');
    expect(update?.ConditionExpression).toContain('adultId = :adultId');
    expect(update?.ConditionExpression).toContain('minorId = :minorId');
    expect(conditionKeys()).toContainEqual(FK.familyEntitlement(target.household.householdId));
    expect(transaction()).toEqual(expect.arrayContaining([expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({
      entityType: 'MinorLinkAcceptance', requestId: notice.noticeId, responsibilityVersion: 'minor-link-responsibility-v1', privacyVersion: 'minor-link-privacy-v1',
    }) }) })]));
  });

  it('does not replace an already active recipient supervision during link acceptance', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'], sponsoredPilot: true });
    const target = fixture({ primaryId: 'adult-target', sponsoredPilot: true });
    const notice = minorLinkNotice(source, target, 'approved');
    installLinkReads(source, target, notice);
    const active = createSupervisionLink({ householdId: target.household.householdId, adultId: 'adult-target', minorId: 'minor-a', role: 'primary_responsible', now: NOW - 5_000 });
    ddbMock.on(GetCommand, { Key: FK.supervision('minor-a', 'adult-target') }).resolves({ Item: active });
    await expect(acceptMinorLinkRequest(context(target, 'adult-target'), notice.noticeId, {
      ...baseCommand(target.household.householdId), responsibilityVersion: 'minor-link-responsibility-v1', privacyVersion: 'minor-link-privacy-v1',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('keeps the entire return-link transfer atomic when the historical interval changes concurrently', async () => {
    const source = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'], sponsoredPilot: true });
    const target = fixture({ primaryId: 'adult-target', sponsoredPilot: true });
    const notice = minorLinkNotice(source, target, 'approved');
    installLinkReads(source, target, notice);
    const historical = { ...createSupervisionLink({ householdId: target.household.householdId, adultId: 'adult-target', minorId: 'minor-a', role: 'primary_responsible', now: NOW - 20_000 }), state: 'ended', revision: 7, validUntil: NOW - 10_000 };
    ddbMock.on(GetCommand, { Key: FK.supervision('minor-a', 'adult-target') }).resolves({ Item: historical });
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('revision changed to 8'), { name: 'TransactionCanceledException' }));
    await expect(acceptMinorLinkRequest(context(target, 'adult-target'), notice.noticeId, {
      ...baseCommand(target.household.householdId), responsibilityVersion: 'minor-link-responsibility-v1', privacyVersion: 'minor-link-privacy-v1',
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(transaction().find(item => item.Update?.Key?.['pk'] === historical.pk && item.Update.Key['sk'] === historical.sk)?.Update?.ExpressionAttributeValues?.[':expectedRevision']).toBe(7);
  });

  it('returns the accepted household on an exact target retry without moving the minor again', async () => {
    const originalSource = fixture({ primaryId: 'adult-source', minorIds: ['minor-a'] });
    const originalTarget = fixture({ primaryId: 'adult-target' });
    const notice = minorLinkNotice(originalSource, originalTarget, 'accepted');
    const acceptedSource = fixture({ primaryId: 'adult-source' });
    const acceptedTarget = fixture({ primaryId: 'adult-target', minorIds: ['minor-a'] });
    acceptedSource.household = { ...acceptedSource.household, revision: 2 };
    acceptedTarget.household = { ...acceptedTarget.household, revision: 2 };
    installLinkReads(acceptedSource, acceptedTarget, notice);

    await expect(
      acceptMinorLinkRequest(
        context(acceptedTarget, 'adult-target'),
        notice.noticeId,
        {
          ...baseCommand(originalTarget.household.householdId),
          responsibilityVersion: 'minor-link-responsibility-v1',
          privacyVersion: 'minor-link-privacy-v1',
        },
      ),
    ).resolves.toMatchObject({
      householdId: originalTarget.household.householdId,
      revision: 2,
      minors: [expect.objectContaining({ user: expect.objectContaining({ userId: 'minor-a' }) })],
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires the paid additional-responsible add-on before accepting an invitation', async () => {
    const family = fixture({ minorIds: ['minor-a'], offerKey: 'family_1_minor' });
    family.profiles.set('adult-additional', profile('adult-additional'));
    const notice = invitation(family);
    installReads(family, { notice });

    await expect(
      acceptAdditionalResponsible(
        context(family, 'adult-additional'),
        notice.noticeId,
        baseCommand(family.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('requires recent authentication for every additional-responsible authority change', async () => {
    const inviteFamily = fixture({
      minorIds: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    inviteFamily.profiles.set('adult-additional', profile('adult-additional'));
    installReads(inviteFamily);

    await expect(
      inviteAdditionalResponsible(
        context(inviteFamily, 'adult-primary', NOW - 10 * 60_000),
        {
          ...baseCommand(inviteFamily.household.householdId),
          intendedAdultId: 'adult-additional',
          minorIds: ['minor-a'],
        },
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    ddbMock.reset();
    const acceptFamily = fixture({
      minorIds: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    acceptFamily.profiles.set('adult-additional', profile('adult-additional'));
    const notice = invitation(acceptFamily);
    installReads(acceptFamily, { notice });

    await expect(
      acceptAdditionalResponsible(
        context(acceptFamily, 'adult-additional', NOW - 10 * 60_000),
        notice.noticeId,
        baseCommand(acceptFamily.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    ddbMock.reset();
    const assignedFamily = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(assignedFamily);

    await expect(
      replaceAdditionalScope(
        context(assignedFamily, 'adult-primary', NOW - 10 * 60_000),
        { ...baseCommand(assignedFamily.household.householdId), minorIds: ['minor-b'] },
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    await expect(
      revokeAdditionalResponsible(
        context(assignedFamily, 'adult-primary', NOW - 10 * 60_000),
        baseCommand(assignedFamily.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('binds an additional-responsible invitation to one concrete adult', async () => {
    const family = fixture({
      minorIds: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    family.profiles.set('adult-additional', profile('adult-additional'));
    family.profiles.set('adult-stranger', profile('adult-stranger'));
    const notice = invitation(family, 'adult-additional');
    installReads(family, { notice });

    await expect(
      acceptAdditionalResponsible(
        context(family, 'adult-stranger'),
        notice.noticeId,
        baseCommand(family.household.householdId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('indexes additional invitations for exactly the sender and intended adult atomically', async () => {
    const family = fixture({ minorIds: ['minor-a'], offerKey: 'family_1_minor_1_additional_responsible' });
    family.profiles.set('adult-additional', profile('adult-additional'));
    installReads(family);
    await inviteAdditionalResponsible(context(family), {
      ...baseCommand(family.household.householdId), intendedAdultId: 'adult-additional', minorIds: ['minor-a'],
    });
    expect(transaction().flatMap((item) => item.Put?.Item?.['entityType'] === 'FamilyInboxPointer' ? [item.Put.Item['pk']] : []).sort())
      .toEqual(['USER#adult-additional', 'USER#adult-primary']);
  });

  it('conditions additional activation on entitlement and the affected minor lifecycle', async () => {
    const family = fixture({
      minorIds: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    family.profiles.set('adult-additional', profile('adult-additional'));
    const notice = invitation(family);
    installReads(family, { notice });

    await acceptAdditionalResponsible(
      context(family, 'adult-additional'),
      notice.noticeId,
      baseCommand(family.household.householdId),
    );

    expect(conditionKeys()).toEqual(expect.arrayContaining([
      FK.familyEntitlement(family.household.householdId),
      K.profile('minor-a'),
      accountClosureKey('minor-a'),
    ]));
    expect(transaction()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: { pk: notice.pk, sk: notice.sk },
          ConditionExpression: expect.stringContaining('expiresAt > :now'),
          ExpressionAttributeValues: expect.objectContaining({ ':now': NOW }),
        }),
      }),
    ]));
  });

  it('returns the accepted additional-responsible result on an exact retry without writing again', async () => {
    const originalFamily = fixture({
      minorIds: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    originalFamily.profiles.set('adult-additional', profile('adult-additional'));
    const notice = {
      ...invitation(originalFamily),
      acceptedById: 'adult-additional',
      acceptanceCommandId: COMMAND_ID,
      state: 'accepted' as const,
      revision: 2,
    };
    const acceptedFamily = fixture({
      minorIds: ['minor-a'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a'],
      offerKey: 'family_1_minor_1_additional_responsible',
    });
    acceptedFamily.household = { ...acceptedFamily.household, revision: 2 };
    installReads(acceptedFamily, { notice });

    await expect(
      acceptAdditionalResponsible(
        context(acceptedFamily, 'adult-additional'),
        notice.noticeId,
        baseCommand(originalFamily.household.householdId),
      ),
    ).resolves.toMatchObject({
      householdId: originalFamily.household.householdId,
      revision: 2,
      additionalResponsible: expect.objectContaining({
        user: expect.objectContaining({ userId: 'adult-additional' }),
      }),
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    ['ended', 'primary_responsible'],
    ['revoked', 'additional_responsible'],
  ] as const)('accepts a fresh invitation after a %s supervision link without resetting its revision', async (state, role) => {
    const family = fixture({ minorIds: ['minor-a'], offerKey: 'family_1_minor_1_additional_responsible', sponsoredPilot: true });
    family.profiles.set('adult-additional', profile('adult-additional'));
    const historical = {
      ...createSupervisionLink({ householdId: family.household.householdId, adultId: 'adult-additional',
        minorId: 'minor-a', role, now: NOW - 4_000 }),
      state, revision: 7, validUntil: NOW - 1_000, updatedAt: NOW - 1_000,
    };
    family.links.push(historical);
    family.coverages.push({
      ...createCoverageAssignment({ householdId: family.household.householdId, accountId: 'adult-additional',
        seatType: role, source: 'sponsored_pilot', now: NOW - 4_000 }),
      state: 'ended', revision: 9,
    });
    const notice = invitation(family);
    installReads(family, { notice });
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      const key = FK.supervision('minor-a', 'adult-additional');
      const write = input.TransactItems?.find((item) =>
        item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk ||
        item.Put?.Item?.['pk'] === key.pk && item.Put.Item['sk'] === key.sk);
      // DynamoDB rejects an existence-only Put because the terminated row still exists.
      if (write?.Put) throw Object.assign(new Error('supervision row already exists'), { name: 'TransactionCanceledException' });
      expect(write?.Update).toMatchObject({
        Key: key,
        ConditionExpression: expect.stringContaining('revision = :expectedRevision'),
        ExpressionAttributeValues: expect.objectContaining({ ':expectedRevision': 7, ':nextRevision': 8,
          ':previousState': state, ':previousRole': role, ':active': 'active', ':additionalRole': 'additional_responsible',
          ':householdId': historical.householdId, ':adultId': historical.adultId, ':minorId': historical.minorId,
          ':now': NOW, ':noEnd': null }),
      });
      for (const predicate of ['#state = :previousState', '#role = :previousRole', 'householdId = :householdId',
        'adultId = :adultId', 'minorId = :minorId']) expect(write?.Update?.ConditionExpression).toContain(predicate);
      expect(write?.Update?.UpdateExpression).toContain('validFrom = :now');
      expect(write?.Update?.UpdateExpression).toContain('validUntil = :noEnd');
      expect(write?.Update?.UpdateExpression).not.toContain('createdAt');
      const accepted = fixture({ minorIds: ['minor-a'], additionalId: 'adult-additional', additionalScope: ['minor-a'],
        offerKey: 'family_1_minor_1_additional_responsible', sponsoredPilot: true });
      accepted.household = { ...accepted.household, revision: 2 };
      installReads(accepted, { notice: { ...notice, state: 'accepted', acceptedById: 'adult-additional',
        acceptanceCommandId: COMMAND_ID, revision: 2 } });
      return {};
    });

    await expect(acceptAdditionalResponsible(context(family, 'adult-additional'), notice.noticeId,
      baseCommand(family.household.householdId))).resolves.toMatchObject({ revision: 2, myRole: 'additional_responsible' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rejects a concurrent change to a historical supervision link atomically', async () => {
    const family = fixture({ minorIds: ['minor-a'], offerKey: 'family_1_minor_1_additional_responsible', sponsoredPilot: true });
    family.profiles.set('adult-additional', profile('adult-additional'));
    family.links.push({
      ...createSupervisionLink({ householdId: family.household.householdId, adultId: 'adult-additional',
        minorId: 'minor-a', role: 'primary_responsible', now: NOW - 4_000 }),
      state: 'ended', revision: 7, validUntil: NOW - 1_000,
    });
    const notice = invitation(family);
    installReads(family, { notice });
    ddbMock.on(TransactWriteCommand).callsFake((input: TransactWriteCommandInput) => {
      const update = input.TransactItems?.find((item) => item.Update?.Key?.sk === 'SUPERVISION#adult-additional')?.Update;
      expect(update?.ExpressionAttributeValues?.[':expectedRevision']).toBe(7);
      // Another writer advanced this row to revision 8 after the consistent snapshot.
      throw Object.assign(new Error('conditional revision changed'), { name: 'TransactionCanceledException' });
    });

    await expect(acceptAdditionalResponsible(context(family, 'adult-additional'), notice.noticeId,
      baseCommand(family.household.householdId))).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(family.household.revision).toBe(1);
    expect(family.seats[2].state).toBe('empty');
    expect(family.links[1].state).toBe('ended');
    expect(notice.state).toBe('pending');
  });

  it('does not reactivate historical supervision with an already consumed invitation', async () => {
    const family = fixture({ minorIds: ['minor-a'], offerKey: 'family_1_minor_1_additional_responsible', sponsoredPilot: true });
    family.links.push({
      ...createSupervisionLink({ householdId: family.household.householdId, adultId: 'adult-additional',
        minorId: 'minor-a', role: 'additional_responsible', now: NOW - 4_000 }),
      state: 'revoked', revision: 7, validUntil: NOW - 1_000,
    });
    const notice = { ...invitation(family), state: 'accepted', acceptedById: 'adult-additional',
      acceptanceCommandId: '11111111-1111-4111-8111-111111111111', revision: 2 };
    installReads(family, { notice });

    await expect(acceptAdditionalResponsible(context(family, 'adult-additional'), notice.noticeId,
      baseCommand(family.household.householdId))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('fences every newly authorized minor during additional scope replacement', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(family);

    await replaceAdditionalScope(context(family), {
      ...baseCommand(family.household.householdId),
      minorIds: ['minor-b'],
    });

    expect(conditionKeys()).toEqual(expect.arrayContaining([
      K.profile('adult-additional'),
      accountClosureKey('adult-additional'),
      K.profile('minor-b'),
      accountClosureKey('minor-b'),
    ]));
  });

  it('blocks newly added additional scope when minor linking is disabled', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(family, { minorLinkingEnabled: false });

    await expect(replaceAdditionalScope(context(family), {
      ...baseCommand(family.household.householdId),
      minorIds: ['minor-a', 'minor-b'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);

    const reducingFamily = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a', 'minor-b'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    ddbMock.reset();
    installReads(reducingFamily, { minorLinkingEnabled: false });
    await expect(replaceAdditionalScope(context(reducingFamily), {
      ...baseCommand(reducingFamily.household.householdId),
      minorIds: ['minor-a'],
    })).resolves.toMatchObject({ householdId: reducingFamily.household.householdId });
  });

  it('rejects primary transfer initiation without recent authentication', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a', 'minor-b'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(family);

    await expect(
      transferPrimaryResponsibility(
        context(family, 'adult-primary', NOW - 10 * 60_000),
        { ...baseCommand(family.household.householdId), newPrimaryAccountId: 'adult-additional' },
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('records a fresh primary proposal without transferring authority immediately', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a', 'minor-b'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    installReads(family);

    await transferPrimaryResponsibility(context(family), {
      ...baseCommand(family.household.householdId),
      newPrimaryAccountId: 'adult-additional',
    });

    const items = transaction();
    expect(items.some((item) => item.Update?.Key?.['sk'] === 'META')).toBe(false);
    expect(items.flatMap((item) => item.Put?.Item?.['entityType'] === 'FamilyInboxPointer' ? [item.Put.Item['pk']] : []).sort())
      .toEqual(['USER#adult-additional', 'USER#adult-primary']);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            ...FK.primaryTransfer(family.household.householdId),
            entityType: 'PrimaryTransferProposal',
            commandId: COMMAND_ID,
            currentPrimaryId: 'adult-primary',
            newPrimaryId: 'adult-additional',
            state: 'pending',
          }),
        }),
      }),
    ]));
  });

  it('transfers only when the exact successor accepts and all minors remain writable', async () => {
    const family = fixture({
      minorIds: ['minor-a', 'minor-b'],
      additionalId: 'adult-additional',
      additionalScope: ['minor-a', 'minor-b'],
      offerKey: 'family_2_minors_1_additional_responsible',
    });
    const proposal = createPrimaryTransferProposal({
      householdId: family.household.householdId,
      currentPrimaryId: 'adult-primary',
      newPrimaryId: 'adult-additional',
      householdRevision: 1,
      commandId: COMMAND_ID,
      now: NOW - 60_000,
      expiresAt: NOW + 840_000,
    });
    installReads(family, { transfer: proposal });

    await transferPrimaryResponsibility(context(family, 'adult-additional'), {
      ...baseCommand(family.household.householdId),
      newPrimaryAccountId: 'adult-additional',
    });

    const items = transaction();
    expect(items.some((item) => item.Update?.Key?.['sk'] === 'META')).toBe(true);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          Key: FK.primaryTransfer(family.household.householdId),
          ConditionExpression: expect.stringContaining('commandId = :commandId'),
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            entityType: 'PrimaryTransferAcceptance',
            householdId: family.household.householdId,
            currentPrimaryId: 'adult-primary',
            newPrimaryId: 'adult-additional',
            commandId: COMMAND_ID,
            acceptedById: 'adult-additional',
          }),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      }),
    ]));
    expect(conditionKeys()).toEqual(expect.arrayContaining([
      K.profile('minor-a'),
      accountClosureKey('minor-a'),
      K.profile('minor-b'),
      accountClosureKey('minor-b'),
    ]));
  });
});
