/**
 * Transfers & swaps on mobile — pure route resolution, Loop quote and
 * fee-limit math, swap-state copy, and the remote-node swap store.
 *
 * Rules carried over from desktop (`apps/desktop/src/platform/pages/payments/
 * transfers/routes.ts` and `pages/liquidity/loop/*`):
 * - Routes come from what the active backend can do right now. A pair with
 *   no rail says so; no bridge or custodian is ever substituted.
 * - Every money-moving flow reviews a real quote. A Loop swap is authorized
 *   as `{ amountSat, maxTotalFeeSat }`; before it starts, the store re-quotes
 *   and refuses if the total rose above what the user approved.
 * - Loop fee limits match `@sovereign/liquidity` (`LiquidityManager.execute*`):
 *   swap fee from the quote, miner fee × 2, prepay from the quote, and Loop's
 *   default routing caps (`loopRoutingFeeCapSat`, 10 sats + 2%).
 *
 * Over Lightning Node Connect the phone talks to loopd directly (no desktop
 * bridge in between), so the re-quote check lives here.
 */

import { loopRoutingFeeCapSat } from '@sovereign/liquidity';
import type { BackendKind, FeatureId, FeatureStatus } from './capabilities.js';

// ——— routes this track adds to the tab stacks ———

/**
 * Remote node (Mode B) screens, pushed onto the active tab's stack:
 * `liquidity`, `transfers` (FROM → TO), `swap-flow` (params `{ direction, amount? }`),
 * `swap` (progress/receipt, params `{ id }`), `swaps` (history), `assets`,
 * `asset` / `asset-receive` / `asset-send` (params `{ id }`).
 */
export type MoneyRoute =
  | 'liquidity'
  | 'transfers'
  | 'swap-flow'
  | 'swap'
  | 'swaps'
  | 'assets'
  | 'asset'
  | 'asset-receive'
  | 'asset-send';

/** The everyday wallet (Mode A) has no Loop and no assets: three informational routes. */
export type ModeAMoneyRoute = 'liquidity' | 'transfers' | 'assets';

export const MONEY_ROUTES: readonly MoneyRoute[] = [
  'liquidity',
  'transfers',
  'swap-flow',
  'swap',
  'swaps',
  'assets',
  'asset',
  'asset-receive',
  'asset-send',
];

export function isMoneyRoute(route: string): route is MoneyRoute {
  return MONEY_ROUTES.some((r) => r === route);
}

// ——— Loop over the LNC port ———

export type LoopDirection = 'loop-out' | 'loop-in';

/** The swap server's limits, from loopd's GetLoopOutTerms / GetLoopInTerms. */
export interface LoopTerms {
  readonly loopOut: { readonly minSat: bigint; readonly maxSat: bigint };
  readonly loopIn: { readonly minSat: bigint; readonly maxSat: bigint };
}

/**
 * A live quote as loopd returns it (LoopOutQuote / GetLoopInQuote).
 * For Loop Out, `prepayAmtSat` is the part of `swapFeeSat` paid up front —
 * it is part of the swap fee, never added to it.
 */
export interface RemoteLoopQuote {
  readonly direction: LoopDirection;
  readonly amountSat: bigint;
  readonly swapFeeSat: bigint;
  /** Loop Out: no-show prepayment (`prepay_amt_sat`); 0 for Loop In. */
  readonly prepayAmtSat: bigint;
  /** Loop Out: sweep fee estimate (`htlc_sweep_fee_sat`); Loop In: HTLC publish fee (`htlc_publish_fee_sat`). */
  readonly minerFeeSat: bigint;
  readonly confTarget: number;
  readonly cltvDelta: number;
}

/** Hard limits sent with a Loop Out — loopd refuses to spend more on any of them. */
export interface LoopOutFeeLimits {
  readonly maxSwapFeeSat: bigint;
  readonly maxMinerFeeSat: bigint;
  readonly maxPrepayAmtSat: bigint;
  readonly maxSwapRoutingFeeSat: bigint;
  readonly maxPrepayRoutingFeeSat: bigint;
}

/** Hard limits sent with a Loop In. */
export interface LoopInFeeLimits {
  readonly maxSwapFeeSat: bigint;
  readonly maxMinerFeeSat: bigint;
}

export interface LoopOutRequest extends LoopOutFeeLimits {
  readonly amountSat: bigint;
  /** Null: loopd sweeps to a fresh address of the node's own wallet. */
  readonly destAddress: string | null;
  readonly sweepConfTarget: number;
  readonly label: string;
}

export interface LoopInRequest extends LoopInFeeLimits {
  readonly amountSat: bigint;
  readonly label: string;
}

export interface LoopSwapStarted {
  readonly swapId: string;
  readonly htlcAddress: string | null;
}

/** loopd SwapState, in plain terms. */
export type RemoteSwapState =
  | 'initiated'
  | 'htlc-published'
  | 'preimage-revealed'
  | 'invoice-settled'
  | 'succeeded'
  | 'failed';

/** loopd FailureReason (FAILURE_REASON_*). */
export type LoopFailureReason =
  | 'offchain'
  | 'timeout'
  | 'sweep-timeout'
  | 'insufficient-value'
  | 'temporary'
  | 'incorrect-amount'
  | 'abandoned'
  | 'insufficient-confirmed-balance'
  | 'incorrect-htlc-amount'
  | 'unknown';

/** One swap as loopd reports it (SwapStatus). Costs are what was actually paid so far. */
export interface RemoteSwap {
  readonly id: string;
  readonly direction: LoopDirection;
  readonly state: RemoteSwapState;
  readonly failureReason: LoopFailureReason | null;
  readonly amountSat: bigint;
  readonly costServerSat: bigint;
  readonly costOnchainSat: bigint;
  readonly costOffchainSat: bigint;
  readonly htlcAddress: string | null;
  /** ISO-8601 UTC. */
  readonly initiatedAt: string;
  readonly updatedAt: string;
  readonly label: string | null;
}

/**
 * Optional Loop methods on the LNC port. A litd session reaches loopd over
 * the same connection when its macaroon allows it; the lnc-rn adapter maps
 * these onto `loop.swapClient.*`. Absent methods → "not available over this
 * connection" with the reason, never an error.
 */
