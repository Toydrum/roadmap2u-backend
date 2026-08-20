import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { AuditWriter } from './commercial/audit';
import type { CommercialMode } from './commercial/flags';

export type CommercialConfigCommand =
  | 'bootstrap-flags'
  | 'set-flags'
  | 'freeze-cutover';

export interface CommercialConfigBrokerEvent {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly http?: { readonly method?: string };
    readonly authorizer?: { readonly iam?: { readonly userArn?: string } };
  };
}

export interface CommercialConfigBrokerResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CommercialConfigBrokerDeps {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly auditWriter: AuditWriter;
  readonly now: () => number;
  readonly allowlist: ReadonlyArray<{
    readonly accountId: string;
    readonly roleName: string;
    readonly stage: string;
    readonly commands: readonly CommercialConfigCommand[];
  }>;
}

interface BootstrapFlagsRequest {
  readonly command: 'bootstrap-flags';
  readonly stage: string;
  readonly reason: string;
}

type MutableFlagName =
  | 'quotaMode'
  | 'capabilityMode'
  | 'accessCodeIssuanceEnabled'
  | 'accessCodeRedemptionEnabled';

type MutableFlagChanges = Readonly<
  Partial<{
    quotaMode: CommercialMode;
    capabilityMode: CommercialMode;
    accessCodeIssuanceEnabled: boolean;
    accessCodeRedemptionEnabled: boolean;
  }>
>;

interface SetFlagsRequest {
  readonly command: 'set-flags';
  readonly stage: string;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly changes: MutableFlagChanges;
}

interface FreezeCutoverRequest {
  readonly command: 'freeze-cutover';
  readonly stage: string;
  readonly commercialEntitlementsCutoverAt: string;
  readonly inventoryManifestHash: string;
  readonly reason: string;
}

type BrokerRequest = BootstrapFlagsRequest | SetFlagsRequest | FreezeCutoverRequest;

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const CONFIG_KEY = Object.freeze({ pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' });
const CUTOVER_KEY = Object.freeze({ pk: 'COMMERCIAL#CONFIG', sk: 'CUTOVER' });
const ABSENT_KEY_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
const MODES = new Set<CommercialMode>(['off', 'observe', 'enforce']);
const MUTABLE_FLAG_NAMES = Object.freeze<readonly MutableFlagName[]>([
  'quotaMode',
  'capabilityMode',
  'accessCodeIssuanceEnabled',
  'accessCodeRedemptionEnabled',
]);
const MUTABLE_FLAG_NAME_SET = new Set<string>(MUTABLE_FLAG_NAMES);
const MAX_REASON_BYTES = 256;
const MAX_BODY_BYTES = 4096;
const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSUMED_ROLE_ARN_PATTERN =
  /^arn:aws:sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/([A-Za-z0-9_+=,.@-]{2,64})$/;

function respond(statusCode: number, payload: Readonly<Record<string, unknown>>): CommercialConfigBrokerResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const expectedKeys = new Set(expected);
  return keys.length === expectedKeys.size && keys.every((key) => expectedKeys.has(key));
}

function isBoundedReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= MAX_REASON_BYTES
  );
}

function isStage(value: unknown): value is string {
  return typeof value === 'string' && STAGE_PATTERN.test(value);
}

function isExpectedRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value < Number.MAX_SAFE_INTEGER
  );
}

function isMode(value: unknown): value is CommercialMode {
  return typeof value === 'string' && MODES.has(value as CommercialMode);
}

function isCanonicalUtcIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseChanges(value: unknown): MutableFlagChanges | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => MUTABLE_FLAG_NAME_SET.has(key))) return null;

  for (const key of keys) {
    const flagValue = value[key];
    if (key === 'quotaMode' || key === 'capabilityMode') {
      if (!isMode(flagValue)) return null;
    } else if (typeof flagValue !== 'boolean') {
      return null;
    }
  }
  return value as MutableFlagChanges;
}

