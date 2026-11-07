import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test opens its own SQLite file under the OS temp dir, so files may run in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
