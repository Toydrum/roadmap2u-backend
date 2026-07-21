import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const contractsRoot = rootIndex >= 0
  ? resolve(process.argv[rootIndex + 1] ?? '')
  : join(backendRoot, 'shared');
const contractFiles = [
  'api/contracts.ts',
  'db/schema.ts',
  'auth/auth-types.ts',
];
const hash = createHash('sha256');

for (const relativePath of contractFiles) {
  hash.update(relativePath, 'utf8');
  hash.update('\0');
  // Git may materialize text files as CRLF on Windows and LF on Linux.
  // Canonicalize only for the cross-platform release hash; the parity test
  // still compares the vendored contracts byte for byte.
  const contents = readFileSync(join(contractsRoot, relativePath), 'utf8')
    .replaceAll('\r\n', '\n');
  hash.update(contents, 'utf8');
  hash.update('\0');
}

process.stdout.write(`${hash.digest('hex')}\n`);
