/**
 * ModeBRemoteController — the advanced-mode mobile experience over LNC.
 *
 * The phone NEVER embeds a node (spec-locked: mobile Mode B is LNC-only).
 * Every RPC flows through the `LncRpcPort` — in production an adapter over
 * `@lightninglabs/lnc-rn`'s pairing phrase client (PAKE + Noise to the user's
 * own litd); unit tests fake the port while the regtest LNC e2e proves the
 * real transport (pairing phrase, macaroon scoping, payment, revocation).
 *
 * Spec rules encoded here, not in screens:
 * - Payments are dispatched ONLY while the app is foregrounded (the engine
 *   still persists the intent before dispatch — shared PaymentEngine).
 * - Operations that require node liveness (channel open/close, force-close
 *   safety) are gated out on mobile and labeled desktop-only.
 * - The UI renders the macaroon scope the session actually has: a session
 *   that cannot read the wallet sees disabled actions, not errors.
 */

import type { PaymentIntent, ReconcileResult } from '@sovereign/payments';
import {
  PaymentEngine,
  InMemoryPaymentIntentStore,
} from '@sovereign/payments';
import type { DispatchOutcome } from '@sovereign/payments';
import type { PaymentDispatcher } from '@sovereign/payments';
import { LNC_REMOTE_DECLARATION } from '@sovereign/wallet-core';
import { remoteLndCapabilities } from './capabilities.js';
import type { MobileWalletCapabilities } from './capabilities.js';
import {
  createNavigation,
  currentEntry,
  handleBack,
  navigateTo,
  selectTab as selectNavTab,
} from './navigation.js';
import type { NavigationState, PrimaryTab } from './navigation.js';
import { NO_PLATFORM_SERVICES } from './platform.js';
import type { PlatformServices } from './platform.js';
import { decodeBolt11, invoiceAmountSat, knownBitcoinNetwork, parseDestination, unknownNetworkReason } from './destination.js';
import type { BitcoinNetwork, Bolt11Invoice } from './destination.js';
import { lightningFeeCapSat } from './preferences.js';
import type { Preferences } from './preferences.js';
import { RemoteAssetStore, assetsSurface } from './assets.js';
import type { AssetsPortExtension } from './assets.js';
import { RemoteChannelStore } from './liquidity.js';
import type { ChannelPortExtension } from './liquidity.js';
import { RemoteSwapStore, loopSurface } from './transfers.js';
import type { LoopPortExtension, MoneyRoute, TransferAuthorizer } from './transfers.js';

/** What the port reports after a successful pairing handshake. */
export interface RemoteNodeInfo {
  readonly identityPubkey: string;
  readonly alias: string;
  readonly version: string;
  readonly network: string;
  readonly blockHeight: number;
}

/** Channel view from the remote node — rendered, never merged with Mode A. */
export interface RemoteChannelSummary {
  readonly chanId: string;
  readonly active: boolean;
  readonly localSat: bigint;
  readonly remoteSat: bigint;
  readonly capacitySat: bigint;
}

export interface RemoteBalances {
  /** Sum of local channel balances — Lightning-spendable, in satoshis. */
  readonly lightningSpendableSat: bigint;
  /** Confirmed on-chain balance of the remote node's wallet, in satoshis. */
  readonly onchainConfirmedSat: bigint;
  readonly channels: readonly RemoteChannelSummary[];
}

/**
 * One Lightning payment (outgoing) or invoice (incoming) as the remote node
 * reports it. Status mapping from LND:
 * - payments (lnrpc.Payment.status): IN_FLIGHT → pending, SUCCEEDED → settled, FAILED → failed;
 * - invoices (lnrpc.Invoice.state): OPEN → open, ACCEPTED → pending,
 *   SETTLED → settled, CANCELED → canceled (cancelled or expired).
 */
export interface RemoteActivityRecord {
  /** Payment hash, hex — LND's identifier for both payments and invoices. */
  readonly paymentHash: string;
  readonly direction: 'in' | 'out';
  /** Amount paid (out) or requested/received (in), in satoshis. */
  readonly amountSat: bigint;
  /** Routing fee paid on an outgoing payment; null when not applicable or unknown. */
  readonly feeSat: bigint | null;
  readonly status: 'pending' | 'settled' | 'failed' | 'open' | 'canceled';
  /** ISO-8601 UTC creation time. */
  readonly createdAt: string;
  readonly memo: string | null;
  /** The BOLT11 request when the node returns it. */
  readonly paymentRequest: string | null;
}

/** Sessions visible through the current session (if permitted at all). */
export interface RemoteSessionSummary {
  readonly localPublicKey: string;
  readonly label: string;
  readonly state: 'in-use' | 'created' | 'revoked' | 'expired';
}

/**
 * The LNC transport port. The production adapter wraps
 * `@lightninglabs/lnc-rn`; nothing in this file (or the tests) imports it —
 * the same structural-port pattern as the Mode A controller.
 */