function parseBody(event: CommercialConfigBrokerEvent): BrokerRequest | null {
  if (event.isBase64Encoded || typeof event.body !== 'string') return null;
  if (Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(event.body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  if (value['command'] === 'bootstrap-flags') {
    if (!hasExactKeys(value, ['command', 'stage', 'reason'])) return null;
    if (!isStage(value['stage']) || !isBoundedReason(value['reason'])) return null;
    return value as unknown as BootstrapFlagsRequest;
  }

  if (value['command'] === 'set-flags') {
    if (
      !hasExactKeys(value, [
        'command',
        'stage',
        'expectedRevision',
        'reason',
        'changes',
      ])
    ) {
      return null;
    }
    const changes = parseChanges(value['changes']);
    if (
      !isStage(value['stage']) ||
      !isExpectedRevision(value['expectedRevision']) ||
      !isBoundedReason(value['reason']) ||
      !changes
    ) {
      return null;
    }
    return { ...value, changes } as unknown as SetFlagsRequest;
  }

  if (value['command'] === 'freeze-cutover') {
    if (
      !hasExactKeys(value, [
        'command',
        'stage',
        'commercialEntitlementsCutoverAt',
        'inventoryManifestHash',
        'reason',
      ])
    ) {
      return null;
    }
    if (
      !isStage(value['stage']) ||
      !isCanonicalUtcIso(value['commercialEntitlementsCutoverAt']) ||
      typeof value['inventoryManifestHash'] !== 'string' ||
      !SHA256_PATTERN.test(value['inventoryManifestHash']) ||
      !isBoundedReason(value['reason'])
    ) {
      return null;
    }
    return value as unknown as FreezeCutoverRequest;
  }

  return null;
}

function isAllowed(
  deps: CommercialConfigBrokerDeps,
  actorArn: string,
  request: BrokerRequest,
): boolean {
  const principal = ASSUMED_ROLE_ARN_PATTERN.exec(actorArn);
  if (!principal) return false;
  const [, accountId, roleName] = principal;
  return deps.allowlist.some(
    (entry) =>
      entry.accountId === accountId &&
      entry.roleName === roleName &&
      entry.stage === request.stage &&
      entry.commands.includes(request.command),
  );
}

function isConditionalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException') return true;
  if (error.name !== 'TransactionCanceledException') return false;

  const reasons = (error as Error & { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  const codes = reasons.map((reason) =>
    isRecord(reason) && typeof reason['Code'] === 'string' ? reason['Code'] : '',
  );
  const conflictCodes = new Set(['ConditionalCheckFailed', 'TransactionConflict']);
  return (
    codes.some((code) => conflictCodes.has(code)) &&
    codes.every((code) => code === 'None' || conflictCodes.has(code))
  );
}

async function bootstrapFlags(
  deps: CommercialConfigBrokerDeps,
  request: BootstrapFlagsRequest,
  actorArn: string,
): Promise<CommercialConfigBrokerResponse> {
  const now = deps.now();
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...CONFIG_KEY,
                revision: 1,
                quotaMode: 'off',
                capabilityMode: 'off',
                accessCodeIssuanceEnabled: false,
                accessCodeRedemptionEnabled: false,
                premiumPaymentsEnabled: false,
                updatedAt: now,
                updatedBy: actorArn,
                reason: request.reason,
              },
              ConditionExpression: ABSENT_KEY_CONDITION,
            },
          },
          deps.auditWriter.transactPut({
            action: 'commercial_config.flags_bootstrapped',
            actor: actorArn,
            subject: 'COMMERCIAL#CONFIG/FLAGS',
            details: { stage: request.stage, revision: 1 },
          }),
        ],
      }),
    );
    return respond(201, { command: request.command, revision: 1 });
  } catch (error) {
    return isConditionalConflict(error)
      ? respond(409, { error: 'CONFIGURATION_CONFLICT' })
      : respond(503, { error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
  }
}

async function setFlags(
  deps: CommercialConfigBrokerDeps,
  request: SetFlagsRequest,
  actorArn: string,
): Promise<CommercialConfigBrokerResponse> {
  const now = deps.now();
  const nextRevision = request.expectedRevision + 1;
  const changedFields = MUTABLE_FLAG_NAMES.filter((field) =>
    Object.hasOwn(request.changes, field),
  );
  const expressionParts = [
    '#revision = :nextRevision',
    '#updatedAt = :updatedAt',
    '#updatedBy = :updatedBy',
    '#reason = :reason',
    ...changedFields.map((field) => `#${field} = :${field}`),
  ];
  const names: Record<string, string> = {
    '#revision': 'revision',
    '#updatedAt': 'updatedAt',
    '#updatedBy': 'updatedBy',
    '#reason': 'reason',
    '#premiumPaymentsEnabled': 'premiumPaymentsEnabled',
  };
  const values: Record<string, unknown> = {
    ':expectedRevision': request.expectedRevision,
    ':nextRevision': nextRevision,
    ':paymentsDisabled': false,
    ':updatedAt': now,
    ':updatedBy': actorArn,
    ':reason': request.reason,
  };
  for (const field of changedFields) {
    names[`#${field}`] = field;
    values[`:${field}`] = request.changes[field];
  }

  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName,
              Key: CONFIG_KEY,
              UpdateExpression: `SET ${expressionParts.join(', ')}`,
              ConditionExpression:
                'attribute_exists(pk) AND attribute_exists(sk) AND #revision = :expectedRevision AND #premiumPaymentsEnabled = :paymentsDisabled',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          deps.auditWriter.transactPut({
            action: 'commercial_config.flags_changed',
            actor: actorArn,
            subject: 'COMMERCIAL#CONFIG/FLAGS',
            details: {
              stage: request.stage,
              expectedRevision: request.expectedRevision,
              revision: nextRevision,
              changedFields: [...changedFields].sort(),
            },
          }),
        ],
      }),
    );
    return respond(200, { command: request.command, revision: nextRevision });
  } catch (error) {
    return isConditionalConflict(error)
      ? respond(409, { error: 'CONFIGURATION_CONFLICT' })
      : respond(503, { error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
  }
}

function sameCutover(item: unknown, request: FreezeCutoverRequest): boolean {
  return (
    isRecord(item) &&
    item['pk'] === CUTOVER_KEY.pk &&
    item['sk'] === CUTOVER_KEY.sk &&
    item['commercialEntitlementsCutoverAt'] === request.commercialEntitlementsCutoverAt &&
    item['inventoryManifestHash'] === request.inventoryManifestHash &&
    item['reason'] === request.reason
  );
}

function freezeResponse(
  request: FreezeCutoverRequest,
  statusCode: 200 | 201,
  idempotent: boolean,
): CommercialConfigBrokerResponse {
  return respond(statusCode, {
    command: request.command,
    commercialEntitlementsCutoverAt: request.commercialEntitlementsCutoverAt,
    inventoryManifestHash: request.inventoryManifestHash,
    idempotent,
  });
}

async function freezeCutover(
  deps: CommercialConfigBrokerDeps,
  request: FreezeCutoverRequest,
  actorArn: string,
): Promise<CommercialConfigBrokerResponse> {
  const now = deps.now();
  try {
    await deps.ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...CUTOVER_KEY,
                commercialEntitlementsCutoverAt: request.commercialEntitlementsCutoverAt,
                inventoryManifestHash: request.inventoryManifestHash,
                frozenAt: now,
                frozenBy: actorArn,
                reason: request.reason,
              },
              ConditionExpression: ABSENT_KEY_CONDITION,
            },
          },
          deps.auditWriter.transactPut({
            action: 'commercial_config.cutover_frozen',
            actor: actorArn,
            subject: 'COMMERCIAL#CONFIG/CUTOVER',
            details: {
              stage: request.stage,
              commercialEntitlementsCutoverAt: request.commercialEntitlementsCutoverAt,
              inventoryManifestHash: request.inventoryManifestHash,
            },
          }),
        ],
      }),
    );
    return freezeResponse(request, 201, false);
  } catch (error) {
    if (!isConditionalConflict(error)) {
      return respond(503, { error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
    }
  }

  try {
    const existing = await deps.ddb.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: CUTOVER_KEY,
        ConsistentRead: true,
      }),
    );
    return sameCutover(existing.Item, request)
      ? freezeResponse(request, 200, true)
      : respond(409, { error: 'CONFIGURATION_CONFLICT' });
  } catch {
    return respond(503, { error: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE' });
  }
}

export function createCommercialConfigBroker(deps: CommercialConfigBrokerDeps) {
  return async (event: CommercialConfigBrokerEvent): Promise<CommercialConfigBrokerResponse> => {
    const actorArn = event.requestContext?.authorizer?.iam?.userArn;
    if (typeof actorArn !== 'string' || actorArn.length === 0) {
      return respond(401, { error: 'UNAUTHENTICATED' });
    }
    if (event.requestContext?.http?.method !== 'POST') {
      return respond(400, { error: 'INVALID_REQUEST' });
    }

    const request = parseBody(event);
    if (!request) return respond(400, { error: 'INVALID_REQUEST' });
    if (!isAllowed(deps, actorArn, request)) return respond(403, { error: 'FORBIDDEN' });

    if (request.command === 'bootstrap-flags') {
      return bootstrapFlags(deps, request, actorArn);
    }
    if (request.command === 'set-flags') return setFlags(deps, request, actorArn);
    return freezeCutover(deps, request, actorArn);
  };
}
