/**
 * Lightning Terminal sub-servers behind the bridge: Loop, Pool, Taproot
 * Assets, Faraday and litd's own Status service.
 *
 * Every call goes to litd's integrated mux (the `httpslisten` port, litd's
 * own TLS cert) authenticated with the baked **super macaroon** — the only
 * credential litd accepts for every sub-server. (LND's admin macaroon is
 * rejected with "signature mismatch after caveat verification".) The super
 * macaroon only exists once the wallet is unlocked and the sub-servers have
 * started, so every surface answers 503 "still starting" until it does.
 *
 * Money-moving calls (Loop Out / Loop In / static Loop In) require a
 * transaction-specific authorization: the caller echoes the exact amount and
 * a fee ceiling it reviewed; the hub re-quotes and refuses if the live fees
 * exceed the ceiling. Nothing here invents a number: every view is mapped
 * from a daemon response, and failures are returned as classified errors.
 */
import { readFile } from 'node:fs/promises';
import type { GrpcTransport } from '@protobuf-ts/grpc-transport';
import {
  litStatus,
  litStatusClient,
  Loop,
  Pool,
  PoolAuctioneer,
  PoolClient,
  tapdAssets,
  tapdMint,
  AddressType,
  Invoice_InvoiceState,
  ListInvoiceRequest,
  ListPeersRequest,
  FeeReportRequest,
  GetTransactionsRequest,
  PolicyUpdateRequest,
  ChannelPoint,
  type LightningClient,
} from '@sovereign/litd-proto';
import {
  LiquidityManager,
  MemoryLiquidityJournal,
  type AutoLoopBudgetPolicy,
  type LiquidityJournal,
  type QuoteResult,
} from '@sovereign/liquidity';
import { randomUUID } from 'node:crypto';
import type { AssetIdHex } from '@sovereign/wallet-core';
import { createLitdTransport, type LitdConnectionOptions } from '../client.js';
import type { LitdNetwork } from '../config.js';
import { LitdLoopPort } from '../loop-client.js';
import { LitdPoolPort } from '../pool-client.js';
import { createTapdClients, type TapdClients } from '../assets/tapd-clients.js';
import { AssetManager } from '../assets/asset-manager.js';
import { RPC_UNARY_TIMEOUT_MS } from '../rpc-timeout.js';
import { BridgeRequestError } from './session.js';
import type { SubServerPlan } from './subserver-config.js';

const T = { timeoutMs: RPC_UNARY_TIMEOUT_MS };

// ——— views (JSON-safe: sats as numbers, ids as hex, times as epoch ms) ———

export interface SubServerStatusView {
  readonly running: boolean;
  readonly disabled: boolean;
  readonly error: string;
  readonly customStatus: string;
}

export interface ServicesView {
  readonly network: LitdNetwork;
  /** False until the super macaroon exists (wallet locked / sub-servers starting). */
  readonly ready: boolean;
  readonly subServers: Readonly<Record<string, SubServerStatusView>> | null;
  readonly statusError?: string;
  readonly operators: SubServerPlan['operators'];
}

export type SwapKind = 'loop-out' | 'loop-in' | 'static-loop-in';

export interface SwapView {
  readonly id: string;
  readonly kind: SwapKind;
  /** loopd state name, lowercased: initiated, preimage_revealed, htlc_published, success, failed, invoice_settled. */
  readonly state: string;
  readonly done: boolean;
  readonly failureReason: string | null;
  readonly amountSat: number;
  readonly costServerSat: number;
  readonly costOnchainSat: number;
  readonly costOffchainSat: number;
  readonly initiatedAt: number;
  readonly updatedAt: number;
  readonly htlcAddress: string;
  readonly label: string;
  readonly outgoingChanIds: readonly string[];
  readonly lastHopHex: string;
}

export interface LoopTermsView {
  readonly loopOut: { readonly minSat: number; readonly maxSat: number } | { readonly error: string };
  readonly loopIn: { readonly minSat: number; readonly maxSat: number } | { readonly error: string };
}

export interface DepositView {
  readonly id: string;
  readonly state: string;
  readonly outpoint: string;
  readonly valueSat: number;
  readonly confirmationHeight: number;
  readonly blocksUntilExpiry: number;
}

