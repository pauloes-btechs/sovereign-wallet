#!/usr/bin/env node
/**
 * Download pinned sidecar binaries and verify them against sidecars.lock.json.
 *
 * The SHA256 hashes in the lock file come from the upstream SIGNED release
 * manifest (manifest-<tag>.txt, published with .sig/.ots) — this script never
 * trusts a hash it did not read from the lock file. A mismatch is a hard
 * failure: the binary is never extracted or bundled.
 *
 * Output layout is what Tauri 2 `bundle.externalBin` expects:
 *   apps/desktop/src-tauri/binaries/litd-<tauri-triple>[.exe]
 *
 * Usage:
 *   node scripts/fetch-sidecars.mjs                    # fetch for the current platform
 *   node scripts/fetch-sidecars.mjs --all              # fetch every platform in the lock
 *   node scripts/fetch-sidecars.mjs --triple=<triple>  # fetch for one Tauri target
 *                                                      # (matches the desktop-artifacts
 *                                                      # job matrix on CI runners)
 *
 * Platform notes: .tar.gz extraction uses tar(1); .zip (Windows asset)
 * extraction needs bsdtar (default on macOS, built into Windows 10+); GNU tar
 * on Linux cannot read zip — CI only needs the linux asset.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(path.join(repoRoot, 'sidecars.lock.json'), 'utf8'));
const outDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');

/** Current platform key -> Tauri triple + upstream asset identifiers. */
const PLATFORMS = {
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', assetOs: 'linux-amd64', ext: '' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', assetOs: 'linux-arm64', ext: '' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', assetOs: 'darwin-amd64', ext: '' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', assetOs: 'darwin-arm64', ext: '' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', assetOs: 'windows-amd64', ext: '.exe' },
};

function currentPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!(key in PLATFORMS)) {
    throw new Error(`Unsupported platform ${key}: no pinned sidecar in sidecars.lock.json`);
  }
  return key;
}

/** Tauri triple -> platform key, for jobs that target a specific triple. */
const TRIPLE_TO_KEY = Object.fromEntries(
  Object.entries(PLATFORMS).map(([key, platform]) => [platform.triple, key]),
);

function platformKeyFromTriple(triple) {
  const key = TRIPLE_TO_KEY[triple];
  if (key === undefined) {
    throw new Error(`Unknown Tauri triple ${triple}: no pinned sidecar platform matches it`);
  }
  return key;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }
  await pipeline(res.body, createWriteStream(destPath));
}

/** Extract a single named binary from the archive into destDir, return its path. */
function extractBinary(archivePath, memberPath, destDir) {
  const list = spawnSync('tar', ['-tf', archivePath], { encoding: 'utf8' });
  if (list.status !== 0) {
    throw new Error(`Cannot list archive ${archivePath}: ${list.stderr}`);
  }
  const member = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l === memberPath);
  if (!member) {
    throw new Error(`Archive ${archivePath} does not contain ${memberPath}`);
  }
  const res = spawnSync('tar', ['-xf', archivePath, '-C', destDir, member], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`Extraction failed (zip needs bsdtar, GNU tar cannot read zip): ${res.stderr}`);
  }
  return path.join(destDir, member);
}

async function fetchSidecar(platformKey) {
  const platform = PLATFORMS[platformKey];
  const pkg = lock.litd;
  const ext = platform.ext === '.exe' ? '.zip' : '.tar.gz';
  const assetName = `${pkg.assetPrefix}-${platform.assetOs}-${pkg.tag}${ext}`;
  const expected = pkg.sha256[platformKey];
  if (!expected) {
    throw new Error(`No pinned sha256 for ${platformKey} in sidecars.lock.json`);
  }
  const url = `https://github.com/${pkg.repo}/releases/download/${pkg.tag}/${assetName}`;
  const workDir = await mkdtemp(path.join(tmpdir(), 'sovereign-sidecar-'));
  try {
    console.log(`[${platformKey}] downloading ${url}`);
    const archivePath = path.join(workDir, assetName);
    await download(url, archivePath);

    const actual = await sha256File(archivePath);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}. ` +
          'Refusing to bundle — verify the release manifest and update sidecars.lock.json.',
      );
    }
    console.log(`[${platformKey}] sha256 verified: ${actual}`);

    const innerDir = `${pkg.assetPrefix}-${platform.assetOs}-${pkg.tag}`;
    const memberPath = path.posix.join(innerDir, `litd${platform.ext}`);
    const extracted = extractBinary(archivePath, memberPath, workDir);

    await mkdir(outDir, { recursive: true });
    const target = path.join(outDir, `litd-${platform.triple}${platform.ext}`);
    // copyFile (not rename): tmpdir may be on a different filesystem.
    await rm(target, { force: true });
    await copyFile(extracted, target);
    await rm(extracted, { force: true });
    if (platform.ext === '') {
      await chmod(target, 0o755);
    }
    console.log(`[${platformKey}] wrote ${target}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const tripleArg = process.argv.find((arg) => arg.startsWith('--triple='));
const targets = tripleArg
  ? [platformKeyFromTriple(tripleArg.slice('--triple='.length))]
  : process.argv.includes('--all')
    ? Object.keys(PLATFORMS)
    : [currentPlatformKey()];
for (const key of targets) {
  await fetchSidecar(key);
}
console.log(`done (${targets.length} platform${targets.length === 1 ? '' : 's'})`);
