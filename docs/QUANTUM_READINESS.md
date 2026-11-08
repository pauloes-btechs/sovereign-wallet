# Quantum readiness

What Sovereign Wallet can and can't do about quantum computers today, what
it does to keep users safe in the meantime, and what changes when Bitcoin
adopts a post-quantum output type. Facts checked on 2026-11-08.

## Where Bitcoin stands (2026-11-08)

| Proposal | What it is | State |
| --- | --- | --- |
| **BIP-360, Pay-to-Merkle-Root (P2MR)** (formerly P2TSH / P2QRH) | A new output type: Taproot without the key-path spend. SegWit **version 2**; mainnet addresses start `bc1z`. Requires BIPs 340, 341, 342 | Layer: Consensus (soft fork). Status: **Draft**, Version 0.12.1, in bitcoin/bips. **Not activated** |
| **BIP-361, Post Quantum Migration and Legacy Signature Sunset** | A plan to phase out ECDSA/Schnorr spending once a post-quantum output type exists | Status: **Draft** (bitcoin/bips header as observed 2026-11-08); still under discussion |
| **SHRINCS** (Jonas Nick, Mikhail Kudinov) | A hash-based post-quantum signature scheme. An `OP_CHECKSHRINCS` opcode proposal (May 2026) was demonstrated on Liquid only. The SHRINCS working group posted a first **draft BIP** to the Bitcoin-Dev mailing list on Aug 26, 2026, with a reference implementation; the Q4 2026 goal is community review | Draft BIP; may not have a BIP number or a bitcoin/bips file yet |

What that means:

- **BIP-360 defines no post-quantum signature algorithm.** It mentions
  ML-DSA and SLH-DSA as research directions. A P2MR output removes the
  public key from the output; spending it still uses today's signatures.
- Its stated goal is resistance to **long-exposure** attacks (a key that
  sits visible on-chain for a long time). **Short-exposure** attacks (a key
  revealed in the mempool during a spend) need faster quantum computers and
  are not addressed by P2MR alone.
- **Nothing is activated.** No wallet can safely receive to or send to P2MR
  today.

## The danger this wallet guards against

Until a soft fork gives SegWit version 2 its rules, a v2 output is
**unencumbered: anyone can spend it**. The same is true for every version
from 2 to 16, and for a version-1 output whose program is not 32 bytes. A
user who pastes a `bc1z…` address (for example, from a wallet that ships
P2MR early) would lose those coins to whoever takes them first.

So the wallet **refuses to send to unactivated SegWit versions**, before the
review step, with the reason:

> Coins sent to a version-2 address before BIP-360 activates can be taken by anyone.

(v3–v16 get the same refusal naming their version.) The address is still
recognised, so the message says what it is instead of "invalid address".

| Where | Guard |
| --- | --- |
| Shared rule | `packages/wallet-core/src/addressTypes.ts`: `witnessVersionPolicy(version, { activated, programLength })` and `unactivatedWitnessRefusal(address)` (bech32/bech32m decoder in `bech32.ts`). Also applied in wallet-core `parseDestination` |
| Mobile | `apps/mobile/src/flows/destination.ts`: bare addresses and `bitcoin:` links are refused at parse time; in a unified `bitcoin:…?lightning=` link the Lightning part stays payable and the on-chain rail is shown unavailable with the reason (`sendFlow.ts` `railOptions`). Loop Out destination check (`transfers.ts`) |
| Desktop | Send → On-chain (`send-kit.tsx` `addressLooksWrong`), Transfers on-chain send and Loop Out to an external address (`pages/payments/address-guard.ts`), Loop page wizard, legacy Mode B on-chain screen |
| Bridge (defence in depth) | `services/litd-adapter`: `POST /onchain/send` and `POST /loop/out` `destAddress` answer **400** with the same reason (`src/bridge/address-policy.ts`) |

## What the wallet shows

- **Exposure view**: a page in the desktop app shows which of the wallet's
  coins sit in outputs whose public key is visible on-chain (built
  separately; see the app's quantum exposure page).
- **Receive → On-chain → Address types**: every known output type from the
  registry, whether this page offers it (and why not), and whether its key
  is visible while coins sit there: P2WPKH and nested SegWit hide the key
  until spent; Taproot (P2TR) shows it for as long as the coins sit there;
  P2MR is listed as **"Not available — BIP-360 is a draft and not
  activated"**. There is no way to create a P2MR address, and the bridge
  answers a `p2mr` address request with that reason.

## When BIP-360 activates

Activation means a soft fork with a signalled, locked-in activation height
on mainnet — not a BIP Status change on its own. Then:

1. **Registry**: set `p2mr`'s `status` to `{ state: 'active' }` in
   `addressTypes.ts`. `witnessVersionPolicy` then allows v2 with a 32-byte
   program automatically (other v2 lengths and v3–v16 stay refused). Ship it
   behind the activation height for mainnet; regtest/signet can go first.
2. **Receive**: add P2MR receive once LND (via litd) can create P2MR
   addresses, and allow the type in the bridge's `/onchain/address`.
3. **Migration flow (future)**: move coins from key-exposed outputs (P2TR,
   reused addresses) to P2MR, driven by the exposure view. Not built.
4. Revisit BIP-361's timeline, and post-quantum signatures (e.g. SHRINCS)
   once a signature BIP is adopted.

## What is tracked weekly

The upstream watch (`.github/workflows/upstream-watch.yml`,
`scripts/upstream-watch/quantum.mjs`) records, every Monday:

- `bip-0360.mediawiki` and `bip-0361.mediawiki` in bitcoin/bips: the
  `Status` and `Version` header lines and the last commit (GitHub contents
  and commits API).
- Bitcoin Core pull requests mentioning "BIP-360", "BIP360" or P2MR (GitHub
  search), new ones and state changes (opened, closed, merged).
- The SHRINCS draft BIP: bitcoin/bips pull requests mentioning SHRINCS, the
  BIP number once a `bip-NNNN` file appears in one, that file's Status, and
  the merge.

Observations are compared with `scripts/upstream-watch/quantum-baseline.json`
(recorded 2026-11-08: BIP-360 Draft 0.12.1, BIP-361 Draft; Core PRs and
SHRINCS PRs not yet recorded, so the first run reports them once). Any change
adds a **Quantum readiness** section to the weekly issue, or opens an issue
of its own when no Lightning Labs release changed. Accept a change with
`node scripts/upstream-watch/check.mjs --write-quantum-baseline` and commit
the baseline.
