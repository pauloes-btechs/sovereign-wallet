import { defineConfig } from 'vitest/config';

// Integration suite: boots the real litd sidecar binary against the Docker
// regtest harness (bitcoind + 2x LND). Gated behind SOVEREIGN_INTEGRATION=1
// in package.json scripts; requires Docker.
export default defineConfig({
  test: {
    include: ['src/integration/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // Containers share ports and block state — never parallelize.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
