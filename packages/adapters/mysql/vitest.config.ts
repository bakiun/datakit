import { defineConfig } from 'vitest/config';

// Integration tests start MySQL, MariaDB and SSH servers in Docker.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
