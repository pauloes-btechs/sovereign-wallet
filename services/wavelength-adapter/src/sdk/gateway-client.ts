/**
 * WavedGatewayClient — a {@link WavelengthClient} transport that talks to the
 * local waved daemon's HTTP/JSON gateway (`--rpc.gateway.listenaddr`) over
 * loopback. The desktop app loads this in its webview; the waved process
 * itself is owned by the Tauri sidecar (see daemon-lifecycle), never started
 * or stopped from here.
 *
 * Wire protocol facts below were verified against the real waved v0.2.0
 * gateway on 2026-10-30 (create, unlock, get-info, get-balance, list with
 * all three views, exit-summary, exit-plan, error envelopes). Anything not
 * verified on the wire yet is marked `UNVERIFIED-ON-WIRE` and is pinned by
 * the daemon-lifecycle integration suite as it gains an Ark operator.
 *
 * Encoding rules (verified):
 * - Unary POST-only routes; a GET to a gateway route returns 501.
 * - Requests and responses are snake_case JSON; responses are camelized here
 *   at the boundary so every consumer sees the SDK shapes.
 * - protojson int64 fields arrive as JSON strings (`"total_vtxo_amount_sat":"0"`);
 *   int32 counters arrive as numbers. All sat-amount fields are parsed here.
 * - Byte fields (`wallet_password`, `seed_passphrase`) are base64-encoded here.
 * - Daemon proto enums arrive as proto names (`"WALLET_STATE_LOCKED"`), which
 *   the SDK's `walletStateFromProto` passes through unchanged — so the mapping
 *   to the SDK's lowercase union happens HERE, not via that helper. (List
 *   `view` is numeric on the wire: 0/1=activity, 2=vtxos, 3=onchain.)
 * - `ReceiveRequest.amountSat` serializes as `amt_sat` on this gateway, not
 *   `amount_sat` (verified: `amount_sat` yields "amt_sat is required").
 * - Errors arrive as gRPC-gateway envelopes (`{code, message, details}`) with
 *   HTTP 200 (details may vary); they are converted to {@link WavelengthError}.
 * - `/readyz` gates on more than wallet readiness: a READY wallet with a
 *   disconnected Ark operator still reports 503. Wallet flows must therefore
 *   gate on `getInfo().walletState`, never on `/readyz`.
 */

import {
  WavelengthError,
  WalletState,
  walletStateFromProto,
} from './index.js';
import type {
  ActivityStreamOptions,
  Balance,
  CreateWalletRequest,
  CreateWalletResult,
  DepositRequest,
  DepositResult,
  Entry,
  EntryKind,
  ExitRequest,
  ExitResult,
  ExitStatusRequest,
  ExitStatusResult,
  ExitSummaryRequest,
  ExitSummaryResult,
  GetExitPlanRequest,
  GetExitPlanResult,
  ListRequest,
  ListResult,
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
  WalletInfo,
  WalletStatus,
  WavelengthClient,
  WavelengthEvent,
  WavelengthListener,
  WalletVTXO,
} from './index.js';

/**
 * The gateway client's own balance shape: the daemon's full lwwallet balance
 * breakdown, before the lossy mapping onto the SDK's five-field {@link Balance}.
 * The desktop Mode A UI renders its three-balance model (Lightning-spendable /
 * on-chain / locked-or-expiring) from this shape; see `mapWireBalance` for the
 * SDK mapping it also feeds.
 */
export interface WireBalance {
  /** Boarding VTXOs confirmed on the Ark chain. */
  boardingConfirmedSat: number;
  /** Boarding VTXOs not yet confirmed. */
  boardingUnconfirmedSat: number;
  /** Spendable VTXO value (Lightning-spendable in Mode A terms). */
  vtxoBalanceSat: number;
  /** Daemon-wide confirmed total across boarding, VTXOs, and the on-chain wallet. */
  totalConfirmedSat: number;
  /** Confirmed funds in the backing on-chain wallet. */
  onchainWalletConfirmedSat: number;
  /** Boarding value waiting to be swept into the shared VTXO batch. */
  boardingPendingSweepSat: number;
  /** Boarding value already swept. */
  boardingSweptSat: number;
  /** Boarding value adopted directly into the VTXO set. */
  boardingAdoptedSat: number;
  /** VTXO value pending settlement (inbound in flight). */
  vtxoPendingSat: number;
  /** VTXO value locked in unilateral exits (locked-or-expiring in Mode A terms). */
  vtxoUnilateralExitSat: number;
  /** Per-asset balances (Taproot Assets), empty when the wallet holds none. */
  assetBalances: Array<Record<string, unknown>>;
}

