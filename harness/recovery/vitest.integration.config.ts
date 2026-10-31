import { defineConfig } from 'vitest/config';

// Recovery drill suite — RELEASE-BLOCKING per the Sovereign Wallet spec.
// Every drill runs in a disposable regtest environment (Docker compose nodes
// with wiped data dirs, throwaway litd sidecars, temp SQLite stores) and
// records per-step evidence to docs/TEST_RESULTS.md via the shared recorder.
// Gated behind SOVEREIGN_INTEGRATION=1 like the other integration suites;
// requires Docker + the fetched litd sidecar binary (pnpm sidecar:fetch).
export default defineConfig({
  test: {
    include: ['src/**/*.recovery.test.ts'],
    environment: 'node',
    testTimeout: 420_000,
    hookTimeout: 420_000,
    // The drills stop, wipe, and restart the shared compose nodes — the file
    // order below is deterministic and nodes are re-bootstrapped per file.
    fileParallelism: false,
    passWithNoTests: true,
    sequence: { shuffle: false },
  },
});
