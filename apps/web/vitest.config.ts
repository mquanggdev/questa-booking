import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests of pure logic (no browser); browser tests use Playwright (e2e/).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.spec.ts'] },
});
