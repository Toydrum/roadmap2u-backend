import { PREPAYMENT_CATALOG } from './commercial/catalog';
import type { HttpResponse } from './http';
import { instrumentHandler } from './observability';

const PUBLIC_CATALOG_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300',
});

/** Public compiled-data boundary. The request is intentionally never inspected. */
export function createCatalogHandler(): (_event?: unknown) => Promise<HttpResponse> {
  return async () => ({
    statusCode: 200,
    headers: { ...PUBLIC_CATALOG_HEADERS },
    body: JSON.stringify(PREPAYMENT_CATALOG),
  });
}

const catalogHandler = createCatalogHandler();

export const handler = instrumentHandler(
  'catalog',
  (event: unknown, _context?: unknown) => catalogHandler(event),
);
