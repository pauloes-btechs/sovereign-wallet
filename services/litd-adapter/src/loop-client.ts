/**
 * LoopPort implementation over litd's bundled loopd (SwapClient service).
 *
 * In integrated mode the loop sub-server registers on the same TLS+macaroon
 * gRPC surface as the Lightning service, so one connection option set drives
 * every client. All protobuf→domain mapping is pure and unit-tested; this
 * file only wires transport calls to those functions and classifies gRPC
 * failures into `LiquidityProviderError`.
 */
import { status as grpcStatus, type ServiceError } from '@grpc/grpc-js';
import { Loop, LoopClient } from '@sovereign/litd-proto';
import { isLiquidityProviderError, LiquidityProviderError } from '@sovereign/liquidity';
import type { AutoLoopParams, LoopDirection, LoopQuote, SwapUpdate } from '@sovereign/liquidity';
import type { GrpcTransport } from '@protobuf-ts/grpc-transport';

import type { LitdConnectionOptions } from './client.js';
import { createLitdTransport } from './client.js';

/** Seconds→ms with a defensive unit guard (see swapTimestampToMs). */
export function swapTimestampToMs(seconds: bigint): number {
  const n = Number(seconds);
  if (n > 1e12) return Math.floor(n / 1000); // ns or ms — future proto change
  if (n > 1e9) return n * 1000; // unix seconds, loopd's documented unit
  return Date.now(); // unset timestamp — use the observation time
}

/** Map loopd's SwapState enum onto the engine's SwapState union. */
export function mapSwapState(state: Loop.SwapState): SwapUpdate['state'] {
  switch (state) {
    case Loop.SwapState.INITIATED:
      return 'initiated';
    case Loop.SwapState.PREIMAGE_REVEALED:
      return 'preimage-revealed';
    case Loop.SwapState.INVOICE_SETTLED:
      return 'invoice-settled';
    case Loop.SwapState.SUCCESS:
      return 'settled';
    case Loop.SwapState.FAILED:
      return 'failed';
    default:
      return 'initiated';
  }
}

/** Pure protobuf SwapStatus → engine SwapUpdate. */
export function mapSwapStatusToSwapUpdate(s: Readonly<Loop.SwapStatus>): SwapUpdate {
  const direction: LoopDirection =
    s.type === Loop.SwapType.LOOP_IN || s.type === Loop.SwapType.STATIC_LOOP_IN ? 'loop-in' : 'loop-out';
  return {
    swapId: s.id,
    direction,
    state: mapSwapState(s.state),
    amountSat: Number(s.amt),
    // Realized cost so far — the sum the engine budgets against.
    costSat: Number(s.costServer + s.costOnchain + s.costOffchain),
    at: swapTimestampToMs(s.lastUpdateTime),
  };
}

/** Pure loopd OutQuoteResponse → engine LoopQuote. */
export function mapOutQuoteToLoopQuote(r: Readonly<Loop.OutQuoteResponse>, amountSat: number): LoopQuote {
  const swapFeeSat = Number(r.swapFeeSat);
  const prepayFeeSat = Number(r.prepayAmtSat);
  const minerFeeSat = Number(r.htlcSweepFeeSat);
  return {
    direction: 'loop-out',
    amountSat,
    fees: { swapFeeSat, prepayFeeSat, minerFeeSat, routingFeeSat: 0, totalSat: swapFeeSat + prepayFeeSat + minerFeeSat },
    cltvDelta: r.cltvDelta,
    confTarget: r.confTarget,
    swapFeePpm: amountSat > 0 ? Math.round((swapFeeSat / amountSat) * 1_000_000) : 0,
  };
}

/** Pure loopd InQuoteResponse → engine LoopQuote. */
export function mapInQuoteToLoopQuote(r: Readonly<Loop.InQuoteResponse>, amountSat: number): LoopQuote {
  const swapFeeSat = Number(r.swapFeeSat);
  const minerFeeSat = Number(r.htlcPublishFeeSat);
  return {
    direction: 'loop-in',
    amountSat: Number(r.quotedAmt) || amountSat,
    fees: { swapFeeSat, prepayFeeSat: 0, minerFeeSat, routingFeeSat: 0, totalSat: swapFeeSat + minerFeeSat },
    cltvDelta: r.cltvDelta,
    confTarget: r.confTarget,
    swapFeePpm: amountSat > 0 ? Math.round((swapFeeSat / amountSat) * 1_000_000) : 0,
  };
}

