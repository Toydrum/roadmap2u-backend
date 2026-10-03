import type { AwsClientStub } from 'aws-sdk-client-mock';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, type BatchGetCommandInput } from '@aws-sdk/lib-dynamodb';
import type { ProfileItem } from '../../lambda/db';
import { K } from '../../lambda/db';
import type { FamilyV2Fixture } from './family-v2-fixture';

/** Install exact family reads after generic commercial stubs; leave other keys alone. */
export function installFamilyV2Reads(
  mock: AwsClientStub<DynamoDBDocumentClient>,
  family: FamilyV2Fixture,
  profiles: readonly ProfileItem[],
  current: () => boolean = () => true,
): void {
  for (const profile of profiles) {
    mock.on(GetCommand, { Key: K.profile(profile.userId) }).resolves({ Item: profile });
  }
  for (const row of family.coverages) {
    mock.on(GetCommand, { Key: { pk: row.pk, sk: row.sk } }).resolves({ Item: row });
  }
  mock.on(QueryCommand, { ExpressionAttributeValues: { ':pk': family.household.pk } })
    .callsFake(() => ({ Items: current() ? [family.household, ...family.seats] : [] }));
  for (const seat of family.seats) {
    if (seat.seatType !== 'minor' || !seat.accountId) continue;
    mock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': K.user(seat.accountId), ':prefix': 'SUPERVISION#' },
    }).callsFake(() => ({
      Items: family.supervisionLinks.filter((link) => link.minorId === seat.accountId),
    }));
  }
  mock.on(BatchGetCommand).callsFake((input: BatchGetCommandInput) => ({
    Responses: Object.fromEntries(Object.entries(input.RequestItems ?? {}).map(([table, request]) => [
      table, family.coverages.filter((row) => request.Keys?.some((key) => key.pk === row.pk && key.sk === row.sk)),
    ])),
  }));
}