export interface LncRpcPort extends ChannelPortExtension, LoopPortExtension, AssetsPortExtension {
  /**
   * True only for a test stand-in (`SimulatedLncPort`): screens then label
   * every Loop, liquidity and asset result as simulated. A real adapter
   * leaves it undefined.
   */
  readonly simulated?: boolean;

  /** PAKE + Noise pairing with a 10-word phrase; resolves once RPCs flow. */
  connect(pairingPhraseWords: readonly string[]): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Connection lifecycle events (e.g. a revoked session drops mid-flight). */
  onConnectionEvent(listener: (event: LncConnectionEvent) => void): () => void;

  getInfo(): Promise<RemoteNodeInfo>;
  getBalances(): Promise<RemoteBalances>;

  /**
   * `valueSat` 0n = an amountless invoice (the payer chooses). Adapters pass
   * `expirySeconds` as lnrpc.Invoice `expiry`; omitted = the node's default.
   */
  addInvoice(request: { valueSat: bigint; memo?: string; expirySeconds?: number }): Promise<{ bolt11: string }>;
  /**
   * Resolves at terminal state; `sent`/`timeout` stay in-flight for recovery.
   * Adapters pass `timeoutSeconds` and `feeLimitSat` to routerrpc
   * SendPaymentV2 (`timeout_seconds`, `fee_limit_sat`); the node refuses
   * routes above the fee limit. Omitted `feeLimitSat` = the node's default.
   * Throw `PaymentNotDispatchedError` only for a refusal before anything
   * was sent; any other throw keeps the payment in-flight (ambiguous).
   */
  payInvoice(request: { bolt11: string; timeoutSeconds: number; feeLimitSat?: number }): Promise<{
    outcome: DispatchOutcome;
  }>;
  /** Recovery lookup by payment hash — never dispatches (engine contract). */
  lookupPayment(paymentHashHex: string): Promise<ReconcileResult>;

  /**
   * Lightning payments and invoices, newest first, at most `maxItems`.
   * Optional: present when the adapter implements it and the session's
   * macaroon can read them. The lnc-rn adapter merges
   * `lightning.listPayments({ includeIncomplete: true, reversed: true })`
   * and `lightning.listInvoices({ reversed: true })`.
   */
  listLightningActivity?(request: { readonly maxItems: number }): Promise<readonly RemoteActivityRecord[]>;

  /** Present only when the session's macaroon can read litd sessions. */
  listSessions?(): Promise<readonly RemoteSessionSummary[]>;
  /** Revoke a session (usually the current one) — requires the permission. */
  revokeSession?(localPublicKey: string): Promise<void>;
}

export type LncConnectionEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'revoked' };

/**
 * Ops that need the node to be alive and interactive for channel safety.
 * The mobile wallet hides these behind a desktop-only label rather than
 * exposing them over a connection that can gap in the background.
 */
export const LIVENESS_REQUIRED_OPS = [
  'open-channel',
  'close-channel',
  'force-close-channel',
] as const;

export type LivenessRequiredOp = (typeof LIVENESS_REQUIRED_OPS)[number];

export function isDesktopOnly(op: string): op is LivenessRequiredOp {
  return (LIVENESS_REQUIRED_OPS as readonly string[]).includes(op);
}

export const DESKTOP_ONLY_DISCLOSURE =
  'Channel safety operations need a live, continuously connected node — do them from the desktop app.';

/** 10-word pairing phrase — exactly 10, matching litd's mnemonic format. */
export function validatePairingPhrase(text: string): 'ok' | 'wrong-word-count' {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length === 10 ? 'ok' : 'wrong-word-count';
}

/**
 * Thrown by an `LncRpcPort.payInvoice` adapter ONLY when it refused the
 * payment before sending anything to the node (not connected, request
 * rejected on the phone). The dispatcher treats it as a definitive failure;
 * any other throw is treated as ambiguous (the node may be paying).
 */
export class PaymentNotDispatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotDispatchedError';
  }
}

export class ModeBRemoteError extends Error {
  constructor(
    readonly code:
      | 'not-connected'
      | 'wrong-word-count'
      | 'backgrounded'
      | 'revoked'
      | 'session-permission-denied'
      | 'port-error',
    message: string,
  ) {
    super(message);
    this.name = 'ModeBRemoteError';
  }
}

/** Screens shown once paired — they live on the tab stacks. */
export type ModeBRoute =
  | 'home'
  | 'activity'
  | 'send'
  | 'receive'
  | 'wallet'
  /** One activity record's receipt; params: `{ id }` (see `flows/activity.ts`). */
  | 'transaction'
  /** Liquidity, Transfers & swaps, Loop progress, Taproot Assets (see `flows/transfers.ts`). */
  | MoneyRoute
  /** Wallet tab settings sub-screens (see `ui/wallet/routes.ts`). */
  | 'walletGeneral'
  | 'walletPayments'
  | 'walletSecurity'
  | 'walletBackup'
  | 'walletPrivacy'
  | 'walletNetwork'
  | 'walletManage';

/** Connection-phase screens (no tab bar). */
export type ModeBPhaseScreen = 'pairing' | 'connecting' | 'revoked';

