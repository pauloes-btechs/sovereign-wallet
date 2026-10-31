/**
 * Deterministic property fuzzing for the wallet-owned untrusted-input
 * parsers. NOT random-at-runtime: a fixed seed list runs every CI pass, so
 * a failure is exactly reproducible by re-running the suite with the same
 * seed (printed in the failure message). The dedicated CI fuzz job
 * escalates the iteration budget via FUZZ_ITERATIONS.
 *
 * Oracles, per target:
 *  - parseDestination / bech32Decode: TOTAL — never throw; onchain/invoice
 *    results are canonicalization-stable (normalized re-parses identically);
 *    a valid string's lowercase form stays valid.
 *
 * Sidecar listen-argument parsing is fuzzed separately, next to its
 * implementation (packages/privacy/src/listenargs.fuzz.test.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  bech32Decode,
  bech32Encode,
  convertBits,
  parseDestination,
  segwitAddressEncode,
} from './index.js';

/** xorshift32 — deterministic, fast, good enough for structured fuzzing. */
function makePrng(seed: number): () => number {
  let state = seed | 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const CHARPOOL = 'qpzry9x8gf2tvdw0s3jn54khce6mua7lbc1munp0123456789ABCDEF:.%_-\\';

function randomString(rng: () => number, maxLength: number): string {
  const len = Math.floor(rng() * maxLength);
  let out = '';
  for (let i = 0; i < len; i++) out += CHARPOOL[Math.floor(rng() * CHARPOOL.length)] ?? '';
  return out;
}

function mutate(rng: () => number, s: string): string {
  if (s.length === 0) return randomString(rng, 4);
  const copy = [...s];
  const mutations = Math.max(1, Math.floor(rng() * 3));
  for (let i = 0; i < mutations; i++) {
    const pos = Math.floor(rng() * copy.length);
    switch (Math.floor(rng() * 4)) {
      case 0: // bit flip on a random char
        copy[pos] = String.fromCharCode(copy[pos]!.charCodeAt(0) ^ (1 << Math.floor(rng() * 7)));
        break;
      case 1: // deletion
        copy.splice(pos, 1);
        break;
      case 2: // insert a hostile char
        copy.splice(pos, 0, CHARPOOL[Math.floor(rng() * CHARPOOL.length)] ?? 'q');
        break;
      case 3: // truncate
        copy.length = pos;
        break;
    }
    if (copy.length === 0) break;
  }
  return copy.join('');
}

function validAddresses(rng: () => number): string[] {
  const hrps = ['bc', 'tb', 'bcrt'];
  const out: string[] = [];
  for (const hrp of hrps) {
    for (const [version, size] of [
      [0, 20],
      [0, 32],
      [1, 32],
    ] as const) {
      const program = Array.from({ length: size }, () => Math.floor(rng() * 256));
      const encoded = segwitAddressEncode(hrp, version, program);
      if (encoded) out.push(encoded);
    }
  }
  return out;
}

function validInvoices(rng: () => number): string[] {
  const hash = Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256));
  const words = [...convertBits(hash, 8, 5, true)!];
  const fieldWords = [1, 1, 20, ...words];
  const out: string[] = [];
  for (const hrp of ['lnbc', 'lntb', 'lnbcrt', 'lnbc100n', 'lnbc2m', 'lntb50u']) {
    out.push(bech32Encode(hrp, fieldWords, 'bech32'));
  }
  return out;
}

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 25_000);
const SEEDS = [0x5eed1, 0x5eed2, 0x5eed3];

interface Corpus {
  name: string;
  items: string[];
}

function buildCorpora(seed: number): Corpus[] {
  const rng = makePrng(seed);
  const valid = [...validAddresses(rng), ...validInvoices(rng)];
  const mutated: string[] = [];
  for (let i = 0; i < Math.ceil(ITERATIONS / 2); i++) {
    mutated.push(mutate(rng, valid[Math.floor(rng() * valid.length)] ?? 'bc1'));
  }
  const random: string[] = [];
  for (let i = 0; i < Math.ceil(ITERATIONS / 2); i++) random.push(randomString(rng, 120));
  return [
    { name: 'mutated-valid', items: mutated },
    { name: 'random-printable', items: random },
  ];
}

describe('fuzz: parseDestination and bech32Decode (total parsers)', () => {
  for (const seed of SEEDS) {
    it(`holds oracle invariants across the corpus [seed=0x${seed.toString(16)}, n=${ITERATIONS}]`, () => {
      for (const corpus of buildCorpora(seed)) {
        for (const input of corpus.items) {
          let result: ReturnType<typeof parseDestination>;
          // Oracle 1: total — never throws.
          try {
            result = parseDestination(input);
          } catch (err) {
            throw new Error(
              `parseDestination threw on ${corpus.name} input (seed 0x${seed.toString(16)}): ${JSON.stringify(input)} — ${err}`,
            );
          }
          if (result.ok && (result.kind === 'onchain' || result.kind === 'lightning-invoice')) {
            // Oracle 2: canonicalization stability — the normalized form
            // re-parses to the same kind.
            const reparsed = parseDestination(result.normalized);
            expect(
              reparsed.kind === result.kind,
              `re-parse flipped kind for ${JSON.stringify(input)}`,
            ).toBe(true);
            // Oracle 3: a valid lowercase form stays valid.
            expect(parseDestination(result.normalized.toLowerCase()).ok).toBe(true);
          }
          // bech32Decode: same totality oracle on the raw charset corpus.
          try {
            bech32Decode(input);
          } catch (err) {
            throw new Error(
              `bech32Decode threw on ${corpus.name} input (seed 0x${seed.toString(16)}): ${JSON.stringify(input)} — ${err}`,
            );
          }
        }
      }
    });
  }
});

