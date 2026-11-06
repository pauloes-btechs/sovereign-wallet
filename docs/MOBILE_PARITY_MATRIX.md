# Mobile parity matrix

Audit of what the mobile app (`apps/mobile`) does compared with desktop, and
what each mobile backend can support, as of 2026-11-05 (branch
`feat/mobile-parity`). Every row is from reading the code named in it; nothing
here was run on a device. Desktop statuses come from the code and from
[PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md).

## Read this first

- **Only the web preview runs flows.** Native shells exist
  (`apps/mobile/ios`, `apps/mobile/android`; CI jobs `android-dev-build` and
  `ios-dev-build` in `.github/workflows/ci.yml`), but `apps/mobile/index.js`
  registers `App` with no Wavelength client resolver and no LNC port resolver,
  so a native build renders "Native shell not configured"
  (`src/App.tsx`, `ModeAEntry` / `ModeBEntry`). The preview (`pnpm web:dev`)
  runs the real controllers and screens over react-native-web against
  **simulated** backends: `src/testing/simulatedWalletClient.ts` (harness
  `SimulatedWavelengthClient`) and `src/testing/simulatedLncPort.ts`. No Android
  SDK or Xcode is available in the build sandbox.
- **Two backends, never equivalent.** Mode A "everyday" is a Wavelength (Ark)
  wallet on the phone (`@sovereign/wavelength-adapter`). Mode B "remote node"
  is the user's own LND/litd reached over Lightning Node Connect through
  `LncRpcPort` (`src/flows/modeBRemoteController.ts`). The backend columns
  below are separate on purpose.
- **What "backend support" means.** For Wavelength: what
  `WavelengthProvider` (`services/wavelength-adapter/src/provider.ts`) and the
  pinned SDK request types (`@lightninglabs/wavelength-core@0.2.0`,
  `dist/requests.d.ts`) accept. For remote LND: what `LncRpcPort` exposes
  today, and separately what a litd LNC session could reach (marked
  "possible", not verified in this repo).
- Screens render from `MobileWalletCapabilities`
  (`src/flows/capabilities.ts`), which derives each feature from the declared
  provider capabilities, the live connection and the injected device services,
  with a user-facing reason for every unavailable feature.

## Legend

| Mark | Meaning |
| --- | --- |
| ✅ | Works and is surfaced in the mobile UI (against the simulated backend in the preview) |
| 🟨 | Partly implemented |
| 🟦 | Backend/library supports it; no mobile UI |
| 🧪 | Only exercised against a simulated backend |
| ⬜ | Not implemented |
| ⛔ | The backend (or the port the app uses) does not support it |
| — | Not applicable to this backend |

## A. Full mobile parity

Capabilities that should work on desktop and mobile wherever the active
backend supports them.

