# Advanced wallet platform (desktop, litd)

The advanced wallet UI once the node is ready. Lifecycle gates (create,
restore, unlock) stay in `../modeb/ModeBApp.tsx`.

## Files you share (do not edit from a page workstream)

| File | What it is |
| --- | --- |
| `api.ts` | `PlatformApi`: typed client for every bridge route. Core LND routes are on `api.bridge` (`BridgeClient`: `walletBalance()`, `channels()`, `payments(max)`, `newAddress(type)`, `estimateFee(...)`, `sendCoins(...)`, `openChannel(...)`, `closeChannel(...)`, `closeJob(id)`, `createInvoice(...)`, `decodeInvoice(...)`, `payInvoice(...)`, `diagnostics()`, `exportChannelBackups()`, `restoreChannelBackups(hex)` — read `../modeb/bridge-client.ts` for exact signatures) |
| `context.tsx` | `usePlatform()` → `{ api, bridge, node, services, toast, refreshKey, bumpRefresh }`; `usePrefs()` → `{ unit, hideAmounts, set }`; `usePoll(fn, intervalMs, deps)`; `useService('loop'\|'pool'\|'taproot-assets'\|'faraday')` |
| `ui.tsx` | Component kit (below). Every amount goes through `<Amount>` |
| `balances.ts` | `computeAccounts(walletBalance, channels, poolAccounts)` + `fundSegments(accounts)`. The ONLY balance math. Never add balances yourself |
| `router.tsx` | Route registry, `Link`, `navigate`, `useLocation` (hash routes; sub-paths like `/loop/out` resolve to the `/loop` page, which reads `useLocation()` for its sub-view) |
| `shell.tsx`, `platform.css` | Shell + all styles |

If a page needs a component the kit lacks, add it in your own page folder
(e.g. `pages/liquidity/components/SwapRow.tsx`). Page-specific CSS goes in
`pages/<group>/<group>.css`, using only `--sovl-*` tokens and `.p-*` classes
as building blocks. Never hard-code a color.

## Component kit (`ui.tsx`)

`Icon` · `Amount` (sats/BTC + privacy) · `formatSats` · `LiquidityBar` +
`FUND_LABEL` (segments: `onchain`, `outbound`, `inbound`, `locked`) ·
`PageHeader` · `Panel` (title, note, actions, flush) · `Stat` · `Badge`
(tone) · `Notice` (info/warning/danger/positive) · `Empty` · `Skeleton` ·
`Field` (render-prop id) · `Segmented` · `CopyField` · `QrCode` · `Sheet`
(slide-over, Esc closes) · `Timeline` · `Steps` · `Breakdown` (fee rows +
total) · `relativeTime` · `shortId`.

Layout classes: `.p-grid` + `.p-span-{3,4,5,6,7,8,12}`, `.p-stack`, `.p-row`,
`.p-spread`. Controls: `.p-btn` (`-primary`, `-ghost`, `-danger`, `-sm`,
`-icon`), `.p-input`, `.p-select`, `.p-textarea`, `.p-input-affix`, `.p-check`,
`.p-tabs`. Tables: `.p-table-wrap > table.p-table` (`.p-num` for amounts,
`tr[data-clickable]`). Text: `.p-mono` (ids, addresses, invoices only),
`.p-muted`, `.p-faint`, `.p-hint`.

## Product rules (non-negotiable)

1. **Real data only.** Every number comes from a bridge response. No sample
   rows, no invented fees, no fake charts. Loading → `Skeleton`; failure →
   `Notice tone="danger"` with the bridge's error text and a retry.
2. **Honest unavailability.** If a service or operator is down (see
   `useService`, `services.data.operators.loop.mode === 'offline'`), say
   exactly that and why, and what would make it available. Never show a
   disabled button without saying why it is disabled.
3. **Money-moving actions** use a review step that shows source,
   destination, amount, every fee from a real quote, total cost, amount
   received, timing, dependencies and risks, then a final confirm. Loop
   swaps send `authorization: { amountSat, maxTotalFeeSat }` (the bridge
   re-quotes and refuses if fees rose). After success: `toast(...)`,
   `bumpRefresh()`, and a status view.
4. **Copy:** sentence case, plain verbs, no all-caps labels, no "→" in
   buttons, errors say what happened and how to fix it. A button keeps its
   name through the flow ("Start Loop Out" → toast "Loop Out started").
5. **Layout:** use the width. Desktop-dense, no single small card in a big
   empty area. Detail views open in a `Sheet` rather than a new page.
6. **Accessibility:** every control labeled (use `Field`), keyboard
   reachable, status changes in text not color alone.
7. **Types:** strict TS, no `any`, no `as never`, no unchecked casts.

## Verify your pages

- Live node: bridge at `127.0.0.1:8791`, app at the URL in
  `/home/claude/stack/app-url` (dev server on port 5180, hot reload).
  Bridge calls from a shell: `/home/claude/stack/api.sh GET /channels`.
- Screenshot: `cd /home/claude/stack && NODE_GLOBAL=$(npm root -g) node shot.mjs '<hash path>' <out.png>`
  (prints page text + console errors; `FULL=1` for full page). Look at
  every screenshot you take and fix what you see.
- Regtest helpers: `/home/claude/stack/btcctl generate N` mines;
  `/home/claude/stack/alice-cli ...` is the peer LND (pubkey via
  `alice-cli getinfo`, P2P `127.0.0.1:19735`).
- `cd /home/claude/sw/apps/desktop && pnpm exec tsc --noEmit` and
  `cd /home/claude/sw && pnpm lint` must pass.