/**
 * Pure LiquidityParameters → engine AutoLoopParams. loopd answers
 * GetLiquidityParams with a zero message when nothing was ever configured —
 * that maps to `null` ("no params stored"), which the manager treats as
 * automation-off.
 */
export function mapLiquidityParameters(p: Readonly<Loop.LiquidityParameters>): AutoLoopParams | null {
  const isZero =
    !p.autoloop &&
    p.autoloopBudgetSat === 0n &&
    p.maxMinerFeeSat === 0n &&
    p.maxPrepaySat === 0n &&
    p.maxSwapFeePpm === 0n;
  if (isZero) return null;
  return {
    autoloopEnabled: p.autoloop,
    budgetSat: Number(p.autoloopBudgetSat),
    budgetStartSec: Number(p.autoloopBudgetStartSec),
    maxSwapFeePpm: Number(p.maxSwapFeePpm),
    maxMinerFeeSat: Number(p.maxMinerFeeSat),
    maxPrepaySat: Number(p.maxPrepaySat),
    sweepConfTarget: p.sweepConfTarget,
    failureBackoffSec: Number(p.failureBackoffSec),
  };
}

/**
 * Pure merge for SetLiquidityParams: the RPC REPLACES the full parameter
 * set, so the engine's AutoLoop knobs are written over the daemon's current
 * parameters (rules, amounts, sweep targets preserved) — never a bare
 * minimal message that would wipe channel rules.
 */
export function autoLoopParamsOntoLiquidityParameters(
  current: Readonly<Loop.LiquidityParameters>,
  params: Readonly<AutoLoopParams>,
): Loop.LiquidityParameters {
  return Loop.LiquidityParameters.create({
    ...current,
    autoloop: params.autoloopEnabled,
    autoloopBudgetSat: BigInt(params.budgetSat),
    // loopd's deprecated start field: the refresh period governs budgets now.
    autoloopBudgetStartSec: BigInt(0),
    autoloopBudgetRefreshPeriodSec: BigInt(30 * 24 * 60 * 60), // 30 days — the app's monthly ceiling
    maxSwapFeePpm: BigInt(params.maxSwapFeePpm),
    maxMinerFeeSat: BigInt(params.maxMinerFeeSat),
    maxPrepaySat: BigInt(params.maxPrepaySat),
    // sweepConfTarget stays daemon-owned: the engine never clobbers the
    // user's sweep confirmation target (AutoLoopParams carries it read-only).
    failureBackoffSec: BigInt(params.failureBackoffSec),
  });
}

const FAILURE_MESSAGE_KINDS: readonly [RegExp, LiquidityProviderError['kind']][] = [
  [/insufficient|no capacity|not enough (channel|funds|balance)|utxo/i, 'insufficient-funds'],
  [/too (small|large)|outside|minimum|maximum|terms/i, 'out-of-terms'],
  [/no affordable|cannot (afford|serve)/i, 'no-affordable-quote'],
  [/expired|permission|macaroon|auth/i, 'unauthenticated'],
];

/**
 * Map a gRPC failure onto the engine's classified provider error. Message
 * inspection refines the coarse gRPC code where loopd packs specifics
 * (terms, capacity) into a generic code.
 */
export function mapTransportError(err: unknown): LiquidityProviderError {
  if (isLiquidityProviderError(err)) {
    return err;
  }
  const svcErr = err as Partial<ServiceError> | undefined;
  const code = svcErr?.code;
  const message = svcErr?.message ?? String(err);
  let kind: LiquidityProviderError['kind'] = 'unknown';
  if (code === grpcStatus.UNAUTHENTICATED || code === grpcStatus.PERMISSION_DENIED) {
    kind = 'unauthenticated';
  } else if (
    code === grpcStatus.UNAVAILABLE ||
    code === grpcStatus.DEADLINE_EXCEEDED ||
    code === grpcStatus.UNIMPLEMENTED || // sub-server not registered yet (litd still starting)
    code === grpcStatus.CANCELLED
  ) {
    kind = 'unavailable';
  } else if (code === grpcStatus.INVALID_ARGUMENT || code === grpcStatus.FAILED_PRECONDITION) {
    kind = 'out-of-terms';
  } else if (code === grpcStatus.RESOURCE_EXHAUSTED) {
    kind = 'no-affordable-quote';
  }
  for (const [pattern, refined] of FAILURE_MESSAGE_KINDS) {
    if (pattern.test(message)) {
      kind = refined;
      break;
    }
  }
  return new LiquidityProviderError(kind, message);
}

/** Factory-bound Loop port over litd's loop sub-server. */
export class LitdLoopPort {
  private readonly client: LoopClient.SwapClientClient;

