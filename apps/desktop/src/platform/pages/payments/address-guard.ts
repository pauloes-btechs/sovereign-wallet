/**
 * On-chain destination checks shared by every desktop send path (Send →
 * On-chain, Transfers, Loop Out to an external address).
 *
 * The SegWit-version rule comes from `@sovereign/wallet-core`
 * (`unactivatedWitnessRefusal`): an address whose SegWit version has no
 * spending rules yet — v2, the BIP-360 P2MR draft, or v3–v16 — is refused
 * before review, because anyone could take coins sent there. The bridge
 * refuses the same addresses server-side.
 */
import { outputType, unactivatedWitnessRefusal } from '@sovereign/wallet-core';

/** Light format check only; LND/loopd validate the address for the network. */
export const looksLikeAddress = (a: string): boolean =>
  /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}$/i.test(a) || /^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

/**
 * Why this wallet won't send to `address`, when its SegWit version has no
 * spending rules yet; null when it may (or when it isn't a SegWit address —
 * other checks handle format and network).
 */
export function unactivatedAddressProblem(address: string): string | null {
  const refusal = unactivatedWitnessRefusal(address);
  if (refusal === null) return null;
  const what =
    refusal.outputType === null
      ? `a SegWit version-${refusal.witnessVersion} address`
      : `a ${outputType(refusal.outputType).label} address (SegWit version ${refusal.witnessVersion})`;
  return `This is ${what}. ${refusal.reason} This wallet won't send to it. Ask the recipient for a different address.`;
}

/** Format, then SegWit-version check, for an external destination field. Null for an empty field. */
export function externalAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return null;
  if (!looksLikeAddress(a)) return 'That doesn’t look like a Bitcoin address.';
  return unactivatedAddressProblem(a);
}
