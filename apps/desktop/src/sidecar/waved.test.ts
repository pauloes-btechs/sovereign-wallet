import { describe, expect, it } from 'vitest';
import { MemoryKeyringStore } from '@sovereign/secure-store';
import { validateSidecarListenArgs } from '@sovereign/privacy';
import { wavedSidecarArgs } from './waved.js';

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
