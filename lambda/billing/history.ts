import { BillingError, BillingHistoryPending, digest, type BillingConfig, type BillingRepository, type ProviderInvoice, type ProviderSubscription } from './model';

export interface StripeHistoryOptions {
  repository: Pick<BillingRepository, 'readCursor' | 'saveCursor' | 'saveHistoryCursor'>;
  now?: () => number;
  budgetMs?: number;
  requireLease?: boolean;
}
interface Cursor { phase: 'subscriptions' | 'invoices' | 'complete'; startedAt: number; completedAt?: number; after?: string; subscriptionPages: number; invoicePages: number }
interface Page<T> { data: T[]; has_more: boolean }
interface Loader {
  subscriptions(after?: string): Promise<Page<ProviderSubscription>>;
  invoices(subscriptions: ProviderSubscription[], after?: string): Promise<Page<ProviderInvoice>>;
}
/** Only normalized financial facts are cached. Partial pages never form a snapshot.
 * Callers hold the owner's financial lease; the cursor is saved after its page. */
export async function collectStripeHistory(config: BillingConfig, customerId: string, options: StripeHistoryOptions, loader: Loader) {
  const { repository: r } = options, now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 25_000);
  const prefix = `history:${digest([config.accountId, config.stage, config.liveMode, customerId])}`;
  let cursor = await r.readCursor(prefix) as unknown as Cursor | undefined;
  if (!cursor || (cursor.phase === 'complete' && (cursor.completedAt ?? 0) + 900_000 <= now())) cursor = { phase: 'subscriptions', startedAt: now(), subscriptionPages: 0, invoicePages: 0 };
  const loaded = new Map<string, { id: string }[][]>();
  const readPages = async <T extends { id: string }>(kind: 'subscriptions' | 'invoices', count: number): Promise<T[]> => {
    const cached = loaded.get(kind);
    if (cached?.length === count) return cached.flat() as T[];
    const all: T[] = [];
    const chunks: T[][] = [];
    for (let from = 0; from < count; from += 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, count - from) }, (_, offset) => r.readCursor(`${prefix}:${kind}:${from + offset}`)));
      for (const page of batch) {
        if (!Array.isArray(page?.['items'])) throw new BillingError('BILLING_PAYMENT_REVIEW');
        chunks.push(page['items'] as T[]); all.push(...page['items'] as T[]);
      }
    }
    loaded.set(kind, chunks);
    return all;
  };
  while (cursor.phase !== 'complete') {
    if (now() >= deadline) throw new BillingHistoryPending();
    const subscriptions = cursor.phase === 'invoices' ? await readPages<ProviderSubscription>('subscriptions', cursor.subscriptionPages) : [];
    const page: Page<ProviderSubscription | ProviderInvoice> = cursor.phase === 'subscriptions' ? await loader.subscriptions(cursor.after) : await loader.invoices(subscriptions, cursor.after);
    if (page.has_more && (!page.data.length || page.data.at(-1)?.id === cursor.after)) throw new BillingError('BILLING_PAYMENT_REVIEW');
    const kind: 'subscriptions' | 'invoices' = cursor.phase;
    const index: number = kind === 'subscriptions' ? cursor.subscriptionPages : cursor.invoicePages;
    await r.saveCursor(`${prefix}:${kind}:${index}`, { items: page.data });
    cursor = { ...cursor, ...(kind === 'subscriptions' ? { subscriptionPages: index + 1 } : { invoicePages: index + 1 }), after: page.has_more ? page.data.at(-1)?.id : undefined };
    if (!page.has_more) cursor = kind === 'subscriptions' ? { ...cursor, phase: 'invoices' } : { ...cursor, phase: 'complete', completedAt: now() };
    await r.saveCursor(prefix, { ...cursor });
  }
  const subscriptions = await readPages<ProviderSubscription>('subscriptions', cursor.subscriptionPages), invoices = await readPages<ProviderInvoice>('invoices', cursor.invoicePages);
  const update = async (kind: 'subscriptions' | 'invoices', values: (ProviderSubscription | ProviderInvoice)[]) => {
    const byId = new Map(values.map((v) => [v.id, v]));
    for (const [index, chunk] of (loaded.get(kind) ?? []).entries()) {
      const updated = chunk.map((v) => byId.get(v.id) ?? v);
      if (digest(chunk) !== digest(updated)) await r.saveCursor(`${prefix}:${kind}:${index}`, { items: updated });
    }
  };
  return { subscriptions, invoices, startedAt: cursor.startedAt, update };
}
