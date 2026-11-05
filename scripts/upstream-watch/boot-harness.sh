#!/usr/bin/env bash
# Boots the docker regtest harness exactly like the CI integration / Mode B
# e2e jobs (see .github/workflows/ci.yml), for the weekly upstream watch.
# Image tags come from SOVEREIGN_{LND,LITD,APERTURE}_IMAGE when set, else the
# pins in harness/regtest/docker-compose.yml. Requires SOVEREIGN_BTCD_BIN.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${SOVEREIGN_BTCD_BIN:?set SOVEREIGN_BTCD_BIN to the btcd binary (filter server)}"
compose=(docker compose -f harness/regtest/docker-compose.yml)

echo "harness images:"
"${compose[@]}" config --images

mkdir -p harness/regtest/data/bitcoind harness/regtest/data/lnd-alice \
  harness/regtest/data/lnd-bob harness/regtest/data/litd-lnd \
  harness/regtest/data/litd-lit harness/regtest/data/btcd \
  harness/regtest/data/btcd-log
chmod 0777 harness/regtest/data/bitcoind
"${compose[@]}" up -d --wait

for d in lnd-alice lnd-bob litd-lit; do
  sudo chown -R "$(id -u):$(id -g)" "harness/regtest/data/$d"
done
for _ in $(seq 1 90); do
  [ -f harness/regtest/data/litd-lnd/tls.cert ] && break
  sleep 2
done
if [ ! -f harness/regtest/data/litd-lnd/tls.cert ]; then
  echo "::error::litd embedded-LND tls.cert did not appear within 180s"
  "${compose[@]}" logs --tail=200
  exit 1
fi
sudo chown -R "$(id -u):$(id -g)" harness/regtest/data/litd-lnd

pnpm harness:bootstrap

for d in lnd-alice lnd-bob litd-lnd litd-lit; do
  sudo chown -R "$(id -u):$(id -g)" "harness/regtest/data/$d"
done
echo "harness up"
