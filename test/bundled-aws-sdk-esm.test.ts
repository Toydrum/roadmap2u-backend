import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_AWS_SDK_ESM_BANNER } from '../lib/lambda-bundling';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('bundled AWS SDK ESM Lambda runtime', () => {
  it('loads bundled Smithy node transports without a dynamic require failure', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.tmp-aws-sdk-esm-'));
    temporaryDirectories.push(directory);
    const entry = join(directory, 'entry.mjs');
    const outfile = join(directory, 'bundle.mjs');
    await writeFile(
      entry,
      [
        "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
        "const client = new DynamoDBClient({ region: 'us-east-1' });",
        'client.destroy();',
        "console.log('bundle-loaded');",
      ].join('\n'),
      'utf8',
    );

    await build({
      entryPoints: [entry],
      outfile,
      absWorkingDir: process.cwd(),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: { js: BUNDLED_AWS_SDK_ESM_BANNER },
    });

    expect(execFileSync(process.execPath, [outfile], { encoding: 'utf8' })).toContain(
      'bundle-loaded',
    );
  });
});
