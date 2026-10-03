import { createHash } from 'node:crypto';

const FAMILY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function assertFamilyIdentifier(value: string, label: string): void {
  if (!FAMILY_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-empty opaque identifier`);
  }
}

export function householdIdForPrimary(primaryResponsibleId: string): string {
  assertFamilyIdentifier(primaryResponsibleId, 'primaryResponsibleId');
  const digest = createHash('sha256')
    .update('roadmap2u:household:v2\0', 'utf8')
    .update(primaryResponsibleId, 'utf8')
    .digest('hex');
  return `hh_${digest}`;
}

export function supervisionLinkId(
  householdId: string,
  minorId: string,
  adultId: string,
): string {
  assertFamilyIdentifier(householdId, 'householdId');
  assertFamilyIdentifier(minorId, 'minorId');
  assertFamilyIdentifier(adultId, 'adultId');
  const digest = createHash('sha256')
    .update('roadmap2u:supervision:v2\0', 'utf8')
    .update(householdId, 'utf8')
    .update('\0', 'utf8')
    .update(minorId, 'utf8')
    .update('\0', 'utf8')
    .update(adultId, 'utf8')
    .digest('hex');
  return `sl_${digest}`;
}

function householdPartition(householdId: string): string {
  assertFamilyIdentifier(householdId, 'householdId');
  return `HOUSEHOLD#${householdId}`;
}

function userPartition(accountId: string, label: string): string {
  assertFamilyIdentifier(accountId, label);
  return `USER#${accountId}`;
}

export const FK = Object.freeze({
  household: (householdId: string) => ({
    pk: householdPartition(householdId),
    sk: 'META' as const,
  }),
  minorSeat: (householdId: string, seat: 1 | 2) => {
    if (seat !== 1 && seat !== 2) throw new RangeError('minor seat must be 1 or 2');
    return {
      pk: householdPartition(householdId),
      sk: `SEAT#MINOR#${seat}` as const,
    };
  },
  additionalSeat: (householdId: string) => ({
    pk: householdPartition(householdId),
    sk: 'SEAT#ADDITIONAL' as const,
  }),
  supervision: (minorId: string, adultId: string) => ({
    pk: userPartition(minorId, 'minorId'),
    sk: `SUPERVISION#${userPartition(adultId, 'adultId').slice('USER#'.length)}` as const,
  }),
  supervisionByAdult: (adultId: string, minorId: string) => ({
    gsi1pk: userPartition(adultId, 'adultId'),
    gsi1sk: `SUPERVISION#${userPartition(minorId, 'minorId').slice('USER#'.length)}` as const,
  }),
  familyCoverage: (accountId: string) => ({
    pk: userPartition(accountId, 'accountId'),
    sk: 'COVERAGE#FAMILY' as const,
  }),
  familyEntitlement: (householdId: string) => ({
    pk: householdPartition(householdId),
    sk: 'ENTITLEMENT#FAMILY' as const,
  }),
  minorConsent: (minorId: string) => ({
    pk: userPartition(minorId, 'minorId'),
    sk: 'CONSENT#FAMILY_ONBOARDING' as const,
  }),
  minorLinkAcceptance: (minorId: string, requestId: string) => {
    assertFamilyIdentifier(requestId, 'requestId');
    return {
      pk: userPartition(minorId, 'minorId'),
      sk: `CONSENT#FAMILY_LINK#${requestId}` as const,
    };
  },
  primaryTransfer: (householdId: string) => ({
    pk: householdPartition(householdId),
    sk: 'TRANSFER#PRIMARY' as const,
  }),
  primaryTransferAcceptance: (householdId: string, commandId: string) => {
    assertFamilyIdentifier(commandId, 'commandId');
    return {
      pk: householdPartition(householdId),
      sk: `AUDIT#PRIMARY_TRANSFER#${commandId}` as const,
    };
  },
});
