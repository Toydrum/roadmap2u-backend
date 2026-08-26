import { ApiError, type AccessSummary } from '@app/api/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { readStableAccessSnapshot } from '../access-reader';
import { K, type ProfileItem } from '../db';
import {
  emitCommercialMetric,
  type CommercialEmfMetricName,
  type CommercialMetricStage,
} from '../observability';
import {
  AccessCodeRedeemer,
  type AccessCodeRedemptionDeps,
  type RedemptionAccountSnapshot,
} from './access-code-redemption';
import {
  buildBrokerTransaction,
  buildRedemptionTransaction,
  consumeAccessCodeAttempt,
  parseAccessCodeSecret,
} from './access-code-storage';
import {
  accessCodeCommandKey,
  accessCodeKey,
  type AccessCodeCommandItem,
  type AccessCodeItem,
} from './access-codes';
import { AuditWriter } from './audit';
import { CommercialFlagsResolver } from './flags';
import { accountClosureKey } from './model';
import {
  SponsoredAccessBroker,
  type SponsoredAccessBrokerDeps,
  type SponsoredAccessBrokerProposal,
  type SponsoredAccessCommand,
  type SponsoredGrantSnapshot,
} from './sponsored-access-broker';

export interface AccessCodeDynamoOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly ssm: SSMClient;
  readonly tableName: string;
  readonly auditTableName: string;
  readonly parameterName: string;
  readonly stage: CommercialMetricStage;
  readonly now: () => number;
}

interface ProfileClosureSnapshot {
  readonly profile?: ProfileItem;
  readonly closure?: Readonly<Record<string, unknown>>;
}

const REDEMPTION_METRICS: Readonly<Record<string, CommercialEmfMetricName>> = {
  success: 'AccessCodeRedeemed',
  invalid: 'AccessCodeInvalid',
  rate_limited: 'AccessCodeRateLimited',
  conflict: 'AccessCodeConflict',
};

const BROKER_METRICS: Readonly<Record<string, CommercialEmfMetricName>> = {
  issued: 'AccessCodeIssued',
  revoked: 'AccessCodeRevoked',
  extended: 'AccessCodeExtended',
  conflict: 'AccessCodeConflict',
};

function isTransactionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TransactionCanceledException' ||
      error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionConflictException')
  );
}

async function readProfileClosure(
  options: AccessCodeDynamoOptions,
  ownerSub: string,
): Promise<ProfileClosureSnapshot> {
  const result = await options.ddb.send(
    new TransactGetCommand({
      TransactItems: [
        { Get: { TableName: options.tableName, Key: K.profile(ownerSub) } },
        {
          Get: {
            TableName: options.tableName,
            Key: accountClosureKey(ownerSub),
          },
        },
      ],
    }),
  );
  const [profile, closure] = result.Responses ?? [];
  return {
    ...(profile?.Item ? { profile: profile.Item as ProfileItem } : {}),
    ...(closure?.Item ? { closure: closure.Item as Readonly<Record<string, unknown>> } : {}),
  };
}

async function readCode(
  options: AccessCodeDynamoOptions,
  issuanceId: string,
): Promise<AccessCodeItem | undefined> {
  const result = await options.ddb.send(
    new GetCommand({
      TableName: options.tableName,
      Key: accessCodeKey(issuanceId),
      ConsistentRead: true,
    }),
  );
  return result.Item as AccessCodeItem | undefined;
}

async function readCommand(
  options: AccessCodeDynamoOptions,
  commandId: string,
): Promise<AccessCodeCommandItem | undefined> {
  const result = await options.ddb.send(
    new GetCommand({
      TableName: options.tableName,
      Key: accessCodeCommandKey(commandId),
      ConsistentRead: true,
    }),
  );
  return result.Item as AccessCodeCommandItem | undefined;
}

async function readAccountSnapshot(
  options: AccessCodeDynamoOptions,
  ownerSub: string,
): Promise<RedemptionAccountSnapshot> {
  const [lifecycle, commercial] = await Promise.all([
    readProfileClosure(options, ownerSub),
    readStableAccessSnapshot(options.ddb, options.tableName, ownerSub),
  ]);
  return {
    ...lifecycle,
    ...(commercial.access ? { access: commercial.access } : {}),
    grants: commercial.grants,
  };
}

async function readGrantSnapshot(
  options: AccessCodeDynamoOptions,
  issuanceId: string,
): Promise<SponsoredGrantSnapshot | undefined> {
  const code = await readCode(options, issuanceId);
  const ownerSub = code?.redeemerSub;
  if (!code || code.status !== 'redeemed' || !ownerSub) return undefined;
  const snapshot = await readStableAccessSnapshot(options.ddb, options.tableName, ownerSub);
  const grant = snapshot.grants.find((candidate) => candidate.grantId === `code-${issuanceId}`);
  if (!snapshot.access || !grant) return undefined;
  return {
    code,
    ownerSub,
    grant,
    grants: snapshot.grants,
    access: snapshot.access,
  };
}

