/**
 * Typed client for the advanced (litd) platform: the bridge's core LND
 * routes (BridgeClient) plus the sub-server routes added in
 * services/litd-adapter/src/bridge/subserver-routes.ts. View types mirror
 * the bridge's JSON exactly (sats as numbers there, strings for the older
 * core routes). Nothing here computes or invents values.
 */
import type { BridgeClient } from '../modeb/bridge-client.js';

export interface SubServerStatus {
  readonly running: boolean;
  readonly disabled: boolean;
  readonly error: string;
  readonly customStatus: string;
}

export interface OperatorEndpoint {
  readonly mode: 'offline' | 'configured' | 'upstream-default';
  readonly host?: string;
}

export interface ServicesView {
  readonly network: string;
  readonly ready: boolean;
  readonly subServers: Readonly<Record<string, SubServerStatus>> | null;
  readonly statusError?: string;
  readonly operators: { readonly loop: OperatorEndpoint; readonly pool: OperatorEndpoint };
}

export type SwapKind = 'loop-out' | 'loop-in' | 'static-loop-in';

export interface SwapView {
  readonly id: string;
  readonly kind: SwapKind;
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

export type Range = { readonly minSat: number; readonly maxSat: number } | { readonly error: string };
export interface LoopTermsView {
  readonly loopOut: Range;
  readonly loopIn: Range;
}

export interface LoopQuote {
  readonly direction: 'loop-out' | 'loop-in';
  readonly amountSat: number;
  readonly fees: {
    readonly swapFeeSat: number;
    readonly prepayFeeSat: number;
    readonly minerFeeSat: number;
    readonly routingFeeSat: number;
    readonly totalSat: number;
  };
  readonly cltvDelta: number;
  readonly confTarget: number;
  readonly swapFeePpm: number;
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: LoopQuote; readonly message: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export interface DepositView {
  readonly id: string;
  readonly state: string;
  readonly outpoint: string;
  readonly valueSat: number;
  readonly confirmationHeight: number;
  readonly blocksUntilExpiry: number;
}

export interface StaticAddressView {
  readonly summary: {
    readonly address: string;
    readonly relativeExpiryBlocks: number;
    readonly totalDeposits: number;
    readonly unconfirmedSat: number;
    readonly depositedSat: number;
    readonly expiredSat: number;
    readonly withdrawnSat: number;
    readonly loopedInSat: number;
  } | null;
  readonly deposits: readonly DepositView[];
  readonly error?: string;
}

export interface AutoLoopView {
  readonly params: {
    readonly autoloopEnabled: boolean;
    readonly budgetSat: number;
    readonly budgetStartSec: number;
    readonly maxSwapFeePpm: number;
    readonly sweepFeeRateSatPerVbyte: number;
    readonly maxMinerFeeSat: number;
    readonly maxPrepaySat: number;
    readonly sweepConfTarget: number;
    readonly failureBackoffSec: number;
  } | null;
  readonly policy: unknown;
  readonly enabledByThisApp: boolean;
}

export interface Section<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

export interface PoolView {
  readonly market: { readonly state: 'unavailable' | 'thin' | 'available'; readonly matchedBatches: number; readonly message: string };
  readonly accounts: Section<readonly { traderKeyHex: string; valueSat: number; availableSat: number; expirationHeight: number; state: string }[]>;
  readonly orders: Section<readonly { nonceHex: string; side: 'bid' | 'ask'; state: string; amountSat: number; rateFixed: number; units: number; unitsUnfulfilled: number; leaseDurationBlocks: number; createdAt: number }[]>;
  readonly leases: Section<{
    readonly leases: readonly { channelPoint: string; amountSat: number; durationBlocks: number; expiryHeight: number; premiumSat: number; executionFeeSat: number; chainFeeSat: number; purchased: boolean; sidecar: boolean; remoteNodeHex: string }[];
    readonly totalPaidSat: number;
    readonly totalEarnedSat: number;
  }>;
  readonly leaseDurations: Section<readonly { blocks: number; state: string }[]>;
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

export interface AssetsView {
  readonly assets: readonly AssetView[];
  readonly balances: readonly { assetIdHex: string; name: string; type: string; balance: string }[];
  readonly universe: { readonly version: string; readonly network: string; readonly blockHeight: number } | null;
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
  readonly addresses: readonly string[];
}

export interface UtxoView {
  /** txid:index, txid in display (explorer) byte order. */
  readonly outpoint: string;
  readonly address: string;
  readonly addressType: 'p2wkh' | 'np2wkh' | 'p2tr' | 'unknown';
  readonly amountSat: number;
  readonly confirmations: number;
  readonly pkScript: string;
}

/** GET /lnd/utxos: unspent outputs + this wallet's addresses already spent from (from its own history). */
export interface UtxosView {
  readonly utxos: readonly UtxoView[];
  readonly spentFromAddresses: readonly string[];
  /** Spends of ours whose earlier output is missing from this node's history (e.g. a restored wallet). */
  readonly unresolvedSpends: number;
  /**
   * Generic P2SH / P2WSH addresses spent from: whether each spend revealed a
   * public key (true), a keyless script (false) or could not be read (null).
   * Absent from older bridges and recorded demo data: those addresses then
   * classify as unknown.
   */
  readonly spendEvidence?: readonly { readonly address: string; readonly revealsPublicKey: boolean | null }[];
  readonly historyTransactions: number;
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

export interface FeeReportView {
  readonly policies: readonly { channelId: string; channelPoint: string; baseFeeMsat: number; feePpm: number; inboundBaseFeeMsat: number; inboundFeePpm: number }[];
  readonly earnedDaySat: number;
  readonly earnedWeekSat: number;
  readonly earnedMonthSat: number;
}

export interface SwapAuthorization {
  readonly amountSat: number;
  readonly maxTotalFeeSat: number;
}

/** Thin typed wrapper; one instance per bridge client. */
export class PlatformApi {
  constructor(readonly bridge: BridgeClient) {}

