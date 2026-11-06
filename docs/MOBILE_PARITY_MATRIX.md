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
| Bitcoin send | Advanced: fee rate, review, txid (✅). Everyday: `quoteOnchain` review | Mode A: address + amount → live quote → review (amount, service fee) → confirm through `PaymentEngine` → reconcile | `quoteOnchain` + `WavelengthPaymentDispatcher`; fee cap `maxFeeSat` only — `SendRequest` has no fee rate or confirmation target | ⛔ port has no `sendCoins` / `estimateFee`. Possible: LND `SendCoins`, `EstimateFee` | Mode A ✅ 🧪 · Mode B ⛔ | Send tab | Review before confirm with the quoted fee; persist-before-dispatch | Mode B port extension; Mode A total row |
| Bitcoin receive | Advanced: address, QR, `bitcoin:` URI, deposit detection | Mode A: fresh boarding address, **new** QR (`bitcoin:` URI) with copy fallback | `depositOnchain()` ✓ | ⛔ port has no `newAddress`. Possible: LND `NewAddress` | Mode A ✅ 🧪 · Mode B ⛔ | Receive tab | Address reuse: a new address per tap | Deposit detection via activity; Mode B port extension |
| Lightning send | Advanced: decode → review with fee cap → pay → fee and preimage | Mode A: invoice → swap quote with service fee → confirm → in-flight → reconcile. Mode B: paste BOLT11 → pay; no decode or review; app must be in the foreground | `quoteLightning` (+ `maxFeeSat`) ✓ | `payInvoice({ bolt11, timeoutSeconds: 60 })`; no decode, no fee limit (`LncPaymentDispatcher`) | Mode A ✅ 🧪 · Mode B 🟨 🧪 | Send tab | Review step with real fee before confirm (Mode B lacks it); foreground-only dispatch on Mode B | Mode B: add `decodePayReq` and a fee limit to the port, then a review step |
| Lightning receive | Advanced: invoice, QR, live "received" | Mode A: amount → swap invoice → **new** QR (`lightning:`). Mode B: amount → `addInvoice` → **new** QR | `receiveLightning(amountSat, memo)`; `ReceiveRequest` has no expiry | `addInvoice({ valueSat, memo })`; no expiry, no settle notification | ✅ 🧪 | Receive tab | — | Mode B: invoice subscription for "paid" state |
| Payment history | Advanced: payments, invoices, swaps, on-chain merged; search, filters, detail sheets. Everyday: none | Mode A: one page of `activityHistory()`. **New** Mode B: Lightning payments and invoices via optional `LncRpcPort.listLightningActivity`; a port without it shows "not available over this connection" | `activityHistory()` (SDK `list`, one page, `limit/offset/cursor` available in `ListRequest`) | **New** optional `listLightningActivity({ maxItems })`; implemented by the simulated port only. Possible: LND `ListPayments` + `ListInvoices` (+ `GetTransactions` for on-chain) | 🟨 🧪 | Activity tab | Local history privacy (mask in privacy mode) | Paging, filters, search; real lnc-rn adapter for the new method |
| Transaction details / receipts | Detail sheets with timeline, fees, ids | ⬜ — rows only | Entry fields via `mapEntryToRecord` | Record carries hash, fee, memo, request | ⬜ | Foundation ready: `Sheet` (`src/ui/Sheet.tsx`) and stack push with params | Never show preimages or secrets in shareable receipts | Receipt sheet from Activity rows |
| Fee previews | `Breakdown` with real quotes | Mode A: service fee row in review. Mode B: none — "routing fee is not quoted beforehand" | `expectedFeeSat` from the quote ✓ | ⛔ no route-fee estimate in the port. Possible: `EstimateRouteFee` / `QueryRoutes` | Mode A ✅ · Mode B ⛔ | Send tab | — | Mode A total row; Mode B port extension |
| Payment status | Toasts, status views | Mode A: in-flight warning + "Check payment status" reconcile. Mode B: sending / sent / failed | Engine reconcile via `lookup` ✓ | `lookupPayment` (sim returns `unknown`) | 🟨 🧪 | Send tab | Persist-before-dispatch **only in memory**: both modes use `InMemoryPaymentIntentStore` (`src/App.tsx`, `modeBRemoteController.ts`), so an app kill loses the intent | SQLCipher/keystore-backed intent store on device |
| Wallet security (PIN, biometrics, auto-lock) | "App lock isn't available in this build" (`pages/account/security.tsx`) | ⬜. **New:** capability rows say why (`appLock`, `biometricUnlock`), `lockTimeoutSeconds` preference stored | — | — | ⬜ | Wallet tab shows the reason | iOS Keychain / Android Keystore; PIN hash only in the keystore; biometric prompt | `SecureStoragePort` + biometric service in the native shell (`src/flows/platform.ts`) |
| Wallet preferences | Settings page (`pages/account/settings.tsx`) | **New:** `PreferencesStore` with versioned schema and validation: denomination, hide balances, haptics, theme, invoice expiry, on-chain fee preference, max Lightning fee (ppm + sat floor), payment timeout, lock timeout, fiat currency. Web preview persists to localStorage; native has no backend yet (in-memory) | Honoured: Lightning fee cap (`maxFeeSat`), payment timeout (dispatcher timeout, read at start). Not honoured by SDK: invoice expiry, on-chain fee rate | None honoured by the port today (fee limit, expiry, timeout fixed at 60 s) | 🟨 | No settings UI yet | Preferences hold no secrets | Settings screens that show each value with its capability reason |
| Account management | Wallets page explains both modes (`pages/account/wallets.tsx`) | Mode chosen by the host at launch (`mode` prop); no switching or renaming in the app | One wallet per data dir | One pairing per launch; phrase never stored | ⬜ | — | Never mix seeds or recovery models across modes (`assertSeedCompatible`) | Wallet list in the Wallet tab |
| Privacy controls | Privacy page: connections disclosure, amount privacy, Tor status | Hide-balances preference and masking; no screen-capture protection, no Tor | Ark operator and swap service see payments (declared disclosures) | LNC mailbox relays encrypted traffic | 🟨 | — | Disclosures shown verbatim from declarations | Privacy section in Wallet tab |
| Backup status / verification | SCB export, seed guidance | Mode A verifies every word at creation only | — | — (node-side) | 🟨 | Onboarding | — | Re-verify later from Wallet tab |
| Network and connection status | Top bar, node overview | Mode A: network + Ark operator reachability. Mode B: alias, version, block height, revoked-session screen | `walletInfo().serverConnected` | `getInfo()`; `revoked` connection event | ✅ 🧪 | Home, Wallet | Reconnection needs a fresh pairing phrase | Reconnect flow |