async function parameterString(options: AccessCodeDynamoOptions): Promise<string> {
  const result = await options.ssm.send(
    new GetParameterCommand({ Name: options.parameterName, WithDecryption: true }),
  );
  if (result.Parameter?.Type !== 'SecureString') {
    throw new Error('access-code parameter must be a SecureString');
  }
  if (typeof result.Parameter?.Value !== 'string') {
    throw new Error('invalid access-code parameter');
  }
  return result.Parameter.Value;
}

function flagsResolver(options: AccessCodeDynamoOptions): CommercialFlagsResolver {
  return new CommercialFlagsResolver({
    now: options.now,
    readItem: async () => {
      const result = await options.ddb.send(
        new GetCommand({
          TableName: options.tableName,
          Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' },
          ConsistentRead: true,
        }),
      );
      return result.Item;
    },
    emitMetric: (metric) => emitCommercialMetric(metric, options.stage),
  });
}

export function createDynamoAccessCodeRedemptionDeps(
  options: AccessCodeDynamoOptions,
): AccessCodeRedemptionDeps {
  const auditWriter = new AuditWriter({
    ddb: options.ddb,
    tableName: options.auditTableName,
  });
  const config = flagsResolver(options);
  return {
    now: options.now,
    resolveFlags: () => config.resolve(),
    consumeAttempt: (ownerSub, now) =>
      consumeAccessCodeAttempt(options.ddb, options.tableName, ownerSub, now),
    readCode: (issuanceId) => readCode(options, issuanceId),
    readSecretKey: async (version) =>
      parseAccessCodeSecret(await parameterString(options), version).key,
    readAccountSnapshot: (ownerSub) => readAccountSnapshot(options, ownerSub),
    commitRedemption: async (proposal) => {
      try {
        await options.ddb.send(
          new TransactWriteCommand(
            buildRedemptionTransaction(proposal, options.tableName, auditWriter),
          ),
        );
        return 'committed';
      } catch (error) {
        if (!isTransactionConflict(error)) throw error;
        const lifecycle = await readProfileClosure(options, proposal.ownerSub);
        if (!lifecycle.profile || lifecycle.profile.status === 'closing' || lifecycle.closure) {
          throw new ApiError('CONFLICT', 'account closure is in progress');
        }
        return 'conflict';
      }
    },
    emitMetric: (metric) => emitCommercialMetric(REDEMPTION_METRICS[metric], options.stage),
  };
}

export function createDynamoSponsoredAccessBrokerDeps(
  options: AccessCodeDynamoOptions,
  allowlist: SponsoredAccessBrokerDeps['allowlist'],
): SponsoredAccessBrokerDeps {
  const auditWriter = new AuditWriter({
    ddb: options.ddb,
    tableName: options.auditTableName,
  });
  const config = flagsResolver(options);
  return {
    now: options.now,
    resolveFlags: () => config.resolve(),
    readCommand: (commandId) => readCommand(options, commandId),
    readCode: (issuanceId) => readCode(options, issuanceId),
    readGrantSnapshot: (issuanceId) => readGrantSnapshot(options, issuanceId),
    readActiveSecretKey: async () => parseAccessCodeSecret(await parameterString(options)),
    nextIssuanceId: randomUUID,
    randomBytes,
    commit: async (proposal: SponsoredAccessBrokerProposal) => {
      try {
        await options.ddb.send(
          new TransactWriteCommand(
            buildBrokerTransaction(proposal, options.tableName, auditWriter),
          ),
        );
        return 'committed';
      } catch (error) {
        if (isTransactionConflict(error)) return 'conflict';
        throw error;
      }
    },
    emitMetric: (metric) => emitCommercialMetric(BROKER_METRICS[metric], options.stage),
    allowlist,
  };
}

export function createDynamoAccessCodeRedeemer(options: AccessCodeDynamoOptions) {
  return new AccessCodeRedeemer(createDynamoAccessCodeRedemptionDeps(options));
}

export function createDynamoSponsoredAccessBroker(
  options: AccessCodeDynamoOptions,
  allowlist: SponsoredAccessBrokerDeps['allowlist'],
) {
  return new SponsoredAccessBroker(createDynamoSponsoredAccessBrokerDeps(options, allowlist));
}

export async function readAccessCodeUsage(
  options: AccessCodeDynamoOptions,
  ownerSub: string,
): Promise<AccessSummary['usage']> {
  const result = await options.ddb.send(
    new GetCommand({
      TableName: options.tableName,
      Key: { pk: K.user(ownerSub), sk: 'USAGE' },
      ConsistentRead: true,
    }),
  );
  const item = result.Item;
  if (
    item?.['state'] !== 'active' ||
    typeof item['activeTrees'] !== 'number' ||
    !Number.isSafeInteger(item['activeTrees']) ||
    item['activeTrees'] < 0
  ) {
    return { activeTrees: 0, visibleBranchesByTree: {} };
  }
  return { activeTrees: item['activeTrees'], visibleBranchesByTree: {} };
}

export function supportedSponsoredAccessCommands(): readonly SponsoredAccessCommand['command'][] {
  return ['issue-code', 'revoke-code', 'extend-grant', 'revoke-grant', 'metadata'];
}
