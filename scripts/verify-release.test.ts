import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LITD_ASSETS,
  WAVED_BINARIES,
  comparePins,
  evaluateGpgStatus,
  expectedHashes,
  parseManifest,
  readWavedPins,
  verifySignatureFile,
  // @ts-expect-error — plain ESM script module, no type declarations
} from './verify-release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixtures = path.join(here, 'release-keys/fixtures');
const read = (p: string): string => readFileSync(p, 'utf8');

interface Signers {
  signers: Record<string, string>;
  releases: Record<string, { repo: string; signers: string[]; minSignatures: number }>;
}
const trust = JSON.parse(read(path.join(here, 'release-keys/signers.json'))) as Signers;
const VIKTOR = trust.signers['ViktorT-11'] ?? '';
const ROASBEEF = trust.signers.roasbeef ?? '';

const VALID = (primary: string, signedAt = 1792632263): string =>
  `[GNUPG:] VALIDSIG 296212681AADF05656A2CDEE90525F7DEEE0AD86 2026-10-22 ${signedAt} 0 4 0 22 10 00 ${primary}`;

describe('manifest parsing', () => {
  it('reads sha256 lines and ignores everything else', () => {
    const m = parseManifest(`${'a'.repeat(64)}  x.tar.gz\n\nnot a hash line\n${'B'.repeat(64)}  dir/bin\n`);
    expect(m.get('x.tar.gz')).toBe('a'.repeat(64));
    expect(m.get('dir/bin')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });

  it('refuses a manifest that lists one file with two hashes', () => {
    expect(() => parseManifest(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n`)).toThrow(/twice/);
  });
});

describe('gpg status evaluation', () => {
  it('accepts a good signature by the pinned primary key (subkey signing)', () => {
    const status = `[GNUPG:] GOODSIG 90525F7DEEE0AD86 someone\n${VALID(ROASBEEF)}\n`;
    expect(evaluateGpgStatus(status, ROASBEEF)).toMatchObject({ ok: true, primary: ROASBEEF });
  });

  it('rejects a valid signature from any other key', () => {
    const status = `[GNUPG:] GOODSIG 961CC8259AE675D4 someone\n${VALID(VIKTOR)}\n`;
    expect(evaluateGpgStatus(status, ROASBEEF)).toMatchObject({ ok: false });
  });

  it('rejects bad, revoked and uncheckable signatures', () => {
    expect(evaluateGpgStatus('[GNUPG:] BADSIG 90525F7DEEE0AD86 x\n', ROASBEEF).ok).toBe(false);
    expect(evaluateGpgStatus(`[GNUPG:] REVKEYSIG 90525F7DEEE0AD86 x\n${VALID(ROASBEEF)}\n`, ROASBEEF).ok).toBe(false);
    expect(evaluateGpgStatus('[GNUPG:] ERRSIG 90525F7DEEE0AD86 1 10 00 1 9\n', ROASBEEF).ok).toBe(false);
    expect(evaluateGpgStatus('', ROASBEEF).ok).toBe(false);
  });

  it('rejects output with more than one VALIDSIG (one file must be one signature)', () => {
    const status = `[GNUPG:] GOODSIG a x\n${VALID(ROASBEEF)}\n[GNUPG:] GOODSIG b y\n${VALID(ROASBEEF)}\n`;
    expect(evaluateGpgStatus(status, ROASBEEF).ok).toBe(false);
  });

  it('accepts an expired key only for signatures made before it expired', () => {
    const before = `[GNUPG:] KEYEXPIRED 1793271779\n[GNUPG:] EXPKEYSIG 90525F7DEEE0AD86 x\n${VALID(ROASBEEF, 1792632263)}\n`;
    const after = `[GNUPG:] KEYEXPIRED 1793271779\n[GNUPG:] EXPKEYSIG 90525F7DEEE0AD86 x\n${VALID(ROASBEEF, 1793271780)}\n`;
    expect(evaluateGpgStatus(before, ROASBEEF).ok).toBe(true);
    expect(evaluateGpgStatus(after, ROASBEEF)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });
});

describe('pin comparison', () => {
  it('reports differing, missing and extra pins', () => {
    const problems = comparePins({ a: 'A'.repeat(64), b: '1'.repeat(64), extra: '2'.repeat(64) }, { a: 'a'.repeat(64), b: '3'.repeat(64), c: '4'.repeat(64) });
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/b: pinned/);
    expect(problems.join('\n')).toMatch(/c: not pinned/);
    expect(problems.join('\n')).toMatch(/extra: pinned but not in the signed manifest/);
  });

  it('fails loudly when the manifest lacks a platform', () => {
    expect(() => expectedHashes(new Map(), LITD_ASSETS, 'v0.17.10', 'lightning-terminal-')).toThrow(/no entry/);
  });
});

describe('committed pins match the committed signed manifest', () => {
  it('sidecars.lock.json equals the signed manifest committed for its pinned tag', () => {
    const lock = JSON.parse(read(path.join(root, 'sidecars.lock.json'))) as { litd: { tag: string; assetPrefix: string; sha256: Record<string, string> } };
    const manifest = parseManifest(read(path.join(fixtures, `manifest-${lock.litd.tag}.txt`)));
    const expected = expectedHashes(manifest, LITD_ASSETS, lock.litd.tag, `${lock.litd.assetPrefix}-`);
    expect(comparePins(lock.litd.sha256, expected)).toEqual([]);
  });

  it('reads all five waved pins from fetch-waved.mjs', () => {
    const pins = readWavedPins(read(path.join(root, 'scripts/fetch-waved.mjs'))) as { tag: string; sha256: Record<string, string> };
    expect(pins.tag).toMatch(/^v\d+\.\d+\.\d+/);
    expect(Object.keys(pins.sha256).sort()).toEqual(Object.keys(WAVED_BINARIES).sort());
  });

  it('pins every trusted signer to a committed key file', () => {
    for (const rel of Object.values(trust.releases)) {
      expect(rel.minSignatures).toBeGreaterThanOrEqual(1);
      for (const s of rel.signers) {
        expect(trust.signers[s]).toMatch(/^[0-9A-F]{40}$/);
        expect(read(path.join(here, 'release-keys', `${s}.asc`))).toContain('BEGIN PGP PUBLIC KEY BLOCK');
      }
    }
  });
});

describe('real gpg against the committed keys', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'verify-release-test-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const sig10 = path.join(fixtures, 'manifest-ViktorT-11-v0.17.10.sig');
  const manifest10 = path.join(fixtures, 'manifest-v0.17.10.txt');

  it('verifies the litd v0.17.10 manifest signature', () => {
    expect(verifySignatureFile('ViktorT-11', VIKTOR, sig10, manifest10, work)).toMatchObject({ ok: true, primary: VIKTOR });
  });

  it('verifies the litd v0.17.11 manifest signature (the current pin)', () => {
    const v = verifySignatureFile('ViktorT-11', VIKTOR, path.join(fixtures, 'manifest-ViktorT-11-v0.17.11.sig'), path.join(fixtures, 'manifest-v0.17.11.txt'), work);
    expect(v).toMatchObject({ ok: true, primary: VIKTOR });
  });

  it('does not accept the v0.17.10 signature for the v0.17.11 manifest', () => {
    expect(verifySignatureFile('ViktorT-11', VIKTOR, sig10, path.join(fixtures, 'manifest-v0.17.11.txt'), work).ok).toBe(false);
  });

  it('accepts roasbeef’s v0.17.8 signature, made before his key expired', () => {
    const v = verifySignatureFile('roasbeef', ROASBEEF, path.join(fixtures, 'manifest-roasbeef-v0.17.8.sig'), path.join(fixtures, 'manifest-v0.17.8.txt'), work);
    expect(v).toMatchObject({ ok: true, primary: ROASBEEF });
  });

  it('does not count a signature under another signer’s name', () => {
    expect(verifySignatureFile('roasbeef', ROASBEEF, sig10, manifest10, work).ok).toBe(false);
  });

  it('rejects a manifest with one hash swapped', () => {
    const tampered = path.join(work, 'tampered.txt');
    const text = read(manifest10);
    const line = text.split('\n').find((l) => l.endsWith('lightning-terminal-linux-amd64-v0.17.10.tar.gz')) ?? '';
    expect(line).not.toBe('');
    writeFileSync(tampered, text.replace(line, `${'0'.repeat(64)}  lightning-terminal-linux-amd64-v0.17.10.tar.gz`));
    expect(verifySignatureFile('ViktorT-11', VIKTOR, sig10, tampered, work).ok).toBe(false);
  });
});