/** Routes used by this transport. All verified against waved v0.2.0. */
const ROUTES = {
  getInfo: '/v1/daemon/get-info',
  getBalance: '/v1/daemon/get-balance',
  createWallet: '/v1/wallet/create',
  unlockWallet: '/v1/wallet/unlock',
  deposit: '/v1/wallet/deposit',
  receive: '/v1/wallet/recv',
  prepareSend: '/v1/wallet/prepare-send',
  send: '/v1/wallet/send',
  list: '/v1/wallet/list',
  exit: '/v1/wallet/exit',
  exitSummary: '/v1/wallet/exit-summary',
  exitStatus: '/v1/daemon/get-unroll-status',
  getExitPlan: '/v1/wallet/exit-plan',
  status: '/v1/wallet/status',
} as const;

/** Wire `view` numbers, verified: 2 returns the vtxos variant, 3 onchain, 0/1 activity. */
const WIRE_VIEW = { activity: 0, vtxos: 2, onchain: 3 } as const;

/** Daemon proto enum name → SDK lowercase value (verified for wallet_state). */
const WIRE_WALLET_STATE: Record<string, WalletState> = {
  WALLET_STATE_NONE: WalletState.None,
  WALLET_STATE_LOCKED: WalletState.Locked,
  WALLET_STATE_READY: WalletState.Ready,
  WALLET_STATE_SYNCING: WalletState.Syncing,
};

/**
 * Wire-to-SDK key aliases: the gateway's snake_case acronyms camelize to a
 * different spelling than the SDK's typed keys (verified wire: `identity_pubkey`
 * → `identityPubkey`; SDK type: `identityPubKey`). Applied after `wireToCamel`
 * so values land on the keys the SDK types and consumers actually read.
 */
const WIRE_KEY_ALIASES: Record<string, string> = {
  identityPubkey: 'identityPubKey',
  recoveredBoardingUtxos: 'recoveredBoardingUTXOs',
  recoveredVtxos: 'recoveredVTXOs',
};

function applyAliases(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [from, to] of Object.entries(WIRE_KEY_ALIASES)) {
    if (from in obj && !(to in obj)) obj[to] = obj[from];
  }
  return obj;
}

/** EntryKind SDK string → proto number for request fields (`kinds`). UNVERIFIED-ON-WIRE. */
const WIRE_ENTRY_KIND: Record<EntryKind, number> = {
  send: 1,
  receive: 2,
  deposit: 3,
  exit: 4,
};

/** gRPC status codes that appear on this gateway (verified envelopes). */
const GRPC = {
  InvalidArgument: 3,
  NotFound: 5,
  FailedPrecondition: 9,
  Internal: 13,
  Unavailable: 14,
} as const;

export interface WavedGatewayClientOptions {
  /** The daemon gateway base URL, e.g. `http://127.0.0.1:10452`. Loopback only. */
  gatewayUrl: string;
  /** Injected fetch; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * HEX-ENCODED admin macaroon from the daemon data dir
   * (`<datadir>/data/<network>/admin.macaroon`). The gateway REJECTS every
   * call without it (verified waved v0.2.0: `expected 1 macaroon, got 0`),
   * including `get-info` on a fresh datadir. The macaroon is minted at
   * daemon STARTUP — before wallet creation — so it exists for every call
   * as long as the client is constructed after the sidecar boots. In the
   * desktop app the Tauri main process reads the file and hands the hex to
   * the webview; the webview never touches the filesystem.
   */
  macaroonHex?: string;
  /**
   * Activity poll interval in ms. The v0.2.0 gateway exposes no push stream,
   * so `startActivity` synthesizes `'activity'` events by polling the list
   * route and diffing entries (verified: no stream route exists in v0.2.0).
   */
  activityPollMs?: number;
}

