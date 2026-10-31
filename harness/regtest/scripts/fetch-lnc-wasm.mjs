#!/usr/bin/env node
/**
 * Fetch the pinned LNC wasm client binary and verify its SHA256.
 *
 * @lightninglabs/lnc-web does not bundle the wasm — WasmManager fetches it
 * from a URL. The e2e pins the version and checksum here, then serves the
 * file over a local loopback HTTP server so the pairing test is hermetic
 * (no CDN dependency at test time, no silent upstream swaps).
 *
 * Usage: node harness/regtest/scripts/fetch-lnc-wasm.mjs
 * Output: harness/regtest/data/lnc/lnc-v0.3.6-alpha.wasm
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const PINNED = {
  url: 'https://lightning.engineering/lnc-v0.3.6-alpha.wasm',
  version: '0.3.6-alpha',
  // SHA256 of the exact artifact served at the pinned URL (retrieved and
  // hashed on 2026-10-31, 92,199,482 bytes). Re-pin deliberately when
  // upgrading the LNC client.
  sha256: '32771b00d1ff87fc2a397bdc921b9fae72809ebf8f46ca667838b84e6a3b02b3',
  size: 92_199_482,
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'lnc');
const outPath = join(outDir, `lnc-v${PINNED.version}.wasm`);

async function sha256Ok(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex') === PINNED.sha256;
}

if (existsSync(outPath) && (await sha256Ok(outPath))) {
  console.log(`lnc wasm already pinned: ${outPath}`);
  process.exit(0);
}

console.log(`fetching ${PINNED.url} ...`);
const response = await fetch(PINNED.url);
if (!response.ok || !response.body) {
  console.error(`::error::failed to fetch LNC wasm: HTTP ${response.status}`);
  process.exit(1);
}
await rm(outPath, { force: true });
mkdirSync(outDir, { recursive: true });
await pipeline(Readable.fromWeb(response.body), createWriteStream(outPath));

const hash = createHash('sha256');
hash.update(await readFile(outPath));
const actual = hash.digest('hex');
if (actual !== PINNED.sha256) {
  await rm(outPath, { force: true });
  console.error(`::error::LNC wasm checksum mismatch: expected ${PINNED.sha256}, got ${actual}`);
  process.exit(1);
}
console.log(`lnc wasm verified (${PINNED.size} bytes): ${outPath}`);
