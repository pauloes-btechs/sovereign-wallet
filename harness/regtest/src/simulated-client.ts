/**
 * SimulatedWavelengthClient — a test double that implements the pinned SDK's
 * `WavelengthClient` contract (re-exported by @sovereign/wavelength-adapter)
 * with deterministic in-memory state.
 *
 * Why a simulation rather than a live `waved` daemon: no upstream Ark container
 * image is verified for CI yet, and the money-flow tests must run hermetically
 * on every push. The simulation drives the REAL adapter, dispatcher, and
 * payment engine end-to-end — only the daemon is faked. Live-daemon wiring is
 * added when the harness verifies upstream images.
 */
import { createHash } from 'node:crypto';
import {
  EntryFailureCodeFailed,
  EntryKindDeposit,
  EntryKindReceive,
  EntryKindSend,
  EntryPhaseConfirmed,
  EntryPhaseWaitingForPayment,
  EntryRequestTypeLightning,
  EntryRequestTypeOnchain,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryStatusPending,
  FORCE_UNROLL_ACK,
  ListViewActivity,
  ListViewOnchain,
  ListViewVTXOs,
  SendRailLightning,
  SendRailOnchain,
  SendQuoteStatusComplete,
  WalletState,
  WavelengthError,
} from '@sovereign/wavelength-adapter';
import type {
  ActivityStreamOptions,
  Balance,
  CreateWalletRequest,
  CreateWalletResult,
  DepositRequest,
  DepositResult,
  Entry,
  EntryFailureCode,
  EntryProgress,
  ExitRequest,
  ExitResult,
  ExitJobStatus,
  ExitPlanEntry,
  ExitStatusRequest,
  ExitStatusResult,
  ExitSummaryEntry,
  ExitSummaryRequest,
  ExitSummaryResult,
  GetExitPlanRequest,
  GetExitPlanResult,
  ListRequest,
  ListResult,
  Network,
  OpenWalletFromPasskeyRequest,
  OpenWalletFromPasskeyResult,
  PrepareSendResult,
  ReceiveRequest,
  ReceiveResult,
  RuntimeConfig,
  SendRequest,
  SendResult,
  SweepWalletRequest,
  SweepWalletResult,
  UnlockWalletRequest,
  UnlockWalletResult,
  VTXOInventory,
  WalletInfo,
  WalletStatus,
  WalletVTXO,
  WavelengthClient,
  WavelengthEvent,
  WavelengthListener,
} from '@sovereign/wavelength-adapter';

/** One exit job's simulated state. */
interface SimExitJob {
  status: ExitJobStatus;
  amountSat: number;
  sweepTxid: string;
  /** Driver-controlled best-case countdown surfaced through exitStatus. */
  bestCaseBlocksRemaining: number;
}

/** The Ark operator's record of a VTXO it batched for some wallet. */
export interface OperatorVtxoRecord {
  readonly outpoint: string;
  readonly amountSat: number;
  /** Chain height at which the VTXO's batch expires. */
  readonly batchExpiry: number;
  readonly relativeExpiry: number;
}

/**
 * The operator-side indexer SimulatedWavelengthClients SHARE. Models the
 * recovery contract the drill depends on: a seed restore rebuilds off-chain
 * VTXO state from the OPERATOR's view — a fresh daemon recovers exactly the
 * VTXOs the operator still holds in live (unexpired) batches, and nothing
 * else. Records whose batch has expired are unrecoverable off-chain; the
 * only path back is the wallet's own unilateral exit.
 */
export class OperatorIndexer {
  private readonly wallets = new Map<string, OperatorVtxoRecord[]>();

  record(walletKey: string, record: OperatorVtxoRecord): void {
    const existing = this.wallets.get(walletKey) ?? [];
    if (!existing.some((r) => r.outpoint === record.outpoint)) {
      existing.push(record);
    }
    this.wallets.set(walletKey, existing);
  }

  /** VTXOs the operator still holds in live (unexpired) batches for a wallet. */
  liveFor(walletKey: string, atHeight: number): OperatorVtxoRecord[] {
    return (this.wallets.get(walletKey) ?? []).filter((r) => r.batchExpiry > atHeight);
  }
}

/**
 * Deterministic per-seed wallet key. Models the real property that makes
 * recovery work at all: wallet identity and keys derive from the seed, so
 * any daemon initialized from the same words maps to the same operator-side
 * wallet.
 */