| Capability | Desktop | Mobile today | Wavelength backend | Remote LND via LNC | Status | Mobile UI | Security requirements | Plan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wallet creation | Everyday: create + backup confirm (`apps/desktop/src/wallet/WalletApp.tsx`). Advanced: aezeed create (`apps/desktop/src/modeb`) | Mode A create → 12 words → verify every word (`src/ui/onboardingScreens.tsx`, `src/ui/verifyWords.ts`) | `createWallet({ password })` ✓ | — the node holds the keys; nothing to create on the phone | ✅ Mode A 🧪 | Onboarding (no tabs) | Words held only in controller state during backup and cleared on confirm (`confirmBackup`); never persisted. Needs screen-capture protection while words show (not available) | Native Wavelength resolver; screen-capture protection on the backup screen |
| Wallet restoration | Everyday: none. Advanced: aezeed restore gate (🟨, untested) | Mode A restore: 12/24-word check, cross-provider seed guard (`assertSeedCompatible`), batch-expiry failure explained (`modeAController.ts` `restore`) | `createWallet({ mnemonic, recoverState: true })` ✓ | — restored on the node | ✅ Mode A 🧪 | Onboarding | Phrase typed into a field and passed once; same capture protection need | Native resolver; clear the field from memory after use |
| Balances | Advanced: `computeAccounts` (`apps/desktop/src/platform/balances.ts`) with on-chain / outbound / inbound / locked | Mode A: total + Lightning spendable / on-chain confirmed / locked-or-expiring (`MobileBalanceGrid`). Mode B: Lightning spendable, on-chain confirmed, channel count | `balanceBuckets()`; on-chain buckets are zero unless the client exposes the gateway wire balance (`provider.ts` comment) | `getBalances()`: `lightningSpendableSat`, `onchainConfirmedSat`, `channels[]` — no unconfirmed on-chain, no pending channels | ✅ 🧪 | Home | Privacy mode masks amounts (`useAmountFormatter`) | Mode B: add pending/unconfirmed to the port so pending vs spendable is shown |
| Denomination (sats/BTC) and privacy mode | `usePrefs()` unit + hideAmounts (`apps/desktop/src/platform/context.tsx`) | **New:** `Preferences.denomination` / `hideBalances` (`src/flows/preferences.ts`); every amount goes through `MobileAmount` / `useAmountFormatter` (`src/ui/Primitives.tsx`, `src/ui/appContext.tsx`). Exact bigint BTC formatting (`src/ui/format.ts`) | — (display only) | — (display only) | 🟨 | No settings screen yet; values take effect when stored | Masked amounts are spoken as "Amount hidden" | Settings screen in the Wallet tab |
| Bitcoin send | Advanced: fee rate, review, txid (✅). Everyday: `quoteOnchain` review | **Unified Send** (`src/ui/send/`): one "Pay to" input parsed on the phone (`flows/destination.ts`: address checksum + network, BIP21 amount/label) → amount in the user's denomination → live quote → review (from, to, amount, fee, quoted total, timing, "can't be reversed") → confirm through `PaymentEngine` → in-flight / reconcile → receipt | `quoteOnchain` + `WavelengthPaymentDispatcher`; fee cap `maxFeeSat` only — `SendRequest` has no fee rate or confirmation target | ⛔ port has no `sendCoins` / `estimateFee` (the rail is shown with its reason). Possible: LND `SendCoins`, `EstimateFee` | Mode A ✅ 🧪 · Mode B ⛔ | Send tab | Review before confirm with the quoted fee; persist-before-dispatch | Mode B port extension |
| Bitcoin receive | Advanced: address, QR, `bitcoin:` URI, deposit detection | **Unified Receive** (`src/ui/receive/`): fresh boarding address per tap, BIP21 QR with optional amount + label, copy, share when the device has it, address-reuse warning, deposits from `activityDetails` (pending / confirmed with block height) | `depositOnchain()` ✓; deposits are not tied to an address in the activity record | ⛔ port has no `newAddress` (tab shows the reason). Possible: LND `NewAddress` | Mode A ✅ 🧪 · Mode B ⛔ | Receive tab | Address reuse: a new address per tap, warning shown | Per-address deposit tracking needs the address in the entry; Mode B port extension |
| Lightning send | Advanced: decode → review with fee cap → pay → fee and preimage | **Unified Send**: BOLT11 / `lightning:` / unified BIP21 decoded on the phone (amount, description, expiry, payment hash; checksum verified, signature left to the backend). Mode A: swap quote with `maxFeeSat` from the fee preference → review → confirm → in-flight → reconcile (now reports a reconciled *failure* as failed) → receipt. Mode B: review shows the fee **limit** and timeout from preferences → `payInvoice({ feeLimitSat, timeoutSeconds })` → receipt with the routing fee from the node's record; ambiguous outcomes stay `in-flight` with "Check payment status" (never a resend); the node's failure reason is kept and explained | `quoteLightning` (+ `maxFeeSat`) ✓; amountless invoices refused (SDK v1) | `payInvoice({ bolt11, timeoutSeconds, feeLimitSat? })` (sim implements both); amountless invoices refused (no amount field); reconciliation key is now the decoded payment hash | Mode A ✅ 🧪 · Mode B ✅ 🧪 | Send tab | Review before confirm; non-dismissable progress sheet while dispatching; foreground-only dispatch on Mode B | Real lnc-rn adapter must pass `fee_limit_sat` / `timeout_seconds` |
| Lightning receive | Advanced: invoice, QR, live "received" | **Unified Receive**: amount (required on Mode A, optional on Mode B), description, expiry, QR, copy, share when available, status (waiting / paid / expired) polled from the backend's own records | `receiveLightning(amountSat, memo)`; `ReceiveRequest` has no expiry (decoded expiry shown instead); status from the receive entry carrying the invoice's payment hash | `addInvoice({ valueSat, memo, expirySeconds? })` (expiry from the preference); status from `listLightningActivity` when present, otherwise "can't be read over this connection" | ✅ 🧪 | Receive tab | — | Mode B: invoice subscription instead of polling |
| Payment history | Advanced: payments, invoices, swaps, on-chain merged; search, filters, detail sheets. Everyday: none | **Activity tab** (`src/ui/activity/`, `flows/activity.ts`): one model for both modes; search (memo, ids, amount), status chips, type chips when there is more than one rail, grouped by day; loading, empty, error, unavailable states | ✅ `provider.activityDetails()` (one page, no paging) | 🧪 Lightning payments + invoices via optional `listLightningActivity`; no on-chain history over the port | ✅ / 🧪 | Activity tab | Preimage hidden until tapped and excluded from search | Paging (Mode A cursor not on the port); swap and asset rows in Activity |
| Transaction details / receipts | Detail sheets with timeline, fees, ids | **Receipt screen** (`ui/activity/TransactionDetail.tsx`): amount, status, timeline of reported steps only, fee or why it is missing, ids with copy, "Not reported by this wallet" for absent fields | ✅ `mapEntryToActivityDetail` (fee, txid, preimage, confirmation height, failure code) | 🧪 settle time and preimage not reported over this connection | ✅ / 🧪 | Pushed from Activity and Home | Preimage reveal on tap | — |
| Fee previews | `Breakdown` with real quotes | Mode A: quoted fee + quoted total, "estimated" when `feeKnown` is false, the fee cap shown. Mode B: "Routing fee: up to X" (the fee limit) and "Total, at most" — LND can't quote a route over the port | `expectedFeeSat` / `expectedTotalOutflowSat` from the quote ✓ | ⛔ no route-fee estimate in the port. Possible: `EstimateRouteFee` / `QueryRoutes` | Mode A ✅ · Mode B 🟨 (cap, not quote) | Send tab | — | Mode B port extension for a real estimate |
| Payment status | Toasts, status views | Mode A: in-flight + "Check payment status" reconcile; reconciled failures reported as failures (`ModeAEnginePort.intentState`). Mode B: sending (sheet) / in-flight + check status / settled with receipt / failed with the node's reason | Engine reconcile via `lookup` ✓ | `lookupPayment` (sim returns `unknown`) | 🟨 🧪 | Send tab | Persist-before-dispatch **only in memory**: both modes use `InMemoryPaymentIntentStore` (`src/App.tsx`, `modeBRemoteController.ts`), so an app kill loses the intent | SQLCipher/keystore-backed intent store on device |
| Wallet security (PIN, biometrics, auto-lock) | "App lock isn't available in this build" (`pages/account/security.tsx`) | **App lock** (`flows/appLock.ts`, `ui/wallet/WalletSecurity.tsx`): 6–12 digit PIN stored only as scrypt (N=2^15, r=8, p=1) with per-PIN salt, constant-time compare; 5 free attempts then 30 s → 1 h backoff persisted before answering; lock on launch and after the lock timeout; lock overlay hides and un-mounts nothing but makes the app invisible to screen readers; fails closed; biometric unlock only when the host provides it; Forgot PIN via a slow salted verifier of the recovery phrase (Mode A) | — (device-side) | — (device-side) | ✅ preview / 🟨 native | Wallet → Security | Native: `react-native-keychain` 10.0.0 (Keychain/Keystore, this device only, biometric access control); `NSFaceIDUsageDescription`, `USE_BIOMETRIC` added. **Needs the CI native builds and a device to verify**; Hermes `getRandomValues` and scrypt timing unmeasured | Verify on device |
| Wallet preferences | Settings page (`pages/account/settings.tsx`) | **Settings center** (`ui/wallet/`): General (unit, hide balances, haptics, appearance, fiat, language, notifications), Payment preferences (max Lightning fee, payment timeout, invoice expiry, on-chain fee preference) each with whether the active backend applies it | Fee cap applied to quotes; timeout from next start; invoice expiry and on-chain fee rate ⛔ (SDK can't set them; the UI says so) | 🧪 fee limit, timeout and expiry passed per payment/invoice | ✅ | Wallet → General / Payments | Validated against bounds; invalid input refused | **Settings don't persist on native yet** (no native preferences backend); haptics/notifications/fiat not available and shown as such |
| Account management | Wallets page explains both modes (`pages/account/wallets.tsx`) | Wallet → Wallet management: wallet type and capabilities, rename (saved per wallet type), Mode B disconnect / connect a different node with confirmation | — | — | 🟨 | Wallet → Management | Never mixes seeds or recovery models; Wavelength and remote node shown as different wallet types | One wallet per install: switching or several wallets not built (stated in the UI) |
| Privacy controls | Privacy page: connections disclosure, amount privacy, Tor status | Wallet → Privacy: external services disclosed (Ark operator, LNC mailbox), Tor "not supported", diagnostics "none collected", address-reuse note, hide balances, screen-capture protection setting | — | — | 🟨 | Wallet → Privacy | No anonymity claims | Screen-capture protection saved but no native module applies it yet |
| Backup status / verification | SCB export, seed guidance | Mode A: every word verified at creation; later "Check your written copy" against a slow salted verifier saved at backup or restore (phrase never stored, never shown again). Mode B: keys live on the node, stated | ⛔ SDK can't reveal the phrase again | — node-side | ✅ / — | Wallet → Security → Backup | Typed restore phrase and password cleared from state after restore | — |
| Network and connection status | Top bar, node overview | Wallet → Network: network (fixed per wallet, no switch), Ark operator reachability (A); alias, version, height, connection, sessions with revoke where the port supports it, network-mismatch warning (B) | ✅ | 🧪 sessions only if the port has `listSessions`/`revokeSession` (simulated port has neither) | ✅ / 🧪 | Wallet → Network | Revoke asks for confirmation | Real LNC adapter |

## B. Simplified mobile functionality

| Capability | Desktop | Mobile today | Wavelength backend | Remote LND via LNC | Status | Mobile UI | Security requirements | Plan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Funding Lightning / moving funds on-chain | Transfers FROM→TO registry offering only real rails (`pages/payments/transfers/routes.ts`) | **Transfers & swaps** (`ui/transfers/`, `flows/transfers.ts`): FROM→TO picker resolved by backend; Mode B Loop Out / Loop In in-app, invoice and deposit hand off to Send/Receive; Mode A hand-offs only; "another blockchain" says no cross-chain route | Hand-offs to Send/Receive (deposit, withdraw, pay, receive) | 🧪 Loop in-app; on-chain rails blocked (no on-chain methods on the port) | 🧪 | Wallet → Transfers & swaps | No bridges offered | Real LNC adapter |
| Loop In / Loop Out, swap monitoring | ✅ Loop pages; Loop Out and In verified on regtest through the wallet | Quote breakdown (swap fee incl. prepay, miner fee, routing cap from `@sovereign/liquidity`), limits sent as desktop (prepay = quoted, miner ×2, routing caps), approve `{amountSat, maxTotalFeeSat}`, re-quote refusal, device authorization via the app lock, progress, receipt, history, failure explanations | — Wavelength has no Loop (stated) | 🧪 simulated loopd only (states progress over time; real failure and refund paths) | 🧪 | Transfers & swaps, swap history | PIN/biometric before submit when a PIN is set | Real LNC adapter for loopd (terms, quotes, LoopOut/LoopIn with limits, ListSwaps, SwapInfo) |
| Liquidity availability and warnings | Liquidity overview, inbound/outbound | **Liquidity** (`ui/liquidity/`, `flows/liquidity.ts`): spendable, receiving capacity, per-channel bars, plain-language warnings, recommendations (low inbound → Loop Out, low outbound → Loop In) prefilled into the swap flow; Mode A explains it has no channels and shows spendable / in-flight / deposits / expiring | ✅ Wavelength availability semantics | 🧪 `listChannels` on the simulated port; falls back to `getBalances` channels | 🧪 | Wallet → Liquidity; Home receiving-capacity line | — | Home does not yet use `liquidityAttention()` for pending-swap and low-liquidity notices |
| Wallet connections (LNC sessions) | Library only (`services/litd-adapter/src/lnc-sessions.ts`); desktop UI says not available | Pairing with a 10-word phrase; revoked-session screen. `revokeCurrentSession` exists in the controller, no button | — | Optional `listSessions` / `revokeSession` on the port; the simulated port has neither | 🟨 | Pairing screen | Phrase used once and cleared; never persisted | Session screen when the port offers the methods (capabilities already detect them) |
| Taproot Assets | ✅ list, receive, send, history | **Assets** (`ui/assets/`, `flows/assets.ts`): list, detail, receive (address + QR), send (decode → review → send), transfer history; issuer unverified unless verified, stablecoin look-alikes flagged | ⛔ not supported by Wavelength (stated) | 🧪 simulated tapd only | 🧪 | Wallet → Assets | Unverified assets never shown as trusted or redeemable | Real LNC adapter for tapd; `LNC_REMOTE_DECLARATION.assets` still `'none'` in wallet-core |
| Ark exit and recovery information | Exit not wired on desktop | Home VTXO notice (expiring / exiting / at-risk) and "How this wallet works" disclosures | `exitReadiness`, `exitPlan`, `startUnilateralExit` (requires `FORCE_UNROLL_ACK`), `exitSummary`, `exitStatusFor` — not in `ModeAProviderPort` | — | 🟦 | Home, How this wallet works | Irreversible: typed acknowledgement, fee preview from `getExitPlan` | Add exit methods to `ModeAProviderPort`, read-only exit summary first |

## C. Desktop-priority functionality

| Capability | Desktop | Mobile today | Wavelength backend | Remote LND via LNC | Status | Mobile UI | Security requirements | Plan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Channel open / close / force close | Channels page | Desktop-only by rule: `LIVENESS_REQUIRED_OPS` + `DESKTOP_ONLY_DISCLOSURE` (`modeBRemoteController.ts`) | — | Deliberately not exposed | ⛔ by design | Notice on Home and Wallet | Needs a continuously connected node | Status only |
| Full node configuration, daemon management | Node overview, settings | ⬜ | — | — | ⛔ by design | — | — | Status only |
| Pool auctions and orders | Read-only market, accounts, orders | ⬜ | — | — | ⛔ by design | — | — | None |
| Routing analytics (Faraday) | Routing & analytics page | ⬜ | — | — | ⛔ by design | — | — | None |
| Channel policy, peers | Editors and peer list | ⬜ | — | — | ⛔ by design | — | — | None |
| Debugging and logs | Developer tools page | ⬜ | — | — | ⛔ by design | — | Logs must never carry secrets | None |

## Mobile foundation (this branch)

What later mobile work builds on. All in `apps/mobile/src`.

| Piece | Where | Notes |
| --- | --- | --- |
| Five primary tabs, per-tab stacks | `flows/navigation.ts`, `ui/navigationUi.tsx` | Home, Activity, Send, Receive, Wallet in both modes. Switching tabs keeps each stack and draft; re-tapping a tab pops to its root; back pops, then returns to Home; Android hardware back via `useHardwareBack` |
| Bottom sheet | `ui/Sheet.tsx` | Modal; Close button, backdrop, Android back, Escape on web; `dismissable={false}` for in-flight payments |
| Capability model | `flows/capabilities.ts` | `wavelengthCapabilities()` and `remoteLndCapabilities()`; every unavailable feature has a reason; controllers expose `walletCapabilities()` |
| Preferences | `flows/preferences.ts` | Versioned schema (v1) with migrations table, strict `set`, lenient load; memory and web backends; `NativePreferencesBackend` slot |
| Device services | `flows/platform.ts` | `PlatformServices` (clipboard, share, scanner, haptics, keystore, biometrics, screen capture, bottom inset); none wired natively |
| QR code | `ui/qr.ts`, `ui/QrCode.tsx` | `qrcode-generator@1.4.4` (same as desktop), 4-module quiet zone, accessible label, selectable text, Copy only when a clipboard exists |
| Formatting | `ui/format.ts`, `ui/appContext.tsx` | Exact sats/BTC formatting and input parsing, privacy masking, `useAmountFormatter()` |

## Remaining gaps

1. **Native resolvers.** No Wavelength client resolver (SDK React Native
   bindings) and no LNC port adapter over `@lightninglabs/lnc-rn` are wired in
   `index.js`, so native builds show "Native shell not configured". Until
   they are, no flow runs on a device.
2. **Durable payment intents.** Both modes use `InMemoryPaymentIntentStore`;
   crash-safe reconciliation does not survive an app restart on mobile.
3. **Native preferences storage.** `NativePreferencesBackend` is an interface
   only (no AsyncStorage/MMKV dependency). Native builds keep preferences in
   memory for the session.
4. **Keystore / Keychain and biometrics on a device.** The app lock is
   built (`flows/appLock.ts`) with a native `SecureStoragePort` over
   `react-native-keychain` 10.0.0 (`src/native/`), but nothing native has run:
   the CI `android-dev-build` / `ios-dev-build` jobs must link it, and a
   device must confirm the biometric prompt, `crypto.getRandomValues` on
   Hermes (the salt falls back to time + `Math.random` without it) and scrypt
   timing. The iOS Keychain survives uninstall, so a forgotten PIN with no
   backup record needs an app-data reset.
5. **QR scanning.** No camera scanner module (`scanQrCode`). Send shows a
   "Scan QR code" button as soon as the host injects one; until then it shows
   the reason and accepts pasted text (invoice, `lightning:`, address, BIP21).
6. **Clipboard and share on native.** React Native core has no clipboard API;
   the web preview injects `navigator.clipboard`. The system share sheet is not
   wired into `PlatformServices`.
7. **Safe areas.** No safe-area module; the host passes `bottomInset`
   (default 0, the tab bar pads at least 8pt). Top insets are not handled.
8. **Haptics and screen-capture protection.** No native modules.
9. **Remote LND port gaps.** On-chain balance detail, receive address and
   send; route-fee estimate; amountless-invoice payment (no amount field);
   invoice-paid subscription (Receive polls `listLightningActivity`); and a
   real lnc-rn adapter that passes `feeLimitSat` / `timeoutSeconds` /
   `expirySeconds` (only the simulated port implements them today). Invoices
   are decoded on the phone (`flows/destination.ts`); the node signature is
   not verified there — the node checks it when paying.
10. **Wavelength gaps.** The SDK accepts no invoice expiry and no on-chain fee
    rate (only `maxFeeSat`), so those preferences cannot apply in Mode A. Exit
    methods exist on the provider but not on `ModeAProviderPort`.
11. **Fiat values.** No exchange-rate source; the `fiatCurrency` preference
    exists but nothing shows fiat.
12. **Light or system theme.** Only the dark palette exists
    (`packages/ui/src/tokens.ts`); `theme: 'system'` is stored but has no effect.
13. **One wallet per install.** Switching wallets, several wallets, and
    changing wallet type in the app are not built; the Wallet tab says so.
14. **Device testing.** No Android SDK or Xcode in the sandbox; screens are
    verified headless (vitest + react-native-web) and by preview screenshots.
15. **Remote-node money features run only on the simulated port.** Liquidity,
    Loop (terms, quotes, LoopOut/LoopIn with limits, ListSwaps, SwapInfo) and
    Taproot Assets (ListAssets, transfers, NewAddr, DecodeAddr, SendAsset)
    need a real lnc-rn adapter and a session macaroon that permits loopd and
    tapd calls.
16. **Mode A preview never settles payments.** The simulated Wavelength
    client leaves sends pending, so the preview shows "result isn't known
    yet"; settled and failed receipts are covered by tests that settle the
    simulated payment.
