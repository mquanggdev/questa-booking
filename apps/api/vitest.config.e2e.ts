import { defineConfig } from 'vitest/config';
import { testEnv } from './test/support/test-env.js';

// E2E tests: boot the Nest app against real PostgreSQL and Redis, using an
// isolated test database (see test/support/test-env.ts).
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: testEnv,
    globalSetup: ['./test/support/global-setup.ts'],
    // Files share one database and truncate it, so they must not overlap.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
