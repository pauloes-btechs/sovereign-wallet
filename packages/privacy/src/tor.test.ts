/**
 * Tor transport tests run against a loopback SOCKS5 stub that implements the
 * no-auth handshake and relays CONNECT tunnels to a loopback HTTP target —
 * proving the client's wire behavior (greeting, CONNECT with domain ATYP,
 * reply parsing, bidirectional relay) without a real Tor daemon.
 */
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressPolicyViolation, SecurityPolicyEngine, TorPrivacyTransport, TorTransportError } from './index.js';

/** Minimal SOCKS5 no-auth stub: handshake, reply success, relay to `relayPort`. */
function startSocksStub(relayPort: number): Promise<{
  port: number;
  sawConnects: () => string[];
  close: () => void;
}> {
  const sawConnects: string[] = [];
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'connect' | 'tunnel' = 'greeting';
    let relay: net.Socket | undefined;

    client.on('error', () => relay?.destroy());
    client.on('data', (chunk: Buffer) => {
      if (stage === 'tunnel') {
        relay?.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 3) return;
        if (buffer[0] !== 0x05 || buffer[2] !== 0x00) {
          client.destroy();
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        buffer = buffer.subarray(3);
        stage = 'connect';
      }

      // CONNECT request: VER CMD RSV ATYP ADDR PORT
      if (stage === 'connect') {
        if (buffer.length < 5) return;
        const atyp = buffer[3] ?? 0;
        let host = '';
        let consumed = 0;
        if (atyp === 0x01) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          consumed = 10;
        } else if (atyp === 0x03) {
          const len = buffer[4] ?? 0;
          if (buffer.length < 7 + len) return;
          host = buffer.subarray(5, 5 + len).toString('utf8');
          consumed = 7 + len;
        } else {
          client.destroy();
          return;
        }
        sawConnects.push(host);
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        const rest = buffer.subarray(consumed);
        buffer = Buffer.alloc(0);
        stage = 'tunnel';
        relay = net.connect(relayPort, '127.0.0.1');
        relay.on('data', (d: Buffer) => client.write(d));
        relay.on('error', () => client.destroy());
        // Bytes that arrived piggybacked on the CONNECT request are tunnel data.
        if (rest.length > 0) relay.write(rest);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        sawConnects: () => sawConnects,
        close: () => server.close(),
      });
    });
  });
}

function startHttpTarget(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tor-ok-body');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
    });
  });
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe('TorPrivacyTransport', () => {
  it('routes an allowed request through SOCKS5 CONNECT and returns the response', async () => {
    const target = await startHttpTarget();
    cleanup.push(target.close);
    const socks = await startSocksStub(target.port);
    cleanup.push(socks.close);

    const engine = new SecurityPolicyEngine().registerUrl(`http://operator.example.test:${target.port}`, {
      id: 'ark-operator-test',
      purpose: 'Test operator endpoint.',
      allowTor: true,
    });
    const transport = new TorPrivacyTransport(engine, { socksPort: socks.port });

    const res = await transport.fetch(`http://operator.example.test:${target.port}/v1/ping`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tor-ok-body');
    // The destination hostname went to the proxy as a domain — DNS stays inside Tor.
    expect(socks.sawConnects()).toEqual(['operator.example.test']);
  });

  it('carries a POST body through the tunnel', async () => {
    const seen: { body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ body });
        res.writeHead(200);
        res.end('posted');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => server.close());
    const targetPort = (server.address() as AddressInfo).port;

    const socks = await startSocksStub(targetPort);
    cleanup.push(socks.close);

    const engine = new SecurityPolicyEngine().registerUrl(`http://swap.example.test:${targetPort}`, {
      id: 'swap-server-test',
      purpose: 'Test swap endpoint.',
      allowTor: true,
    });
    const transport = new TorPrivacyTransport(engine, { socksPort: socks.port });
    const res = await transport.fetch(`http://swap.example.test:${targetPort}/v1/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invoice: 'lnbcrt1' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ body: JSON.stringify({ invoice: 'lnbcrt1' }) }]);
  });

  it('refuses endpoints that did not disclose allowTor before any connection', async () => {
    const engine = new SecurityPolicyEngine().register({
      id: 'no-tor-endpoint',
      scheme: 'https',
      host: 'esplora.example.org',
      purpose: 'Block data.',
      allowTor: false,
    });
    const transport = new TorPrivacyTransport(engine, {});
    await expect(transport.fetch('https://esplora.example.org/blocks/tip')).rejects.toThrow(
      EgressPolicyViolation,
    );
  });

  it('refuses loopback destinations outright (loopback-over-tor)', async () => {
    const transport = new TorPrivacyTransport(new SecurityPolicyEngine(), {});
    await expect(transport.fetch('http://127.0.0.1:10031/v1/daemon/get-info')).rejects.toThrow(
      EgressPolicyViolation,
    );
  });

  it('refuses a non-loopback SOCKS proxy (outside the trust model)', async () => {
    const engine = new SecurityPolicyEngine().register({
      id: 'remote-ok',
      scheme: 'https',
      host: 'example.org',
      purpose: 'Test.',
      allowTor: true,
    });
    const transport = new TorPrivacyTransport(engine, { socksHost: 'proxy.example.org' });
    await expect(transport.fetch('https://example.org/')).rejects.toThrow(TorTransportError);
    await expect(transport.fetch('https://example.org/')).rejects.toMatchObject({
      code: 'socks-proxy-not-loopback',
    });
  });

  it('surfaces a SOCKS refusal as a typed error (proxy answered, target unreachable)', async () => {
    // Stub that accepts the handshake then replies with failure code 0x05
    // (host unreachable) instead of relaying.
    const server = net.createServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once('data', () => {
          client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const engine = new SecurityPolicyEngine().register({
      id: 'target',
      scheme: 'https',
      host: 'example.org',
      purpose: 'Test.',
      allowTor: true,
    });
    const transport = new TorPrivacyTransport(engine, { socksPort: port });
    await expect(transport.fetch('https://example.org/')).rejects.toMatchObject({
      code: 'socks-refused',
    });
  });
});
