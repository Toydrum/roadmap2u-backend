import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createCommercialConfigBroker,
  type CommercialConfigBrokerEvent,
  type CommercialConfigCommand,
} from './commercial-config-broker';
import { AuditWriter } from './commercial/audit';
import {
  emitCommercialBrokerAvailabilityMetric,
  instrumentHandler,
  type CommercialMetricStage,
} from './observability';

interface BrokerAllowlistEntry {
  readonly accountId: string;
  readonly roleName: string;
  readonly stage: string;
  readonly commands: readonly CommercialConfigCommand[];
}

const ACCOUNT_PATTERN = /^[0-9]{12}$/;
const ROLE_PATTERN = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const STAGE_PATTERN = /^(?:dev|test|prod)$/;
const COMMANDS = new Set<CommercialConfigCommand>([
  'bootstrap-flags',
  'set-flags',
  'freeze-cutover',
]);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required ${name}`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAllowlist(raw: string, stage: string): readonly BrokerAllowlistEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('COMMERCIAL_CONFIG_ALLOWLIST must be valid JSON');
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('COMMERCIAL_CONFIG_ALLOWLIST must contain exactly two roles');
  }
  const entries = value.map((entry): BrokerAllowlistEntry => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'accountId,commands,roleName,stage') {
      throw new Error('COMMERCIAL_CONFIG_ALLOWLIST contains an invalid entry');
    }
    const { accountId, roleName, commands } = entry;
    if (
      typeof accountId !== 'string' ||
      !ACCOUNT_PATTERN.test(accountId) ||
      typeof roleName !== 'string' ||
      !ROLE_PATTERN.test(roleName) ||
      entry.stage !== stage ||
      !Array.isArray(commands) ||
      commands.length === 0 ||
      !commands.every((command) => typeof command === 'string' && COMMANDS.has(command as CommercialConfigCommand))
    ) {
      throw new Error('COMMERCIAL_CONFIG_ALLOWLIST contains an invalid entry');
    }
    return {
      accountId,
      roleName,
      stage,
      commands: commands as CommercialConfigCommand[],
    };
  });
  const commandSets = entries.map((entry) => [...entry.commands].sort().join(','));
  if (!commandSets.includes('bootstrap-flags,freeze-cutover') || !commandSets.includes('set-flags')) {
    throw new Error('COMMERCIAL_CONFIG_ALLOWLIST has invalid command partitions');
  }
  return entries;
}

const stage = requiredEnvironment('COMMERCIAL_STAGE');
if (!STAGE_PATTERN.test(stage)) throw new Error('COMMERCIAL_STAGE must be dev, test, or prod');
const tableName = requiredEnvironment('TABLE_NAME');
const auditTableName = requiredEnvironment('AUDIT_TABLE_NAME');
const allowlist = parseAllowlist(requiredEnvironment('COMMERCIAL_CONFIG_ALLOWLIST'), stage);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const auditWriter = new AuditWriter({ ddb, tableName: auditTableName });

const broker = createCommercialConfigBroker({
  ddb,
  tableName,
  auditWriter,
  now: Date.now,
  allowlist,
});

export const handler = instrumentHandler(
  'commercial-config-broker',
  async (event: CommercialConfigBrokerEvent, _context?: object) => {
    const response = await broker(event);
    emitCommercialBrokerAvailabilityMetric(response.statusCode, stage as CommercialMetricStage);
    return response;
  },
);
