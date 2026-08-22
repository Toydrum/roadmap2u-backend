import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveAccessItem } from '../lambda/commercial/access-resolver';
import {
  buildIssuedAccessCode,
  buildSponsoredGrant,
  computeAccessCodeMac,
  parseAccessCode,
  resolveAccessCodeTerms,
} from '../lambda/commercial/access-codes';
import type { RedemptionCommitProposal } from '../lambda/commercial/access-code-redemption';
import { AuditWriter } from '../lambda/commercial/audit';
import {
  buildBrokerTransaction,
  buildRedemptionTransaction,
  consumeAccessCodeAttempt,
  parseAccessCodeSecret,
} from '../lambda/commercial/access-code-storage';
import type { SponsoredAccessBrokerProposal } from '../lambda/commercial/sponsored-access-broker';

const NOW = Date.parse('2026-08-22T18:30:00.000Z');
const OWNER = 'sub-adult';
const ISSUANCE_ID = '7c9bd8cb-78ce-43c7-a9b8-8e2865f3f47a';
const HMAC_KEY = Buffer.alloc(32, 0x5a);
const SECRET = Buffer.alloc(32, 0x31);
const ddbMock = mockClient(DynamoDBDocumentClient);

function code() {
  const parsed = parseAccessCode(`RM2U1.${ISSUANCE_ID}.${SECRET.toString('base64url')}`)!;
  return buildIssuedAccessCode({
    issuanceId: ISSUANCE_ID,
    secretMac: computeAccessCodeMac(parsed, HMAC_KEY),
    secretKeyVersion: 'v1',
    issuedAt: NOW - 1_000,
    issuedBy: 'operator',
    reason: 'beta',
    terms: resolveAccessCodeTerms({}),
  });
}

function auditWriter() {
  return new AuditWriter({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: 'audit-table',
  });
}

function redemptionProposal(): RedemptionCommitProposal {
  const stored = code();
  const grant = buildSponsoredGrant(stored, OWNER, NOW);
  const previous = deriveAccessItem(OWNER, NOW - 1, undefined, []);
  return {
    ownerSub: OWNER,
    issuanceId: ISSUANCE_ID,
    expectedCodeRevision: 1,
    expectedAccessRevision: previous.revision,
    redeemedAt: NOW,
    requestId: 'request-1',
    grant,
    access: deriveAccessItem(OWNER, NOW, previous, [grant]),
    audit: {
      targetKind: 'ACCESS_CODE',
      targetId: ISSUANCE_ID,
      timestamp: NOW,
      requestId: 'request-1',
      action: 'access_code.redeemed',
      actor: OWNER,
      subject: grant.grantId,
      details: { fingerprint: stored.fingerprint },
    },
  };
}

describe('access-code secret parsing and DynamoDB transaction builders', () => {
  beforeEach(() => ddbMock.reset());

  it('reads only an allowlisted active/versioned key with at least 256 bits', () => {
    const secretString = JSON.stringify({
      activeVersion: 'v2',
      v1: 'a'.repeat(32),
      v2: 'b'.repeat(48),
    });

    expect(parseAccessCodeSecret(secretString)).toEqual({
      version: 'v2',
      key: Buffer.from('b'.repeat(48), 'utf8'),
    });
    expect(parseAccessCodeSecret(secretString, 'v1')).toEqual({
      version: 'v1',
      key: Buffer.from('a'.repeat(32), 'utf8'),
    });
    expect(() =>
      parseAccessCodeSecret(JSON.stringify({ activeVersion: 'v1', v1: 'a'.repeat(31) })),
    ).toThrow('invalid access-code secret');
    expect(() => parseAccessCodeSecret('{"activeVersion":"v1"}')).toThrow(
      'invalid access-code secret',
    );
  });

  it('builds one six-part atomic redemption with lifecycle, CAS and append-only guards', () => {
    const transaction = buildRedemptionTransaction(
      redemptionProposal(),
      'roadmap-dev',
      auditWriter(),
    );

    expect(transaction.TransactItems).toHaveLength(6);
    const serialized = JSON.stringify(transaction);
    expect(serialized).toContain('#status = :issued');
    expect(serialized).toContain('redeemBy > :redeemedAt');
    expect(serialized).toContain('accountType = :adult');
    expect(serialized).toContain('attribute_not_exists(pk) AND attribute_not_exists(sk)');
    expect(serialized).toContain('revision = :expectedRevision');
    expect(serialized).not.toContain(code().secretMac);
    expect(serialized).not.toContain(SECRET.toString('base64url'));
  });

  it('builds issue-code as CODE + COMMAND + append-only audit with no plaintext', () => {
    const stored = code();
    const proposal: SponsoredAccessBrokerProposal = {
      kind: 'issue-code',
      code: stored,
      commandItem: {
        pk: 'ADMIN#SPONSORED',
        sk: 'COMMAND#e3850eda-32e1-4b2b-a1bf-233226881128',
        commandId: 'e3850eda-32e1-4b2b-a1bf-233226881128',
        action: 'issue-code',
        requestHash: 'a'.repeat(64),
        actor: 'operator',
        reason: 'beta',
        status: 'committed',
        result: { metadata: { issuanceId: ISSUANCE_ID } },
        createdAt: NOW,
      },
      audit: {
        targetKind: 'ACCESS_CODE',
        targetId: ISSUANCE_ID,
        timestamp: NOW,
        requestId: 'request-1',
        action: 'access_code.issued',
        actor: 'operator',
        subject: ISSUANCE_ID,
        details: { fingerprint: stored.fingerprint },
      },
    };

    const transaction = buildBrokerTransaction(proposal, 'roadmap-dev', auditWriter());

    expect(transaction.TransactItems).toHaveLength(3);
    expect(transaction.TransactItems?.[0]?.Put?.Item).toEqual(stored);
    expect(transaction.TransactItems?.[1]?.Put?.Item).toEqual(proposal.commandItem);
    const audit = transaction.TransactItems?.[2]?.Put?.Item;
    expect(JSON.stringify({ command: proposal.commandItem, audit })).not.toContain(
      stored.secretMac,
    );
  });

  it('atomically permits attempts one through five and returns retry time on the sixth', async () => {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(
        Object.assign(new Error('limited'), { name: 'ConditionalCheckFailedException' }),
      );

    await expect(consumeAccessCodeAttempt(ddb, 'roadmap-dev', OWNER, NOW)).resolves.toEqual({
      allowed: true,
    });
    await expect(consumeAccessCodeAttempt(ddb, 'roadmap-dev', OWNER, NOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1_800,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('#count < :limit');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':limit': 5 });
    expect(input.Key).toEqual({
      pk: `ACCESS_CODE_ATTEMPT#${OWNER}`,
      sk: 'HOUR#2026-08-22T18',
    });
  });
});
