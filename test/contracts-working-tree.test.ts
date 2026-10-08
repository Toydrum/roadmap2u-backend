import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
describe('explicit local contract copies', () => {
  it('copies uncommitted contracts without manufacturing a release lock and rejects CI use', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'roadmap-local-contracts-'));
    try {
      const frontend = join(sandbox, 'frontend');
      const backend = join(sandbox, 'backend');
      const script = join(backend, 'scripts', 'sync-contracts.mjs');
      mkdirSync(dirname(script), { recursive: true });
      copyFileSync(join(root, 'scripts', 'sync-contracts.mjs'), script);
      for (const name of [
        'api/contracts.ts',
        'db/schema.ts',
        'auth/auth-types.ts',
        'i18n/es.ts',
        'i18n/en.ts',
      ]) {
        const source = join(frontend, 'src', 'app', 'core', name);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, `// ${name}\n`);
      }
      const git = (...args: string[]) =>
        spawnSync('git', ['-C', frontend, ...args], { encoding: 'utf8' });
      expect(git('init', '--quiet').status).toBe(0);
      expect(git('config', 'user.name', 'Contract Fixture').status).toBe(0);
      expect(git('config', 'user.email', 'fixture@roadmap2u.invalid').status).toBe(0);
      expect(git('config', 'commit.gpgsign', 'false').status).toBe(0);
      expect(git('add', 'src').status).toBe(0);
      expect(git('commit', '--quiet', '-m', 'fixture').status).toBe(0);
      writeFileSync(join(frontend, 'src', 'app', 'core', 'api/contracts.ts'), '// uncommitted\n');
      const env = { ...process.env, ROADMAP2U_FRONTEND_PATH: frontend, CI: '' };
      const result = spawnSync(process.execPath, [script, '--working-tree'], {
        env,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(backend, 'shared', 'api', 'contracts.ts'), 'utf8')).toBe(
        '// uncommitted\n',
      );
      expect(existsSync(join(backend, 'shared', 'contracts-source.json'))).toBe(false);
      const preview = JSON.parse(
        readFileSync(join(backend, 'shared', 'contracts-working-tree.json'), 'utf8'),
      );
      expect(preview).toMatchObject({
        state: 'working_tree',
        baseCommitSha: git('rev-parse', 'HEAD').stdout.trim(),
      });
      const ci = spawnSync(process.execPath, [script, '--working-tree'], {
        env: { ...env, CI: 'true' },
        encoding: 'utf8',
      });
      expect(ci.status).not.toBe(0);
      expect(ci.stderr).toContain('not allowed in CI');
    } finally {
      if (
        !resolve(sandbox).startsWith(resolve(tmpdir()) + '\\') &&
        !resolve(sandbox).startsWith(resolve(tmpdir()) + '/')
      )
        throw new Error('unsafe test cleanup');
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
