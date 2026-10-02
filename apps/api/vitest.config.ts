import { defineConfig } from 'vitest/config';

// Unit tests: fast, no database or Redis. Files next to the code as *.spec.ts.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