export interface StaticAddressView {
  readonly summary:
    | {
        readonly address: string;
        readonly relativeExpiryBlocks: number;
        readonly totalDeposits: number;
        readonly unconfirmedSat: number;
        readonly depositedSat: number;
        readonly expiredSat: number;
        readonly withdrawnSat: number;
        readonly loopedInSat: number;
      }
    | null;
  readonly deposits: readonly DepositView[];
  readonly error?: string;
}

export interface Section<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

export interface PoolOverviewView {
  readonly market: Awaited<ReturnType<LiquidityManager['poolMarket']>>;
  readonly accounts: Section<readonly PoolAccountView[]>;
  readonly orders: Section<readonly PoolOrderView[]>;
  readonly leases: Section<{ readonly leases: readonly PoolLeaseView[]; readonly totalPaidSat: number; readonly totalEarnedSat: number }>;
  readonly leaseDurations: Section<readonly { readonly blocks: number; readonly state: string }[]>;
}

export interface PoolAccountView {
  readonly traderKeyHex: string;
  readonly valueSat: number;
  readonly availableSat: number;
  readonly expirationHeight: number;
  readonly state: string;
}

export interface PoolOrderView {
  readonly nonceHex: string;
  readonly side: 'bid' | 'ask';
  readonly state: string;
  readonly amountSat: number;
  readonly rateFixed: number;
  readonly units: number;
  readonly unitsUnfulfilled: number;
  readonly leaseDurationBlocks: number;
  readonly createdAt: number;
}

export interface PoolLeaseView {
  readonly channelPoint: string;
  readonly amountSat: number;
  readonly durationBlocks: number;
  readonly expiryHeight: number;
  readonly premiumSat: number;
  readonly executionFeeSat: number;
  readonly chainFeeSat: number;
  readonly purchased: boolean;
  readonly sidecar: boolean;
  readonly remoteNodeHex: string;
}

export interface AssetView {
  readonly assetIdHex: string;
  readonly name: string;
  readonly type: string;
  readonly amount: string;
  readonly groupKeyHex: string | null;
  readonly metaHashHex: string;
  readonly genesisPoint: string;
  readonly anchorOutpoint: string;
  readonly anchorBlockHeight: number;
  readonly isSpent: boolean;
  readonly version: string;
}

export interface AssetBalanceView {
  readonly assetIdHex: string;
  readonly name: string;
  readonly type: string;
  readonly balance: string;
}

export interface AssetsOverviewView {
  readonly assets: readonly AssetView[];
  readonly balances: readonly AssetBalanceView[];
  readonly universe: { readonly version: string; readonly network: string; readonly blockHeight: number } | null;
}

// ——— helpers ———

const hex = (b: Uint8Array | undefined): string => (b === undefined ? '' : Buffer.from(b).toString('hex'));
const num = (v: bigint | number | undefined): number => (v === undefined ? 0 : Number(v));
const ms = (sec: bigint | number | undefined): number => num(sec) * 1000;
const enumName = (e: Record<string | number, string | number>, v: number): string =>
  String(e[v] ?? `unknown_${v}`).toLowerCase();

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

const DONE_STATES = new Set(['success', 'failed']);

export function mapSwapStatus(s: Readonly<Loop.SwapStatus>): SwapView {
  const kind: SwapKind =
    s.type === Loop.SwapType.LOOP_OUT ? 'loop-out' : s.staticLoopInStateOptional.oneofKind !== undefined ? 'static-loop-in' : 'loop-in';
  const state = enumName(Loop.SwapState as unknown as Record<number, string>, s.state);
  const failure = s.failureReason === Loop.FailureReason.NONE ? null : enumName(Loop.FailureReason as unknown as Record<number, string>, s.failureReason);
  return {
    id: s.idBytes.length > 0 ? hex(s.idBytes) : s.id,
    kind,
    state,
    done: DONE_STATES.has(state),
    failureReason: failure,
    amountSat: num(s.amt),
    costServerSat: num(s.costServer),
    costOnchainSat: num(s.costOnchain),
    costOffchainSat: num(s.costOffchain),
    initiatedAt: Math.floor(num(s.initiationTime) / 1e6),
    updatedAt: Math.floor(num(s.lastUpdateTime) / 1e6),
    htlcAddress: s.htlcAddress,
    label: s.label,
    outgoingChanIds: s.outgoingChanSet.map(String),
    lastHopHex: hex(s.lastHop),
  };
}