  private constructor(
    private readonly transport: GrpcTransport,
    /** Stream-death hook — stream errors must never vanish silently. */
    private readonly onStreamError?: (err: unknown) => void,
  ) {
    this.client = new LoopClient.SwapClientClient(transport);
  }

  /** Async factory — the transport reads the TLS cert before connecting. */
  static async create(
    options: LitdConnectionOptions,
    onStreamError?: (err: unknown) => void,
  ): Promise<LitdLoopPort> {
    return new LitdLoopPort(await createLitdTransport(options), onStreamError);
  }

  async loopOutQuote(amountSat: number, confTarget = 6): Promise<LoopQuote> {
    try {
      const resp = await this.client
        .loopOutQuote(Loop.QuoteRequest.create({ amt: BigInt(amountSat), confTarget }))
        .response;
      return mapOutQuoteToLoopQuote(resp, amountSat);
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async loopInQuote(amountSat: number, confTarget = 6): Promise<LoopQuote> {
    try {
      const resp = await this.client.getLoopInQuote(Loop.QuoteRequest.create({ amt: BigInt(amountSat), confTarget })).response;
      return mapInQuoteToLoopQuote(resp, amountSat);
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async executeLoopOut(req: Readonly<{ amountSat: number; destAddress: string; maxSwapFeeSat: number; maxMinerFeeSat: number; sweepConfTarget?: number }>): Promise<{ swapId: string }> {
    try {
      const resp = await this.client
        .loopOut(
          Loop.LoopOutRequest.create({
            amt: BigInt(req.amountSat),
            dest: req.destAddress,
            maxSwapFee: BigInt(req.maxSwapFeeSat),
            maxMinerFee: BigInt(req.maxMinerFeeSat),
            sweepConfTarget: req.sweepConfTarget ?? 6,
            initiator: 'sovereign-wallet',
          }),
        )
        .response;
      return { swapId: resp.id };
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async executeLoopIn(req: Readonly<{ amountSat: number; maxSwapFeeSat: number; maxMinerFeeSat: number; lastHopPubkeyHex?: string }>): Promise<{ swapId: string }> {
    try {
      const resp = await this.client
        .loopIn(
          Loop.LoopInRequest.create({
            amt: BigInt(req.amountSat),
            maxSwapFee: BigInt(req.maxSwapFeeSat),
            maxMinerFee: BigInt(req.maxMinerFeeSat),
            lastHop: req.lastHopPubkeyHex !== undefined ? Buffer.from(req.lastHopPubkeyHex, 'hex') : new Uint8Array(0),
          }),
        )
        .response;
      return { swapId: resp.id };
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async getAutoLoopParams(): Promise<AutoLoopParams | null> {
    try {
      const params = await this.client.getLiquidityParams(Loop.GetLiquidityParamsRequest.create({})).response;
      return mapLiquidityParameters(params);
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async setAutoLoopParams(params: Readonly<AutoLoopParams>): Promise<void> {
    try {
      // Read-modify-write: SetLiquidityParams replaces the whole parameter
      // set, so the engine's knobs land on top of the daemon's current
      // config (channel rules and amounts preserved).
      const current = await this.client.getLiquidityParams(Loop.GetLiquidityParamsRequest.create({})).response;
      await this.client.setLiquidityParams(Loop.SetLiquidityParamsRequest.create({ parameters: autoLoopParamsOntoLiquidityParameters(current, params) })).response;
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  async listSwaps(): Promise<SwapUpdate[]> {
    try {
      const resp = await this.client.listSwaps(Loop.ListSwapsRequest.create({})).response;
      return resp.swaps.map(mapSwapStatusToSwapUpdate);
    } catch (err) {
      throw mapTransportError(err);
    }
  }

  onSwapEvent(listener: (update: Readonly<SwapUpdate>) => void): () => void {
    const call = this.client.monitor(Loop.MonitorRequest.create({}));
    let closed = false;
    void (async () => {
      try {
        for await (const status of call.responses) {
          if (closed) break;
          listener(mapSwapStatusToSwapUpdate(status));
        }
      } catch (err) {
        // The monitor stream dies with the daemon (restart, network) — the
        // reconciliation path (listSwaps) covers the gap, but the error is
        // never swallowed silently.
        if (!closed) this.onStreamError?.(err);
      }
    })();
    // protobuf-ts's ServerStreamingCall exposes no per-call cancel; the
    // stream's lifetime is bounded by the transport, closed with the port.
    return () => {
      closed = true;
    };
  }

  close(): void {
    this.transport.close();
  }
}
