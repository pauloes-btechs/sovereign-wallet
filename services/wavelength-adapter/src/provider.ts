/**
 * WavelengthProvider — the Mode A WalletProvider implementation.
 *
 * Capabilities are NOT re-declared here: this class reuses wallet-core's
 * WAVELENGTH_DECLARATION so its capability values and operator disclosures
 * remain the single source of truth (the golden test pins the adapter to it).
 *
 * Everything Wavelength-shaped stays behind this class and the sdk/ facade —
 * the isolation lint forbids wallet-core imports of this adapter and any
 * other package importing the Wavelength SDK.
 */

import { WAVELENGTH_DECLARATION } from '@sovereign/wallet-core';
import type {
  BalanceBuckets,
  StartOptions,
  TransactionRecord,
  WalletEvent,
  WalletProvider,
} from '@sovereign/wallet-core';
import type {
  Balance,
  CreateWalletRequest,
  CreateWalletResult,
  ExitBatchEvent,
  ExitBatchResult,
  ExitSummaryResult,
  GetExitPlanResult,
  ListView,
  UnlockWalletResult,
  WalletInfo,
  WavelengthClient,
  WavelengthEvent,
  WavelengthListener,
} from './sdk/index.js';
import { FORCE_UNROLL_ACK, exitBatch } from './sdk/index.js';
import type { Unsubscribe } from './sdk/index.js';
import type { ExitReadiness } from './exit.js';
import { summarizeExitReadiness } from './exit.js';
import { mapEntryToRecord } from './entry-mapping.js';
import { SDK_PIN } from './sdk-pin.js';
import type { QuotedSend } from './submit.js';
import { quoteLightningSend, quoteOnchainSend } from './submit.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  classifyVtxoInventory,
  hasAtRisk,
  hasExpiring,
  lockedOrExpiringSat,
} from './vtxo-lifecycle.js';
import type { VtxoContext, VtxoWithState } from './vtxo-lifecycle.js';

export type { QuotedSend };

/** Error surface for provider lifecycle calls (starts, stops, wallet flows). */
export class WavelengthProviderError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-started' | 'mainnet-forbidden' | 'ack-required' | 'daemon-error',
  ) {
    super(message);
    this.name = 'WavelengthProviderError';
  }
}

export interface WavelengthAdapterOptions {
  /** Transport-built client (browser WASM, RN native, or test harness). */
  readonly client: WavelengthClient;
  /** Overrides the pinned SDK identifier recorded in sdk-pin.ts. */
  readonly sdkPin?: string;
  /** VTXO poll cadence for expiry/operator alerts. */
  readonly pollIntervalMs?: number;
  /**
   * Spec-locked: autonomous mainnet operation is never enabled by default.
   * Only an explicit host-level opt-in lets the provider start on mainnet.
   */
  readonly allowMainnet?: boolean;
}

/** What the host passes to {@link WavelengthProvider.start}. */
export type { StartOptions };

/**
 * Mode A provider. One instance owns one client/daemon session; start/stop
 * bracket its lifetime exactly like the litd sidecar's.
 */
export class WavelengthProvider implements WalletProvider {
  readonly id = WAVELENGTH_DECLARATION.id;
  readonly capabilities = WAVELENGTH_DECLARATION.capabilities;
  readonly seedCompatibility = WAVELENGTH_DECLARATION.seedCompatibility;

  private readonly client: WavelengthClient;
  private readonly sdkPin: string;
  private readonly pollIntervalMs: number;
  private readonly allowMainnet: boolean;

  private readonly listeners = new Set<(e: WalletEvent) => void>();
  private unsubscribeSdk: Unsubscribe | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  /** Last emitted transition flags — alerts fire on edges, not every poll. */
  private lastExpiring = false;
  private lastAtRisk = false;

  constructor(options: WavelengthAdapterOptions) {
    this.client = options.client;
    this.sdkPin = options.sdkPin ?? SDK_PIN;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.allowMainnet = options.allowMainnet ?? false;
  }

  // ——— WalletProvider ———

