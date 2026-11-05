# Product capability matrix

Audit of what Sovereign Wallet actually does, as of 2026-11-05 (branch
`feat/product-platform`, base `4b5c563`). Evidence comes from reading the
code, the test suites, and running the apps against a real litd v0.17.8 on
regtest. **Updated after the platform build (same day):** statuses below are
current as of commit `8824e55`; "was:" notes record the original audit where
the status changed. A capability counts as **surfaced** only when a user can discover,
configure, execute, monitor and understand it in the UI. An RPC stub, an
import or a library function with no route to the UI does not count.

## Legend

| Mark | Classification |
| --- | --- |
| ✅ | Fully functional and surfaced in the UI |
| 🟦 | Fully functional, not surfaced in the UI (library code, tested against a real daemon, no route to any screen) |
| 🟨 | Partially implemented |
| 🧪 | Mocked or simulated only |
| ⬜ | Not implemented |
| ⛔ | Unsupported by the current backend, upstream version, or test environment |

Architecture recap: desktop **advanced mode** = React UI → bridge (HTTP,
`services/litd-adapter/src/bridge`) → litd gRPC. Desktop **everyday mode** =
React UI → `waved` REST gateway (Wavelength). Mobile everyday = Wavelength SDK
(simulated client today); mobile advanced = LNC to a remote node.

## LND (advanced mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Create wallet (aezeed) | ✅ | `POST /wallet/seed`, `/wallet/init`; e2e "create"; used by `reset.sh` on every rebuild |
| Restore wallet (aezeed + recovery window) | 🟨 | Bridge route + gate screen; the bridge path is still never tested |
| Unlock | ✅ | Gate screen; exercised on every bridge restart of the local stack (was 🟨). Relaunch on an existing wallet used to time out; fixed (`client.ts` service-up evidence) |
| On-chain balance, receive address, send, fee estimate | ✅ | Receive (QR, `bitcoin:` URI, deposit detection) and Send (review, fee rate, txid) verified on regtest. Fee-rate/target mix-up fixed; `/onchain/estimate-fee` sent no outputs and always failed — fixed |
| On-chain transaction history | ✅ | New `GET /lnd/transactions`; merged into Activity with confirmations, fee and wallet label |
| Taproot (p2tr) receive addresses | ⬜ | Only p2wkh/np2wkh allowed |
| UTXO list / coin control | ⬜ | No ListUnspent route |
| Lightning pay (BOLT11) + decode | ✅ | Decode → review (fee cap, total, destination) → pay → real fee and preimage; verified. Memo/destination of past payments decoded on demand in Activity. Still bypasses `packages/payments` intents |
| Create invoice | ✅ | QR (`LIGHTNING:`), copy, live "payment received"; verified with alice paying |
| Invoice history | ✅ | `GET /lnd/invoices`; Payment requests page with filters and detail sheet (was ⬜) |
| Fee probing before pay (EstimateRouteFee) | ⬜ | User sets a fee cap (default 0.5%, min 10 sats) |
| Keysend | ⬜ | Received keysends are shown; sending is not offered |
| Open / list channels | ✅ | Verified opening a second channel; connecting to an already-connected peer no longer fails |
| Close channel (coop / force) | 🟨 | Sheet with warnings, confirm and job polling; deliberately not executed on the shared node |
| Channel fee policies (FeeReport, UpdateChannelPolicy) | ✅ | Per-channel and all-channel editor; verified (500 msat / 250 ppm) (was ⬜). Time-lock delta and HTLC limits are not read back |
| Peers list | ✅ | Network & peers page (was ⬜). Connect/disconnect only via channel open |
| Forwarding history | 🟨 | 7-day chart + table; capped at the oldest 100 events in the window, no channel ids |
| Network graph / node lookup | ⬜ | |
| SCB export / restore | 🟨 | Export verified (718 bytes, download + copy). Restore gated behind a typed confirmation; not run on the shared node |
| PSBT channel funding | ⬜ | |

## Chain backend

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Neutrino (BIP157) sync | ✅ | Sync height and status in the top bar, dashboard and Node overview. Backend name is not reported by the bridge; the UI says so |
| bitcoind backend | 🟨 | Config path exists; never run in tests |
| Remote LND (litd proxy) | 🟨 | Connections page explains it; no in-app setup |

