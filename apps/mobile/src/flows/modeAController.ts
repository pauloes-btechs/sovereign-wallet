/**
 * ModeAController — the everyday-mode (Wavelength) wallet state machine.
 *
 * Pure TypeScript: no react-native imports. Screens subscribe with
 * `useSyncExternalStore`; every user intent is a named method here. All
 * daemon contact flows through structural ports (satisfied by
 * `WavelengthProvider` + `PaymentEngine`), so unit tests fake the ports
 * while the regtest integration suite drives the real stack.
 *
 * Rendering rule (spec-locked): the UI renders only what the provider
 * DECLARES — capabilities and operator-dependency disclosures are read
 * from `provider.capabilities` at runtime, never hardcoded in screens.
 * The word "channel" never appears in Mode A copy; Lightning labels come
 * from `@sovereign/ui/copy` (the single source of wording).
 */

import type { PaymentIntent, PaymentKind, RecoveryReport } from '@sovereign/payments';
import type { BalanceBuckets, WalletCapabilities, WalletProvider } from '@sovereign/wallet-core';
import { assertSeedCompatible } from '@sovereign/wallet-core';
import { CrossProviderRestoreError } from '@sovereign/wallet-core';
import type {
  CreateWalletRequest,
  CreateWalletResult,
  LightningSendPayload,
  OnchainSendPayload,
  QuotedSend,
  VtxoWithState,
  WalletInfo,
} from '@sovereign/wavelength-adapter';
import { WavelengthError } from '@sovereign/wavelength-adapter';
import { hasAtRisk, hasExpiring } from '@sovereign/wavelength-adapter';

/** VTXO summary derived from the live classification — what Home renders. */
export interface VtxoSummary {
  readonly state: 'fresh' | 'expiring' | 'at-risk' | 'exiting';
  readonly operatorReachable: boolean;
  /** Hours until the earliest expiring batch; null when nothing is expiring. */
  readonly hoursToExpiry: number | null;
}

/** Why a restore was refused (mirrors the shared RecoveryFlow rejection contract). */
export interface RestoreRejection {
  code: 'cross-provider-seed' | 'invalid-words' | 'batch-expired';
  message: string;
}

export type ModeAScreen =
  | 'onboarding'
  | 'backup'
  | 'home'
  | 'send'
  | 'receive'
  | 'restore'
  | 'capabilities';

export interface ModeAState {
  readonly screen: ModeAScreen;
  readonly busy: boolean;
  /** True once the provider runtime finished starting; onboarding gates on it. */
  readonly runtimeReady: boolean;

  // Backup flow — words exist only while the backup screen is active and are
  // never persisted anywhere (cleared the moment the flow completes or leaves).
  readonly words: readonly string[] | null;
  readonly backupStep: 'show' | 'verify' | 'done';

  // Home — balances and the VTXO notice, rendered from live provider data.
  readonly balances: BalanceBuckets | null;
  readonly vtxo: VtxoSummary | null;

  // Send — a controlled draft; quotes are shown before confirming.
  readonly sendKind: 'lightning' | 'onchain';
  readonly sendDestination: string;
  readonly sendAmountText: string;
  readonly sendStatus: 'idle' | 'review' | 'sending' | 'settled' | 'failed';
  readonly sendAmountSat: bigint | null;
  readonly sendFeeSat: bigint | null;
  readonly sendError: string | null;

  // Receive — swap-based Lightning invoice or on-chain boarding address.
  readonly receiveTab: 'onchain' | 'lightning';
  readonly onchainAddress: string | null;
  readonly invoice: string | null;
  readonly receiveAmountText: string;

  // Restore — words text + password, rebuilt before VTXO batch expiry.
  readonly restoreWordsText: string;
  readonly restorePassword: string;
  readonly restoreStatus: 'entering' | 'restoring' | 'restored' | 'failed';
  readonly restoreRejection: RestoreRejection | null;
  readonly restoreSummary: { recoveredVTXOs: number; recoveryRan: boolean } | null;
}

/**
 * Structural port over `WavelengthProvider` — exactly the surface the
 * controller consumes, nothing more. Keeping it structural lets unit tests
 * fake the daemon while the real provider drives integration tests.
 */
