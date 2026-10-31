/** Sats formatting helpers — string-safe (no float math on amounts). */

/** Group digits: "1234567" → "1,234,567". Throws on non-numeric input. */
export function formatSats(satString: string): string {
  if (!/^\d+$/.test(satString)) {
    throw new Error(`not a sat amount: ${satString}`);
  }
  return satString.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Parse a user-typed sats amount; undefined when blank. Throws on junk. */
export function parseSatsInput(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/,/g, '');
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Amount must be a whole number of satoshis');
  }
  return trimmed;
}

/** Truncate a hash/txid for display. */
export function shortHash(hash: string, keep = 8): string {
  if (hash.length <= keep * 2) return hash;
  return `${hash.slice(0, keep)}…${hash.slice(-keep)}`;
}