export const DEFAULT_ACTIVITY_POLL_MS = 2_000;

/**
 * UTF-8 → base64 without Node-only globals (runs in the desktop webview).
 * The daemon's byte fields (`wallet_password`, `seed_passphrase`) are
 * base64-encoded on this transport (verified).
 */
function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Mechanical camelCase → snake_case for request fields (verified round-trip). */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Encodes an SDK camelCase request object onto the wire's snake_case JSON. */
function toWire(req: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (value === undefined) continue;
    out[toSnake(key)] = value;
  }
  return out;
}

/**
 * snake_case → camelCase key conversion, applied recursively. The SDK's own
 * `camelizeKeys` maps PASCALCASE (the facade's Go-struct JSON), but the waved
 * gateway's raw HTTP JSON is snake_case (verified: `wallet_state`,
 * `total_vtxo_amount_sat`, `identity_pubkey`) — so this transport normalizes
 * with its own converter. Do not swap in `camelizeKeys` here: it silently
 * leaves snake_case keys untouched, which misreads every response.
 */
function wireToCamel<T>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map(wireToCamel) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = wireToCamel(val);
    }
    return out as T;
  }
  return value as T;
}

/**
 * Parses a protojson int64 (JSON string or number) into a JS number. Sat
 * amounts fit in Number.MAX_SAFE_INTEGER for wallet-scale values; the SDK
 * types them as `number`.
 */
function sat(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Normalizes a daemon enum onto the SDK's string-union values. The wire may
 * carry proto names ('ENTRY_FAILURE_CODE_TIMED_OUT') or the daemon's plain
 * labels; the SDK unions are the bare lowercase values ('timed_out'), so the
 * enum-type prefix is stripped mechanically after lowercasing. Plain labels
 * pass through unchanged, and both shapes therefore land on the same value.
 */
const ENTRY_ENUM_PREFIX = /^entry_(?:kind|status|phase|request_type|failure_code)_(?=[a-z])/;

function normalizeEnum(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value.toLowerCase().replace(ENTRY_ENUM_PREFIX, '');
}

/**
 * Normalizes the raw wire progress object onto the SDK's EntryProgress
 * (all fields required; an empty field means "not applicable / not yet
 * known"). Int64 fields arrive as JSON strings on the wire, matching the
 * balance quirk sat() handles.
 */
function normalizeProgress(raw: unknown): Entry['progress'] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const p = wireToCamel<Record<string, unknown>>(raw);
  return {
    phase: normalizeEnum(p.phase),
    phaseLabel: String(p.phaseLabel ?? ''),
    paymentHash: String(p.paymentHash ?? ''),
    txid: String(p.txid ?? ''),
    confirmationHeight: sat(p.confirmationHeight),
    // The wire spells the field vtxo_outpoint; the SDK union is vTXOOutpoint.
    vTXOOutpoint: String(p.vTXOOutpoint ?? p.vtxoOutpoint ?? ''),
    preimage: String(p.preimage ?? ''),
  } as Entry['progress'];
}

/** Normalizes the raw wire request oneof view onto the SDK's EntryRequest. */
function normalizeRequest(raw: unknown): Entry['request'] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const r = wireToCamel<Record<string, unknown>>(raw);
  return {
    type: normalizeEnum(r.type),
    lightningInvoice: String(r.lightningInvoice ?? ''),
    paymentHash: String(r.paymentHash ?? ''),
    onchainAddress: String(r.onchainAddress ?? ''),
    arkAddress: String(r.arkAddress ?? ''),
  } as Entry['request'];
}

