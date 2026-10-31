/**
 * Drill evidence recorder.
 *
 * Every drill records its steps (what was wiped, what was restored, what was
 * observed) into an append-only JSONL file, and the suite renders
 * docs/TEST_RESULTS.md from that record. The rendered file is the
 * release-blocking evidence: a wallet build is releasable only when every
 * drill in it is green in CI.
 *
 * Vitest runs drill files sequentially but each file gets its own module
 * instance, so records are shared through the JSONL file, not module state.
 * Every file's afterAll re-renders the doc from the FULL record — the last
 * writer therefore publishes complete results.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');

/** Append-only record file — cleared by the suite's test:integration script. */
export const RESULTS_JSONL =
  process.env['SOVEREIGN_RECOVERY_RESULTS_JSONL'] ?? join(PKG_DIR, 'results', 'drill-results.jsonl');

/** The rendered, committed evidence document. */
export const TEST_RESULTS_MD =
  process.env['SOVEREIGN_TEST_RESULTS_MD'] ?? join(REPO_ROOT, 'docs', 'TEST_RESULTS.md');

export interface DrillStep {
  readonly step: string;
  readonly detail: string;
}

export interface DrillRecord {
  readonly drillId: string;
  readonly title: string;
  readonly result: 'pass' | 'fail';
  readonly environment: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly DrillStep[];
  readonly error?: string;
}

/** One drill run. Created by `runDrill`, stepped by the drill body. */
export class Drill {
  private readonly steps: DrillStep[] = [];
  private readonly startedAt = new Date().toISOString();

  constructor(
    readonly drillId: string,
    readonly title: string,
    readonly environment: string,
  ) {}

  /** Records one evidence step. Numbered automatically in drill order. */
  step(detail: string): void {
    this.steps.push({ step: `${this.steps.length + 1}`, detail });
  }

  finish(result: 'pass' | 'fail', error?: unknown): DrillRecord {
    const record: DrillRecord = {
      drillId: this.drillId,
      title: this.title,
      result,
      environment: this.environment,
      startedAt: this.startedAt,
      durationMs: Date.now() - Date.parse(this.startedAt) || 0,
      steps: this.steps,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    };
    mkdirSync(dirname(RESULTS_JSONL), { recursive: true });
    appendFileSync(RESULTS_JSONL, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

/**
 * Runs one drill body as the drill itself: a pass records evidence; a failure
 * records the error and rethrows so the test (and CI) fails loudly.
 */
export async function runDrill(
  drillId: string,
  title: string,
  environment: string,
  body: (d: Drill) => Promise<void>,
): Promise<void> {
  const d = new Drill(drillId, title, environment);
  try {
    await body(d);
    d.finish('pass');
  } catch (err) {
    d.finish('fail', err);
    throw err;
  }
}

/** Reads every recorded drill result (drills that ran, in run order). */
export function readRecords(): DrillRecord[] {
  if (!existsSync(RESULTS_JSONL)) return [];
  return readFileSync(RESULTS_JSONL, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DrillRecord);
}

const RESULTS_START_MARKER = '<!-- recovery-results:start -->';
const HEAD_TEMPLATE = `# TEST_RESULTS — Recovery drills (release-blocking)

Every wallet release requires a green run of the dedicated recovery drill suite
(\`harness/recovery\`) in CI. The five drills exercise the recovery paths the spec
marks release-blocking, each in a disposable regtest environment, and render
their evidence into this file.

Run locally with Docker + a fetched litd sidecar (\`pnpm sidecar:fetch\`):

\`\`\`sh
pnpm --filter @sovereign/harness-recovery test:integration
\`\`\`

The suite renders the results table below on every run. Regtest/signet only —
the drills are destructive by design (they wipe node data dirs) and guarded by
an on-node chain assertion.

Drills:

1. **LND aezeed + SCB restore** — capture a wallet's seed and static channel
   backup, wipe the node, restore from seed + SCB, force-close the restored
   channel with the peer down, and watch the funds return on-chain.
2. **Wavelength seed restore before VTXO batch expiry** — restore the seed on a
   fresh daemon before expiry; then the operator-unreachable fallback: the
   operator-side scan fails, the wallet's own encrypted backup rebuilds VTXO
   state, and the unilateral exit carries the funds on-chain.
3. **Taproot asset backup restore** — the LND seed alone restores no asset
   state; the exported tapd wallet backup must import and the proofs must
   re-verify on-chain.
4. **Interrupted-payment recovery** — payment intents persisted in-flight
   before dispatch are reconciled against the real LND on restart. A settled
   payment is recognized and never re-dispatched; a payment that never reached
   the backend returns to authorized for one safe, re-signed retry.
5. **Two LND nodes, one seed** — initializing two live nodes from the same
   seed yields identical identity keys, and the wallet-core identity guard
   refuses the second registration before funds can be double-spent.
`;

/** Renders docs/TEST_RESULTS.md from the full JSONL record (last writer wins). */
export function renderTestResults(): void {
  const records = readRecords();
  const lines: string[] = [
    RESULTS_START_MARKER,
    '',
    `Rendered: ${new Date().toISOString()} · drills recorded: ${records.length}`,
    '',
    '| Drill | Title | Result | Environment | Duration | Steps |',
    '| --- | --- | --- | --- | --- | --- |',
    ...records.map(
      (r) =>
        `| \`${r.drillId}\` | ${r.title} | ${r.result === 'pass' ? '✅ pass' : '❌ FAIL'} | ${r.environment} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.steps.length} |`,
    ),
    '',
  ];

  for (const r of records) {
    lines.push(`### ${r.drillId} — ${r.title}`, '', `Result: **${r.result}** (environment: ${r.environment})`, '');
    for (const s of r.steps) {
      lines.push(`${s.step}. ${s.detail}`);
    }
    if (r.error !== undefined) {
      lines.push('', `> Error: ${r.error}`);
    }
    lines.push('');
  }

  const head = existsSync(TEST_RESULTS_MD)
    ? readFileSync(TEST_RESULTS_MD, 'utf8').split(RESULTS_START_MARKER)[0]
    : HEAD_TEMPLATE;
  writeFileSync(TEST_RESULTS_MD, head + lines.join('\n'), 'utf8');
}
