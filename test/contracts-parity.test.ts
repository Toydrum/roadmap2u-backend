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
