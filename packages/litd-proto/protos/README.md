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
- `router.proto` — the `routerrpc.Router` service (SendPaymentV2 payment
  lifecycle, SendToRouteV2, EstimateRouteFee, Query/Get/SetMissionControlConfig,
  QueryProbability, BuildRoute). Vendored from
  [`lightningnetwork/lnd` at tag `v0.21.5-beta.rc1`](https://github.com/lightningnetwork/lnd/tree/v0.21.5-beta.rc1/lnrpc/routerrpc)
  — the LND version bundled in litd v0.17.8 (verified via GitHub API,
  2026-10-31). Imports `lightning.proto`.
- `faraday.proto` — the `frdrpc.FaradayServer` service (RevenueReport,
  ChannelInsights, CloseReport, NodeAudit, ExchangeRate, forwarding-ability
  and close-recommendation analytics). Vendored from
  [`lightninglabs/faraday` at commit `b547baea0f95`](https://github.com/lightninglabs/faraday/tree/b547baea0f95/frdrpc)
  (the `frdrpc` module at v1.0.2 — the exact revision litd v0.17.8 pins in
  go.mod, verified via GitHub API, 2026-10-31). Self-contained; no imports.

The router and faraday services are served by the litd sidecar: routerrpc on
the embedded LND's wallet-facing gRPC listener, frdrpc through litd's proxy
mux. The Faraday surface backs the Mode B diagnostics pane; revenue numbers
come from the node's own forwarded-HTLC history.
- `lit-sessions.proto` — the `litrpc.Sessions` service (AddSession,
  ListSessions, RevokeSession), vendored **unmodified** from
  [`lightninglabs/lightning-terminal` at tag `v0.17.8`](https://github.com/lightninglabs/lightning-terminal/blob/v0.17.8/litrpc/lit-sessions.proto)
  (`litrpc/lit-sessions.proto`). Self-contained; no imports. Used by the
  LNC mobile mode to create/revoke macaroon-scoped LNC sessions.

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
