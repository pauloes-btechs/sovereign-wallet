/**
 * HTTP surface for the Lightning Terminal sub-servers (see subservers.ts).
 * Same auth and transport as every other bridge route (bearer token,
 * loopback only); this module only parses and validates input.
 *
 *   GET  /services                    litd sub-server status + operator endpoints
 *   GET  /loop/terms                  min/max swap sizes per direction
 *   POST /loop/quote                  { direction, amountSat, confTarget? }
 *   GET  /loop/swaps                  all swaps, newest first
 *   GET  /loop/swaps/:id              one swap
 *   POST /loop/out                    { amountSat, destAddress?, sweepConfTarget?, outgoingChanIds?, label?, authorization }
 *   POST /loop/in                     { amountSat, lastHopPubkeyHex?, label?, authorization }
 *   GET  /loop/static                 static address summary + deposits
 *   POST /loop/static/address         create the static Loop In address
 *   POST /loop/static/loop-in         { outpoints, amountSat?, lastHopPubkeyHex?, label?, authorization }
 *   GET  /loop/autoloop               loopd params + this app's budget policy
 *   POST /loop/autoloop               { enabled: false } | { enabled: true, policy, sweepFeeRateSatPerVbyte? }
 *   GET  /loop/suggestions            AutoLoop dry run (SuggestSwaps)
 *   GET  /lnd/invoices                received payments (newest first)
 *   GET  /lnd/peers                   connected peers
 *   GET  /lnd/fees                    per-channel routing fee policies + fees earned
 *   POST /lnd/fees                    { channelPoint?, baseFeeMsat, feePpm, timeLockDelta }
 *   GET  /pool                        market, accounts, orders, leases, durations
 *   GET  /assets                      assets, balances, universe info
 *   GET  /assets/transfers            transfer history
 *   POST /assets/address              { assetIdHex, amount }
 *   POST /assets/decode               { address }
 *   POST /assets/send                 { address, authorization: { address } }
 */
import type { AutoLoopBudgetPolicy } from '@sovereign/liquidity';
import { BridgeRequestError } from './session.js';
import type { SubServerHub, SwapAuthorization } from './subservers.js';

type Json = Record<string, unknown>;

export const NO_ROUTE = Symbol('no-route');

function str(body: Json, field: string, required: true): string;
function str(body: Json, field: string, required?: false): string | undefined;
function str(body: Json, field: string, required = false): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw new BridgeRequestError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new BridgeRequestError(400, `${field} must be a string`);
  return v.trim();
}

function sats(body: Json, field: string, required: true): number;
function sats(body: Json, field: string, required?: false): number | undefined;
function sats(body: Json, field: string, required = false): number | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw new BridgeRequestError(400, `${field} is required`);
    return undefined;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) {
    throw new BridgeRequestError(400, `${field} must be a positive whole number of sats`);
  }
  return n;
}

function int(body: Json, field: string): number | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new BridgeRequestError(400, `${field} must be a non-negative integer`);
  return v;
}

function strList(body: Json, field: string, pattern: RegExp, what: string): string[] | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !pattern.test(x))) {
    throw new BridgeRequestError(400, `${field} must be a list of ${what}`);
  }
  return v as string[];
}

function obj(body: Json, field: string): Json {
  const v = body[field];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BridgeRequestError(400, `${field} is required`);
  return v as Json;
}

const PUBKEY = /^(02|03)[0-9a-f]{64}$/i;

function authorization(body: Json): SwapAuthorization {
  const a = obj(body, 'authorization');
  const amountSat = sats(a, 'amountSat', true);
  const v = a['maxTotalFeeSat'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new BridgeRequestError(400, 'authorization.maxTotalFeeSat must be a non-negative whole number of sats');
  }
  return { amountSat, maxTotalFeeSat: v };
}

function pubkey(body: Json, field: string): string | undefined {
  const v = str(body, field);
  if (v !== undefined && !PUBKEY.test(v)) throw new BridgeRequestError(400, `${field} must be a 33-byte compressed public key in hex`);
  return v;
}

function policy(body: Json): AutoLoopBudgetPolicy {
  const p = obj(body, 'policy');
  return p as unknown as AutoLoopBudgetPolicy; // shape and bounds are enforced by LiquidityManager.enableAutoLoop
}

