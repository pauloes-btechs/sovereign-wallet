#!/usr/bin/env node
/**
 * Build the replay fixtures for the hosted /desktop/ demo from a bridge
 * traffic recording (apps/desktop/e2e/modeb/recorder.ts).
 *
 *   node scripts/demo/build-fixtures.mjs \
 *     --in=<dir>/modeb-traffic.jsonl \
 *     --out=apps/desktop/src/demo/fixtures/modeb.json \
 *     [--litd=v0.17.8] [--source="CI regtest harness (bitcoind)"]
 *
 * For every METHOD + path the UI called, the fixture keeps the LAST
 * successful response of the run, so the demo opens on the end state of the
 * scenario: funded wallet, open channel, payments both ways, diagnostics,
 * channel backup. Wallet setup routes are never recorded (seed, password).
 *
 * The output is deterministic for a given recording (sorted keys) so a diff
 * between two recordings shows exactly what changed upstream.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const input = arg('in');
const output = arg('out', path.join(repoRoot, 'apps/desktop/src/demo/fixtures/modeb.json'));
if (input === undefined) {
  console.error('build-fixtures: --in=<modeb-traffic.jsonl> is required');
  process.exit(2);
}
const lock = JSON.parse(readFileSync(path.join(repoRoot, 'sidecars.lock.json'), 'utf8'));
const litdTag = arg('litd', lock.litd.tag);
const source = arg('source', 'regtest');

const lines = readFileSync(input, 'utf8').split('\n').filter((l) => l.trim() !== '');
const exchanges = lines.map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq);
if (exchanges.length === 0) {
  console.error('build-fixtures: recording is empty');
  process.exit(1);
}

/** key → last exchange; successful answers win over failures. */
const byKey = new Map();
for (const ex of exchanges) {
  if (/^\/wallet\//.test(ex.path)) continue; // defense in depth: never ship seed/password routes
  const key = `${ex.method} ${ex.path}`;
  const prev = byKey.get(key);
  const ok = ex.status >= 200 && ex.status < 300;
  const prevOk = prev !== undefined && prev.status >= 200 && prev.status < 300;
  if (prev === undefined || ok || !prevOk) byKey.set(key, ex);
}

const state = byKey.get('GET /state');
if (state === undefined || state.body?.phase !== 'ready') {
  console.error('build-fixtures: recording has no ready GET /state — the scenario did not reach a live wallet');
  process.exit(1);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

const routes = Object.fromEntries(
  [...byKey.keys()].sort().map((key) => {
    const ex = byKey.get(key);
    return [key, { status: ex.status, body: sortKeys(ex.body) }];
  }),
);

const fixture = {
  meta: {
    recordedAt: new Date().toISOString(),
    network: 'regtest',
    source,
    litd: litdTag,
    lnd: state.body.info?.version ?? 'unknown',
    alias: state.body.info?.alias ?? '',
    exchanges: exchanges.length,
  },
  routes,
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`build-fixtures: ${Object.keys(routes).length} routes from ${exchanges.length} exchanges → ${path.relative(process.cwd(), output)}`);
console.log(`  litd ${fixture.meta.litd} · lnd ${fixture.meta.lnd}`);