export function simWalletKey(mnemonic: readonly string[]): string {
  return createHash('sha256').update(mnemonic.join(' ')).digest('hex');
}

export class SimulatedWavelengthClient implements WavelengthClient {
  // ——— test-driver state ———
  blockHeight = 805_000;
  operatorReachable = true;
  freeRefreshWindowBlocks = 25;
  balances: Balance = {
    confirmedSat: 0,
    pendingInSat: 0,
    pendingOutSat: 0,
    creditAvailableSat: 0,
    creditReservedSat: 0,
  };
  vtxos: WalletVTXO[] = [];
  backingUTXOs: { amountSat: number }[] = [];
  swapFeeSat = 30;
  /** Quotes the driver may settle or fail by id. */
  readonly entries: Entry[] = [];
  readonly exits = new Map<string, SimExitJob>();
  /** Operator-side state shared across daemon instances (recovery drills). */
  readonly indexer: OperatorIndexer;

  // ——— wallet state (lifecycle drills) ———
  walletMnemonic: string[] | undefined;
  walletKeyHex: string | undefined;

  // ——— observability for the tests ———
  sendPreparedCalls = 0;
  preparedQuotes = new Map<string, PrepareSendResult>();
  startedConfig: RuntimeConfig | undefined;

  private seq = 0;
  private mnemonicSeq = 0;
  private started = false;
  private disposed = false;
  private streamOpen = false;
  private readonly listeners = new Set<WavelengthListener>();

  /** `indexer` is shared between daemons simulating restore from the operator. */
  constructor(indexer: OperatorIndexer = new OperatorIndexer()) {
    this.indexer = indexer;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private makeProgress(partial: Partial<EntryProgress> = {}): EntryProgress {
    // Every EntryProgress field is required in the pinned SDK — empty string
    // until the daemon durably knows a value.
    return {
      phase: partial.phase ?? EntryPhaseWaitingForPayment,
      phaseLabel: partial.phaseLabel ?? 'waiting_for_payment',
      paymentHash: partial.paymentHash ?? '',
      txid: partial.txid ?? '',
      confirmationHeight: partial.confirmationHeight ?? 0,
      vTXOOutpoint: partial.vTXOOutpoint ?? '',
      preimage: partial.preimage ?? '',
    };
  }

  private appendEntry(entry: Entry): void {
    this.entries.push(entry);
    this.emit({ type: 'activity', payload: entry });
  }

  private emit(event: WavelengthEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ——— test drivers ———

  /** Marks a send entry settled exactly like the swap server would. */
  settleEntry(entryId: string): Entry {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`sim: no entry ${entryId}`);
    entry.status = EntryStatusComplete;
    // EntryProgress fields are all required (empty strings until known).
    const prior = entry.progress;
    entry.progress = this.makeProgress({
      phase: EntryPhaseConfirmed,
      phaseLabel: 'confirmed',
      paymentHash: prior?.paymentHash ?? '',
      txid: prior?.txid ?? '',
      confirmationHeight: this.blockHeight,
      vTXOOutpoint: prior?.vTXOOutpoint ?? '',
      preimage: prior?.preimage ?? '',
    });
    this.emit({ type: 'activity', payload: entry });
    return entry;
  }

  /** Marks a send entry failed with a specific SDK failure code. */
  failEntry(entryId: string, failureCode: EntryFailureCode, reason: string): Entry {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`sim: no entry ${entryId}`);
    entry.status = EntryStatusFailed;
    entry.failureCode = failureCode;
    entry.failureReason = reason;
    this.emit({ type: 'activity', payload: entry });
    return entry;
  }

  /** Moves the simulated chain forward one block. */
  addBlock(): void {
    this.blockHeight += 1;
  }

  connectOperator(reachable: boolean): void {
    this.operatorReachable = reachable;
  }

  /** Adds a fresh VTXO expiring `blocksToExpiry` blocks from the current tip. */
  depositVTXO(outpoint: string, amountSat: number, blocksToExpiry: number): void {
    this.vtxos.push({
      outpoint,
      amountSat,
      status: 'available',
      batchExpiry: this.blockHeight + blocksToExpiry,
      relativeExpiry: 40,
      commitmentTxid: 'sim-commitment-txid',
    });
    this.balances.confirmedSat += amountSat;
    // The operator indexes whatever exists — including wallets the current
    // daemon has not created yet (another instance may restore them later).
    const key = this.walletKeyHex ?? (this.walletMnemonic ? simWalletKey(this.walletMnemonic) : undefined);
    if (key !== undefined) {
      this.indexer.record(key, {
        outpoint,
        amountSat,
        batchExpiry: this.blockHeight + blocksToExpiry,
        relativeExpiry: 40,
      });
    }
  }

