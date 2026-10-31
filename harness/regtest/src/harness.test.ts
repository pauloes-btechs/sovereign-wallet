import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isWalletAlreadyReady,
  sidecarAdminMacaroonPath,
  sidecarRpc,
  sidecarTlsCertPath,
} from './harness.js';

/** RpcError look-alike: protobuf-ts RpcError extends Error with a message. */
const rpcError = (message: string): Error => Object.assign(new Error(message), { code: 2 });

describe('isWalletAlreadyReady', () => {
  it('matches the unlocker-gone error observed in CI', () => {
    expect(
      isWalletAlreadyReady(
        rpcError('wallet already unlocked, WalletUnlocker service is no longer available'),
      ),
    ).toBe(true);
  });

  it('matches the already-exists and already-initialized variants', () => {
    expect(isWalletAlreadyReady(rpcError('wallet already exists'))).toBe(true);
    expect(isWalletAlreadyReady(rpcError('wallet already initialized'))).toBe(true);
  });

  it('matches non-Error rejections carrying the same text', () => {
    expect(isWalletAlreadyReady('WalletUnlocker service is no longer available')).toBe(true);
  });

  it('never matches a wrong-password or transient failure', () => {
    expect(isWalletAlreadyReady(rpcError('invalid passphrase for main macaroon'))).toBe(false);
    expect(isWalletAlreadyReady(rpcError('unavailable: connection refused'))).toBe(false);
    expect(isWalletAlreadyReady(rpcError('deadline exceeded'))).toBe(false);
  });
});

describe('sidecar RPC derivation', () => {
  it('parses the lnd.rpclisten port the launcher wrote into lit.conf', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sovereign-sidecar-rpc-'));
    await writeFileSync(path.join(dir, 'lit.conf'), 'httpslisten=127.0.0.1:8443\nlnd.rpclisten=127.0.0.1:46047\n');
    const rpc = await sidecarRpc(dir);
    expect(rpc.rpcHost).toBe('127.0.0.1');
    expect(rpc.rpcPort).toBe(46047);
    expect(rpc.dataDir).toBe(dir);
  });

  it('fails loudly when lit.conf carries no lnd.rpclisten line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sovereign-sidecar-rpc-'));
    await writeFileSync(path.join(dir, 'lit.conf'), 'httpslisten=127.0.0.1:8443\n');
    await expect(sidecarRpc(dir)).rejects.toThrow(/no lnd.rpclisten/);
  });

  it('pins the embedded-LND TLS path — NOT the litd proxy cert', () => {
    // Run 11 pinned: dialing lnd.rpclisten with <dataDir>/tls.cert (litd's
    // top-level tlscertpath, the proxy cert) fails the TLS handshake with
    // "self-signed certificate"; the listener presents <lnddir>/tls.cert.
    expect(sidecarTlsCertPath('/tmp/side')).toBe(path.join('/tmp/side', 'lnd', 'tls.cert'));
    expect(sidecarAdminMacaroonPath('/tmp/side')).toBe(
      path.join('/tmp/side', 'lnd', 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon'),
    );
  });
});
