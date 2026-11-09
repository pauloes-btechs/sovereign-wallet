import { describe, expect, it } from 'vitest';
import { receiveTypeRows } from './receive-types.js';

describe('receive address types', () => {
  const rows = receiveTypeRows();
  const row = (id: string) => rows.find((r) => r.id === id);

  it('lists every registry type, P2MR included but not available, with the reason', () => {
    expect(rows.map((r) => r.id)).toEqual(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2wsh', 'p2tr', 'p2mr']);
    expect(row('p2mr')).toMatchObject({ availability: 'not-available', prefix: 'bc1z', availabilityText: 'Not available — BIP-360 is a draft and not activated.' });
  });

  it('offers exactly the bridge types', () => {
    expect(rows.filter((r) => r.availability === 'offered').map((r) => r.id)).toEqual(['p2sh-p2wpkh', 'p2wpkh']);
    for (const r of rows.filter((x) => x.availability === 'not-offered')) expect(r.availabilityText).toMatch(/^Not offered/);
  });

  it('says whether the key is visible while coins sit there', () => {
    expect(row('p2tr')?.exposure).toBe('Visible while unspent');
    expect(row('p2wpkh')?.exposure).toBe('Hidden until spent');
  });
});
