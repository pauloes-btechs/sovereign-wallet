/**
 * Transfer route registry: which rail moves value from a source to a
 * destination, given what this node can actually do right now.
 *
 * Pure data + functions (no React, no I/O) so the rules are unit-tested and
 * a new provider is one more entry in ROUTE_ADAPTERS — the Transfers page
 * renders whatever this resolves to and never invents a route.
 *
 * Two kinds of "no":
 * - A pair with NO rail at all (e.g. Lightning → Ethereum) resolves to
 *   `noRoute` with the reason. No bridge or custodian is ever substituted.
 * - A pair whose rail exists but cannot run right now (e.g. the Loop swap
 *   server is offline) resolves to a candidate with a `blocker` that says
 *   why and what would fix it.
 */

export type SourceId = 'onchain' | 'lightning' | 'external-btc' | 'taproot-asset';
export type DestinationId = 'onchain' | 'lightning' | 'external-address' | 'invoice' | 'asset-address' | 'other-chain';

export type RailId =
  | 'onchain-send'
  | 'lightning-payment'
  | 'loop-out'
  | 'loop-in'
  | 'static-loop-in'
  | 'channel-open'
  | 'funding-address'
  | 'funding-invoice'
  | 'asset-send';

export interface SourceDef {
  readonly id: SourceId;
  readonly label: string;
  readonly detail: string;
}

export interface DestinationDef {
  readonly id: DestinationId;
  readonly label: string;
  readonly detail: string;
}

export const SOURCES: readonly SourceDef[] = [
  { id: 'onchain', label: 'On-chain bitcoin', detail: 'This wallet, spendable now' },
  { id: 'lightning', label: 'Lightning balance', detail: 'This wallet, your side of open channels' },
  { id: 'external-btc', label: 'External Bitcoin wallet', detail: 'Another wallet or exchange funds this one' },
  { id: 'taproot-asset', label: 'Taproot Assets', detail: 'Assets held by this node (tapd)' },
];

export const DESTINATIONS: readonly DestinationDef[] = [
  { id: 'onchain', label: 'On-chain bitcoin', detail: 'This wallet' },
  { id: 'lightning', label: 'Lightning outbound', detail: 'This wallet, spendable capacity' },
  { id: 'external-address', label: 'External Bitcoin address', detail: 'Any bc1 / tb1 / bcrt1 address' },
  { id: 'invoice', label: 'Lightning invoice', detail: 'Pay a BOLT 11 request' },
  { id: 'asset-address', label: 'Taproot Assets address', detail: 'A tapbc1 / taptb1 / taprt1 address' },
  { id: 'other-chain', label: 'Another blockchain', detail: 'Ethereum, Tron, Solana, …' },
];

/** What the page knows about the node right now. Every field comes from a bridge response. */
export interface RouteEnv {
  readonly onchainSpendableSat: number;
  readonly lightningSpendableSat: number;
  readonly lightningReceivableSat: number;
  readonly openChannels: number;
  /** null while unknown. */
  readonly loopRunning: boolean | null;
  readonly loopOperator: 'offline' | 'configured' | 'upstream-default' | null;
  readonly loopOperatorHost?: string;
  readonly tapdRunning: boolean | null;
  readonly assetCount: number;
}

export interface Blocker {
  readonly reason: string;
  readonly fix?: string;
  /** 'provider' = an external service is down; 'funds' = this wallet lacks balance/capacity; 'service' = a local daemon is down. */
  readonly kind: 'provider' | 'funds' | 'service';
}

export interface RouteAdapter {
  readonly rail: RailId;
  readonly label: string;
  readonly provider: string;
  readonly summary: string;
  readonly timing: string;
  readonly dependencies: readonly string[];
  readonly risks: readonly string[];
  /** Executes on this page (true) or hands off to the page that owns it. */
  readonly inline: boolean;
  readonly handoff?: { readonly to: string; readonly label: string };
  readonly matches: (source: SourceId, destination: DestinationId) => boolean;
  readonly check: (env: RouteEnv) => Blocker | null;
}

const LOOP_SERVER_FIX_REGTEST =
  'On regtest, run Lightning Labs’ lightninglabs/loopserver image and restart the bridge with --loopServer <host:port>. On signet and mainnet loopd uses Lightning Labs’ hosted swap server.';