  services = () => this.bridge.request<ServicesView>('GET', '/services');

  loopTerms = () => this.bridge.request<LoopTermsView>('GET', '/loop/terms');
  loopQuote = (direction: 'loop-out' | 'loop-in', amountSat: number, confTarget?: number) =>
    this.bridge.request<QuoteResult>('POST', '/loop/quote', { direction, amountSat, confTarget });
  swaps = async () => (await this.bridge.request<{ swaps: SwapView[] }>('GET', '/loop/swaps')).swaps;
  swap = (id: string) => this.bridge.request<SwapView>('GET', `/loop/swaps/${id}`);
  loopOut = (body: {
    amountSat: number;
    destAddress?: string;
    sweepConfTarget?: number;
    outgoingChanIds?: string[];
    label?: string;
    authorization: SwapAuthorization;
  }) => this.bridge.request<{ swapId: string; destAddress: string; quote: LoopQuote }>('POST', '/loop/out', body);
  loopIn = (body: { amountSat: number; lastHopPubkeyHex?: string; label?: string; authorization: SwapAuthorization }) =>
    this.bridge.request<{ swapId: string; quote: LoopQuote }>('POST', '/loop/in', body);
  staticAddress = () => this.bridge.request<StaticAddressView>('GET', '/loop/static');
  newStaticAddress = () => this.bridge.request<{ address: string; expiryBlocks: number }>('POST', '/loop/static/address');
  staticLoopIn = (body: { outpoints: string[]; amountSat?: number; lastHopPubkeyHex?: string; label?: string; authorization: { maxTotalFeeSat: number } }) =>
    this.bridge.request<{ swapHashHex: string; state: string; amountSat: number; quotedSwapFeeSat: number }>('POST', '/loop/static/loop-in', body);
  autoloop = () => this.bridge.request<AutoLoopView>('GET', '/loop/autoloop');
  setAutoloop = (body: { enabled: false } | { enabled: true; policy: unknown; sweepFeeRateSatPerVbyte?: number }) =>
    this.bridge.request<AutoLoopView>('POST', '/loop/autoloop', body);
  suggestions = () =>
    this.bridge.request<{ loopOut: number[]; loopIn: number[]; disqualified: { channelId: string; reason: string }[] }>('GET', '/loop/suggestions');

  pool = () => this.bridge.request<PoolView>('GET', '/pool');

  assets = () => this.bridge.request<AssetsView>('GET', '/assets');
  assetTransfers = async () =>
    (await this.bridge.request<{ transfers: { txid: string; at: number; anchorTxHeight: number; inputs: number; outputs: { assetIdHex: string; amount: string }[] }[] }>('GET', '/assets/transfers')).transfers;
  newAssetAddress = (assetIdHex: string, amount: string) => this.bridge.request<{ address: string }>('POST', '/assets/address', { assetIdHex, amount });
  decodeAssetAddress = (address: string) => this.bridge.request<{ assetIdHex: string; amount: string }>('POST', '/assets/decode', { address });
  mintAsset = (body: { name: string; amount: string; description?: string; grouped?: boolean }) =>
    this.bridge.request<{ batchKeyHex: string; state: string; txid: string }>('POST', '/assets/mint', {
      ...body,
      authorization: { name: body.name, amount: body.amount },
    });
  sendAsset = (address: string) => this.bridge.request<{ txid: string }>('POST', '/assets/send', { address, authorization: { address } });

  invoices = async () => (await this.bridge.request<{ invoices: InvoiceView[] }>('GET', '/lnd/invoices')).invoices;
  transactions = async () => (await this.bridge.request<{ transactions: OnchainTxView[] }>('GET', '/lnd/transactions')).transactions;
  utxos = () => this.bridge.request<UtxosView>('GET', '/lnd/utxos');
  peers = async () => (await this.bridge.request<{ peers: PeerView[] }>('GET', '/lnd/peers')).peers;
  feeReport = () => this.bridge.request<FeeReportView>('GET', '/lnd/fees');
  updateFeePolicy = (body: { channelPoint?: string; baseFeeMsat: number; feePpm: number; timeLockDelta: number }) =>
    this.bridge.request<{ failed: string[] }>('POST', '/lnd/fees', body);
}
