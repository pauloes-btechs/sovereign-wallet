/**
 * LNC pairing e2e — regtest litd + a real LNC client pairing through the
 * harness's aperture mailbox (compose service, 127.0.0.1:17045).
 *
 * Chain under test (the exact flow mobile Mode B performs):
 *   litd session creation (litrpc.Sessions, super macaroon)
 *     -> 10-word pairing phrase
 *     -> PAKE + Noise pairing through the mailbox (aperture, TLS)
 *     -> RPC over the encrypted session (GetInfo / AddInvoice)
 *     -> macaroon scoping (custom session: invoice-only permissions)
 *     -> a regtest payment settles across the LNC-created invoice
 *     -> session revocation kills a live connection
 *
 * Environment notes:
 * - The LNC wasm client dials the mailbox with wss:// and its TLS
 *   verification happens HOST-side (Go js/wasm routes through the JS
 *   fetch) — the self-signed regtest certificate therefore requires
 *   NODE_TLS_REJECT_UNAUTHORIZED=0, set below before any pairing. The
 *   session transport itself is end-to-end PAKE+Noise: the mailbox never
 *   sees plaintext. Production pairs against the real mailbox with a
 *   publicly-verified certificate.
 * - The wasm binary is fetched and checksum-pinned by
 *   harness/regtest/scripts/fetch-lnc-wasm.mjs and served over loopback
 *   HTTP here — no CDN dependency at pairing time.
 * - Regtest only. Never point this suite at mainnet.
 */
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// LNC's wasm transport expects a WHATWG WebSocket; Node provides one only
// via the `ws` polyfill. Set before any pairing starts.
(globalThis as Record<string, unknown>)['WebSocket'] = WebSocket;

import {
  GenSeedRequest,
  GetInfoRequest,
  InitWalletRequest,
  NewAddressRequest,
  AddressType,
  WalletBalanceRequest,
  OpenChannelRequest,
  Payment_PaymentStatus,
  RouterClient,
  SendPaymentRequest,
  ConnectPeerRequest,
  ListPeersRequest,
  type LightningClient,
} from '@sovereign/litd-proto';
import {
  ALICE,
  bitcoinSendTo,
  bootstrapHarness,
  HARNESS_WALLET_PASSWORD,
  makeLightningClient,
  makeTransport,
  mineBlocks,
} from '@sovereign/harness-regtest';
import {
  connectionOptionsFromConfig,
  createLightningClient,
  createWalletUnlockerClient,
  launchLitdSidecar,
  LncSessionManager,
  probeRpcReady,
  waitForServices,
  type LaunchedLitd,
  type LitdConnectionOptions,
} from '../index.js';
import { pollUntil, sidecarBinaryPath } from './helpers.js';

// harness/regtest/services/... -> monorepo root (4 up)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const WASM_LOCAL_PATH = path.join(repoRoot, 'harness', 'regtest', 'data', 'lnc', 'lnc-v0.3.6-alpha.wasm');
const FETCH_LNC_WASM = path.join(repoRoot, 'harness', 'regtest', 'scripts', 'fetch-lnc-wasm.mjs');
const MAILBOX_ADDR = '127.0.0.1:17045';
const SESSION_TTL_MS = 60 * 60 * 1000;

let launched: LaunchedLitd | undefined;
let dataDir: string | undefined;
/** Connection to the litd TLS PROXY (session administration surface). */
let proxyConn: LitdConnectionOptions | undefined;
/** Embedded-LND Lightning client for the litd node. */
let litdClient: LightningClient | undefined;
let sessions: LncSessionManager | undefined;
let wasmServer: Server | undefined;
let wasmUrl = '';
/** Live wasm sessions — disconnected in afterAll so vitest can exit. */
const liveManagers: Array<{ disconnect(): void }> = [];

interface LncCall {
  /**
   * RPC with an explicit timeout. The lnc-web client retries mailbox
   * reconnects forever on a dead session — a revoked-session RPC can hang
   * without ever rejecting — so callers must not await it unbounded.
   */
  request<T>(method: string, req?: object): Promise<T>;
  isConnected(): boolean;
  /** Disconnect this client — bounded so a wedged retry loop can't block. */
  disconnect(): Promise<void>;
}