  /** Funds the backing wallet (the fee source a unilateral exit requires). */
  fundBacking(amountSat: number): void {
    this.backingUTXOs.push({ amountSat });
  }

  /** Advances one exit job along the unilateral path, to completion if asked. */
  advanceExitJob(outpoint: string, to: ExitJobStatus): SimExitJob {
    const job = this.exits.get(outpoint);
    if (!job) throw new Error(`sim: no exit job for ${outpoint}`);
    job.status = to;
    if (to === 'completed') {
      const vtxo = this.vtxos.find((v) => v.outpoint === outpoint);
      if (vtxo) {
        this.balances.confirmedSat -= vtxo.amountSat;
        this.vtxos = this.vtxos.filter((v) => v.outpoint !== outpoint);
      }
      job.sweepTxid = this.nextId('sweep-tx');
    }
    return job;
  }

  // ——— WavelengthClient (the pinned SDK contract) ———

  async ready(): Promise<void> {
    if (this.disposed) throw new Error('sim: client disposed');
  }

  async start(config: RuntimeConfig): Promise<WalletInfo> {
    this.startedConfig = config;
    this.started = true;
    return this.getInfo();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.streamOpen = false;
  }

  async getInfo(): Promise<WalletInfo> {
    return {
      version: 'sim-0.2.0',
      commit: 'sim',
      network: (this.startedConfig?.network ?? 'regtest') as string,
      blockHeight: this.blockHeight,
      serverConnected: this.operatorReachable,
      walletType: 'ark',
      walletState: WalletState.Ready,
      walletReady: true,
      identityPubKey: this.simIdentity(),
      serverInfo: { freeRefreshWindowBlocks: this.freeRefreshWindowBlocks },
    } as WalletInfo;
  }

  async status(): Promise<WalletStatus> {
    const info = await this.getInfo();
    return {
      ready: info.walletReady,
      unlocked: true,
      network: info.network,
      balance: this.balances,
      pendingCount: this.entries.filter((e) => e.status === EntryStatusPending).length,
    } satisfies WalletStatus;
  }

  async balance(): Promise<Balance> {
    return { ...this.balances };
  }

  /**
   * Wallet identity derives from the seed once one exists — the property the
   * recovery drills depend on (same words ⇒ same identity on any daemon).
   */
  private simIdentity(): string {
    return this.walletKeyHex === undefined ? 'sim-identity' : `sim-${this.walletKeyHex.slice(0, 16)}`;
  }

  /** Deterministic fake mnemonic — the drills treat it as opaque seed words. */
  private freshMnemonic(): string[] {
    this.mnemonicSeq += 1;
    return Array.from({ length: 12 }, (_, i) => `word${this.mnemonicSeq}of${this.mnemonicSeq}-${i + 1}`);
  }

  /** Adopts an operator-side (or locally backed-up) VTXO record as inventory. */
  private adoptRecord(record: OperatorVtxoRecord): void {
    if (this.vtxos.some((v) => v.outpoint === record.outpoint)) return;
    this.vtxos.push({
      outpoint: record.outpoint,
      amountSat: record.amountSat,
      status: 'available',
      batchExpiry: record.batchExpiry,
      relativeExpiry: record.relativeExpiry,
      commitmentTxid: 'sim-commitment-txid',
    });
    this.balances.confirmedSat += record.amountSat;
  }

