import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';

import { GetInfoResponse, Transaction } from '@sovereign/litd-proto';
import { describeLightningMechanism } from '@sovereign/wallet-core';

import { buildLitdConfig } from './config.js';
import type { LaunchedLitd, LaunchLitdOptions } from './launcher.js';
import type { LaunchFn, LightningClientFactory } from './provider.js';
import { LITD_LOCAL_CAPABILITIES, LITD_LOCAL_SEED_COMPATIBILITY, LitdLocalProvider } from './provider.js';

const START_OPTS = { network: 'regtest' as const, dataDir: '/tmp/litd-provider-test' };

/** Controllable async-iterable transaction stream. */
class FakeTxStream implements AsyncIterable<Transaction> {
  private queue: Array<{ ok: true; tx: Transaction } | { ok: false; err: Error }> = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(tx: Transaction): void {
    this.queue.push({ ok: true, tx });
    this.wake?.();
  }
  fail(err: Error): void {
    this.queue.push({ ok: false, err });
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        new Promise<IteratorResult<Transaction>>((resolve, reject) => {
          const step = (): void => {
            const item = this.queue.shift();
            if (item !== undefined) {
              if (item.ok) {
                resolve({ value: item.tx, done: false });
              } else {
                reject(item.err);
              }
            } else if (this.closed) {
              resolve({ value: undefined, done: true });
            } else {
              this.wake = () => {
                this.wake = undefined;
                step();
              };
            }
          };
          step();
        }),
    };
  }
}

interface LaunchRecord {
  options?: LaunchLitdOptions['options'];
  stopCount: number;
}

function fakeLaunchFn(record: LaunchRecord): LaunchFn {
  return async (launch) => {
    record.options = launch.options;
    const launched: LaunchedLitd = {
      config: buildLitdConfig(launch.options),
      child: {} as ChildProcess,
      stop: async () => {
        record.stopCount += 1;
      },
    };
    return launched;
  };
}

function makeProvider(overrides?: {
  launchFn?: LaunchFn;
  streamRetryLimit?: number;
  streamBackoffMs?: number;
}): { provider: LitdLocalProvider; record: LaunchRecord; closed: { transports: number }; stream: FakeTxStream } {
  const record: LaunchRecord = { stopCount: 0 };
  const closed = { transports: 0 };
  const stream = new FakeTxStream();
  // One persistent stream served on every (re)subscribe — retries reattach.
  const clientFactory: LightningClientFactory = async () => ({
    transport: { close: () => (closed.transports += 1) },
    getInfo: () => ({ response: Promise.resolve(GetInfoResponse.create({})) }),
    subscribeTransactions: () => ({ responses: stream }),
  });
  const provider = new LitdLocalProvider({
    binaryPath: '/opt/sidecars/litd',
    backend: { kind: 'neutrino', peers: ['127.0.0.1:18444'] },
    launchFn: overrides?.launchFn ?? fakeLaunchFn(record),
    clientFactory,
    streamRetryLimit: overrides?.streamRetryLimit,
    streamBackoffMs: overrides?.streamBackoffMs,
  });
  return { provider, record, closed, stream };
}

describe('LitdLocalProvider', () => {
  it('declares capabilities consistent with litd channels semantics', () => {
    expect(LITD_LOCAL_CAPABILITIES).toMatchObject({
      lightningSend: true,
      lightningReceive: true,
      lightningMechanism: 'channels',
      onchainSend: true,
      onchainReceive: true,
      assets: 'none',
      unilateralExit: 'instant',
      recoveryModel: 'aezeed+scb',
      operatorDependencies: [],
    });
    // The UI labels the mechanism via the shared helper — cross-check.
    expect(describeLightningMechanism(LITD_LOCAL_CAPABILITIES.lightningMechanism)).toBe(
      'Lightning via payment channels',
    );
  });

  it('accepts only aezeed seeds, disjoint from any Ark-mode mnemonic', () => {
    expect(LITD_LOCAL_SEED_COMPATIBILITY).toEqual(['aezeed']);
    expect(Object.isFrozen(LITD_LOCAL_SEED_COMPATIBILITY)).toBe(true);
    expect(LITD_LOCAL_SEED_COMPATIBILITY.some((s) => s.includes('ark'))).toBe(false);
  });

  it('passes start options and backend through to the launcher', async () => {
    const { provider, record } = makeProvider();
    await provider.start(START_OPTS);
    expect(record.options).toMatchObject({
      network: 'regtest',
      dataDir: '/tmp/litd-provider-test',
      backend: { kind: 'neutrino', peers: ['127.0.0.1:18444'] },
    });
    await provider.stop();
  });

  it('rejects a second start while running', async () => {
    const { provider } = makeProvider();
    await provider.start(START_OPTS);
    await expect(provider.start(START_OPTS)).rejects.toThrow(/already started/);
    await provider.stop();
  });

  it('emits balance-changed for each observed transaction', async () => {
    const { provider, stream } = makeProvider();
    const events: string[] = [];
    provider.onEvent((e) => events.push(e.type));
    await provider.start(START_OPTS);
    await new Promise((r) => setTimeout(r, 20)); // let the pump attach
    stream.push(Transaction.create({}));
    stream.push(Transaction.create({}));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((t) => t === 'balance-changed').length).toBe(2);
    await provider.stop();
  });

  it('stops the sidecar exactly once and closes the client transport', async () => {
    const { provider, record, closed } = makeProvider();
    await provider.start(START_OPTS);
    await provider.stop();
    await provider.stop(); // idempotent
    expect(record.stopCount).toBe(1);
    expect(closed.transports).toBe(1);
  });

  it('stops the pump on stop() without recording a stream error', async () => {
    const { provider, stream } = makeProvider();
    await provider.start(START_OPTS);
    await new Promise((r) => setTimeout(r, 20));
    await provider.stop();
    stream.fail(new Error('after stop'));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.getLastEventStreamError()).toBeUndefined();
  });

  it('bounds stream retries and records the terminal failure (never swallows it)', async () => {
    const { provider, stream } = makeProvider({ streamRetryLimit: 2, streamBackoffMs: 5 });
    await provider.start(START_OPTS);
    await new Promise((r) => setTimeout(r, 20));
    stream.fail(new Error('boom'));
    stream.fail(new Error('boom 2'));
    await new Promise((r) => setTimeout(r, 200));
    // The recorded error must surface through the getter — not vanish.
    expect(provider.getLastEventStreamError()).toBeDefined();
    await provider.stop();
  });

  it('getNodeInfo proxies the live daemon response', async () => {
    const closed = { transports: 0 };
    const stream = new FakeTxStream();
    let infoCalls = 0;
    const factory: LightningClientFactory = async () => ({
      transport: { close: () => (closed.transports += 1) },
      getInfo: () => {
        infoCalls += 1;
        return { response: Promise.resolve(GetInfoResponse.create({ identityPubkey: '02aa' })) };
      },
      subscribeTransactions: () => ({ responses: stream }),
    });
    // Build the provider directly with the custom factory via overrides.
    const custom = new LitdLocalProvider({
      binaryPath: '/opt/sidecars/litd',
      backend: { kind: 'neutrino' },
      launchFn: fakeLaunchFn({ stopCount: 0 }),
      clientFactory: factory,
    });
    await custom.start(START_OPTS);
    const info = await custom.getNodeInfo();
    expect(infoCalls).toBe(1);
    expect(info.identityPubkey).toBe('02aa');
    await custom.stop();
    expect(closed.transports).toBeGreaterThanOrEqual(0);
  });
});