export interface LoopPortExtension {
  loopTerms?(): Promise<LoopTerms>;
  loopQuote?(request: { readonly direction: LoopDirection; readonly amountSat: bigint }): Promise<RemoteLoopQuote>;
  loopOut?(request: LoopOutRequest): Promise<LoopSwapStarted>;
  loopIn?(request: LoopInRequest): Promise<LoopSwapStarted>;
  listSwaps?(): Promise<readonly RemoteSwap[]>;
  swapStatus?(swapId: string): Promise<RemoteSwap>;
}

/** Which Loop methods this port has: `run` = can quote and start swaps; `monitor` = can read them. */
export function loopSurface(port: LoopPortExtension): { readonly run: boolean; readonly monitor: boolean } {
  const has = (f: unknown): boolean => typeof f === 'function';
  return {
    run: has(port.loopTerms) && has(port.loopQuote) && has(port.loopOut) && has(port.loopIn),
    monitor: has(port.listSwaps) && has(port.swapStatus),
  };
}

// ——— quote math ———

/** The quote as the review screen renders it — every number from loopd's quote. */
export interface LoopQuoteView {
  readonly direction: LoopDirection;
  readonly amountSat: bigint;
  readonly swapFeeSat: bigint;
  /** Part of `swapFeeSat`, not added to it. */
  readonly prepayAmtSat: bigint;
  readonly minerFeeSat: bigint;
  /** Loop Out: the most the node may pay to route the swap and prepay invoices. 0 for Loop In. */
  readonly routingFeeCapSat: bigint;
  /** swap fee + miner fee + routing cap — what the user authorizes (`maxTotalFeeSat`). */
  readonly totalFeeSat: bigint;
  /** Loop Out: arrives on-chain; Loop In: arrives as Lightning balance. */
  readonly receivedSat: bigint;
  readonly swapFeePpm: number;
  readonly confTarget: number;
  readonly cltvDelta: number;
}

const big = (n: number): bigint => BigInt(n);
/** `loopRoutingFeeCapSat` from @sovereign/liquidity, on bigint sats. */
export function routingCapSat(amountSat: bigint): bigint {
  return big(loopRoutingFeeCapSat(Number(amountSat)));
}

/** Same derivation as the litd adapter's mapOutQuoteToLoopQuote / mapInQuoteToLoopQuote. */
export function buildQuoteView(quote: RemoteLoopQuote): LoopQuoteView {
  const out = quote.direction === 'loop-out';
  const routingFeeCapSat = out
    ? routingCapSat(quote.amountSat) + (quote.prepayAmtSat > 0n ? routingCapSat(quote.prepayAmtSat) : 0n)
    : 0n;
  const receivedSat = out
    ? quote.amountSat - quote.swapFeeSat - quote.minerFeeSat
    : quote.amountSat - quote.swapFeeSat;
  return {
    direction: quote.direction,
    amountSat: quote.amountSat,
    swapFeeSat: quote.swapFeeSat,
    prepayAmtSat: out ? quote.prepayAmtSat : 0n,
    minerFeeSat: quote.minerFeeSat,
    routingFeeCapSat,
    totalFeeSat: quote.swapFeeSat + quote.minerFeeSat + routingFeeCapSat,
    receivedSat,
    swapFeePpm: quote.amountSat > 0n ? Number((quote.swapFeeSat * 1_000_000n) / quote.amountSat) : 0,
    confTarget: quote.confTarget,
    cltvDelta: quote.cltvDelta,
  };
}

/** Margin on the miner-fee limit, as `LiquidityManager` (FEE_BOUND_MARGIN = 2). */
export const MINER_FEE_LIMIT_MULTIPLIER = 2n;

/** Loop Out limits from a fresh quote — the same rule `LiquidityManager.executeLoopOut` applies. */
export function loopOutFeeLimits(quote: RemoteLoopQuote): LoopOutFeeLimits {
  return {
    maxSwapFeeSat: quote.swapFeeSat,
    maxMinerFeeSat: quote.minerFeeSat * MINER_FEE_LIMIT_MULTIPLIER,
    maxPrepayAmtSat: quote.prepayAmtSat,
    maxSwapRoutingFeeSat: routingCapSat(quote.amountSat),
    maxPrepayRoutingFeeSat: routingCapSat(quote.prepayAmtSat),
  };
}

export function loopInFeeLimits(quote: RemoteLoopQuote): LoopInFeeLimits {
  return {
    maxSwapFeeSat: quote.swapFeeSat,
    maxMinerFeeSat: quote.minerFeeSat * MINER_FEE_LIMIT_MULTIPLIER,
  };
}

/** The most loopd could spend under the limits sent (the worst case, shown on review). */
export function worstCaseFeeSat(quote: RemoteLoopQuote): bigint {
  if (quote.direction === 'loop-out') {
    const l = loopOutFeeLimits(quote);
    return l.maxSwapFeeSat + l.maxMinerFeeSat + l.maxSwapRoutingFeeSat + l.maxPrepayRoutingFeeSat;
  }
  const l = loopInFeeLimits(quote);
  return l.maxSwapFeeSat + l.maxMinerFeeSat;
}

/** What the user approves on the review screen. */
export interface SwapAuthorization {
  readonly amountSat: bigint;
  readonly maxTotalFeeSat: bigint;
}

/**
 * The re-check before a swap starts: the fresh quote must be for the same
 * amount and its total must not exceed what the user authorized. Returns the
 * refusal message, or null when the swap may start.
 */
export function recheckAuthorization(fresh: LoopQuoteView, auth: SwapAuthorization): string | null {
  if (fresh.amountSat !== auth.amountSat) {
    return 'The new quote is for a different amount than you approved. Review the swap again.';
  }
  if (fresh.totalFeeSat > auth.maxTotalFeeSat) {
    return `Fees changed since you reviewed this swap: now ${groupSats(fresh.totalFeeSat)} sats, above the ${groupSats(auth.maxTotalFeeSat)} sats you approved. Review the new quote.`;
  }
  return null;
}

