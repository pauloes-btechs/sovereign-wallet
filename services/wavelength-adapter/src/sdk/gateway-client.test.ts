import { afterEach, describe, expect, it, vi } from 'vitest';
import { WavelengthError, WalletState } from './index.js';
import type { WavedGatewayClient, WavedGatewayClientOptions } from '../index.js';
import {
  createWavedGatewayClient,
  mapWireBalance,
  parseWireBalance,
  normalizeGatewayInfo,
} from './gateway-client.js';

/**
 * Unit tests for the waved gateway transport's client-side contract: request
 * encoding (base64 byte fields, amt_sat quirk, numeric view), error-envelope
 * conversion, protojson normalization (int64 strings, proto enum names), and
 * the session/polling lifecycle. The wire facts themselves are pinned against
 * the real daemon by packages/daemon-lifecycle's waved integration suite.
 */

type FetchCall = { url: string; init: RequestInit };
type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Guard for noUncheckedIndexedAccess: asserts a call was recorded. */
function firstCall(calls: FetchCall[]): FetchCall {
  const call = calls[0];
  if (!call) throw new Error('expected at least one gateway call');
  return call;
}

function clientWith(
  responder: Responder,
  activityPollMs = 50,
  options: Partial<WavedGatewayClientOptions> = {},
): { client: WavedGatewayClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = { url: String(url), init: init ?? {} };
    calls.push(record);
    return responder(record.url, record.init);
  }) as unknown as typeof fetch;
  const client = createWavedGatewayClient({
    gatewayUrl: 'http://127.0.0.1:10452',
    fetchImpl,
    activityPollMs,
    ...options,
  });
  return { client, calls };
}

const CREATE_RESULT = {
  mnemonic: ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'],
  identity_pubkey: '02aa',
  recovery_ran: false,
  recovered_boarding_addresses: 0,
  recovered_boarding_utxos: 0,
  recovered_vtxos: 0,
};

const INFO_LOCKED = {
  version: '0.2.0',
  commit: 'b82bd54',
  network: 'regtest',
  block_height: 805000,
  server_connected: false,
  wallet_type: 'lwwallet',
  wallet_state: 'WALLET_STATE_LOCKED',
  identity_pubkey: '0234aa',
  server_info: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('request encoding', () => {
  it('base64-encodes the wallet password and posts to the create route', async () => {
    const { client, calls } = clientWith(() => jsonResponse(CREATE_RESULT));
    await client.createWallet({ password: 'correct horse battery staple' });
    expect(calls).toHaveLength(1);
    const call = firstCall(calls);
    expect(call.url).toBe('http://127.0.0.1:10452/v1/wallet/create');
    expect(call.init.method).toBe('POST');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    // 'correct horse battery staple' in base64 (verified against the daemon probe).
    expect(body.wallet_password).toBe(btoa('correct horse battery staple'));
  });

  it('base64-encodes unlock and posts to the unlock route', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ identity_pubkey: '02aa' }));
    await client.unlockWallet({ password: 'pw' });
    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(firstCall(calls).url).toBe('http://127.0.0.1:10452/v1/wallet/unlock');
    expect(body).toEqual({ wallet_password: btoa('pw') });
  });

  it('serializes receive amounts as amt_sat (verified daemon quirk)', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ invoice: 'lnbcrt1', entry: {} }));
    await client.receive({ amountSat: 21000, memo: 'hi' });
    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(body).toEqual({ amt_sat: 21000, memo: 'hi' });
  });

  it('maps SDK list views onto the wire numbers (vtxos=2, onchain=3, activity=0)', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ activity: { entries: [], total: 0, has_more: false, next_cursor: '' } }));
    await client.list({ view: 'vtxos' });
    await client.list({ view: 'onchain' });
    await client.list({ view: 'activity' });
    await client.list();
    const bodies = calls.map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
    expect(bodies.map((b) => b.view)).toEqual([2, 3, 0, 0]);
  });

  it('camelCase→snake_cases mechanical request fields (recover_state, amount_sat_hint)', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ address: 'bcrt1q', entry: {} }));
    await client.deposit({ amountSatHint: 5000 });
    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(body).toEqual({ amount_sat_hint: 5000 });
  });

  it('sends the unilateral exit ack under its verified wire name', async () => {
    const { client, calls } = clientWith(() => jsonResponse({}));
    await client.exit({ outpoint: 'aa:0', forceUnrollAck: 'I_KNOW_WHAT_I_AM_DOING' });
    const body = JSON.parse(String(firstCall(calls).init.body)) as Record<string, unknown>;
    expect(body).toEqual({ outpoint: 'aa:0', force_unroll_ack: 'I_KNOW_WHAT_I_AM_DOING' });
  });

  it('attaches the hex admin macaroon header on every call when configured', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ identity_pubkey: '' }), undefined, {
      macaroonHex: 'abcd1234',
    });
    await client.getInfo();
    await client.getInfo();
    expect(calls).toHaveLength(2);
    const headers = calls.map((c) => (c.init.headers as Record<string, string>).macaroon);
    expect(headers).toEqual(['abcd1234', 'abcd1234']);
  });

  it('sends no macaroon header when none is configured (unit context only — the real daemon rejects it)', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ identity_pubkey: '' }));
    await client.getInfo();
    expect((firstCall(calls).init.headers as Record<string, string>).macaroon).toBeUndefined();
  });
});

