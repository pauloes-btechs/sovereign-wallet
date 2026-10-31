# Wallet Recovery

What can be restored, from what, under which clock — for both modes. The
mechanisms below are exercised by the release-blocking drill suite in
`harness/recovery`; evidence renders into [TEST_RESULTS](TEST_RESULTS.md).

The single governing rule: **recovery paths are disjoint per provider.** A
seed created under one engine never restores a wallet under the other — the
recovery UI refuses cross-provider seeds with an explicit explanation rather
than attempting a partial restore.

## Mode A — Wavelength (Ark)

State that must be recovered: on-device keys (seed), VTXO inventory
(off-chain), and the local encrypted VTXO backup.

### Seed restore before VTXO batch expiry (primary path)

A seed restore rebuilds off-chain VTXO state (SDK v0.1.2+) by scanning the
Ark operator's batches. **It must complete before the batch expires** — after
expiry the operator-side scan finds nothing (drill `drill-2-negative-expired-
restore` proves this negative leg).

1. Enter the seed on a fresh daemon (same provider).
2. The operator-side scan rebuilds live VTXOs; the wallet identity matches
   the pre-restore wallet.
3. Restored VTXOs classify fresh — spendable inside the free-refresh window.

The onboarding backup-confirmation step states the consequence plainly:
_"If you ever need to restore, do it promptly — waiting too long can force a
slower on-chain exit."_

### Operator-unreachable fallback

If the operator is unreachable during restore, the seed alone recovers keys
but **zero VTXO state**. The wallet's local encrypted backup (captured
whilst funded) rebuilds the VTXO inventory without the operator (drill
`drill-2-operator-unreachable-fallback`):

1. Local encrypted backup restores the VTXO inventory.
2. Exit readiness gates on a funded fee source — the wallet prompts to fund
   the exit fee.
3. Unilateral exit is a wallet-side operation; it carries funds on-chain
   even with the operator permanently down.

### What recovery does NOT restore

- Lightning swap-in-flight state (swap-server side records; swaps are
  atomic — funds are either settled or refundable via the swap server).
- Anything after batch expiry without the local encrypted backup (off-chain
  path is unrecoverable; only a unilateral exit remains).

## Mode B — litd / LND

### aezeed + SCB channel restore

1. Restore the aezeed seed on a fresh (or wiped) node.
2. Import the static channel backup (SCB) — `chanbackup.scb` / `channel.bak`
   from the node data directory.
3. Force-close restored channels if the peer is unreachable; funds return
   on-chain after the force-close confirms (drill `drill-1-aezeed-scb`).

SCB is cooperative-restore data, not a guarantee: peers must exist on the
network for the sweep path to settle. The wallet prompts for a backup file
location at channel-open time.

### Taproot asset state

The LND seed alone restores **no asset state** — seed-only asset recovery is
impossible by design (tapd v0.8.x). The exported tapd wallet backup must be
imported, and asset proofs re-verify on-chain before balances reappear
(drill `drill-3-tapd-backup`). The backup file is therefore mandatory output
of any asset issuance or receive flow.

### Interrupted payments

Payment intents persisted in-flight before dispatch are reconciled against
the real LND on restart (drill `drill-4-payment-reconciliation`):

- A payment the backend settled is recognized as settled — never re-dispatched.
- A payment that never reached the backend returns to `authorized` for one
  safe, re-signed retry.
- Unknown-result payments surface a user-facing recovery explanation — no
  silent loss, no blind re-broadcast.

### Identity guard

Initializing two live nodes from the same seed yields identical identity
keys; the wallet-core identity guard refuses the second registration before
funds can be double-spent (drill `drill-5-duplicate-identity`).

## Running the drills

```sh
pnpm sidecar:fetch                      # hash-verified litd sidecar
pnpm --filter @sovereign/harness-recovery test:integration
```

Requires Docker (regtest harness) and is destructive by design — drills wipe
node data dirs, guarded by an on-node regtest-chain assertion. Results render
into `docs/TEST_RESULTS.md` between the `recovery-results` markers.
