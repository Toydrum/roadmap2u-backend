import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Ctx } from '../lambda/authz';
import type { Deps, ProfileItem } from '../lambda/db';
import { createEmptySeatAssignments, createHousehold } from '../lambda/family/model';

const NOW = 1_800_000_000_000;
const COMMAND_ID = '9c09f76b-246a-4f0d-a188-8ba97f7f518d';
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

type HouseholdModule = Record<string, (...args: never[]) => Promise<unknown>>;

async function loadHousehold(): Promise<HouseholdModule | null> {
  const modulePath = '../lambda/handlers/' + 'household';
  return import(modulePath).catch(() => null) as Promise<HouseholdModule | null>;
}

function primaryProfile(): ProfileItem {
  return {
    pk: 'USER#adult-primary',
    sk: 'PROFILE',
    userId: 'adult-primary',
    username: 'primary',
    displayName: 'Primary',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW - 1_000,
    status: 'active',
    familyFenceVersion: 1,
  };
}

function context(): Ctx {
  const deps: Deps = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}) as Deps['cognito'],
    table: 'roadmap',
    userPoolId: 'pool-1',
    now: () => NOW,
  };
  return { callerId: 'adult-primary', caller: primaryProfile(), authenticatedAt: NOW - 60_000, deps };
}

function command(householdId: string) {
  return {
    householdId,
    expectedHouseholdRevision: 1,
    commandId: COMMAND_ID,
    policyVersion: 'family-policy-v2',
  };
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

describe('family v2 household handlers', () => {
  it('rejects unknown JSON keys on every mutating route before any I/O', async () => {
    const household = await loadHousehold();
    for (const name of [
      'createMinor',
      'createMinorLinkRequest',
      'approveMinorLinkRequest',
      'acceptMinorLinkRequest',
      'inviteAdditionalResponsible',
      'acceptAdditionalResponsible',
      'replaceAdditionalScope',
      'revokeAdditionalResponsible',
      'transferPrimaryResponsibility',
    ]) {
      expect(household?.[name], name).toBeTypeOf('function');
    }

    const base = command('household-a');
    const cases: Array<[string, unknown[], Record<string, unknown>]> = [
      [
        'createMinor',
        [],
        {
          ...base,
          username: 'child_one',
          country: 'MX',
          majorityAt: '2035-01-01',
          declarationVersion: 'declaration-v1',
          consentVersion: 'consent-v1',
        },
      ],
      ['createMinorLinkRequest', [], { ...base, code: 'ABC123' }],
      ['approveMinorLinkRequest', ['request-a'], base],
      [
        'acceptMinorLinkRequest',
        ['request-a'],
        {
          ...base,
          responsibilityVersion: 'minor-link-responsibility-v1',
          privacyVersion: 'minor-link-privacy-v1',
        },
      ],
      [
        'inviteAdditionalResponsible',
        [],
        { ...base, intendedAdultId: 'adult-additional', minorIds: ['minor-a'] },
      ],
      ['acceptAdditionalResponsible', ['invitation-a'], base],
      ['replaceAdditionalScope', [], { ...base, minorIds: ['minor-a'] }],
      ['revokeAdditionalResponsible', [], base],
      [
        'transferPrimaryResponsibility',
        [],
        { ...base, newPrimaryAccountId: 'adult-additional' },
      ],
    ];

    for (const [name, pathArgs, body] of cases) {
      const call = household![name];
      await expect(
        call(context() as never, ...(pathArgs as never[]), { ...body, unexpected: true } as never),
        name,
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rejects a command from another policy version before any I/O', async () => {
    const household = await loadHousehold();
    expect(household?.['revokeAdditionalResponsible']).toBeTypeOf('function');

    await expect(
      household!['revokeAdditionalResponsible'](
        context() as never,
        { ...command('household-a'), policyVersion: 'family-policy-v1' } as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns the deterministic empty Household created at adult signup', async () => {
    const householdModule = await loadHousehold();
    expect(householdModule?.['getHousehold']).toBeTypeOf('function');
    const ctx = context();
    const household = createHousehold({ primaryResponsibleId: ctx.callerId, now: NOW - 1_000 });
    const seats = createEmptySeatAssignments(household.householdId, NOW - 1_000);
    ddbMock.on(QueryCommand).resolves({ Items: [household, ...seats] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: [] } });
    ddbMock.on(GetCommand).resolves({ Item: primaryProfile() });

    await expect(householdModule!['getHousehold'](ctx as never)).resolves.toMatchObject({
      contractVersion: 1,
      householdId: household.householdId,
      myRole: 'primary_responsible',
      primaryResponsible: { userId: 'adult-primary' },
      minors: [],
      availableMinorSeats: 2,
      additionalResponsibleSeatAvailable: true,
      revision: 1,
    });
  });

  it('does not create a Cognito minor before paid family coverage exists', async () => {
    const householdModule = await loadHousehold();
    expect(householdModule?.['createMinor']).toBeTypeOf('function');
    const ctx = context();
    const household = createHousehold({ primaryResponsibleId: ctx.callerId, now: NOW - 1_000 });
    const seats = createEmptySeatAssignments(household.householdId, NOW - 1_000);
    ddbMock.on(QueryCommand).resolves({ Items: [household, ...seats] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { roadmap: [] } });

    await expect(
      householdModule!['createMinor'](ctx as never, {
        ...command(household.householdId),
        username: 'child_one',
        country: 'MX',
        majorityAt: '2035-01-01',
        declarationVersion: 'declaration-v1',
        consentVersion: 'consent-v1',
      } as never),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(cognitoMock.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});