describe('error envelopes', () => {
  it('converts a gRPC envelope that arrived with HTTP 200 into a WavelengthError', async () => {
    const { client } = clientWith(() =>
      jsonResponse({ code: 9, message: 'wallet already exists', details: [] }),
    );
    await expect(client.createWallet({ password: 'pw' })).rejects.toMatchObject({
      name: 'WavelengthError',
      message: 'wallet already exists',
    });
  });

  it('maps WALLET_NOT_READY envelopes to the runtime_not_ready code', async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        code: 9,
        message: 'wallet not ready: state=0',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'WALLET_NOT_READY' }],
      }),
    );
    const error = await client.balance().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WavelengthError);
    expect((error as WavelengthError).code).toBe('runtime_not_ready');
  });

  it('wraps non-JSON bodies and network failures without swallowing them', async () => {
    const { client: badBody } = clientWith(() => jsonResponse('<html>', 502));
    await expect(badBody.getInfo()).rejects.toBeInstanceOf(WavelengthError);

    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const down = createWavedGatewayClient({ gatewayUrl: 'http://127.0.0.1:1', fetchImpl });
    await expect(down.getInfo()).rejects.toMatchObject({ code: 'runtime_not_ready' });
  });
});

describe('response normalization', () => {
  it('maps the daemon proto wallet-state name onto the SDK union and backfills walletReady', () => {
    const locked = normalizeGatewayInfo(INFO_LOCKED);
    expect(locked.walletState).toBe(WalletState.Locked);
    expect(locked.walletReady).toBe(false);
    expect(locked.blockHeight).toBe(805000);
    expect(locked.network).toBe('regtest');

    const ready = normalizeGatewayInfo({ ...INFO_LOCKED, wallet_state: 'WALLET_STATE_READY' });
    expect(ready.walletState).toBe(WalletState.Ready);
    expect(ready.walletReady).toBe(true);

    // A future/garbled state stays conservative (locked), never none.
    expect(normalizeGatewayInfo({ ...INFO_LOCKED, wallet_state: 'WALLET_STATE_CATCHING_UP' }).walletState).toBe(
      WalletState.Locked,
    );
    // Numeric proto values still normalize (SDK compatibility).
    expect(normalizeGatewayInfo({ ...INFO_LOCKED, wallet_state: 2 }).walletState).toBe(WalletState.Locked);
  });

  it('parses protojson int64 sat strings into numbers and maps the SDK balance', () => {
    const wire = parseWireBalance({
      boarding_confirmed_sat: '10',
      boarding_unconfirmed_sat: '0',
      vtxo_balance_sat: '900',
      total_confirmed_sat: '1000',
      onchain_wallet_confirmed_sat: '90',
      boarding_pending_sweep_sat: '5',
      boarding_swept_sat: '0',
      boarding_adopted_sat: '0',
      vtxo_pending_sat: '7',
      vtxo_unilateral_exit_sat: '40',
      asset_balances: [],
    });
    expect(wire.vtxoBalanceSat).toBe(900);
    expect(wire.assetBalances).toEqual([]);
    const mapped = mapWireBalance(wire);
    expect(mapped).toEqual({
      confirmedSat: 1000,
      pendingInSat: 7,
      pendingOutSat: 45,
      creditAvailableSat: 0,
      creditReservedSat: 0,
    });
  });

  it('normalizes activity entries including proto-name enums and string sat fields', async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        activity: {
          entries: [
            {
              id: 'e1',
              kind: 'ENTRY_KIND_SEND',
              status: 'ENTRY_STATUS_PENDING',
              amount_sat: '1200',
              fee_sat: '3',
              counterparty: 'swap.server',
              created_at: '2026-10-30T00:00:00Z',
              updated_at: '2026-10-30T00:01:00Z',
              cursor: '42',
              failure_code: 'ENTRY_FAILURE_CODE_TIMED_OUT',
              progress: {
                phase: 'ENTRY_PHASE_CONFIRMED',
                phase_label: 'confirmed',
                payment_hash: 'ab'.repeat(32),
                txid: 'cd'.repeat(32),
                confirmation_height: '8',
                vtxo_outpoint: 'aa:1',
                preimage: '',
              },
              request: {
                type: 'ENTRY_REQUEST_TYPE_ONCHAIN',
                onchain_address: 'bcrt1qexample',
              },
            },
          ],
          total: 1,
          has_more: false,
          next_cursor: '',
        },
      }),
    );
    const result = await client.list({ view: 'activity' });
    const entry = result.activity?.entries[0];
    expect(result.view).toBe('activity');
    // Proto-name enums normalize to the SDK's bare lowercase union values —
    // these are the exact strings the SDK declares for EntryKind/EntryStatus/
    // EntryFailureCode/EntryPhase/EntryRequestType.
    expect(entry?.kind).toBe('send');
    expect(entry?.status).toBe('pending');
    expect(entry?.failureCode).toBe('timed_out');
    expect(entry?.progress?.phase).toBe('confirmed');
    expect(entry?.progress?.phaseLabel).toBe('confirmed');
    expect(entry?.progress?.confirmationHeight).toBe(8);
    expect(entry?.progress?.vTXOOutpoint).toBe('aa:1');
    expect(entry?.request?.type).toBe('onchain');
    expect(entry?.request?.onchainAddress).toBe('bcrt1qexample');
    expect(entry?.amountSat).toBe(1200);
    expect(entry?.feeSat).toBe(3);
    expect(entry?.cursor).toBe(42);
  });

  it('parses the vtxos and onchain list variants by response presence', async () => {
    const vtxoClient = clientWith(() => jsonResponse({ vtxos: { vtxos: [{ outpoint: 'aa:1', amount_sat: '5' }], total: 1 } }));
    const v = await vtxoClient.client.list({ view: 'vtxos' });
    expect(v.view).toBe('vtxos');
    expect(v.vtxos?.total).toBe(1);

    const onchainClient = clientWith(() => jsonResponse({ onchain: { txs: [], total: 0, has_more: false } }));
    const o = await onchainClient.client.list({ view: 'onchain' });
    expect(o.view).toBe('onchain');
    expect(o.onchain?.txs).toEqual([]);
  });
});