  async createWallet(req: CreateWalletRequest): Promise<CreateWalletResult> {
    if (this.walletMnemonic !== undefined) {
      throw new WavelengthError('sim: wallet already exists — a daemon holds one wallet', 'already_exists');
    }
    const mnemonicIn = req.mnemonic ?? [];
    const recoverStateWanted = req.recoverState ?? false;
    const restoring = mnemonicIn.length > 0;
    const mnemonic = restoring ? [...mnemonicIn] : this.freshMnemonic();
    this.walletMnemonic = mnemonic;
    this.walletKeyHex = simWalletKey(mnemonic);

    const recoveryRan = restoring && recoverStateWanted;
    let recoveredVTXOs = 0;
    if (recoveryRan) {
      if (!this.operatorReachable) {
        // The wallet exists (keys work) but the off-chain state scan needs
        // the operator's view of live batches — exactly what the real daemon
        // rebuilds VTXO state from on a restore.
        throw new WavelengthError(
          'sim: recovery scan failed — Ark operator unreachable; VTXO state not rebuilt',
          'unavailable',
        );
      }
      for (const record of this.indexer.liveFor(this.walletKeyHex, this.blockHeight)) {
        this.adoptRecord(record);
        recoveredVTXOs += 1;
      }
    }
    return {
      mnemonic,
      encipheredSeed: `sim-enc(${this.walletKeyHex.slice(0, 12)})`,
      identityPubKey: this.simIdentity(),
      recoveryRan,
      recoveredBoardingAddresses: 0,
      recoveredBoardingUTXOs: 0,
      recoveredVTXOs,
      recoveredOORReceiveScripts: 0,
      recoveredOORRecipientEvents: 0,
    };
  }

  async unlockWallet(_req: UnlockWalletRequest): Promise<UnlockWalletResult> {
    if (this.walletMnemonic === undefined) {
      throw new WavelengthError('sim: no wallet to unlock — create or restore one first', 'not_found');
    }
    return { identityPubKey: this.simIdentity() };
  }

  /**
   * Restores VTXO state from the wallet's OWN encrypted backup (the local
   * records our app layer keeps alongside the seed) — the fallback when the
   * operator is unreachable and the operator-side scan cannot rebuild state.
   * Adopts records regardless of expiry (the unilateral-exit path follows);
   * returns how many records were newly adopted.
   */
  restoreVtxoStateFromBackup(records: readonly OperatorVtxoRecord[]): number {
    let adopted = 0;
    for (const record of records) {
      if (this.vtxos.some((v) => v.outpoint === record.outpoint)) continue;
      this.adoptRecord(record);
      adopted += 1;
    }
    return adopted;
  }

  async openWalletFromPasskey(
    _req: OpenWalletFromPasskeyRequest,
  ): Promise<OpenWalletFromPasskeyResult> {
    throw new Error('sim: openWalletFromPasskey not simulated');
  }

  async deposit(req?: DepositRequest): Promise<DepositResult> {
    const address = this.nextId('bcrt1q-sim-board');
    const entry: Entry = {
      id: this.nextId('entry'),
      kind: EntryKindDeposit,
      status: EntryStatusPending,
      amountSat: req?.amountSatHint ?? 0,
      feeSat: 0,
      counterparty: 'chain',
      createdAt: '2026-10-30T00:00:00Z',
      updatedAt: '2026-10-30T00:00:00Z',
      note: '',
      failureReason: '',
      cursor: this.seq,
      failureCode: EntryFailureCodeFailed,
      progress: this.makeProgress({ txid: this.nextId('tx') }),
    };
    this.appendEntry(entry);
    return { address, entry };
  }

  async receive(req: ReceiveRequest): Promise<ReceiveResult> {
    const invoice = this.nextId('lnbcrt1-sim');
    const entry: Entry = {
      id: this.nextId('entry'),
      kind: EntryKindReceive,
      status: EntryStatusPending,
      amountSat: req.amountSat,
      feeSat: 0,
      counterparty: 'swap-server',
      createdAt: '2026-10-30T00:00:00Z',
      updatedAt: '2026-10-30T00:00:00Z',
      note: req.memo ?? '',
      failureReason: '',
      cursor: this.seq,
      failureCode: EntryFailureCodeFailed,
      progress: this.makeProgress({ paymentHash: this.nextId('recv-ph') }),
    };
    this.appendEntry(entry);
    return { invoice, entry };
  }

  async prepareSend(req: SendRequest): Promise<PrepareSendResult> {
    const isLightning = 'invoice' in req && req.invoice !== '';
    const amountSat = req.amountSat ?? 0;
    const quote: PrepareSendResult = {
      sendIntentId: this.nextId('si'),
      amountSat,
      expectedFeeSat: this.swapFeeSat,
      feeKnown: true,
      expectedTotalOutflowSat: amountSat + this.swapFeeSat,
      totalOutflowKnown: true,
      rail: isLightning ? SendRailLightning : SendRailOnchain,
      quoteStatus: SendQuoteStatusComplete,
      destinationSummary: isLightning ? 'invoice-destination' : (req as { onchainAddress: string }).onchainAddress,
      invoiceDescription: req.note ?? '',
      paymentHash: isLightning ? this.nextId('ph') : '',
      expiresAtUnix: 1_798_000_000,
      selectedOutpoints: [],
      warning: '',
    };
    this.preparedQuotes.set(quote.sendIntentId, quote);
    return quote;
  }

