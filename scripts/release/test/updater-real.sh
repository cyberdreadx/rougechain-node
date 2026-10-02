#!/usr/bin/env bash
# Runs INSIDE a throw-away container (started by ../test-updater.sh with REAL_BINARY + REAL_CLI).
# The REAL node, updated by the REAL updater, health-checked against the REAL network:
#   1. install the real node binary as a test-signed release "1.6.0" (its CLI has no
#      `release verify`), default peer = the public mainnet node;
#   2. start it (stand-in systemctl → the unit's ExecStart as the service user) and let it sync
#      from mainnet — read-only requests; the node has no --public-url and does not --mine;
#   3. `rougechain-update run --now` to a test-signed "1.6.1": the same program with one byte
#      appended + a CLI that has `release verify`;
#   4. the updater verifies ML-DSA-65 with the new CLI, restarts the node and runs its health
#      check against https://api.rougechain.io: chain id, upgrade schedule (the real manifest's
#      activation list), same block + state root as mainnet, not behind.
set -uo pipefail

WEB="${WEB:?}"
LOG=/tmp/real.log
PASS=0
FAIL=0
TEST_ENV=(ROUGECHAIN_INSTALLER_TEST=1 ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem
  ROUGECHAIN_INSTALLER_TEST_MLDSA_PUBKEY_FILE=/ctx/keys/release-mldsa65.pub)
RUN_PATH=/ctx/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BIN=/usr/local/bin/quantum-vault-daemon
CLI=/usr/local/bin/rougechain
CONF=/etc/rougechain/mainnet
MAINNET=https://api.rougechain.io/api
LOCAL=http://127.0.0.1:5100/api

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; if [ -s "$LOG" ]; then sed 's/^/        | /' "$LOG" | tail -n 40; fi; }
check() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
sha() { sha256sum "$1" | cut -d ' ' -f 1; }
stat_of() { curl -fsS --max-time 10 "$1/stats" 2> /dev/null | jq -r "$2" 2> /dev/null; }

export DEBIAN_FRONTEND=noninteractive
{ apt-get update -qq || { sleep 10; apt-get update -qq; }; } > /tmp/apt.log 2>&1
apt-get install -y -qq --no-install-recommends curl ca-certificates openssl jq > /tmp/apt.log 2>&1 || { cat /tmp/apt.log; echo "could not install prerequisites"; exit 1; }
mkdir -p /run/systemd/system

env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" RELEASE_BASE_URLS="$WEB/rel/real-1.6.0" NODE_NAME=updater-real-test \
  bash /src/install-validator.sh > "$LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then ok "real node 1.6.0 installed and started by the installer"; else bad "install of the real node (exit $RC)"; fi
check "its CLI (as shipped with 1.6.0) has no 'release verify' → ML-DSA-65 not verified at install" bash -c "! $CLI release verify --help && grep -q 'ML-DSA-65 signature present; not verified yet' $LOG"
check "the node key is a real ML-DSA-65 key, 0600" bash -c "test \"\$(jq -r '.public_key_hex | length' /var/lib/rougechain/mainnet/node-keys.json)\" = 3904 && test \"\$(stat -c %a /var/lib/rougechain/mainnet/node-keys.json)\" = 600"
check "auto-update set up: updater, command, timer enabled" bash -c "test -x /usr/local/bin/rougechain-update && grep -qx 'enable --now rougechain-update.timer' /run/fake-systemd/calls.log"

NET_H="$(stat_of "$MAINNET" .network_height)"
echo "real: mainnet is at height ${NET_H:-?}"
synced=0
for _ in $(seq 1 100); do
  H="$(stat_of "$LOCAL" .network_height)"
  NET_H="$(stat_of "$MAINNET" .network_height)"
  if [ -n "${H:-}" ] && [ -n "${NET_H:-}" ] && [ "$H" = "$NET_H" ]; then synced=1; break; fi
  sleep 3
done
: > "$LOG"
if [ "$synced" = 1 ]; then ok "the real node synced from mainnet to its tip (height $H)"; else tail -n 30 /var/log/fake-node.log > "$LOG"; bad "the real node did not reach the mainnet tip (local ${H:-?}, mainnet ${NET_H:-?})"; fi
check "same state root as the public node at that height" test "$(stat_of "$LOCAL" .state_root)" = "$(stat_of "$MAINNET" .state_root)"
OLD_SHA="$(sha $BIN)"

