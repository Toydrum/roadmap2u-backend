import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CDK entrypoint configuration', () => {
  it('refuses to synthesize without an explicit stage context', () => {
    const executable = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const result = spawnSync(process.execPath, [executable, 'bin/roadmap.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_ACCOUNT_ID: '123456789012',
        HOSTED_ZONE_ID: 'Z0123456789ABCDEFGHIJ',
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Missing required CDK context "stage"',
    );
  });
});
