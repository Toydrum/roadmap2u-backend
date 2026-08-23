import { ApiError } from '@app/api/contracts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createDynamoSponsoredAccessBroker,
  supportedSponsoredAccessCommands,
  type AccessCodeDynamoOptions,
} from './commercial/access-code-dynamo';
import type {
  SponsoredAccessBrokerContext,
  SponsoredAccessBrokerDeps,
  SponsoredAccessBrokerResult,
  SponsoredAccessCommand,
} from './commercial/sponsored-access-broker';
import { errorResponse, type HttpResponse } from './http';
import { instrumentHandler } from './observability';
import { isTrustedRequestId } from './request-id';

export interface SponsoredAccessBrokerEvent {
  readonly rawQueryString?: string;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: { readonly method?: string };
    readonly authorizer?: { readonly iam?: { readonly userArn?: string } };
  };
}

export interface SponsoredAccessBrokerHandlerDeps {
  readonly execute: (
    command: SponsoredAccessCommand,
    context: SponsoredAccessBrokerContext,
  ) => Promise<SponsoredAccessBrokerResult | Readonly<Record<string, unknown>>>;
}

const MAX_BODY_BYTES = 4_096;
const NO_STORE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function parseBody(event: SponsoredAccessBrokerEvent): SponsoredAccessCommand {
  if (
    event.isBase64Encoded ||
    event.rawQueryString ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new ApiError('VALIDATION');
  }
  let value: unknown;
  try {
    value = JSON.parse(event.body);
  } catch {
    throw new ApiError('VALIDATION');
  }
  if (!isRecord(value) || typeof value['command'] !== 'string') {
    throw new ApiError('VALIDATION');
  }

  if (value['command'] === 'issue-code') {
    if (
      !exactKeys(
        value,
        ['command', 'stage', 'commandId', 'reason', 'grantOfferKey', 'confirmHash'],
        ['permanent', 'confirmPermanent', 'durationSeconds', 'redeemWindowSeconds'],
      ) ||
      value['grantOfferKey'] !== 'premium_demo' ||
      (value['permanent'] !== undefined && typeof value['permanent'] !== 'boolean') ||
      (value['confirmPermanent'] !== undefined && typeof value['confirmPermanent'] !== 'boolean') ||
      (value['durationSeconds'] !== undefined && typeof value['durationSeconds'] !== 'number') ||
      (value['redeemWindowSeconds'] !== undefined &&
        typeof value['redeemWindowSeconds'] !== 'number')
    ) {
      throw new ApiError('VALIDATION');
    }
    return value as unknown as SponsoredAccessCommand;
  }

  if (value['command'] === 'revoke-code' || value['command'] === 'revoke-grant') {
    if (
      !exactKeys(value, ['command', 'stage', 'commandId', 'reason', 'issuanceId', 'confirmHash'])
    ) {
      throw new ApiError('VALIDATION');
    }
    return value as unknown as SponsoredAccessCommand;
  }

  if (value['command'] === 'extend-grant') {
    if (
      !exactKeys(value, [
        'command',
        'stage',
        'commandId',
        'reason',
        'issuanceId',
        'newExpiresAt',
        'confirmHash',
      ]) ||
      typeof value['newExpiresAt'] !== 'number'
    ) {
      throw new ApiError('VALIDATION');
    }
    return value as unknown as SponsoredAccessCommand;
  }

  if (value['command'] === 'metadata') {
    if (!exactKeys(value, ['command', 'stage', 'issuanceId'])) {
      throw new ApiError('VALIDATION');
    }
    return value as unknown as SponsoredAccessCommand;
  }

  throw new ApiError('VALIDATION');
}

function noStore(response: HttpResponse): HttpResponse {
  return { ...response, headers: { ...response.headers, 'cache-control': 'no-store' } };
}

export function createSponsoredAccessBrokerHandler(deps: SponsoredAccessBrokerHandlerDeps) {
  return async (event: SponsoredAccessBrokerEvent): Promise<HttpResponse> => {
    try {
      if (event.requestContext?.http?.method !== 'POST') throw new ApiError('VALIDATION');
      const actorArn = event.requestContext.authorizer?.iam?.userArn;
      const requestId = event.requestContext.requestId;
      if (
        typeof actorArn !== 'string' ||
        !actorArn ||
        !isTrustedRequestId(requestId)
      ) {
        throw new ApiError('UNAUTHENTICATED');
      }
      const command = parseBody(event);
      const result = await deps.execute(command, { actorArn, requestId });
      return {
        statusCode: 200,
        headers: { ...NO_STORE_HEADERS },
        body: JSON.stringify(result),
      };
    } catch (error) {
      return noStore(errorResponse(error));
    }
  };
}

type BrokerAllowlist = SponsoredAccessBrokerDeps['allowlist'];

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAllowlist(raw: string, stage: string): BrokerAllowlist {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('SPONSORED_ACCESS_ALLOWLIST must be valid JSON');
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('SPONSORED_ACCESS_ALLOWLIST must contain exactly one operator role');
  }
  const commands = supportedSponsoredAccessCommands();
  const expectedCommands = [...commands].sort().join(',');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(',') !== 'accountId,commands,roleName,stage' ||
      typeof entry['accountId'] !== 'string' ||
      !/^[0-9]{12}$/.test(entry['accountId']) ||
      typeof entry['roleName'] !== 'string' ||
      !/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(entry['roleName']) ||
      entry['stage'] !== stage ||
      !Array.isArray(entry['commands']) ||
      !entry['commands'].every((command) =>
        commands.includes(command as SponsoredAccessCommand['command']),
      ) ||
      [...entry['commands']].sort().join(',') !== expectedCommands
    ) {
      throw new Error('SPONSORED_ACCESS_ALLOWLIST contains an invalid entry');
    }
    return {
      accountId: entry['accountId'],
      roleName: entry['roleName'],
      stage,
      commands,
    };
  });
}

let productionHandler: ((event: SponsoredAccessBrokerEvent) => Promise<HttpResponse>) | undefined;

function production(): (event: SponsoredAccessBrokerEvent) => Promise<HttpResponse> {
  if (productionHandler) return productionHandler;
  const stage = requiredEnvironment('COMMERCIAL_STAGE');
  if (stage !== 'dev' && stage !== 'test' && stage !== 'prod') {
    throw new Error('COMMERCIAL_STAGE must be dev, test, or prod');
  }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const options: AccessCodeDynamoOptions = {
    ddb,
    secrets: new SecretsManagerClient({}),
    tableName: requiredEnvironment('TABLE_NAME'),
    auditTableName: requiredEnvironment('AUDIT_TABLE_NAME'),
    secretId: requiredEnvironment('ACCESS_CODE_SECRET_ID'),
    stage,
    now: Date.now,
  };
  const broker = createDynamoSponsoredAccessBroker(
    options,
    parseAllowlist(requiredEnvironment('SPONSORED_ACCESS_ALLOWLIST'), stage),
  );
  productionHandler = createSponsoredAccessBrokerHandler({
    execute: (command, context) => broker.execute(command, context),
  });
  return productionHandler;
}

export const handler = instrumentHandler(
  'sponsored-access-broker',
  (event: SponsoredAccessBrokerEvent): Promise<HttpResponse> => production()(event),
);
