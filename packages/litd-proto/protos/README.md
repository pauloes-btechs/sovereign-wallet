# Vendored LND protos — pinned to litd v0.17.8

These `.proto` files are vendored **unmodified** from
[`lightningnetwork/lnd` at tag `v0.21.5-beta.rc1`](https://github.com/lightningnetwork/lnd/tree/v0.21.5-beta.rc1/lnrpc)
— the LND version bundled in litd (lightning-terminal) v0.17.8, verified via
the GitHub API on 2026-10-30:

- `lightning.proto` — the `lnrpc.Lightning` service (getinfo, balances,
  addresses, on-chain send, channels, invoices, macaroons, streaming
  subscriptions). Self-contained; no imports.
- `walletunlocker.proto` — the `lnrpc.WalletUnlocker` service (GenSeed,
  InitWallet, UnlockWallet). Imports `lightning.proto`.

> Note: the spec's "pinned `rpc.proto`" is this surface. Modern LND names the
> main service proto `lightning.proto`; `rpc.proto` no longer exists at this
> tag.

Do NOT edit these files by hand. To re-pin against a new litd release, replace
both files from the matching LND tag, run `pnpm --filter @sovereign/litd-proto
generate`, review the diff of the generated TypeScript, and update the
litd-adapter golden tests.

License: MIT (LND). Keep this vendoring in lockstep with the litd sidecar pin
(`sidecars.lock.json`) — the generated client is only guaranteed against the
litd release that bundles this LND version.
