import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const frontendRoot = resolve(
  process.env['ROADMAP2U_FRONTEND_PATH'] ?? join(backendRoot, '..', 'RoadMap2U'),
);
const contractFiles = [
  'api/contracts.ts',
  'db/schema.ts',
  'auth/auth-types.ts',
] as const;

const contractSourcePath = join(backendRoot, 'shared', 'contracts-source.json');

function sourcePath(relativePath: string): string {
  return join(frontendRoot, 'src', 'app', 'core', relativePath);
}

function vendoredPath(relativePath: string): string {
  return join(backendRoot, 'shared', relativePath);
}

function contractHash(root: string): string {
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

describe('vendored frontend contracts', () => {
  it('pins the exact frontend repository, commit and vendored contract hash', () => {
    expect(existsSync(contractSourcePath), `Missing contract source lock ${contractSourcePath}`).toBe(
      true,
    );
    const lock = JSON.parse(readFileSync(contractSourcePath, 'utf8')) as Record<string, unknown>;

    expect(lock).toEqual({
      schemaVersion: 1,
      repository: 'Toydrum/RoadMap2U',
      commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      contractHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(lock['commitSha']).toBe('5c8a4f1bfb4c8c0f63c7dc666fd498c7eeb5eb92');
    expect(lock['contractHash']).toBe(contractHash(join(backendRoot, 'shared')));
  });

  it('resolves and verifies the pinned checkout before parity checks', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'roadmap-contract-source-'));
    try {
      const fakeFrontend = join(sandbox, 'frontend');
      for (const relativePath of contractFiles) {
        const source = vendoredPath(relativePath);
        const destination = join(fakeFrontend, 'src', 'app', 'core', relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
      const runGit = (...args: string[]) =>
        spawnSync('git', ['-C', fakeFrontend, ...args], { encoding: 'utf8' });
      expect(runGit('init', '--quiet').status).toBe(0);
      expect(runGit('config', 'user.name', 'RoadMap2U Contract Test').status).toBe(0);
      expect(runGit('config', 'user.email', 'contract-test@roadmap2u.invalid').status).toBe(0);
      expect(runGit('config', 'commit.gpgsign', 'false').status).toBe(0);
      expect(runGit('add', 'src/app/core').status).toBe(0);
      expect(runGit('commit', '--quiet', '-m', 'contract fixture').status).toBe(0);
      const commitResult = runGit('rev-parse', 'HEAD');
      expect(commitResult.status, commitResult.stderr).toBe(0);
      const commitSha = commitResult.stdout.trim();
      const expectedHash = contractHash(join(backendRoot, 'shared'));
      const lockPath = join(sandbox, 'contracts-source.json');
      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          repository: 'Toydrum/RoadMap2U',
          commitSha,
          contractHash: expectedHash,
        }),
        'utf8',
      );

      const githubOutput = join(sandbox, 'github-output');
      const script = join(backendRoot, 'scripts', 'verify-contract-source.mjs');
      const resolveResult = spawnSync(
        process.execPath,
        [script, 'resolve', '--lock', lockPath, '--github-output', githubOutput],
        { cwd: backendRoot, encoding: 'utf8' },
      );

      expect(resolveResult.status, resolveResult.stderr).toBe(0);
      expect(readFileSync(githubOutput, 'utf8')).toBe(
        [
          'repository=Toydrum/RoadMap2U',
          `commit_sha=${commitSha}`,
          `contract_hash=${expectedHash}`,
          '',
        ].join('\n'),
      );

      const verifyResult = spawnSync(
        process.execPath,
        [script, 'verify', '--lock', lockPath, '--frontend-root', fakeFrontend],
        { cwd: backendRoot, encoding: 'utf8' },
      );
      expect(verifyResult.status, verifyResult.stderr).toBe(0);
      expect(verifyResult.stdout).toContain('Verified pinned frontend contract source');

      writeFileSync(
        join(fakeFrontend, 'src', 'app', 'core', contractFiles[0]),
        '// substituted contract bytes\n',
        'utf8',
      );
      const substitutedContract = spawnSync(
        process.execPath,
        [script, 'verify', '--lock', lockPath, '--frontend-root', fakeFrontend],
        { cwd: backendRoot, encoding: 'utf8' },
      );
      expect(substitutedContract.status).not.toBe(0);
      expect(substitutedContract.stderr).toContain('does not match pinned hash');
      copyFileSync(
        vendoredPath(contractFiles[0]),
        join(fakeFrontend, 'src', 'app', 'core', contractFiles[0]),
      );

      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          repository: 'Toydrum/RoadMap2U',
          commitSha: '0000000000000000000000000000000000000000',
          contractHash: expectedHash,
        }),
        'utf8',
      );
      const substitutedHead = spawnSync(
        process.execPath,
        [script, 'verify', '--lock', lockPath, '--frontend-root', fakeFrontend],
        { cwd: backendRoot, encoding: 'utf8' },
      );
      expect(substitutedHead.status).not.toBe(0);
      expect(substitutedHead.stderr).toContain('does not match pinned commit');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects malformed or substituted contract source locks', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'roadmap-contract-lock-'));
    try {
      const lockPath = join(sandbox, 'contracts-source.json');
      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          repository: 'attacker/substitute',
          commitSha: 'main',
          contractHash: 'not-a-hash',
        }),
        'utf8',
      );
      const result = spawnSync(
        process.execPath,
        [
          join(backendRoot, 'scripts', 'verify-contract-source.mjs'),
          'resolve',
          '--lock',
          lockPath,
        ],
        { cwd: backendRoot, encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Invalid contract source lock');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('requires the frontend source checkout instead of silently skipping parity', () => {
    expect(
      existsSync(frontendRoot),
      `Frontend contract source not found at ${frontendRoot}; set ROADMAP2U_FRONTEND_PATH to its repository root`,
    ).toBe(true);
  });

  it.each(contractFiles)('%s is byte-for-byte identical to the frontend source', (relativePath) => {
    const source = sourcePath(relativePath);
    expect(existsSync(source), `Missing frontend contract ${source}`).toBe(true);
    expect(readFileSync(vendoredPath(relativePath)).equals(readFileSync(source))).toBe(true);
  });

  it('prints the deterministic combined contract hash', () => {
    const result = spawnSync(process.execPath, [join(backendRoot, 'scripts', 'contracts-hash.mjs')], {
      cwd: backendRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(contractHash(join(backendRoot, 'shared')));
  });

  it('keeps the release hash stable across LF and CRLF checkouts', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'roadmap-contract-eol-'));
    try {
      const lfRoot = join(sandbox, 'lf');
      const crlfRoot = join(sandbox, 'crlf');
      for (const relativePath of contractFiles) {
        for (const [root, newline] of [[lfRoot, '\n'], [crlfRoot, '\r\n']] as const) {
          const destination = join(root, relativePath);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, `first${newline}second${newline}`, 'utf8');
        }
      }
      const run = (root: string) =>
        spawnSync(
          process.execPath,
          [join(backendRoot, 'scripts', 'contracts-hash.mjs'), '--root', root],
          { cwd: backendRoot, encoding: 'utf8' },
        );
      const lf = run(lfRoot);
      const crlf = run(crlfRoot);
      expect(lf.status, lf.stderr).toBe(0);
      expect(crlf.status, crlf.stderr).toBe(0);
      expect(crlf.stdout).toBe(lf.stdout);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('syncs all contracts from the configured frontend root', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'roadmap-contracts-'));
    try {
      const fakeBackend = join(sandbox, 'backend');
      const fakeFrontend = join(sandbox, 'frontend');
      const scriptSource = join(backendRoot, 'scripts', 'sync-contracts.mjs');
      const scriptCopy = join(fakeBackend, 'scripts', 'sync-contracts.mjs');
      mkdirSync(dirname(scriptCopy), { recursive: true });
      copyFileSync(scriptSource, scriptCopy);

      for (const relativePath of contractFiles) {
        const source = join(fakeFrontend, 'src', 'app', 'core', relativePath);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, `// ${relativePath}\n`, 'utf8');
      }

      const result = spawnSync(process.execPath, [scriptCopy], {
        cwd: fakeBackend,
        env: { ...process.env, ROADMAP2U_FRONTEND_PATH: fakeFrontend },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      for (const relativePath of contractFiles) {
        expect(readFileSync(join(fakeBackend, 'shared', relativePath), 'utf8')).toBe(
          `// ${relativePath}\n`,
        );
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
