import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GenSeedRequest, InitWalletRequest } from '@sovereign/litd-proto';
import { BTCD_FILTER_PORT, bootstrapHarness, HARNESS_WALLET_PASSWORD } from '@sovereign/harness-regtest';
import { LiquidityManager, LiquidityProviderError, MemoryLiquidityJournal } from '@sovereign/liquidity';
import {
  connectionOptionsFromConfig,
  createWalletUnlockerClient,
  launchLitdSidecar,
  LitdLoopPort,
  LitdPoolPort,
  probeRpcReady,
  waitForServices,
  type LaunchedLitd,
  type LitdConnectionOptions,
} from '../index.js';
import { sidecarBinaryPath, sleep } from './helpers.js';

// Loop/Pool integration against a REAL litd sidecar on the regtest harness
// (integrated loopd + poold register on the same TLS+macaroon RPC surface as
// the Lightning sub-server — no second daemon).
//
// Honest boundary: Loop swap EXECUTION and Pool lease EXECUTION need the
// Lightning Labs swap server / auctioneer, which serve mainnet and testnet
// only — there is no public regtest swap server. What this suite proves on
// regtest is the full client path: sub-server registration, macaroon auth,
// protobuf compatibility, the daemon-side AutoLoop parameter round-trip
// (client-side state — no server needed), and classified provider failures
// for the server-dependent RPCs. Mainnet/testing of executed swaps stays
// strictly opt-in per the spec's safety boundaries.

let launched: LaunchedLitd | undefined;
let conn: LitdConnectionOptions | undefined;
let loopPort: LitdLoopPort | undefined;
let poolPort: LitdPoolPort | undefined;
let dataDir: string | undefined;

async function poll<T>(fn: () => Promise<T>, isDone: (value: T) => boolean, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (isDone(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(1000);
  }
}

beforeAll(async () => {
  await bootstrapHarness();

  dataDir = mkdtempSync(path.join(os.tmpdir(), 'litd-liquidity-'));
  launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      backend: { kind: 'neutrino', peers: [`127.0.0.1:${BTCD_FILTER_PORT}`] },
    },
  });
  conn = connectionOptionsFromConfig(launched.config);
  await probeRpcReady(conn, 60_000);

  const unlocker = await createWalletUnlockerClient(conn);
  const seed = await unlocker.genSeed(GenSeedRequest.create({})).response;
  await unlocker
    .initWallet(
      InitWalletRequest.create({
        walletPassword: Buffer.from(HARNESS_WALLET_PASSWORD, 'utf8'),
        cipherSeedMnemonic: seed.cipherSeedMnemonic,
        aezeedPassphrase: new Uint8Array(0),
        recoveryWindow: 0,
        statelessInit: false,
      }),
    )
    .response;
  await waitForServices(conn, 'lightning', 60_000);

  loopPort = await LitdLoopPort.create(conn, () => undefined);
  poolPort = await LitdPoolPort.create(conn);
}, 240_000);

afterAll(async () => {
  loopPort?.close();
  poolPort?.close();
  await launched?.stop();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('Loop sub-server over litd on regtest', () => {
  it('round-trips AutoLoop parameters through the daemon (client-side state)', async () => {
    // loopd starts with nothing configured.
    const initial = await loopPort!.getAutoLoopParams();
    expect(initial).toBeNull();

    // Enable with the engine's budget shape — the opt-in flow's exact call.
    await loopPort!.setAutoLoopParams({
      autoloopEnabled: true,
      budgetSat: 150_000,
      budgetStartSec: Math.floor(Date.now() / 1000),
      maxSwapFeePpm: 2_500,
      maxMinerFeeSat: 10_000,
      maxPrepaySat: 5_000,
      sweepConfTarget: 6,
      failureBackoffSec: 3_600,
    });

    const enabled = await poll(
      () => loopPort!.getAutoLoopParams(),
      (params) => params !== null && params.autoloopEnabled,
      'AutoLoop params to persist as enabled',
      30_000,
    );
    expect(enabled?.budgetSat).toBe(150_000);
    expect(enabled?.maxMinerFeeSat).toBe(10_000);
    expect(enabled?.maxSwapFeePpm).toBe(2_500);

    // Disable — the reverse flow the budget-enforcement path uses.
    await loopPort!.setAutoLoopParams({
      autoloopEnabled: false,
      budgetSat: 150_000,
      budgetStartSec: 0,
      maxSwapFeePpm: 2_500,
      maxMinerFeeSat: 10_000,
      maxPrepaySat: 5_000,
      sweepConfTarget: 6,
      failureBackoffSec: 3_600,
    });
    const disabled = await poll(
      () => loopPort!.getAutoLoopParams(),
      (params) => params !== null && !params.autoloopEnabled,
      'AutoLoop params to persist as disabled',
      30_000,
    );
    expect(disabled?.budgetSat).toBe(150_000);
  });

  it('serves swap bookkeeping (no swaps yet) and classified quote failures', async () => {
    await expect(loopPort!.listSwaps()).resolves.toEqual([]);

    // The quote RPC needs the Lightning Labs swap server — unreachable on
    // regtest. The failure must be CLASSIFIED (provider error with a kind),
    // never a raw gRPC error.
    const failure = await loopPort!.loopOutQuote(500_000).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(LiquidityProviderError);
    expect((failure as LiquidityProviderError).kind).toBeDefined();
  });

  it('classifies swap execution failure against the absent regtest swap server', async () => {
    // Same boundary as above: LoopOut initiation cannot reach a server.
    const failure = await loopPort!
      .executeLoopOut({
        amountSat: 500_000,
        destAddress: 'bcrt1qzgerezhqwxp9sxx3he4389wre6z80r9yqmalfr',
        maxSwapFeeSat: 1_000,
        maxMinerFeeSat: 1_000,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(LiquidityProviderError);
  });
});

describe('Pool sub-server over litd on regtest', () => {
  it('classifies the unreachable auctioneer as an unavailable market', async () => {
    // poold cannot reach the Lightning Labs auctioneer from regtest — the
    // market state must come back as a classified failure, not a throw.
    const failure = await poolPort!.marketRaw().then(
      (raw) => raw,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(LiquidityProviderError);
    expect((failure as LiquidityProviderError).kind).toBe('unavailable');
  });
});

describe('LiquidityManager over the live litd ports', () => {
  it('keeps automation off by default and journals the enable/disable cycle', async () => {
    const manager: LiquidityManager = new LiquidityManager({
      loop: loopPort!,
      pool: poolPort!,
      journal: new MemoryLiquidityJournal(),
      newId: () => globalThis.crypto.randomUUID(),
    });
    await manager.start();

    // The opt-in default: automation never touches the daemon unprompted.
    expect(manager.isAutoLoopEnabled()).toBe(false);

    await manager.enableAutoLoop({
      perActionCapSat: 10_000,
      dailyBudgetSat: 50_000,
      monthlyBudgetSat: 150_000,
    });

    // The manager's policy reaches the daemon as autoloop=true params.
    const params = await poll(
      () => loopPort!.getAutoLoopParams(),
      (p) => p !== null && p.autoloopEnabled,
      'daemon AutoLoop to enable via the manager',
      30_000,
    );
    expect(params?.budgetSat).toBe(150_000);

    await manager.disableAutoLoop('integration test teardown');
    const off = await poll(
      () => loopPort!.getAutoLoopParams(),
      (p) => p !== null && !p.autoloopEnabled,
      'daemon AutoLoop to disable via the manager',
      30_000,
    );
    expect(off).not.toBeNull();
  });
});
