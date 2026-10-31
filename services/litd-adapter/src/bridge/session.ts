/**
 * LitdBridgeSession — one desktop session against one litd sidecar (or a
 * remote LND via litd's remote mode). Owns the wallet-phase probe, the
 * macaroon lifecycle, every Mode B operation the UI needs, and the
 * channel-close jobs that outlive their initiating HTTP call.
 *
 * The session never trusts its caller more than necessary: seed mnemonics and
 * wallet passwords exist only inside this process, the admin macaroon is read
 * from disk here and never returned over the wire, and the loopback invariant
 * is the HTTP server's job (see server.ts).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  LightningClient,
  RouterClient,
  UnlockWalletRequest,
  FaradayServerClient,
  ChannelBalanceResponse,
  ChanBackupSnapshot,
  ChannelInsightsResponse,
  ClosedChannelsResponse,
  CoinSelectionStrategy,
  ForwardingHistoryResponse,
  GetInfoResponse,
  Invoice_InvoiceState,
  ListChannelsResponse,
  ListPaymentsResponse,
  PayReq,
  PendingChannelsResponse,
  Payment,
  CloseStatusUpdate,
  WalletBalanceResponse,
  RevenueReportResponse,
} from '@sovereign/litd-proto';

import type { LitdConnectionOptions } from '../client.js';

import {
  buildCloseChannelRequest,
  buildOpenChannelRequest,
  buildSendCoinsRequest,
  buildSendPaymentRequest,
  buildRestoreChanBackupRequest,
  mapChannelInsights,
  mapChannelBalance,
  mapClosedChannels,
  mapForwardingEvents,
  mapNodeInfo,
  mapOpenChannel,
  mapPayReq,
  mapPendingChannel,
  mapPaymentOutcome,
  mapRevenueReport,
  mapWalletBalance,
  multiChanBackupHex,
  walletPhaseFromInfoError,
  walletPhaseFromUnlockCanaryError,
  type ChannelInsightView,
  type ChannelRowView,
  type ClosedChannelView,
  type ForwardingEventView,
  type LitdWalletPhase,
  type NodeHealthView,
  type PaymentOutcomeView,
  type PhaseProbeOutcome,
  type RevenueReportView,
} from '../state-mappings.js';

/** Operations the session performs against litd, injected so unit tests can
 * run the full state machine without a daemon. */
export interface LitdBridgeDeps {
  /** GenSeed + InitWallet/UnlockWallet — the pre-init surface. */
  readonly createUnlocker: () => UnlockerOps | Promise<UnlockerOps>;
  /** Macaroon-authed wallet surface; recreated when the macaroon changes. */
  readonly createLightning: (macaroonHex: string) => LightningOps | Promise<LightningOps>;
  /** Faraday analytics surface through litd's proxy mux; may be absent. */
  readonly createFaraday?: (macaroonHex: string) => FaradayOps | Promise<FaradayOps>;
  /** Admin macaroon bytes as hex; undefined until the wallet is initialized. */
  readonly readAdminMacaroon: () => Promise<string | undefined>;
  /** One throwaway canary password per session — never a real credential. */
  readonly canaryPassword?: () => string;
  /** Post-init macaroon wait budget (test seam; default 15s). */
  readonly macaroonWaitMs?: number;
}

export interface UnlockerOps {
  genSeed(): Promise<{ readonly mnemonic: readonly string[] }>;
  initWallet(input: {
    readonly mnemonic: readonly string[];
    readonly password: string;
    readonly aezeedPassphrase?: string;
    readonly recoveryWindow?: number;
  }): Promise<void>;
  unlockWallet(password: string): Promise<void>;
}

