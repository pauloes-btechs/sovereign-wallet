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
export interface LncRpcPort {
  /** PAKE + Noise pairing with a 10-word phrase; resolves once RPCs flow. */
  connect(pairingPhraseWords: readonly string[]): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Connection lifecycle events (e.g. a revoked session drops mid-flight). */
  onConnectionEvent(listener: (event: LncConnectionEvent) => void): () => void;

  getInfo(): Promise<RemoteNodeInfo>;
  getBalances(): Promise<RemoteBalances>;

  addInvoice(request: { valueSat: bigint; memo?: string }): Promise<{ bolt11: string }>;
  /** Resolves at terminal state; `sent`/`timeout` stay in-flight for recovery. */
  payInvoice(request: { bolt11: string; timeoutSeconds: number }): Promise<{
    outcome: DispatchOutcome;
  }>;
  /** Recovery lookup by payment hash — never dispatches (engine contract). */
  lookupPayment(paymentHashHex: string): Promise<ReconcileResult>;

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

export type ModeBRemoteScreen =
  | 'pairing'
  | 'connecting'
  | 'home'
  | 'send'
  | 'receive'
  | 'revoked';

export interface ModeBRemoteState {
  readonly screen: ModeBRemoteScreen;
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
  readonly sendStatus: 'idle' | 'sending' | 'settled' | 'failed';
  readonly sendError: string | null;

  // Receive
  readonly invoiceAmountText: string;
  readonly invoice: string | null;
}

const INITIAL_STATE: ModeBRemoteState = {
  screen: 'pairing',
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
  invoiceAmountText: '',
  invoice: null,
};

export interface ModeBRemoteControllerOptions {
  readonly port: LncRpcPort;
  readonly network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  readonly pollIntervalMs?: number;
}

/** Bridge: the shared engine's dispatcher contract onto the LNC port. */
export class LncPaymentDispatcher implements PaymentDispatcher {
  constructor(private readonly port: LncRpcPort) {}

  prepare(intent: Readonly<PaymentIntent>): Promise<{ backendRef: string }> {
    const bolt11 = readInvoicePayload(intent);
    return Promise.resolve({ backendRef: hashHex(bolt11) });
  }

  async dispatch(
    intent: Readonly<PaymentIntent>,
    _backendRef: string,
  ): Promise<DispatchOutcome> {
    const bolt11 = readInvoicePayload(intent);
    try {
      const { outcome } = await this.port.payInvoice({ bolt11, timeoutSeconds: 60 });
      return outcome;
    } catch (error) {
      return { status: 'definitive-failure', reason: describeError(error) };
    }
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

function readInvoicePayload(intent: Readonly<PaymentIntent>): string {
  const payload = intent.payload as { bolt11?: unknown };
  if (typeof payload.bolt11 !== 'string' || payload.bolt11 === '') {
    throw new ModeBRemoteError('port-error', 'payment intent has no bolt11 payload');
  }
  return payload.bolt11;
}

function hashHex(text: string): string {
  // 32-byte local reconciliation key for the invoice. The engine persists it
  // BEFORE dispatch; lookups reconcile by it. (sha256 of the request string —
  // deterministic, dependency-free; the invoice's own payment hash is not
  // extractable without a bolt11 decoder on-device.)
  return sha256Hex(text);
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
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private state: ModeBRemoteState = INITIAL_STATE;

  constructor(options: ModeBRemoteControllerOptions) {
    this.port = options.port;
    this.network = options.network;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.engine = new PaymentEngine({
      store: new InMemoryPaymentIntentStore(),
      dispatcher: new LncPaymentDispatcher(this.port),
      newId: () => globalThis.crypto.randomUUID(),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ModeBRemoteState => this.state;

  capabilities = () =>
    ({
      lightningMechanism: 'channels' as const,
      recoveryModel: 'remote-macaroon' as const,
      // The phone hosts no node — balances and history live on the user's litd.
      note: 'Connected to your own node over Lightning Node Connect.',
    });

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
      this.set({ phraseText: '', phraseValidation: null, screen: 'home', busy: false, node, balances });
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
    if (this.state.screen !== 'pairing') {
      this.set({ node, balances });
    }
  }

  navigate(screen: ModeBRemoteScreen): void {
    if (screen === 'home') void this.refresh().catch(() => undefined);
    this.set({ screen });
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
    this.set({ sendBolt11Text: bolt11 });
  }

  async send(): Promise<void> {
    if (!this.state.foregrounded) {
      const error = new ModeBRemoteError(
        'backgrounded',
        'Payments run while the app is open. Reopen the app and try again.',
      );
      this.set({ sendError: error.message, sendStatus: 'failed' });
      throw error;
    }
    const bolt11 = this.state.sendBolt11Text.trim();
    this.set({ sendStatus: 'sending', sendError: null });
    try {
      // Persist-before-dispatch: submit authorizes and persists the intent;
      // execute dispatches exactly once and reconciles on any ambiguity.
      const intent = await this.engine.submit('lightning-invoice', { bolt11 });
      const settled = await this.engine.execute(intent.intentId);
      this.set({
        sendStatus: settled.state === 'settled' ? 'settled' : 'failed',
        sendBolt11Text: settled.state === 'settled' ? '' : this.state.sendBolt11Text,
        sendError: settled.state === 'settled' ? null : `Payment failed (${settled.state}).`,
      });
      if (settled.state === 'settled') void this.refresh().catch(() => undefined);
    } catch (error) {
      this.set({ sendStatus: 'failed', sendError: describeError(error) });
      throw error;
    }
  }

  // --- receive -------------------------------------------------------------

  editInvoiceAmount(text: string): void {
    this.set({ invoiceAmountText: text });
  }

  async createInvoice(): Promise<void> {
    const sat = parseSats(this.state.invoiceAmountText);
    if (sat === null) return;
    const { bolt11 } = await this.port.addInvoice({ valueSat: sat, memo: 'Mode B receive' });
    this.set({ invoice: bolt11 });
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

  private async handleRevoked(): Promise<void> {
    this.stop();
    try {
      await this.port.disconnect();
    } catch {
      // the transport may already be gone — the state change is what matters
    }
    this.set({ screen: 'revoked', node: null, balances: null });
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