export interface ModeAProviderPort
  extends Pick<WalletProvider, 'id' | 'capabilities' | 'seedCompatibility' | 'start' | 'stop' | 'onEvent'> {
  createWallet(request: CreateWalletRequest): Promise<CreateWalletResult>;
  walletInfo(): Promise<WalletInfo>;
  balanceBuckets(classified?: readonly VtxoWithState[]): Promise<BalanceBuckets>;
  receiveLightning(amountSat: number, memo?: string): Promise<string>;
  depositOnchain(amountSatHint?: number): Promise<string>;
  quoteLightning(input: {
    invoice: string;
    amountSat?: number;
    note?: string;
    maxFeeSat?: number;
  }): Promise<QuotedSend & { payload: LightningSendPayload }>;
  quoteOnchain(input: {
    onchainAddress: string;
    amountSat?: number;
    sweepAll?: boolean;
    note?: string;
    maxFeeSat?: number;
  }): Promise<QuotedSend & { payload: OnchainSendPayload }>;
  classifyVtxos(): Promise<readonly VtxoWithState[]>;
}

/** Structural port over the shared `PaymentEngine`. */
export interface ModeAEnginePort {
  submit(kind: PaymentKind, payload: unknown, maxFeeSat?: number): Promise<PaymentIntent>;
  execute(intentId: string): Promise<PaymentIntent>;
  recoverInterrupted(): Promise<RecoveryReport>;
}

export interface ModeAControllerPorts {
  readonly provider: ModeAProviderPort;
  readonly engine: ModeAEnginePort;
  readonly network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly dataDir: string;
}

export class ModeAController {
  private readonly provider: ModeAProviderPort;
  private readonly engine: ModeAEnginePort;
  private readonly network: ModeAControllerPorts['network'];
  private readonly dataDir: string;

  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents: (() => void) | undefined;
  private state: ModeAState = INITIAL_STATE;

  /** The intent dispatched for the current send — the reconcile key. */
  private pendingIntentId: string | undefined;
  /** The approved payload carried from review into confirm — never re-quoted. */
  private pendingPayload: LightningSendPayload | OnchainSendPayload | undefined;
  private pendingMaxFeeSat: number | undefined;

  constructor(ports: ModeAControllerPorts) {
    this.provider = ports.provider;
    this.engine = ports.engine;
    this.network = ports.network;
    this.dataDir = ports.dataDir;
  }

  // ——— React binding ———

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ModeAState => this.state;

  // ——— Declared capabilities (the UI renders these, never hardcoded copy) ———

  get capabilities(): WalletCapabilities {
    return this.provider.capabilities;
  }

  get seedCompatibility(): readonly string[] {
    return this.provider.seedCompatibility;
  }

  // ——— Lifecycle ———

  /** Starts the provider runtime, subscribes to balance events, initial refresh. */
  async start(): Promise<void> {
    await this.provider.start({ network: this.network, dataDir: this.dataDir });
    this.set({ runtimeReady: true });
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = this.provider.onEvent((event) => {
      if (
        event.type === 'balance-changed' ||
        event.type === 'vtxo-expiry-approaching' ||
        event.type === 'operator-unreachable'
      ) {
        void this.refreshBalances();
      }
    });
    await this.refreshBalances();
  }

  async stop(): Promise<void> {
    this.set({ runtimeReady: false });
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    await this.provider.stop();
  }

  // ——— Wallet creation + backup ———

  /**
   * Creates a fresh Mode A wallet. Mnemonic omitted = the daemon generates
   * the phrase; the result's words feed the backup confirmation and are then
   * dropped from memory when the flow completes.
   */
  async createWallet(password: string): Promise<void> {
    this.set({ busy: true });
    try {
      const result = await this.provider.createWallet({
        password,
        recoverState: false,
        recoveryWindow: 0,
      });
      this.set({
        busy: false,
        words: result.mnemonic,
        backupStep: 'show',
        screen: 'backup',
      });
    } catch (error) {
      this.set({ busy: false });
      throw error;
    }
  }

  acknowledgeWords(): void {
    this.set({ backupStep: 'verify' });
  }

  showWordsAgain(): void {
    this.set({ backupStep: 'show' });
  }

