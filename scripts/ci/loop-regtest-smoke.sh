#!/usr/bin/env bash
# Real swap settlement on regtest against the source-built regtest Loop server
# (lightninglabs/loop PR #1222). Regtest only — never real funds.
#
# 1. Boots upstream's regtest topology (bitcoind, two lnd nodes, swap server,
#    aperture/L402, loopd) and waits for channels.
# 2. Checks the swap server answers terms and quotes in both directions.
# 3. Runs upstream's acceptance script, which performs a real Loop Out, a real
#    Loop In and a static-address deposit Loop In, mines what each protocol
#    needs, and fails on any FAILED state.
# 4. Asserts from loopd's own swap list that each swap type reached success.
set -Eeuo pipefail

REGTEST_DIR="${1:?usage: loop-regtest-smoke.sh /path/to/loop/regtest}"
cd "$REGTEST_DIR"

fail() { echo "::error::$*" >&2; exit 1; }
loop() { ./regtest.sh loop "$@"; }

echo "::group::Bootstrap upstream Loop regtest environment"
timeout 25m ./regtest.sh start || fail "Upstream regtest setup failed"
echo "::endgroup::"

echo "::group::Swap server terms and quotes"
loop terms || fail "Loop terms unavailable"
loop quote out 500000 || fail "Loop Out quote failed"
loop quote in 500000 || fail "Loop In quote failed"
echo "::endgroup::"

echo "::group::Real swaps (upstream regtest/e2e.sh)"
TIMEOUT_SECONDS=300 timeout 25m ./e2e.sh || fail "Upstream swap acceptance failed"
echo "::endgroup::"

echo "::group::Verify settled swaps"
listing="$(loop listswaps)" || fail "Cannot read Loop swaps"
echo "$listing" | jq .
for t in LOOP_OUT LOOP_IN; do
  ok="$(jq --arg t "$t" '[.swaps[]? | select(.type == $t and .state == "SUCCESS")] | length' <<< "$listing")"
  [[ "$ok" -ge 1 ]] || fail "No successful $t swap in loopd's swap list"
done
static="$(loop static listswaps)" || fail "Cannot read static-address swaps"
echo "$static" | jq .
[[ "$(jq '[.swaps[]? | select(.state == "SUCCEEDED")] | length' <<< "$static")" -ge 1 ]] \
  || fail "No successful static-address Loop In"
echo "::endgroup::"

echo "Real Loop Out, Loop In and static-address Loop In all settled on regtest."
