import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuditWriter } from './commercial/audit';
import { createFamilyPilotBroker } from './family-pilot-broker';
import { instrumentHandler } from './observability';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const stage = required('COMMERCIAL_STAGE');
if (stage !== 'dev' && stage !== 'test' && stage !== 'prod') {
  throw new Error('COMMERCIAL_STAGE must be dev, test, or prod');
}
const accountId = required('PILOT_ACCOUNT_ID');
if (!/^[0-9]{12}$/.test(accountId)) throw new Error('PILOT_ACCOUNT_ID is invalid');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const broker = createFamilyPilotBroker({
  ddb, tableName: required('TABLE_NAME'),
  auditWriter: new AuditWriter({ ddb, tableName: required('AUDIT_TABLE_NAME') }),
  stage, accountId, now: Date.now,
});

export const handler = instrumentHandler('family-pilot-broker', broker);
