import type { SubscriptionSourceItem } from '../commercial/model';
import { isDeepStrictEqual } from 'node:util';
import { initialState, type BillingActor, type BillingCommit, type BillingCommand, type BillingRepository, type BillingState, type InvoiceReceipt, type StripeEventEnvelope } from './model';

/** Deterministic transactional adapter used by synthetic provider scenarios. */
export class MemoryBillingRepository implements BillingRepository {
  readonly testClocks = new Map<string, unknown>();
  async readTestClock(id: string): Promise<unknown> { return structuredClone(this.testClocks.get(id) ?? null); }
  readonly actors = new Map<string, BillingActor>();
  readonly states = new Map<string, BillingState>();
  readonly commands = new Map<string, BillingCommand>();
  readonly invoices = new Map<string, InvoiceReceipt>();
  readonly sources = new Map<string, SubscriptionSourceItem>();
  readonly mappings = new Map<string, string>();
  readonly events = new Map<string, StripeEventEnvelope>();
  readonly cursors = new Map<string, Record<string, unknown>>();
  readonly audit: { ownerSub: string; action: string; revision: number }[] = [];
  async actor(id: string): Promise<BillingActor | null> { return structuredClone(this.actors.get(id) ?? null); }
  async load(id: string): Promise<BillingState> { return structuredClone(this.states.get(id) ?? initialState(id)); }
  async command(id: string, commandId: string): Promise<BillingCommand | null> { return structuredClone(this.commands.get(`${id}/${commandId}`) ?? null); }
  async receipts(id: string): Promise<InvoiceReceipt[]> { return structuredClone([...this.invoices.values()].filter((i) => i.ownerSub === id)); }
  async projectionRevision(id: string): Promise<number> { return this.sources.get(id)?.revision ?? 0; }
  async mappedOwner(kind: string, id: string): Promise<string | null> { return this.mappings.get(`${kind}/${id}`) ?? null; }
  async commit(c: BillingCommit): Promise<boolean> {
    if (c.clockObservation && !isDeepStrictEqual(c.clockObservation.item, await this.readTestClock(c.state.ownerSub))) return false;
    const old = this.states.get(c.state.ownerSub) ?? initialState(c.state.ownerSub);
    if (old.revision !== c.expectedRevision) return false;
    const actor = this.actors.get(c.state.ownerSub);
    if ((c.guard === 'standard' || c.guard === 'adult' || c.guard === 'open') && (!actor || actor.status !== 'active' || actor.closing)) return false;
    if (c.guard === 'standard' && (actor!.accountType !== 'adult' || actor!.privacyMode !== undefined || (!actor!.accountTermsCurrent && !actor!.adultDeclarationCurrent) || actor!.privacyRevision !== c.actor?.privacyRevision || actor!.accountTermsHash !== c.actor?.accountTermsHash || actor!.declarationHash !== c.actor?.declarationHash)) return false;
    if (c.guard === 'adult' && (actor!.accountType !== 'adult' || !actor!.adultDeclarationCurrent || actor!.privacyMode === 'adolescent_private')) return false;
    if (c.lease && (old.leaseOwner !== c.lease.owner || old.leaseRevision !== c.lease.revision || (old.leaseUntil ?? 0) <= c.lease.now)) return false;
    if (!c.lease && (old.leaseUntil ?? 0) > c.state.updatedAt) return false;
    if (c.source && (!actor || actor.status !== 'active' || actor.closing || c.state.closingId || c.state.closedAt || (this.sources.get(c.state.ownerSub)?.revision ?? -1) >= c.source.revision)) return false;
    if (c.commandAbsent && c.command && this.commands.has(`${c.command.ownerSub}/${c.command.commandId}`)) return false;
    if (c.mappings?.some((m) => this.mappings.has(`${m.kind}/${m.id}`) && this.mappings.get(`${m.kind}/${m.id}`) !== c.state.ownerSub)) return false;
    this.states.set(c.state.ownerSub, structuredClone(c.state));
    if (c.command) this.commands.set(`${c.command.ownerSub}/${c.command.commandId}`, structuredClone(c.command));
    for (const i of c.invoices ?? []) this.invoices.set(`${i.ownerSub}/${i.invoiceId}`, structuredClone(i));
    for (const m of c.mappings ?? []) this.mappings.set(`${m.kind}/${m.id}`, c.state.ownerSub);
    if (c.source && actor && actor.status === 'active' && !actor.closing && !c.state.closingId && !c.state.closedAt) this.sources.set(c.state.ownerSub, structuredClone(c.source));
    this.audit.push({ ownerSub: c.state.ownerSub, action: c.auditAction, revision: c.state.revision });
    return true;
  }
  async acquireLease(id: string, owner: string, now: number, duration: number) {
    const s = this.states.get(id) ?? initialState(id);
    if (s.leaseOwner && (s.leaseUntil ?? 0) > now && s.leaseOwner !== owner) return null;
    const revision = (s.leaseRevision ?? 0) + 1;
    this.states.set(id, { ...s, leaseOwner: owner, leaseUntil: now + duration, leaseRevision: revision });
    return { owner, revision, now };
  }
  async releaseLease(id: string, owner: string): Promise<void> {
    const s = this.states.get(id);
    if (s?.leaseOwner === owner) this.states.set(id, { ...s, leaseOwner: undefined, leaseUntil: undefined });
  }
  async putEvent(e: StripeEventEnvelope): Promise<boolean> { if (this.events.has(e.eventId)) return false; this.events.set(e.eventId, structuredClone(e)); return true; }
  async event(id: string): Promise<StripeEventEnvelope | null> { return structuredClone(this.events.get(id) ?? null); }
  async finishEvent(id: string, status: 'processed' | 'ignored' | 'review', now: number): Promise<void> { const e = this.events.get(id)!; this.events.set(id, { ...e, status, processedAt: now }); }
  async retryEvent(id: string, now: number): Promise<void> { const e = this.events.get(id); if (!e || e.status !== 'pending') return; if (e.attempts >= 11) return this.finishEvent(id, 'review', now); this.events.set(id, { ...e, attempts: e.attempts + 1, nextAttemptAt: now + Math.min(900_000, 2 ** e.attempts * 1000) }); }
  async due(kind: 'events' | 'owners', now: number, cursor?: Record<string, unknown>, limit = 25) {
    const key = (v: StripeEventEnvelope | BillingState) => 'eventId' in v ? `${String(v.nextAttemptAt).padStart(14, '0')}#${v.eventId}` : `${String(v.nextReconcileAt).padStart(14, '0')}#${v.ownerSub}`;
    const all = (kind === 'events' ? [...this.events.values()].filter((e) => e.status === 'pending' && e.nextAttemptAt <= now) : [...this.states.values()].filter((s) => s.nextReconcileAt <= now && s.state !== 'closed')).sort((a, b) => key(a).localeCompare(key(b))).filter((v) => typeof cursor?.['after'] !== 'string' || key(v) > cursor['after']);
    const selected = all.slice(0, limit), itemCursors = selected.map((v) => ({ after: key(v) }));
    return { items: structuredClone(selected), itemCursors, ...(all.length > limit ? { cursor: itemCursors.at(-1) } : {}) };
  }
  async readCursor(name: string) { return this.cursors.get(name); }
  async saveHistoryCursor(name: string, cursor: Record<string, unknown>, guard: { ownerSub: string; owner: string; revision: number; now: number }) {
    const state = this.states.get(guard.ownerSub);
    if (state?.leaseOwner !== guard.owner || state?.leaseRevision !== guard.revision || (state?.leaseUntil ?? 0) <= guard.now) throw Object.assign(new Error('history lease lost'), { continuation: true });
    return this.saveCursor(name, cursor);
  }
  async saveCursor(name: string, cursor?: Record<string, unknown>) { if (cursor) this.cursors.set(name, cursor); else this.cursors.delete(name); }
}
