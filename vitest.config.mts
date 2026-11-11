import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Each integration file gets its own database cloned from a migrated template,
    // so files can run in parallel without sharing ledger state.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