export function mapAsset(a: Readonly<tapdAssets.Asset>): AssetView {
  const g = a.assetGenesis;
  return {
    assetIdHex: hex(g?.assetId),
    name: g?.name ?? '',
    type: enumName(tapdAssets.AssetType as unknown as Record<number, string>, g?.assetType ?? 0),
    amount: String(a.amount),
    groupKeyHex: a.assetGroup === undefined ? null : hex(a.assetGroup.tweakedGroupKey),
    metaHashHex: hex(g?.metaHash),
    genesisPoint: g?.genesisPoint ?? '',
    anchorOutpoint: a.chainAnchor?.anchorOutpoint ?? '',
    anchorBlockHeight: a.chainAnchor?.blockHeight ?? 0,
    isSpent: a.isSpent,
    version: enumName(tapdAssets.AssetVersion as unknown as Record<number, string>, a.version),
  };
}

export interface InvoiceView {
  readonly paymentHashHex: string;
  readonly memo: string;
  readonly valueSat: number;
  readonly paidSat: number;
  readonly state: 'open' | 'settled' | 'canceled' | 'accepted';
  readonly createdAt: number;
  readonly settledAt: number | null;
  readonly expiresAt: number;
  readonly paymentRequest: string;
  readonly isKeysend: boolean;
}

export interface OnchainTxView {
  readonly txid: string;
  /** Net effect on this wallet: positive = received, negative = sent (fee included). */
  readonly amountSat: number;
  readonly feeSat: number;
  readonly confirmations: number;
  readonly blockHeight: number;
  readonly at: number;
  readonly label: string;
  /** This wallet's own addresses among the outputs. */
  readonly addresses: readonly string[];
}

export interface PeerView {
  readonly pubkey: string;
  readonly address: string;
  readonly inbound: boolean;
  readonly pingMs: number;
  readonly satSent: number;
  readonly satReceived: number;
  readonly flapCount: number;
}

export interface FeePolicyView {
  readonly channelId: string;
  readonly channelPoint: string;
  readonly baseFeeMsat: number;
  readonly feePpm: number;
  readonly inboundBaseFeeMsat: number;
  readonly inboundFeePpm: number;
}

export interface FeeReportView {
  readonly policies: readonly FeePolicyView[];
  readonly earnedDaySat: number;
  readonly earnedWeekSat: number;
  readonly earnedMonthSat: number;
}

export function mapInvoice(i: Readonly<{ rHash: Uint8Array; memo: string; value: bigint; amtPaidSat: bigint; state: number; creationDate: bigint; settleDate: bigint; expiry: bigint; paymentRequest: string; isKeysend: boolean }>): InvoiceView {
  const state = (['open', 'settled', 'canceled', 'accepted'] as const)[i.state] ?? 'open';
  return {
    paymentHashHex: hex(i.rHash),
    memo: i.memo,
    valueSat: num(i.value),
    paidSat: num(i.amtPaidSat),
    state,
    createdAt: ms(i.creationDate),
    settledAt: i.state === Invoice_InvoiceState.SETTLED ? ms(i.settleDate) : null,
    expiresAt: ms(i.creationDate) + ms(i.expiry),
    paymentRequest: i.paymentRequest,
    isKeysend: i.isKeysend,
  };
}

// ——— hub ———

export interface SubServerHubOptions {
  readonly network: LitdNetwork;
  /** litd's integrated mux: httpslisten port + litd's own TLS cert. */
  readonly litdEndpoint: Omit<LitdConnectionOptions, 'macaroonPath' | 'macaroonHex'>;
  readonly superMacaroonPath: string;
  readonly plan: SubServerPlan;
  /** LND (admin macaroon) — only for wallet addresses used as swap destinations. */
  readonly lightning: () => Promise<LightningClient>;
  readonly journal?: LiquidityJournal;
  readonly onLog?: (line: string) => void;
}

export class SubServerHub {
  private superHex: string | undefined;
  private transport: GrpcTransport | undefined;
  private loopPort: LitdLoopPort | undefined;
  private poolPort: LitdPoolPort | undefined;
  private manager: LiquidityManager | undefined;
  private tapd: TapdClients | undefined;
  private readonly journal: LiquidityJournal;

  constructor(private readonly options: SubServerHubOptions) {
    this.journal = options.journal ?? new MemoryLiquidityJournal();
  }

  private async conn(): Promise<LitdConnectionOptions> {
    if (this.superHex === undefined) {
      try {
        this.superHex = (await readFile(this.options.superMacaroonPath)).toString('hex');
      } catch {
        throw new BridgeRequestError(
          503,
          'Lightning Terminal services are still starting. They come up once the wallet is unlocked and synced.',
        );
      }
    }
    return { ...this.options.litdEndpoint, macaroonHex: this.superHex };
  }