  /** Finishes the backup flow: words leave memory, the wallet lands on Home. */
  confirmBackup(): void {
    this.set({ words: null, backupStep: 'done', screen: 'home' });
  }

  // ——— Navigation ———

  navigate(screen: ModeAScreen): void {
    this.set({ screen });
  }

  /** Back to Home resets the transient flow state of the screen being left. */
  backToHome(): void {
    this.set({ ...RESET_FLOWS, screen: 'home' });
  }

  // ——— Home ———

  /** Reads live balances + VTXO classification from the provider. */
  async refreshBalances(): Promise<void> {
    try {
      const [classified, info] = await Promise.all([
        this.provider.classifyVtxos(),
        this.provider.walletInfo(),
      ]);
      const balances = await this.provider.balanceBuckets([...classified]);
      this.set({
        balances,
        vtxo: summarizeVtxos(classified, info.serverConnected),
      });
    } catch (error) {
      // A failed background refresh keeps the last known (labeled) values on
      // screen; the failure is surfaced, not swallowed.
      console.warn('[mode-a] balance refresh failed:', error);
    }
  }

  // ——— Send ———

  setSendKind(kind: 'lightning' | 'onchain'): void {
    this.set({ sendKind: kind, sendError: null });
  }

  setSendDestination(destination: string): void {
    this.set({ sendDestination: destination, sendError: null });
  }

  setSendAmount(text: string): void {
    this.set({ sendAmountText: text, sendError: null });
  }

  /**
   * Quotes the current draft against the live daemon (the authorization-time
   * policy point) and moves to Review. Throws from the quote (validation,
   * fee budget) land in `sendError` — nothing has been sent.
   */
  async reviewSend(maxFeeSat?: number): Promise<void> {
    const { sendKind, sendDestination, sendAmountText } = this.state;
    const amountSat = parseSats(sendAmountText);
    try {
      if (sendKind === 'lightning') {
        if (sendDestination.trim().length === 0) {
          throw new Error('Enter a Lightning invoice first.');
        }
        const quoted = await this.provider.quoteLightning({
          invoice: sendDestination.trim(),
          maxFeeSat,
        });
        this.pendingPayload = quoted.payload;
        this.pendingMaxFeeSat = maxFeeSat;
        this.set({
          sendStatus: 'review',
          sendFeeSat: BigInt(quoted.quote.expectedFeeSat),
          sendAmountSat: BigInt(quoted.quote.amountSat),
          sendError: null,
        });
      } else {
        if (sendDestination.trim().length === 0) {
          throw new Error('Enter a recipient address first.');
        }
        if (amountSat === undefined) {
          throw new Error('Enter an amount in sats first.');
        }
        const quoted = await this.provider.quoteOnchain({
          onchainAddress: sendDestination.trim(),
          amountSat,
          maxFeeSat,
        });
        this.pendingPayload = quoted.payload;
        this.pendingMaxFeeSat = maxFeeSat;
        this.set({
          sendStatus: 'review',
          sendFeeSat: BigInt(quoted.quote.expectedFeeSat),
          sendAmountSat: BigInt(quoted.quote.amountSat),
          sendError: null,
        });
      }
    } catch (error) {
      this.pendingPayload = undefined;
      this.pendingMaxFeeSat = undefined;
      this.set({ sendStatus: 'failed', sendError: errorMessage(error) });
    }
  }

  /**
   * Confirms the reviewed payment: the intent is persisted (authorized, then
   * in-flight) BEFORE dispatch — the engine guarantees persist-before-dispatch,
   * so a crash here is reconciled by `reconcilePending`, never re-dispatched.
   */
  async confirmSend(): Promise<void> {
    const payload = this.pendingPayload;
    if (payload === undefined) {
      this.set({ sendStatus: 'failed', sendError: 'No approved payment to send.' });
      return;
    }
    const kind: PaymentKind = 'invoice' in payload ? 'lightning-invoice' : 'onchain';
    this.set({ sendStatus: 'sending', sendError: null });
    try {
      const intent = await this.engine.submit(kind, payload, this.pendingMaxFeeSat);
      this.pendingIntentId = intent.intentId;
      const executed = await this.engine.execute(intent.intentId);
      await this.applySendOutcome(executed);
    } catch (error) {
      this.set({ sendStatus: 'failed', sendError: errorMessage(error) });
    }
  }

