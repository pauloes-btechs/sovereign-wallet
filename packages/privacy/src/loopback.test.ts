import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LoopbackViolationError,
  isLoopbackHost,
  parseHostPort,
  validateSidecarListenArgs,
} from './index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('validateSidecarListenArgs', () => {
  it('accepts an all-loopback argument list', () => {
    expect(() =>
      validateSidecarListenArgs(
        [
          '--health.listen=127.0.0.1:8123',
          '--rpc.listenaddr=127.0.0.1:10029',
          '--rpc.gateway.listenaddr=[::1]:10031',
          '--network=regtest',
          '--nolisten',
        ],
        { label: 'waved' },
      ),
    ).not.toThrow();
  });

  it('rejects wildcard and LAN bindings, listing every violation', () => {
    const args = [
      '--health.listen=127.0.0.1:8123',
      '--rpc.listenaddr=0.0.0.0:10029', // wildcard
      '--rpc.gateway.listenaddr=192.168.1.5:10031', // LAN
    ];
    try {
      validateSidecarListenArgs(args, { label: 'waved' });
      expect.unreachable('expected LoopbackViolationError');
    } catch (err) {
      expect(err).toBeInstanceOf(LoopbackViolationError);
      const violations = (err as LoopbackViolationError).violations;
      expect(violations).toHaveLength(2);
      expect(violations[0]).toContain('0.0.0.0');
      expect(violations[1]).toContain('192.168.1.5');
    }
  });

  it('fails closed on unparseable listen values', () => {
    expect(() =>
      validateSidecarListenArgs(['--rpc.listenaddr=not-a-host:port'], { label: 'waved' }),
    ).toThrow(LoopbackViolationError);
  });

  it('ignores non-listen flags (including url-shaped ones)', () => {
    expect(() =>
      validateSidecarListenArgs(
        [
          '--wallet.esploraurl=http://127.0.0.1:1',
          '--datadir=/tmp/sovereign',
          '--rpc.gateway.allowedorigins=tauri://localhost',
        ],
        { label: 'waved' },
      ),
    ).not.toThrow();
  });

  it('enforces litd listener flags (rpclisten, restlisten, listen)', () => {
    expect(() =>
      validateSidecarListenArgs(
        ['--rpclisten=127.0.0.1:10009', '--restlisten=127.0.0.1:8080', '--listen=127.0.0.1:9735'],
        { label: 'litd' },
      ),
    ).not.toThrow();
    expect(() => validateSidecarListenArgs(['--rpclisten=0.0.0.0:10009'], { label: 'litd' })).toThrow(
      LoopbackViolationError,
    );
  });
});

describe('parseHostPort', () => {
  it('parses IPv4, IPv6, hostname, and wildcard forms', () => {
    expect(parseHostPort('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(parseHostPort('[::1]:9090')).toEqual({ host: '::1', port: 9090 });
    expect(parseHostPort('localhost')).toEqual({ host: 'localhost' });
    expect(parseHostPort(':8080')).toEqual({ host: '0.0.0.0', port: 8080 }); // wildcard, never valid
  });
});

describe('regtest compose publishes loopback-only host ports', () => {
  it('every host-published port in docker-compose.yml binds 127.0.0.1', () => {
    const compose = readFileSync(`${REPO_ROOT}harness/regtest/docker-compose.yml`, 'utf8');
    const portLines = compose.split('\n').filter((l) => /^\s*-\s*"?\d/.test(l) && l.includes(':'));
    expect(portLines.length).toBeGreaterThan(0);
    for (const line of portLines) {
      // Form: - "127.0.0.1:host:container" (optionally quoted)
      expect(line, `non-loopback publish: ${line.trim()}`).toMatch(/^\s*-\s*"?127\.0\.0\.1:/);
    }
  });
});

describe('isLoopbackHost sanity (loopback.ts contract used by policy)', () => {
  it('127.0.0.0/8 is loopback; 0.0.0.0 is not', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});