  private async rawTransport(): Promise<GrpcTransport> {
    this.transport ??= await createLitdTransport(await this.conn());
    return this.transport;
  }

  private async loop(): Promise<LitdLoopPort> {
    this.loopPort ??= await LitdLoopPort.create(await this.conn(), (err) =>
      this.options.onLog?.(`loop monitor stream ended: ${errorText(err)}`),
    );
    return this.loopPort;
  }

  private async liquidity(): Promise<LiquidityManager> {
    if (this.manager === undefined) {
      this.poolPort ??= await LitdPoolPort.create(await this.conn());
      this.manager = new LiquidityManager({ loop: await this.loop(), pool: this.poolPort, journal: this.journal, newId: randomUUID });
    }
    return this.manager;
  }

  private async assets(): Promise<AssetManager> {
    this.tapd ??= await createTapdClients(await this.conn());
    return new AssetManager(this.tapd);
  }

  // ——— LND (admin macaroon): received payments, peers, fee policies ———

  async invoices(max = 100): Promise<readonly InvoiceView[]> {
    const ln = await this.options.lightning();
    const r = await ln.listInvoices(ListInvoiceRequest.create({ numMaxInvoices: BigInt(max), reversed: true, pendingOnly: false }), T).response;
    return r.invoices.map(mapInvoice).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** On-chain transactions touching this wallet (newest first). */
  async transactions(): Promise<readonly OnchainTxView[]> {
    const ln = await this.options.lightning();
    const r = await ln.getTransactions(GetTransactionsRequest.create({ startHeight: 0, endHeight: -1, account: '' }), T).response;
    return r.transactions
      .map((t) => ({
        txid: t.txHash,
        amountSat: num(t.amount),
        feeSat: num(t.totalFees),
        confirmations: t.numConfirmations,
        blockHeight: t.blockHeight,
        at: ms(t.timeStamp),
        label: t.label,
        addresses: t.outputDetails.filter((o) => o.isOurAddress).map((o) => o.address),
      }))
      .sort((a, b) => b.at - a.at);
  }

  async peers(): Promise<readonly PeerView[]> {
    const ln = await this.options.lightning();
    const r = await ln.listPeers(ListPeersRequest.create({ latestError: true }), T).response;
    return r.peers.map((p) => ({
      pubkey: p.pubKey,
      address: p.address,
      inbound: p.inbound,
      pingMs: Math.round(num(p.pingTime) / 1000),
      satSent: num(p.satSent),
      satReceived: num(p.satRecv),
      flapCount: p.flapCount,
    }));
  }

  async feeReport(): Promise<FeeReportView> {
    const ln = await this.options.lightning();
    const r = await ln.feeReport(FeeReportRequest.create({}), T).response;
    return {
      policies: r.channelFees.map((c) => ({
        channelId: c.chanId,
        channelPoint: c.channelPoint,
        baseFeeMsat: num(c.baseFeeMsat),
        feePpm: num(c.feePerMil),
        inboundBaseFeeMsat: c.inboundBaseFeeMsat,
        inboundFeePpm: c.inboundFeePerMil,
      })),
      earnedDaySat: num(r.dayFeeSum),
      earnedWeekSat: num(r.weekFeeSum),
      earnedMonthSat: num(r.monthFeeSum),
    };
  }

  /** Routing fee policy for one channel (or every channel when channelPoint is omitted). */
  async updateFeePolicy(req: { channelPoint?: string; baseFeeMsat: number; feePpm: number; timeLockDelta: number }): Promise<{ failed: readonly string[] }> {
    const ln = await this.options.lightning();
    let scope: PolicyUpdateRequest['scope'] = { oneofKind: 'global', global: true };
    if (req.channelPoint !== undefined) {
      const [txid, idx] = req.channelPoint.split(':');
      scope = {
        oneofKind: 'chanPoint',
        chanPoint: ChannelPoint.create({ fundingTxid: { oneofKind: 'fundingTxidStr', fundingTxidStr: txid ?? '' }, outputIndex: Number(idx) }),
      };
    }
    const r = await ln
      .updateChannelPolicy(
        PolicyUpdateRequest.create({ scope, baseFeeMsat: BigInt(req.baseFeeMsat), feeRatePpm: req.feePpm, timeLockDelta: req.timeLockDelta }),
        T,
      )
      .response;
    return { failed: r.failedUpdates.map((f) => `${f.outpoint?.txidStr ?? ''}:${f.outpoint?.outputIndex ?? ''} ${f.updateError}`) };
  }

  // ——— services ———

  async services(): Promise<ServicesView> {
    const base = { network: this.options.network, operators: this.options.plan.operators };
    let conn: LitdConnectionOptions;
    try {
      conn = await this.conn();
    } catch (err) {
      return { ...base, ready: false, subServers: null, statusError: errorText(err) };
    }
    try {
      const client = new litStatusClient.StatusClient(await this.rawTransport());
      const resp = await client.subServerStatus(litStatus.SubServerStatusReq.create({}), T).response;
      const subServers: Record<string, SubServerStatusView> = {};
      for (const [name, s] of Object.entries(resp.subServers)) {
        subServers[name] = { running: s.running, disabled: s.disabled, error: s.error, customStatus: s.customStatus };
      }
      return { ...base, ready: true, subServers };
    } catch (err) {
      void conn;
      return { ...base, ready: true, subServers: null, statusError: errorText(err) };
    }
  }

  // ——— Loop ———

  async loopTerms(): Promise<LoopTermsView> {
    const client = (await this.loop()).swapClient;
    const [out, inn] = await Promise.all([
      section(async () => client.loopOutTerms(Loop.TermsRequest.create({}), T).response),
      section(async () => client.getLoopInTerms(Loop.TermsRequest.create({}), T).response),
    ]);
    return {
      loopOut: out.ok && out.data ? { minSat: num(out.data.minSwapAmount), maxSat: num(out.data.maxSwapAmount) } : { error: out.error ?? 'unavailable' },
      loopIn: inn.ok && inn.data ? { minSat: num(inn.data.minSwapAmount), maxSat: num(inn.data.maxSwapAmount) } : { error: inn.error ?? 'unavailable' },
    };
  }

  async loopQuote(direction: 'loop-out' | 'loop-in', amountSat: number, confTarget?: number): Promise<QuoteResult> {
    const m = await this.liquidity();
    return direction === 'loop-out' ? m.quoteLoopOut(amountSat, confTarget) : m.quoteLoopIn(amountSat, confTarget);
  }

  async swaps(): Promise<readonly SwapView[]> {
    const resp = await (await this.loop()).swapClient.listSwaps(Loop.ListSwapsRequest.create({}), T).response;
    return resp.swaps.map(mapSwapStatus).sort((a, b) => b.initiatedAt - a.initiatedAt);
  }

  async swap(idHex: string): Promise<SwapView> {
    if (!/^[0-9a-f]{64}$/i.test(idHex)) throw new BridgeRequestError(400, 'swap id must be 32 bytes of hex');
    const resp = await (await this.loop()).swapClient
      .swapInfo(Loop.SwapInfoRequest.create({ id: Buffer.from(idHex, 'hex') }), T)
      .response;
    return mapSwapStatus(resp);
  }

  /** Re-quote and refuse if the live total exceeds what the user authorized. */
  private async authorize(direction: 'loop-out' | 'loop-in', amountSat: number, auth: SwapAuthorization, confTarget?: number) {
    if (auth.amountSat !== amountSat) {
      throw new BridgeRequestError(400, 'authorization does not match the swap amount');
    }
    const q = await this.loopQuote(direction, amountSat, confTarget);
    if (!q.ok) throw new BridgeRequestError(409, q.message);
    if (q.quote.fees.totalSat > auth.maxTotalFeeSat) {
      throw new BridgeRequestError(
        409,
        `Fees changed since you reviewed this swap: now ${q.quote.fees.totalSat} sats, above your ${auth.maxTotalFeeSat}-sat limit. Review the new quote.`,
      );
    }
    return q.quote;
  }

  async loopOut(req: LoopOutBody): Promise<{ swapId: string; destAddress: string; quote: unknown }> {
    const quote = await this.authorize('loop-out', req.amountSat, req.authorization, req.sweepConfTarget);
    let destAddress = req.destAddress ?? '';
    if (destAddress === '') {
      const ln = await this.options.lightning();
      destAddress = (await ln.newAddress({ type: AddressType.TAPROOT_PUBKEY, account: '' }, T).response).address;
    }
    const m = await this.liquidity();
    const { swapId } = await m.executeLoopOut({
      amountSat: req.amountSat,
      destAddress,
      sweepConfTarget: req.sweepConfTarget,
      maxSwapFeeSat: quote.fees.swapFeeSat,
      outgoingChanIds: req.outgoingChanIds,
      label: req.label,
    });
    return { swapId, destAddress, quote };
  }

  async loopIn(req: LoopInBody): Promise<{ swapId: string; quote: unknown }> {
    const quote = await this.authorize('loop-in', req.amountSat, req.authorization);
    const m = await this.liquidity();
    const { swapId } = await m.executeLoopIn({
      amountSat: req.amountSat,
      maxSwapFeeSat: quote.fees.swapFeeSat,
      lastHopPubkeyHex: req.lastHopPubkeyHex,
      label: req.label,
    });
    return { swapId, quote };
  }

  // ——— static-address Loop In ———

  async staticAddress(): Promise<StaticAddressView> {
    const client = (await this.loop()).swapClient;
    const [summary, deposits] = await Promise.all([
      section(async () => client.getStaticAddressSummary(Loop.StaticAddressSummaryRequest.create({}), T).response),
      section(async () => client.listStaticAddressDeposits(Loop.ListStaticAddressDepositsRequest.create({}), T).response),
    ]);
    const s = summary.data;
    return {
      summary:
        summary.ok && s !== undefined && s.staticAddress !== ''
          ? {
              address: s.staticAddress,
              relativeExpiryBlocks: num(s.relativeExpiryBlocks),
              totalDeposits: s.totalNumDeposits,
              unconfirmedSat: num(s.valueUnconfirmedSatoshis),
              depositedSat: num(s.valueDepositedSatoshis),
              expiredSat: num(s.valueExpiredSatoshis),
              withdrawnSat: num(s.valueWithdrawnSatoshis),
              loopedInSat: num(s.valueLoopedInSatoshis),
            }
          : null,
      deposits: (deposits.data?.filteredDeposits ?? []).map((d) => ({
        id: hex(d.id),
        state: enumName(Loop.DepositState as unknown as Record<number, string>, d.state),
        outpoint: d.outpoint,
        valueSat: num(d.value),
        confirmationHeight: num(d.confirmationHeight),
        blocksUntilExpiry: num(d.blocksUntilExpiry),
      })),
      error: summary.ok ? deposits.error : summary.error,
    };
  }

  async newStaticAddress(): Promise<{ address: string; expiryBlocks: number }> {
    const r = await (await this.loop()).swapClient.newStaticAddress(Loop.NewStaticAddressRequest.create({}), T).response;
    return { address: r.address, expiryBlocks: r.expiry };
  }

  async staticLoopIn(req: StaticLoopInBody): Promise<{ swapHashHex: string; state: string; amountSat: number; quotedSwapFeeSat: number }> {
    if (req.outpoints.length === 0) throw new BridgeRequestError(400, 'select at least one deposit');
    const client = (await this.loop()).swapClient;
    const quote = await client
      .getLoopInQuote(Loop.QuoteRequest.create({ amt: BigInt(req.amountSat ?? 0), depositOutpoints: [...req.outpoints] }), T)
      .response;
    const swapFee = num(quote.swapFeeSat);
    if (swapFee > req.authorization.maxTotalFeeSat) {
      throw new BridgeRequestError(409, `Fees changed since you reviewed this Loop In: now ${swapFee} sats, above your ${req.authorization.maxTotalFeeSat}-sat limit.`);
    }
    const r = await client
      .staticAddressLoopIn(
        Loop.StaticAddressLoopInRequest.create({
          outpoints: [...req.outpoints],
          amount: BigInt(req.amountSat ?? 0),
          maxSwapFeeSatoshis: BigInt(swapFee),
          lastHop: req.lastHopPubkeyHex ? Buffer.from(req.lastHopPubkeyHex, 'hex') : new Uint8Array(0),
          label: req.label ?? '',
          initiator: 'sovereign-wallet',
        }),
        T,
      )
      .response;
    return { swapHashHex: hex(r.swapHash), state: r.state, amountSat: num(r.swapAmount), quotedSwapFeeSat: num(r.quotedSwapFeeSatoshis) };
  }

  // ——— AutoLoop ———

  async autoloop(): Promise<{ params: unknown; policy: AutoLoopBudgetPolicy | null; enabledByThisApp: boolean }> {
    const m = await this.liquidity();
    return { params: await (await this.loop()).getAutoLoopParams(), policy: m.getBudgetPolicy(), enabledByThisApp: m.isAutoLoopEnabled() };
  }

  async enableAutoloop(policy: AutoLoopBudgetPolicy, sweepFeeRateSatPerVbyte?: number): Promise<void> {
    await (await this.liquidity()).enableAutoLoop(policy, { sweepFeeRateSatPerVbyte });
  }

  async disableAutoloop(): Promise<void> {
    await (await this.liquidity()).disableAutoLoop('disabled from the app');
  }

  /** AutoLoop dry run: what loopd would do now, without dispatching anything. */
  async suggestSwaps(): Promise<{ loopOut: number[]; loopIn: number[]; disqualified: { channelId: string; reason: string }[] }> {
    const r = await (await this.loop()).swapClient.suggestSwaps(Loop.SuggestSwapsRequest.create({}), T).response;
    return {
      loopOut: r.loopOut.map((o) => num(o.amt)),
      loopIn: r.loopIn.map((o) => num(o.amt)),
      disqualified: r.disqualified.map((d) => ({
        channelId: String(d.channelId),
        reason: enumName(Loop.AutoReason as unknown as Record<number, string>, d.reason),
      })),
    };
  }

  // ——— Pool ———

  async pool(): Promise<PoolOverviewView> {
    const m = await this.liquidity();
    const trader = new PoolClient.TraderClient(await this.rawTransport());
    const [market, accounts, orders, leases, durations] = await Promise.all([
      m.poolMarket(),
      section(async () =>
        (await trader.listAccounts(Pool.ListAccountsRequest.create({ activeOnly: false }), T).response).accounts.map((a) => ({
          traderKeyHex: hex(a.traderKey),
          valueSat: num(a.value),
          availableSat: num(a.availableBalance),
          expirationHeight: a.expirationHeight,
          state: enumName(Pool.AccountState as unknown as Record<number, string>, a.state),
        })),
      ),
      section(async () => {
        const r = await trader.listOrders(Pool.ListOrdersRequest.create({ verbose: false, activeOnly: false }), T).response;
        const mapOrder = (side: 'bid' | 'ask', o: Pool.Order | undefined, duration: number): PoolOrderView => ({
          nonceHex: hex(o?.orderNonce),
          side,
          state: enumName(PoolAuctioneer.OrderState as unknown as Record<number, string>, o?.state ?? 0),
          amountSat: num(o?.amt),
          rateFixed: o?.rateFixed ?? 0,
          units: o?.units ?? 0,
          unitsUnfulfilled: o?.unitsUnfulfilled ?? 0,
          leaseDurationBlocks: duration,
          createdAt: Math.floor(num(o?.creationTimestampNs) / 1e6),
        });
        return [
          ...r.bids.map((b) => mapOrder('bid', b.details, b.leaseDurationBlocks)),
          ...r.asks.map((a) => mapOrder('ask', a.details, a.leaseDurationBlocks)),
        ];
      }),
      section(async () => {
        const r = await trader.leases(Pool.LeasesRequest.create({}), T).response;
        return {
          totalPaidSat: num(r.totalAmtPaidSat),
          totalEarnedSat: num(r.totalAmtEarnedSat),
          leases: r.leases.map((l) => ({
            channelPoint: l.channelPoint === undefined ? '' : `${hex(l.channelPoint.txid)}:${l.channelPoint.outputIndex}`,
            amountSat: num(l.channelAmtSat),
            durationBlocks: l.channelDurationBlocks,
            expiryHeight: l.channelLeaseExpiry,
            premiumSat: num(l.premiumSat),
            executionFeeSat: num(l.executionFeeSat),
            chainFeeSat: num(l.chainFeeSat),
            purchased: l.purchased,
            sidecar: l.sidecarChannel,
            remoteNodeHex: hex(l.channelRemoteNodeKey),
          })),
        };
      }),
      section(async () => {
        const r = await trader.leaseDurations(Pool.LeaseDurationRequest.create({}), T).response;
        return Object.entries(r.leaseDurationBuckets).map(([blocks, state]) => ({
          blocks: Number(blocks),
          state: enumName(PoolAuctioneer.DurationBucketState as unknown as Record<number, string>, state),
        }));
      }),
    ]);
    return { market, accounts, orders, leases, leaseDurations: durations };
  }

  // ——— Taproot Assets ———

  async assetsOverview(): Promise<AssetsOverviewView> {
    const am = await this.assets();
    const [list, balances, info] = await Promise.all([am.listAssets(), am.listBalances(), section(() => am.getInfo())]);
    return {
      assets: list.assets.map(mapAsset),
      balances: Object.entries(balances.assetBalances).map(([id, b]) => ({
        assetIdHex: id,
        name: b.assetGenesis?.name ?? '',
        type: enumName(tapdAssets.AssetType as unknown as Record<number, string>, b.assetGenesis?.assetType ?? 0),
        balance: String(b.balance),
      })),
      universe: info.ok && info.data ? { version: info.data.version, network: info.data.network, blockHeight: info.data.blockHeight } : null,
    };
  }

  async assetTransfers(): Promise<readonly { txid: string; at: number; anchorTxHeight: number; inputs: number; outputs: { assetIdHex: string; amount: string }[] }[]> {
    const r = await (await this.assets()).listTransfers();
    return r.transfers.map((t) => ({
      txid: hex(t.anchorTxHash),
      at: ms(t.transferTimestamp),
      anchorTxHeight: num(t.anchorTxHeightHint),
      inputs: t.inputs.length,
      outputs: t.outputs.map((o) => ({ assetIdHex: hex(o.assetId), amount: String(o.amount) })),
    }));
  }

  async newAssetAddress(assetIdHex: string, amount: string): Promise<{ address: string }> {
    if (!/^[0-9a-f]{64}$/i.test(assetIdHex)) throw new BridgeRequestError(400, 'asset id must be 32 bytes of hex');
    if (!/^[1-9][0-9]*$/.test(amount)) throw new BridgeRequestError(400, 'amount must be a positive whole number of asset units');
    const r = await (await this.assets()).newAssetAddress({ assetIdHex: assetIdHex.toLowerCase() as AssetIdHex, amount: BigInt(amount) });
    return { address: r.encoded };
  }

  async decodeAssetAddress(address: string): Promise<{ assetIdHex: string; amount: string; network: string }> {
    const r = await (await this.assets()).decodeTapAddress(address);
    return { assetIdHex: hex(r.assetId), amount: String(r.amount), network: '' };
  }

  /**
   * Issue a new asset (advanced; costs an on-chain fee). Stages and finalizes
   * a mint batch; the batch anchors on-chain and becomes spendable after
   * confirmation. The caller must echo name + amount as authorization.
   */
  async mintAsset(req: { name: string; amount: string; description?: string; grouped: boolean }): Promise<{ batchKeyHex: string; state: string; txid: string }> {
    if (!/^[1-9][0-9]{0,18}$/.test(req.amount)) throw new BridgeRequestError(400, 'amount must be a positive whole number of units');
    if (req.name.length < 1 || req.name.length > 64) throw new BridgeRequestError(400, 'name must be 1–64 characters');
    const batch = await (await this.assets()).issueAsset({
      name: req.name,
      amount: BigInt(req.amount),
      metaJson: req.description ? { name: req.name, description: req.description } : { name: req.name },
      enableEmission: req.grouped,
    });
    return {
      batchKeyHex: hex(batch?.batchKey),
      state: batch === undefined ? 'unknown' : enumName(tapdMint.BatchState as unknown as Record<number, string>, batch.state),
      txid: batch?.batchTxid ?? '',
    };
  }

  async sendAsset(address: string): Promise<{ txid: string }> {
    const r = await (await this.assets()).sendAsset({ tapAddresses: [address] });
    return { txid: hex(r.transfer?.anchorTxHash) };
  }
}

export interface SwapAuthorization {
  /** Must equal the swap amount — the user authorizes THIS swap. */
  readonly amountSat: number;
  /** The most the user agreed to pay in total fees after reviewing a quote. */
  readonly maxTotalFeeSat: number;
}

export interface LoopOutBody {
  readonly amountSat: number;
  /** Empty → a fresh taproot address in this node's own wallet. */
  readonly destAddress?: string;
  readonly sweepConfTarget?: number;
  readonly outgoingChanIds?: readonly string[];
  readonly label?: string;
  readonly authorization: SwapAuthorization;
}

export interface LoopInBody {
  readonly amountSat: number;
  readonly lastHopPubkeyHex?: string;
  readonly label?: string;
  readonly authorization: SwapAuthorization;
}

export interface StaticLoopInBody {
  readonly outpoints: readonly string[];
  /** Omit to swap the full value of the selected deposits. */
  readonly amountSat?: number;
  readonly lastHopPubkeyHex?: string;
  readonly label?: string;
  readonly authorization: { readonly maxTotalFeeSat: number };
}
