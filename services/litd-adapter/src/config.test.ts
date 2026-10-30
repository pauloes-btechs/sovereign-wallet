import { describe, expect, it } from 'vitest';

import {
  assertLoopbackOnly,
  buildLitdConfig,
  DEFAULT_RPC_PORT,
  DEFAULT_UI_PORT,
  pickFreeLoopbackPort,
} from './config.js';

const NEUTRINO_REGTEST = {
  network: 'regtest' as const,
  dataDir: '/home/user/.sovereign/litd-test',
  backend: { kind: 'neutrino' as const, peers: ['127.0.0.1:18444'] },
};

describe('buildLitdConfig — integrated neutrino (desktop default)', () => {
  const config = buildLitdConfig(NEUTRINO_REGTEST);

  it('binds the wallet gRPC (lnd.rpclisten) and UI to loopback only', () => {
    // litd's own config has NO rpclisten option — the wallet-facing gRPC
    // belongs to the embedded LND, under the `lnd.` prefix (the pinned
    // binary rejects a bare `rpclisten` line with "unknown option").
    expect(config.confLines).toContain('lnd.rpclisten=127.0.0.1:10009');
    expect(config.confLines.some((l) => l.startsWith('rpclisten='))).toBe(false);
    expect(config.confLines).toContain('httpslisten=127.0.0.1:8443');
    expect(config.rpcHost).toBe('127.0.0.1');
    expect(config.rpcPort).toBe(DEFAULT_RPC_PORT);
  });

  it('honors custom ports', () => {
    const custom = buildLitdConfig({ ...NEUTRINO_REGTEST, rpcPort: 20009, uiPort: 9443 });
    expect(custom.confLines).toContain('lnd.rpclisten=127.0.0.1:20009');
    expect(custom.confLines).toContain('httpslisten=127.0.0.1:9443');
    expect(custom.rpcPort).toBe(20009);
    expect(DEFAULT_UI_PORT).toBe(8443);
  });

  it('selects integrated mode with the pinned network', () => {
    expect(config.confLines).toContain('lnd-mode=integrated');
    expect(config.confLines).toContain('network=regtest');
    expect(config.confLines).toContain('lnd.bitcoin.active=true');
    expect(config.confLines).toContain('lnd.bitcoin.regtest=true');
    expect(config.confLines).toContain('lnd.bitcoin.node=neutrino');
    // bitcoin.node=neutrino selects the backend; neutrino.active is not an
    // lnd option (embedded v0.21.5 parser rejects it as unknown).
    expect(config.confLines.some((l) => l.startsWith('lnd.neutrino.active'))).toBe(false);
  });

  it('disables autopilot on regtest (it aborts startup before lnd launches)', () => {
    expect(config.confLines).toContain('autopilot.disable=true');
    // Mainnet keeps autopilot available (Loop server addresses exist there).
    const mainnet = buildLitdConfig({
      ...NEUTRINO_REGTEST,
      network: 'mainnet' as const,
      backend: { kind: 'neutrino' as const },
    });
    expect(mainnet.confLines.some((l) => l.startsWith('autopilot.'))).toBe(false);
  });

  it('connects neutrino to the given compact-filter peers', () => {
    expect(config.confLines).toContain('lnd.neutrino.connect=127.0.0.1:18444');
  });

  it('keeps lnd data under the lit dir and derives the admin macaroon path', () => {
    expect(config.confLines).toContain('lnd.lnddir=/home/user/.sovereign/litd-test/lnd');
    expect(config.adminMacaroonPath).toBe(
      '/home/user/.sovereign/litd-test/lnd/data/chain/bitcoin/regtest/admin.macaroon',
    );
    expect(config.tlsCertPath).toBe(
      '/home/user/.sovereign/litd-test/lnd/tls.cert',
    );
  });

  it('passes only --lit-dir on argv, keeping secrets out of ps output', () => {
    expect(config.args).toEqual(['--lit-dir=/home/user/.sovereign/litd-test']);
  });

  it('writes the UI password to conf, not argv', () => {
    const withPassword = buildLitdConfig({ ...NEUTRINO_REGTEST, uiPassword: 's3cret' });
    expect(withPassword.confLines.filter((l) => l.startsWith('uipassword='))).toEqual(['uipassword=s3cret']);
    expect(withPassword.args.every((a) => !a.includes('s3cret'))).toBe(true);
  });

  it('generates a UI password when none is given', () => {
    const generated = buildLitdConfig(NEUTRINO_REGTEST).confLines.find((l) => l.startsWith('uipassword='));
    expect(generated).toMatch(/^uipassword=[A-Za-z0-9_-]{32}$/);
  });

  it('satisfies the loopback invariant over args and conf lines', () => {
    expect(() => assertLoopbackOnly(config)).not.toThrow();
  });
});