sed -i "s|^RELEASE_BASE_URLS=.*|RELEASE_BASE_URLS=$WEB/rel/real-1.6.1|" "$CONF/update.conf"
START="$(date +%s)"
env -i PATH="$RUN_PATH" HOME=/root "${TEST_ENV[@]}" /usr/local/bin/rougechain-update run --now > "$LOG" 2>&1
RC=$?
echo "real: rougechain-update run --now took $(($(date +%s) - START))s, exit $RC"
sed 's/^/real: | /' "$LOG"
if [ "$RC" -eq 0 ]; then ok "rougechain-update run: exit 0"; else bad "rougechain-update run (exit $RC)"; fi
check "release 1.6.1 is installed; the binary was replaced; .prev is the 1.6.0 binary" test "$(jq -r .version $CONF/manifest.json)" = "1.6.1" -a "$(sha $BIN)" != "$OLD_SHA" -a "$(sha $BIN.prev)" = "$OLD_SHA"
check "ML-DSA-65: not verifiable before (old CLI), verified with the CLI of the new release before the restart" bash -c "grep -q 'ML-DSA-65 signature present; not verified yet' $LOG && grep -q 'signature OK (ML-DSA-65 release key .*checked with the CLI of this release)' $LOG"
check "the node was restarted exactly once" test "$(grep -c '^restart rougechain-validator' /run/fake-systemd/calls.log)" = 1
check "REAL health check passed against public mainnet (chain id, schedule, same block + state, not behind)" grep -qE "UPDATE OK: release 1\.6\.1 is installed \(was 1\.6\.0\) — healthy: agrees with $MAINNET \(local height [0-9]+, reference [0-9]+, same block and state\)" "$LOG"
check "the upgrade schedule of the real node matches the real manifest's activations (canonical_ledger_fork is not reported by the node)" bash -c "curl -fsS $LOCAL/stats | jq -e '.upgrade_schedule.token_minting == 235 and .upgrade_schedule.payable_calls == 190 and (.upgrade_schedule | has(\"canonical_ledger_fork\") | not)'"
check "the node is up after the update, on mainnet's chain id, at the mainnet tip" bash -c "test \"\$(curl -fsS $LOCAL/health | jq -r .chain_id)\" = rougechain-mainnet-1 && test \"\$(curl -fsS $LOCAL/stats | jq -r .network_height)\" = \"\$(curl -fsS $MAINNET/stats | jq -r .network_height)\""
check "the installed CLI now verifies the installed manifest's ML-DSA-65 signature" bash -c "printf '%s\n' \"\$(grep -v '^#' /ctx/keys/release-mldsa65.pub)\" > /tmp/k.pub && $CLI release verify --manifest $CONF/manifest.json --sig $CONF/manifest.json.mldsa65.sig --pubkey /tmp/k.pub"
env -i PATH="$RUN_PATH" HOME=/root /usr/local/bin/rougechain-update status > "$LOG" 2>&1
sed 's/^/real: | /' "$LOG"
check "status: installed 1.6.1, last update healthy" bash -c "grep -qE 'installed release +1\.6\.1' $LOG && grep -qE 'last update .*1\.6\.0 -> 1\.6\.1: healthy' $LOG"
# The REAL published release, checked by the updater with the PRODUCTION keys embedded in it (no
# test variables): both sources serve the signed 1.6.0 manifest; its Ed25519 signature (OpenSSL)
# and its ML-DSA-65 signature (the CLI installed above) must verify — and, being older than the
# installed "1.6.1", it must be ignored.
sed -i "s|^RELEASE_BASE_URLS=.*|RELEASE_BASE_URLS=|" "$CONF/update.conf"
env -i PATH="$RUN_PATH" HOME=/root /usr/local/bin/rougechain-update check > "$LOG" 2>&1
RC=$?
sed 's/^/real: | /' "$LOG"
if [ "$RC" -eq 0 ]; then ok "updater with the production keys, real release sources: exit 0"; else bad "updater against the real release sources (exit $RC)"; fi
check "the real signed manifests from api.rougechain.io AND the GitHub mirror pass both signature checks (embedded production keys)" bash -c "! grep -q 'TEST MODE' $LOG && ! grep -q 'SIGNATURE CHECK FAILED' $LOG && test \"\$(grep -c 'serves release 1.6.0, OLDER than the installed 1.6.1' $LOG)\" = 2"
check "…and the older release is ignored: nothing to install" bash -c "grep -q 'up to date: release 1.6.1 is installed, the newest signed release is 1.6.0' $LOG && test \"\$(jq -r .version $CONF/manifest.json)\" = 1.6.1"
curl -fsS https://api.rougechain.io/releases/manifest-mainnet.json -o /tmp/real-manifest.json && curl -fsS https://api.rougechain.io/releases/manifest-mainnet.json.mldsa65.sig -o /tmp/real-manifest.sig
sed -n 's/^RELEASE_MLDSA65_PUBKEY_HEX="\(.*\)"$/\1/p' /usr/local/lib/rougechain/install-validator.sh > /tmp/prod.pub
check "the installed CLI verifies the live 1.6.0 manifest with the production ML-DSA-65 key embedded in the updater" bash -c "$CLI release verify --manifest /tmp/real-manifest.json --sig /tmp/real-manifest.sig --pubkey /tmp/prod.pub"
check "…and rejects the test-signed manifest with that key" bash -c "! $CLI release verify --manifest $CONF/manifest.json --sig $CONF/manifest.json.mldsa65.sig --pubkey /tmp/prod.pub"

stray="$(find / -xdev -user rougechain -not -path '/proc/*' -not -path '/var/lib/rougechain/*' -not -path /var/lib/rougechain 2> /dev/null | head -n 5)"
check "the node wrote nothing outside its data directory" test -z "$stray"

PATH="$RUN_PATH" systemctl stop rougechain-validator > /dev/null 2>&1 || true
printf '\nreal node: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
