/**
 * Deterministic fuzz target for sidecar listen-argument parsing. Lives next
 * to the code it targets (packages/privacy). Same seed discipline as the
 * wallet-core fuzz suite: fixed seeds every CI pass, failures reproducible
 * by re-running with FUZZ_ITERATIONS raised.
 */

import { describe, expect, it } from 'vitest';
import { parseHostPort, validateSidecarListenArgs } from './index.js';

/** xorshift32 — must match the wallet-core fuzz suite's generator. */
function makePrng(seed: number): () => number {
  let state = seed | 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 25_000);
const SEEDS = [0x5eed1, 0x5eed2, 0x5eed3];
const CHARPOOL = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l0123456789.:%_-\\[]';

function randomString(rng: () => number, maxLength: number): string {
  const len = Math.floor(rng() * maxLength);
  let out = '';
  for (let i = 0; i < len; i++) out += CHARPOOL[Math.floor(rng() * CHARPOOL.length)];
  return out;
}

describe('fuzz: sidecar listen-arg parsing (typed failures only)', () => {
  for (const seed of SEEDS) {
    it(`parseHostPort/validateSidecarListenArgs never throw untyped errors [seed=0x${seed.toString(16)}]`, () => {
      const rng = makePrng(seed);
      for (let i = 0; i < ITERATIONS / 10; i++) {
        const value = randomString(rng, 30);
        try {
          parseHostPort(value);
        } catch (err) {
          // The only permitted failure mode is a typed Error.
          expect(err instanceof Error, `untyped throw for ${JSON.stringify(value)}`).toBe(true);
        }
        // A crafted --flag=value listen arg with hostile content.
        const flag = `--${randomString(rng, 8).replace(/[^a-z.]/gi, '')}=${value}`;
        try {
          validateSidecarListenArgs([flag], { label: 'fuzz' });
        } catch (err) {
          expect(err instanceof Error, `untyped throw for ${JSON.stringify(flag)}`).toBe(true);
        }
      }
    });
  }
});
