import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LitdBridgeSession } from './session.js';
import { createLitdBridgeServer } from './server.js';

const TOKEN = 'test-token';

interface OpenChannelCall {
  readonly nodePubkeyHex: string;
  readonly host: string | undefined;
  readonly localFundingSat: bigint;
  readonly satPerVbyte: number;
  readonly isPrivate: boolean | undefined;
}

/** Route-contract stub: the session's internals belong to session.test.ts. */
function stubSession(calls: OpenChannelCall[]): LitdBridgeSession {
  return {
    openChannel: async (input: OpenChannelCall) => {
      calls.push(input);
      return { channelPoint: 'ab:0' };
    },
  } as unknown as LitdBridgeSession;
}

describe('bridge server routes — POST /channels', () => {
  let server: Server;
  let baseUrl: string;
  let calls: OpenChannelCall[];

  beforeEach(async () => {
    calls = [];
    server = createLitdBridgeServer({ session: stubSession(calls), token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('requires an explicit fee rate — never fabricates 0 (run8 regression: silent 0 default produced a misleading downstream validation error)', async () => {
    const res = await post({
      nodePubkeyHex: 'a'.repeat(66),
      host: '127.0.0.1:9735',
      localFundingSat: '20000000',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('satPerVbyte is required');
    expect(calls).toHaveLength(0);
  });

  it('forwards the parsed fee rate, funding amount as sats, and optional fields to the session', async () => {
    const res = await post({
      nodePubkeyHex: 'a'.repeat(66),
      host: '127.0.0.1:9735',
      localFundingSat: '20000000',
      satPerVbyte: 2,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      nodePubkeyHex: 'a'.repeat(66),
      host: '127.0.0.1:9735',
      localFundingSat: 20000000n,
      satPerVbyte: 2,
      isPrivate: undefined,
    });
  });

  it('rejects a non-numeric fee rate', async () => {
    const res = await post({
      nodePubkeyHex: 'a'.repeat(66),
      host: '127.0.0.1:9735',
      localFundingSat: '20000000',
      satPerVbyte: 'high',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('satPerVbyte must be a number');
    expect(calls).toHaveLength(0);
  });

  it('rejects requests without the bearer token', async () => {
    const res = await fetch(`${baseUrl}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodePubkeyHex: 'a'.repeat(66), localFundingSat: '20000000', satPerVbyte: 2 }),
    });
    expect(res.status).toBe(401);
  });

  it('never reaches the session without auth even on malformed bodies', async () => {
    const res = await fetch(`${baseUrl}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(401);
  });
});
