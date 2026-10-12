import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Bound simultaneous CDK/esbuild children; synthesis tests have a separate finite 60s deadline.
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
});
