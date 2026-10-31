/**
 * Loopback HTTP/JSON bridge over LitdBridgeSession.
 *
 * The webview cannot speak gRPC (no bidirectional streaming, no macaroon
 * storage model), so the desktop shell runs this Node process beside litd and
 * the UI consumes plain JSON. Invariants:
 *  - loopback binding only (the listen call is the only place a host appears);
 *  - every route except GET /livez requires `Authorization: Bearer <token>`
 *    compared in constant time — the token never leaves the bootstrap file;
 *  - sat amounts arrive as strings and are parsed as BigInt (int64 fidelity);
 *  - upstream daemon errors are surfaced verbatim, never rewritten.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { BridgeRequestError, sessionJsonReplacer, type LitdBridgeSession } from './session.js';
import { mapPaymentView } from '../state-mappings.js';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB — requests are small JSON documents.

export interface BridgeServerOptions {
  readonly session: LitdBridgeSession;
  /** Per-launch random token from the bootstrap file. */
  readonly token: string;
  readonly onLog?: (line: string) => void;
}

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, sessionJsonReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The bridge is loopback-only behind a local token; no cross-origin caller
    // is legitimate, and the wallet UI hits it from a privileged webview.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BridgeRequestError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const raw = await readBody(req);
  if (!raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeRequestError(400, 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeRequestError(400, 'request body must be a JSON object');
  }
  return parsed as Json;
}

/** Parse a sat amount arriving as a JSON string (or number for legacy callers). */
function parseSat(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new BridgeRequestError(400, `${field} must be an integer amount of satoshis`);
    }
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new BridgeRequestError(400, `${field} must be a decimal sat amount (as a string)`);
  }
  return BigInt(value.trim());
}

function parseNumber(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new BridgeRequestError(400, `${field} is required`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new BridgeRequestError(400, `${field} must be a number`);
  }
  return n;
}

function requireString(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BridgeRequestError(400, `${field} is required`);
  }
  return value.trim();
}

function optionalString(body: Json, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BridgeRequestError(400, `${field} must be a string`);
  }
  return value.trim();
}

function optionalBool(body: Json, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BridgeRequestError(400, `${field} must be a boolean`);
  }
  return value;
}

