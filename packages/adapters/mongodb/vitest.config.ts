import { defineConfig } from 'vitest/config';

// Integration tests start MongoDB servers in Docker.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
