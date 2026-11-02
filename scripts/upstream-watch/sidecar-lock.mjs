#!/usr/bin/env node
/**
 * Writes a sidecars.lock.json-shaped file for a litd release other than the
 * pinned one, with sha256 values read from that release's manifest
 * (manifest-<tag>.txt). Used only by the weekly upstream watch to test a new
 * litd on regtest; the binary is never bundled. The committed lock stays the
 * only source for shipping builds, and its hashes are verified against the
 * signed manifest by hand when the pin moves.
 *
 *   node scripts/upstream-watch/sidecar-lock.mjs --litd=v0.17.10 --out=/tmp/sidecars.lock.json
 */
import { writeFileSync } from 'node:fs';
import { readJson } from './lib.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = arg('litd');
const out = arg('out');
if (tag === undefined || out === undefined) {
  console.error('usage: sidecar-lock.mjs --litd=<tag> --out=<file>');
  process.exit(2);
}
const pinned = readJson('sidecars.lock.json');
const repo = pinned.litd.repo;
const prefix = pinned.litd.assetPrefix;
const url = `https://github.com/${repo}/releases/download/${tag}/manifest-${tag}.txt`;
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
const manifest = await res.text();

const ASSETS = {
  'linux-x64': `linux-amd64-${tag}.tar.gz`,
  'linux-arm64': `linux-arm64-${tag}.tar.gz`,
  'darwin-x64': `darwin-amd64-${tag}.tar.gz`,
  'darwin-arm64': `darwin-arm64-${tag}.tar.gz`,
  'win32-x64': `windows-amd64-${tag}.zip`,
};
const sha256 = {};
for (const [key, suffix] of Object.entries(ASSETS)) {
  const line = manifest.split('\n').find((l) => l.trim().endsWith(`  ${prefix}-${suffix}`));
  if (line !== undefined) sha256[key] = line.trim().split(/\s+/)[0];
}
if (sha256['linux-x64'] === undefined) throw new Error(`manifest for ${tag} has no linux-amd64 archive`);

writeFileSync(
  out,
  `${JSON.stringify({ $comment: `Upstream-watch canary lock for ${tag}; hashes from ${url}. Not for shipping.`, litd: { ...pinned.litd, tag, sha256 } }, null, 2)}\n`,
);
console.log(`sidecar-lock: ${tag} → ${out} (${Object.keys(sha256).length} platforms)`);