## Lightning Loop

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Loop daemon running in the shipped app | ✅ | `planSubServers` sets `loop-mode=integrated` + per-wallet dirs; super macaroon auth (was ⛔ bug) |
| Loop Out / Loop In quotes | ✅ code, ⛔ regtest | `/loop/terms`, `/loop/quote`; wizards with real fee breakdown. Here the operator is deliberately offline, and the UI says exactly that. Quote total no longer double-counts the prepayment |
| Execute Loop Out / Loop In | 🟨 | Wizards send `{amountSat, maxTotalFeeSat}`; the bridge re-quotes and refuses if fees rose. **Unverified end to end**: needs `loopserver` (Docker Hub, blocked in this sandbox). Next step: CI job with `loop/regtest` compose |
| Swap list / live status / history | ✅ code | `/loop/swaps`, `/loop/swaps/:id`; history with filters, timeline and costs. Empty without a swap server |
| Static-address Loop In | 🟨 | Address, deposits, Loop In from deposits wired; creation needs the server. No quote route for chosen outpoints |
| AutoLoop | 🟨 | Read params, budget-limited enable with review, dry run (`SuggestSwaps`). Direction/rules can't be set through the bridge yet; disable is in-memory |

## Lightning Pool

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Pool daemon running in the shipped app | ✅ | `pool-mode=integrated` (was ⛔ bug) |
| Market, accounts, orders, leases (read) | ✅ code, ⛔ regtest | `GET /pool` with per-section errors; page shows each table or the raw poold error |
| Open account, submit bid/ask, sidecar | ⬜ | Guided flows explain pricing and stop at a disabled submit that names the missing routes. No regtest auctioneer and no signet support upstream |

## Lightning Terminal (litd)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Sub-server status (litrpc Status) | ✅ | `GET /services`; sidebar marks pages whose service is down (was ⬜) |
| Super macaroon for sub-servers | ✅ | Baked read-write at launch; used for Loop, Pool, tapd, Faraday (was ⛔ bug) |
| LNC sessions create / list / revoke | 🟦 | Library + integration test; desktop shows "not available in this app yet" |

## Taproot Assets

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| List assets / balances | ✅ | Grouped per asset, issuer-unverified badge, per-output confirmations |
| Receive address (new / decode) | ✅ | QR + copy; decode on send |
| Send + transfer history | ✅ | Self-transfer verified (confirmed at block 217). Anchor txids were byte-reversed — fixed in the bridge. Incoming transfers (AddrReceives) not listed |
| Mint (issuance) | ✅ | `POST /assets/mint` used by `reset.sh`; UI flow reached review (final click not exercised in the page run) |
| Proof export / verify | 🟦 | Library only |
| Universe sync, asset channels / RFQ | ⬜ | Asset channels gated off on purpose |

## Faraday

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Channel insights, revenue report | ✅ | Works with the super macaroon and its own data dir (was 🟨, always failing); Routing & analytics page |
| Node audit | ⬜ | |

## Wavelength (everyday mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Create wallet / unlock | ✅ | Real waved in CI |
| Restore from mnemonic | 🧪 | Mobile UI over the simulated client only; no desktop UI |
| Balances | ✅ | Exact buckets from `getWireBalance`: on-chain and boarding no longer shown as Lightning-spendable (was 🟨 mislabel) |
| VTXO state / expiry | ✅ code | Desktop reads live per-VTXO classification and operator reachability (was hard-coded "fresh"); unexercised without an operator |
| On-chain receive / send, Lightning swaps | 🟨 | Real code + UI; unexercised without an operator |
| Collaborative / unilateral exit | ⬜ / 🟦 | Exit not wired on desktop |
| Payment history | ✅ mobile, 🟦 desktop | Mobile Activity tab reads `provider.activityHistory()`; desktop everyday mode still doesn't show it |
| Operator / swap-server availability | ⛔ on regtest | No arkd or swap server; SDK presets cover testnet/testnet4/signet |
| Mobile everyday mode against a real client | 🧪 | Simulated client in preview and tests |

## LNC (mobile advanced mode)

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Pair with a remote node | 🟨 | Screens + controller; native resolver not wired |
| Pay / create invoice | 🟨 | Pay has no decode/review step before sending |
| Revoke session | 🟨 | Controller method exists, no button |

## Cross-cutting

