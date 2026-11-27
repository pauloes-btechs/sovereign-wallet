import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AutoLoopParams, SwapUpdate } from '@sovereign/liquidity';

const loop = vi.hoisted(() => {
  const listeners = new Set<(u: SwapUpdate) => void>();
  const state = { params: null as AutoLoopParams | null, writes: [] as AutoLoopParams[] };
  return {
    listeners,
    state,
    port: {
      getAutoLoopParams: async () => state.params,
      setAutoLoopParams: async (p: AutoLoopParams) => {
        state.writes.push({ ...p });
        state.params = { ...p };
      },
      onSwapEvent: (l: (u: SwapUpdate) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  };
});

vi.mock('../loop-client.js', () => ({ LitdLoopPort: { create: async () => loop.port } }));
vi.mock('../pool-client.js', () => ({ LitdPoolPort: { create: async () => ({}) } }));

const { SubServerHub } = await import('./subservers.js');

async function hub(): Promise<InstanceType<typeof SubServerHub>> {
  const dir = await mkdtemp(join(tmpdir(), 'hub-'));
  const superMacaroonPath = join(dir, 'super.macaroon');
  await writeFile(superMacaroonPath, Buffer.from([1, 2, 3]));
  return new SubServerHub({
    network: 'regtest',
    litdEndpoint: { rpcHost: '127.0.0.1', rpcPort: 1, tlsCertPath: join(dir, 'tls.cert') },
    superMacaroonPath,
    plan: {} as never,
    lightning: async () => ({}) as never,
  });
}

describe('SubServerHub AutoLoop governance', () => {
  it('disables AutoLoop when an automated swap breaks the per-action cap', async () => {
    const h = await hub();
    await h.enableAutoloop({ perActionCapSat: 1_000, dailyBudgetSat: 5_000, monthlyBudgetSat: 30_000 });
    expect(loop.state.params?.autoloopEnabled).toBe(true);

    for (const l of loop.listeners) {
      l({ swapId: 'auto-1', direction: 'loop-out', state: 'settled', amountSat: 100_000, costSat: 2_000, at: Date.now() });
    }
    await vi.waitFor(() => expect(loop.state.params?.autoloopEnabled).toBe(false));
  });

  it('starts one manager for concurrent callers, so each swap is counted once', async () => {
    loop.listeners.clear();
    const h = await hub();
    await Promise.all([h.autoloop(), h.autoloop(), h.enableAutoloop({ perActionCapSat: 1_000, dailyBudgetSat: 5_000, monthlyBudgetSat: 30_000 })]);
    expect(loop.listeners.size).toBe(1);
  });
});