/** Shared Loop provider check: sub-server running and swap server configured. */
export function loopBlocker(env: RouteEnv): Blocker | null {
  if (env.loopRunning === false) {
    return { kind: 'service', reason: 'The Loop sub-server (loopd) inside litd is not running.', fix: 'Check Node overview for the loopd error; litd restarts it with the node.' };
  }
  if (env.loopOperator === 'offline') {
    return {
      kind: 'provider',
      reason: `No Loop swap server is configured for this node (loopd points at ${env.loopOperatorHost ?? 'an unroutable address'} on purpose), so it cannot quote or run swaps.`,
      fix: LOOP_SERVER_FIX_REGTEST,
    };
  }
  return null;
}

const needsChannel = (env: RouteEnv): Blocker | null =>
  env.openChannels === 0 ? { kind: 'funds', reason: 'This wallet has no open Lightning channel.', fix: 'Open a channel on the Channels page first.' } : null;

const first = (...checks: (Blocker | null)[]): Blocker | null => checks.find((c) => c !== null) ?? null;

export const ROUTE_ADAPTERS: readonly RouteAdapter[] = [
  {
    rail: 'onchain-send',
    label: 'On-chain send',
    provider: 'LND wallet',
    summary: 'A regular Bitcoin transaction from this wallet’s UTXOs to the address.',
    timing: 'Broadcast immediately; final after about 1–6 blocks (10–60 min on mainnet).',
    dependencies: ['LND wallet', 'the Bitcoin fee market'],
    risks: ['Irreversible once confirmed: check the address.', 'A low fee rate can leave the transaction unconfirmed for a long time.'],
    inline: true,
    matches: (s, d) => s === 'onchain' && d === 'external-address',
    check: (env) => (env.onchainSpendableSat <= 0 ? { kind: 'funds', reason: 'No confirmed on-chain funds to spend.', fix: 'Fund the wallet from an external wallet first.' } : null),
  },
  {
    rail: 'lightning-payment',
    label: 'Lightning payment',
    provider: 'LND router',
    summary: 'Pays the invoice over your channels; the route is found at payment time.',
    timing: 'Usually seconds.',
    dependencies: ['an open channel with enough outbound', 'a route to the recipient'],
    risks: ['Routing fees are only known after the payment; this wallet caps them.', 'The invoice may expire or the route may fail; nothing is spent if it does.'],
    inline: true,
    matches: (s, d) => s === 'lightning' && d === 'invoice',
    check: (env) => first(needsChannel(env), env.lightningSpendableSat <= 0 ? { kind: 'funds', reason: 'No spendable Lightning balance.', fix: 'Loop In or open a channel to add outbound capacity.' } : null),
  },
  {
    rail: 'loop-out',
    label: 'Loop Out',
    provider: 'Lightning Loop (loopd + Lightning Labs swap server)',
    summary: 'Pays the swap server over Lightning; it sends the same amount (minus fees) to a Bitcoin address via an on-chain HTLC that only you can sweep.',
    timing: 'Several blocks: the server publishes the HTLC, then your sweep confirms at the target you pick.',
    dependencies: ['loopd (litd sub-server)', 'Loop swap server', 'an open channel with outbound'],
    risks: [
      'The swap server is a counterparty, but the swap is atomic: you only release the preimage when the on-chain HTLC exists.',
      'A no-show prepayment (small, non-refundable) is paid up front.',
      'Miner fees can rise between quote and sweep; the bridge re-quotes and refuses if the total exceeds what you approved.',
    ],
    inline: true,
    matches: (s, d) => s === 'lightning' && (d === 'onchain' || d === 'external-address'),
    check: (env) => first(loopBlocker(env), needsChannel(env), env.lightningSpendableSat <= 0 ? { kind: 'funds', reason: 'No spendable Lightning balance to swap out.' } : null),
  },
  {
    rail: 'loop-in',
    label: 'Loop In',
    provider: 'Lightning Loop (loopd + Lightning Labs swap server)',
    summary: 'Locks on-chain funds in an HTLC; the swap server pays you the amount over Lightning, adding outbound capacity to your channel.',
    timing: 'The HTLC needs confirmations before the server pays: typically 1–3 blocks.',
    dependencies: ['loopd (litd sub-server)', 'Loop swap server', 'an open channel with inbound room'],
    risks: [
      'If the server never pays, the HTLC times out and you reclaim the funds on-chain (minus miner fees).',
      'Miner fees can rise; the bridge re-quotes and refuses if the total exceeds what you approved.',
    ],
    inline: true,
    matches: (s, d) => s === 'onchain' && d === 'lightning',
    check: (env) =>
      first(
        loopBlocker(env),
        needsChannel(env),
        env.onchainSpendableSat <= 0 ? { kind: 'funds', reason: 'No confirmed on-chain funds to swap in.' } : null,
        env.lightningReceivableSat <= 0 ? { kind: 'funds', reason: 'Your channels have no inbound room to receive the swapped funds.', fix: 'Loop Out first or open a channel where the peer has balance.' } : null,
      ),
  },
  {
    rail: 'channel-open',
    label: 'Open a channel',
    provider: 'LND',
    summary: 'Commits on-chain funds into a new channel with a peer; your side becomes Lightning outbound.',
    timing: '3 confirmations before the channel is usable (about 30 min on mainnet).',
    dependencies: ['LND wallet', 'a reachable peer'],
    risks: ['Closing the channel later costs an on-chain fee.', 'A force close locks your funds for the channel’s timelock.'],
    inline: false,
    handoff: { to: '/channels', label: 'Open a channel' },
    matches: (s, d) => s === 'onchain' && d === 'lightning',
    check: (env) => (env.onchainSpendableSat <= 0 ? { kind: 'funds', reason: 'No confirmed on-chain funds to commit.' } : null),
  },
  {
    rail: 'funding-address',
    label: 'Deposit to an on-chain address',
    provider: 'LND wallet',
    summary: 'Creates a fresh address in this wallet; send to it from the other wallet.',
    timing: 'Spendable after 1 confirmation.',
    dependencies: ['the sending wallet', 'the Bitcoin network'],
    risks: ['Only send bitcoin on this network to this address.'],
    inline: true,
    matches: (s, d) => s === 'external-btc' && d === 'onchain',
    check: () => null,
  },
  {
    rail: 'static-loop-in',
    label: 'Static-address Loop In',
    provider: 'Lightning Loop (static address, MuSig2)',
    summary: 'A reusable 2-of-2 taproot deposit address shared with the swap server. Deposit from any wallet, then Loop the deposits into your channels.',
    timing: 'Deposits need confirmations; the Loop In itself is then fast because the funds are already on-chain.',
    dependencies: ['loopd (litd sub-server)', 'Loop swap server (to create the address and co-sign)'],
    risks: ['Each deposit must be at least 250,000 sats.', 'Deposits not looped in before they expire can only be withdrawn back on-chain.'],
    inline: false,
    handoff: { to: '/loop/static', label: 'Open static address' },
    matches: (s, d) => s === 'external-btc' && d === 'lightning',
    check: (env) => first(loopBlocker(env), needsChannel(env)),
  },
  {
    rail: 'funding-invoice',
    label: 'Receive over Lightning',
    provider: 'LND',
    summary: 'Creates an invoice; pay it from a Lightning-capable external wallet.',
    timing: 'Seconds once paid.',
    dependencies: ['inbound capacity on your channels', 'a paying wallet that speaks Lightning'],
    risks: ['The amount cannot exceed your inbound capacity.', 'Invoices expire (default 24 h).'],
    inline: true,
    matches: (s, d) => s === 'external-btc' && d === 'lightning',
    check: (env) =>
      first(needsChannel(env), env.lightningReceivableSat <= 0 ? { kind: 'funds', reason: 'No inbound capacity to receive into.', fix: 'Loop Out some Lightning balance to create room.' } : null),
  },
  {
    rail: 'asset-send',
    label: 'Taproot Assets send',
    provider: 'tapd',
    summary: 'Transfers the asset amount encoded in the address, anchored in a Bitcoin transaction.',
    timing: 'Broadcast immediately; final after the anchor transaction confirms.',
    dependencies: ['tapd (litd sub-server)', 'a universe or proof courier the recipient can reach'],
    risks: ['The address fixes asset and amount; check both before sending.', 'An on-chain anchor fee in BTC is paid by this wallet.'],
    inline: true,
    matches: (s, d) => s === 'taproot-asset' && d === 'asset-address',
    check: (env) =>
      first(
        env.tapdRunning === false ? { kind: 'service', reason: 'The Taproot Assets sub-server (tapd) is not running.' } : null,
        env.assetCount === 0 ? { kind: 'funds', reason: 'This node holds no Taproot Assets.', fix: 'Receive or mint an asset on the Taproot Assets page.' } : null,
      ),
  },
];