describe('buildLitdConfig — integrated bitcoind (user full node)', () => {
  const config = buildLitdConfig({
    network: 'regtest',
    dataDir: '/data/litd',
    backend: {
      kind: 'bitcoind-rpc',
      rpcHost: '127.0.0.1:18443',
      rpcUser: 'regtestuser',
      rpcPass: 'regtestpass',
      zmqRawBlock: 'tcp://127.0.0.1:29000',
      zmqRawTx: 'tcp://127.0.0.1:29001',
    },
  });

  it('wires the bitcoind backend over ZMQ', () => {
    expect(config.confLines).toContain('lnd.bitcoin.node=bitcoind');
    expect(config.confLines).toContain('lnd.bitcoind.rpchost=127.0.0.1:18443');
    expect(config.confLines).toContain('lnd.bitcoind.rpcuser=regtestuser');
    expect(config.confLines).toContain('lnd.bitcoind.zmqpubrawblock=tcp://127.0.0.1:29000');
    expect(config.confLines).toContain('lnd.bitcoind.zmqpubrawtx=tcp://127.0.0.1:29001');
  });

  it('keeps the bitcoind RPC password in conf only', () => {
    expect(config.confLines).toContain('lnd.bitcoind.rpcpass=regtestpass');
    expect(config.args.every((a) => !a.includes('regtestpass'))).toBe(true);
  });
});

describe('buildLitdConfig — remote LND', () => {
  const config = buildLitdConfig({
    network: 'mainnet',
    dataDir: '/data/litd-remote',
    backend: {
      kind: 'remote-lnd',
      rpcServer: 'lnd.example.com:10009',
      macaroonPath: '/secure/admin.macaroon',
      tlsCertPath: '/secure/tls.cert',
    },
  });

  it('selects remote mode and points at the user node', () => {
    expect(config.confLines).toContain('lnd-mode=remote');
    expect(config.confLines).toContain('remote.lnd.rpcserver=lnd.example.com:10009');
    expect(config.confLines).toContain('remote.lnd.macaroonpath=/secure/admin.macaroon');
    expect(config.confLines).toContain('remote.lnd.tlscertpath=/secure/tls.cert');
  });

  it('emits no network or local-lnd flags (the remote node governs)', () => {
    expect(config.confLines.some((l) => l.startsWith('network='))).toBe(false);
    expect(config.confLines.some((l) => l.startsWith('lnd.'))).toBe(false);
    expect(config.adminMacaroonPath).toBe('/secure/admin.macaroon');
  });

  it('exposes litd\'s TLS proxy as the wallet-facing gRPC surface', () => {
    // No local lnd: the LND API is proxied through litd's httpslisten TLS
    // listener, so connection options point at the UI port and litd's own
    // cert — NOT at the remote node's files.
    expect(config.rpcPort).toBe(DEFAULT_UI_PORT);
    expect(config.tlsCertPath).toBe('/data/litd-remote/tls.cert');
  });
});

describe('assertLoopbackOnly', () => {
  it('rejects a config line binding a wildcard interface', () => {
    const evil = buildLitdConfig(NEUTRINO_REGTEST);
    const violating = { ...evil, confLines: ['rpclisten=0.0.0.0:10009'] };
    expect(() => assertLoopbackOnly(violating)).toThrow(/loopback invariant/);
  });

  it('rejects a wildcard arg', () => {
    const evil = buildLitdConfig(NEUTRINO_REGTEST);
    const violating = { ...evil, args: ['--rpclisten=0.0.0.0:10009'] };
    expect(() => assertLoopbackOnly(violating)).toThrow(/loopback invariant/);
  });

  it('rejects an IPv6 wildcard listener', () => {
    const evil = buildLitdConfig(NEUTRINO_REGTEST);
    const violating = { ...evil, confLines: ['rpclisten=[::]:10009'] };
    expect(() => assertLoopbackOnly(violating)).toThrow(/loopback invariant/);
  });

  it('rejects extraLndArgs that lack the lnd. prefix', () => {
    expect(() =>
      buildLitdConfig({ ...NEUTRINO_REGTEST, extraLndArgs: ['bitcoin.node=neutrino'] }),
    ).toThrow(/lnd\./);
  });
});

describe('pickFreeLoopbackPort', () => {
  it('returns a loopback port the kernel had free', async () => {
    const port = await pickFreeLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
    expect(port).not.toBe(DEFAULT_RPC_PORT);
  });

  it('returns usable ports on consecutive calls', async () => {
    const [a, b] = await Promise.all([pickFreeLoopbackPort(), pickFreeLoopbackPort()]);
    expect(Number.isInteger(a)).toBe(true);
    expect(Number.isInteger(b)).toBe(true);
  });
});
