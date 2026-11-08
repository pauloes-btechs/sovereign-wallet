/**
 * Defence in depth for every route that sends bitcoin to a caller-supplied
 * address (`/onchain/send`, `/loop/out` destAddress): refuse SegWit
 * versions with no spending rules yet — v2 (BIP-360 P2MR, a draft, not
 * activated) and v3–v16 — because anyone could take coins sent there. The
 * apps refuse first; this keeps a bypassed or older client from doing it.
 */
import { unactivatedWitnessRefusal } from '@sovereign/wallet-core';
import { BridgeRequestError } from './session.js';

/** Returns the address unchanged, or throws a 400 with the reason. */
export function requireSendableAddress(address: string): string {
  const refusal = unactivatedWitnessRefusal(address);
  if (refusal !== null) throw new BridgeRequestError(400, refusal.reason);
  return address;
}
