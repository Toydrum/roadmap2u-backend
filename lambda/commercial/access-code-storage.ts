import {
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { K } from '../db';
import { accountClosureKey, accessKey } from './model';
import { accessCodeAttemptKey, accessCodeKey } from './access-codes';
import type { RedemptionCommitProposal } from './access-code-redemption';
import type { AuditWriter } from './audit';
import type { SponsoredAccessBrokerProposal } from './sponsored-access-broker';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const ABSENT_KEY_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
const HOUR_MS = 60 * 60 * 1_000;
const MAX_ATTEMPTS_PER_HOUR = 5;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAccessCodeSecret(
  secretString: string,
  requestedVersion?: string,
): { readonly version: string; readonly key: Buffer } {
  let value: unknown;
  try {
    value = JSON.parse(secretString);
  } catch {
    throw new Error('invalid access-code secret');
  }
  if (
    !isRecord(value) ||
    typeof value['activeVersion'] !== 'string' ||
    !KEY_VERSION_PATTERN.test(value['activeVersion'])
  ) {
    throw new Error('invalid access-code secret');
  }
  const keys = Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== 'activeVersion'),
  );
  if (
    Object.keys(keys).length === 0 ||
    !Object.entries(keys).every(
      ([version, secret]) =>
        KEY_VERSION_PATTERN.test(version) &&
        typeof secret === 'string' &&
        /^[A-Za-z0-9_-]{32,128}$/.test(secret),
    )
  ) {
    throw new Error('invalid access-code secret');
  }
  const version = requestedVersion ?? value['activeVersion'];
  if (!KEY_VERSION_PATTERN.test(version)) throw new Error('invalid access-code secret');
  const secret = keys[version];
  if (typeof secret !== 'string') throw new Error('invalid access-code secret');
  return { version, key: Buffer.from(secret, 'utf8') };
}

function profileCondition(tableName: string, ownerSub: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: K.profile(ownerSub),
      ConditionExpression:
        'attribute_exists(pk) AND userId = :ownerSub AND accountType = :adult AND attribute_exists(email) AND (attribute_not_exists(#status) OR #status = :active)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':ownerSub': ownerSub,
        ':adult': 'adult',
        ':active': 'active',
      },
    },
  };
}

function closureCondition(tableName: string, ownerSub: string): TransactItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: accountClosureKey(ownerSub),
      ConditionExpression: ABSENT_KEY_CONDITION,
    },
  };
}

function accessPut(
  tableName: string,
  item: RedemptionCommitProposal['access'],
  expectedRevision: number | null,
): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        expectedRevision === null ? ABSENT_KEY_CONDITION : 'revision = :expectedRevision',
      ...(expectedRevision === null
        ? {}
        : { ExpressionAttributeValues: { ':expectedRevision': expectedRevision } }),
    },
  };
}

export function buildRedemptionTransaction(
  proposal: RedemptionCommitProposal,
  tableName: string,
  auditWriter: AuditWriter,
): TransactWriteCommandInput {
  return {
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: accessCodeKey(proposal.issuanceId),
          UpdateExpression:
            'SET #status = :redeemed, redeemerSub = :ownerSub, redeemedAt = :redeemedAt, updatedAt = :redeemedAt, revision = :nextRevision',
          ConditionExpression:
            '#status = :issued AND revision = :expectedRevision AND redeemBy > :redeemedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':issued': 'issued',
            ':redeemed': 'redeemed',
            ':ownerSub': proposal.ownerSub,
            ':redeemedAt': proposal.redeemedAt,
            ':expectedRevision': proposal.expectedCodeRevision,
            ':nextRevision': proposal.expectedCodeRevision + 1,
          },
        },
      },
      profileCondition(tableName, proposal.ownerSub),
      closureCondition(tableName, proposal.ownerSub),
      {
        Put: {
          TableName: tableName,
          Item: proposal.grant,
          ConditionExpression: ABSENT_KEY_CONDITION,
        },
      },
      accessPut(tableName, proposal.access, proposal.expectedAccessRevision),
      auditWriter.transactPut(proposal.audit),
    ],
  };
}

function commandPut(tableName: string, proposal: SponsoredAccessBrokerProposal): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: proposal.commandItem,
      ConditionExpression: ABSENT_KEY_CONDITION,
    },
  };
}

export function buildBrokerTransaction(
  proposal: SponsoredAccessBrokerProposal,
  tableName: string,
  auditWriter: AuditWriter,
): TransactWriteCommandInput {
  if (proposal.kind === 'issue-code') {
    return {
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: proposal.code,
            ConditionExpression: ABSENT_KEY_CONDITION,
          },
        },
        commandPut(tableName, proposal),
        auditWriter.transactPut(proposal.audit),
      ],
    };
  }

  if (proposal.kind === 'revoke-code') {
    return {
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: accessCodeKey(proposal.issuanceId),
            UpdateExpression:
              'SET #status = :revoked, revokedAt = :revokedAt, revokedBy = :revokedBy, updatedAt = :revokedAt, revision = :nextRevision',
            ConditionExpression: '#status = :issued AND revision = :expectedRevision',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':issued': 'issued',
              ':revoked': 'revoked',
              ':revokedAt': proposal.revokedAt,
              ':revokedBy': proposal.revokedBy,
              ':expectedRevision': proposal.expectedCodeRevision,
              ':nextRevision': proposal.expectedCodeRevision + 1,
            },
          },
        },
        commandPut(tableName, proposal),
        auditWriter.transactPut(proposal.audit),
      ],
    };
  }

  return {
    TransactItems: [
      profileCondition(tableName, proposal.ownerSub),
      closureCondition(tableName, proposal.ownerSub),
      {
        Put: {
          TableName: tableName,
          Item: proposal.grant,
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: {
            ':expectedRevision': proposal.expectedGrantRevision,
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: proposal.access,
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: {
            ':expectedRevision': proposal.expectedAccessRevision,
          },
        },
      },
      commandPut(tableName, proposal),
      auditWriter.transactPut(proposal.audit),
    ],
  };
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionConflictException')
  );
}

export async function consumeAccessCodeAttempt(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ownerSub: string,
  now: number,
): Promise<
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
> {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const nextHour = hourStart + HOUR_MS;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: accessCodeAttemptKey(ownerSub, now),
        UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :one',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': MAX_ATTEMPTS_PER_HOUR,
          ':ttl': Math.floor((nextHour + HOUR_MS) / 1_000),
        },
      }),
    );
    return { allowed: true };
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((nextHour - now) / 1_000)),
    };
  }
}

export function accessCodeStorageKeys(ownerSub: string, issuanceId: string) {
  return {
    code: accessCodeKey(issuanceId),
    access: accessKey(ownerSub),
  };
}
