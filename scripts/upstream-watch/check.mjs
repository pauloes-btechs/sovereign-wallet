#!/usr/bin/env node
/**
 * Lightning Labs upstream watch — API surface check.
 *
 *   node scripts/upstream-watch/check.mjs [--litd=vX.Y.Z] [--out=upstream-watch-out] [--write-protos]
 *
 * 1. Reads what this repo pins (litd sidecar, harness images, waved).
 * 2. Finds the newest Lightning Labs releases (public git tags).
 * 3. Resolves what the target litd bundles (LND, tapd, Loop, Pool, Faraday)
 *    from litd's own go.mod — the same way the vendored protos were pinned.
 * 4. Fetches every vendored .proto at the target revisions and diffs it
 *    semantically against the vendored copy: removed / renamed / retyped
 *    fields, RPCs, enums (breaking) and new ones (additive). Breaking field
 *    changes are cross-referenced with our own source.
 * 5. Writes report.json + report.md to --out. --write-protos also replaces
 *    the vendored protos with the target versions (imports flattened) so a
 *    follow-up `pnpm --filter @sovereign/litd-proto generate && pnpm typecheck`
 *    shows exactly which of our call sites stop compiling.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareVersions,
  currentPins,
  diffModels,
  fetchRaw,
  findUsages,
  flattenImports,
  latestRelease,
  litdBundle,
  protoModel,
  protosDir,
  readJson,
  releasesSince,
} from './lib.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const outDir = path.resolve(arg('out', 'upstream-watch-out'));
const writeProtos = process.argv.includes('--write-protos');

const map = readJson('packages/litd-proto/protos/upstream.json');
const pins = currentPins();

const latest = {
  litd: latestRelease(map.litd.repo),
  lnd: latestRelease('lightningnetwork/lnd'),
  waved: latestRelease('lightninglabs/wavelength'),
  aperture: latestRelease('lightninglabs/aperture'),
};
const targetLitd = arg('litd', latest.litd);

// The Wavelength TypeScript SDK (Mode A) ships on npm, not as a git tag.
const sdkName = '@lightninglabs/wavelength-core';
const sdkPinned = readJson('services/wavelength-adapter/package.json').dependencies?.[sdkName];
let sdkVersions = [];
try {
  sdkVersions = JSON.parse(execFileSync('npm', ['view', sdkName, 'versions', '--json'], { encoding: 'utf8', timeout: 60_000 }));
} catch {
  sdkVersions = [];
}
const sdkFinals = sdkVersions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
const sdkLatest = sdkFinals.at(-1) ?? sdkPinned;
const sdkNewer = sdkFinals.filter((v) => compareVersions(`v${v}`, `v${sdkPinned}`) > 0);

const components = [
  { name: 'litd (lightning-terminal) sidecar', pinned: pins.litd, latest: latest.litd, newer: releasesSince(map.litd.repo, pins.litd), where: 'sidecars.lock.json' },
  { name: 'litd harness image', pinned: pins.litdImage, latest: latest.litd, newer: releasesSince(map.litd.repo, pins.litdImage), where: 'harness/regtest/docker-compose.yml' },
  { name: 'LND harness image (peers)', pinned: pins.lndImage, latest: latest.lnd, newer: releasesSince('lightningnetwork/lnd', pins.lndImage), where: 'harness/regtest/docker-compose.yml' },
  { name: 'waved (Wavelength)', pinned: pins.waved, latest: latest.waved, newer: releasesSince('lightninglabs/wavelength', pins.waved), where: 'scripts/fetch-waved.mjs' },
  { name: 'Wavelength SDK (npm)', pinned: sdkPinned, latest: sdkLatest, newer: sdkNewer, where: 'services/wavelength-adapter/package.json' },
  { name: 'aperture harness image', pinned: pins.apertureImage, latest: latest.aperture, newer: releasesSince('lightninglabs/aperture', pins.apertureImage), where: 'harness/regtest/docker-compose.yml' },
];

const pinnedBundle = await litdBundle(pins.litd);
const targetBundle = await litdBundle(targetLitd);
const bundled = Object.keys(map.modules).map((mod) => ({
  module: mod,
  pinned: pinnedBundle[mod].version,
  target: targetBundle[mod].version,
  changed: pinnedBundle[mod].ref !== targetBundle[mod].ref,
}));

const vendoredNames = Object.keys(map.files);
const files = [];
for (const [file, src] of Object.entries(map.files)) {
  const repo = map.modules[src.module].repo;
  const vendored = readFileSync(path.join(protosDir, file), 'utf8');
  const entry = { file, upstream: `${repo}/${src.path}`, pinnedRef: pinnedBundle[src.module].ref, targetRef: targetBundle[src.module].ref };
  try {
    const pinnedText = await fetchRaw(repo, entry.pinnedRef, src.path);
    const strip = (t) => t.split('\n').filter((l) => !l.startsWith('import ')).join('\n');
    entry.vendoredMatchesPin = strip(pinnedText) === strip(vendored);
    const targetText = entry.targetRef === entry.pinnedRef ? pinnedText : await fetchRaw(repo, entry.targetRef, src.path);
    entry.textChanged = strip(targetText) !== strip(vendored);
    entry.changes = entry.textChanged ? diffModels(protoModel(vendored, file), protoModel(targetText, file)) : [];
    for (const c of entry.changes) {
      if (c.severity === 'breaking' && c.field !== undefined) c.usedAt = findUsages(c.field);
    }
    if (writeProtos && entry.textChanged) {
      const { text, missing } = flattenImports(targetText, vendoredNames);
      entry.newImports = missing;
      writeFileSync(path.join(protosDir, file), text);
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    entry.changes = [];
  }
  files.push(entry);
}

const all = files.flatMap((f) => f.changes.map((c) => ({ ...c, file: f.file })));
const breaking = all.filter((c) => c.severity === 'breaking');
const additive = all.filter((c) => c.severity === 'additive');
const report = {
  generatedAt: new Date().toISOString(),
  targetLitd,
  pins,
  latest,
  components,
  bundled,
  files,
  summary: {
    newReleases: components.filter((c) => c.newer.length > 0).length,
    breaking: breaking.length,
    breakingUsedByUs: breaking.filter((c) => (c.usedAt ?? []).length > 0).length,
    additive: additive.length,
    fileErrors: files.filter((f) => f.error !== undefined).length,
    vendoredDrift: files.filter((f) => f.vendoredMatchesPin === false).map((f) => f.file),
  },
};

// ——— markdown ———
const md = [];
const s = report.summary;
md.push(`### API surface: litd ${pins.litd} → ${targetLitd}`);
md.push('');
md.push(
  s.breaking === 0
    ? `No breaking proto changes. ${s.additive} additive change(s).`
    : `**${s.breaking} breaking proto change(s)** (${s.breakingUsedByUs} on field names our litd-facing code references), ${s.additive} additive.`,
);
md.push('');
md.push('| Component | Pinned | Latest | Newer releases | Pinned in |');
md.push('| --- | --- | --- | --- | --- |');
for (const c of components) {
  md.push(`| ${c.name} | \`${c.pinned}\` | \`${c.latest}\` | ${c.newer.length === 0 ? 'up to date' : c.newer.map((t) => `\`${t}\``).join(', ')} | \`${c.where}\` |`);
}
md.push('');
md.push(`**Bundled in litd ${targetLitd}** (from its go.mod):`);
md.push('');
md.push('| Module | Pinned build | Target build |');
md.push('| --- | --- | --- |');
for (const b of bundled) md.push(`| \`${b.module.replace('github.com/', '')}\` | \`${b.pinned}\` | ${b.changed ? '**' : ''}\`${b.target}\`${b.changed ? '**' : ''} |`);
md.push('');
md.push('| Vendored proto | Upstream | Breaking | Additive |');
md.push('| --- | --- | --- | --- |');
for (const f of files) {
  const nb = f.changes.filter((c) => c.severity === 'breaking').length;
  const na = f.changes.filter((c) => c.severity === 'additive').length;
  const note = f.error ? `⚠️ ${f.error}` : !f.textChanged ? 'unchanged' : nb + na === 0 ? 'comments/formatting only' : '';
  md.push(`| \`${f.file}\` | \`${f.upstream}\` | ${nb || ''} | ${na || ''} ${note ? `${note}` : ''} |`);
}
if (breaking.length > 0) {
  md.push('');
  md.push('#### Breaking changes');
  md.push('');
  for (const c of breaking.slice(0, 80)) {
    const used = (c.usedAt ?? []).length > 0 ? ` · **name appears in:** ${c.usedAt.map((u) => `\`${u}\``).join(', ')}` : '';
    md.push(`- \`${c.file}\` **${c.kind}** \`${c.name}\`: ${c.detail}${used}`);
  }
  if (breaking.length > 80) md.push(`- … ${breaking.length - 80} more in report.json`);
}
if (additive.length > 0) {
  md.push('');
  md.push(`<details><summary>${additive.length} additive change(s)</summary>`);
  md.push('');
  for (const c of additive.slice(0, 150)) md.push(`- \`${c.file}\` ${c.kind} \`${c.name}\`: ${c.detail}`);
  if (additive.length > 150) md.push(`- … ${additive.length - 150} more in report.json`);
  md.push('');
  md.push('</details>');
}
if (s.vendoredDrift.length > 0) {
  md.push('');
  md.push(`⚠️ Vendored protos no longer match their pinned upstream: ${s.vendoredDrift.map((f) => `\`${f}\``).join(', ')}.`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, 'report.md'), `${md.join('\n')}\n`);
console.log(md.slice(0, 3).join('\n'));
console.log(`report → ${path.relative(process.cwd(), outDir)}/report.{md,json}`);
if (process.env.GITHUB_OUTPUT) {
  const newer = components.find((c) => c.name.startsWith('litd (')).newer.length > 0 || compareVersions(targetLitd, pins.litd) > 0;
  const wavedNewer = components.find((c) => c.name.startsWith('waved')).newer.length > 0;
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `target_litd=${targetLitd}\nlatest_lnd=${latest.lnd}\nlatest_waved=${latest.waved}\nhas_updates=${s.newReleases > 0}\nlitd_newer=${newer}\nwaved_newer=${wavedNewer}\nbreaking=${s.breaking}\nprotos_changed=${files.some((f) => f.textChanged)}\n`,
    { flag: 'a' },
  );
}