export type ModeBRemoteScreen = ModeBPhaseScreen | ModeBRoute;

export const MODE_B_ROOTS: Readonly<Record<PrimaryTab, ModeBRoute>> = {
  home: 'home',
  activity: 'activity',
  send: 'send',
  receive: 'receive',
  wallet: 'wallet',
};

const MODE_B_PHASES: readonly ModeBPhaseScreen[] = ['pairing', 'connecting', 'revoked'];

export function isModeBPhaseScreen(screen: ModeBRemoteScreen): screen is ModeBPhaseScreen {
  return MODE_B_PHASES.some((p) => p === screen);
}

/** How many activity records one read asks the node for. */
export const REMOTE_ACTIVITY_PAGE = 100;

export interface ModeBRemoteState {
  /** The visible screen: a phase screen, or the top of the active tab's stack. */
  readonly screen: ModeBRemoteScreen;
  /** Tab navigation once paired; null on the connection-phase screens. */
  readonly nav: NavigationState<ModeBRoute> | null;
  readonly busy: boolean;

  // Pairing — the 10-word phrase lives only in this field, never persisted.
  readonly phraseText: string;
  readonly phraseValidation: 'ok' | 'wrong-word-count' | null;
  readonly connectError: string | null;

  // Home — rendered from the remote node's live data.
  readonly node: RemoteNodeInfo | null;
  readonly balances: RemoteBalances | null;
  readonly sessionLabel: string | null;

  // Send — foreground rule is visible in the UI, not silent.
  readonly foregrounded: boolean;
  readonly sendBolt11Text: string;
  /** `in-flight` = dispatched, result not final; the screen offers "Check status", never a resend. */
  readonly sendStatus: 'idle' | 'review' | 'sending' | 'in-flight' | 'settled' | 'failed';
  readonly sendError: string | null;
  /** What the review shows and the confirm dispatches (set with `sendStatus: 'review'`). */
  readonly sendReview: RemoteSendReview | null;
  /** Filled after a settled payment, from the node's own record when it can be read. */
  readonly sendReceipt: RemoteSendReceipt | null;

  // Receive
  readonly invoiceAmountText: string;
  readonly invoiceMemoText: string;
  readonly invoice: string | null;
  readonly invoiceError: string | null;

  // Activity — Lightning payments and invoices read from the node.
  readonly activity: readonly RemoteActivityRecord[] | null;
  /** 'unavailable' = this port/session cannot read history (see capabilities). */
  readonly activityStatus: 'idle' | 'loading' | 'loaded' | 'failed' | 'unavailable';
  readonly activityError: string | null;
}

const INITIAL_STATE: ModeBRemoteState = {
  screen: 'pairing',
  nav: null,
  busy: false,
  phraseText: '',
  phraseValidation: null,
  connectError: null,
  node: null,
  balances: null,
  sessionLabel: null,
  foregrounded: true,
  sendBolt11Text: '',
  sendStatus: 'idle',
  sendError: null,
  sendReview: null,
  sendReceipt: null,
  invoiceAmountText: '',
  invoiceMemoText: '',
  invoice: null,
  invoiceError: null,
  activity: null,
  activityStatus: 'idle',
  activityError: null,
};

export interface ModeBRemoteControllerOptions {
  readonly port: LncRpcPort;
  /**
   * The node's network name. Known names (mainnet/bitcoin, testnet/
   * testnet4, signet, regtest) are mapped by `knownBitcoinNetwork`; any
   * other name is an explicit unknown and sending is refused with the reason.
   */
  readonly network: string;
  readonly pollIntervalMs?: number;
  /** Injected device services; capability derivation reads which exist. */
  readonly platform?: PlatformServices;
  /**
   * Device authorization before a swap or asset send starts (app lock /
   * biometrics). Absent → the review screen's confirm is the only step, and
   * the screen says so.
   */
  readonly authorizeTransfer?: TransferAuthorizer;
}

/** Fixed when a payment carries no timeout of its own (the pre-preference default). */
export const DEFAULT_REMOTE_PAYMENT_TIMEOUT_SECONDS = 60;

/** What the Mode B review shows — decoded on the phone, nothing invented. */
export interface RemoteSendReview {
  readonly invoice: Bolt11Invoice;
  /** Whole sats (rounded up from msat). */
  readonly amountSat: bigint;
  /** The most routing fee the node may pay (sent as `fee_limit_sat`). */
  readonly feeLimitSat: bigint;
  /** Sent as `timeout_seconds`. */
  readonly timeoutSeconds: number;
}

export interface RemoteSendReceipt {
  readonly amountSat: bigint;
  /** The routing fee the node reports; null when it could not be read. */
  readonly feeSat: bigint | null;
  readonly paymentHash: string;
  /** Epoch ms when the node reported the payment settled. */
  readonly completedAt: number;
}

/** The persisted payload of a Mode B Lightning intent (JSON-safe: numbers, not bigint). */
interface RemoteInvoicePayload {
  readonly bolt11: string;
  readonly feeLimitSat?: number;
  readonly timeoutSeconds?: number;
}

