#!/usr/bin/env bash
# Real settlement smoke test using upstream Loop regtest and regtest-only
# Lightning Labs swap server. Regtest only — never real funds.
set -Eeuo pipefail

REGTEST_DIR="${1:?usage: loop-regtest-smoke.sh /path/to/loop/regtest}"
cd "$REGTEST_DIR"

fail() { echo "::error::$*" >&2; exit 1; }
loop() { docker exec -i loopclient loop --network regtest "$@"; }

echo "::group::Bootstrap upstream Loop regtest environment"
timeout 20m bash ./regtest.sh start || fail "Upstream regtest setup failed"
echo "::endgroup::"

echo "::group::Swap server quote checks"
timeout 90s bash -c 'until docker exec -i loopclient loop --network regtest terms >/dev/null 2>&1; do sleep 3; done' || fail "Loop terms endpoint unavailable"
loop quote out 500000 || fail "Loop Out quote failed"
loop quote in 500000 || fail "Loop In quote failed"
echo "::endgroup::"

wait_for_settlement() {
  local direction="$1"
  local attempt listing total succeeded failed
  for attempt in $(seq 1 55); do
    listing="$(loop listswaps)" || fail "Cannot read Loop swaps for $direction"
    total="$(jq --arg direction "$direction" '[.swaps[]? | select(.type == $direction)] | length' <<< "$listing")"
    succeeded="$(jq --arg direction "$direction" '[.swaps[]? | select(.type == $direction and .state == "SUCCESS")] | length' <<< "$listing")"
    failed="$(jq --arg direction "$direction" '[.swaps[]? | select(.type == $direction and .state == "FAILED")] | length' <<< "$listing")"
    echo "$direction poll=$attempt count=$total succeeded=$succeeded failed=$failed"
    if [[ "$failed" -gt 0 ]]; then
      echo "$listing" >&2
      fail "$direction failed"
    fi
    if [[ "$total" -eq 1 && "$succeeded" -eq 1 ]]; then
      echo "$listing" | jq .
      return 0
    fi
    bash ./regtest.sh mine 1 || fail "Unable to mine regtest block"
    sleep 5
  done
  loop listswaps || true
  fail "$direction did not reach SUCCESS within polling limit"
}

echo "::group::Real Loop Out"
loop out --amt 500000 --fast --force || fail "Loop Out initiation failed"
wait_for_settlement LOOP_OUT
echo "::endgroup::"

echo "::group::Real Loop In"
loop in --amt 500000 --force || fail "Loop In initiation failed"
wait_for_settlement LOOP_IN
echo "::endgroup::"

echo "Both real Loop swaps reached SUCCESS on regtest."
