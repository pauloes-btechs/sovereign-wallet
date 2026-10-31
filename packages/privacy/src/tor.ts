/**
 * Tor transport — routes HTTP(S) through a local Tor SOCKS5 listener
 * (default 127.0.0.1:9050), implemented over node:net/node:tls with no new
 * dependencies (supply-chain surface matters in this package).
 *
 * Design points:
 * - The destination hostname is placed in the SOCKS5 CONNECT request
 *   (ATYP=domain), so DNS resolution happens inside Tor, never on the
 *   local stack — SOCKS5h semantics.
 * - TLS is still end-to-end (node:tls wraps the tunnel socket); the proxy
 *   sees ciphertext only. Certificate verification is never disabled.
 * - The SOCKS proxy itself must be loopback — a remote proxy would sit
 *   outside the trust model this transport exists for.
 * - Response bodies are size-capped so a hostile endpoint cannot balloon
 *   memory (DoS).
 */

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { SecurityPolicyEngine} from './policy.js';
import { type TransportKind } from './policy.js';
import { isLoopbackHost } from './loopback.js';
import type { PrivacyTransport } from './transport.js';

export class TorTransportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'socks-connect-timeout'
      | 'socks-proxy-not-loopback'
      | 'socks-handshake'
      | 'socks-refused'
      | 'response-too-large'
      | 'request-error',
  ) {
    super(message);
    this.name = 'TorTransportError';
  }
}

export interface TorTransportOptions {
  /** Tor's SOCKS5 listener. Must be loopback. Default 127.0.0.1:9050. */
  readonly socksHost?: string;
  readonly socksPort?: number;
  /** Circuit setup through Tor is slow; default 30s. */
  readonly connectTimeoutMs?: number;
  /** Response body cap. Default 10 MiB. */
  readonly bodyLimitBytes?: number;
}

const SOCKS5_VERSION = 0x05;
const NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;

export class TorPrivacyTransport implements PrivacyTransport {
  readonly kind: TransportKind = 'tor' as const;

  constructor(
    private readonly engine: SecurityPolicyEngine,
    private readonly options: TorTransportOptions = {},
  ) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    this.engine.assertEgressAllowed(url.href, { transport: 'tor' });

    const socksHost = this.options.socksHost ?? '127.0.0.1';
    const socksPort = this.options.socksPort ?? 9050;
    if (!isLoopbackHost(socksHost)) {
      throw new TorTransportError(`SOCKS proxy must be loopback, got ${socksHost}`, 'socks-proxy-not-loopback');
    }

    const socket = await connectSocks5(url.hostname, urlPort(url), {
      socksHost,
      socksPort,
      connectTimeoutMs: this.options.connectTimeoutMs ?? 30_000,
    });

    const method = init?.method ?? 'GET';
    const body = normalizeBody(init?.body);
    const headers = new Headers(init?.headers);
    // fetch sets this automatically; node needs it explicit.
    if (body !== undefined && !headers.has('content-length') && !headers.has('transfer-encoding')) {
      headers.set('content-length', String(body.length));
    }

    return requestOverTunnel(url, socket, method, headers, body, {
      bodyLimitBytes: this.options.bodyLimitBytes ?? 10 * 1024 * 1024,
      signal: init?.signal,
    });
  }
}

function urlPort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function normalizeBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new TorTransportError('Tor transport supports string/binary bodies only', 'request-error');
}

/**
 * Minimal SOCKS5 CONNECT client (no-auth only — Tor's default listener).
 * Resolves with the tunnel socket once the proxy replies REP=0.
 */
export function connectSocks5(
  targetHost: string,
  targetPort: number,
  opts: { socksHost: string; socksPort: number; connectTimeoutMs: number },
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: opts.socksHost, port: opts.socksPort });
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'reply' = 'greeting';
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(opts.connectTimeoutMs, () =>
      fail(new TorTransportError(`SOCKS5 connect timed out after ${opts.connectTimeoutMs}ms`, 'socks-connect-timeout')),
    );
    socket.once('error', (err: Error) => fail(new TorTransportError(`SOCKS5 proxy error: ${err.message}`, 'socks-handshake')));

    socket.on('connect', () => {
      socket.write(Buffer.from([SOCKS5_VERSION, 0x01, NO_AUTH]));
    });

    // Named so the handshake listener can be detached on settle — otherwise it
    // races the tunnel consumer for the first response bytes.
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          if (buffer[0] !== SOCKS5_VERSION || buffer[1] !== NO_AUTH) {
            throw new TorTransportError('SOCKS5 proxy rejected no-auth method', 'socks-handshake');
          }
          buffer = buffer.subarray(2);
          stage = 'reply';
          socket.write(connectRequest(targetHost, targetPort));
        }
        if (stage === 'reply') {
          const consumed = consumeReply(buffer);
          if (consumed === undefined) return; // need more bytes
          settled = true;
          socket.setTimeout(0);
          socket.removeListener('data', onData);
          resolve(socket);
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };
    socket.on('data', onData);
  });
}