export interface LightningOps {
  getInfo(): Promise<{ readonly response: GetInfoResponse }>;
  walletBalance(): Promise<{ readonly response: WalletBalanceResponse }>;
  channelBalance(): Promise<{ readonly response: ChannelBalanceResponse }>;
  newAddress(type: 'p2wkh' | 'np2wkh'): Promise<{ readonly address: string }>;
  sendCoins(request: ReturnType<typeof buildSendCoinsRequest>): Promise<{ readonly txid: string }>;
  estimateFee(targetConf: number): Promise<{ readonly satPerVbyte: bigint; readonly feeSat: bigint }>;
  listChannels(): Promise<{ readonly response: ListChannelsResponse }>;
  pendingChannels(): Promise<{ readonly response: PendingChannelsResponse }>;
  closedChannels(): Promise<{ readonly response: ClosedChannelsResponse }>;
  connectPeer(pubkeyHex: string, host: string): Promise<void>;
  openChannelSync(request: ReturnType<typeof buildOpenChannelRequest>): Promise<{ readonly channelPoint: string }>;
  closeChannel(request: ReturnType<typeof buildCloseChannelRequest>): AsyncIterable<CloseStatusUpdate>;
  addInvoice(input: { readonly amountSat?: bigint; readonly memo?: string }): Promise<{ readonly paymentRequest: string; readonly rHashHex: string }>;
  decodePayReq(paymentRequest: string): Promise<{ readonly response: PayReq }>;
  listPayments(maxPayments: number): Promise<{ readonly response: ListPaymentsResponse }>;
  sendPaymentV2(request: ReturnType<typeof buildSendPaymentRequest>): AsyncIterable<Payment>;
  forwardingHistory(startTimeSec: bigint): Promise<{ readonly response: ForwardingHistoryResponse }>;
  exportAllChannelBackups(): Promise<{ readonly response: ChanBackupSnapshot }>;
  restoreChannelBackups(backupHex: string): Promise<void>;
}

export interface FaradayOps {
  channelInsights(): Promise<{ readonly response: ChannelInsightsResponse }>;
  revenueReport(startSec: bigint, endSec: bigint): Promise<{ readonly response: RevenueReportResponse }>;
}

export interface BridgeStateView {
  readonly phase: PhaseProbeOutcome;
  /** Raw upstream refusal when the phase could not be proven — rendered verbatim. */
  readonly error?: string;
  readonly info?: NodeHealthView;
}

export interface ChannelsOverviewView {
  readonly open: readonly ChannelRowView[];
  readonly pending: readonly ChannelRowView[];
  readonly balance: ReturnType<typeof mapChannelBalance>;
}

export interface DiagnosticsView {
  readonly node: NodeHealthView;
  readonly closed: readonly ClosedChannelView[];
  readonly forwarding: readonly ForwardingEventView[];
  readonly faraday: {
    readonly available: boolean;
    readonly error?: string;
    readonly insights?: readonly ChannelInsightView[];
    readonly revenue?: readonly RevenueReportView[];
  };
}

export interface CloseJobView {
  readonly id: string;
  readonly state: 'closing' | 'closed';
  readonly closingTxid?: string;
  readonly error?: string;
}

export class BridgeRequestError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

const PROBE_CACHE_MS = 1_500;

export class LitdBridgeSession {
  private lightningOps: LightningOps | undefined;
  private lightningMacaroon: string | undefined;
  private probeCache: { readonly at: number; readonly state: BridgeStateView } | undefined;
  private readonly closeJobs = new Map<string, CloseJobView>();
  private readonly canaryPassword: string;

  constructor(private readonly deps: LitdBridgeDeps) {
    this.canaryPassword = deps.canaryPassword?.() ?? `canary-${randomBytes(16).toString('hex')}`;
  }

  // -- phase probe ---------------------------------------------------------

  /** Cached wallet-phase probe; safe to call per request from the UI. */
  async state(): Promise<BridgeStateView> {
    const now = Date.now();
    if (this.probeCache && now - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.state;
    }
    const state = await this.probeState();
    this.probeCache = { at: now, state };
    return state;
  }