/** Normalizes a raw daemon Entry onto the SDK shape (verified structure, enums tolerant). */
function normalizeEntry(raw: Record<string, unknown>): Entry {
  const entry = wireToCamel<Record<string, unknown>>(raw);
  return {
    id: String(entry.id ?? ''),
    kind: normalizeEnum(entry.kind) as Entry['kind'],
    status: normalizeEnum(entry.status) as Entry['status'],
    amountSat: sat(entry.amountSat),
    feeSat: sat(entry.feeSat),
    counterparty: String(entry.counterparty ?? ''),
    createdAt: String(entry.createdAt ?? ''),
    updatedAt: String(entry.updatedAt ?? ''),
    note: String(entry.note ?? ''),
    failureReason: String(entry.failureReason ?? ''),
    cursor: sat(entry.cursor),
    progress: normalizeProgress(entry.progress),
    request: normalizeRequest(entry.request),
    failureCode: normalizeEnum(entry.failureCode) as Entry['failureCode'],
  } as Entry;
}

/**
 * Maps the daemon's full lwwallet balance onto the SDK's five-field
 * {@link Balance}. Field semantics verified against the v0.2.0 wire; the
 * daemon exposes no credit fields (Server-credit is not part of lwwallet
 * v0.2.0), so the credit pair maps to zero.
 */
export function mapWireBalance(wire: WireBalance): Balance {
  return {
    confirmedSat: wire.totalConfirmedSat,
    pendingInSat: wire.vtxoPendingSat + wire.boardingUnconfirmedSat,
    pendingOutSat: wire.vtxoUnilateralExitSat + wire.boardingPendingSweepSat,
    creditAvailableSat: 0,
    creditReservedSat: 0,
  };
}

/** Parses the daemon's balance payload into a {@link WireBalance}. */
export function parseWireBalance(raw: Record<string, unknown>): WireBalance {
  const b = wireToCamel<Record<string, unknown>>(raw);
  return {
    boardingConfirmedSat: sat(b.boardingConfirmedSat),
    boardingUnconfirmedSat: sat(b.boardingUnconfirmedSat),
    vtxoBalanceSat: sat(b.vtxoBalanceSat),
    totalConfirmedSat: sat(b.totalConfirmedSat),
    onchainWalletConfirmedSat: sat(b.onchainWalletConfirmedSat),
    boardingPendingSweepSat: sat(b.boardingPendingSweepSat),
    boardingSweptSat: sat(b.boardingSweptSat),
    boardingAdoptedSat: sat(b.boardingAdoptedSat),
    vtxoPendingSat: sat(b.vtxoPendingSat),
    vtxoUnilateralExitSat: sat(b.vtxoUnilateralExitSat),
    assetBalances: Array.isArray(b.assetBalances) ? b.assetBalances : [],
  };
}

/**
 * Normalizes a raw daemon Info onto {@link WalletInfo}: camelizes, maps the
 * proto wallet-state name (verified: `"WALLET_STATE_LOCKED"` on the wire) to
 * the SDK union, and backfills `walletReady`.
 */
export function normalizeGatewayInfo(raw: unknown): WalletInfo {
  const info = wireToCamel<Record<string, unknown>>(raw ?? {});
  const rawState = info.walletState;
  // The gateway wire is untrusted: a recognized proto name maps to its SDK
  // value, a numeric proto value goes through the SDK mapper, and ANYTHING
  // else (future or garbled) stays conservative at 'locked' so it can never
  // drive the UI into creating a second wallet over an existing one.
  const walletState: WalletState =
    typeof rawState === 'string'
      ? (WIRE_WALLET_STATE[rawState] ?? WalletState.Locked)
      : walletStateFromProto(rawState as number | undefined);
  return {
    ...(applyAliases(info) as Omit<WalletInfo, 'walletState' | 'walletReady'>),
    walletState,
    walletReady: walletState === WalletState.Ready,
  };
}

/** Thrown-shape of a gateway error envelope (verified). */
interface GatewayErrorEnvelope {
  code?: number;
  message?: string;
  details?: Array<{ reason?: string; [key: string]: unknown }>;
}

/**
 * The subset of WavelengthClient this transport can serve faithfully. The
 * passkey path has no verified gateway route in v0.2.0 and throws
 * `unsupported_facade_method`; lifecycle is owned by the sidecar.
 */
export class WavedGatewayClient implements WavelengthClient {
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly activityPollMs: number;
  private readonly macaroonHex?: string;

  private sessionActive = false;
  private readonly listeners = new Set<WavelengthListener>();
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private seenEntries = new Map<string, Entry>();

