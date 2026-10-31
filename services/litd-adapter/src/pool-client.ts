/**
 * PoolPort implementation over litd's bundled poold (Trader service).
 *
 * The market-state read uses the trader's batch-snapshot RPCs — live data
 * about matched batches on the auctioneer. On networks without a reachable
 * auctioneer (regtest, offline nodes) every call fails at the transport and
 * is classified as `unavailable` — the engine's first-class thin/unavailable
 * states, never an unhandled error.
 */
import { PoolClient, PoolAuctioneer } from '@sovereign/litd-proto';
import type { PoolMarketRaw } from '@sovereign/liquidity';
import type { GrpcTransport } from '@protobuf-ts/grpc-transport';

import type { LitdConnectionOptions } from './client.js';
import { createLitdTransport } from './client.js';
import { mapTransportError } from './loop-client.js';
import { RPC_UNARY_TIMEOUT_MS } from './rpc-timeout.js';

/**
 * Pure batch snapshots → market raw data: how many batches actually matched
 * orders, and the total cleared volume. An auctioneer with no batches at all
 * maps to matchedBatches 0 — the engine's thin-market state.
 */
export function batchSnapshotsToMarketRaw(batches: readonly PoolAuctioneer.BatchSnapshotResponse[]): PoolMarketRaw {
  let matchedBatches = 0;
  let leasedVolumeSat = 0;
  for (const batch of batches) {
    if (batch.matchedOrders.length === 0) continue;
    matchedBatches += 1;
    for (const order of batch.matchedOrders) {
      leasedVolumeSat += Number(order.totalSatsCleared);
    }
  }
  return leasedVolumeSat > 0 ? { matchedBatches, leasedVolumeSat } : { matchedBatches };
}

/** Factory-bound Pool port over litd's pool sub-server. */
export class LitdPoolPort {
  private readonly client: PoolClient.TraderClient;

  private constructor(private readonly transport: GrpcTransport) {
    this.client = new PoolClient.TraderClient(transport);
  }

  /** Async factory — the transport reads the TLS cert before connecting. */
  static async create(options: LitdConnectionOptions): Promise<LitdPoolPort> {
    return new LitdPoolPort(await createLitdTransport(options));
  }

  async marketRaw(): Promise<PoolMarketRaw> {
    try {
      const resp = await this.client
        .batchSnapshots(PoolAuctioneer.BatchSnapshotsRequest.create({}), { timeoutMs: RPC_UNARY_TIMEOUT_MS })
        .response;
      return batchSnapshotsToMarketRaw(resp.batches);
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  close(): void {
    this.transport.close();
  }
}