/** Why a pair has no rail at all. Checked only when no adapter matches. */
export function noRouteReason(source: SourceId, destination: DestinationId): { reason: string; fix?: string } {
  if (destination === 'other-chain') {
    return {
      reason:
        'There is no cross-chain route. Loop only swaps between Lightning and Bitcoin on-chain, and Taproot Assets are Bitcoin-native, not ERC-20 or TRC-20 tokens. Moving value to Ethereum or Tron would need a third-party bridge or custodian, which this noncustodial wallet does not use.',
    };
  }
  if (source === 'taproot-asset') {
    return {
      reason:
        'Taproot Assets move only to Taproot Assets addresses. Exchanging an asset for BTC needs asset channels with an RFQ price oracle, which are not enabled on this node.',
    };
  }
  if (destination === 'asset-address') {
    return { reason: 'A Taproot Assets address receives a specific asset, not bitcoin. Choose Taproot Assets as the source.' };
  }
  if (source === 'external-btc') {
    return { reason: 'This wallet is not part of that transfer. Send directly from the other wallet.' };
  }
  if (source === destination) {
    return {
      reason: source === 'onchain' ? 'The funds are already on-chain in this wallet.' : 'The funds are already Lightning balance in this wallet. Rebalancing between your own channels is not offered here.',
    };
  }
  if (source === 'onchain' && destination === 'invoice') {
    return {
      reason: 'Lightning invoices are paid from Lightning balance. Loop does not pay third-party invoices from on-chain funds.',
      fix: 'Loop In (on-chain to Lightning) first, then pay the invoice.',
    };
  }
  return { reason: 'No rail connects these two.' };
}