  constructor(options: WavedGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.macaroonHex = options.macaroonHex;
    this.activityPollMs = options.activityPollMs ?? DEFAULT_ACTIVITY_POLL_MS;
  }

  /** Issues one unary gateway call and normalizes its envelope. */
  private async call<T>(route: string, wireBody: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.macaroonHex) headers.macaroon = this.macaroonHex;
      response = await this.fetchImpl(`${this.gatewayUrl}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(wireBody),
      });
    } catch (cause) {
      throw new WavelengthError(`waved gateway unreachable at ${this.gatewayUrl}${route}`, 'runtime_not_ready', { cause });
    }
    const text = await response.text();
    if (!response.ok) {
      throw this.toWavelengthError(parseErrorEnvelope(text));
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (cause) {
      throw new WavelengthError(`waved gateway returned non-JSON from ${route}`, 'wavelength_error', { cause });
    }
    const envelope = json as GatewayErrorEnvelope;
    // Verified: error envelopes can arrive with HTTP 200 — check the gRPC code.
    if (envelope && typeof envelope === 'object' && typeof envelope.code === 'number' && typeof envelope.message === 'string') {
      throw this.toWavelengthError(envelope);
    }
    return json as T;
  }

  private toWavelengthError(envelope: GatewayErrorEnvelope): WavelengthError {
    const code = envelope.code ?? GRPC.Internal;
    const reason = envelope.details?.find((d) => typeof d.reason === 'string')?.reason;
    // Stable daemon reasons the UI branches on (verified: AMOUNT_REQUIRED,
    // WALLET_NOT_READY, WALLET_ALREADY_EXISTS, INVALID_PASSWORD).
    if (reason === 'WALLET_NOT_READY' || code === GRPC.FailedPrecondition) {
      return new WavelengthError(envelope.message ?? 'wallet not ready', 'runtime_not_ready');
    }
    return new WavelengthError(envelope.message ?? `waved gateway error ${code}`, 'wavelength_error');
  }

  async ready(): Promise<void> {
    // The gateway has no runtime assets to load; the sidecar owns process liveness.
    return;
  }

  async start(config: RuntimeConfig): Promise<WalletInfo> {
    // The waved process is started by the Tauri sidecar, not here. A second
    // start() coalesces onto the running session (matches the SDK's engine
    // semantics); the passed config is ignored — stop() first to reconfigure.
    if (this.sessionActive) {
      return this.getInfo();
    }
    const info = await this.getInfo();
    if (config.network && info.network && config.network !== info.network) {
      throw new WavelengthError(
        `waved daemon runs network '${info.network}' but the app requested '${config.network}'`,
        'invalid_config',
      );
    }
    this.sessionActive = true;
    this.emit({ type: 'runtimeReady' });
    return info;
  }

  async stop(): Promise<void> {
    this.stopActivity();
    this.sessionActive = false;
    this.seenEntries.clear();
    this.emit({ type: 'runtimeStopped' });
  }

  async isRunning(): Promise<boolean> {
    return this.sessionActive;
  }

  async getInfo(): Promise<WalletInfo> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.getInfo);
    return normalizeGatewayInfo(raw);
  }

  /** Full daemon balance breakdown (Mode A three-balance model source). */
  async getWireBalance(): Promise<WireBalance> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.getBalance);
    return parseWireBalance(raw);
  }

  async balance(): Promise<Balance> {
    return mapWireBalance(await this.getWireBalance());
  }

  async status(): Promise<WalletStatus> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.status);
    return wireToCamel<WalletStatus>(raw);
  }

  async createWallet(req: CreateWalletRequest): Promise<CreateWalletResult> {
    const wire = toWire({
      walletPassword: utf8ToBase64(req.password),
      mnemonic: req.mnemonic,
      seedPassphrase: req.seedPassphrase === undefined ? undefined : utf8ToBase64(req.seedPassphrase),
      recoverState: req.recoverState,
      recoveryWindow: req.recoveryWindow,
    });
    const raw = await this.call<Record<string, unknown>>(ROUTES.createWallet, wire);
    return applyAliases(wireToCamel<Record<string, unknown>>(raw)) as unknown as CreateWalletResult;
  }

  async unlockWallet(req: UnlockWalletRequest): Promise<UnlockWalletResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.unlockWallet, {
      wallet_password: utf8ToBase64(req.password),
    });
    return applyAliases(wireToCamel<Record<string, unknown>>(raw)) as unknown as UnlockWalletResult;
  }

  async openWalletFromPasskey(_req: OpenWalletFromPasskeyRequest): Promise<OpenWalletFromPasskeyResult> {
    throw new WavelengthError(
      'passkey wallet open has no waved gateway route in v0.2.0',
      'unsupported_facade_method',
    );
  }

  async deposit(req?: DepositRequest): Promise<DepositResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.deposit, toWire(req as Record<string, unknown>));
    const result = wireToCamel<Record<string, unknown>>(raw);
    return { address: String(result.address ?? ''), entry: normalizeEntry(result.entry as Record<string, unknown>) } as DepositResult;
  }

  async receive(req: ReceiveRequest): Promise<ReceiveResult> {
    // Verified quirk: the gateway serializes ReceiveRequest.amountSat as amt_sat.
    const raw = await this.call<Record<string, unknown>>(ROUTES.receive, {
      amt_sat: req.amountSat,
      memo: req.memo,
    });
    const result = wireToCamel<Record<string, unknown>>(raw);
    return { invoice: String(result.invoice ?? ''), entry: normalizeEntry(result.entry as Record<string, unknown>) } as ReceiveResult;
  }

  async prepareSend(req: SendRequest): Promise<PrepareSendResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.prepareSend, toWire(req as Record<string, unknown>));
    return this.normalizePrepareSend(raw);
  }

  async send(req: SendRequest): Promise<SendResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.send, toWire(req as Record<string, unknown>));
    return wireToCamel<SendResult>(raw);
  }

  async sendPrepared(prepared: PrepareSendResult): Promise<SendResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.send, toWire(prepared as unknown as Record<string, unknown>));
    return wireToCamel<SendResult>(raw);
  }

  /**
   * Normalizes a PrepareSendResult: quote sat fields are protojson int64s and
   * the tagged-union rail/quote variants pass through camelized.
   * UNVERIFIED-ON-WIRE (no operator in the probe environment); pinned by the
   * regtest integration suite once an Ark operator is attached.
   */
  private normalizePrepareSend(raw: unknown): PrepareSendResult {
    return wireToCamel<PrepareSendResult>(raw);
  }

  async list(req: ListRequest = {}): Promise<ListResult> {
    const wire = toWire({
      view: req.view ? WIRE_VIEW[req.view] : WIRE_VIEW.activity,
      pendingOnly: req.pendingOnly,
      // EntryKind strings → proto numbers; an unparseable kind is dropped.
      kinds: req.kinds?.map((k) => WIRE_ENTRY_KIND[k]).filter((n) => typeof n === 'number'),
      limit: req.limit,
      offset: req.offset,
      cursor: req.cursor,
    });
    const raw = await this.call<Record<string, unknown>>(ROUTES.list, wire);
    const camel = wireToCamel<Record<string, unknown>>(raw);
    if (camel.activity) {
      const a = camel.activity as Record<string, unknown>;
      const entries = Array.isArray(a.entries) ? (a.entries as Array<Record<string, unknown>>).map(normalizeEntry) : [];
      return { view: 'activity', activity: { entries, total: sat(a.total), hasMore: Boolean(a.hasMore), nextCursor: String(a.nextCursor ?? '') } };
    }
    if (camel.vtxos) {
      const v = camel.vtxos as Record<string, unknown>;
      const vtxos = Array.isArray(v.vtxos)
        ? wireToCamel<WalletVTXO[]>(v.vtxos)
        : [];
      return { view: 'vtxos', vtxos: { vtxos, total: sat(v.total) } } as ListResult;
    }
    if (camel.onchain) {
      const o = camel.onchain as Record<string, unknown>;
      return { view: 'onchain', onchain: wireToCamel<NonNullable<ListResult['onchain']>>(o) };
    }
    throw new WavelengthError('waved gateway list response carried no known view', 'wavelength_error');
  }

  async exit(req: ExitRequest): Promise<ExitResult> {
    const wire =
      'forceUnrollAck' in req
        ? { outpoint: req.outpoint, force_unroll_ack: req.forceUnrollAck }
        : { outpoint: req.outpoint, destination: req.destination };
    const raw = await this.call<Record<string, unknown>>(ROUTES.exit, wire);
    return wireToCamel<ExitResult>(raw);
  }

  async exitStatus(req: ExitStatusRequest): Promise<ExitStatusResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.exitStatus, toWire(req as Record<string, unknown>));
    return wireToCamel<ExitStatusResult>(raw);
  }

  async exitSummary(_req?: ExitSummaryRequest): Promise<ExitSummaryResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.exitSummary);
    const s = wireToCamel<Record<string, unknown>>(raw);
    const exits = Array.isArray(s.exits) ? wireToCamel<ExitSummaryResult['exits']>(s.exits) : [];
    return {
      exits,
      totalExits: sat(s.totalExits),
      totalVTXOAmountSat: sat(s.totalVtxoAmountSat),
      totalEstFeeSat: sat(s.totalEstFeeSat),
      totalEstNetRecoveredSat: sat(s.totalEstNetRecoveredSat),
    } as ExitSummaryResult;
  }

  async getExitPlan(req: GetExitPlanRequest): Promise<GetExitPlanResult> {
    const raw = await this.call<Record<string, unknown>>(ROUTES.getExitPlan, { outpoints: req.outpoints });
    const p = wireToCamel<Record<string, unknown>>(raw);
    const plans = Array.isArray(p.plans) ? wireToCamel<GetExitPlanResult['plans']>(p.plans) : [];
    return { plans } as GetExitPlanResult;
  }

  async sweepWallet(_req: SweepWalletRequest): Promise<SweepWalletResult> {
    throw new WavelengthError(
      'sweepWallet has no verified waved gateway route in v0.2.0',
      'unsupported_facade_method',
    );
  }

  async callFacade(_method: string, _params?: unknown): Promise<never> {
    throw new WavelengthError(
      'callFacade is not served by the waved gateway transport',
      'unsupported_facade_method',
    );
  }

  subscribe(listener: WavelengthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Polls the activity list and emits one `'activity'` event per new or
   * changed entry, then an `'activityStream'` event only on failure. Polling
   * compensates for the v0.2.0 gateway's lack of a push stream.
   */
  async startActivity(opts: ActivityStreamOptions = {}): Promise<void> {
    if (this.activityTimer) return;
    this.seenEntries.clear();
    const poll = async () => {
      try {
        const result = await this.list({ view: 'activity' });
        for (const entry of result.activity?.entries ?? []) {
          const previous = this.seenEntries.get(entry.id);
          if (previous && previous.updatedAt === entry.updatedAt && previous.status === entry.status) continue;
          this.seenEntries.set(entry.id, entry);
          this.emit({ type: 'activity', payload: entry });
        }
      } catch (cause) {
        this.emit({ type: 'activityStream', payload: { state: 'failed', message: String((cause as Error)?.message ?? cause) } });
      }
    };
    await poll();
    this.activityTimer = setInterval(() => void poll(), this.activityPollMs);
    void opts; // replay/filter/cursor are activity-view concerns; the poll fetches all
  }

  stopActivity(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  dispose(): void {
    this.stopActivity();
    this.listeners.clear();
  }

  private emit(event: WavelengthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        // A listener bug must not break the poll loop — log and continue.
        console.error('waved gateway listener threw', cause);
      }
    }
  }
}

/** Parses a gRPC-gateway error envelope from raw response text (verified shape). */
function parseErrorEnvelope(text: string): GatewayErrorEnvelope {
  try {
    return JSON.parse(text) as GatewayErrorEnvelope;
  } catch {
    return { code: GRPC.Internal, message: text.slice(0, 500) };
  }
}

/** Creates a gateway client bound to one local waved daemon. */
export function createWavedGatewayClient(options: WavedGatewayClientOptions): WavedGatewayClient {
  return new WavedGatewayClient(options);
}