/** Bridge: the shared engine's dispatcher contract onto the LNC port. */
export class LncPaymentDispatcher implements PaymentDispatcher {
  /** Definitive failure reasons by intent id — the engine's intent carries none. */
  private readonly failures = new Map<string, string>();
  /** Errors thrown after the request may have reached the node, by intent id. */
  private readonly uncertain = new Map<string, string>();

  constructor(private readonly port: LncRpcPort) {}

  prepare(intent: Readonly<PaymentIntent>): Promise<{ backendRef: string }> {
    const { bolt11 } = readInvoicePayload(intent);
    return Promise.resolve({ backendRef: hashHex(bolt11) });
  }

  async dispatch(
    intent: Readonly<PaymentIntent>,
    _backendRef: string,
  ): Promise<DispatchOutcome> {
    let payload: RemoteInvoicePayload;
    try {
      payload = readInvoicePayload(intent);
    } catch (error) {
      // Validation on the phone, before any RPC: nothing was sent.
      const reason = describeError(error);
      this.failures.set(intent.intentId, reason);
      return { status: 'definitive-failure', reason };
    }
    try {
      const { outcome } = await this.port.payInvoice({
        bolt11: payload.bolt11,
        timeoutSeconds: payload.timeoutSeconds ?? DEFAULT_REMOTE_PAYMENT_TIMEOUT_SECONDS,
        ...(payload.feeLimitSat === undefined ? {} : { feeLimitSat: payload.feeLimitSat }),
      });
      if (outcome.status === 'definitive-failure') this.failures.set(intent.intentId, outcome.reason);
      return outcome;
    } catch (error) {
      const reason = describeError(error);
      if (error instanceof PaymentNotDispatchedError) {
        // The port says the request never left the phone.
        this.failures.set(intent.intentId, reason);
        return { status: 'definitive-failure', reason };
      }
      // Anything else (dropped connection, transport timeout, a stream that
      // closed mid-payment) may have reached the node, which keeps paying on
      // its own. Ambiguous: the intent stays in-flight and is reconciled by
      // `lookupPayment` — never failed, never re-dispatched.
      this.uncertain.set(intent.intentId, reason);
      return { status: 'timeout' };
    }
  }

  /** Why the node refused this intent's payment; null when it did not say (or did not fail). */
  failureReason(intentId: string): string | null {
    return this.failures.get(intentId) ?? null;
  }

  /** The error that left this intent's outcome unknown; null when none. */
  uncertainReason(intentId: string): string | null {
    return this.uncertain.get(intentId) ?? null;
  }

  async lookup(intent: Readonly<PaymentIntent>) {
    const ref = intent.backendRef ?? '';
    // lnd has no terminal 'not-found' for a payment hash we just derived —
    // an unknown result keeps the intent in needs-recovery, which surfaces
    // to the user instead of ever re-dispatching (engine contract).
    if (ref === '') return { status: 'unknown' as const };
    return this.port.lookupPayment(ref);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readInvoicePayload(intent: Readonly<PaymentIntent>): RemoteInvoicePayload {
  const payload = intent.payload;
  if (!isRecord(payload) || typeof payload.bolt11 !== 'string' || payload.bolt11 === '') {
    throw new ModeBRemoteError('port-error', 'payment intent has no bolt11 payload');
  }
  const { feeLimitSat, timeoutSeconds } = payload;
  return {
    bolt11: payload.bolt11,
    ...(typeof feeLimitSat === 'number' ? { feeLimitSat } : {}),
    ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
  };
}

function hashHex(text: string): string {
  // 32-byte reconciliation key for the invoice, persisted BEFORE dispatch;
  // lookups reconcile by it. The invoice's own payment hash when it decodes
  // (what LND tracks the payment by); otherwise sha256 of the request string,
  // deterministic and dependency-free.
  const decoded = decodeBolt11(text);
  return decoded.ok ? decoded.invoice.paymentHash : sha256Hex(text);
}

export function sha256Hex(text: string): string {
  // Synchronous Web Crypto is unavailable on Hermes — a compact sha256
  // implementation keeps the engine contract without native deps.
  const K = SHA256_K;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes: number[] = [];
  for (const ch of encodeUtf8(text)) bytes.push(ch);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / 2 ** (8 * i)) & 0xff);