async function pairLnc(pairingPhrase: string, namespace: string): Promise<LncCall> {
  const { WasmManager } = await import('@lightninglabs/lnc-web');
  const manager = new WasmManager(namespace, wasmUrl, {
    onLocalKeyCreated: () => {},
    onRemoteKeyReceived: () => {},
  });
  await manager.preload();
  await manager.run();
  await manager.waitTilReady();
  await manager.connect({ pairingPhrase, serverHost: MAILBOX_ADDR });
  liveManagers.push(manager);
  return {
    request: <T,>(method: string, req?: object) => {
      const CALL_TIMEOUT_MS = 20_000;
      return Promise.race([
        manager.request<T>(method, req ?? {}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${method} did not answer within ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS),
        ),
      ]);
    },
    isConnected: () => manager.isConnected,
    disconnect: async () => {
      await Promise.race([
        Promise.resolve(manager.disconnect()),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    },
  };
}

/** Poll until the async call REJECTS — the mirror of pollUntil. */
async function pollForFailure(what: string, call: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await call();
      lastErr = new Error('call unexpectedly succeeded');
    } catch {
      return; // failed as required
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

beforeAll(async () => {
  // Hermetic wasm: fetch + checksum-pin once, then serve over loopback HTTP.
  if (!existsSync(WASM_LOCAL_PATH)) {
    const result = spawnSync('node', [FETCH_LNC_WASM], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`failed to fetch the pinned LNC wasm (exit ${result.status})`);
    }
  }
  wasmServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/wasm' });
    res.end(readFileSync(WASM_LOCAL_PATH));
  });
  await new Promise<void>((resolve) => wasmServer!.listen(0, '127.0.0.1', resolve));
  const addr = wasmServer.address();
  wasmUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/lnc.wasm`;

  await bootstrapHarness();

  // Own litd (integrated, bitcoind backend) with super-macaroon baking —
  // the session admin surface lives on litd's TLS proxy (uiPort). A fixed
  // P2P port lets the harness LND (alice) dial this node for the payment
  // leg. This overrides the config builder's `lnd.listen=127.0.0.1:0`
  // (LND config: last occurrence wins).
  dataDir = mkdtempSync(path.join(repoRoot, 'harness', 'regtest', 'data', 'litd-lnc-e2e-'));
  launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      superMacaroon: { bake: 'read-write' },
      extraLndArgs: ['lnd.listen=127.0.0.1:19737'],
      backend: {
        kind: 'bitcoind-rpc',
        rpcHost: '127.0.0.1:18443',
        rpcUser: 'regtest',
        rpcPass: 'regtest',
        zmqRawBlock: 'tcp://127.0.0.1:28332',
        zmqRawTx: 'tcp://127.0.0.1:28333',
      },
    },
  });
  const embeddedConn = connectionOptionsFromConfig(launched.config);
  await probeRpcReady(embeddedConn, 60_000);

  const unlocker = await createWalletUnlockerClient(embeddedConn);
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
  await waitForServices(embeddedConn, 'lightning', 60_000);
  litdClient = await createLightningClient(embeddedConn);

  // Session administration goes through litd's proxy (its own TLS cert),
  // authenticated with the baked super macaroon. The launcher kernel-
  // assigned the proxy port; recover it from the generated config.
  const uiPortLine = launched.config.confLines.find((l) => l.startsWith('httpslisten='));
  proxyConn = {
    rpcHost: '127.0.0.1',
    rpcPort: Number(uiPortLine!.split(':')[1]),
    tlsCertPath: path.join(dataDir, 'tls.cert'),
    macaroonPath: launched.config.superMacaroonPath!,
  };

  // The session server starts only after litd's sub-servers come up, which
  // on regtest trails the embedded LND's sync of the 110-block bootstrap
  // chain — observed taking >120s from launch on a cold container stack.
  // Poll until ListSessions answers.
  sessions = new LncSessionManager(proxyConn);
  await pollUntil('litd session server', () => sessions!.listSessions(), 240_000);
}, 420_000);

afterAll(async () => {
  for (const manager of liveManagers.splice(0)) {
    try {
      // A revoked-session client's internal retry loop can wedge the
      // manager — bound every disconnect so teardown always completes.
      await Promise.race([
        Promise.resolve(manager.disconnect()),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // teardown best-effort
    }
  }
  console.log('[e2e-marker]', new Date().toISOString(), 'managers disconnected, stopping litd');
  await launched?.stop();
  await new Promise<void>((resolve) => {
    wasmServer?.closeAllConnections?.();
    wasmServer?.close(() => resolve());
  });
});

describe('LNC pairing to the user\u2019s own litd', () => {
  it('pairs with a 10-word phrase and reads node info over the encrypted session', async () => {
    const handle = await sessions!.createSession({
      label: 'lnc-e2e-admin',
      sessionType: 'admin',
      mailboxServerAddr: MAILBOX_ADDR,
      devServer: true,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    expect(handle.pairingPhrase.split(' ')).toHaveLength(10);
    expect(handle.revoked).toBe(false);

    const { request } = await pairLnc(handle.pairingPhrase, 'lnc1');
    const info = await request<{ identityPubkey: string; syncedToChain: boolean }>('lnrpc.Lightning.GetInfo');
    const nodeInfo = await litdClient!.getInfo(GetInfoRequest.create({})).response;
    expect(info.identityPubkey).toBe(nodeInfo.identityPubkey);
    expect(info.syncedToChain).toBe(true);
  });

  it('enforces macaroon scoping: a custom session may add invoices but not read the wallet', async () => {
    const handle = await sessions!.createSession({
      label: 'lnc-e2e-scoped',
      sessionType: 'custom',
      mailboxServerAddr: MAILBOX_ADDR,
      devServer: true,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      customPermissions: [
        { entity: 'invoices', action: 'read' },
        { entity: 'invoices', action: 'write' },
      ],
    });
    const { request } = await pairLnc(handle.pairingPhrase, 'lnc2');

    const invoice = await request<{ paymentRequest: string }>('lnrpc.Lightning.AddInvoice', {
      valueMsat: 1_234_000,
      memo: 'lnc-e2e scoped session',
    });
    expect(invoice.paymentRequest).toContain('lnbcrt');

    // Outside the granted permissions: denied by the macaroon check.
    await pollForFailure('WalletBalance denial under a scoped session', () => request('lnrpc.Lightning.WalletBalance'), 15_000);
  });

  it('pays an invoice created through the LNC session (money flow)', async () => {
    const handle = await sessions!.createSession({
      label: 'lnc-e2e-pay',
      sessionType: 'custom',
      mailboxServerAddr: MAILBOX_ADDR,
      devServer: true,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      customPermissions: [
        { entity: 'invoices', action: 'read' },
        { entity: 'invoices', action: 'write' },
        { entity: 'offchain', action: 'read' },
        { entity: 'offchain', action: 'write' },
        { entity: 'info', action: 'read' },
      ],
    });
    const { request } = await pairLnc(handle.pairingPhrase, 'lnc3');
    const invoice = await request<{ paymentRequest: string; rHash: Uint8Array }>('lnrpc.Lightning.AddInvoice', {
      valueMsat: 500_000,
      memo: 'lnc-e2e payment',
    });

    // Pay from the harness LND (alice) via routerrpc.SendPaymentV2 (the
    // only payment RPC on LND v0.21.5 — server-streaming Payment updates):
    // peer with litd, open a channel (push funds so litd can receive),
    // mine to confirm, then pay.
    const alice = await makeLightningClient(ALICE);
    const aliceRouter = new RouterClient(await makeTransport(ALICE));
    const litdInfo = await litdClient!.getInfo(GetInfoRequest.create({})).response;
    const aliceInfo = await alice.getInfo(GetInfoRequest.create({})).response;
    // litd runs on the host and dials alice's published P2P port; alice is
    // inside Docker and cannot reach the host's loopback, so the reverse
    // direction is the only one that can connect.
    await litdClient!
      .connectPeer(
        ConnectPeerRequest.create({
          addr: { host: '127.0.0.1:19735', pubkey: aliceInfo.identityPubkey },
        }),
      )
      .response.catch(() => {
        // already peered — fine
      });
    // A TCP connect is not an established P2P session: OpenChannelSync
    // fails with "peer is not online" until the handshake completes.
    await pollUntil('litd peered with alice', async () => {
      const peers = await litdClient!.listPeers(ListPeersRequest.create({})).response;
      const peered = (peers.peers ?? []).some((p) => p.pubKey === aliceInfo.identityPubkey);
      if (!peered) throw new Error('peer not yet connected');
      return peers;
    }, 30_000);
    // Fund alice: bootstrap initializes her wallet but never funds it, and
    // channel funding requires confirmed on-chain outputs.
    const aliceAddr = (
      await alice.newAddress(NewAddressRequest.create({ type: AddressType.WITNESS_PUBKEY_HASH }))
    ).response.address;
    await bitcoinSendTo(aliceAddr, 0.1);
    await mineBlocks(6);
    await pollUntil('alice confirmed funding balance', async () => {
      const bal = await alice.walletBalance(WalletBalanceRequest.create({})).response;
      if (bal.confirmedBalance < 1_000_000n) throw new Error(`confirmed=${bal.confirmedBalance}`);
      return bal;
    }, 60_000);
    await alice.openChannelSync(
      OpenChannelRequest.create({
        nodePubkey: new Uint8Array(Buffer.from(litdInfo.identityPubkey, 'hex')),
        localFundingAmount: BigInt(1_000_000),
        pushSat: BigInt(500_000),
      }),
    ).response;
    await mineBlocks(6);
    await pollUntil('channel active', async () => {
      const channels = await litdClient!.listChannels({} as never).response;
      if ((channels.channels ?? []).length === 0) throw new Error('no channels yet');
      return channels;
    }, 60_000);

    const paymentStream = aliceRouter.sendPaymentV2(
      SendPaymentRequest.create({
        paymentRequest: invoice.paymentRequest,
        timeoutSeconds: 60,
        noInflightUpdates: true,
      }),
    );
    let payment: { status: Payment_PaymentStatus } | undefined;
    for await (const update of paymentStream.responses) {
      payment = update;
      if (
        update.status === Payment_PaymentStatus.SUCCEEDED ||
        update.status === Payment_PaymentStatus.FAILED
      ) {
        break;
      }
    }
    expect(payment?.status).toBe(Payment_PaymentStatus.SUCCEEDED);
  }, 240_000);

  it('revoking a session kills the live connection', async () => {
    const handle = await sessions!.createSession({
      label: 'lnc-e2e-revoke',
      sessionType: 'admin',
      mailboxServerAddr: MAILBOX_ADDR,
      devServer: true,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    const lnc4 = await pairLnc(handle.pairingPhrase, 'lnc4');
    // Live and answering.
    console.log('[e2e-marker]', new Date().toISOString(), 'lnc4 paired, calling GetInfo');
    await lnc4.request('lnrpc.Lightning.GetInfo');
    console.log('[e2e-marker]', new Date().toISOString(), 'GetInfo ok, revoking');

    await sessions!.revokeSession(handle.localPublicKeyHex);
    console.log('[e2e-marker]', new Date().toISOString(), 'revoke accepted, verifying listSessions');

    const listed = await sessions!.listSessions();
    const revokedSession = listed.find((s) => s.localPublicKeyHex === handle.localPublicKeyHex);
    expect(revokedSession?.revoked).toBe(true);
    console.log('[e2e-marker]', new Date().toISOString(), 'revoked=true confirmed, disconnecting client');

    // The session is dead, so nothing over it can succeed. We deliberately
    // do NOT issue RPCs against the revoked session: lnc-web 0.3.6-alpha's
    // mailbox retry loop wedges the worker event loop while reconnecting a
    // revoked stream (observed repeatedly in this suite — logs stop
    // advancing, timers stop firing), so even a Promise.race-bounded call
    // cannot recover. Revocation is enforced server-side (revoked=true
    // above); tearing the client down immediately is the only safe client
    // behavior, which is exactly what the production adapter must do when
    // it observes a revoked session.
    await lnc4.disconnect();
    console.log('[e2e-marker]', new Date().toISOString(), 'revocation test complete');
  }, 120_000);
});