function connectRequest(host: string, port: number): Buffer {
  const ip4 = net.isIPv4(host) ? host : undefined;
  const ip6 = !ip4 && net.isIPv6(host) ? host : undefined;
  const head = Buffer.from([SOCKS5_VERSION, CMD_CONNECT, 0x00]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  if (ip4 !== undefined) {
    return Buffer.concat([head, Buffer.from([0x01, ...ip4.split('.').map(Number)]), portBuf]);
  }
  if (ip6 !== undefined) {
    return Buffer.concat([head, Buffer.from([0x04, ...expandIPv6(ip6)]), portBuf]);
  }
  const domain = Buffer.from(host, 'utf8');
  if (domain.length > 255) throw new TorTransportError('SOCKS5 hostname too long', 'request-error');
  return Buffer.concat([head, Buffer.from([0x03, domain.length]), domain, portBuf]);
}

function expandIPv6(address: string): number[] {
  // ::1 and friends — expand to 16 bytes.
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
}

const REP_MESSAGES: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

/** Returns bytes consumed when the full reply is buffered; undefined otherwise. */
function consumeReply(buffer: Buffer): number | undefined {
  if (buffer.length < 4) return undefined;
  if (buffer[0] !== SOCKS5_VERSION) {
    throw new TorTransportError('SOCKS5 proxy sent invalid reply version', 'socks-handshake');
  }
  // 0xff is not a real REP code: an absent byte yields the hex fallback message.
  const rep = buffer[1] ?? 0xff;
  const atyp = buffer[3];
  const addrLen =
    atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (buffer[4] ?? 0) : -1;
  if (addrLen < 0) throw new TorTransportError('SOCKS5 reply has unknown address type', 'socks-handshake');
  const total = 4 + addrLen + 2 + (atyp === 0x03 ? 1 : 0);
  if (buffer.length < total) return undefined;
  if (rep !== 0x00) {
    throw new TorTransportError(
      `SOCKS5 CONNECT failed (${REP_MESSAGES[rep] ?? `0x${rep.toString(16)}`})`,
      'socks-refused',
    );
  }
  return total;
}

function requestOverTunnel(
  url: URL,
  socket: net.Socket,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  opts: { bodyLimitBytes: number; signal?: AbortSignal | null },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    // A one-shot Agent subclass is the only createConnection form Node honors
    // for http.request — `agent: false` builds a fresh default agent that does
    // its own DNS lookup, defeating the whole point of the tunnel.
    const agent = new OneShotTunnelAgent(() =>
      isHttps ? tls.connect({ socket, servername: url.hostname }) : socket,
    );

    const req = mod.request(
      url,
      { method, headers: headersToObject(headers), agent },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.bodyLimitBytes) {
            req.destroy();
            reject(new TorTransportError(`Response exceeds ${opts.bodyLimitBytes} bytes`, 'response-too-large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const payload = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          resolve(new Response(new Uint8Array(payload), { status: res.statusCode, headers: responseHeaders }));
        });
        res.on('error', (err: Error) => reject(new TorTransportError(err.message, 'request-error')));
      },
    );
    req.on('error', (err: Error) => {
      reject(err instanceof TorTransportError ? err : new TorTransportError(err.message, 'request-error'));
    });
    opts.signal?.addEventListener('abort', () => req.destroy(), { once: true });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Agent whose every connection is the caller's pre-established tunnel socket.
 * Both http and https requests flow through it; the https variant supplies a
 * TLSSocket (end-to-end TLS over the tunnel — the proxy sees ciphertext).
 */
class OneShotTunnelAgent extends http.Agent {
  private readonly factory: () => net.Socket;

  constructor(factory: () => net.Socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.factory = factory;
  }

  override createConnection(
    _options: unknown,
    _cb?: (err: Error | null, stream: Duplex) => void,
  ): net.Socket {
    return this.factory();
  }
}
