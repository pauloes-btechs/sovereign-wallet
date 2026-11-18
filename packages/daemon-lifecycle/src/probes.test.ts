import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { allProbes, httpListeningProbe, httpOkProbe } from './probes.js';
import type { HealthProbe } from './types.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function serve(status: number): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const fixed = (alive: boolean, calls: string[], name: string): HealthProbe => ({
  isAlive: async () => {
    calls.push(name);
    return alive;
  },
});

describe('httpListeningProbe', () => {
  it('is alive for any HTTP answer, including an auth refusal', async () => {
    expect(await httpListeningProbe(await serve(200)).isAlive()).toBe(true);
    expect(await httpListeningProbe(await serve(401)).isAlive()).toBe(true);
    expect(await httpListeningProbe(await serve(404)).isAlive()).toBe(true);
  });

  it('is not alive while nothing listens (the waved v0.2.1 gateway race)', async () => {
    expect(await httpListeningProbe(await closedPort()).isAlive()).toBe(false);
  });
});

describe('httpOkProbe', () => {
  it('needs a 2xx', async () => {
    expect(await httpOkProbe(await serve(200)).isAlive()).toBe(true);
    expect(await httpOkProbe(await serve(503)).isAlive()).toBe(false);
    expect(await httpOkProbe(await closedPort()).isAlive()).toBe(false);
  });
});

describe('allProbes', () => {
  it('is alive only when every probe is', async () => {
    const calls: string[] = [];
    expect(await allProbes(fixed(true, calls, 'a'), fixed(true, calls, 'b')).isAlive()).toBe(true);
    expect(await allProbes(fixed(true, calls, 'a'), fixed(false, calls, 'b')).isAlive()).toBe(false);
  });

  it('stops at the first probe that is not alive', async () => {
    const calls: string[] = [];
    expect(await allProbes(fixed(false, calls, 'livez'), fixed(true, calls, 'gateway')).isAlive()).toBe(false);
    expect(calls).toEqual(['livez']);
  });

  it('livez up but gateway not listening is not alive', async () => {
    const probe = allProbes(httpOkProbe(await serve(200)), httpListeningProbe(await closedPort()));
    expect(await probe.isAlive()).toBe(false);
  });
});
