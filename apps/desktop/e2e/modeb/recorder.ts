/**
 * Bridge traffic recorder for the replayed /desktop/ demo.
 *
 * When SOVEREIGN_RECORD_DIR is set, every response the UI receives from the
 * litd bridge (through the vite same-origin /modeb proxy) is appended to
 * `<dir>/modeb-traffic.jsonl`. Recordings are therefore exactly what the
 * real desktop UI got from the real bridge → real litd/LND/Faraday on
 * regtest. `scripts/demo/build-fixtures.mjs` turns them into the demo's
 * replay fixtures.
 *
 * Never recorded: the wallet setup routes (/wallet/*: seed words, unlock
 * password), /livez, request bodies, and request headers (bearer token).
 * Unset → no-op, so the normal e2e run is unchanged.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const PROXY_PREFIX = '/modeb';
const EXCLUDED = [/^\/wallet\//, /^\/livez$/];

export interface RecordedExchange {
  readonly seq: number;
  readonly test: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

let seq = 0;

export function attachRecorder(page: Page, testTitle: string): void {
  const dir = process.env['SOVEREIGN_RECORD_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'modeb-traffic.jsonl');

  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith(`${PROXY_PREFIX}/`)) return;
    const path = url.pathname.slice(PROXY_PREFIX.length);
    if (EXCLUDED.some((re) => re.test(path))) return;
    const method = response.request().method();
    void response
      .text()
      .then((text) => {
        let body: unknown = null;
        try {
          body = text === '' ? null : JSON.parse(text);
        } catch {
          return; // non-JSON (proxy error page) — not a bridge answer
        }
        const entry: RecordedExchange = { seq: seq++, test: testTitle, method, path, status: response.status(), body };
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
      })
      .catch(() => undefined); // page closed mid-read — skip
  });
}
