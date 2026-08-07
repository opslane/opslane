import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    include: ['src/__tests__/**/*.test.ts', 'github-cases/__tests__/**/*.test.mjs'],
  },
});