## B. Simplified mobile functionality

| Capability | Desktop | Mobile today | Wavelength backend | Remote LND via LNC | Status | Mobile UI | Security requirements | Plan |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Funding Lightning / moving funds on-chain | Transfers FROM→TO registry offering only real rails (`pages/payments/transfers/routes.ts`) | ⬜ | Boarding deposit (`depositOnchain`) and on-chain send (`quoteOnchain`) are the on/off ramps | ⛔ none in the port. Possible: `SendCoins`, Loop | ⬜ | — | Review with real quote, device authorization | Transfers screen under Wallet with backend-specific routes |
| Loop In / Loop Out, swap monitoring | ✅ Loop pages; Loop Out and In verified on regtest through the wallet | ⬜ | — Wavelength uses its own swap service, not Loop | ⛔ not in the port. Possible: litd exposes Loop over the same LNC session when the session's macaroon allows it (not verified in this repo) | ⬜ | Wallet tab says why (`loopSwaps`) | Quote → review with every fee → `maxTotalFeeSat` authorization, as desktop | Port methods for terms/quote/swap/list, then a read-only monitor first |
| Liquidity availability and warnings | Liquidity overview, inbound/outbound | Mode B shows channel count only | — no channels; liquidity is the swap service's | `channels[]` carries `localSat` / `remoteSat` / `capacitySat`, so inbound is computable but not shown | 🟦 (Mode B) | — | — | "Can receive up to …" from `remoteSat` on Mode B |
| Wallet connections (LNC sessions) | Library only (`services/litd-adapter/src/lnc-sessions.ts`); desktop UI says not available | Pairing with a 10-word phrase; revoked-session screen. `revokeCurrentSession` exists in the controller, no button | — | Optional `listSessions` / `revokeSession` on the port; the simulated port has neither | 🟨 | Pairing screen | Phrase used once and cleared; never persisted | Session screen when the port offers the methods (capabilities already detect them) |
| Taproot Assets | ✅ list, receive, send, history | ⬜ | ⛔ declared `assets: 'none'` | ⛔ not in the port; `LNC_REMOTE_DECLARATION` declares `assets: 'none'`. Possible: tapd over litd LNC | ⬜ | Wallet tab says why | Never present unverified assets as trusted | Read-only asset list first, behind a declaration change |
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
4. **Keystore / Keychain, app PIN, biometrics, lock timeout.** No
   `SecureStoragePort` implementation or biometric prompt; the
   `lockTimeoutSeconds` preference is stored but nothing enforces it.
5. **QR scanning.** No camera scanner module (`scanQrCode`); Send accepts
   pasted text only.
6. **Clipboard and share on native.** React Native core has no clipboard API;
   the web preview injects `navigator.clipboard`. The system share sheet is not
   wired into `PlatformServices`.
7. **Safe areas.** No safe-area module; the host passes `bottomInset`
   (default 0, the tab bar pads at least 8pt). Top insets are not handled.
8. **Haptics and screen-capture protection.** No native modules.
9. **Remote LND port gaps.** On-chain balance detail, receive address and
   send; invoice decode; route-fee estimate; fee limit; invoice expiry;
   invoice-paid subscription; Loop; Taproot Assets; and a real adapter for the
   new `listLightningActivity`.
10. **Wavelength gaps.** The SDK accepts no invoice expiry and no on-chain fee
    rate (only `maxFeeSat`), so those preferences cannot apply in Mode A. Exit
    methods exist on the provider but not on `ModeAProviderPort`.
11. **Fiat values.** No exchange-rate source; the `fiatCurrency` preference
    exists but nothing shows fiat.
12. **Light or system theme.** Only the dark palette exists
    (`packages/ui/src/tokens.ts`); `theme: 'system'` is stored but has no effect.
13. **Settings, transfers, receipts, assets, sessions screens.** The
    foundation (stacks, sheets, capabilities, preferences) is in place; the
    screens are not.
14. **Device testing.** No Android SDK or Xcode in the sandbox; screens are
    verified headless (vitest + react-native-web) and by preview screenshots.