  async sendPrepared(prepared: PrepareSendResult): Promise<SendResult> {
    this.sendPreparedCalls += 1;
    const quote = this.preparedQuotes.get(prepared.sendIntentId);
    if (!quote) {
      throw new WavelengthError(
        'sim: unknown or single-use send intent — prepare a fresh send',
        'invalid_argument',
      );
    }
    this.preparedQuotes.delete(prepared.sendIntentId);
    const entry: Entry = {
      id: this.nextId('entry'),
      kind: EntryKindSend,
      status: EntryStatusPending,
      amountSat: prepared.amountSat,
      feeSat: prepared.expectedFeeSat,
      counterparty: prepared.rail === SendRailLightning ? 'swap-server' : 'chain',
      // The daemon echoes the user-recognizable request that created the
      // entry — send reconciliation correlates on-chain sends through it.
      request:
        prepared.rail === SendRailLightning
          ? {
              type: EntryRequestTypeLightning,
              lightningInvoice: '',
              paymentHash: prepared.paymentHash,
              onchainAddress: '',
              arkAddress: '',
            }
          : {
              type: EntryRequestTypeOnchain,
              lightningInvoice: '',
              paymentHash: '',
              onchainAddress: prepared.destinationSummary,
              arkAddress: '',
            },
      createdAt: '2026-10-30T00:00:00Z',
      updatedAt: '2026-10-30T00:00:00Z',
      note: prepared.invoiceDescription,
      failureReason: '',
      cursor: this.seq,
      failureCode: EntryFailureCodeFailed,
      progress: this.makeProgress({ paymentHash: prepared.paymentHash }),
    };
    this.appendEntry(entry);
    return { entry, actualAmountSat: prepared.amountSat };
  }

  async send(_req: SendRequest): Promise<SendResult> {
    throw new Error('sim: send not simulated — the adapter always uses prepareSend + sendPrepared');
  }

  async list(req?: ListRequest): Promise<ListResult> {
    const view = req?.view ?? ListViewActivity;
    if (view === ListViewVTXOs) {
      const inventory: VTXOInventory = { vtxos: [...this.vtxos], total: this.vtxos.length };
      return { view, vtxos: inventory } as ListResult;
    }
    if (view === ListViewOnchain) {
      return { view, onchain: { txs: [], total: 0, hasMore: false } } as ListResult;
    }
    return {
      view: ListViewActivity,
      activity: {
        entries: [...this.entries],
        total: this.entries.length,
        hasMore: false,
        nextCursor: '',
      },
    } as ListResult;
  }

  async exit(req: ExitRequest): Promise<ExitResult> {
    if (req.forceUnrollAck !== FORCE_UNROLL_ACK) {
      throw new WavelengthError('sim: unilateral unroll requires the exact acknowledgement', 'invalid_argument');
    }
    const vtxo = this.vtxos.find((v) => v.outpoint === req.outpoint);
    if (!vtxo) {
      throw new WavelengthError(`sim: unknown VTXO ${req.outpoint}`, 'not_found');
    }
    this.exits.set(req.outpoint, {
      status: 'pending',
      amountSat: vtxo.amountSat,
      sweepTxid: '',
      bestCaseBlocksRemaining: 12,
    });
    return {
      path: 'unilateral',
      cooperative: false,
      queuedOutpoints: [],
      created: true,
      actorID: this.nextId('actor'),
      cooperativeError: '',
    } satisfies ExitResult;
  }

  async exitStatus(req: ExitStatusRequest): Promise<ExitStatusResult> {
    const job = this.exits.get(req.outpoint);
    return {
      found: job !== undefined,
      status: job?.status ?? 'unspecified',
      sweepTxid: job?.sweepTxid ?? '',
      lastError: '',
      phaseDetail: '',
      cSV: undefined,
      fees: undefined,
      progress: undefined,
      bestCaseBlocksRemaining: job?.bestCaseBlocksRemaining ?? 0,
      currentHeight: this.blockHeight,
    } satisfies ExitStatusResult;
  }

