#!/usr/bin/env node
/**
 * Verifies that our shipping sidecar pins come from a SIGNED upstream release
 * manifest, and re-pins them from one.
 *
 *   node scripts/verify-release.mjs litd                 # check sidecars.lock.json
 *   node scripts/verify-release.mjs waved                # check scripts/fetch-waved.mjs
 *   node scripts/verify-release.mjs litd --tag=v0.17.10 --write-lock \
 *        --bundled="LND v0.21.6-beta, tapd v0.8.8, Loop v0.35.2, Pool v0.7.2, Faraday v0.2.20"
 *
 * For a release it downloads manifest-<tag>.txt and every
 * manifest-<signer>-<tag>.sig for the signers trusted for that component in
 * scripts/release-keys/signers.json. Each signature is checked with gpg in a
 * throwaway keyring that holds ONLY that signer's committed key, and counts
 * only when gpg reports VALIDSIG for exactly the pinned primary fingerprint
 * (and, if the key has since expired, the signature predates the expiry).
 * Fewer than `minSignatures` good signatures, or any pin that differs from
 * the signed manifest, is a hard failure. `--write-lock` writes hashes only
 * after the same verification passes; it never writes an unverified hash.
 *
 * Needs gpg on PATH and network access to github.com release downloads.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = path.join(repoRoot, 'scripts/release-keys');

/** Platform key (sidecars.lock.json) → manifest asset suffix, as fetch-sidecars.mjs downloads them. */
export const LITD_ASSETS = {
  'linux-x64': (tag) => `linux-amd64-${tag}.tar.gz`,
  'linux-arm64': (tag) => `linux-arm64-${tag}.tar.gz`,
  'darwin-x64': (tag) => `darwin-amd64-${tag}.tar.gz`,
  'darwin-arm64': (tag) => `darwin-arm64-${tag}.tar.gz`,
  'win32-x64': (tag) => `windows-amd64-${tag}.zip`,
};

/** Tauri triple (fetch-waved.mjs) → path of the waved binary inside the manifest. */
export const WAVED_BINARIES = {
  'x86_64-unknown-linux-gnu': (tag) => `wavelength-linux-amd64-${tag}/waved`,
  'aarch64-unknown-linux-gnu': (tag) => `wavelength-linux-arm64-${tag}/waved`,
  'x86_64-pc-windows-msvc': (tag) => `wavelength-windows-amd64-${tag}/waved.exe`,
  'x86_64-apple-darwin': (tag) => `wavelength-darwin-amd64-${tag}/waved`,
  'aarch64-apple-darwin': (tag) => `wavelength-darwin-arm64-${tag}/waved`,
};

/** `sha256  name` lines → Map(name → lowercase sha256). Rejects a name listed twice with different hashes. */
export function parseManifest(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line);
    if (m === null) continue;
    const [, sha, name] = m;
    const prev = out.get(name);
    if (prev !== undefined && prev !== sha.toLowerCase()) throw new Error(`manifest lists ${name} twice with different hashes`);
    out.set(name, sha.toLowerCase());
  }
  return out;
}

/**
 * Reads `gpg --status-fd` output for ONE detached signature. Returns whether it
 * is a valid signature by the expected primary key. VALIDSIG's last field is
 * the primary-key fingerprint, field 3 the signature's creation time. An
 * expired key (EXPKEYSIG/KEYEXPIRED) is accepted only for signatures made
 * before it expired; a revoked key or bad signature never is.
 */
export function evaluateGpgStatus(status, expectedFingerprint) {
  const lines = status.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[GNUPG:] '));
  const fields = (kw) => lines.filter((l) => l.split(' ')[1] === kw).map((l) => l.split(' ').slice(2));
  const expected = expectedFingerprint.toUpperCase();
  if (fields('BADSIG').length > 0) return { ok: false, reason: 'bad signature' };
  if (fields('REVKEYSIG').length > 0) return { ok: false, reason: 'signing key is revoked' };
  if (fields('ERRSIG').length > 0) return { ok: false, reason: 'signature could not be checked' };
  const valid = fields('VALIDSIG');
  if (valid.length !== 1) return { ok: false, reason: `expected one VALIDSIG, got ${valid.length}` };
  const v = valid[0];
  const primary = (v[v.length - 1] ?? '').toUpperCase();
  if (primary !== expected) return { ok: false, reason: `signed by ${primary || 'unknown key'}, expected ${expected}` };
  if (fields('GOODSIG').length === 0 && fields('EXPKEYSIG').length === 0) return { ok: false, reason: 'no GOODSIG/EXPKEYSIG line' };
  const signedAt = Number(v[2]);
  const expiries = fields('KEYEXPIRED').map((f) => Number(f[0])).filter((n) => Number.isFinite(n));
  if (expiries.length > 0) {
    const expiredAt = Math.min(...expiries);
    if (!(signedAt < expiredAt)) return { ok: false, reason: 'signature made after the key expired' };
  }
  return { ok: true, signedAt, primary };
}

