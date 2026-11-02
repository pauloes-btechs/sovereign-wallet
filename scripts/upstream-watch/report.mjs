#!/usr/bin/env node
/**
 * Assembles the weekly upstream-watch GitHub issue from the job outputs.
 *
 *   node scripts/upstream-watch/report.mjs --dir=<artifacts dir> --out=issue.md
 *
 * Reads (all optional except api/report.json):
 *   <dir>/api/report.json, <dir>/api/report.md        check.mjs output
 *   <dir>/api/results.json                            { typecheck, unitTests } after regenerating clients
 *   <dir>/e2e/fixture-diff.md, <dir>/e2e/results.json { e2e }
 *   <dir>/integration/results.json                    { integration }
 *   <dir>/waved/results.json                          { waved }
 * Env: RUN_URL (link to the workflow run).
 * Prints `title=` and `status=` lines for $GITHUB_OUTPUT.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = arg('dir') ?? 'upstream-watch-artifacts';
const out = arg('out') ?? 'issue.md';
const read = (rel) => (existsSync(path.join(dir, rel)) ? readFileSync(path.join(dir, rel), 'utf8') : null);
const readJson = (rel) => {
  const t = read(rel);
  return t === null ? null : JSON.parse(t);
};

const api = readJson('api/report.json');
if (api === null) throw new Error(`${dir}/api/report.json missing`);
const results = {
  ...readJson('api/results.json'),
  ...readJson('e2e/results.json'),
  ...readJson('integration/results.json'),
  ...readJson('waved/results.json'),
};

const ICON = { success: '✅ pass', failure: '❌ fail', cancelled: '⏹ cancelled', skipped: '— skipped' };
const label = (v) => (v === undefined ? '— not run' : (ICON[v] ?? v));

const failed = Object.values(results).some((v) => v === 'failure');
const breaking = api.summary.breaking;
const status = failed ? 'broken' : breaking > 0 ? 'api-breaking' : 'compatible';
const verdict = {
  broken: '❌ **Something breaks on the new releases.** See the failing checks below.',
  'api-breaking': '⚠️ **Breaking API changes upstream**, but everything we exercise still passes. Check the listed fields before bumping.',
  compatible: '✅ **Compatible.** Our code, tests, and desktop UI work unchanged on the new releases. Safe to bump the pins.',
}[status];

const lnd = api.latest.lnd;
const md = [];
md.push(`Weekly check of Lightning Labs releases against Sovereign Wallet ([run](${process.env.RUN_URL ?? '#'})).`);
md.push('');
md.push(verdict);
md.push('');
md.push(`Tested: **litd ${api.targetLitd}** (sidecar + harness image) with **LND ${lnd}** harness peers, against our pins (litd ${api.pins.litd}, LND ${api.pins.lndImage}).`);
md.push('');
md.push('| Check on the new releases | Result |');
md.push('| --- | --- |');
md.push(`| Generated clients regenerated from new protos + \`pnpm typecheck\` | ${label(results.typecheck)} |`);
md.push(`| Unit tests (\`pnpm test\`) on regenerated clients | ${label(results.unitTests)} |`);
md.push(`| Integration suite (\`pnpm test:integration\`, real litd/LND/Loop/Pool/tapd on regtest) | ${label(results.integration)} |`);
md.push(`| Desktop node-mode e2e (real UI → bridge → litd) + re-recorded demo | ${label(results.e2e)} |`);
md.push(`| waved ${api.latest.waved} real-daemon tests (boot, health, wallet persistence across upgrade) | ${label(results.waved)} |`);
md.push('');
md.push(read('api/report.md') ?? '_API report missing._');
md.push('');
md.push(read('e2e/fixture-diff.md') ?? '### Desktop UI responses\n\n_No new recording (e2e did not run or failed before recording)._');
md.push('');
md.push('### To bump');
md.push('');
md.push(
  [
    `1. Download the \`upstream-watch-demo-fixture\` artifact from the run and replace \`apps/desktop/src/demo/fixtures/modeb.json\` (refreshes the hosted /desktop/ demo).`,
    `2. Update \`sidecars.lock.json\` to ${api.targetLitd}, verifying hashes against the **signed** \`manifest-${api.targetLitd}.txt\` (this run used the unsigned manifest for testing only).`,
    '3. Update the image tags in `harness/regtest/docker-compose.yml` and, if protos changed, re-vendor them (`node scripts/upstream-watch/check.mjs --write-protos`) and run `pnpm --filter @sovereign/litd-proto generate`.',
    '4. Open a PR; CI runs the full suite, including the recovery drills.',
  ].join('\n'),
);
md.push('');
md.push('<sub>Opened by `.github/workflows/upstream-watch.yml`. Close this issue once the pins are bumped; the next run opens a new one if newer releases appear.</sub>');

writeFileSync(out, `${md.join('\n')}\n`);
const title = `Upstream watch: litd ${api.targetLitd}, LND ${lnd} (pinned litd ${api.pins.litd})`;
console.log(`title=${title}`);
console.log(`status=${status}`);
