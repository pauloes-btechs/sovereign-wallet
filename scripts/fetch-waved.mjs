#!/usr/bin/env node
/**
 * Downloads the pinned `waved` daemon binary for a Tauri target triple,
 * verifies it against the upstream release's per-binary SHA256 hashes
 * (pinned below, taken from the SIGNED release manifest of v0.2.0), and
 * installs it as a Tauri sidecar at apps/desktop/src-tauri/binaries/.
 *
 * Supply-chain posture: the hash pins live in THIS repository, not in the
 * release response — a compromised or swapped upstream asset fails the
 * hash check and the build refuses to proceed. Re-pin = new upstream
 * release reviewed + manifest hashes updated here (see
 * docs/UPSTREAM_INTEGRATIONS.md).
 *
 * Usage: node scripts/fetch-waved.mjs --triple=x86_64-unknown-linux-gnu
 * Adds `--run-smoke` automatically when the triple matches this host.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const WAVES_VERSION = '0.2.0';
const WAVES_REPO = 'lightninglabs/wavelength';
// Pinned from the SIGNED release manifest (manifest-v0.2.0.txt, signatures by
// bhandras + sputn1ck), verified 2026-10-30. Keyed by Tauri target triple.
const WAVES_SHA256 = {
  'x86_64-unknown-linux-gnu': '4874375e7d480126cafbe6b289765147b626cbdf3488ad45600d8497a90501f4',
  'aarch64-unknown-linux-gnu': 'c125f34be8fe2db7e93150d3ee843ab31c0e457759744392dc43ec9351cfa12b',
  'x86_64-pc-windows-msvc': 'fc7182e4fde24f210c814eac2adaf44c93f0ce60004060ef8f11d4bb93751d77',
  'x86_64-apple-darwin': 'a87ae404bf19aec4383250ca4a593a79589a2e87889c55e4e161260871eacc7d',
  'aarch64-apple-darwin': '7c5aa143a82b10450150b0136105543cc33eefff8f498099135cda1087b93094',
};

// Tauri triple → upstream asset base name (wavelength-<asset>-v<version>).
const TRIPLE_TO_ASSET = {
  'x86_64-unknown-linux-gnu': 'wavelength-linux-amd64',
  'aarch64-unknown-linux-gnu': 'wavelength-linux-arm64',
  'x86_64-pc-windows-msvc': 'wavelength-windows-amd64',
  'x86_64-apple-darwin': 'wavelength-darwin-amd64',
  'aarch64-apple-darwin': 'wavelength-darwin-arm64',
};

const triple = (process.argv.find((a) => a.startsWith('--triple=')) ?? '--triple=').split('=')[1];
if (!TRIPLE_TO_ASSET[triple]) {
  console.error(
    `fetch-waved: unknown or missing --triple. Supported: ${Object.keys(TRIPLE_TO_ASSET).join(', ')}`,
  );
  process.exit(2);
}
const expectedHash = WAVES_SHA256[triple];
const assetBase = TRIPLE_TO_ASSET[triple];
const isWindowsTarget = triple.includes('windows');
const archiveName = `${assetBase}-v${WAVES_VERSION}.${isWindowsTarget ? 'zip' : 'tar.gz'}`;
const archiveUrl = `https://github.com/${WAVES_REPO}/releases/download/v${WAVES_VERSION}/${archiveName}`;
const innerDir = `${assetBase}-v${WAVES_VERSION}`;
const wavedName = isWindowsTarget ? 'waved.exe' : 'waved';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binariesDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');
const sidecarPath = path.join(binariesDir, isWindowsTarget ? `waved-${triple}.exe` : `waved-${triple}`);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Extracts the waved binary from the archive into dest. Shells out to tar
 *  (bsdtar reads zip too on macOS/Windows runners; GNU tar needs .tar.gz). */
function extract(archivePath, workDir) {
  const exeRel = path.join(innerDir, wavedName);
  if (isWindowsTarget) {
    // PowerShell Expand-Archive is always present on windows runners.
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${workDir}' -Force`],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error(`Expand-Archive failed (${r.status})`);
  } else {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', workDir, exeRel], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar extraction failed (${r.status})`);
  }
  return path.join(workDir, exeRel);
}

/** Verifies the extracted binary executes and reports the pinned version. */
function versionSmoke(binaryPath) {
  const r = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  console.log(`waved --version → ${out || `(exit ${r.status})`}`);
  if (!out.includes(WAVES_VERSION)) {
    throw new Error(`waved --version did not report ${WAVES_VERSION}`);
  }
}

const workDir = await mkdtemp(path.join(tmpdir(), 'waved-fetch-'));
try {
  console.log(`fetch-waved: ${archiveUrl}`);
  const response = await fetch(archiveUrl, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const archivePath = path.join(workDir, archiveName);
  await writeFile(archivePath, archive);

  const binaryPath = extract(archivePath, workDir);
  const binary = await readFile(binaryPath);

  const actualHash = sha256(binary);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 MISMATCH for waved ${triple}: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log(`fetch-waved: SHA256 verified (${actualHash.slice(0, 16)}…)`);

  await mkdir(binariesDir, { recursive: true });
  await writeFile(sidecarPath, binary);
  if (!isWindowsTarget) await chmod(sidecarPath, 0o755);
  console.log(`fetch-waved: installed ${sidecarPath}`);

  const hostTriple = {
    linux: 'x86_64-unknown-linux-gnu',
    darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    win32: 'x86_64-pc-windows-msvc',
  }[process.platform];
  if (process.argv.includes('--run-smoke') || hostTriple === triple) {
    versionSmoke(binaryPath);
  }
  console.log('fetch-waved: OK');
} finally {
  await rm(workDir, { recursive: true, force: true });
}