/** Pins that are missing from, or differ from, the signed manifest. */
export function comparePins(pins, expected) {
  const problems = [];
  for (const [key, want] of Object.entries(expected)) {
    const have = pins[key];
    if (have === undefined) problems.push(`${key}: not pinned (manifest has ${want})`);
    else if (have.toLowerCase() !== want) problems.push(`${key}: pinned ${have}, signed manifest says ${want}`);
  }
  for (const key of Object.keys(pins)) if (!(key in expected)) problems.push(`${key}: pinned but not in the signed manifest`);
  return problems;
}

/** Hashes the signed manifest gives for each pin key. Throws if a platform is missing. */
export function expectedHashes(manifest, table, tag, prefix = '') {
  const out = {};
  for (const [key, name] of Object.entries(table)) {
    const file = `${prefix}${name(tag)}`;
    const sha = manifest.get(file);
    if (sha === undefined) throw new Error(`signed manifest has no entry for ${file}`);
    out[key] = sha;
  }
  return out;
}

/** Version + per-triple hashes pinned in scripts/fetch-waved.mjs (the source is the pin). */
export function readWavedPins(source) {
  const version = /const PINNED_WAVES_VERSION = '([^']+)';/.exec(source)?.[1];
  const block = /const WAVES_SHA256 = \{([\s\S]*?)\};/.exec(source)?.[1];
  if (version === undefined || block === undefined) throw new Error('fetch-waved.mjs: pin block not found');
  const sha256 = {};
  for (const m of block.matchAll(/'([^']+)':\s*'([0-9a-fA-F]{64})'/g)) sha256[m[1]] = m[2];
  return { tag: `v${version}`, sha256 };
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function gpg(home, args) {
  const r = spawnSync('gpg', ['--homedir', home, '--batch', '--no-tty', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`gpg: ${r.error.message} (is gpg installed?)`);
  return r;
}

/**
 * Checks one detached signature with gpg, in a fresh keyring under `workDir`
 * that holds only `signer`'s committed key, so a signature can only count for
 * the signer whose file name it carries.
 */
export function verifySignatureFile(signer, fingerprint, sigPath, manifestPath, workDir) {
  const home = mkdtempSync(path.join(workDir, `gnupg-${signer}-`));
  const imported = gpg(home, ['--import', path.join(keysDir, `${signer}.asc`)]);
  if (imported.status !== 0) throw new Error(`could not import ${signer}.asc: ${imported.stderr}`);
  const r = gpg(home, ['--status-fd', '1', '--verify', sigPath, manifestPath]);
  // The status lines are authoritative: gpg's exit code alone cannot tell
  // a good signature by an expired key from one by the wrong key.
  return evaluateGpgStatus(r.stdout, fingerprint);
}

/** Downloads and verifies a release manifest. Returns the parsed manifest and the signers that verified. */
export async function verifyManifest(component, tag) {
  const trust = JSON.parse(readFileSync(path.join(keysDir, 'signers.json'), 'utf8'));
  const rel = trust.releases[component];
  if (rel === undefined) throw new Error(`no trust policy for ${component}`);
  const base = `https://github.com/${rel.repo}/releases/download/${tag}`;
  const manifestName = `manifest-${tag}.txt`;
  const manifestBytes = await download(`${base}/${manifestName}`);
  if (manifestBytes === null) throw new Error(`${rel.repo} ${tag} has no ${manifestName}`);

  const work = mkdtempSync(path.join(tmpdir(), 'sovereign-verify-'));
  const verified = [];
  try {
    const manifestPath = path.join(work, manifestName);
    writeFileSync(manifestPath, manifestBytes);
    for (const signer of rel.signers) {
      const fingerprint = trust.signers[signer];
      if (fingerprint === undefined) throw new Error(`signer ${signer} has no pinned fingerprint`);
      const sig = await download(`${base}/manifest-${signer}-${tag}.sig`);
      if (sig === null) {
        console.log(`  ${signer}: no signature on this release`);
        continue;
      }
      const sigPath = path.join(work, `manifest-${signer}-${tag}.sig`);
      writeFileSync(sigPath, sig);
      const verdict = verifySignatureFile(signer, fingerprint, sigPath, manifestPath, work);
      if (!verdict.ok) {
        console.log(`  ${signer}: REJECTED (${verdict.reason})`);
        continue;
      }
      console.log(`  ${signer}: good signature by ${fingerprint}, made ${new Date(verdict.signedAt * 1000).toISOString()}`);
      verified.push(signer);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (verified.length < rel.minSignatures) {
    throw new Error(`${rel.repo} ${tag}: ${verified.length} trusted signature(s), need ${rel.minSignatures}`);
  }
  return { manifest: parseManifest(manifestBytes.toString('utf8')), verified };
}

async function main() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const component = process.argv[2];
  const lockPath = path.join(repoRoot, 'sidecars.lock.json');

  if (component === 'litd') {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const tag = arg('tag') ?? lock.litd.tag;
    console.log(`litd ${tag}: verifying ${lock.litd.repo} manifest signatures`);
    const { manifest, verified } = await verifyManifest('litd', tag);
    const expected = expectedHashes(manifest, LITD_ASSETS, tag, `${lock.litd.assetPrefix}-`);
    if (process.argv.includes('--write-lock')) {
      const bundled = arg('bundled');
      if (tag !== lock.litd.tag && bundled === undefined) throw new Error('--bundled="…" is required when the tag changes');
      const next = {
        ...lock,
        $comment: `Pinned sidecar binaries. SHA256 values are copied verbatim from the signed release manifest (manifest-${tag}.txt, signature manifest-${verified.join('/')}-${tag}.sig verified against scripts/release-keys by scripts/verify-release.mjs) of ${lock.litd.repo} ${tag}. Keys are \`\${process.platform}-\${process.arch}\`. Re-pin via: node scripts/verify-release.mjs litd --tag=<tag> --write-lock --bundled="…" — never add an unverified hash.`,
        litd: { ...lock.litd, tag, bundledUpstream: bundled ?? lock.litd.bundledUpstream, sha256: expected },
      };
      writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`wrote sidecars.lock.json for ${tag}`);
      return;
    }
    if (tag !== lock.litd.tag) {
      console.log(`signed hashes for litd ${tag} (pinned: ${lock.litd.tag}); add --write-lock to re-pin:`);
      for (const [key, sha] of Object.entries(expected)) console.log(`  "${key}": "${sha}"`);
      return;
    }
    const problems = comparePins(lock.litd.sha256, expected);
    if (problems.length > 0) throw new Error(`sidecars.lock.json does not match the signed manifest:\n  ${problems.join('\n  ')}`);
    console.log(`sidecars.lock.json: all ${Object.keys(expected).length} litd ${tag} hashes match the signed manifest`);
    return;
  }

  if (component === 'waved') {
    const pins = readWavedPins(readFileSync(path.join(repoRoot, 'scripts/fetch-waved.mjs'), 'utf8'));
    const tag = arg('tag') ?? pins.tag;
    console.log(`waved ${tag}: verifying lightninglabs/wavelength manifest signatures`);
    const { manifest } = await verifyManifest('waved', tag);
    const expected = expectedHashes(manifest, WAVED_BINARIES, tag);
    if (tag !== pins.tag) {
      console.log(`signed hashes for waved ${tag} (pinned: ${pins.tag}):`);
      for (const [triple, sha] of Object.entries(expected)) console.log(`  '${triple}': '${sha}',`);
      return;
    }
    const problems = comparePins(pins.sha256, expected);
    if (problems.length > 0) throw new Error(`fetch-waved.mjs does not match the signed manifest:\n  ${problems.join('\n  ')}`);
    console.log(`fetch-waved.mjs: all ${Object.keys(expected).length} waved ${tag} hashes match the signed manifest`);
    return;
  }

  console.error('usage: verify-release.mjs <litd|waved> [--tag=<tag>] [--write-lock --bundled="…"]');
  process.exit(2);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`verify-release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