/** Constant-time token check; always runs a comparison to avoid timing tells. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // burn equivalent time before rejecting
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

/** Build the bridge's HTTP server. Call `listen(port)` to start serving. */
export function createLitdBridgeServer(options: BridgeServerOptions): Server {
  const { session, token } = options;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      options.onLog?.(`bridge handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal bridge error' });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Unauthenticated liveness only — reveals nothing but process presence.
    if (method === 'GET' && path === '/livez') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const provided = bearerToken(req);
    if (provided === undefined || !tokenMatches(provided, token)) {
      sendJson(res, 401, { error: 'missing or invalid bridge token' });
      return;
    }

    try {
      await route(method, path, url, req, res);
    } catch (err) {
      if (err instanceof BridgeRequestError) {
        sendJson(res, err.httpStatus, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, { error: message });
    }
  }

  async function route(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const post = () => readJsonBody(req);

    // Wallet lifecycle
    if (method === 'GET' && path === '/state') {
      sendJson(res, 200, await session.state());
      return;
    }
    if (method === 'POST' && path === '/wallet/seed') {
      sendJson(res, 200, await session.generateSeed());
      return;
    }
    if (method === 'POST' && path === '/wallet/init') {
      const body = await post();
      const mnemonic = body.mnemonic;
      if (!Array.isArray(mnemonic) || mnemonic.some((w) => typeof w !== 'string')) {
        throw new BridgeRequestError(400, 'mnemonic must be an array of seed words');
      }
      const password = requireString(body, 'password');
      sendJson(
        res,
        200,
        await session.initWallet({
          mnemonic: mnemonic as string[],
          password,
          aezeedPassphrase: optionalString(body, 'aezeedPassphrase'),
          recoveryWindow: optionalNumberOrUndefined(body.recoveryWindow),
        }),
      );
      return;
    }
    if (method === 'POST' && path === '/wallet/unlock') {
      const body = await post();
      sendJson(res, 200, await session.unlockWallet(requireString(body, 'password')));
      return;
    }

    // On-chain
    if (method === 'GET' && path === '/onchain/balance') {
      sendJson(res, 200, await session.walletBalance());
      return;
    }
    if (method === 'POST' && path === '/onchain/address') {
      const body = await post();
      const type = optionalString(body, 'type') ?? 'p2wkh';
      if (type !== 'p2wkh' && type !== 'np2wkh') {
        throw new BridgeRequestError(400, 'address type must be p2wkh or np2wkh');
      }
      sendJson(res, 200, await session.newAddress(type));
      return;
    }
    if (method === 'POST' && path === '/onchain/estimate-fee') {
      const body = await post();
      sendJson(res, 200, await session.estimateFee(parseNumber(body.targetConf, 'targetConf')));
      return;
    }
    if (method === 'POST' && path === '/onchain/send') {
      const body = await post();
      const amountSat = parseSat(body.amountSat, 'amountSat');
      const sendAll = optionalBool(body, 'sendAll') ?? false;
      if (!sendAll && amountSat === undefined) {
        throw new BridgeRequestError(400, 'amountSat is required unless sendAll is true');
      }
      sendJson(
        res,
        200,
        await session.sendCoins({
          address: requireString(body, 'address'),
          amountSat,
          sendAll,
          satPerVbyte: parseNumber(body.satPerVbyte, 'satPerVbyte', 0),
          label: optionalString(body, 'label'),
        }),
      );
      return;
    }

    // Channels
    if (method === 'GET' && path === '/channels') {
      sendJson(res, 200, await session.channels());
      return;
    }
    if (method === 'POST' && path === '/channels') {
      const body = await post();
      const localFundingSat = parseSat(body.localFundingSat, 'localFundingSat');
      if (localFundingSat === undefined || localFundingSat <= 0n) {
        throw new BridgeRequestError(400, 'localFundingSat must be a positive sat amount');
      }
      sendJson(
        res,
        200,
        await session.openChannel({
          nodePubkeyHex: requireString(body, 'nodePubkeyHex'),
          host: optionalString(body, 'host'),
          localFundingSat,
          // Required on purpose — never fabricate a fee: a silent 0 default
          // produces a misleading downstream validation error instead of a
          // clear 400 at the contract boundary.
          satPerVbyte: parseNumber(body.satPerVbyte, 'satPerVbyte'),
          isPrivate: optionalBool(body, 'isPrivate'),
        }),
      );
      return;
    }
    if (method === 'POST' && path === '/channels/close') {
      const body = await post();
      sendJson(
        res,
        200,
        await session.closeChannel({
          channelPoint: requireString(body, 'channelPoint'),
          force: optionalBool(body, 'force'),
          satPerVbyte: body.satPerVbyte === undefined ? undefined : parseNumber(body.satPerVbyte, 'satPerVbyte'),
        }),
      );
      return;
    }
    const closeJobMatch = /^\/channels\/close\/([0-9a-f]{16})$/.exec(path);
    if (method === 'GET' && closeJobMatch) {
      const job = session.closeJob(closeJobMatch[1] ?? '');
      if (job === undefined) {
        throw new BridgeRequestError(404, 'no such close job');
      }
      sendJson(res, 200, job);
      return;
    }

    // Lightning payments
    if (method === 'POST' && path === '/invoices') {
      const body = await post();
      sendJson(
        res,
        200,
        await session.createInvoice({
          amountSat: parseSat(body.amountSat, 'amountSat'),
          memo: optionalString(body, 'memo'),
        }),
      );
      return;
    }
    if (method === 'POST' && path === '/invoices/decode') {
      const body = await post();
      sendJson(res, 200, await session.decodeInvoice(requireString(body, 'paymentRequest')));
      return;
    }
    if (method === 'POST' && path === '/payments') {
      const body = await post();
      sendJson(
        res,
        200,
        await session.payInvoice({
          paymentRequest: requireString(body, 'paymentRequest'),
          amountSat: parseSat(body.amountSat, 'amountSat'),
          invoiceAmountSat: parseSat(body.invoiceAmountSat, 'invoiceAmountSat'),
          feeLimitSat: parseSat(body.feeLimitSat, 'feeLimitSat'),
          feeLimitPercent: body.feeLimitPercent === undefined ? undefined : parseNumber(body.feeLimitPercent, 'feeLimitPercent'),
          cltvLimit: body.cltvLimit === undefined ? undefined : parseNumber(body.cltvLimit, 'cltvLimit'),
          allowSelfPayment: optionalBool(body, 'allowSelfPayment'),
        }),
      );
      return;
    }
    if (method === 'GET' && path === '/payments') {
      const max = parseNumber(url.searchParams.get('max'), 'max', 20);
      const payments = await session.payments(Math.trunc(max));
      sendJson(res, 200, { payments: payments.map(mapPaymentView) });
      return;
    }

    // Diagnostics + backups
    if (method === 'GET' && path === '/diagnostics') {
      sendJson(res, 200, await session.diagnostics());
      return;
    }
    if (method === 'GET' && path === '/channel-backups') {
      sendJson(res, 200, await session.exportChannelBackups());
      return;
    }
    if (method === 'POST' && path === '/channel-backups/restore') {
      const body = await post();
      sendJson(res, 200, await session.restoreChannelBackups(requireString(body, 'backupHex')));
      return;
    }

    throw new BridgeRequestError(404, `no route for ${method} ${path}`);
  }

  return server;
}

function optionalNumberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new BridgeRequestError(400, 'recoveryWindow must be a number');
  }
  return Math.trunc(n);
}
