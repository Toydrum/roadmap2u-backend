import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractFiles = [
  'api/contracts.ts',
  'db/schema.ts',
  'auth/auth-types.ts',
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(`Invalid contract source lock: ${message}`);
}

function loadLock(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail('root must be an object');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ['commitSha', 'contractHash', 'repository', 'schemaVersion'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    fail(`keys must be exactly ${expectedKeys.join(', ')}`);
  }
  if (value.schemaVersion !== 1) {
    fail('schemaVersion must be 1');
  }
  if (value.repository !== 'Toydrum/RoadMap2U') {
    fail('repository must be Toydrum/RoadMap2U');
  }
  if (typeof value.commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(value.commitSha)) {
    fail('commitSha must be a lowercase 40-character hexadecimal SHA');
  }
  if (typeof value.contractHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.contractHash)) {
    fail('contractHash must be a lowercase 64-character SHA-256 hash');
  }
  return value;
}

function contractHash(root) {
  const hash = createHash('sha256');
  for (const relativePath of contractFiles) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(
      readFileSync(join(root, relativePath), 'utf8').replaceAll('\r\n', '\n'),
      'utf8',
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

function checkedOutSha(frontendRoot) {
  const safeDirectory = resolve(frontendRoot).replaceAll('\\', '/');
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${safeDirectory}`, '-C', frontendRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to resolve frontend HEAD: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function verify(lock, frontendRoot) {
  const actualSha = checkedOutSha(frontendRoot);
  if (actualSha !== lock.commitSha) {
    throw new Error(`Frontend HEAD ${actualSha} does not match pinned commit ${lock.commitSha}`);
  }

  const frontendHash = contractHash(join(frontendRoot, 'src', 'app', 'core'));
  const vendoredHash = contractHash(join(backendRoot, 'shared'));
  if (frontendHash !== lock.contractHash) {
    throw new Error(
      `Frontend contract hash ${frontendHash} does not match pinned hash ${lock.contractHash}`,
    );
  }
  if (vendoredHash !== lock.contractHash) {
    throw new Error(
      `Vendored contract hash ${vendoredHash} does not match pinned hash ${lock.contractHash}`,
    );
  }

  process.stdout.write(
    `Verified pinned frontend contract source ${lock.repository}@${lock.commitSha}\n`,
  );
}

const command = process.argv[2];
const lockPath = resolve(argument('--lock') ?? join(backendRoot, 'shared', 'contracts-source.json'));

try {
  const lock = loadLock(lockPath);
  if (command === 'resolve') {
    const githubOutput = argument('--github-output');
    if (githubOutput) {
      appendFileSync(
        githubOutput,
        `repository=${lock.repository}\ncommit_sha=${lock.commitSha}\ncontract_hash=${lock.contractHash}\n`,
        'utf8',
      );
    } else {
      process.stdout.write(`${JSON.stringify(lock)}\n`);
    }
  } else if (command === 'verify') {
    const frontendRoot = argument('--frontend-root');
    if (!frontendRoot) {
      throw new Error('verify requires --frontend-root');
    }
    verify(lock, resolve(frontendRoot));
  } else {
    throw new Error('Usage: verify-contract-source.mjs <resolve|verify> [options]');
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
