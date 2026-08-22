import { ApiError, type AccessSummary } from '@app/api/contracts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { accessSummary } from './access-reader';
import type { RedeemAccessCodeInput } from './commercial/access-code-redemption';
import {
  createDynamoAccessCodeRedeemer,
  readAccessCodeUsage,
  type AccessCodeDynamoOptions,
} from './commercial/access-code-dynamo';
import type { AccessItem } from './commercial/model';
import { errorResponse, type HttpResponse } from './http';
import { instrumentHandler } from './observability';

export interface AccessCodeRedeemerEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: { readonly method?: string };
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: Readonly<Record<string, unknown>> };
    };
  };
}

export interface AccessCodeRedeemerHandlerDeps {
  readonly redeem: (input: RedeemAccessCodeInput) => Promise<AccessItem>;
  readonly readUsage: (ownerSub: string) => Promise<AccessSummary['usage']>;
}

const NO_STORE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
});
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_BODY_BYTES = 512;

function noStore(response: HttpResponse): HttpResponse {
  return { ...response, headers: { ...response.headers, 'cache-control': 'no-store' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(event: AccessCodeRedeemerEvent): { readonly code: string } {
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
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value['code'] !== 'string') {
    throw new ApiError('VALIDATION');
  }
  return { code: value['code'] };
}

function verifiedClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

export function createAccessCodeRedeemerHandler(deps: AccessCodeRedeemerHandlerDeps) {
  return async (event: AccessCodeRedeemerEvent): Promise<HttpResponse> => {
    try {
      if (
        event.requestContext?.http?.method !== 'POST' ||
        event.rawPath !== '/v1/access-codes/redeem'
      ) {
        throw new ApiError('VALIDATION');
      }
      const claims = event.requestContext.authorizer?.jwt?.claims;
      const ownerSub = claims?.['sub'];
      const requestId = event.requestContext.requestId;
      if (
        typeof ownerSub !== 'string' ||
        !ownerSub ||
        ownerSub !== ownerSub.trim() ||
        typeof requestId !== 'string' ||
        !REQUEST_ID_PATTERN.test(requestId)
      ) {
        throw new ApiError('UNAUTHENTICATED');
      }
      const body = parseBody(event);
      const access = await deps.redeem({
        ownerSub,
        emailVerified: verifiedClaim(claims?.['email_verified']),
        code: body.code,
        requestId,
      });
      const usage = await deps.readUsage(ownerSub);
      return {
        statusCode: 200,
        headers: { ...NO_STORE_HEADERS },
        body: JSON.stringify(accessSummary(access, usage)),
      };
    } catch (error) {
      return noStore(errorResponse(error));
    }
  };
}

let productionHandler: ((event: AccessCodeRedeemerEvent) => Promise<HttpResponse>) | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function production(): (event: AccessCodeRedeemerEvent) => Promise<HttpResponse> {
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
  const redeemer = createDynamoAccessCodeRedeemer(options);
  productionHandler = createAccessCodeRedeemerHandler({
    redeem: (input) => redeemer.redeem(input),
    readUsage: (ownerSub) => readAccessCodeUsage(options, ownerSub),
  });
  return productionHandler;
}

export const handler = instrumentHandler(
  'access-code-redeemer',
  (event: AccessCodeRedeemerEvent): Promise<HttpResponse> => production()(event),
);
