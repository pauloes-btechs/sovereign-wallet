import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
// only — there is no public regtest swap server. AutoLoop PARAMETER WRITES
// also need a live operator: loopd's liquidity manager validates params
// against the swap server's restrictions on every SetLiquidityParams (loop
// at the pinned commit, liquidity.setParameters → cfg.Restrictions). What
// this suite proves on regtest is the full client path: sub-server
// registration, macaroon auth, protobuf compatibility, the live AutoLoop
// defaults read, fail-closed opt-in at the operator boundary, and
// classified provider failures for the server-dependent RPCs. Mainnet
// testing of executed swaps stays strictly opt-in per the spec's safety
// boundaries.

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

/** The loop/pool gRPC services register on litd's listener only after the
 * embedded LND finishes its Neutrino sync — the Lightning surface serves
 * earlier, so tests would otherwise race registration with "unknown
 * service" errors. litd's proxy also answers for registered-but-still-
 * starting sub-servers with "not yet ready". Wait until both services
 * actually SERVE: "unknown service" (unregistered) and "not yet ready"
 * (starting) keep polling; any other outcome — success, or a registered-
 * but-failing RPC against the pinned dead operator endpoints — is positive
 * evidence the service is up. */
async function waitForSubserverRegistration(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  const probe = async (name: 'loop' | 'pool'): Promise<boolean> => {
    try {
      if (name === 'loop') {
        await loopPort!.listSwaps();
      } else {
        await poolPort!.marketRaw();
      }
      return true;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      return !/unknown service|not yet ready/i.test(lastErr);
    }
  };
  for (;;) {
    const [loopUp, poolUp] = [await probe('loop'), await probe('pool')];
    if (loopUp && poolUp) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`loop/pool sub-servers did not register within ${timeoutMs}ms: ${lastErr}`);
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
      // Without these, loopd/poold default to the real Lightning Labs
      // mainnet operators — autonomous CI must never contact them (spec
      // safety boundary). A dead loopback endpoint makes every
      // operator-dependent RPC fail fast and deterministically, which is
      // exactly the classified-unavailable behavior under test.
      // The mode gates do NOT default to integrated — without them the
      // bundled loopd/poold never start and every Loop/Pool RPC answers
      // "unknown service" forever (observed against the pinned binary with
      // a fully-synced embedded LND).
      extraSubServerArgs: [
        'loop-mode=integrated',
        'pool-mode=integrated',
        'loop.server.host=127.0.0.1:1',
        'pool.auctionserver=127.0.0.1:1',
        // Sub-server macaroon DBs default to ~/.loop and ~/.pool — a SHARED
        // store encrypted against whichever root key first created it. A
        // later run with a different wallet hits "unable to unlock macaroon
        // DB: invalid password": the RPC surface registers but loopd/poold
        // start half-initialized (their RPCs panic with nil managers —
        // observed). Pointing each daemon at this run's temp dir keeps runs
        // hermetic on reused machines (warm CI runners included).
        `loop.datadir=${dataDir}/loop`,
        `pool.basedir=${dataDir}/pool`,
      ],
      // Sub-server RPCs reject LND's admin macaroon (litd's sub-server
      // caveat check answers "signature mismatch after caveat
      // verification" — observed). The baked super macaroon authenticates
      // every sub-server through the shared root key.
      superMacaroon: { bake: 'read-write' },
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

  // litd bakes the super macaroon once the wallet is unlocked and the
  // sub-servers start — wait for the file before building the ports.
  const superMacaroonPath = launched.config.superMacaroonPath;
  await poll(
    async () => (superMacaroonPath !== undefined && existsSync(superMacaroonPath) ? superMacaroonPath : null),
    (p) => p !== null,
    'litd to bake the super macaroon',
    60_000,
  );

  loopPort = await LitdLoopPort.create({ ...conn, macaroonPath: superMacaroonPath }, () => undefined);
  poolPort = await LitdPoolPort.create({ ...conn, macaroonPath: superMacaroonPath });
  // 240s: 48× the ≤5s registration observed with the mode gates on, and
  // the beforeAll's phases stay inside this hook's 420s budget even when
  // earlier phases each burn their full 60s caps.
  await waitForSubserverRegistration(240_000);
}, 420_000);

afterAll(async () => {
  loopPort?.close();
  poolPort?.close();
  await launched?.stop();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('Loop sub-server over litd on regtest', () => {
  it('serves fresh AutoLoop defaults over the live RPC', async () => {
    // A fresh loopd serves its DEFAULT parameters (autoloop disabled) —
    // observed live against the pinned binary; it does not answer with an
    // empty message, so the port reports concrete defaults, not null.
    // Values are loopd's deterministic start-up constants for this pin:
    // budget 335544 sats, sweep target 100 blocks, 24h failure backoff.
    const initial = await loopPort!.getAutoLoopParams();
    expect(initial).toEqual({
      autoloopEnabled: false,
      budgetSat: 335_544,
      budgetStartSec: 0,
      maxSwapFeePpm: 0,
      sweepFeeRateSatPerVbyte: 0,
      maxMinerFeeSat: 0,
      maxPrepaySat: 0,
      sweepConfTarget: 100,
      failureBackoffSec: 86_400,
    });
  });

  it('fails closed: AutoLoop opt-in is refused while the operator is unreachable', async () => {
    // Upstream contract (loop at the pinned commit, liquidity.setParameters):
    // SetLiquidityParams validates params against the swap server's
    // restrictions — a LIVE operator is required for any AutoLoop write.
    // With the operator pinned to a dead loopback endpoint the write must
    // fail with a CLASSIFIED provider error, leave the policy off, record
    // nothing as enabled in the journal (the daemon write is the commit
    // point, not the user's click), and leave daemon state untouched.
    const managerJournal = new MemoryLiquidityJournal();
    const manager: LiquidityManager = new LiquidityManager({
      loop: loopPort!,
      pool: poolPort!,
      journal: managerJournal,
      newId: () => globalThis.crypto.randomUUID(),
    });
    await manager.start();
    expect(manager.isAutoLoopEnabled()).toBe(false);

    await expect(
      manager.enableAutoLoop({
        perActionCapSat: 10_000,
        dailyBudgetSat: 50_000,
        monthlyBudgetSat: 150_000,
      }),
    ).rejects.toBeInstanceOf(LiquidityProviderError);

    expect(manager.isAutoLoopEnabled()).toBe(false);
    expect(await managerJournal.list()).toEqual([]);
    const after = await loopPort!.getAutoLoopParams();
    expect(after?.autoloopEnabled).toBe(false);
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
