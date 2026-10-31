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
- `tapcommon.proto`, `taprootassets.proto`, `mint.proto` — the tapd v0.8.6
  surface: `taprpc.TaprootAssets` (ListAssets, ListBalances, ListTransfers,
  NewAddr/DecodeAddr/AddrReceives, SendAsset, VerifyProof/DecodeProof/
  ExportProof/UnpackProofFile, FetchAssetMeta) and `mintrpc.Mint`
  (MintAsset, FundBatch, SealBatch, FinalizeBatch, CancelBatch, ListBatches).
  Vendored unmodified from
  [`lightninglabs/taproot-assets` at tag `v0.8.6`](https://github.com/lightninglabs/taproot-assets/tree/v0.8.6/taprpc)
  (`taprpc/tapcommon.proto`, `taprpc/taprootassets.proto`,
  `taprpc/mintrpc/mint.proto` — the tapd revision litd v0.17.8 pins in
  go.mod, verified via GitHub API, 2026-10-31). Flat layout: upstream
  imports are same-dir (`import "tapcommon.proto"`), so all three sit at
  the vendored root. Generated clients are exported from
  `@sovereign/litd-proto` under the `tapdCommon` / `tapdAssets` / `tapdMint`
  namespaces — their messages collide with LNRpc names (GetInfoRequest,
  OutPoint), so never flat-re-export them.
- `loop.proto` — the `looprpc.SwapClient` service (LoopOut/LoopIn quotes and
  execution, terms, swap status/monitoring, LiquidityParams get/set for
  AutoLoop). Vendored from
  [`lightninglabs/loop` at commit `333ed1efccdd375a17fb2df4ace0fb13ac97ce2a`](https://github.com/lightninglabs/loop/tree/333ed1efccdd375a17fb2df4ace0fb13ac97ce2a/looprpc)
  (the exact revision litd v0.17.8 pins in go.mod, verified via GitHub API,
  2026-10-31). Imports `common.proto` and `lightning.proto` (paths rewritten
  from `swapserverrpc/` and `lnrpc/` to the flat vendored layout).
- `common.proto` — `looprpc` shared messages (HopHint, RouteHint, FeeReport,
  terms helpers) from the same Loop commit. Self-contained; no imports.
- `pool.proto` — the `poolrpc.Trader` service (accounts, orders, leases,
  market info/BatchSnapshot — the market-availability surface). Vendored from
  [`lightninglabs/pool` at commit `262af739b741d54fb74a787888bec83123082164`](https://github.com/lightninglabs/pool/tree/262af739b741d54fb74a787888bec83123082164/auctioneerrpc)
  (the exact revision litd v0.17.8 pins in go.mod, verified via GitHub API,
  2026-10-31). Imports `auctioneer.proto` (path rewritten from
  `auctioneerrpc/` to the flat vendored layout).
- `auctioneer.proto` — `poolrpc` auctioneer/messages (account state,
  match/batch types) from the same Pool commit. No third-party imports.

The router and faraday services are served by the litd sidecar: routerrpc on
the embedded LND's wallet-facing gRPC listener, frdrpc through litd's proxy
mux. The Faraday surface backs the Mode B diagnostics pane; revenue numbers
come from the node's own forwarded-HTLC history.
- `lit-sessions.proto` — the `litrpc.Sessions` service (AddSession,
  ListSessions, RevokeSession), vendored **unmodified** from
  [`lightninglabs/lightning-terminal` at tag `v0.17.8`](https://github.com/lightninglabs/lightning-terminal/blob/v0.17.8/litrpc/lit-sessions.proto)
  (`litrpc/lit-sessions.proto`). Self-contained; no imports. Used by the
  LNC mobile mode to create/revoke macaroon-scoped LNC sessions.

tapd differs: in integrated mode the tapd sub-server registers its gRPC
services on litd's own TLS mux (`httpslisten`, default 127.0.0.1:8443) —
NOT on the embedded LND's raw listener. Calls authenticate with tapd's own
admin macaroon (`taproot-assets.macaroonpath`, tapd permissions, rooted at
the shared LND root key) presented over litd's TLS. The wallet-facing
surface for assets is therefore: litd `httpslisten` + litd TLS cert +
tapd admin.macaroon (verified against litd v0.17.8 and tapd v0.8.6
sources, 2026-10-31).
The Loop (`looprpc`) and Pool (`poolrpc`) services are also served through
litd's unified gRPC proxy on the `httpslisten` endpoint — litd runs the Loop
and Pool sub-servers in-process, so no extra daemon is managed. In integrated
mode these sub-servers register only after the embedded LND has fully synced
to its chain backend; clients must tolerate "unavailable" responses until
then.

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
