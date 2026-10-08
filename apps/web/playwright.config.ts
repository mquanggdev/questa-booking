import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// Browser tests of the buying flow, against the real stack: API, worker,
// PostgreSQL and Redis must be running (docker compose up -d) and seeded
// (pnpm --filter @questa/api db:seed), because tests sign in as the seeded
// organizer to create their own performance.
// Only the seed password is taken from the repo's .env: loading the whole
// file would also pass the API's NODE_ENV=development to `next build`, which
// then fails to prerender.
try {
  process.env.SEED_PASSWORD ??= parseEnv(
    readFileSync('../../.env', 'utf8'),
  ).SEED_PASSWORD;
} catch {
  // CI provides variables directly.
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3200';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Each test builds its own customers and performance, so files can run in
  // parallel; tests inside a file share one performance and run in order.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Next.js recommends testing the production build. Skipped when a server is
  // already running there (local development, or the Docker web container).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm build && pnpm start',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
