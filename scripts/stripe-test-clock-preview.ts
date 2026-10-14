import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareClockJournal, prepareClockProviderAdvance, type ClockJournalRequest } from './stripe-test-clock-journal';

export const CLOCK_PREVIEW_MANIFEST_MAX_BYTES = 256 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function reject(): never { throw new Error('CLOCK_PREVIEW_MANIFEST_REJECTED'); }

/** Offline projection of recorded input through the real transaction preparers.
 * A valid manifest is neither a live inventory nor physical authorization. */
export async function prepareClockPreview(raw: unknown) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > CLOCK_PREVIEW_MANIFEST_MAX_BYTES) reject();
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { reject(); }
  if (!record(manifest) || manifest.schemaVersion !== 1 ||
      Object.keys(manifest).length !== 3 || !Object.keys(manifest).every(key => ['schemaVersion', 'sourceSha', 'request'].includes(key)) ||
      typeof manifest.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
      !record(manifest.request) || !record(manifest.request.clock) || !record(manifest.request.storage) || !record(manifest.request.snapshot)) reject();
  const plan = await prepareClockJournal(manifest.request as unknown as ClockJournalRequest, manifest.sourceSha);
  const items = plan.transaction.TransactItems!;
  const targets = items.map(item => {
    if (item.Put) return { action: 'Put', table: item.Put.TableName!, key: { pk: item.Put.Item!.pk as string, sk: item.Put.Item!.sk as string } };
    if (item.ConditionCheck) return { action: 'ConditionCheck', table: item.ConditionCheck.TableName!, key: { pk: item.ConditionCheck.Key!.pk as string, sk: item.ConditionCheck.Key!.sk as string } };
    throw new Error('CLOCK_PREVIEW_UNSUPPORTED_TRANSACTION');
  });
  return {
    schemaVersion: 1,
    mode: 'offline_preview',
    manifestSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    intent: structuredClone(plan.intent),
    dynamodb: {
      transactionItems: items.length,
      writes: targets.filter(item => item.action === 'Put').length,
      conditionChecks: targets.filter(item => item.action === 'ConditionCheck').length,
      readbackItems: plan.readback.TransactItems!.length,
      maximumWriteRequests: 1,
      maximumReadbackRequests: 1,
      targets,
    },
    providerAdvance: plan.intent.phase === 'advance_fence'
      ? { ...prepareClockProviderAdvance(plan), requiresVerifiedFence: true, maximumPostRequests: 1 }
      : null,
    physicalExecutionAllowed: false,
    physicalAuthorizationChecked: false,
    sourceShaVerified: false,
    remoteStateVerified: false,
    retryAllowed: false,
  };
}

interface PreviewIo {
  readManifest: (file: string) => Promise<string>;
  writeOut: (text: string) => void;
  writeError: (text: string) => void;
}
/** Bound the actual descriptor read, including growth after stat; never open it for writing. */
async function readManifest(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > CLOCK_PREVIEW_MANIFEST_MAX_BYTES) reject();
    const buffer = Buffer.alloc(CLOCK_PREVIEW_MANIFEST_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > CLOCK_PREVIEW_MANIFEST_MAX_BYTES) reject();
    // Preserve a BOM so JSON.parse rejects it; successful hashes bind every byte.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
  } finally { await handle.close(); }
}
const defaultIo: PreviewIo = {
  readManifest,
  writeOut: text => { process.stdout.write(text); },
  writeError: text => { process.stderr.write(text); },
};
/** Preview is the sole mode. There is deliberately no execute or credentials option. */
export async function runClockPreviewCli(args: readonly string[], io: PreviewIo = defaultIo): Promise<number> {
  const failure = (code: string, exit: number) => {
    io.writeError(JSON.stringify({ status: 'rejected', code }) + '\n');
    return exit;
  };
  if (args.length !== 2 || args[0] !== '--manifest' || typeof args[1] !== 'string' ||
      args[1].trim().length === 0 || args[1] === '-' || args[1].startsWith('--')) return failure('CLOCK_PREVIEW_ARGUMENTS', 2);
  let raw: string;
  try { raw = await io.readManifest(args[1]); } catch { return failure('CLOCK_PREVIEW_READ_FAILED', 1); }
  try {
    const preview = await prepareClockPreview(raw);
    io.writeOut(JSON.stringify(preview, null, 2) + '\n');
    return 0;
  } catch (error) {
    // Controlled preparer codes are useful; JSON fragments, paths and arbitrary
    // dependency errors never reach the operator's stdout/stderr.
    const code = error instanceof Error && /^CLOCK_(?:PREVIEW|PUBLISHER|INSTALL|TRANSITION|JOURNAL)_[A-Z_]+$/.test(error.message)
      ? error.message : 'CLOCK_PREVIEW_REQUEST_REJECTED';
    return failure(code, 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runClockPreviewCli(process.argv.slice(2));
}
