import { defineConfig } from 'vitest/config';

// E2E tests: boot the Nest app against real PostgreSQL and Redis.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