  async exitSummary(_req?: ExitSummaryRequest): Promise<ExitSummaryResult> {
    const exits = [...this.exits.entries()]
      .filter(([, job]) => job.status !== 'completed' && job.status !== 'failed')
      .map(([outpoint, job]): ExitSummaryEntry => ({
        outpoint,
        status: job.status,
        vTXOAmountSat: job.amountSat,
        estTotalFeeSat: 500,
        estNetRecoveredSat: job.amountSat - 500,
      }));
    return {
      exits,
      totalExits: exits.length,
      totalVTXOAmountSat: exits.reduce((sum, e) => sum + e.vTXOAmountSat, 0),
      totalEstFeeSat: exits.length * 500,
      totalEstNetRecoveredSat: exits.reduce((sum, e) => sum + e.estNetRecoveredSat, 0),
    } satisfies ExitSummaryResult;
  }

  async getExitPlan(req: GetExitPlanRequest): Promise<GetExitPlanResult> {
    const backingTotal = this.backingUTXOs.reduce((sum, u) => sum + u.amountSat, 0);
    const recommendedPerVtxo = 900;
    const plans = req.outpoints.map((outpoint): ExitPlanEntry => {
      const vtxo = this.vtxos.find((v) => v.outpoint === outpoint);
      const amountSat = vtxo?.amountSat ?? 0;
      // Structural block: too small to exit economically even with funding.
      if (amountSat > 0 && amountSat < 1_000) {
        return {
          outpoint,
          fundingAddress: 'bcrt1q-sim-funding',
          requiredConfirmations: 1,
          requiredFeeUTXOCount: 1,
          usableFeeUTXOCount: backingTotal > 0 ? 1 : 0,
          recommendedUTXOAmountSat: recommendedPerVtxo,
          recommendedTotalFundingSat: recommendedPerVtxo,
          fundingShortfallSat: 0,
          canStart: false,
          infeasibilityReason: 'uneconomical',
          exitJobFound: this.exits.has(outpoint),
          exitStatus: this.exits.get(outpoint)?.status ?? 'unspecified',
          sweepTxid: this.exits.get(outpoint)?.sweepTxid ?? '',
          lastError: '',
          roundCommitment: '',
          err: '',
        };
      }
      const shortfall = Math.max(0, recommendedPerVtxo - backingTotal);
      return {
        outpoint,
        fundingAddress: 'bcrt1q-sim-funding',
        requiredConfirmations: 1,
        requiredFeeUTXOCount: 1,
        usableFeeUTXOCount: backingTotal >= recommendedPerVtxo ? 1 : 0,
        recommendedUTXOAmountSat: recommendedPerVtxo,
        recommendedTotalFundingSat: recommendedPerVtxo,
        fundingShortfallSat: shortfall,
        canStart: shortfall === 0,
        infeasibilityReason: shortfall === 0 ? 'unspecified' : 'wallet_underfunded',
        exitJobFound: this.exits.has(outpoint),
        exitStatus: this.exits.get(outpoint)?.status ?? 'unspecified',
        sweepTxid: this.exits.get(outpoint)?.sweepTxid ?? '',
        lastError: '',
        roundCommitment: '',
        err: '',
      };
    });
    return {
      plans,
      feeRateSatPerVByte: 2,
      canStart: plans.every((p) => p.canStart),
      totalFundingShortfallSat: plans.reduce((sum, p) => sum + p.fundingShortfallSat, 0),
      totalRecommendedFundingSat: plans.reduce((sum, p) => sum + p.recommendedTotalFundingSat, 0),
    } satisfies GetExitPlanResult;
  }

  async sweepWallet(_req: SweepWalletRequest): Promise<SweepWalletResult> {
    throw new Error('sim: sweepWallet not simulated');
  }

  async callFacade<T = unknown>(_method: string, _params?: unknown): Promise<T> {
    throw new Error('sim: callFacade not simulated');
  }

  async isRunning(): Promise<boolean> {
    return this.started;
  }

  subscribe(listener: WavelengthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async startActivity(_opts?: ActivityStreamOptions): Promise<void> {
    this.streamOpen = true;
  }

  stopActivity(): void {
    this.streamOpen = false;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** The network type the harness pins (keeps Network import used/type-safe). */
export const HARNESS_NETWORK: Network = 'regtest';
