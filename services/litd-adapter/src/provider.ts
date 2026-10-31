/**
 * Mode B WalletProvider over a local litd sidecar (integrated LND) — or,
 * with backend.kind='remote-lnd', over the user's own remote LND node.
 *
 * The capability declaration is static and test-golden: it states what THIS
 * code can guarantee today, not what litd could ever do.
 */
import { GetTransactionsRequest, LightningClient } from '@sovereign/litd-proto';
import type {
  GetInfoRequest,
  GetInfoResponse,
  Transaction,
} from '@sovereign/litd-proto';
import type { StartOptions, WalletCapabilities, WalletEvent, WalletProvider } from '@sovereign/wallet-core';
import { PROOF_COURIER_DISCLOSURE } from '@sovereign/wallet-core';

import { connectionOptionsFromConfig, createLitdTransport } from './client.js';
import { launchLitdSidecar } from './launcher.js';
import type { LaunchedLitd, LaunchLitdOptions } from './launcher.js';
import type { LitdBackendOptions, LitdNetwork, LitdSidecarOptions, ResolvedLitdConfig } from './config.js';

/**
 * Requirements litd places on a REMOTE LND node (litd v0.17.8 upstream docs,
 * docs/config-lnd-remote.md). The UI must surface `disclosure` verbatim.
 */
export const REMOTE_LND_REQUIREMENTS = {
  minLndVersion: 'v0.19.0',
  requiresFlag: 'rpcmiddleware.enable=true',
  disclosure:
    'Remote mode connects to your own LND node. Your node must run LND v0.19.0 or newer with rpcmiddleware.enable=true.',
} as const;

/**
 * Capabilities of the litd-local provider as implemented by this adapter.
 * - unilateralExit 'instant': force-close initiates immediately; settlement
 *   of funds then follows on-chain timelocks.
 * - operatorDependencies: the ONLY external service in the asset surface is
 *   the proof courier — external asset transfers deliver payment proofs
 *   through it (self-transfers and plain BTC/Lightning do not use it). When
 *   Pool leases ship (feature-detected, later task), the declaration gains
 *   a pool-market entry.
 * - assets 'layer1': the bundled tapd sub-server serves L1 issuance,
 *   transfers, balances, history, and proofs (AssetManager). Asset-channel
 *   transfers stay UNDECLARED — they are experimental (tapd v0.8.x lockstep
 *   + RFQ oracle, seed-only recovery impossible) behind the experimental
 *   gate, off by default; the declaration upgrades to 'layer1+channels'
 *   only when that gate ships its UI (assetSupportForConfig).
 */
// Annotated BEFORE freezing so the literal is contextually typed (enum
// members narrow instead of widening to string).
const litdLocalCapabilities: WalletCapabilities = {
  lightningSend: true,
  lightningReceive: true,
  lightningMechanism: 'channels',
  onchainSend: true,
  onchainReceive: true,
  assets: 'layer1',
  unilateralExit: 'instant',
  recoveryModel: 'aezeed+scb',
  operatorDependencies: [
    {
      kind: 'proof-courier',
      requiredFor: ['send', 'receive'],
      // Shared with the domain declaration — one disclosure, verbatim.
      disclosure: PROOF_COURIER_DISCLOSURE,
    },
  ],
};
export const LITD_LOCAL_CAPABILITIES: Readonly<WalletCapabilities> = Object.freeze(litdLocalCapabilities);

export const LITD_LOCAL_SEED_COMPATIBILITY: readonly string[] = Object.freeze(['aezeed']);

/** Structural slice of the generated LightningClient the provider consumes. */
export interface LightningStreamClient {
  /** RpcTransport — closed on provider stop. */
  readonly transport: { close(): void };
  getInfo(request: GetInfoRequest): { response: Promise<GetInfoResponse> };
  subscribeTransactions(request: GetTransactionsRequest): { responses: AsyncIterable<Transaction> };
}

export type LaunchFn = (launch: LaunchLitdOptions) => Promise<LaunchedLitd>;
export type LightningClientFactory = (config: LaunchedLitd['config']) => Promise<LightningStreamClient>;

/**
 * Real client factory: the generated LightningClient keeps its transport
 * private, so the wrapper owns the transport handle and closes it on stop.
 */
async function defaultClientFactory(config: ResolvedLitdConfig): Promise<LightningStreamClient> {
  const transport = await createLitdTransport(connectionOptionsFromConfig(config));
  const client = new LightningClient(transport);
  return {
    transport: { close: () => transport.close() },
    getInfo: (request) => client.getInfo(request),
    subscribeTransactions: (request) => client.subscribeTransactions(request),
  };
}