  async start(opts: StartOptions): Promise<void> {
    if (opts.network === 'mainnet' && !this.allowMainnet) {
      throw new WavelengthProviderError(
        'Refusing to start the Wavelength runtime on mainnet: mainnet operations are strictly opt-in and never unattended.',
        'mainnet-forbidden',
      );
    }
    await this.client.start({
      network: opts.network,
      dataDir: opts.dataDir,
      allowMainnet: opts.network === 'mainnet',
    });
    this.started = true;

    // Open the activity stream and forward activity entries as the coarse
    // balance-changed signal. Payment-level alerts ride the intent machine
    // (engine events), not this stream; stream failures are logged, never
    // swallowed silently.
    await this.client.startActivity({ includeExisting: false });
    this.unsubscribeSdk = this.client.subscribe(((event: WavelengthEvent) => {
      if (event.type === 'activity') {
        this.emit({ type: 'balance-changed' });
      } else if (event.type === 'activityStream' && event.payload.state === 'failed') {
        console.warn('[wavelength-adapter] activity stream failed:', event.payload.message);
      }
    }) satisfies WavelengthListener);

    this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.unsubscribeSdk?.();
    this.unsubscribeSdk = undefined;
    this.client.stopActivity();
    await this.client.stop();
    this.started = false;
  }