  /**
   * Crash-safe reconciliation for the current (or last) send. Never dispatches —
   * the engine looks the intent up on the backend by its payment hash.
   */
  async reconcilePending(): Promise<void> {
    const intentId = this.pendingIntentId;
    if (intentId === undefined) return;
    const report = await this.engine.recoverInterrupted();
    if (report.reconciled.includes(intentId)) {
      this.set({ sendStatus: 'settled', sendError: null });
      await this.refreshBalances();
    } else if (report.needsRecovery.includes(intentId)) {
      this.set({
        sendStatus: 'failed',
        sendError:
          'The payment could not be confirmed. Check your history before retrying — retrying now could pay twice.',
      });
    }
  }

  sendAnother(): void {
    this.pendingIntentId = undefined;
    this.pendingPayload = undefined;
    this.pendingMaxFeeSat = undefined;
    this.set({ ...RESET_SEND, screen: 'send' });
  }

  // ——— Receive ———

  setReceiveTab(tab: 'onchain' | 'lightning'): void {
    this.set({ receiveTab: tab });
  }

  setReceiveAmount(text: string): void {
    this.set({ receiveAmountText: text });
  }

  /** Fresh boarding address for an on-chain deposit into the Ark wallet. */
  async generateAddress(): Promise<void> {
    this.set({ busy: true });
    try {
      const amountHint = parseSats(this.state.receiveAmountText);
      const address = await this.provider.depositOnchain(amountHint);
      this.set({ busy: false, onchainAddress: address });
    } catch (error) {
      this.set({ busy: false });
      throw error;
    }
  }

  /**
   * Fresh Lightning invoice via the swap service — the declared mechanism
   * (`capabilities.lightningMechanism === 'swaps'`) is what the Receive
   * screen labels it with.
   */
  async generateInvoice(): Promise<void> {
    const amountSat = parseSats(this.state.receiveAmountText);
    if (amountSat === undefined) {
      throw new Error('Enter an amount in sats first.');
    }
    this.set({ busy: true });
    try {
      const invoice = await this.provider.receiveLightning(amountSat, 'Sovereign Wallet receive');
      this.set({ busy: false, invoice });
    } catch (error) {
      this.set({ busy: false });
      throw error;
    }
  }

  // ——— Restore ———

  setRestoreWords(text: string): void {
    this.set({ restoreWordsText: text, restoreRejection: null });
  }

  setRestorePassword(text: string): void {
    this.set({ restorePassword: text });
  }

  /**
   * Restores a Mode A wallet from its phrase. Two guards run before the
   * daemon sees anything: the word count, and the provider's declared seed
   * compatibility — a cross-provider phrase is refused with an explanation,
   * never partially restored. The daemon-side rebuild must complete before
   * the VTXO batch expires; a deadline failure maps to `batch-expired`.
   */
  async restore(): Promise<void> {
    const words = this.state.restoreWordsText.split(/\s+/).filter((w) => w.length > 0);
    if (words.length !== 12 && words.length !== 24) {
      this.set({
        restoreStatus: 'failed',
        restoreRejection: {
          code: 'invalid-words',
          message: 'A recovery phrase has 12 or 24 words. Count the words and try again.',
        },
      });
      return;
    }
    if (this.state.restorePassword.length === 0) {
      this.set({
        restoreStatus: 'failed',
        restoreRejection: {
          code: 'invalid-words',
          message: 'Enter the wallet password you want to use for this device.',
        },
      });
      return;
    }
    try {
      // The boundary guard: refuses a phrase type this provider does not accept.
      assertSeedCompatible(this.provider, 'mnemonic-ark');
    } catch (error) {
      if (error instanceof CrossProviderRestoreError) {
        this.set({
          restoreStatus: 'failed',
          restoreRejection: { code: 'cross-provider-seed', message: error.message },
        });
        return;
      }
      throw error;
    }

    this.set({ restoreStatus: 'restoring', restoreRejection: null });
    try {
      const result = await this.provider.createWallet({
        password: this.state.restorePassword,
        mnemonic: words,
        recoverState: true,
      });
      this.set({
        restoreStatus: 'restored',
        restoreSummary: {
          recoveredVTXOs: result.recoveredVTXOs,
          recoveryRan: result.recoveryRan,
        },
      });
      await this.refreshBalances();
    } catch (error) {
      this.set({
        restoreStatus: 'failed',
        restoreRejection: mapRestoreFailure(error),
      });
    }
  }

