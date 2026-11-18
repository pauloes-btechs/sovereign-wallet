#!/usr/bin/env node
/**
 * Downloads the pinned `waved` daemon binary for a Tauri target triple,
 * verifies it against the upstream release's per-binary SHA256 hashes
 * (pinned below, taken from the SIGNED release manifest of v0.2.1), and
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

const PINNED_WAVES_VERSION = '0.2.1';
// SOVEREIGN_WAVED_VERSION + SOVEREIGN_WAVED_SHA256 test another release (the
// weekly upstream watch reads the hash from that release's manifest). Both
// must be set together; shipping builds never set them.
const WAVES_VERSION = process.env.SOVEREIGN_WAVED_VERSION ?? PINNED_WAVES_VERSION;
const WAVES_REPO = 'lightninglabs/wavelength';
// Pinned from the SIGNED release manifest (manifest-v0.2.1.txt, signatures by
// bhandras 9FC6B0BF…094198D8 + sputn1ck 4DC23555…81A5F0E4, keys unchanged
// since v0.2.0), verified 2026-11-16. Keyed by Tauri target triple.
const WAVES_SHA256 = {
  'x86_64-unknown-linux-gnu': 'f6cec36bcd3fde27c182ad37edfc5913cea3802896bfe8177eb3d312adbe59be',
  'aarch64-unknown-linux-gnu': '23679b8c97c58af064847449366b5f9ef5c77fbb82e738a3b396c2a6bb5be6bd',
  'x86_64-pc-windows-msvc': '3fa4bf6452d54fb0417b4350607b5433b7416b727041a30adbbde90a5a58c69d',
  'x86_64-apple-darwin': '4102d498e238b7144faf7af9cb02adeaee3c42cc220a7259104da4fc64e5bfc4',
  'aarch64-apple-darwin': '1f9180f4a09080efe5b613ed2551fa91de6f84f84ced439f8e844ea6388e9b6b',
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
if ((process.env.SOVEREIGN_WAVED_VERSION === undefined) !== (process.env.SOVEREIGN_WAVED_SHA256 === undefined)) {
  console.error('fetch-waved: set SOVEREIGN_WAVED_VERSION and SOVEREIGN_WAVED_SHA256 together');
  process.exit(2);
}
const expectedHash = process.env.SOVEREIGN_WAVED_SHA256 ?? WAVES_SHA256[triple];
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