/** Returns the JSON body to send, or NO_ROUTE when the path isn't a sub-server route. */
export async function routeSubServers(
  hub: SubServerHub,
  method: string,
  path: string,
  post: () => Promise<Json>,
): Promise<unknown> {
  if (method === 'GET' && path === '/services') return hub.services();

  // Loop
  if (method === 'GET' && path === '/loop/terms') return hub.loopTerms();
  if (method === 'POST' && path === '/loop/quote') {
    const b = await post();
    const direction = str(b, 'direction', true);
    if (direction !== 'loop-out' && direction !== 'loop-in') throw new BridgeRequestError(400, 'direction must be loop-out or loop-in');
    return hub.loopQuote(direction, sats(b, 'amountSat', true), int(b, 'confTarget'));
  }
  if (method === 'GET' && path === '/loop/swaps') return { swaps: await hub.swaps() };
  const swapMatch = /^\/loop\/swaps\/([0-9a-fA-F]+)$/.exec(path);
  if (method === 'GET' && swapMatch !== null) return hub.swap(swapMatch[1] ?? '');
  if (method === 'POST' && path === '/loop/out') {
    const b = await post();
    return hub.loopOut({
      amountSat: sats(b, 'amountSat', true),
      destAddress: str(b, 'destAddress'),
      sweepConfTarget: int(b, 'sweepConfTarget'),
      outgoingChanIds: strList(b, 'outgoingChanIds', /^[0-9]{1,20}$/, 'channel ids'),
      label: str(b, 'label'),
      authorization: authorization(b),
    });
  }
  if (method === 'POST' && path === '/loop/in') {
    const b = await post();
    return hub.loopIn({
      amountSat: sats(b, 'amountSat', true),
      lastHopPubkeyHex: pubkey(b, 'lastHopPubkeyHex'),
      label: str(b, 'label'),
      authorization: authorization(b),
    });
  }
  if (method === 'GET' && path === '/loop/static') return hub.staticAddress();
  if (method === 'POST' && path === '/loop/static/address') return hub.newStaticAddress();
  if (method === 'POST' && path === '/loop/static/loop-in') {
    const b = await post();
    const a = obj(b, 'authorization');
    const maxTotalFeeSat = a['maxTotalFeeSat'];
    if (typeof maxTotalFeeSat !== 'number' || !Number.isSafeInteger(maxTotalFeeSat) || maxTotalFeeSat < 0) {
      throw new BridgeRequestError(400, 'authorization.maxTotalFeeSat must be a non-negative whole number of sats');
    }
    return hub.staticLoopIn({
      outpoints: strList(b, 'outpoints', /^[0-9a-f]{64}:[0-9]{1,5}$/i, 'txid:index outpoints') ?? [],
      amountSat: sats(b, 'amountSat'),
      lastHopPubkeyHex: pubkey(b, 'lastHopPubkeyHex'),
      label: str(b, 'label'),
      authorization: { maxTotalFeeSat },
    });
  }
  if (method === 'GET' && path === '/loop/autoloop') return hub.autoloop();
  if (method === 'POST' && path === '/loop/autoloop') {
    const b = await post();
    if (b['enabled'] === false) {
      await hub.disableAutoloop();
      return hub.autoloop();
    }
    if (b['enabled'] !== true) throw new BridgeRequestError(400, 'enabled must be true or false');
    const sweep = b['sweepFeeRateSatPerVbyte'];
    if (sweep !== undefined && (typeof sweep !== 'number' || sweep <= 0)) {
      throw new BridgeRequestError(400, 'sweepFeeRateSatPerVbyte must be a positive number');
    }
    await hub.enableAutoloop(policy(b), sweep as number | undefined);
    return hub.autoloop();
  }
  if (method === 'GET' && path === '/loop/suggestions') return hub.suggestSwaps();

  // LND extras
  if (method === 'GET' && path === '/lnd/invoices') return { invoices: await hub.invoices() };
  if (method === 'GET' && path === '/lnd/peers') return { peers: await hub.peers() };
  if (method === 'GET' && path === '/lnd/fees') return hub.feeReport();
  if (method === 'POST' && path === '/lnd/fees') {
    const b = await post();
    const cp = str(b, 'channelPoint');
    if (cp !== undefined && !/^[0-9a-f]{64}:[0-9]{1,5}$/i.test(cp)) throw new BridgeRequestError(400, 'channelPoint must be txid:index');
    const base = b['baseFeeMsat'];
    const ppm = b['feePpm'];
    const delta = b['timeLockDelta'];
    if (typeof base !== 'number' || !Number.isInteger(base) || base < 0 || base > 1_000_000) {
      throw new BridgeRequestError(400, 'baseFeeMsat must be a whole number from 0 to 1,000,000');
    }
    if (typeof ppm !== 'number' || !Number.isInteger(ppm) || ppm < 0 || ppm > 50_000) {
      throw new BridgeRequestError(400, 'feePpm must be a whole number from 0 to 50,000');
    }
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta < 18 || delta > 2016) {
      throw new BridgeRequestError(400, 'timeLockDelta must be a whole number of blocks from 18 to 2016');
    }
    return hub.updateFeePolicy({ channelPoint: cp, baseFeeMsat: base, feePpm: ppm, timeLockDelta: delta });
  }

  // Pool
  if (method === 'GET' && path === '/pool') return hub.pool();

  // Taproot Assets
  if (method === 'GET' && path === '/assets') return hub.assetsOverview();
  if (method === 'GET' && path === '/assets/transfers') return { transfers: await hub.assetTransfers() };
  if (method === 'POST' && path === '/assets/address') {
    const b = await post();
    return hub.newAssetAddress(str(b, 'assetIdHex', true), str(b, 'amount', true));
  }
  if (method === 'POST' && path === '/assets/decode') {
    const b = await post();
    return hub.decodeAssetAddress(str(b, 'address', true));
  }
  if (method === 'POST' && path === '/assets/send') {
    const b = await post();
    const address = str(b, 'address', true);
    // Transaction-specific authorization: the caller echoes the exact address it reviewed.
    if (str(obj(b, 'authorization'), 'address', true) !== address) {
      throw new BridgeRequestError(400, 'authorization does not match the destination address');
    }
    return hub.sendAsset(address);
  }

  return NO_ROUTE;
}
