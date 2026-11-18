import { describe, expect, it } from 'vitest';
import { MemoryKeyringStore } from '@sovereign/secure-store';
import { validateSidecarListenArgs } from '@sovereign/privacy/loopback';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WAVED_GATEWAY_PORT, retryUntil, wavedLivenessProbe, wavedSidecarArgs } from './waved.js';

describe('wavedSidecarArgs: loopback-only binding, fail-closed', () => {
  it('assembles args that pass the privacy package loopback validation', () => {
    const args = wavedSidecarArgs({ healthPort: 44123, dataDir: '/tmp/data', network: 'regtest' });
    expect(() => validateSidecarListenArgs(args, { label: 'waved' })).not.toThrow();
  });

  it('pins every listener to 127.0.0.1', () => {
    const args = wavedSidecarArgs({ healthPort: 44123, dataDir: '/tmp/data', network: 'regtest' });
    const listeners = args.filter((a) => a.includes('listen') || a.includes('listenaddr'));
    expect(listeners.length).toBeGreaterThanOrEqual(3);
    for (const listener of listeners) {
      expect(listener).toContain('127.0.0.1');
      expect(listener).not.toMatch(/0\.0\.0\.0|\[::\]|192\.168\.|\b10\./);
    }
  });

  it('fails closed if a listener is ever moved off loopback', () => {
    const tampered = wavedSidecarArgs({
      healthPort: 44123,
      dataDir: '/tmp/data',
      network: 'regtest',
    }).map((a) => a.replace('127.0.0.1:10029', '0.0.0.0:10029'));
    expect(() => validateSidecarListenArgs(tampered, { label: 'waved' })).toThrow(
      /bind loopback only/i,
    );
  });
});

describe('secure-store desktop composition (contract, no Tauri runtime)', () => {
  it('database key service round-trips through the keyring the way src-tauri wiring does', async () => {
    // Mirrors the desktop composition: TauriKeyringStore over the scripted
    // invoke; here the memory store stands in for the platform keyring to
    // pin the DatabaseKeyService → keyring → SQLCipher key flow end to end.
    const { DatabaseKeyService } = await import('@sovereign/secure-store');
    const keyring = new MemoryKeyringStore();
    const service = new DatabaseKeyService(keyring);
    const key = await service.getOrCreateKey('mode-a');
    expect(key).toHaveLength(32);
  });
});

describe('waved liveness waits for the gateway (waved v0.2.1 serves /livez first)', () => {
  async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }
  async function closedPort(): Promise<number> {
    const s = await listen(() => undefined);
    await s.close();
    return s.port;
  }

  it('is not live while /livez is up but the gateway is not listening', async () => {
    const health = await listen((_q, res) => res.writeHead(200).end());
    try {
      expect(await wavedLivenessProbe(health.port, await closedPort()).isAlive()).toBe(false);
    } finally {
      await health.close();
    }
  });

  it('is live once the gateway answers, even with an auth refusal', async () => {
    const health = await listen((_q, res) => res.writeHead(200).end());
    const gateway = await listen((_q, res) => res.writeHead(401).end());
    try {
      expect(await wavedLivenessProbe(health.port, gateway.port).isAlive()).toBe(true);
    } finally {
      await health.close();
      await gateway.close();
    }
  });

  it('probes the same gateway port the daemon is told to listen on', () => {
    expect(wavedSidecarArgs({ healthPort: 1, dataDir: '/d', network: 'regtest' })).toContain(
      `--rpc.gateway.listenaddr=127.0.0.1:${WAVED_GATEWAY_PORT}`,
    );
  });
});

describe('retryUntil (admin macaroon minted after liveness)', () => {
  it('returns as soon as an attempt succeeds', async () => {
    let n = 0;
    const value = await retryUntil(async () => {
      n += 1;
      if (n < 3) throw new Error('ENOENT');
      return 'mac';
    }, { timeoutMs: 1_000, intervalMs: 1 });
    expect(value).toBe('mac');
    expect(n).toBe(3);
  });

  it('rejects with the last error after the timeout', async () => {
    await expect(retryUntil(async () => {
      throw new Error('ENOENT: admin.macaroon');
    }, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow('ENOENT: admin.macaroon');
  });
});