  const w: number[] = new Array<number>(64).fill(0);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[off + i * 4] ?? 0) << 24) |
        ((bytes[off + i * 4 + 1] ?? 0) << 16) |
        ((bytes[off + i * 4 + 2] ?? 0) << 8) |
        (bytes[off + i * 4 + 3] ?? 0);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function encodeUtf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63),
      );
  }
  return out;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export class ModeBRemoteController {
  readonly network: string;
  private readonly port: LncRpcPort;
  private readonly engine: PaymentEngine;
  private readonly pollIntervalMs: number;
  private readonly platform: PlatformServices;
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private state: ModeBRemoteState = INITIAL_STATE;
  /** Loop terms, quotes, swaps and progress (own subscription; see flows/transfers.ts). */
  readonly swaps: RemoteSwapStore;
  /** Taproot Assets read and moved over this connection (flows/assets.ts). */
  readonly assets: RemoteAssetStore;
  /** Detailed channel liquidity (flows/liquidity.ts). */
  readonly channels: RemoteChannelStore;

  constructor(options: ModeBRemoteControllerOptions) {
    this.port = options.port;
    this.network = options.network;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.platform = options.platform ?? NO_PLATFORM_SERVICES;
    const isForegrounded = (): boolean => this.state.foregrounded;
    this.swaps = new RemoteSwapStore({
      port: this.port,
      network: options.network,
      isForegrounded,
      authorize: options.authorizeTransfer,
      onSwapChanged: () => {
        void this.refresh().catch(() => undefined);
        void this.channels.load();
      },
    });
    this.assets = new RemoteAssetStore({
      port: this.port,
      network: options.network,
      isForegrounded,
      authorize: options.authorizeTransfer,
    });
    this.channels = new RemoteChannelStore(this.port);
    this.dispatcher = new LncPaymentDispatcher(this.port);
    this.intents = new InMemoryPaymentIntentStore();
    this.engine = new PaymentEngine({
      store: this.intents,
      dispatcher: this.dispatcher,
      newId: () => globalThis.crypto.randomUUID(),
    });
  }

  private readonly dispatcher: LncPaymentDispatcher;
  private readonly intents: InMemoryPaymentIntentStore;
  /** The intent of the current send — the reconcile key for "Check status". */
  private pendingIntentId: string | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ModeBRemoteState => this.state;

  /** True when the port is a test stand-in; screens label its results simulated. */
  isSimulated = (): boolean => this.port.simulated === true;

  capabilities = () =>
    ({
      lightningMechanism: 'channels' as const,
      recoveryModel: 'remote-macaroon' as const,
      // The phone hosts no node — balances and history live on the user's litd.
      note: 'Connected to your own node over Lightning Node Connect.',
    });

  private capsCache: { state: ModeBRemoteState; caps: MobileWalletCapabilities } | undefined;

  /**
   * What this connection can do right now — the remote-node declaration,
   * narrowed to what the LNC port actually implements (feature detection)
   * and the connection/foreground state. Stable identity per state.
   */
  walletCapabilities = (): MobileWalletCapabilities => {
    const state = this.state;
    if (this.capsCache?.state === state) return this.capsCache.caps;
    const caps = remoteLndCapabilities({
      declared: LNC_REMOTE_DECLARATION.capabilities,
      connected: state.nav !== null && this.port.isConnected(),
      foregrounded: state.foregrounded,
      port: {
        listLightningActivity: typeof this.port.listLightningActivity === 'function',
        listSessions: typeof this.port.listSessions === 'function',
        revokeSession: typeof this.port.revokeSession === 'function',
        listChannels: typeof this.port.listChannels === 'function',
        loop: loopSurface(this.port).run,
        loopMonitor: loopSurface(this.port).monitor,
        assets: assetsSurface(this.port).list,
      },
      platform: this.platform,
    });
    this.capsCache = { state, caps };
    return caps;
  };

  /** Starts event + poll loops once paired. Safe to call again on repair. */
  start(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = this.port.onConnectionEvent((event) => {
      if (event.type === 'revoked') {
        void this.handleRevoked();
      }
    });
    this.pollTimer = setInterval(() => void this.refresh().catch(() => undefined), this.pollIntervalMs);
  }

  stop(): void {
    this.swaps.stop();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  // --- pairing -------------------------------------------------------------

  enterPairingPhrase(text: string): void {
    this.set({
      phraseText: text,
      phraseValidation: validatePairingPhrase(text) === 'ok' ? 'ok' : 'wrong-word-count',
    });
  }

  async pair(): Promise<void> {
    if (validatePairingPhrase(this.state.phraseText) !== 'ok') {
      this.set({ phraseValidation: 'wrong-word-count' });
      throw new ModeBRemoteError('wrong-word-count', 'A pairing phrase is exactly 10 words.');
    }
    this.set({ screen: 'connecting', busy: true, connectError: null });
    try {
      await this.port.connect(this.state.phraseText.trim().split(/\s+/));
      const [node, balances] = await Promise.all([this.port.getInfo(), this.port.getBalances()]);
      // The phrase is consumed the moment RPCs flow — never kept in memory.
      const nav = createNavigation(MODE_B_ROOTS, 'home');
      this.set({ phraseText: '', phraseValidation: null, nav, screen: 'home', busy: false, node, balances });
      this.start();
    } catch (error) {
      this.set({
        screen: 'pairing',
        busy: false,
        connectError: describeError(error),
      });
      throw error instanceof ModeBRemoteError
        ? error
        : new ModeBRemoteError('port-error', describeError(error));
    }
  }

  // --- home / refresh ------------------------------------------------------

  async refresh(): Promise<void> {
    if (!this.port.isConnected()) return;
    const [node, balances] = await Promise.all([this.port.getInfo(), this.port.getBalances()]);
    if (this.state.nav !== null) {
      this.set({ node, balances });
    }
  }

  /**
   * Goes to a screen. Phase screens leave the tabs; a tab's root switches to
   * that tab (keeping its stack); other screens push onto the active tab.
   */
  navigate(screen: ModeBRemoteScreen, params?: Readonly<Record<string, string>>): void {
    if (isModeBPhaseScreen(screen)) {
      this.set({ screen, nav: null });
      return;
    }
    const nav = this.state.nav ?? createNavigation(MODE_B_ROOTS, 'home');
    this.setNav(navigateTo(nav, MODE_B_ROOTS, screen, params));
  }

  /** Tab-bar selection (re-tapping the active tab pops it to its root). */
  selectTab(tab: PrimaryTab): void {
    if (this.state.nav === null) return;
    this.setNav(selectNavTab(this.state.nav, tab));
  }

  /** Back control and Android hardware back. False = nothing to go back to. */
  goBack(): boolean {
    if (this.state.nav === null) return false;
    const { nav, handled } = handleBack(this.state.nav);
    if (handled) this.setNav(nav);
    return handled;
  }

  private setNav(nav: NavigationState<ModeBRoute>): void {
    const screen = currentEntry(nav).route;
    const entering = screen !== this.state.screen;
    this.set({ nav, screen });
    if (entering && screen === 'home') void this.refresh().catch(() => undefined);
    if (entering && screen === 'activity') void this.loadActivity();
  }

  // --- activity ------------------------------------------------------------

  /**
   * Reads Lightning payments and invoices from the node. A port without
   * `listLightningActivity` is reported as unavailable — never as "no activity".
   */
  async loadActivity(): Promise<void> {
    const list = this.port.listLightningActivity;
    if (list === undefined) {
      this.set({ activityStatus: 'unavailable', activityError: null });
      return;
    }
    this.set({ activityStatus: 'loading', activityError: null });
    try {
      const activity = await list.call(this.port, { maxItems: REMOTE_ACTIVITY_PAGE });
      this.set({ activity, activityStatus: 'loaded' });
    } catch (error) {
      this.set({ activityStatus: 'failed', activityError: describeError(error) });
    }
  }

  // --- foreground rule -----------------------------------------------------

  /**
   * The host app calls this on foreground/background transitions. Payments
   * made in the background are refused BEFORE the engine authorizes anything.
   */
  setForegrounded(foregrounded: boolean): void {
    this.set({ foregrounded });
  }

  // --- send ----------------------------------------------------------------

  editSendDestination(bolt11: string): void {
    this.set({ sendBolt11Text: bolt11, sendError: null });
  }

  /**
   * Review step: decodes the pasted invoice on the phone (network, amount,
   * description, expiry — the signature is checked by the node when it
   * pays) and fixes the fee limit and timeout from the user's preferences.
   * Nothing reaches the node. Errors land in `sendError` with status idle.
   */
  reviewSend(
    preferences: Preferences,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): void {
    const network = this.networkId();
    if (network === null) {
      this.set({ sendStatus: 'idle', sendError: unknownNetworkReason(this.network), sendReview: null });
      return;
    }
    const parsed = parseDestination(this.state.sendBolt11Text, network);
    if (!parsed.ok) {
      this.set({ sendStatus: 'idle', sendError: parsed.error.message, sendReview: null });
      return;
    }
    const invoice = parsed.destination.lightning;
    if (invoice === null) {
      this.set({
        sendStatus: 'idle',
        sendError: "On-chain sending isn't available over this connection yet. Paste a Lightning invoice.",
        sendReview: null,
      });
      return;
    }
    const amountSat = invoiceAmountSat(invoice);
    if (amountSat === null) {
      this.set({
        sendStatus: 'idle',
        sendError:
          "This invoice doesn't say how much to pay, and this connection can't add an amount yet. Ask the recipient for an invoice with an amount.",
        sendReview: null,
      });
      return;
    }
    if (nowSec >= invoice.expiresAt) {
      this.set({ sendStatus: 'idle', sendError: 'This invoice expired. Ask the recipient for a new one.', sendReview: null });
      return;
    }
    this.set({
      sendStatus: 'review',
      sendError: null,
      sendReceipt: null,
      sendReview: {
        invoice,
        amountSat,
        feeLimitSat: lightningFeeCapSat(preferences, amountSat),
        timeoutSeconds: preferences.paymentTimeoutSeconds,
      },
    });
  }

  /** "Back to edit" from Review. */
  editSend(): void {
    // A payment that was handed to the node can't be edited back into a draft.
    if (this.state.sendStatus === 'sending' || this.state.sendStatus === 'in-flight') return;
    this.set({ sendStatus: 'idle', sendReview: null, sendError: null });
  }

  /** "Send another" / "Done": clears the draft and the last result. */
  resetSend(): void {
    this.pendingIntentId = undefined;
    this.set({ sendStatus: 'idle', sendReview: null, sendReceipt: null, sendError: null, sendBolt11Text: '' });
  }

  /** Confirms the reviewed payment — the fee limit and timeout ride in the persisted intent. */
  async confirmSend(): Promise<void> {
    const review = this.state.sendReview;
    // Only a payment on Review can be confirmed. A second tap while one is
    // sending (or after it finished) is ignored: it must not dispatch again
    // nor overwrite the in-flight state with "failed".
    if (this.state.sendStatus !== 'review') return;
    if (review === null) {
      this.set({ sendStatus: 'failed', sendError: 'No reviewed payment to send.' });
      return;
    }
    await this.dispatchInvoice(
      { bolt11: review.invoice.invoice, feeLimitSat: Number(review.feeLimitSat), timeoutSeconds: review.timeoutSeconds },
      review,
    ).catch(() => undefined);
  }

  /**
   * Pays the draft invoice without a review step (kept for callers that
   * already reviewed elsewhere). The screens use `reviewSend` → `confirmSend`.
   */
  async send(): Promise<void> {
    await this.dispatchInvoice({ bolt11: this.state.sendBolt11Text.trim() }, null);
  }

  private async dispatchInvoice(payload: RemoteInvoicePayload, review: RemoteSendReview | null): Promise<void> {
    if (!this.state.foregrounded) {
      const error = new ModeBRemoteError(
        'backgrounded',
        'Payments run while the app is open. Reopen the app and try again.',
      );
      this.set({ sendError: error.message, sendStatus: 'failed' });
      throw error;
    }
    this.set({ sendStatus: 'sending', sendError: null });
    this.pendingIntentId = undefined;
    let intentId: string | undefined;
    try {
      // Persist-before-dispatch: submit authorizes and persists the intent;
      // execute dispatches exactly once and reconciles on any ambiguity.
      const intent = await this.engine.submit('lightning-invoice', payload, payload.feeLimitSat);
      intentId = intent.intentId;
      this.pendingIntentId = intentId;
      const executed = await this.engine.execute(intentId);
      await this.applyPaymentState(executed.state, intentId, review);
    } catch (error) {
      if (intentId === undefined) {
        // submit refused it: nothing was persisted for dispatch.
        this.set({ sendStatus: 'failed', sendError: describeError(error) });
        throw error;
      }
      // Thrown once the intent existed: the request may have reached the
      // node. Go by what the intent store recorded; anything past
      // `authorized` stays in-flight for "Check status".
      const persisted = await this.intents.get(intentId).catch(() => undefined);
      if (persisted?.state === 'authorized') {
        this.pendingIntentId = undefined;
        this.set({ sendStatus: 'failed', sendError: describeError(error) });
        throw error;
      }
      this.set({ sendStatus: 'in-flight', sendError: unconfirmedMessage(describeError(error)) });
    }
  }

  /**
   * "Check status" for a payment whose result was not final: looks it up on
   * the node by payment hash (the engine's recovery path) — never re-sends.
   */
  async checkPaymentStatus(): Promise<void> {
    const intentId = this.pendingIntentId;
    if (intentId === undefined || this.state.sendStatus !== 'in-flight') return;
    this.set({ busy: true });
    try {
      await this.engine.recoverInterrupted();
      const intent = await this.intents.get(intentId);
      this.set({ busy: false });
      await this.applyPaymentState(intent?.state ?? 'needs-recovery', intentId, this.state.sendReview);
    } catch (error) {
      this.set({ busy: false, sendError: `The status could not be read: ${describeError(error)}` });
    }
  }

  private async applyPaymentState(
    state: PaymentIntent['state'],
    intentId: string,
    review: RemoteSendReview | null,
  ): Promise<void> {
    if (state === 'settled') {
      this.set({ sendStatus: 'settled', sendError: null, sendBolt11Text: '' });
      void this.refresh().catch(() => undefined);
      if (review !== null) await this.readReceipt(review);
      if (this.state.activityStatus === 'loaded') void this.loadActivity();
      return;
    }
    if (state === 'failed') {
      const reason = this.dispatcher.failureReason(intentId);
      this.set({ sendStatus: 'failed', sendError: reason === null ? 'Payment failed.' : `Payment failed: ${reason}` });
      return;
    }
    // in-flight / needs-recovery: the node may still complete it.
    this.set({ sendStatus: 'in-flight', sendError: unconfirmedMessage(this.dispatcher.uncertainReason(intentId)) });
  }

  /** Receipt fee from the node's own payment record, when history can be read. */
  private async readReceipt(review: RemoteSendReview): Promise<void> {
    const base: RemoteSendReceipt = {
      amountSat: review.amountSat,
      feeSat: null,
      paymentHash: review.invoice.paymentHash,
      completedAt: Date.now(),
    };
    this.set({ sendReceipt: base });
    const list = this.port.listLightningActivity;
    if (list === undefined) return;
    try {
      const records = await list.call(this.port, { maxItems: REMOTE_ACTIVITY_PAGE });
      const record = records.find(
        (r) => r.direction === 'out' && (r.paymentHash === review.invoice.paymentHash || r.paymentRequest === review.invoice.invoice),
      );
      if (record !== undefined) this.set({ sendReceipt: { ...base, amountSat: record.amountSat, feeSat: record.feeSat } });
    } catch {
      // The payment settled; a failed history read only leaves the fee unknown.
    }
  }

  /** The configured network; null when the name isn't recognized (never assumed to be mainnet). */
  private networkId(): BitcoinNetwork | null {
    return knownBitcoinNetwork(this.network);
  }

  // --- receive -------------------------------------------------------------

  editInvoiceAmount(text: string): void {
    this.set({ invoiceAmountText: text, invoiceError: null });
  }

  editInvoiceMemo(text: string): void {
    this.set({ invoiceMemoText: text, invoiceError: null });
  }

  /**
   * Creates an invoice on the node. Without options the amount comes from
   * the sats-only draft. The Receive screen passes `amountSat` parsed in
   * the user's denomination (null = amountless, the payer chooses) and
   * `expirySeconds` from the invoice-expiry preference.
   */
  async createInvoice(options: { amountSat?: bigint | null; expirySeconds?: number } = {}): Promise<void> {
    const sat = options.amountSat !== undefined ? options.amountSat ?? 0n : parseSats(this.state.invoiceAmountText);
    if (sat === null) {
      // Nothing reaches the node; the screen says what is missing.
      this.set({ invoiceError: 'Enter a whole number of sats to create an invoice.' });
      return;
    }
    const memo = this.state.invoiceMemoText.trim();
    this.set({ busy: true });
    try {
      const { bolt11 } = await this.port.addInvoice({
        valueSat: sat,
        memo: memo === '' ? 'Mode B receive' : memo,
        ...(options.expirySeconds === undefined ? {} : { expirySeconds: options.expirySeconds }),
      });
      this.set({ busy: false, invoice: bolt11, invoiceError: null });
      if (this.state.activityStatus === 'loaded') void this.loadActivity();
    } catch (error) {
      this.set({ busy: false, invoiceError: describeError(error) });
      throw error;
    }
  }

  // --- sessions ------------------------------------------------------------

  async revokeCurrentSession(localPublicKey: string): Promise<void> {
    if (this.port.revokeSession === undefined) {
      throw new ModeBRemoteError(
        'session-permission-denied',
        'This session cannot manage sessions — revoke from the desktop app.',
      );
    }
    await this.port.revokeSession(localPublicKey);
    await this.handleRevoked();
  }

  /** True while the LNC transport reports a live connection. */
  isConnected(): boolean {
    return this.port.isConnected();
  }

  /**
   * The node's LNC sessions, when this connection may read them. Throws a
   * `session-permission-denied` error when the port has no `listSessions`.
   */
  async listSessions(): Promise<readonly RemoteSessionSummary[]> {
    if (this.port.listSessions === undefined) {
      throw new ModeBRemoteError(
        'session-permission-denied',
        "This connection can't list node sessions. Manage sessions from the desktop app.",
      );
    }
    return this.port.listSessions();
  }

  /**
   * Revokes one session. When that drops this phone's own connection (it
   * was the session in use), the app moves to the revoked screen; revoking
   * another session leaves this one connected.
   */
  async revokeSession(localPublicKey: string): Promise<'this-session' | 'other-session'> {
    if (this.port.revokeSession === undefined) {
      throw new ModeBRemoteError(
        'session-permission-denied',
        "This connection can't revoke sessions. Revoke it from the desktop app.",
      );
    }
    await this.port.revokeSession(localPublicKey);
    if (!this.port.isConnected()) {
      await this.handleRevoked();
      return 'this-session';
    }
    return 'other-session';
  }

  /**
   * Ends this connection and returns to the pairing screen. The node keeps
   * the session; connecting again needs a pairing phrase (none is stored).
   */
  async disconnect(): Promise<void> {
    this.stop();
    try {
      await this.port.disconnect();
    } catch {
      // the transport may already be gone — leaving is what matters
    }
    this.set({
      screen: 'pairing',
      nav: null,
      node: null,
      balances: null,
      activity: null,
      activityStatus: 'idle',
      activityError: null,
      connectError: null,
    });
  }

  private async handleRevoked(): Promise<void> {
    this.stop();
    try {
      await this.port.disconnect();
    } catch {
      // the transport may already be gone — the state change is what matters
    }
    this.set({
      screen: 'revoked',
      nav: null,
      node: null,
      balances: null,
      activity: null,
      activityStatus: 'idle',
      activityError: null,
    });
  }

  private set(partial: Partial<ModeBRemoteState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export function parseSats(text: string): bigint | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const value = BigInt(trimmed);
  return value > 0n ? value : null;
}

/** The in-flight notice, with the connection's own error when one left the outcome unknown. */
function unconfirmedMessage(reason: string | null): string {
  const base =
    "The payment's result isn't known yet — your node may still complete it. Check its status before trying again; paying again now could pay twice.";
  return reason === null ? base : `${base} (Connection reported: ${reason})`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
