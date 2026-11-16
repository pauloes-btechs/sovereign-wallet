/**
 * Regression tests for issue #44: the LNC integration suite hung for 37
 * minutes because the lnc-web Go/wasm runtime ran inside the vitest worker
 * and could block its event loop, freezing every timeout meant to bound it.
 * IsolatedLncClient moves each client into a child process; these tests pin
 * the guarantees the suite now relies on, using a stub child that
 * reproduces the wedge (a synchronous never-yielding loop).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { IsolatedLncClient } from './integration/lnc-isolated-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(here, 'integration', '__fixtures__', 'stub-lnc-child.mjs');

const started: IsolatedLncClient[] = [];
afterEach(async () => {
  await Promise.allSettled(started.splice(0).map((c) => c.dispose()));
});

async function startStub(mode: string, overrides: { callTimeoutMs?: number; shutdownGraceMs?: number; startTimeoutMs?: number } = {}) {
  const client = await IsolatedLncClient.start({
    label: `stub-${mode}`,
    scriptPath: STUB,
    env: { STUB_MODE: mode },
    onLog: () => {},
    ...overrides,
  });
  started.push(client);
  return client;
}

describe('IsolatedLncClient', () => {
  it('round-trips connect and request, preserving binary fields', async () => {
    const client = await startStub('ok');
    await client.connect({ wasmUrl: 'http://x/lnc.wasm', namespace: 'n', pairingPhrase: 'p', serverHost: 'h:1' });
    const res = await client.request<{ method: string; request: { a: number }; bytes: Uint8Array }>('lnrpc.Lightning.GetInfo', { a: 1 });
    expect(res.method).toBe('lnrpc.Lightning.GetInfo');
    expect(res.request).toEqual({ a: 1 });
    expect(res.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
    await client.dispose();
    expect(client.alive).toBe(false);
    expect(client.child.exitCode).toBe(0);
  });

  it('surfaces a child-side RPC error as a rejection naming the client', async () => {
    const client = await startStub('ok');
    await expect(client.request('fail')).rejects.toThrow(/LNC client stub-ok: permission denied/);
  });

  it('a wedged child fails the call on deadline while the parent event loop keeps running, then is killed', async () => {
    const client = await startStub('wedge-on-request', { callTimeoutMs: 400, shutdownGraceMs: 300 });

    // Parent timers must keep firing while the child spins.
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 50);
    const t0 = Date.now();
    await expect(client.request('lnrpc.Lightning.GetInfo')).rejects.toThrow(
      /lnrpc\.Lightning\.GetInfo did not answer within 400ms .*still running — wasm runtime likely wedged/,
    );
    clearInterval(ticker);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThanOrEqual(4);
    expect(client.alive).toBe(true);

    const d0 = Date.now();
    await client.dispose();
    expect(Date.now() - d0).toBeLessThan(3_000);
    expect(client.alive).toBe(false);
    expect(client.child.signalCode).toBe('SIGKILL');
  });

  it('escalates to SIGKILL when the child ignores shutdown', async () => {
    const client = await startStub('ignore-shutdown', { shutdownGraceMs: 300 });
    await client.dispose();
    expect(client.child.signalCode).toBe('SIGKILL');
  });

  it('rejects pending calls immediately when the child dies, and later calls too', async () => {
    const client = await startStub('crash-on-request', { callTimeoutMs: 10_000 });
    const t0 = Date.now();
    await expect(client.request('lnrpc.Lightning.GetInfo')).rejects.toThrow(/exited \(code=3 signal=null\)/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await expect(client.request('lnrpc.Lightning.GetInfo')).rejects.toThrow(/exited/);
    await client.dispose();
  });

  it('fails start with a clear error when the child never reports ready', async () => {
    await expect(
      IsolatedLncClient.start({
        label: 'never',
        scriptPath: STUB,
        env: { STUB_MODE: 'never-ready' },
        onLog: () => {},
        startTimeoutMs: 300,
        shutdownGraceMs: 300,
      }),
    ).rejects.toThrow(/LNC client never did not report ready within 300ms/);
  });

  it('dispose is idempotent', async () => {
    const client = await startStub('ok');
    await Promise.all([client.dispose(), client.dispose()]);
    await client.dispose();
    expect(client.alive).toBe(false);
  });
});

describe('LNC integration suite wiring (issue #44)', () => {
  const source = readFileSync(path.join(here, 'integration', 'lnc.integration.test.ts'), 'utf8');

  it('never loads lnc-web into the test worker', () => {
    // The wasm runtime may only run inside IsolatedLncClient's child process.
    expect(source).not.toMatch(/['"]@lightninglabs\/lnc-web['"]/);
    expect(source).toMatch(/IsolatedLncClient/);
  });

  it('does not rely on process.exit (vitest workers turn it into a thrown error)', () => {
    expect(source).not.toMatch(/process\.exit\(/);
  });
});
