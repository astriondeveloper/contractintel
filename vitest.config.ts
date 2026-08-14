import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup/global-setup.ts'],
    // The loader and resolver tests share one database. Running files in parallel
    // would let them fight over the same rows.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
  },
});
