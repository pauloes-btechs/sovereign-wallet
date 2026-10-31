import { describe, expect, it } from 'vitest';
import {
  assertFutureExpiry,
  assertTenWordPhrase,
  litSessionType,
} from './lnc-sessions.js';
import { bytesToHex, hexToBytes } from './bytes.js';
import { SessionType as LitSessionType } from '@sovereign/litd-proto';

describe('litSessionType', () => {
  it('maps scoped session kinds onto litd SessionType values', () => {
    expect(litSessionType('readonly')).toBe(LitSessionType.TYPE_MACAROON_READONLY);
    expect(litSessionType('admin')).toBe(LitSessionType.TYPE_MACAROON_ADMIN);
    expect(litSessionType('custom')).toBe(LitSessionType.TYPE_MACAROON_CUSTOM);
  });
});

describe('assertFutureExpiry', () => {
  it('accepts an expiry strictly in the future', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(() => assertFutureExpiry(now, new Date('2026-01-02T00:00:00Z'))).not.toThrow();
  });

  it('rejects a past or equal expiry — litd refuses to create the session', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(() => assertFutureExpiry(now, new Date('2025-12-31T23:59:59Z'))).toThrow(/future/);
    expect(() => assertFutureExpiry(now, now)).toThrow(/future/);
  });
});

describe('assertTenWordPhrase', () => {
  it('accepts exactly 10 space-separated words', () => {
    const phrase = Array.from({ length: 10 }, (_, i) => `word${i}`).join(' ');
    expect(() => assertTenWordPhrase(phrase)).not.toThrow();
  });

  it('rejects phrases with the wrong word count', () => {
    expect(() => assertTenWordPhrase('one two three')).toThrow(/10-word/);
    expect(() => assertTenWordPhrase(Array.from({ length: 11 }, (_, i) => `w${i}`).join(' '))).toThrow(
      /10-word/,
    );
  });
});

describe('bytes helpers', () => {
  it('round-trips hex <-> bytes', () => {
    const hex = '02079a0bc0b6cdabfb92';
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  it('rejects malformed hex', () => {
    expect(() => hexToBytes('abc')).toThrow(/hex/);
    expect(() => hexToBytes('zz')).toThrow(/hex/);
  });
});
