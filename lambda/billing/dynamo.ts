import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Deps, ProfileItem } from '../db';
import { isDeclared, readPrivacyItem } from '../privacy/consent';
import { readRestoreExclusion } from '../privacy/retention';
import { initialState, type BillingActor, type BillingCommit, type BillingCommand, type BillingRepository, type BillingState, type InvoiceReceipt, type StripeEventEnvelope } from './model';

interface Options {
  ddb: DynamoDBDocumentClient; table: string; accountId: string; stage: string; liveMode: boolean;
  privacyTable?: string; authenticatedOwner?: { ownerSub: string; emailVerified: boolean };
}
type Tx = NonNullable<TransactWriteCommandInput['TransactItems']>;
const financial = { retentionScope: 'commercial', retentionPolicyVersion: 'financial-v1-draft', retentionStatus: 'pending_policy_approval' };
const dueSort = (now: number, id: string) => `NEXT#${String(now).padStart(14, '0')}#${id}`;
const conditional = (error: unknown) => (error as { name?: string })?.name === 'ConditionalCheckFailedException';
function transactionConflict(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return e?.name === 'TransactionCanceledException' && !!e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict');
}
/** Financial partitions deliberately survive USER partition erasure and have no forest TTL. */
export class DynamoBillingRepository implements BillingRepository {
  constructor(readonly options: Options) {}
  private stateKey(id: string) { return { pk: `BILLING#${id}`, sk: 'STATE' }; }
  private commandKey(id: string, commandId: string) { return { pk: `BILLING#${id}`, sk: `COMMAND#${commandId}` }; }
  private eventKey(id: string) { return { pk: `STRIPE_EVENT#${this.options.accountId}#${this.options.stage}#${id}`, sk: 'EVENT' }; }
  private mappingKey(kind: string, id: string) { return { pk: `STRIPE#${this.options.accountId}#${this.options.stage}#${this.options.liveMode ? 'live' : 'test'}#${kind.toUpperCase()}#${id}`, sk: 'OWNER' }; }
  private async strong<T>(Key: Record<string, unknown>): Promise<T | null> {
    const result = await this.options.ddb.send(new GetCommand({ TableName: this.options.table, Key, ConsistentRead: true }));
    return result.Item as T ?? null;
  }
  async actor(ownerSub: string): Promise<BillingActor | null> {
    const deps = { ddb: this.options.ddb, table: this.options.table, privacyTable: this.options.privacyTable } as Deps;
    const [p, closure, exclusion] = await Promise.all([
      this.strong<ProfileItem>({ pk: `USER#${ownerSub}`, sk: 'PROFILE' }),
      this.strong({ pk: `ACCOUNT_CLOSURE#${ownerSub}`, sk: 'STATE' }),
      readRestoreExclusion(deps, ownerSub),
    ]);
    if (!p || p.userId !== ownerSub || exclusion?.scope === 'account') return null;
    const privacy = await readPrivacyItem(deps, ownerSub);
    return { ownerSub, accountType: p.accountType, status: p.status ?? 'active', emailVerified: this.options.authenticatedOwner?.ownerSub === ownerSub && this.options.authenticatedOwner.emailVerified, adultDeclarationCurrent: isDeclared(privacy), ...(p.privacyMode ? { privacyMode: p.privacyMode } : {}), ...(p.email ? { email: p.email } : {}), ...(privacy ? { privacyRevision: privacy.revision, declarationHash: privacy.declarationDocumentHash } : {}), closing: !!closure };
  }
  async load(id: string): Promise<BillingState> { return { ...initialState(id), ...await this.strong<BillingState>(this.stateKey(id)) }; }
  async command(id: string, commandId: string) { return this.strong<BillingCommand>(this.commandKey(id, commandId)); }
  async projectionRevision(id: string): Promise<number> {
    const source = await this.strong<{ revision?: unknown }>({ pk: `USER#${id}`, sk: 'SUBSCRIPTION#INDIVIDUAL' });
    return Number.isSafeInteger(source?.revision) && (source!.revision as number) >= 0 ? source!.revision as number : 0;
  }
  async receipts(id: string): Promise<InvoiceReceipt[]> {
    const items: InvoiceReceipt[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.options.ddb.send(new QueryCommand({ TableName: this.options.table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `BILLING#${id}`, ':prefix': 'INVOICE#' }, ConsistentRead: true, Limit: 100, ExclusiveStartKey: cursor }));
      items.push(...page.Items as InvoiceReceipt[] ?? []); cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async mappedOwner(kind: 'customer' | 'subscription' | 'checkout', id: string): Promise<string | null> { return (await this.strong<{ ownerSub: string }>(this.mappingKey(kind, id)))?.ownerSub ?? null; }
  async commit(c: BillingCommit): Promise<boolean> {
    const { table, ddb } = this.options, id = c.state.ownerSub;
    let condition = c.expectedRevision === 0 ? 'attribute_not_exists(pk)' : 'revision = :expectedRevision';
    const values: Record<string, unknown> = c.expectedRevision === 0 ? {} : { ':expectedRevision': c.expectedRevision };
    if (c.lease) {
      condition += ' AND leaseOwner = :leaseOwner AND leaseRevision = :leaseRevision AND leaseUntil > :leaseNow';
      Object.assign(values, { ':leaseOwner': c.lease.owner, ':leaseRevision': c.lease.revision, ':leaseNow': c.lease.now });
    } else {
      condition += ' AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :writeNow)';
      values[':writeNow'] = c.state.updatedAt;
    }
    // A lease can initialize an absent account state at revision zero.
    if (c.expectedRevision === 0 && c.lease) condition = condition.replace('attribute_not_exists(pk)', 'revision = :expectedRevision'), values[':expectedRevision'] = 0;
    const stateItem = { ...c.state, ...this.stateKey(id), ...financial, ...(c.state.state !== 'closed' ? { gsi1pk: `BILLING#OWNERS#${this.options.stage}`, gsi1sk: dueSort(c.state.nextReconcileAt, id) } : {}) };
    const tx: Tx = [{ Put: { TableName: table, Item: stateItem, ConditionExpression: condition, ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) } }];
    if (c.guard === 'adult' || c.guard === 'open' || c.source) {
      tx.push({ ConditionCheck: { TableName: table, Key: { pk: `USER#${id}`, sk: 'PROFILE' }, ConditionExpression: `attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)${c.guard === 'adult' ? ' AND accountType = :adult AND attribute_not_exists(privacyMode)' : ''}`, ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':active': 'active', ...(c.guard === 'adult' ? { ':adult': 'adult' } : {}) } } });
      tx.push({ ConditionCheck: { TableName: table, Key: { pk: `ACCOUNT_CLOSURE#${id}`, sk: 'STATE' }, ConditionExpression: 'attribute_not_exists(pk)' } });
    }
    if (c.guard === 'adult' && c.actor?.privacyRevision !== undefined) tx.push({ ConditionCheck: { TableName: table, Key: { pk: `USER#${id}`, sk: 'PRIVACY#ADULT' }, ConditionExpression: 'revision = :privacyRevision AND declarationDocumentHash = :declarationHash AND attribute_exists(adultDeclaredAt)', ExpressionAttributeValues: { ':privacyRevision': c.actor.privacyRevision, ':declarationHash': c.actor.declarationHash } } });
    if (c.guard === 'closure') {
      if (!c.state.closingId) throw new Error('financial closure identity required');
      tx.push({ ConditionCheck: { TableName: table, Key: { pk: `ACCOUNT_CLOSURE#${id}`, sk: 'STATE' }, ConditionExpression: 'closureId = :closureId', ExpressionAttributeValues: { ':closureId': c.state.closingId } } });
    }
    if (c.command) tx.push({ Put: { TableName: table, Item: { ...c.command, ...this.commandKey(id, c.command.commandId), ...financial }, ...(c.commandAbsent ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}) } });
    for (const mapping of c.mappings ?? []) tx.push({ Put: { TableName: table, Item: { ...this.mappingKey(mapping.kind, mapping.id), ...financial, ownerSub: id, accountId: this.options.accountId, stage: this.options.stage, liveMode: this.options.liveMode }, ConditionExpression: 'attribute_not_exists(ownerSub) OR ownerSub = :owner', ExpressionAttributeValues: { ':owner': id } } });
    for (const invoice of c.invoices ?? []) tx.push({ Put: { TableName: table, Item: { ...invoice, pk: `BILLING#${id}`, sk: `INVOICE#${invoice.invoiceId}`, ...financial } } });
    if (c.source) tx.push({ Put: { TableName: table, Item: c.source, ConditionExpression: 'attribute_not_exists(revision) OR revision < :nextRevision', ExpressionAttributeValues: { ':nextRevision': c.source.revision } } });
    // Commercial audit shares the financial transaction and never inherits forest retention.
    tx.push({ Put: { TableName: table, Item: { pk: `BILLING#${id}`, sk: `AUDIT#${String(c.state.updatedAt).padStart(14, '0')}#${c.state.revision}`, ...financial, action: c.auditAction, revision: c.state.revision, occurredAt: c.state.updatedAt }, ConditionExpression: 'attribute_not_exists(pk)' } });
    if (tx.length > 100) throw new Error('billing transaction exceeds bounded financial history');
    try { await ddb.send(new TransactWriteCommand({ TransactItems: tx })); return true; } catch (error) { if (transactionConflict(error)) return false; throw error; }
  }
  async acquireLease(id: string, owner: string, now: number, duration: number) {
    try {
      const result = await this.options.ddb.send(new UpdateCommand({ TableName: this.options.table, Key: this.stateKey(id), UpdateExpression: 'SET ownerSub = if_not_exists(ownerSub, :id), revision = if_not_exists(revision, :zero), leaseOwner = :owner, leaseUntil = :until, leaseRevision = if_not_exists(leaseRevision, :zero) + :one', ConditionExpression: 'attribute_not_exists(leaseUntil) OR leaseUntil <= :now OR leaseOwner = :owner', ExpressionAttributeValues: { ':id': id, ':zero': 0, ':owner': owner, ':until': now + duration, ':now': now, ':one': 1 }, ReturnValues: 'ALL_NEW' }));
      return { owner, revision: result.Attributes?.['leaseRevision'] as number, now };
    } catch (error) { if (conditional(error)) return null; throw error; }
  }
  async releaseLease(id: string, owner: string): Promise<void> {
    try { await this.options.ddb.send(new UpdateCommand({ TableName: this.options.table, Key: this.stateKey(id), UpdateExpression: 'REMOVE leaseOwner, leaseUntil', ConditionExpression: 'leaseOwner = :owner', ExpressionAttributeValues: { ':owner': owner } })); } catch (error) { if (!conditional(error)) throw error; }
  }
  async putEvent(event: StripeEventEnvelope): Promise<boolean> {
    try { await this.options.ddb.send(new PutCommand({ TableName: this.options.table, Item: { ...event, ...this.eventKey(event.eventId), ...financial, gsi1pk: `BILLING#EVENTS#${this.options.stage}`, gsi1sk: dueSort(event.nextAttemptAt, event.eventId) }, ConditionExpression: 'attribute_not_exists(pk)' })); return true; } catch (error) { if (conditional(error)) return false; throw error; }
  }
  async event(id: string) { return this.strong<StripeEventEnvelope>(this.eventKey(id)); }
  async finishEvent(id: string, status: 'processed' | 'ignored' | 'review', now: number) {
    await this.options.ddb.send(new UpdateCommand({ TableName: this.options.table, Key: this.eventKey(id), UpdateExpression: 'SET #status = :status, processedAt = :now REMOVE gsi1pk, gsi1sk', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': status, ':now': now } }));
  }
  async retryEvent(id: string, now: number) {
    const event = await this.event(id); if (!event || event.status !== 'pending') return;
    if (event.attempts >= 11) return this.finishEvent(id, 'review', now);
    const next = now + Math.min(900_000, 2 ** event.attempts * 1000);
    await this.options.ddb.send(new UpdateCommand({ TableName: this.options.table, Key: this.eventKey(id), UpdateExpression: 'SET attempts = :attempts, nextAttemptAt = :next, gsi1sk = :sort', ConditionExpression: '#status = :pending AND attempts = :old', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':attempts': event.attempts + 1, ':old': event.attempts, ':next': next, ':sort': dueSort(next, id), ':pending': 'pending' } }));
  }
  async due(kind: 'events' | 'owners', now: number, cursor?: Record<string, unknown>, limit = 25) {
    const result = await this.options.ddb.send(new QueryCommand({ TableName: this.options.table, IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk <= :through', ExpressionAttributeValues: { ':pk': `BILLING#${kind === 'events' ? 'EVENTS' : 'OWNERS'}#${this.options.stage}`, ':through': `${dueSort(now, '')}\uffff` }, Limit: Math.min(100, limit), ExclusiveStartKey: cursor }));
    const items = result.Items ?? [];
    return { items: items as (StripeEventEnvelope | BillingState)[], itemCursors: items.map((v) => ({ pk: v['pk'], sk: v['sk'], gsi1pk: v['gsi1pk'], gsi1sk: v['gsi1sk'] })), ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) };
  }
  async readCursor(name: string) { return (await this.strong<{ cursor?: Record<string, unknown> }>({ pk: `BILLING#RECONCILER#${this.options.stage}`, sk: `CURSOR#${name}` }))?.cursor; }
  async saveHistoryCursor(name: string, cursor: Record<string, unknown>, guard: { ownerSub: string; owner: string; revision: number; now: number }): Promise<void> {
    try {
      await this.options.ddb.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: this.options.table, Key: this.stateKey(guard.ownerSub), ConditionExpression: 'leaseOwner = :owner AND leaseRevision = :revision AND leaseUntil > :now', ExpressionAttributeValues: { ':owner': guard.owner, ':revision': guard.revision, ':now': guard.now } } },
        { Put: { TableName: this.options.table, Item: { pk: `BILLING#RECONCILER#${this.options.stage}`, sk: `CURSOR#${name}`, ...financial, cursor } } },
      ] }));
    } catch (e) { if (transactionConflict(e)) throw Object.assign(new Error('history lease lost'), { continuation: true }); throw e; }
  }
  async saveCursor(name: string, cursor?: Record<string, unknown>) { await this.options.ddb.send(new PutCommand({ TableName: this.options.table, Item: { pk: `BILLING#RECONCILER#${this.options.stage}`, sk: `CURSOR#${name}`, ...financial, ...(cursor ? { cursor } : {}) } })); }
}