export interface RouteCandidate {
  readonly adapter: RouteAdapter;
  readonly blocker: Blocker | null;
}

export interface Resolution {
  readonly candidates: readonly RouteCandidate[];
  /** Set only when no adapter matches the pair. */
  readonly noRoute?: { readonly reason: string; readonly fix?: string };
}

/** Every rail for the pair, in registry order (preferred first), with its live blocker. */
export function resolveRoutes(source: SourceId, destination: DestinationId, env: RouteEnv, adapters: readonly RouteAdapter[] = ROUTE_ADAPTERS): Resolution {
  const candidates = adapters.filter((a) => a.matches(source, destination)).map((adapter) => ({ adapter, blocker: adapter.check(env) }));
  if (candidates.length === 0) return { candidates, noRoute: noRouteReason(source, destination) };
  return { candidates };
}

/** The candidate to preselect: the first runnable one, else the preferred one. */
export function preferredCandidate(r: Resolution): RouteCandidate | undefined {
  return r.candidates.find((c) => c.blocker === null) ?? r.candidates[0];
}

/** Is there any rail for this pair at all (ignoring live blockers)? Drives the destination list hints. */
export function hasRail(source: SourceId, destination: DestinationId, adapters: readonly RouteAdapter[] = ROUTE_ADAPTERS): boolean {
  return adapters.some((a) => a.matches(source, destination));
}

/** bitcoin: payment URI (BIP 21). Amount in BTC with up to 8 decimals, no float drift. */
export function bip21(address: string, amountSat?: number): string {
  if (amountSat === undefined || !Number.isSafeInteger(amountSat) || amountSat <= 0) return `bitcoin:${address}`;
  const whole = Math.floor(amountSat / 100_000_000);
  const frac = String(amountSat % 100_000_000).padStart(8, '0').replace(/0+$/, '');
  return `bitcoin:${address}?amount=${frac === '' ? String(whole) : `${whole}.${frac}`}`;
}
