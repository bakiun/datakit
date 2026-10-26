import { defineConfig } from 'vitest/config';

// Integration tests start Kafka and its REST services in Docker.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