  private async probeState(): Promise<BridgeStateView> {
    try {
      const ops = await this.ensureLightning();
      const { response } = await ops.getInfo();
      return { phase: 'ready' as LitdWalletPhase, info: mapNodeInfo(response) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fromInfo = walletPhaseFromInfoError(message);
      if (fromInfo === 'locked') {
        return { phase: 'locked' };
      }
      if (fromInfo === 'undetermined') {
        return { phase: await this.probeViaCanary(), error: message };
      }
      return { phase: fromInfo };
    }
  }

  /** Disambiguate an undetermined info error with the unlock canary. */
  private async probeViaCanary(): Promise<PhaseProbeOutcome> {
    try {
      const unlocker = await this.deps.createUnlocker();
      await unlocker.unlockWallet(this.canaryPassword);
      // A canary password should never succeed — but if the wallet accepted
      // it, the wallet is genuinely up (defensive: treat as ready).
      return 'ready';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const phase = walletPhaseFromUnlockCanaryError(message);
      if (phase !== 'undetermined') {
        return phase;
      }
      return 'undetermined';
    }
  }

  // -- macaroon / client lifecycle ------------------------------------------

  private async ensureLightning(): Promise<LightningOps> {
    const macaroonHex = await this.deps.readAdminMacaroon();
    if (macaroonHex === undefined) {
      throw new BridgeRequestError(503, 'admin macaroon not found yet — the wallet may still be initializing');
    }
    if (this.lightningOps === undefined || this.lightningMacaroon !== macaroonHex) {
      this.lightningOps = await this.deps.createLightning(macaroonHex);
      this.lightningMacaroon = macaroonHex;
    }
    return this.lightningOps;
  }

  private async requireReady(): Promise<LightningOps> {
    const state = await this.state();
    if (state.phase !== 'ready') {
      throw new BridgeRequestError(409, `wallet is not ready (phase: ${state.phase})`);
    }
    return this.ensureLightning();
  }

  private async waitForMacaroon(): Promise<string> {
    const waitMs = this.deps.macaroonWaitMs ?? 15_000;
    const deadline = Date.now() + waitMs;
    // Poll at 250ms for real deployments, faster when the budget is small —
    // a poll interval longer than the budget would skip the macaroon entirely.
    const pollMs = Math.max(10, Math.min(250, Math.floor(waitMs / 8)));
    while (Date.now() < deadline) {
      const macaroonHex = await this.deps.readAdminMacaroon();
      if (macaroonHex !== undefined) {
        return macaroonHex;
      }
      await delay(pollMs);
    }
    throw new BridgeRequestError(502, 'wallet initialized but the admin macaroon did not appear in time');
  }

  // -- wallet lifecycle ------------------------------------------------------

  async generateSeed(): Promise<{ readonly mnemonic: readonly string[] }> {
    const state = await this.state();
    if (state.phase !== 'missing') {
      throw new BridgeRequestError(409, `a wallet already exists or its state is unknown (phase: ${state.phase}) — refusing to generate a seed`);
    }
    const unlocker = await this.deps.createUnlocker();
    const { mnemonic } = await unlocker.genSeed();
    return { mnemonic };
  }

  /** InitWallet for both fresh create (recoveryWindow 0) and restore. */
  async initWallet(input: {
    readonly mnemonic: readonly string[];
    readonly password: string;
    readonly aezeedPassphrase?: string;
    readonly recoveryWindow?: number;
  }): Promise<{ readonly ok: true }> {
    const state = await this.state();
    if (state.phase !== 'missing') {
      throw new BridgeRequestError(409, `wallet is not in the missing state (phase: ${state.phase})`);
    }
    const unlocker = await this.deps.createUnlocker();
    await unlocker.initWallet(input);
    this.probeCache = undefined;
    await this.waitForMacaroon();
    return { ok: true };
  }

  async unlockWallet(password: string): Promise<{ readonly ok: true }> {
    const state = await this.state();
    if (state.phase !== 'locked') {
      throw new BridgeRequestError(409, `wallet is not locked (phase: ${state.phase})`);
    }
    const unlocker = await this.deps.createUnlocker();
    await unlocker.unlockWallet(password);
    this.probeCache = undefined;
    await this.waitForMacaroon();
    return { ok: true };
  }

  // -- on-chain --------------------------------------------------------------

  async walletBalance(): Promise<ReturnType<typeof mapWalletBalance>> {
    const ops = await this.requireReady();
    const { response } = await ops.walletBalance();
    return mapWalletBalance(response);
  }

  async newAddress(type: 'p2wkh' | 'np2wkh'): Promise<{ readonly address: string }> {
    const ops = await this.requireReady();
    return ops.newAddress(type);
  }

  async estimateFee(targetConf: number): Promise<{ readonly satPerVbyte: bigint; readonly feeSat: bigint }> {
    if (!Number.isInteger(targetConf) || targetConf < 1 || targetConf > 1000) {
      throw new BridgeRequestError(400, 'confirmation target must be between 1 and 1000 blocks');
    }
    const ops = await this.requireReady();
    return ops.estimateFee(targetConf);
  }

  async sendCoins(input: {
    readonly address: string;
    readonly amountSat?: bigint;
    readonly sendAll?: boolean;
    readonly satPerVbyte: number;
    readonly label?: string;
  }): Promise<{ readonly txid: string }> {
    const ops = await this.requireReady();
    const request = buildSendCoinsRequest(input);
    const { txid } = await ops.sendCoins(request);
    return { txid };
  }

  // -- channels ---------------------------------------------------------------

  async channels(): Promise<ChannelsOverviewView> {
    const ops = await this.requireReady();
    const [open, pending, balance] = await Promise.all([
      ops.listChannels(),
      ops.pendingChannels(),
      ops.channelBalance(),
    ]);
    const response = pending.response;
    return {
      open: open.response.channels.map(mapOpenChannel),
      pending: [
        ...response.pendingOpenChannels.map((c) => mapPendingChannel('pending-open', c)),
        ...response.pendingClosingChannels.map((c) => mapPendingChannel('pending-closing', c)),
        ...response.pendingForceClosingChannels.map((c) => mapPendingChannel('pending-force-closing', c)),
        ...response.waitingCloseChannels.map((c) => mapPendingChannel('waiting-close', c)),
      ],
      balance: mapChannelBalance(balance.response),
    };
  }

  async openChannel(input: {
    readonly nodePubkeyHex: string;
    readonly host?: string;
    readonly localFundingSat: bigint;
    readonly satPerVbyte: number;
    readonly isPrivate?: boolean;
  }): Promise<{ readonly channelPoint: string }> {
    const ops = await this.requireReady();
    const request = buildOpenChannelRequest(input);
    if (input.host !== undefined && input.host.trim()) {
      await ops.connectPeer(request.nodePubkeyString || input.nodePubkeyHex.trim(), input.host.trim());
    }
    const { channelPoint } = await ops.openChannelSync(request);
    return { channelPoint };
  }

  /** Starts a close job that survives the HTTP call; poll via closeJob(). */
  async closeChannel(input: {
    readonly channelPoint: string;
    readonly force?: boolean;
    readonly satPerVbyte?: number;
  }): Promise<CloseJobView> {
    const ops = await this.requireReady();
    const request = buildCloseChannelRequest(input);
    const id = randomBytes(8).toString('hex');
    this.closeJobs.set(id, { id, state: 'closing' });
    void this.runCloseJob(id, ops, request);
    return { id, state: 'closing' };
  }

  private async runCloseJob(
    id: string,
    ops: LightningOps,
    request: ReturnType<typeof buildCloseChannelRequest>,
  ): Promise<void> {
    try {
      for await (const update of ops.closeChannel(request)) {
        if (update.update.oneofKind === 'closePending') {
          const txidHex = Buffer.from(update.update.closePending.txid).toString('hex');
          const job = this.closeJobs.get(id);
          if (job && txidHex !== '') {
            this.closeJobs.set(id, { ...job, closingTxid: txidHex });
          }
        }
        if (update.update.oneofKind === 'chanClose') {
          // Keep the txid seen at closePending — the close summary completes
          // the job, it does not replace what was already broadcast.
          const summaryTxid = Buffer.from(update.update.chanClose.closingTxid).toString('hex');
          const job = this.closeJobs.get(id);
          this.closeJobs.set(id, {
            id,
            state: 'closed',
            closingTxid: job?.closingTxid ?? (summaryTxid === '' ? undefined : summaryTxid),
          });
          return;
        }
        // closeInstant (pending HTLC resolution progress) — the job stays 'closing'.
      }
      // Stream ended without a close summary — cooperative closes registered
      // elsewhere; mark closed only if we saw a txid, else surface ambiguity.
      const job = this.closeJobs.get(id);
      this.closeJobs.set(id, {
        id,
        state: job?.closingTxid ? 'closed' : 'closing',
        closingTxid: job?.closingTxid,
        error: job?.closingTxid ? undefined : 'close stream ended without a close confirmation',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.closeJobs.set(id, { id, state: 'closing', error: message });
    }
  }

  closeJob(id: string): CloseJobView | undefined {
    return this.closeJobs.get(id);
  }

  // -- lightning --------------------------------------------------------------

  async createInvoice(input: { readonly amountSat?: bigint; readonly memo?: string }): Promise<{ readonly paymentRequest: string; readonly rHashHex: string }> {
    const ops = await this.requireReady();
    if (input.amountSat !== undefined && input.amountSat < 0n) {
      throw new BridgeRequestError(400, 'invoice amount cannot be negative');
    }
    return ops.addInvoice({ amountSat: input.amountSat, memo: input.memo });
  }

  async decodeInvoice(paymentRequest: string): Promise<ReturnType<typeof mapPayReq>> {
    const ops = await this.requireReady();
    const { response } = await ops.decodePayReq(paymentRequest.trim());
    return mapPayReq(response);
  }

  async payInvoice(input: {
    readonly paymentRequest: string;
    readonly amountSat?: bigint;
    /** Decoded invoice amount — percentage fee base. */
    readonly invoiceAmountSat?: bigint;
    readonly feeLimitSat?: bigint;
    readonly feeLimitPercent?: number;
    readonly cltvLimit?: number;
    readonly allowSelfPayment?: boolean;
  }): Promise<PaymentOutcomeView> {
    const ops = await this.requireReady();
    const request = buildSendPaymentRequest(input);
    // Consume the SendPaymentV2 stream to its terminal state. Payment status:
    // 1 IN_FLIGHT → 2 SUCCEEDED | 3 FAILED.
    let final: Payment | undefined;
    for await (const payment of ops.sendPaymentV2(request)) {
      final = payment;
      if (payment.status === 2 || payment.status === 3) {
        final = payment;
        break;
      }
    }
    return mapPaymentOutcome(final);
  }

  async payments(max = 20): Promise<readonly Payment[]> {
    const ops = await this.requireReady();
    const { response } = await ops.listPayments(max);
    return response.payments;
  }

  // -- diagnostics ------------------------------------------------------------

  async diagnostics(): Promise<DiagnosticsView> {
    const ops = await this.requireReady();
    const state = await this.state();
    if (state.info === undefined) {
      throw new BridgeRequestError(503, 'node info unavailable');
    }
    const [closed, forwarding] = await Promise.all([
      ops.closedChannels(),
      ops.forwardingHistory(BigInt(Math.floor(Date.now() / 1000) - 7 * 24 * 3600)),
    ]);
    const faraday = await this.faradayDiagnostics(ops);
    return {
      node: state.info,
      closed: mapClosedChannels(closed.response),
      forwarding: mapForwardingEvents(forwarding.response),
      faraday,
    };
  }

  private async faradayDiagnostics(_ops: LightningOps): Promise<DiagnosticsView['faraday']> {
    if (this.deps.createFaraday === undefined) {
      return { available: false, error: 'Faraday analytics not configured for this connection' };
    }
    try {
      const macaroonHex = await this.deps.readAdminMacaroon();
      if (macaroonHex === undefined) {
        return { available: false, error: 'macaroon not available' };
      }
      const faraday = await this.deps.createFaraday(macaroonHex);
      const endSec = BigInt(Math.floor(Date.now() / 1000));
      const startSec = endSec - 7n * 24n * 3600n;
      const [insights, revenue] = await Promise.all([
        faraday.channelInsights(),
        faraday.revenueReport(startSec, endSec),
      ]);
      return {
        available: true,
        insights: mapChannelInsights(insights.response),
        revenue: mapRevenueReport(revenue.response),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Diagnostics never block the wallet — they render as an honest
      // "unavailable" state with the daemon's own reason.
      return { available: false, error: message };
    }
  }

  // -- SCB (channel backups) ----------------------------------------------------

  async exportChannelBackups(): Promise<{ readonly multiChanBackupHex: string }> {
    const ops = await this.requireReady();
    const { response } = await ops.exportAllChannelBackups();
    return { multiChanBackupHex: multiChanBackupHex(response) };
  }

  async restoreChannelBackups(backupHex: string): Promise<{ readonly ok: true }> {
    const ops = await this.requireReady();
    buildRestoreChanBackupRequest(backupHex); // validate before dispatch
    await ops.restoreChannelBackups(backupHex);
    return { ok: true };
  }
}

/** Re-exported for the HTTP server's JSON serialization. */
export function sessionJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Session deps wired to the real litd clients — the only place gRPC exists. */
export async function createRealBridgeDeps(options: {
  readonly connectionOptions: LitdConnectionOptions;
  /** Faraday subserver config; integrated litd serves it on the same mux. */
  readonly faraday?: { readonly rpcPort: number; readonly tlsCertPath: string; readonly macaroonGlobDir: string };
}): Promise<LitdBridgeDeps> {
  const { createLightningClient, createRouterClient, createWalletUnlockerClient } = await import('../client.js');
  const conn = options.connectionOptions;
  return {
    createUnlocker: async () => {
      const client = await createWalletUnlockerClient(conn);
      return {
        genSeed: async () => {
          const { response } = await client.genSeed({
            aezeedPassphrase: new Uint8Array(),
            seedEntropy: new Uint8Array(),
          });
          return { mnemonic: response.cipherSeedMnemonic };
        },
        initWallet: async (input) => {
          await client.initWallet({
            walletPassword: new Uint8Array(Buffer.from(input.password, 'utf8')),
            cipherSeedMnemonic: [...input.mnemonic],
            // Must match the genSeed passphrase exactly: the aezeed was
            // encrypted with it at generation time and any mismatch fails
            // InitWallet with "invalid passphrase". Default is empty because
            // genSeed encrypts with an empty passphrase.
            aezeedPassphrase: new Uint8Array(Buffer.from(input.aezeedPassphrase ?? '', 'utf8')),
            recoveryWindow: input.recoveryWindow ?? 0,
            channelBackups: undefined,
            statelessInit: false,
            extendedMasterKey: '',
            extendedMasterKeyBirthdayTimestamp: 0n,
            watchOnly: undefined,
            macaroonRootKey: new Uint8Array(),
          });
        },
        unlockWallet: async (password) => {
          const req: UnlockWalletRequest = {
            walletPassword: new Uint8Array(Buffer.from(password, 'utf8')),
            recoveryWindow: 0,
            channelBackups: undefined,
            statelessInit: false,
          };
          await client.unlockWallet(req);
        },
      };
    },
    createLightning: async (macaroonHex) => {
      const client = await createLightningClient({ ...conn, macaroonHex });
      const router = await createRouterClient({ ...conn, macaroonHex });
      return lightningOpsFromClient({ lightning: client, router });
    },
    createFaraday: options.faraday
      ? async (adminMacaroonHex) => {
          const faradayOptions = options.faraday;
          if (faradayOptions === undefined) {
            throw new Error('faraday options missing');
          }
          const { FaradayServerClient } = await import('@sovereign/litd-proto');
          const { createLitdTransport } = await import('../client.js');
          // The faraday subserver validates against its own macaroon when
          // present (faraday.macaroon beside the admin macaroon); the admin
          // macaroon is the fallback for deployments that never minted one.
          let macaroonHex = adminMacaroonHex;
          try {
            macaroonHex = (
              await readFile(join(faradayOptions.macaroonGlobDir, 'faraday.macaroon'))
            ).toString('hex');
          } catch {
            // faraday.macaroon is optional — admin macaroon works too.
          }
          const transport = await createLitdTransport({
            rpcHost: '127.0.0.1',
            rpcPort: faradayOptions.rpcPort,
            tlsCertPath: faradayOptions.tlsCertPath,
            macaroonHex,
          });
          return faradayOpsFromClient(new FaradayServerClient(transport));
        }
      : undefined,
    readAdminMacaroon: () => readFile(conn.macaroonPath ?? '', 'hex').catch(() => undefined),
  };
}

/** Bridge the generated Faraday client into the session's analytics surface. */
export function faradayOpsFromClient(client: FaradayServerClient): FaradayOps {
  return {
    channelInsights: async () => ({ response: (await client.channelInsights({})).response }),
    revenueReport: async (startSec, endSec) => ({
      response: (
        await client.revenueReport({ chanPoints: [], startTime: startSec, endTime: endSec })
      ).response,
    }),
  };
}

/** Bridge generated gRPC clients into the session's operation surface. */
export function lightningOpsFromClient(clients: { readonly lightning: LightningClient; readonly router: RouterClient }): LightningOps {
  const lightning = clients.lightning;
  const router = clients.router;
  return {
    getInfo: async () => ({ response: (await lightning.getInfo({})).response }),
    walletBalance: async () => ({
      response: (await lightning.walletBalance({ account: '', minConfs: 1 })).response,
    }),
    channelBalance: async () => ({ response: (await lightning.channelBalance({})).response }),
    newAddress: async (type) => ({
      address: (await lightning.newAddress({ type: type === 'p2wkh' ? 2 : 3, account: '' })).response.address,
    }),
    sendCoins: async (request) => ({ txid: (await lightning.sendCoins(request)).response.txid }),
    estimateFee: async (targetConf) => {
      const req = {
        addrToAmount: {},
        targetConf,
        minConfs: 1,
        spendUnconfirmed: false,
        coinSelectionStrategy: 0 as CoinSelectionStrategy,
        inputs: [],
      };
      const { response } = await lightning.estimateFee(req);
      return { satPerVbyte: response.satPerVbyte, feeSat: response.feeSat };
    },
    listChannels: async () => ({
      response: (
        await lightning.listChannels({
          activeOnly: false,
          inactiveOnly: false,
          publicOnly: false,
          privateOnly: false,
          peer: new Uint8Array(),
          peerAliasLookup: false,
        })
      ).response,
    }),
    pendingChannels: async () => ({
      response: (await lightning.pendingChannels({ includeRawTx: false })).response,
    }),
    closedChannels: async () => ({
      response: (
        await lightning.closedChannels({
          cooperative: true,
          localForce: true,
          remoteForce: true,
          breach: true,
          fundingCanceled: true,
          abandoned: true,
        })
      ).response,
    }),
    connectPeer: async (pubkeyHex, host) => {
      await lightning.connectPeer({
        addr: { pubkey: pubkeyHex.toLowerCase(), host },
        perm: false,
        timeout: 30n,
      });
    },
    openChannelSync: async (request) => {
      const { response } = await lightning.openChannelSync(request);
      const txid =
        response.fundingTxid.oneofKind === 'fundingTxidStr'
          ? response.fundingTxid.fundingTxidStr
          : response.fundingTxid.oneofKind === 'fundingTxidBytes'
            ? Buffer.from(response.fundingTxid.fundingTxidBytes).toString('hex')
            : '';
      return { channelPoint: `${txid}:${response.outputIndex}` };
    },
    closeChannel: (request) =>
      streamToAsyncIterable({
        responses: lightning.closeChannel(request).responses,
        read: (u) => u.update,
      }) as AsyncIterable<CloseStatusUpdate>,
    addInvoice: async (input) => {
      const { response } = await lightning.addInvoice({
        memo: input.memo ?? '',
        value: input.amountSat ?? 0n,
        rPreimage: new Uint8Array(),
        rHash: new Uint8Array(),
        valueMsat: 0n,
        settled: false,
        creationDate: 0n,
        settleDate: 0n,
        paymentRequest: '',
        descriptionHash: new Uint8Array(),
        expiry: 0n,
        fallbackAddr: '',
        cltvExpiry: 0n,
        routeHints: [],
        private: false,
        addIndex: 0n,
        settleIndex: 0n,
        amtPaid: 0n,
        amtPaidSat: 0n,
        amtPaidMsat: 0n,
        state: 0 as Invoice_InvoiceState,
        htlcs: [],
        features: {},
        isKeysend: false,
        paymentAddr: new Uint8Array(),
        isAmp: false,
        ampInvoiceState: {},
        isBlinded: false,
        blindedPathConfig: undefined,
      });
      return { paymentRequest: response.paymentRequest, rHashHex: Buffer.from(response.rHash).toString('hex') };
    },
    decodePayReq: async (paymentRequest) => ({
      response: (await lightning.decodePayReq({ payReq: paymentRequest })).response,
    }),
    listPayments: async (maxPayments) => ({
      response: (
        await lightning.listPayments({
          maxPayments: BigInt(maxPayments),
          includeIncomplete: true,
          indexOffset: 0n,
          reversed: true,
          countTotalPayments: false,
          creationDateStart: 0n,
          creationDateEnd: 0n,
          omitHops: false,
        })
      ).response,
    }),
    sendPaymentV2: (request) =>
      streamToAsyncIterable({
        responses: router.sendPaymentV2(request).responses,
        read: (p) => p,
      }) as AsyncIterable<Payment>,
    forwardingHistory: async (startTimeSec) => ({
      response: (
        await lightning.forwardingHistory({
          startTime: startTimeSec,
          endTime: 0n,
          indexOffset: 0,
          numMaxEvents: 100,
          peerAliasLookup: false,
          incomingChanIds: [],
          outgoingChanIds: [],
        })
      ).response,
    }),
    exportAllChannelBackups: async () => ({
      response: (await lightning.exportAllChannelBackups({})).response,
    }),
    restoreChannelBackups: async (backupHex) => {
      await lightning.restoreChannelBackups(buildRestoreChanBackupRequest(backupHex));
    },
  };
}

function streamToAsyncIterable<TRead, TOut>(options: {
  readonly responses: AsyncIterable<TRead>;
  readonly read: (item: TRead) => TOut;
}): AsyncIterable<TOut> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const item of options.responses) {
        yield options.read(item);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// (end of session)
// ---------------------------------------------------------------------------
