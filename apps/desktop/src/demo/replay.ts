/**
 * Replay transport for the hosted /desktop/ demo.
 *
 * The fixtures are real bridge responses recorded while the desktop UI ran
 * against real litd / LND / Faraday on regtest (see
 * apps/desktop/e2e/modeb/recorder.ts and scripts/demo/build-fixtures.mjs).
 * The demo runs the unmodified BridgeClient and screens over this
 * transport, so a field the UI reads that disappears from a new recording
 * shows up as a broken screen here, the same way it would in the app.
 *
 * Nothing leaves the page: no network, no keys, no funds. Calls the recorded
 * session never made get an explicit "not part of the recording" error.
 */
import { BridgeClient } from '../modeb/bridge-client.js';

export const DEMO_BRIDGE_URL = 'demo://bridge';

export interface DemoFixtureMeta {
  readonly recordedAt: string;
  readonly network: string;
  readonly source: string;
  readonly litd: string;
  readonly lnd: string;
  readonly alias: string;
  readonly exchanges: number;
}

export interface DemoFixture {
  readonly meta: DemoFixtureMeta;
  readonly routes: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>;
}

const LATENCY_MS = 120;

export const NOT_RECORDED_MESSAGE =
  'Not available in the replayed demo: the recorded regtest session never made this call.';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers bridge calls from the recording. */
export function createReplayFetch(fixture: DemoFixture, latencyMs = LATENCY_MS): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith(DEMO_BRIDGE_URL)) {
      return jsonResponse(400, { error: 'replay transport only answers demo bridge calls' });
    }
    const pathname = raw.slice(DEMO_BRIDGE_URL.length).split('?')[0] ?? '/';
    const method = (init?.method ?? 'GET').toUpperCase();
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    const hit = fixture.routes[`${method} ${pathname}`];
    if (hit === undefined) return jsonResponse(501, { error: NOT_RECORDED_MESSAGE });
    return jsonResponse(hit.status, hit.body);
  };
}

export function createReplayClient(fixture: DemoFixture, latencyMs = LATENCY_MS): BridgeClient {
  return new BridgeClient({
    bridgeUrl: DEMO_BRIDGE_URL,
    bridgeToken: 'replay',
    fetchImpl: createReplayFetch(fixture, latencyMs),
  });
}

/** Lazy so the fixtures only ship in the demo build's own chunk. */
export async function loadDemoFixture(): Promise<DemoFixture> {
  const mod = (await import('./fixtures/modeb.json')) as { default: DemoFixture };
  return mod.default;
}