export interface LitdLocalProviderOptions {
  /** Checksum-verified litd sidecar binary (scripts/fetch-sidecars.mjs). */
  readonly binaryPath: string;
  /**
   * Backend selection. Neutrino is the desktop default; 'remote-lnd' makes
   * this provider proxy the user's own node (see REMOTE_LND_REQUIREMENTS).
   */
  readonly backend: LitdBackendOptions;
  readonly readyTimeoutMs?: number;
  /** Test seams — defaults are the real launcher/client factory. */
  readonly launchFn?: LaunchFn;
  readonly clientFactory?: LightningClientFactory;
  readonly streamRetryLimit?: number;
  readonly streamBackoffMs?: number;
}

const DEFAULT_STREAM_RETRY_LIMIT = 5;
const DEFAULT_STREAM_BACKOFF_MS = 1_000;

export class LitdLocalProvider implements WalletProvider {
  readonly id = 'litd-local' as const;
  readonly capabilities = LITD_LOCAL_CAPABILITIES;
  readonly seedCompatibility = LITD_LOCAL_SEED_COMPATIBILITY;

  private readonly launchFn: LaunchFn;
  private readonly clientFactory: LightningClientFactory;
  private readonly streamRetryLimit: number;
  private readonly streamBackoffMs: number;
  private readonly binaryPath: string;
  private readonly backend: LitdBackendOptions;
  private readonly readyTimeoutMs: number | undefined;

  private launched: LaunchedLitd | undefined;
  private client: LightningStreamClient | undefined;
  private readonly listeners = new Set<(e: WalletEvent) => void>();
  private pumpAbort = new AbortController();
  /** Surfaced, never swallowed: the last terminal event-stream failure. */
  private lastEventStreamError: Error | undefined;

  constructor(options: LitdLocalProviderOptions) {
    this.binaryPath = options.binaryPath;
    this.backend = options.backend;
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.launchFn = options.launchFn ?? launchLitdSidecar;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.streamRetryLimit = options.streamRetryLimit ?? DEFAULT_STREAM_RETRY_LIMIT;
    this.streamBackoffMs = options.streamBackoffMs ?? DEFAULT_STREAM_BACKOFF_MS;
  }

  get isStarted(): boolean {
    return this.launched !== undefined;
  }

  /** Full node info from the live daemon (diagnostics + integration tests). */
  async getNodeInfo(): Promise<GetInfoResponse> {
    const client = this.requireClient();
    return (await client.getInfo({})).response;
  }

  async start(opts: StartOptions): Promise<void> {
    if (this.launched !== undefined) {
      throw new Error('LitdLocalProvider is already started');
    }
    this.lastEventStreamError = undefined;
    const sidecarOptions: LitdSidecarOptions = {
      network: opts.network as LitdNetwork,
      dataDir: opts.dataDir,
      backend: this.backend,
    };
    this.launched = await this.launchFn({
      binaryPath: this.binaryPath,
      options: sidecarOptions,
      readyTimeoutMs: this.readyTimeoutMs,
    });
    this.client = await this.clientFactory(this.launched.config);
    this.pumpAbort = new AbortController();
    void this.pumpTransactions(this.pumpAbort.signal);
  }

  async stop(): Promise<void> {
    this.pumpAbort.abort();
    const launched = this.launched;
    const client = this.client;
    this.launched = undefined;
    this.client = undefined;
    if (client !== undefined) {
      client.transport.close();
    }
    await launched?.stop();
  }

  onEvent(listener: (e: WalletEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLastEventStreamError(): Error | undefined {
    return this.lastEventStreamError;
  }

  private requireClient(): LightningStreamClient {
    if (this.client === undefined) {
      throw new Error('LitdLocalProvider is not started');
    }
    return this.client;
  }

  private emit(event: WalletEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Transaction stream -> balance-changed events. Bounded retry with backoff;
   * after streamRetryLimit consecutive failures the pump stops and records
   * the error on lastEventStreamError instead of looping forever or dying
   * silently. The stream is re-established on the next start.
   */
  private async pumpTransactions(signal: AbortSignal): Promise<void> {
    if (this.client === undefined) {
      return;
    }
    let attempt = 0;
    while (!signal.aborted) {
      const request = GetTransactionsRequest.create({});
      const responses = this.requireClient().subscribeTransactions(request).responses;
      try {
        for await (const _tx of responses) {
          attempt = 0;
          this.emit({ type: 'balance-changed' });
        }
        // Server closed the stream cleanly (e.g. shutdown in progress).
        if (signal.aborted) {
          return;
        }
        this.lastEventStreamError = new Error('transaction stream closed by backend');
        return;
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        attempt += 1;
        if (attempt >= this.streamRetryLimit) {
          this.lastEventStreamError = err instanceof Error ? err : new Error(String(err));
          return;
        }
        await new Promise((r) => setTimeout(r, this.streamBackoffMs * 2 ** (attempt - 1)));
      }
    }
  }
}
