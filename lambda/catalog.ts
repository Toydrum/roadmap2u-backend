import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { FREE_LIMITS } from '@app/api/contracts';
import { LEGACY_PREPAYMENT_CATALOG, PREPAYMENT_CATALOG } from './commercial/catalog';
import {
  COMMERCIAL_FLAGS_ATTRIBUTES,
  CommercialFlagsResolver,
  type CommercialConfigResult,
  type CommercialMetricName,
} from './commercial/flags';
import type { HttpResponse } from './http';
import { instrumentHandler } from './observability';

interface CatalogDeps {
  readonly resolveFlags: () => Promise<CommercialConfigResult>;
}

/** The public request cannot select a catalog, data key, price or policy. */
export function createCatalogHandler(
  deps: CatalogDeps,
): (_event?: unknown) => Promise<HttpResponse> {
  return async (event) => {
    const policyV2 = (event as { queryStringParameters?: Record<string, string> } | undefined)
      ?.queryStringParameters?.['policy'] === '2';
    const config = await deps.resolveFlags();
    const current = config.status === 'available' && config.freshness !== 'stale';
    const family = current && config.flags.familyCatalogEnabled;
    const catalog = family ? PREPAYMENT_CATALOG : LEGACY_PREPAYMENT_CATALOG;
    const useTightenedQuota = policyV2 && config.status === 'available' && config.flags.freeQuotaV2Enabled === true;
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': current && !policyV2 ? 'public, max-age=30' : 'no-store',
      },
      body: JSON.stringify(useTightenedQuota ? {
        ...catalog,
        plans: { ...catalog.plans, free: { ...catalog.plans.free, limits: FREE_LIMITS } },
      } : catalog),
    };
  };
}

/** Only the fixed FLAGS item and its validated projection are read. */
export function createDynamoCatalogHandler(options: {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => number;
  readonly emitMetric?: (metric: CommercialMetricName) => void;
}): (_event?: unknown) => Promise<HttpResponse> {
  const names = Object.fromEntries(
    COMMERCIAL_FLAGS_ATTRIBUTES.map((field, index) => [`#p${index}`, field]),
  );
  const resolver = new CommercialFlagsResolver({
    now: options.now,
    emitMetric: options.emitMetric ?? (() => undefined),
    readItem: async () =>
      (
        await options.ddb.send(
          new GetCommand({
            TableName: options.tableName,
            Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' },
            ConsistentRead: true,
            ProjectionExpression: Object.keys(names).join(', '),
            ExpressionAttributeNames: names,
          }),
        )
      ).Item,
  });
  return createCatalogHandler({ resolveFlags: () => resolver.resolve() });
}

let catalogHandler: ReturnType<typeof createCatalogHandler> | undefined;
function productionCatalog(): ReturnType<typeof createCatalogHandler> {
  if (catalogHandler) return catalogHandler;
  const tableName = process.env['TABLE_NAME'];
  if (!tableName) throw new Error('TABLE_NAME is required');
  catalogHandler = createDynamoCatalogHandler({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName,
    now: Date.now,
    emitMetric: (metric) => console.info(JSON.stringify({ service: 'catalog', metric })),
  });
  return catalogHandler;
}

export const handler = instrumentHandler('catalog', (event: unknown, _context?: unknown) =>
  productionCatalog()(event),
);