  onEvent(listener: (e: WalletEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ——— Mode A wallet lifecycle ———

  /** Creates (or restores) the Mode A wallet — mnemonic is `string[]` per the SDK. */
  async createWallet(request: CreateWalletRequest): Promise<CreateWalletResult> {
    this.assertStarted();
    return this.client.createWallet(request);
  }

  async unlockWallet(password: string): Promise<UnlockWalletResult> {
    this.assertStarted();
    return this.client.unlockWallet({ password });
  }

  async walletInfo(): Promise<WalletInfo> {
    this.assertStarted();
    return this.client.getInfo();
  }

  /**
   * Balance buckets for the Mode A UI. The pinned SDK exposes ONE unified
   * daemon balance (`Balance` — confirmed/pendingIn/pendingOut/credits) and
   * no separate on-chain scalar, so the on-chain buckets stay zeroed here;
   * the regtest money-flow test pins this interpretation.
   */
  async balanceBuckets(classified?: readonly VtxoWithState[]): Promise<BalanceBuckets> {
    this.assertStarted();
    const [balance, inventory] = await Promise.all([
      this.client.balance(),
      classified !== undefined ? Promise.resolve(classified) : this.classifyCurrentInventory(),
    ]);
    // lockedOrExpiring classifies a SUBSET of confirmed funds — clamp so the
    // bucket never exceeds the confirmed total (double-count guard).
    const locked = lockedOrExpiringSat(inventory);
    const confirmed = BigInt(balance.confirmedSat);
    return {
      onchainConfirmedSat: 0n,
      onchainPendingSat: 0n,
      lightningSpendableSat: confirmed,
      lightningPendingSat: BigInt(
        balance.pendingInSat + balance.pendingOutSat + balance.creditReservedSat,
      ),
      lockedOrExpiringSat: locked > confirmed ? confirmed : locked,
    };
  }

  /** Credit-based Lightning receive invoice (fresh invoice + amount + memo). */
  async receiveLightning(amountSat: number, memo?: string): Promise<string> {
    this.assertStarted();
    const received = await this.client.receive({ amountSat, memo });
    return received.invoice;
  }

  /** Fresh boarding address for an on-chain deposit into the Ark wallet. */
  async depositOnchain(amountSatHint?: number): Promise<string> {
    this.assertStarted();
    const deposit = await this.client.deposit({ amountSatHint });
    return deposit.address;
  }

  /** One page of wallet activity as provider-partitioned history records. */
  async activityHistory(view: ListView = 'activity'): Promise<TransactionRecord[]> {
    this.assertStarted();
    const result = await this.client.list({ view, pendingOnly: false });
    return (result.activity?.entries ?? []).map((e) => mapEntryToRecord(e, this.id));
  }

  // ——— Mode A sends (quote at authorization; dispatch via the engine) ———

  /** Quotes a Lightning swap send and enforces the fee budget. Never dispatches. */
  async quoteLightning(
    input: { invoice: string; amountSat?: number; note?: string; maxFeeSat?: number },
  ): Promise<QuotedSend & { payload: { invoice: string; amountSat?: number; note?: string } }> {
    this.assertStarted();
    const { maxFeeSat, ...rest } = input;
    return quoteLightningSend(this.client, rest, maxFeeSat);
  }

  /** Quotes an on-chain send and enforces the fee budget. Never dispatches. */
  async quoteOnchain(
    input: {
      onchainAddress: string;
      amountSat?: number;
      sweepAll?: boolean;
      note?: string;
      maxFeeSat?: number;
    },
  ): Promise<
    QuotedSend & { payload: { onchainAddress: string; amountSat?: number; sweepAll?: boolean; note?: string } }
  > {
    this.assertStarted();
    const { maxFeeSat, ...rest } = input;
    return quoteOnchainSend(this.client, rest, maxFeeSat);
  }

  // ——— Mode A unilateral exit ———

  /** Previews unilateral-exit readiness for the outpoints — moves nothing. */
  async exitReadiness(outpoints: readonly string[], confTarget?: number): Promise<ExitReadiness> {
    this.assertStarted();
    const plan = await this.client.getExitPlan({ outpoints: [...outpoints], confTarget });
    return summarizeExitReadiness(plan);
  }

  /** The raw daemon plan (per-outpoint funding details, fee rate). */
  async exitPlan(outpoints: readonly string[], confTarget?: number): Promise<GetExitPlanResult> {
    this.assertStarted();
    return this.client.getExitPlan({ outpoints: [...outpoints], confTarget });
  }

  /**
   * Starts unilateral exits for the outpoints. `ack` must be the exact
   * FORCE_UNROLL_ACK constant — the SDK rejects anything else, and this
   * gate refuses to pass anything through without it.
   */
  async startUnilateralExit(
    outpoints: readonly string[],
    ack: string,
    opts?: { confTarget?: number; onEvent?: (event: ExitBatchEvent) => void },
  ): Promise<ExitBatchResult> {
    this.assertStarted();
    if (ack !== FORCE_UNROLL_ACK) {
      throw new WavelengthProviderError(
        'Refusing to start a unilateral exit without the exact irreversible-unroll acknowledgement.',
        'ack-required',
      );
    }
    // SDK-blessed batch helper: previews funding, skips outpoints already
    // running an exit, re-plans between starts, treats a mid-batch daemon
    // rejection as a clean stop.
    return exitBatch({
      mode: 'unilateral',
      outpoints: [...outpoints],
      confTarget: opts?.confTarget,
      client: this.client,
      onEvent: opts?.onEvent,
    });
  }

  /** Wallet-wide in-progress exit summary (per-exit status + totals). */
  async exitSummary(): Promise<ExitSummaryResult> {
    this.assertStarted();
    return this.client.exitSummary();
  }

  /** Exit-job status for one outpoint (coarse by default; detailed costs a round-trip). */
  async exitStatusFor(outpoint: string, detailed = false) {
    this.assertStarted();
    return this.client.exitStatus({ outpoint, detailed });
  }

  // ——— internals ———

  private assertStarted(): void {
    if (!this.started) {
      throw new WavelengthProviderError(
        'The Wavelength runtime is not started — call start() first.',
        'not-started',
      );
    }
  }

  private emit(event: WalletEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Poll pass: classify VTXOs, fire alert edges (expiry / operator). */
  async pollOnce(): Promise<void> {
    if (!this.started) return;
    try {
      const info = await this.client.getInfo();
      const classified = await this.classifyCurrentInventory(info);
      const expiring = hasExpiring(classified);
      const atRisk = hasAtRisk(classified);
      if (expiring && !this.lastExpiring) {
        this.emit({ type: 'vtxo-expiry-approaching' });
      }
      // Operator unreachable is only actionable INSIDE the expiry window —
      // emit the edge only then (research: at-risk = "VTXOs expire next
      // block while the operator is unreachable").
      if (atRisk && !this.lastAtRisk) {
        this.emit({ type: 'operator-unreachable' });
      }
      this.lastExpiring = expiring;
      this.lastAtRisk = atRisk;
    } catch (error) {
      // A failed poll pass retries on the next tick; never crashes the
      // provider. Domain calls surface daemon errors directly.
      console.warn('[wavelength-adapter] poll failed:', error);
    }
  }

  /** Live VTXO classification: vtxos view + exit summary + wallet info. */
  private async classifyCurrentInventory(info?: WalletInfo): Promise<VtxoWithState[]> {
    const walletInfo = info ?? (await this.client.getInfo());
    const [listResult, summary] = await Promise.all([
      this.client.list({ view: 'vtxos' }),
      this.client.exitSummary(),
    ]);
    const ctx: VtxoContext = {
      blockHeight: walletInfo.blockHeight,
      freeRefreshWindowBlocks: walletInfo.serverInfo?.freeRefreshWindowBlocks,
      operatorReachable: walletInfo.serverConnected,
      exitJobs: new Map(
        (summary.exits ?? []).map((entry) => [entry.outpoint, entry.status]),
      ),
    };
    return classifyVtxoInventory(
      { vtxos: listResult.vtxos?.vtxos ?? [], total: listResult.vtxos?.total ?? 0 },
      ctx,
    );
  }
}

/** Balance type re-export for hosts that want the pinned shape without the SDK. */
export type { Balance };