export function groupSats(sats: bigint): string {
  return sats.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ——— amount validation ———

/** Whole sats from user input (commas, spaces and underscores ignored); null when invalid or zero. */
export function parseSwapAmount(text: string): bigint | null {
  const s = text.replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n ? n : null;
}

export interface SwapFunds {
  /** Sendable over Lightning (Loop Out source). */
  readonly lightningSpendableSat: bigint;
  /** Confirmed on-chain (Loop In source). */
  readonly onchainSat: bigint;
  /** Receivable over Lightning (where Loop In funds land). */
  readonly receivableSat: bigint;
}

/** Amount checks that need no quote: format, server terms, source balance. */
export function swapAmountError(
  direction: LoopDirection,
  text: string,
  terms: LoopTerms | null,
  funds: SwapFunds,
): string | null {
  if (text.trim() === '') return 'Enter an amount in sats.';
  const amount = parseSwapAmount(text);
  if (amount === null) return 'Enter a whole number of sats.';
  const range = terms === null ? null : direction === 'loop-out' ? terms.loopOut : terms.loopIn;
  if (range !== null) {
    if (amount < range.minSat) return `The swap server's minimum is ${groupSats(range.minSat)} sats.`;
    if (amount > range.maxSat) return `The swap server's maximum is ${groupSats(range.maxSat)} sats.`;
  }
  if (direction === 'loop-out' && amount > funds.lightningSpendableSat) {
    return `That is more than your Lightning spendable balance (${groupSats(funds.lightningSpendableSat)} sats).`;
  }
  if (direction === 'loop-in' && amount > funds.onchainSat) {
    return `That is more than your confirmed on-chain balance (${groupSats(funds.onchainSat)} sats).`;
  }
  return null;
}

/** Checks that need the quote: the fees must fit the source, the result must fit the destination. */
export function quotedSwapError(quote: LoopQuoteView, funds: SwapFunds): string | null {
  if (quote.receivedSat <= 0n) return 'The fees would take the whole amount. Try a larger amount.';
  if (quote.direction === 'loop-out') {
    // Routing is a cap; only what is used is spent, but the amount itself must leave your channels.
    if (quote.amountSat > funds.lightningSpendableSat) {
      return `That is more than your Lightning spendable balance (${groupSats(funds.lightningSpendableSat)} sats).`;
    }
    return null;
  }
  if (quote.amountSat + quote.minerFeeSat > funds.onchainSat) {
    return `The amount plus the ${groupSats(quote.minerFeeSat)}-sat miner fee is more than your confirmed on-chain balance (${groupSats(funds.onchainSat)} sats).`;
  }
  if (quote.receivedSat > funds.receivableSat) {
    return `Your channels can receive at most ${groupSats(funds.receivableSat)} sats right now, less than the ${groupSats(quote.receivedSat)} sats this Loop In would deliver. Loop Out first to make room, or choose a smaller amount.`;
  }
  return null;
}

/** Loose address check before handing an address to loopd (which validates it fully). */
export function bitcoinAddressError(text: string, network: string): string | null {
  const a = text.trim();
  if (a === '') return null;
  const prefixes: Record<string, readonly string[]> = {
    mainnet: ['bc1'],
    testnet: ['tb1'],
    signet: ['tb1'],
    regtest: ['bcrt1'],
  };
  const expected = prefixes[network] ?? [];
  const lower = a.toLowerCase();
  if (expected.some((p) => lower.startsWith(p))) {
    return /^[a-z0-9]{14,90}$/.test(lower) ? null : 'That address has characters a Bitcoin address cannot contain.';
  }
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return null;
  return `That doesn't look like a ${network} Bitcoin address (expected ${expected.join(' or ') || 'a Bitcoin address'}…).`;
}

// ——— swap state copy ———

export const DIRECTION_LABEL: Readonly<Record<LoopDirection, string>> = {
  'loop-out': 'Loop Out',
  'loop-in': 'Loop In',
};

export function isTerminal(state: RemoteSwapState): boolean {
  return state === 'succeeded' || state === 'failed';
}

export const SWAP_STATE_LABEL: Readonly<Record<RemoteSwapState, string>> = {
  initiated: 'Started',
  'htlc-published': 'On-chain contract published',
  'preimage-revealed': 'Claiming on-chain funds',
  'invoice-settled': 'Paid over Lightning',
  succeeded: 'Completed',
  failed: 'Failed',
};

export interface SwapStep {
  readonly state: RemoteSwapState;
  readonly title: string;
  readonly body: string;
}

export const SWAP_STEPS: Readonly<Record<LoopDirection, readonly SwapStep[]>> = {
  'loop-out': [
    {
      state: 'initiated',
      title: 'Swap requested',
      body: 'Your node is paying the swap server over Lightning. The payment settles only when your node claims the on-chain funds.',
    },
    {
      state: 'htlc-published',
      title: 'Server locked the funds on-chain',
      body: 'The server published an on-chain contract that only your node can claim.',
    },
    {
      state: 'preimage-revealed',
      title: 'Claiming to your address',
      body: 'Your node claimed the contract and broadcast the sweep transaction.',
    },
    { state: 'succeeded', title: 'Completed', body: 'The sweep confirmed. The funds are on-chain.' },
  ],
  'loop-in': [
    { state: 'initiated', title: 'Swap requested', body: 'Your node agreed the terms with the swap server.' },
    {
      state: 'htlc-published',
      title: 'Your funds locked on-chain',
      body: 'Your node published an on-chain contract the server can claim only after paying you over Lightning.',
    },
    {
      state: 'invoice-settled',
      title: 'Server paid you over Lightning',
      body: 'Your Lightning spendable balance increased.',
    },
    { state: 'succeeded', title: 'Completed', body: 'The server claimed the on-chain contract.' },
  ],
};

export type StepStatus = 'done' | 'current' | 'pending' | 'failed';

/** The progress list for a swap. loopd reports only the terminal failure, not the step it failed at. */
export function swapProgress(swap: Pick<RemoteSwap, 'direction' | 'state' | 'failureReason'>): readonly {
  readonly title: string;
  readonly body: string;
  readonly status: StepStatus;
}[] {
  const steps = SWAP_STEPS[swap.direction];
  if (swap.state === 'failed') {
    const first = steps[0];
    return [
      ...(first === undefined ? [] : [{ title: first.title, body: first.body, status: 'done' as const }]),
      { title: 'Swap failed', body: explainSwapFailure(swap.direction, swap.failureReason).what, status: 'failed' },
    ];
  }
  const index = steps.findIndex((s) => s.state === swap.state);
  const at = index < 0 ? 0 : index;
  return steps.map((step, i) => ({
    title: step.title,
    body: step.body,
    status: i < at || (i === at && swap.state === 'succeeded') ? 'done' : i === at ? 'current' : 'pending',
  }));
}

/** What is happening while a swap is pending, and whether the user needs to do anything. */
export function pendingExplanation(swap: Pick<RemoteSwap, 'direction' | 'state'>): string {
  const node = 'The swap runs on your node, not on this phone: you can close the app and check back later.';
  if (swap.direction === 'loop-out') {
    switch (swap.state) {
      case 'initiated':
        return `Waiting for the swap server to lock the funds on-chain. If it never does, the Lightning payment is not settled and only the small prepayment can be lost. ${node}`;
      case 'htlc-published':
        return `Waiting for the server's on-chain contract to confirm before your node claims it. ${node}`;
      case 'preimage-revealed':
        return `Your node's claim transaction is waiting for a confirmation. ${node}`;
      default:
        return node;
    }
  }
  switch (swap.state) {
    case 'initiated':
      return `Your node is publishing the on-chain contract with your funds. ${node}`;
    case 'htlc-published':
      return `Waiting for the contract to confirm; then the server pays you over Lightning. If it never pays, your node takes the funds back after the timeout, minus miner fees. ${node}`;
    case 'invoice-settled':
      return `You have been paid. The server is claiming the on-chain contract, which needs nothing from you. ${node}`;
    default:
      return node;
  }
}

/** Plain-language failure: what happened and what to do next. */
export function explainSwapFailure(
  direction: LoopDirection,
  reason: LoopFailureReason | null,
): { readonly what: string; readonly next: string } {
  switch (reason) {
    case 'offchain':
      return {
        what: 'Your node could not pay the swap server over Lightning (no route, or no single channel had enough balance).',
        next: 'Nothing was swapped. Try a smaller amount, or wait and try again.',
      };
    case 'timeout':
      return direction === 'loop-in'
        ? {
            what: 'The swap server did not pay before the on-chain contract timed out.',
            next: 'Your node takes the funds back on-chain automatically; only miner fees are lost.',
          }
        : {
            what: 'The on-chain contract did not confirm in time.',
            next: 'The Lightning payment was not settled. Start a new swap if you still need it.',
          };
    case 'sweep-timeout':
      return {
        what: 'Your node could not claim the on-chain contract before it expired.',
        next: 'Check your node on the desktop app; the swap server may have reclaimed the contract.',
      };
    case 'insufficient-value':
      return {
        what: 'At current miner fees, the on-chain amount was too small to claim.',
        next: 'Try a larger amount, or wait for lower fees.',
      };
    case 'incorrect-amount':
    case 'incorrect-htlc-amount':
      return {
        what: "The on-chain contract amount didn't match the agreed terms, so your node refused it.",
        next: 'Nothing was swapped. Start a new swap.',
      };
    case 'abandoned':
      return {
        what: 'The swap was abandoned before it completed.',
        next: 'If a prepayment was made, the server may keep it. Start a new swap if you still need it.',
      };
    case 'insufficient-confirmed-balance':
      return {
        what: 'Your node did not have enough confirmed on-chain funds to publish the contract.',
        next: 'Wait for deposits to confirm, or choose a smaller amount.',
      };
    case 'temporary':
      return {
        what: 'The swap failed with a temporary error.',
        next: 'Start a new swap; this one will not be retried.',
      };
    case 'unknown':
    case null:
      return {
        what: 'Your node reported the swap as failed without a reason.',
        next: 'Check the swap on the desktop app for details.',
      };
  }
}

export function totalCostSat(swap: Pick<RemoteSwap, 'costServerSat' | 'costOnchainSat' | 'costOffchainSat'>): bigint {
  return swap.costServerSat + swap.costOnchainSat + swap.costOffchainSat;
}

// ——— FROM → TO routes ———

export type TransferEndpointId =
  | 'lightning'
  | 'onchain'
  | 'wallet'
  | 'external-btc'
  | 'external-lightning'
  | 'taproot-asset'
  | 'external-address'
  | 'invoice'
  | 'asset-address'
  | 'other-chain';

export interface TransferEndpoint {
  readonly id: TransferEndpointId;
  readonly label: string;
  readonly detail: string;
}

const ENDPOINTS: Readonly<Record<TransferEndpointId, Omit<TransferEndpoint, 'id'>>> = {
  lightning: { label: 'Lightning balance', detail: "Your side of your node's channels" },
  onchain: { label: 'On-chain bitcoin', detail: "Your node's on-chain wallet" },
  wallet: { label: 'This wallet', detail: 'Your everyday wallet balance' },
  'external-btc': { label: 'External Bitcoin wallet', detail: 'Another wallet or exchange, on-chain' },
  'external-lightning': { label: 'External Lightning wallet', detail: 'Another wallet that pays invoices' },
  'taproot-asset': { label: 'Taproot Assets', detail: "Assets held by your node's tapd" },
  'external-address': { label: 'Bitcoin address', detail: 'Any address on this network' },
  invoice: { label: 'Lightning invoice', detail: 'Pay a BOLT 11 request' },
  'asset-address': { label: 'Taproot Assets address', detail: 'A tap address for one asset' },
  'other-chain': { label: 'Another blockchain', detail: 'Ethereum, Tron, Solana…' },
};

const endpoint = (id: TransferEndpointId): TransferEndpoint => ({ id, ...ENDPOINTS[id] });

/** Sources and destinations offered per backend — Wavelength has one balance, a node has two. */
export function transferSources(backend: BackendKind): readonly TransferEndpoint[] {
  return backend === 'remote-lnd'
    ? (['lightning', 'onchain', 'external-btc', 'taproot-asset'] as const).map(endpoint)
    : (['wallet', 'external-btc', 'external-lightning'] as const).map(endpoint);
}

export function transferDestinations(backend: BackendKind): readonly TransferEndpoint[] {
  return backend === 'remote-lnd'
    ? (['onchain', 'lightning', 'external-address', 'invoice', 'asset-address', 'other-chain'] as const).map(endpoint)
    : (['wallet', 'external-address', 'invoice', 'other-chain'] as const).map(endpoint);
}

/** Where a route continues: inline swap flow here, or a hand-off to the screen that owns it. */
export type RouteAction =
  | { readonly kind: 'swap'; readonly direction: LoopDirection }
  | {
      readonly kind: 'handoff';
      readonly to: 'send-lightning' | 'send-onchain' | 'receive-lightning' | 'receive-onchain' | 'assets';
      readonly label: string;
    };

export type RailId =
  | 'loop-out'
  | 'loop-in'
  | 'lightning-payment'
  | 'onchain-send'
  | 'deposit-address'
  | 'receive-invoice'
  | 'asset-send'
  | 'wavelength-lightning-send'
  | 'wavelength-onchain-send'
  | 'wavelength-boarding'
  | 'wavelength-lightning-receive';

/** What the transfer screen knows right now. Every value comes from the backend. */
export interface RouteEnv {
  readonly backend: BackendKind;
  readonly features: Readonly<Record<FeatureId, FeatureStatus>>;
  readonly lightningSpendableSat: bigint | null;
  readonly onchainSat: bigint | null;
  readonly receivableSat: bigint | null;
  readonly activeChannels: number | null;
  /** Remote LND: can this connection quote and start Loop swaps? */
  readonly loopRunnable: boolean;
  /** Remote LND: terms read failed (server unreachable etc.); null when fine or unknown. */
  readonly loopTermsError: string | null;
  readonly assetCount: number | null;
}

export interface Blocker {
  readonly reason: string;
  readonly fix?: string;
}

export interface RouteAdapter {
  readonly rail: RailId;
  readonly backend: BackendKind;
  readonly label: string;
  readonly provider: string;
  readonly summary: string;
  readonly timing: string;
  readonly risks: readonly string[];
  readonly action: RouteAction;
  readonly matches: (from: TransferEndpointId, to: TransferEndpointId) => boolean;
  readonly check: (env: RouteEnv) => Blocker | null;
}

const feature = (env: RouteEnv, id: FeatureId): Blocker | null => {
  const f = env.features[id];
  return f.available ? null : { reason: f.reason };
};

const first = (...checks: (Blocker | null)[]): Blocker | null => checks.find((c) => c !== null) ?? null;

const loopBlocker = (env: RouteEnv): Blocker | null =>
  first(
    feature(env, 'loopSwaps'),
    env.loopTermsError !== null
      ? {
          reason: `Your node's Loop service could not reach the swap server: ${env.loopTermsError}`,
          fix: 'Check Loop on the desktop app connected to the same node, then retry.',
        }
      : null,
  );

const needsChannel = (env: RouteEnv): Blocker | null =>
  env.activeChannels === 0
    ? { reason: 'Your node has no active Lightning channel.', fix: 'Open a channel from the desktop app first.' }
    : null;

const noFunds = (value: bigint | null, reason: string, fix?: string): Blocker | null =>
  value !== null && value <= 0n ? (fix === undefined ? { reason } : { reason, fix }) : null;

export const ROUTE_ADAPTERS: readonly RouteAdapter[] = [
  // ——— remote LND over LNC ———
  {
    rail: 'loop-out',
    backend: 'remote-lnd',
    label: 'Loop Out',
    provider: 'Lightning Loop on your node',
    summary:
      'Your node pays the swap server over Lightning; the server sends the amount, minus fees, to a Bitcoin address in an on-chain contract only your node can claim. Frees up receiving capacity.',
    timing: 'A few blocks: the server publishes the contract, then your node claims it.',
    risks: [
      'The swap is atomic: your node only completes the Lightning payment once the on-chain contract exists.',
      'A small prepayment, part of the swap fee, is paid up front and kept by the server if the swap is abandoned.',
      'Miner fees can rise; the swap is re-quoted and refused if fees exceed what you approved.',
    ],
    action: { kind: 'swap', direction: 'loop-out' },
    matches: (from, to) => from === 'lightning' && (to === 'onchain' || to === 'external-address'),
    check: (env) =>
      first(
        loopBlocker(env),
        needsChannel(env),
        noFunds(env.lightningSpendableSat, 'No spendable Lightning balance to swap out.'),
      ),
  },
  {
    rail: 'loop-in',
    backend: 'remote-lnd',
    label: 'Loop In',
    provider: 'Lightning Loop on your node',
    summary:
      "Your node locks on-chain funds in a contract; the swap server pays you the amount, minus its fee, over Lightning. Adds to what you can send.",
    timing: 'The contract needs a confirmation or more before the server pays.',
    risks: [
      'If the server never pays, your node takes the funds back after the timeout, minus miner fees.',
      'Miner fees can rise; the swap is re-quoted and refused if fees exceed what you approved.',
    ],
    action: { kind: 'swap', direction: 'loop-in' },
    matches: (from, to) => from === 'onchain' && to === 'lightning',
    check: (env) =>
      first(
        loopBlocker(env),
        needsChannel(env),
        noFunds(env.onchainSat, 'No confirmed on-chain funds to swap in.'),
        noFunds(
          env.receivableSat,
          'Your channels have no room to receive the swapped funds.',
          'Loop Out first to make room.',
        ),
      ),
  },
  {
    rail: 'lightning-payment',
    backend: 'remote-lnd',
    label: 'Lightning payment',
    provider: 'Your node',
    summary: 'Your node pays the invoice over its channels.',
    timing: 'Usually seconds.',
    risks: ['The invoice may expire or the route may fail; nothing is spent if it does.'],
    action: { kind: 'handoff', to: 'send-lightning', label: 'Continue in Send' },
    matches: (from, to) => from === 'lightning' && to === 'invoice',
    check: (env) =>
      first(
        feature(env, 'lightningSend'),
        needsChannel(env),
        noFunds(env.lightningSpendableSat, 'No spendable Lightning balance.', 'Loop In to add sending capacity.'),
      ),
  },
  {
    rail: 'onchain-send',
    backend: 'remote-lnd',
    label: 'On-chain send',
    provider: "Your node's wallet",
    summary: "A Bitcoin transaction from your node's wallet to the address.",
    timing: 'Final after about 1–6 blocks.',
    risks: ['Irreversible once confirmed: check the address.'],
    action: { kind: 'handoff', to: 'send-onchain', label: 'Continue in Send' },
    matches: (from, to) => from === 'onchain' && to === 'external-address',
    check: (env) => first(feature(env, 'onchainSend'), noFunds(env.onchainSat, 'No confirmed on-chain funds.')),
  },
  {
    rail: 'deposit-address',
    backend: 'remote-lnd',
    label: 'Deposit to your node',
    provider: "Your node's wallet",
    summary: "A fresh address in your node's wallet; send to it from the other wallet.",
    timing: 'Spendable after a confirmation.',
    risks: ['Only send bitcoin on this network to the address.'],
    action: { kind: 'handoff', to: 'receive-onchain', label: 'Continue in Receive' },
    matches: (from, to) => from === 'external-btc' && to === 'onchain',
    check: (env) => feature(env, 'onchainReceive'),
  },
  {
    rail: 'receive-invoice',
    backend: 'remote-lnd',
    label: 'Receive over Lightning',
    provider: 'Your node',
    summary: 'Create an invoice on your node and pay it from a Lightning wallet.',
    timing: 'Seconds once paid.',
    risks: ['The amount cannot be more than your receiving capacity.'],
    action: { kind: 'handoff', to: 'receive-lightning', label: 'Continue in Receive' },
    matches: (from, to) => (from === 'external-btc' || from === 'external-lightning') && to === 'lightning',
    check: (env) =>
      first(
        feature(env, 'lightningReceive'),
        needsChannel(env),
        noFunds(env.receivableSat, 'Your channels have no room to receive.', 'Loop Out some Lightning balance to make room.'),
      ),
  },
  {
    rail: 'asset-send',
    backend: 'remote-lnd',
    label: 'Taproot Assets send',
    provider: "Your node's tapd",
    summary: 'Sends the asset amount the address asks for, anchored in a Bitcoin transaction.',
    timing: 'Final when the anchor transaction confirms.',
    risks: ['The address fixes the asset and the amount; check both.', 'Your node pays the on-chain fee in sats.'],
    action: { kind: 'handoff', to: 'assets', label: 'Choose an asset to send' },
    matches: (from, to) => from === 'taproot-asset' && to === 'asset-address',
    check: (env) =>
      first(
        feature(env, 'taprootAssets'),
        env.assetCount === 0 ? { reason: 'Your node holds no Taproot Assets.' } : null,
      ),
  },
  // ——— Wavelength (everyday wallet) ———
  {
    rail: 'wavelength-lightning-send',
    backend: 'wavelength',
    label: 'Pay a Lightning invoice',
    provider: "Wavelength's swap service",
    summary: 'Your wallet pays the invoice through the swap service; its fee is quoted before you confirm.',
    timing: 'Usually seconds.',
    risks: ['The swap service is a counterparty for the payment.'],
    action: { kind: 'handoff', to: 'send-lightning', label: 'Continue in Send' },
    matches: (from, to) => from === 'wallet' && to === 'invoice',
    check: (env) => first(feature(env, 'lightningSend'), noFunds(env.lightningSpendableSat, 'No spendable balance.')),
  },
  {
    rail: 'wavelength-onchain-send',
    backend: 'wavelength',
    label: 'Withdraw on-chain',
    provider: 'The Ark operator',
    summary: 'Sends from your wallet balance to a Bitcoin address; the fee is quoted before you confirm.',
    timing: 'Final after the on-chain transaction confirms.',
    risks: ['Irreversible once confirmed: check the address.'],
    action: { kind: 'handoff', to: 'send-onchain', label: 'Continue in Send' },
    matches: (from, to) => from === 'wallet' && to === 'external-address',
    check: (env) => first(feature(env, 'onchainSend'), noFunds(env.lightningSpendableSat, 'No spendable balance.')),
  },
  {
    rail: 'wavelength-boarding',
    backend: 'wavelength',
    label: 'Deposit on-chain (boarding)',
    provider: 'The Ark operator',
    summary: 'A boarding address for this wallet. A deposit becomes spendable once it confirms and joins a batch.',
    timing: 'After the deposit confirms and the next batch includes it.',
    risks: ['Only send bitcoin on this network to the address.'],
    action: { kind: 'handoff', to: 'receive-onchain', label: 'Continue in Receive' },
    matches: (from, to) => from === 'external-btc' && to === 'wallet',
    check: (env) => feature(env, 'onchainReceive'),
  },
  {
    rail: 'wavelength-lightning-receive',
    backend: 'wavelength',
    label: 'Receive over Lightning',
    provider: "Wavelength's swap service",
    summary: 'An invoice paid through the swap service into this wallet. Invoices need an amount.',
    timing: 'Seconds once paid.',
    risks: ['The swap service is a counterparty for the payment.'],
    action: { kind: 'handoff', to: 'receive-lightning', label: 'Continue in Receive' },
    matches: (from, to) => from === 'external-lightning' && to === 'wallet',
    check: (env) => feature(env, 'lightningReceive'),
  },
];

/** Why a pair has no rail at all on this backend. */
export function noRouteReason(
  backend: BackendKind,
  from: TransferEndpointId,
  to: TransferEndpointId,
): { readonly reason: string; readonly fix?: string } {
  if (to === 'other-chain') {
    return {
      reason:
        'There is no cross-chain route. This wallet only moves bitcoin (and, on a node, Taproot Assets). Reaching Ethereum, Tron or Solana would need a third-party bridge or custodian, which this self-custodial wallet does not use.',
    };
  }
  if (from === 'taproot-asset') {
    return { reason: 'Taproot Assets move only to Taproot Assets addresses.' };
  }
  if (to === 'asset-address') {
    return { reason: 'A Taproot Assets address receives a specific asset, not bitcoin. Choose Taproot Assets as the source.' };
  }
  if (from === 'external-btc' || from === 'external-lightning') {
    if (to === 'external-address' || to === 'invoice') {
      return { reason: 'This wallet is not part of that transfer. Send directly from the other wallet.' };
    }
    if (backend === 'remote-lnd' && from === 'external-lightning' && to === 'onchain') {
      return {
        reason: 'A Lightning payment lands in your channels, not on-chain.',
        fix: 'Receive over Lightning, then Loop Out to move it on-chain.',
      };
    }
    if (backend === 'wavelength' && from === 'external-btc') {
      return { reason: 'No rail connects these two.' };
    }
  }
  if (from === to) {
    return { reason: from === 'onchain' ? 'The funds are already on-chain.' : 'The funds are already there.' };
  }
  if (backend === 'remote-lnd' && from === 'onchain' && to === 'invoice') {
    return {
      reason: 'Lightning invoices are paid from Lightning balance. Loop does not pay third-party invoices from on-chain funds.',
      fix: 'Loop In first, then pay the invoice.',
    };
  }
  if (backend === 'wavelength') {
    return {
      reason:
        "The everyday wallet holds one balance, used for both Lightning and on-chain payments, so there is nothing to move between. Loop needs your own Lightning node and isn't used here.",
    };
  }
  return { reason: 'No rail connects these two.' };
}

export interface RouteCandidate {
  readonly adapter: RouteAdapter;
  readonly blocker: Blocker | null;
}

export interface RouteResolution {
  readonly candidates: readonly RouteCandidate[];
  readonly noRoute?: { readonly reason: string; readonly fix?: string };
}

/** Every rail this backend has for the pair, with its live blocker. */
export function resolveTransferRoutes(
  from: TransferEndpointId,
  to: TransferEndpointId,
  env: RouteEnv,
  adapters: readonly RouteAdapter[] = ROUTE_ADAPTERS,
): RouteResolution {
  const candidates = adapters
    .filter((a) => a.backend === env.backend && a.matches(from, to))
    .map((adapter) => ({ adapter, blocker: adapter.check(env) }));
  if (candidates.length === 0) return { candidates, noRoute: noRouteReason(env.backend, from, to) };
  return { candidates };
}

/** Does any rail exist for the pair on this backend (ignoring live blockers)? */
export function hasRail(
  backend: BackendKind,
  from: TransferEndpointId,
  to: TransferEndpointId,
  adapters: readonly RouteAdapter[] = ROUTE_ADAPTERS,
): boolean {
  return adapters.some((a) => a.backend === backend && a.matches(from, to));
}

// ——— device authorization hook ———

/**
 * The device-authorization step before a swap starts. The app-lock /
 * biometric module (`flows/appLock.ts`, built separately) plugs in here
 * through `ModeBRemoteControllerOptions.authorizeTransfer`. Without one, the
 * review screen's explicit confirm is the only authorization, and the screen
 * says so.
 */
export type TransferAuthorizer = (request: { readonly reason: string }) => Promise<boolean>;

// ——— remote-node swap store ———

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'failed' | 'unavailable';

export interface SwapDraft {
  readonly direction: LoopDirection;
  readonly amountText: string;
  /** Loop Out only; empty = a fresh address in your node's wallet. */
  readonly destinationText: string;
  readonly stage: 'edit' | 'quoting' | 'review' | 'confirming';
  /** The quote the review shows; fee limits are derived from a FRESH quote at confirm. */
  readonly quote: LoopQuoteView | null;
  readonly error: string | null;
}

export interface RemoteSwapsState {
  readonly terms: LoopTerms | null;
  readonly termsStatus: LoadStatus;
  readonly termsError: string | null;
  readonly swaps: readonly RemoteSwap[] | null;
  readonly swapsStatus: LoadStatus;
  readonly swapsError: string | null;
  readonly draft: SwapDraft | null;
  /** The swap whose progress is being followed (opened from history, or just started). */
  readonly watchedId: string | null;
  readonly watched: RemoteSwap | null;
  readonly watchError: string | null;
}

const INITIAL: RemoteSwapsState = {
  terms: null,
  termsStatus: 'idle',
  termsError: null,
  swaps: null,
  swapsStatus: 'idle',
  swapsError: null,
  draft: null,
  watchedId: null,
  watched: null,
  watchError: null,
};

export interface RemoteSwapStoreOptions {
  readonly port: LoopPortExtension;
  readonly network: string;
  /** Swaps start only while the app is open (same rule as payments). */
  readonly isForegrounded: () => boolean;
  readonly authorize?: TransferAuthorizer;
  /** Called when a watched swap reaches a terminal state (refresh balances). */
  readonly onSwapChanged?: () => void;
  /** Status poll cadence while a swap's progress is open. */
  readonly pollIntervalMs?: number;
}

export class RemoteSwapStore {
  private state: RemoteSwapsState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: RemoteSwapStoreOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RemoteSwapsState => this.state;

  surface(): { readonly run: boolean; readonly monitor: boolean } {
    return loopSurface(this.options.port);
  }

  /** True when a device-authorization step runs before swaps start. */
  hasDeviceAuthorization(): boolean {
    return this.options.authorize !== undefined;
  }

  async loadTerms(): Promise<void> {
    const terms = this.options.port.loopTerms;
    if (terms === undefined) {
      this.set({ termsStatus: 'unavailable', termsError: null });
      return;
    }
    this.set({ termsStatus: 'loading', termsError: null });
    try {
      this.set({ terms: await terms.call(this.options.port), termsStatus: 'loaded' });
    } catch (error) {
      this.set({ termsStatus: 'failed', termsError: describe(error) });
    }
  }

  async loadSwaps(): Promise<void> {
    const list = this.options.port.listSwaps;
    if (list === undefined) {
      this.set({ swapsStatus: 'unavailable', swapsError: null });
      return;
    }
    if (this.state.swaps === null) this.set({ swapsStatus: 'loading', swapsError: null });
    try {
      const swaps = [...(await list.call(this.options.port))].sort((a, b) =>
        b.initiatedAt.localeCompare(a.initiatedAt),
      );
      this.set({ swaps, swapsStatus: 'loaded', swapsError: null });
    } catch (error) {
      this.set({ swapsStatus: 'failed', swapsError: describe(error) });
    }
  }

  /** Swaps that have not reached a terminal state (from the last history read). */
  pendingSwaps(): readonly RemoteSwap[] {
    return (this.state.swaps ?? []).filter((s) => !isTerminal(s.state));
  }

  // ——— draft ———

  beginDraft(direction: LoopDirection, amountSat?: bigint): void {
    this.set({
      draft: {
        direction,
        amountText: amountSat === undefined ? '' : amountSat.toString(),
        destinationText: '',
        stage: 'edit',
        quote: null,
        error: null,
      },
    });
    if (this.state.termsStatus !== 'loaded') void this.loadTerms();
  }

  editAmount(text: string): void {
    this.patchDraft({ amountText: text, error: null, stage: 'edit', quote: null });
  }

  editDestination(text: string): void {
    this.patchDraft({ destinationText: text, error: null, stage: 'edit', quote: null });
  }

  backToEdit(): void {
    this.patchDraft({ stage: 'edit', error: null });
  }

  discardDraft(): void {
    this.set({ draft: null });
  }

  /** Validate, fetch a live quote and move to review. */
  async review(funds: SwapFunds): Promise<void> {
    const draft = this.state.draft;
    if (draft === null) return;
    const quoteFn = this.options.port.loopQuote;
    if (quoteFn === undefined) {
      this.patchDraft({ error: "Loop quotes aren't available over this connection." });
      return;
    }
    const amountError = swapAmountError(draft.direction, draft.amountText, this.state.terms, funds);
    if (amountError !== null) {
      this.patchDraft({ error: amountError });
      return;
    }
    if (draft.direction === 'loop-out') {
      const addressError = bitcoinAddressError(draft.destinationText, this.options.network);
      if (addressError !== null) {
        this.patchDraft({ error: addressError });
        return;
      }
    }
    const amountSat = parseSwapAmount(draft.amountText);
    if (amountSat === null) return;
    this.patchDraft({ stage: 'quoting', error: null });
    try {
      const raw = await quoteFn.call(this.options.port, { direction: draft.direction, amountSat });
      const quote = buildQuoteView(raw);
      const quotedError = quotedSwapError(quote, funds);
      if (quotedError !== null) {
        this.patchDraft({ stage: 'edit', error: quotedError });
        return;
      }
      this.patchDraft({ stage: 'review', quote });
    } catch (error) {
      this.patchDraft({ stage: 'edit', error: `No quote: ${describe(error)}` });
    }
  }

  /**
   * Confirm the reviewed swap: device authorization → fresh quote → refuse if
   * fees rose above the reviewed total → start with explicit fee limits.
   * Returns the new swap id, or null when it did not start (the draft says why).
   */
  async confirm(): Promise<string | null> {
    const draft = this.state.draft;
    if (draft === null || draft.stage !== 'review' || draft.quote === null) return null;
    const { port } = this.options;
    const quoteFn = port.loopQuote;
    const start = draft.direction === 'loop-out' ? port.loopOut : port.loopIn;
    if (quoteFn === undefined || start === undefined) {
      this.patchDraft({ error: "Starting swaps isn't available over this connection." });
      return null;
    }
    if (!this.options.isForegrounded()) {
      this.patchDraft({ error: 'Swaps start only while the app is open. Reopen the app and try again.' });
      return null;
    }
    const authorization: SwapAuthorization = {
      amountSat: draft.quote.amountSat,
      maxTotalFeeSat: draft.quote.totalFeeSat,
    };
    this.patchDraft({ stage: 'confirming', error: null });
    try {
      if (this.options.authorize !== undefined) {
        const approved = await this.options.authorize({
          reason: `Approve ${DIRECTION_LABEL[draft.direction]} of ${groupSats(authorization.amountSat)} sats`,
        });
        if (!approved) {
          this.patchDraft({ stage: 'review', error: 'Device authorization was not given, so the swap did not start.' });
          return null;
        }
      }
      const freshRaw = await quoteFn.call(port, { direction: draft.direction, amountSat: authorization.amountSat });
      const fresh = buildQuoteView(freshRaw);
      const refusal = recheckAuthorization(fresh, authorization);
      if (refusal !== null) {
        // Show the new numbers; the user must review again.
        this.patchDraft({ stage: 'review', quote: fresh, error: refusal });
        return null;
      }
      const label = `mobile ${draft.direction}`;
      const started =
        draft.direction === 'loop-out'
          ? await port.loopOut?.call(port, {
              amountSat: authorization.amountSat,
              destAddress: draft.destinationText.trim() === '' ? null : draft.destinationText.trim(),
              sweepConfTarget: fresh.confTarget,
              label,
              ...loopOutFeeLimits(freshRaw),
            })
          : await port.loopIn?.call(port, { amountSat: authorization.amountSat, label, ...loopInFeeLimits(freshRaw) });
      if (started === undefined) return null;
      this.set({ draft: null });
      this.watch(started.swapId);
      void this.loadSwaps();
      this.options.onSwapChanged?.();
      return started.swapId;
    } catch (error) {
      this.patchDraft({ stage: 'review', error: `The swap did not start: ${describe(error)}` });
      return null;
    }
  }

  // ——— progress ———

  /** Follow one swap's status until it is terminal. */
  watch(swapId: string): void {
    this.clearPoll();
    const known = this.state.swaps?.find((s) => s.id === swapId) ?? null;
    this.set({ watchedId: swapId, watched: known, watchError: null });
    void this.pollWatched();
  }

  stopWatching(): void {
    this.clearPoll();
    this.set({ watchedId: null, watched: null, watchError: null });
  }

  stop(): void {
    this.clearPoll();
  }

  private async pollWatched(): Promise<void> {
    const id = this.state.watchedId;
    const status = this.options.port.swapStatus;
    if (id === null) return;
    if (status === undefined) {
      this.set({ watchError: "Swap status isn't available over this connection." });
      return;
    }
    try {
      const swap = await status.call(this.options.port, id);
      if (this.state.watchedId !== id) return;
      const changed = this.state.watched?.state !== swap.state;
      this.set({ watched: swap, watchError: null, swaps: mergeSwap(this.state.swaps, swap) });
      if (changed) this.options.onSwapChanged?.();
      if (isTerminal(swap.state)) return;
    } catch (error) {
      if (this.state.watchedId !== id) return;
      this.set({ watchError: `Could not read the swap's status: ${describe(error)}. Retrying.` });
    }
    this.pollTimer = setTimeout(() => void this.pollWatched(), this.pollIntervalMs);
  }

  private clearPoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private patchDraft(partial: Partial<SwapDraft>): void {
    if (this.state.draft === null) return;
    this.set({ draft: { ...this.state.draft, ...partial } });
  }

  private set(partial: Partial<RemoteSwapsState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

function mergeSwap(list: readonly RemoteSwap[] | null, swap: RemoteSwap): readonly RemoteSwap[] | null {
  if (list === null) return null;
  const index = list.findIndex((s) => s.id === swap.id);
  if (index < 0) return [swap, ...list];
  return list.map((s, i) => (i === index ? swap : s));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
