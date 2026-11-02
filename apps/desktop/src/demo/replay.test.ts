import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeHttpError } from '../modeb/bridge-client.js';
import { createReplayClient, createReplayFetch, DEMO_BRIDGE_URL, NOT_RECORDED_MESSAGE, type DemoFixture } from './replay.js';

const tiny: DemoFixture = {
  meta: { recordedAt: '2026-11-02T00:00:00Z', network: 'regtest', source: 'test', litd: 'v0', lnd: '0', alias: 'a', exchanges: 2 },
  routes: {
    'GET /state': { status: 200, body: { phase: 'ready' } },
    'GET /payments': { status: 200, body: { payments: [{ valueSat: '42' }] } },
  },
};

describe('replay transport', () => {
  it('answers a recorded route through the real BridgeClient', async () => {
    const client = createReplayClient(tiny, 0);
    await expect(client.state()).resolves.toEqual({ phase: 'ready' });
  });

  it('ignores the query string when matching (payments?max=20)', async () => {
    const client = createReplayClient(tiny, 0);
    const res = await client.payments(20);
    expect(res.payments[0]?.valueSat).toBe('42');
  });

  it('answers unrecorded calls with an explicit 501, never a guess', async () => {
    const client = createReplayClient(tiny, 0);
    const err = await client.walletBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect((err as BridgeHttpError).status).toBe(501);
    expect((err as BridgeHttpError).message).toBe(NOT_RECORDED_MESSAGE);
  });

  it('refuses anything that is not a demo bridge URL', async () => {
    const res = await createReplayFetch(tiny, 0)('http://127.0.0.1:8791/state');
    expect(res.status).toBe(400);
  });
});

/**
 * Contract for the committed fixture the hosted demo ships. Re-recording
 * against a new litd must keep these true, or the demo would open broken.
 */
describe('committed demo fixture (apps/desktop/src/demo/fixtures/modeb.json)', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/modeb.json', import.meta.url), 'utf8')) as DemoFixture;

  it('opens on a ready node', () => {
    expect((fixture.routes['GET /state']?.body as { phase?: string }).phase).toBe('ready');
  });

  it('covers every read the Mode B screens make on open', () => {
    for (const key of ['GET /state', 'GET /onchain/balance', 'GET /channels', 'GET /payments', 'GET /diagnostics']) {
      expect(fixture.routes[key]?.status, key).toBe(200);
    }
  });

  it('never ships wallet setup routes (seed words, unlock password)', () => {
    expect(Object.keys(fixture.routes).filter((k) => / \/wallet\//.test(k))).toEqual([]);
    expect(JSON.stringify(fixture)).not.toMatch(/mnemonic|password/i);
  });

  it('is regtest-only data', () => {
    expect(fixture.meta.network).toBe('regtest');
    expect(JSON.stringify(fixture)).not.toMatch(/\bbc1[qp][0-9a-z]{20,}|\blnbc[0-9]/);
  });

  it('records the upstream versions it came from', () => {
    expect(fixture.meta.litd).toMatch(/^v\d+\.\d+\.\d+/);
    expect(fixture.meta.lnd).not.toBe('unknown');
  });

  it('keeps the demo base URL scheme the replay transport expects', () => {
    expect(DEMO_BRIDGE_URL.startsWith('demo://')).toBe(true);
  });
});