describe('session lifecycle', () => {
  it('coalesces a second start onto the running session', async () => {
    let calls = 0;
    const { client } = clientWith(() => {
      calls += 1;
      return jsonResponse(INFO_LOCKED);
    });
    const first = await client.start({ network: 'regtest' });
    const second = await client.start({ network: 'regtest' });
    expect(second.walletState).toBe(first.walletState);
    expect(calls).toBe(2); // one getInfo per start
    expect(await client.isRunning()).toBe(true);
    await client.stop();
    expect(await client.isRunning()).toBe(false);
  });

  it('rejects a network mismatch between the app config and the running daemon', async () => {
    const { client } = clientWith(() => jsonResponse(INFO_LOCKED));
    await expect(client.start({ network: 'mainnet' })).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('throws unsupported for paths the v0.2.0 gateway does not serve', async () => {
    const { client } = clientWith(() => jsonResponse({}));
    await expect(client.callFacade('getInfo')).rejects.toMatchObject({ code: 'unsupported_facade_method' });
    await expect(
      client.sweepWallet({ broadcast: false } as Parameters<WavedGatewayClient['sweepWallet']>[0]),
    ).rejects.toMatchObject({ code: 'unsupported_facade_method' });
    await expect(
      client.openWalletFromPasskey({ prfOutput: 'aa' } as Parameters<WavedGatewayClient['openWalletFromPasskey']>[0]),
    ).rejects.toMatchObject({ code: 'unsupported_facade_method' });
  });
});

describe('activity polling', () => {
  it('emits one activity event per new or changed entry and stays silent otherwise', async () => {
    vi.useFakeTimers();
    let entries: Array<Record<string, unknown>> = [];
    const { client } = clientWith(() => jsonResponse({ activity: { entries, total: entries.length, has_more: false, next_cursor: '' } }));
    const events: unknown[] = [];
    client.subscribe((e) => events.push(e));
    await client.startActivity();

    entries = [
      { id: 'e1', kind: 'send', status: 'pending', amount_sat: '1', fee_sat: '0', created_at: 't', updated_at: 't1' },
    ];
    await vi.advanceTimersByTimeAsync(60);
    expect(events.filter((e) => (e as { type: string }).type === 'activity')).toHaveLength(1);

    // Same poll again: no change → no duplicate event.
    await vi.advanceTimersByTimeAsync(60);
    expect(events.filter((e) => (e as { type: string }).type === 'activity')).toHaveLength(1);

    // Entry advances → exactly one more event.
    entries = [{ ...entries[0], status: 'complete', updated_at: 't2' }];
    await vi.advanceTimersByTimeAsync(60);
    expect(events.filter((e) => (e as { type: string }).type === 'activity')).toHaveLength(2);

    client.stopActivity();
  });

  it('emits an activityStream failure event when the list call fails', async () => {
    vi.useFakeTimers();
    const { client } = clientWith(() => jsonResponse({ code: 13, message: 'boom', details: [] }));
    const events: Array<{ type: string; payload?: { state?: string } }> = [];
    client.subscribe((e) => events.push(e as { type: string; payload?: { state?: string } }));
    await client.startActivity();
    await vi.advanceTimersByTimeAsync(10);
    expect(events.some((e) => e.type === 'activityStream' && e.payload?.state === 'failed')).toBe(true);
    client.stopActivity();
  });
});