| Capability | Status | Evidence / gap |
| --- | --- | --- |
| Navigation | ✅ | Mobile: bottom tab bar (Home / Activity / Pay / More). Desktop: sidebar in six groups, breadcrumbs, ⌘K palette, `/` search, `.` privacy toggle, hash deep links (was ⬜) |
| Dashboard | ✅ | Balances from one function (`computeAccounts`), no double counting; insights from real state |
| Activity / history | ✅ | Payments, invoices, swaps and on-chain transactions merged; search, filters, totals, detail sheets (was ⬜) |
| Transfers between rails | ✅ | FROM→TO registry offers only real rails; pairs with no rail say why (cross-chain, ERC-20, assets ≠ BTC). 17 tests |
| Design system | ✅ | One token source (`packages/ui` CSS + TS export, drift-tested) used by desktop and mobile; was three palettes |
| Settings | ✅ | Denomination, privacy mode, compact sidebar wired; everything else read-only with where it's configured. No unwired toggles |
| QR codes, copy buttons, payment URIs | ✅ | Receive, requests, assets, static address |
| Privacy controls | 🟨 | Amount hiding + connections disclosure; Tor not configured for the node |
| Crash-safe payment intents | 🟨 | Engine is drill-tested; only Wavelength sends use it |

## What is left (ordered)

1. **Prove Loop end to end**: CI job running `loop/regtest` (loopserver +
   aperture + etcd) against the bridge; execute one Loop Out and one Loop In
   and assert the swap history. Docker Hub is blocked in this sandbox.
2. **Bridge gaps found while building pages**: static-address quote, AutoLoop
   direction/rules, Loop In conf target, invoice expiry, peer alias, chain
   backend name, forwarding pagination, asset AddrReceives and decimals,
   Pool write routes (accounts, orders, sidecar), p2tr addresses, UTXOs.
3. **Wavelength desktop**: real VTXO state/expiry, operator status, exits,
   history, restore.
4. **Payments through intents** for advanced mode (crash-safe sends).
5. Mobile: QR/copy, safe-area insets, real icons, a review total in everyday send, and a decode/review step for remote-node send.

## Upstream and environment blockers

Researched 2026-11-05 against Lightning Labs docs and source (links in
[UPSTREAM_INTEGRATIONS](UPSTREAM_INTEGRATIONS.md)).

| Area | Fact | Consequence |
| --- | --- | --- |
| Loop on regtest | Lightning Labs publishes `lightninglabs/loopserver`, a regtest-only swap server (binary only), wired with aperture (L402) in `loop/regtest/docker-compose.yml` | Real Loop In / Loop Out / static-address journeys **can** be verified on regtest, but only where Docker Hub is reachable (GitHub Actions). This dev environment cannot pull it |
| Loop on signet / testnet | loopd has built-in `signet.swap.lightning.today` and `test.swap.lightning.today` endpoints | Unverified whether they are online |
| Static-address Loop In | Standard since Loop v0.29; MuSig2 taproot address, 250k sat minimum; static-address *autoloop* is `--experimental` | Implement deposits → Loop In; keep static autoloop off |
| AutoLoop | One direction at a time (`--type in|out`); `SuggestSwaps` is the dry run | UI enforces a single direction and offers a dry run |
| Pool | No public regtest auctioneer; poold has no signet; testnet auctioneer status unverified; no official deprecation, but low activity | Pool journeys can only be verified to "market unavailable" in this environment. Marked **unverified** |
| Taproot Assets | Works fully on regtest with a local universe / proof courier; asset channels need integrated litd, protocol flags and a (mock) price oracle | Single-node mint / send / receive / proofs verifiable; asset channels stay gated |
| Faraday via litd | Sub-servers accept their own macaroon or a litd **super macaroon**; LND's admin macaroon fails with "signature mismatch" | Root cause of the Faraday bug; fixed by baking the super macaroon |
| litd sub-server status | `litrpc.Status/SubServerStatus` (since v0.11) returns running / disabled / error per sub-server | Replace error-string readiness guessing with this RPC |
| Wavelength | No public regtest Ark operator or swap server; SDK presets cover testnet, testnet4 and signet | Everyday-mode money movement can't be verified on regtest; needs signet with Lightning Labs' operator (unverified availability) |
| Polar | Supports litd up to 0.16 and disables Loop/Pool | Not useful for Loop/Pool testing |
