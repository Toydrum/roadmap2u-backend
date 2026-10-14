import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoAccessResolver } from '../access-reader';
import { COMMERCIAL_FLAGS_ATTRIBUTES, CommercialFlagsResolver, individualPurchasesEnabled } from '../commercial/flags';
import { loadPrivateConfig, purchasesConfigReady } from './config';
import { DynamoBillingRepository } from './dynamo';
import { StripeBillingProvider } from './stripe-provider';
import { BillingService } from './service';
import { BillingProjector } from './projection';
import { billingMetric } from './metrics';

export function environment(name: string): string { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; }
export function billingDynamoClient() { return DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }); }
let loaded: { expiresAt: number; config: Awaited<ReturnType<typeof loadPrivateConfig>> } | undefined;
export async function createBillingRuntime(authenticatedOwner?: { ownerSub: string; emailVerified: boolean }) {
  const now = Date.now;
  if (!loaded || loaded.expiresAt <= now()) {
    try { loaded = { config: await loadPrivateConfig(environment('STRIPE_CONFIG_PARAMETER')), expiresAt: now() + 60_000 }; }
    catch { billingMetric('ConfigurationError'); throw new Error('billing configuration unavailable'); }
  }
  const config = loaded.config;
  if (config.stage !== environment('STAGE')) { billingMetric('ConfigurationError'); throw new Error('billing stage mismatch'); }
  const ddb = billingDynamoClient(), table = environment('TABLE_NAME');
  const repository = new DynamoBillingRepository({ ddb, table, accountId: config.accountId, stage: config.stage, liveMode: config.liveMode, privacyTable: process.env['PRIVACY_TABLE_NAME'], authenticatedOwner });
  const provider = StripeBillingProvider.create(config, config.apiKey, { repository, now, requireLease: true });
  const flagAliases = Object.fromEntries(COMMERCIAL_FLAGS_ATTRIBUTES.map((attribute, i) => [`#flag${i}`, attribute]));
  const flags = new CommercialFlagsResolver({ now, readItem: async () => (await ddb.send(new GetCommand({ TableName: table, Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' }, ConsistentRead: true, ProjectionExpression: Object.keys(flagAliases).join(', '), ExpressionAttributeNames: flagAliases }))).Item, emitMetric: () => billingMetric('ConfigurationError') });
  const service = new BillingService({ repository, provider, config, now, purchasesEnabled: async () => purchasesConfigReady(config) && individualPurchasesEnabled(await flags.resolve()) });
  const resolver = createDynamoAccessResolver({ ddb, tableName: table, now, stage:config.stage });
  const projector = new BillingProjector({ repository, provider, config, now, nextWorkerId: randomUUID, refreshAccess: async (id) => { await resolver.resolveFresh(id); } });
  return { repository, provider, config, service, projector, now, metric: billingMetric };
}
