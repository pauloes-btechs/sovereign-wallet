/**
 * tapd client factory — the asset RPC surface of litd's bundled tapd
 * sub-server (v0.8.6 inside litd v0.17.8).
 *
 * Wiring verified against litd v0.17.8 + tapd v0.8.6 sources (2026-10-31):
 * in integrated mode tapd registers its gRPC services on litd's own TLS mux
 * (`httpslisten`, default 127.0.0.1:8443) — NOT on the embedded LND's raw
 * listener. Calls authenticate with tapd's own admin macaroon
 * (`taproot-assets.macaroonpath`; tapd permissions, rooted at the shared LND
 * root key) presented over litd's TLS — the LND admin macaroon lacks tapd
 * permissions, and the full-permission super macaroon is not baked by
 * default (`bake-super-macaroon=none`). Least privilege by default.
 */
import type { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { tapdAssetsClient, tapdMintClient } from '@sovereign/litd-proto';

import { type LitdConnectionOptions, createLitdTransport } from '../client.js';
import type { ResolvedTapdEndpoint } from '../config.js';

/** Clients over ONE transport — dial once, share the channel. */
export interface TapdClients {
  readonly transport: GrpcTransport;
  readonly assets: tapdAssetsClient.TaprootAssetsClient;
  readonly mint: tapdMintClient.MintClient;
}

/**
 * Connection options for the tapd surface from the resolved sidecar config:
 * dial the litd proxy (the ui/https port), present tapd's admin macaroon.
 */
export function tapdConnectionOptions(
  config: ResolvedTapdEndpoint,
): LitdConnectionOptions {
  return {
    rpcHost: config.rpcHost,
    rpcPort: config.rpcPort,
    tlsCertPath: config.tlsCertPath,
    macaroonPath: config.macaroonPath,
  };
}

/**
 * Creates the tapd clients. Requires a macaroon: tapd answers every call
 * with "permission denied" without one — a config error, not a transient
 * state (same rule as the Lightning client).
 */
export async function createTapdClients(options: LitdConnectionOptions): Promise<TapdClients> {
  if (options.macaroonHex === undefined && options.macaroonPath === undefined) {
    throw new Error(
      'tapd client requires a macaroon: set macaroonPath to the tapd admin macaroon (taproot-assets.macaroonpath)',
    );
  }
  const transport = await createLitdTransport(options);
  return {
    transport,
    assets: new tapdAssetsClient.TaprootAssetsClient(transport),
    mint: new tapdMintClient.MintClient(transport),
  };
}

/**
 * Errors that prove the tapd surface is REGISTERED and legitimately
 * refusing — positive evidence the RPC surface is up. tapd starts after
 * wallet init+unlock; before that the proxy rejects tapd service calls with
 * "server not started"/"subserver starting"-shaped errors, and before
 * unlock the wallet-lock error shows through. Text varies by layer, so the
 * gate resolves only on success or positive evidence — everything else
 * retries until the deadline (same discipline as waitForServices).
 */
const TAPD_UP_EVIDENCE =
  /not found|unavailable|unimplemented|already exists|wallet locked|starting|not started|failed to|internal/i;

/**
 * Wait until the tapd surface actually serves through the litd proxy.
 * Resolves when the canary (tapd GetInfo) succeeds — the strongest
 * evidence: the macaroon was accepted and the service answered.
 */
export async function waitForTapdServices(options: LitdConnectionOptions, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    const outcome = await tapdCanary(options).then(
      () => 'serving' as const,
      (err: unknown) => {
        lastErr = err instanceof Error ? err.message : String(err);
        return TAPD_UP_EVIDENCE.test(lastErr) ? ('registered' as const) : ('starting' as const);
      },
    );
    if (outcome === 'serving') {
      return;
    }
    await sleep(300);
  }
  throw new Error(`tapd RPC not serving within ${timeoutMs}ms: ${lastErr}`);
}

/** One canary call on the tapd surface. Closes the transport after. */
async function tapdCanary(options: LitdConnectionOptions): Promise<void> {
  const clients = await createTapdClients(options);
  try {
    await clients.assets.getInfo({}).response;
  } finally {
    clients.transport.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
