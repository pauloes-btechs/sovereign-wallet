# Security Review — Privacy & Security Hardening

Adversarial review pass over the security surface built in this task: the
fail-closed egress policy engine, Tor transport, loopback-only sidecar
enforcement, SQLCipher-at-rest storage with platform keyring, durable
payment-intent store, and the wallet-owned destination parser and fuzz
harnesses.

Method: threat-model walkthrough of trust boundaries (untrusted destination
strings, remote gateway JSON, sidecar listen arguments, stored intent data,
disk/egress channels), targeted code review of each boundary, and
deterministic fuzzing of every wallet-owned parser.

## Findings and triage

### F-1 — bech32 variant discriminant rejected all valid strict-variant decodes (CRITICAL, FIXED)

`bech32Decode` returned the numeric checksum constant (1 / 0x2bc830a3) as the
`variant` field instead of the `'bech32' | 'bech32m'` discriminant. Every
caller comparing `variant !== 'bech32'` — including `segwitAddressDecode` and
invoice decoding — rejected cryptographically valid input. Fail-closed (no
invalid input was accepted), but it broke the BIP-173 canonical vector.

**Fix:** the decoder maps the checksum constant to its variant string;
BIP-173 and BIP-350 vectors now pass. Evidence: `destinations.test.ts`
(canonical P2WPKH vector, taproot bech32m round-trip).

### F-2 — uppercase addresses skipped on-chain dispatch (HIGH, FIXED)

The on-chain branch matched `/^([a-z]+)1/` — case-sensitive — so the
uppercase BIP-173 vector (`BC1Q…`) skipped on-chain parsing entirely and fell
through to "unknown". A UI pasting an uppercase address would have shown an
invalid-destination error for a valid address (fail-closed, but a correctness
defect that could train users to distrust paste validation).

**Fix:** case-insensitive dispatch with normalized HRP membership check.

### F-3 — witness program limit compared words to the byte bound (HIGH, FIXED)

`segwitAddressDecode` rejected any decode whose *word* count exceeded 40. A
32-byte program is 52 words, so every taproot (P2TR) address was rejected.
BIP-173 bounds the program at 2–40 **bytes**.

**Fix:** word-count check removed; byte limits enforced after 5→8-bit
conversion, plus the version-specific length rules (v0: 20/32 bytes, bech32;
v1–16: bech32m).

### F-4 — fuzz oracle noise: incorrect test expectation (LOW, FIXED)

The BOLT-11 amount test asserted 100 msat for a 100-nanoBTC invoice; 100
nanoBTC = 10 sat = 10,000 msat. The parser was correct; the test was not.

### F-5 — legacy base58check addresses unsupported (LOW, ACCEPTED RISK)

The wallet-owned destination parser covers SegWit bech32/bech32m only.
P2PKH/P2SH base58check inputs return `{ ok: false }` — fail-closed, never
misrouted. Sending to a legacy address will require explicit support work
(scope decision recorded here rather than silently assumed).

**Owner:** follow-up feature; not a security defect. Severity unchanged
unless a UI path silently strips or "fixes" rejected input — none exists
(rejection surfaces a typed reason).

### F-6 — desktop native encryption unverified until CI cargo runs (CRITICAL GATE, RESOLVED)

The Tauri Rust commands (keyring get/set/delete, SQLCipher
open/get/set/delete/list with fail-cipher checks) cannot be compiled locally —
no cargo toolchain in the sandbox. CI runs `cargo test` on the macOS/Windows
desktop matrix. **Merge gate:** those jobs must be green before merge;
production desktop encryption is unverified until then.

**RESOLVED 2026-10-31** at head 547ea71: all three desktop-artifacts jobs
(macos-latest, macos-15-intel, windows-latest) passed, including
`sqlcipher_engages_and_rejects_non_hex_keys` (`PRAGMA cipher_version` proves a
real SQLCipher build is engaged), `wrong_key_cannot_read_the_database`
(a different valid key cannot decrypt the file), and the per-platform
`keyring_round_trip_on_platform_store`. Two fixes landed en route: the
`DbRegistry` state was restructured to `Mutex`-guarded state (rusqlite's
`Connection` is `Send`, not `Sync`, so Tauri's managed state rejected it), and
keyring v3's `NoEntry` on deleting an already-absent credential is mapped to
success, matching the documented idempotent-delete contract.

### F-7 — egress instrumentation covers the patchable surface (MEDIUM, ACCEPTED WITH DISCLOSURE)

Node's ESM built-in `http` module namespace properties cannot be reassigned,
so the egress test instruments `globalThis.fetch` and
`net.Socket.prototype.connect` instead. Raw-socket instrumentation catches
every TCP egress regardless of the higher-level API (fetch, http/https
request, undici pools all bottom out in sockets), which is the property that
matters for the no-undisclosed-egress guarantee. The gap is DNS: with
`SOCKS5` hostname forwarding DNS goes through the proxy; direct transports
resolve via `dns` and are covered at the connect stage.

## Fuzz harness

Two deterministic suites, fixed seeds (`0x5eed1..3`), CI budget 100,000
iterations per seed (`FUZZ_ITERATIONS` env, 4× the local default of 25,000):

- `packages/wallet-core/src/destinations.fuzz.test.ts` — mutated-valid and
  random-printable corpora through `parseDestination`/`bech32Decode` with
  totality + canonicalization-stability oracles.
- `packages/privacy/src/listenargs.fuzz.test.ts` — hostile listen arguments
  through `parseHostPort`/`validateSidecarListenArgs`, typed-failure-only
  oracle.

CI job: `fuzz` in `.github/workflows/ci.yml`. A failure reproduces locally by
re-running with the same seed and a higher iteration budget.

## Remaining gates before merge

1. CI `fuzz` job green at the 100k budget (this PR).
2. Desktop matrix `cargo test` green — closes F-6 (this PR's CI).
3. Egress suite green — no network calls beyond disclosed endpoints (this
   PR's CI; re-verified on every PR touching runtime source).
