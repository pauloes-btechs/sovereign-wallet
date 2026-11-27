import { describe, expect, it } from 'vitest';
import {
  AssetIdentifierError,
  DEFAULT_STABLECOIN_TICKERS,
  classifyAsset,
  describeAssetSupport,
  parseAssetId,
  parseAssetOutpoint,
  parseGroupKey,
  parseScriptKey,
  shortAssetId,
} from './assets.js';

const VALID_ASSET_ID = 'a'.repeat(64);
const VALID_GROUP_KEY = `02${'b'.repeat(64)}`;
const VALID_SCRIPT_KEY = `03${'c'.repeat(64)}`;

describe('validated asset identifiers', () => {
  it('accepts and canonicalizes a 32-byte asset id', () => {
    expect(parseAssetId(`  ${VALID_ASSET_ID.toUpperCase()} `)).toBe(VALID_ASSET_ID);
  });

  it('rejects asset ids with wrong length, non-hex, or empty input', () => {
    expect(() => parseAssetId('a'.repeat(63))).toThrow(AssetIdentifierError);
    expect(() => parseAssetId('a'.repeat(65))).toThrow(AssetIdentifierError);
    expect(() => parseAssetId(`${'g'.repeat(63)}a`)).toThrow(AssetIdentifierError);
    expect(() => parseAssetId('')).toThrow(AssetIdentifierError);
    try {
      parseAssetId('a'.repeat(63));
      expect.unreachable('must throw');
    } catch (err) {
      expect((err as AssetIdentifierError).code).toBe('wrong-length');
    }
  });

  it('rejects group/script keys that are not 33-byte compressed pubkeys', () => {
    expect(parseGroupKey(VALID_GROUP_KEY)).toBe(VALID_GROUP_KEY);
    expect(parseScriptKey(VALID_SCRIPT_KEY)).toBe(VALID_SCRIPT_KEY);
    expect(() => parseGroupKey(`01${'b'.repeat(64)}`)).toThrow(AssetIdentifierError);
    expect(() => parseGroupKey('b'.repeat(66))).toThrow(AssetIdentifierError);
    try {
      parseScriptKey(`04${'c'.repeat(64)}`);
      expect.unreachable('must throw');
    } catch (err) {
      expect((err as AssetIdentifierError).code).toBe('not-compressed-pubkey');
    }
  });

  it('parses outpoints and rejects malformed ones', () => {
    const txid = 'f'.repeat(64);
    expect(parseAssetOutpoint(`${txid}:1`)).toEqual({ txid, outputIndex: 1 });
    expect(() => parseAssetOutpoint('deadbeef:0')).toThrow(AssetIdentifierError);
    expect(() => parseAssetOutpoint(`${'g'.repeat(64)}:0`)).toThrow(AssetIdentifierError);
    expect(() => parseAssetOutpoint(`${txid}:`)).toThrow(AssetIdentifierError);
    expect(() => parseAssetOutpoint(`${txid}:-1`)).toThrow(AssetIdentifierError);
  });

  it('shortAssetId is display-only', () => {
    expect(shortAssetId(VALID_ASSET_ID)).toBe('aaaaaaaa…');
  });
});

describe('classifyAsset — verified metadata vs unverified issuer claims', () => {
  const usdcClaim = {
    rawHex: Buffer.from(JSON.stringify({ name: 'USD Coin', ticker: 'USDC' })).toString('hex'),
    metaType: 'json' as const,
    json: { name: 'USD Coin', ticker: 'USDC' },
  };
  const untrusted = { trustedIssuers: new Set<string>() };

  it('an unverified asset never renders as a trusted stablecoin', () => {
    const entry = classifyAsset({ assetId: VALID_ASSET_ID, metaHashAnchored: true, meta: usdcClaim }, untrusted);
    expect(entry.trust).toBe('issuer-claimed');
    expect(entry.display.label).toBe('USD Coin (unverified issuer)');
    expect(entry.display.stablecoinImpersonationRisk).toBe(true);
  });

  it('anchored meta + trusted issuer is the only path to a verified label', () => {
    const trusted = { trustedIssuers: new Set([VALID_ASSET_ID]) };
    // Anchored but untrusted: still claimed.
    expect(classifyAsset({ assetId: VALID_ASSET_ID, metaHashAnchored: true, meta: usdcClaim }, untrusted).trust).toBe('issuer-claimed');
    // Trusted but unanchored: still claimed (metadata not bound to the asset).
    expect(classifyAsset({ assetId: VALID_ASSET_ID, metaHashAnchored: false, meta: usdcClaim }, trusted).trust).toBe('issuer-claimed');
    // Both: verified, clean label, no impersonation warning.
    const verified = classifyAsset({ assetId: VALID_ASSET_ID, metaHashAnchored: true, meta: usdcClaim }, trusted);
    expect(verified.trust).toBe('issuer-verified');
    expect(verified.display.label).toBe('USD Coin');
    expect(verified.display.stablecoinImpersonationRisk).toBe(false);
  });

  it('trusting a group key verifies assets in that group', () => {
    const entry = classifyAsset(
      { assetId: VALID_ASSET_ID, groupKeyHex: VALID_GROUP_KEY, metaHashAnchored: true, meta: usdcClaim },
      { trustedIssuers: new Set([VALID_GROUP_KEY]) },
    );
    expect(entry.trust).toBe('issuer-verified');
  });

  it('unparseable or absent metadata renders as unknown and unverified, never a crash', () => {
    const garbage = classifyAsset({ assetId: VALID_ASSET_ID, metaHashAnchored: true, meta: { rawHex: 'deadbeef', metaType: 'opaque' } }, untrusted);
    expect(garbage.display.label).toBe('Unknown asset (unverified issuer)');
  });

  it('stablecoin lookalike matching is case-insensitive across name and ticker', () => {
    const sneaky = classifyAsset(
      { assetId: VALID_ASSET_ID, metaHashAnchored: true, meta: { rawHex: '00', metaType: 'json', json: { name: 'Totally Real USDC Token', ticker: 'usdt' } } },
      untrusted,
    );
    expect(sneaky.display.stablecoinImpersonationRisk).toBe(true);
    expect(DEFAULT_STABLECOIN_TICKERS).toContain('usdc');
  });
});

describe('describeAssetSupport', () => {
  it('names each support depth honestly', () => {
    expect(describeAssetSupport('none')).toBe('Taproot assets not supported');
    expect(describeAssetSupport('layer1')).toBe('Taproot assets on Bitcoin layer 1');
    expect(describeAssetSupport('layer1+channels')).toBe('Taproot assets on layer 1 and over Lightning channels');
  });
});
