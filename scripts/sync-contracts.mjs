import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(
  process.env.ROADMAP2U_FRONTEND_PATH ?? join(backendRoot, '..', 'RoadMap2U'),
);
const contractFiles = [
  'api/contracts.ts',
  'db/schema.ts',
  'auth/auth-types.ts',
];

const copies = contractFiles.map((relativePath) => ({
  source: join(frontendRoot, 'src', 'app', 'core', relativePath),
  destination: join(backendRoot, 'shared', relativePath),
}));

for (const { source } of copies) {
  if (!existsSync(source)) {
    throw new Error(
      `Frontend contract not found at ${source}; set ROADMAP2U_FRONTEND_PATH to the frontend repository root`,
    );
  }
}

const changed = [];
for (const { source, destination } of copies) {
  if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination))) {
    changed.push(destination.slice(backendRoot.length + 1));
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

process.stdout.write(`Synced ${copies.length} contracts from ${frontendRoot}\n`);
process.stdout.write(
  changed.length > 0
    ? `Updated:\n${changed.map((path) => `  ${path}`).join('\n')}\n`
    : 'No vendored contract changed.\n',
);
process.stdout.write('Run npm test before committing.\n');