  // ——— internals ———

  private async applySendOutcome(executed: PaymentIntent): Promise<void> {
    switch (executed.state) {
      case 'settled':
        this.set({ sendStatus: 'settled', sendError: null });
        await this.refreshBalances();
        return;
      case 'in-flight':
        // Ambiguous by design (timeout/uncertain response) — stays in-flight
        // until a reconcile. The UI keeps the do-not-close notice up.
        this.set({ sendStatus: 'sending' });
        return;
      default:
        this.set({
          sendStatus: 'failed',
          sendError: 'The payment failed — no funds were moved. Try again when ready.',
        });
    }
  }

  private set(partial: Partial<ModeAState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

// ——— pure helpers (exported for tests) ———

const INITIAL_STATE: ModeAState = {
  screen: 'onboarding',
  busy: false,
  runtimeReady: false,
  words: null,
  backupStep: 'show',
  balances: null,
  vtxo: null,
  sendKind: 'lightning',
  sendDestination: '',
  sendAmountText: '',
  sendStatus: 'idle',
  sendAmountSat: null,
  sendFeeSat: null,
  sendError: null,
  receiveTab: 'onchain',
  onchainAddress: null,
  invoice: null,
  receiveAmountText: '',
  restoreWordsText: '',
  restorePassword: '',
  restoreStatus: 'entering',
  restoreRejection: null,
  restoreSummary: null,
};

const RESET_SEND: Partial<ModeAState> = {
  sendKind: 'lightning',
  sendDestination: '',
  sendAmountText: '',
  sendStatus: 'idle',
  sendAmountSat: null,
  sendFeeSat: null,
  sendError: null,
};

const RESET_FLOWS: Partial<ModeAState> = {
  ...RESET_SEND,
  receiveTab: 'onchain',
  onchainAddress: null,
  invoice: null,
  receiveAmountText: '',
};

/** Derives the Home screen's single VTXO summary from the classified inventory. */
export function summarizeVtxos(
  classified: readonly VtxoWithState[],
  operatorReachable: boolean,
): VtxoSummary {
  const state = hasAtRisk(classified)
    ? 'at-risk'
    : classified.some((v) => v.state === 'exiting')
      ? 'exiting'
      : hasExpiring(classified)
        ? 'expiring'
        : 'fresh';
  const expiring = classified
    .filter((v) => v.state === 'expiring' && typeof v.blocksToExpiry === 'number')
    .map((v) => v.blocksToExpiry ?? Number.POSITIVE_INFINITY);
  const minBlocks = expiring.length > 0 ? Math.min(...expiring) : null;
  return {
    state,
    operatorReachable,
    hoursToExpiry: minBlocks === null ? null : blocksToHours(minBlocks),
  };
}

/**
 * Ark batches anchor to L1 blocks (~10 min). Blocks → whole hours, rounded
 * up so the notice never under-reports the deadline.
 */
export function blocksToHours(blocks: number): number {
  return Math.max(1, Math.ceil(blocks / 6));
}

/** Strict satoshi parser: digits only, leading zeros collapsed. Undefined when empty/invalid. */
export function parseSats(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function mapRestoreFailure(error: unknown): RestoreRejection {
  if (error instanceof CrossProviderRestoreError) {
    return { code: 'cross-provider-seed', message: error.message };
  }
  if (error instanceof WavelengthError) {
    // The daemon refuses a restore that misses the VTXO batch deadline —
    // routed to the unilateral-exit fallback explanation.
    if (error.code === 'failed_precondition' || /expir/i.test(error.message)) {
      return {
        code: 'batch-expired',
        message:
          'The restore could not complete before the VTXO batch deadline. Your funds are not lost — they exit on-chain through a slower unilateral exit.',
      };
    }
    return { code: 'invalid-words', message: error.message };
  }
  return { code: 'invalid-words', message: errorMessage(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
