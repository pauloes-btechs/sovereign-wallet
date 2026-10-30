import { defineConfig } from 'vitest/config';

// Unit tests only — the integration suite against the Docker regtest harness
// runs separately: `pnpm --filter @sovereign/litd-adapter test:integration`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/integration/**'],
    environment: 'node',
  },
});
