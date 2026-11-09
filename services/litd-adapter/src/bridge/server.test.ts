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

describe('bridge server routes — refusing unactivated SegWit versions (BIP-360)', () => {
  /** The example P2MR address from the BIP-360 text: mainnet, SegWit v2. */
  const BIP360_EXAMPLE = 'bc1zzmv50jjgxxhww6ve4g5zpewrkjqhr06fyujpm20tuezdlxmfphcqfc80ve';
  const REASON = 'Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.';
  let server: Server;
  let baseUrl: string;
  let sends: { address: string }[];
  let newAddressCalls: string[];

  beforeEach(async () => {
    sends = [];
    newAddressCalls = [];
    const session = {
      sendCoins: async (input: { address: string }) => {
        sends.push(input);
        return { txid: 'ff'.repeat(32) };
      },
      newAddress: async (type: string) => {
        newAddressCalls.push(type);
        return { address: 'bcrt1qexample' };
      },
    } as unknown as LitdBridgeSession;
    server = createLitdBridgeServer({ session, token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    server.close();
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses /onchain/send to a SegWit v2 address with a 400 and the reason', async () => {
    const res = await post('/onchain/send', { address: BIP360_EXAMPLE, amountSat: '10000', satPerVbyte: 2 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(REASON);
    expect(sends).toHaveLength(0);
  });

  it('still forwards an ordinary address', async () => {
    const res = await post('/onchain/send', { address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amountSat: '10000', satPerVbyte: 2 });
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it('explains why a P2MR receive address cannot be created', async () => {
    const res = await post('/onchain/address', { type: 'p2mr' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('p2mr: Not available — BIP-360 is a draft and not activated');
    expect(newAddressCalls).toHaveLength(0);
  });
});
