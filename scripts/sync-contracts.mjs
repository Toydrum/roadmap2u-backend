import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(
  process.env.ROADMAP2U_FRONTEND_PATH ?? join(backendRoot, '..', 'RoadMap2U'),
);
const contractFiles = ['api/contracts.ts', 'db/schema.ts', 'auth/auth-types.ts'];
const contractSourceFiles = contractFiles.map((relativePath) =>
  join('src', 'app', 'core', relativePath),
);

function runFrontendGit(args) {
  const safeDirectory = frontendRoot.replaceAll('\\', '/');
  return spawnSync('git', ['-c', `safe.directory=${safeDirectory}`, '-C', frontendRoot, ...args], {
    encoding: 'utf8',
  });
}

function committedFrontendSha() {
  const dirty = runFrontendGit(['diff', '--quiet', 'HEAD', '--', ...contractSourceFiles]);
  if (dirty.status === 1) {
    throw new Error(
      'Frontend contracts have uncommitted changes; commit them before syncing an exact source lock',
    );
  }
  if (dirty.status !== 0) {
    throw new Error(`Unable to inspect frontend contracts: ${dirty.stderr.trim()}`);
  }

  const result = runFrontendGit(['rev-parse', 'HEAD']);
  if (result.status !== 0) {
    throw new Error(`Unable to resolve frontend HEAD: ${result.stderr.trim()}`);
  }
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid frontend HEAD: ${sha}`);
  return sha;
}

function contractHash(root) {
  const hash = createHash('sha256');
  for (const relativePath of contractFiles) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(join(root, relativePath), 'utf8').replaceAll('\r\n', '\n'), 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

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

const lockDestination = join(backendRoot, 'shared', 'contracts-source.json');
const lockContents = `${JSON.stringify(
  {
    schemaVersion: 1,
    repository: 'Toydrum/RoadMap2U',
    commitSha: committedFrontendSha(),
    contractHash: contractHash(join(backendRoot, 'shared')),
  },
  null,
  2,
)}\n`;
if (!existsSync(lockDestination) || readFileSync(lockDestination, 'utf8') !== lockContents) {
  changed.push(lockDestination.slice(backendRoot.length + 1));
}
writeFileSync(lockDestination, lockContents, 'utf8');

process.stdout.write(`Synced ${copies.length} contracts from ${frontendRoot}\n`);
process.stdout.write(
  changed.length > 0
    ? `Updated:\n${changed.map((path) => `  ${path}`).join('\n')}\n`
    : 'No vendored contract changed.\n',
);
process.stdout.write('Run npm test before committing.\n');
