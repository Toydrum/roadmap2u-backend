import { describe, expect, it } from 'vitest';
import { buildMajorityTransition } from '../lambda/family/majority-transition';
import { reconcileDueMajority } from '../lambda/family-majority-reconciler';
import { familyV2Fixture } from './support/family-v2-fixture';
import { installFamilyV2Reads } from './support/family-v2-reads';
import { FK } from '../lambda/family/keys';
import { K, type ProfileItem } from '../lambda/db';
import { AuditWriter } from '../lambda/commercial/audit';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const NOW = Date.parse('2035-01-01T00:00:00.000Z');
const MINOR = 'minor-grown';

function profile(): ProfileItem {
  return { ...K.profile(MINOR), userId: MINOR, username: 'minor_grown',
    displayName: 'Minor', accountType: 'minor', socialEnabled: true,
    createdAt: NOW - 1_000_000, status: 'active', majorityAt: '2035-01-01',
    gsi2pk: 'FAMILY#MAJORITY', gsi2sk: `2035-01-01#${MINOR}` };
}

describe('family majority transition', () => {
  it('keeps the account, ends supervision and family coverage, and opens an adult household', () => {
    const family = familyV2Fixture({ now: NOW, primaryId: 'primary', minorIds: [MINOR] });
    const items = buildMajorityTransition({ tableName: 'roadmap-dev', now: NOW,
      profile: profile(), snapshot: family });
    expect(items.some((item) => item.Delete)).toBe(false);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ Update: expect.objectContaining({
        Key: K.profile(MINOR), UpdateExpression: expect.stringContaining('accountType = :adult'),
      }) }),
      expect.objectContaining({ Update: expect.objectContaining({
        Key: FK.familyCoverage(MINOR),
        ExpressionAttributeValues: expect.objectContaining({ ':ended': 'ended' }),
      }) }),
      expect.objectContaining({ Put: expect.objectContaining({
        Item: expect.objectContaining({ entityType: 'Household', primaryResponsibleId: MINOR }),
      }) }),
    ]));
    expect(items.filter((item) => item.Update?.Key?.['sk']?.toString().startsWith('SUPERVISION#')))
      .toHaveLength(1);
  });

  it('releases an additional responsible seat when its only minor reaches majority', () => {
    const family = familyV2Fixture({ now: NOW, primaryId: 'primary', minorIds: [MINOR],
      additionalResponsibleSeat: 1, additionalId: 'extra', additionalScope: [MINOR] });
    const items = buildMajorityTransition({ tableName: 'roadmap-dev', now: NOW,
      profile: profile(), snapshot: family });
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ Update: expect.objectContaining({ Key: FK.additionalSeat(family.household.householdId) }) }),
      expect.objectContaining({ Update: expect.objectContaining({ Key: FK.familyCoverage('extra') }) }),
    ]));
  });

  it('runs the due transition from the sparse index and updates Cognito before the transaction', async () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const cognitoMock = mockClient(CognitoIdentityProviderClient);
    ddbMock.reset();
    cognitoMock.reset();
    const family = familyV2Fixture({ now: NOW, primaryId: 'primary', minorIds: [MINOR] });
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const cognito = new CognitoIdentityProviderClient({});
    installFamilyV2Reads(ddbMock, family, [profile()]);
    ddbMock.on(QueryCommand, { IndexName: 'gsi2' }).resolves({ Items: [profile()] });
    ddbMock.on(TransactWriteCommand).resolves({});
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    const outcome = await reconcileDueMajority({ ddb, cognito, tableName: 'roadmap-dev',
      userPoolId: 'pool', auditWriter: new AuditWriter({ ddb, tableName: 'audit-dev' }),
      now: () => NOW }, 'request-1');
    expect(outcome).toBe(1);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input)
      .toMatchObject({ Username: 'minor_grown',
        UserAttributes: [{ Name: 'custom:accountType', Value: 'adult' }] });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });
});
