#!/usr/bin/env bash
# Runs INSIDE a throw-away container (started by ../test-installer.sh). Exercises
# scripts/install-validator.sh against a local HTTP server with TEST keys.
#   /src  the repo's scripts/ directory (read-only)
#   /ctx  test fixtures: keys/ (test public keys), shims/
#   WEB   base URL of the fixture server, e.g. http://rc-inst-test-web:8080
# Prints one line per check and exits non-zero if any check failed.
set -uo pipefail

WEB="${WEB:?}"
INSTALLER=/src/install-validator.sh
LOG=/tmp/installer.log
PASS=0
FAIL=0
TEST_ENV=(ROUGECHAIN_INSTALLER_TEST=1 ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem)
BIN=/usr/local/bin/quantum-vault-daemon
UNIT=/etc/systemd/system/rougechain-validator.service
DATA=/var/lib/rougechain/mainnet
KEYS=$DATA/node-keys.json
CONF=/etc/rougechain/mainnet
RC=0

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; if [ -s "$LOG" ]; then sed 's/^/        | /' "$LOG" | tail -n 25; fi; }
check() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
section() { printf '\n[%s]\n' "$1"; }

# run VAR=value... [-- installer-args...] : run the installer with a clean environment.
run() {
  local envs=() args=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  if [ $# -gt 0 ]; then shift; args=("$@"); fi
  env -i PATH="${RUN_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" HOME=/root \
    "${envs[@]}" bash "$INSTALLER" "${args[@]}" > "$LOG" 2>&1
  RC=$?
}
base() { printf 'RELEASE_BASE_URLS=%s' "$WEB/rel/$1"; }

expect_ok()   { if [ "$RC" -eq 0 ]; then ok "$1"; else bad "$1 (exit $RC)"; fi; }
# expect_refused DESC PATTERN : the installer must have failed AND said why.
expect_refused() {
  if [ "$RC" -ne 0 ] && grep -qE -- "$2" "$LOG"; then ok "$1"; else bad "$1 (exit $RC, wanted failure matching /$2/)"; fi
}
logged() { grep -qE -- "$1" "$LOG"; }

state() {
  {
    find /usr/local/bin /etc/rougechain /var/lib/rougechain /etc/systemd/system -type f -exec sha256sum {} + 2>/dev/null | sort -k 2
    find /usr/local/bin /etc/rougechain /var/lib/rougechain /etc/systemd/system -exec stat -c '%n %a %U %G' {} + 2>/dev/null | sort
    getent passwd rougechain || true
  } | sha256sum | cut -d ' ' -f 1
}
reset_state() {
  rm -rf /usr/local/bin/quantum-vault-daemon* /etc/rougechain /var/lib/rougechain /etc/systemd/system/rougechain-validator*
  userdel rougechain > /dev/null 2>&1 || true
  groupdel rougechain > /dev/null 2>&1 || true
}
mode_owner() { stat -c '%a %U:%G' "$1" 2>/dev/null; }
sha() { sha256sum "$1" | cut -d ' ' -f 1; }
manifest_sha() { curl -fsS "$WEB/rel/$1/manifest-mainnet.json" | jq -r .binary.sha256; }

# shellcheck disable=SC1091
echo "=== $(. /etc/os-release && echo "$PRETTY_NAME") / $(openssl version 2>/dev/null || echo 'openssl not installed yet') ==="
EMPTY="$(state)"

section "placeholder key"
run "$(base v1)"
expect_refused "installer with the placeholder key refuses to run" "placeholder key"
check "…and changed nothing" test "$(state)" = "$EMPTY"
run ROUGECHAIN_INSTALLER_TEST=1 "$(base v1)"
expect_refused "test flag alone (no key file) is rejected" "needs BOTH"
run ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem "$(base v1)"
expect_refused "test key file alone (no flag) is rejected" "needs BOTH"
run ROUGECHAIN_INSTALLER_TEST=yes ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem "$(base v1)"
expect_refused "test flag must be exactly 1" "needs BOTH"
check "…and changed nothing" test "$(state)" = "$EMPTY"

section "platform + input checks"
cp /etc/os-release /tmp/os-release.orig
real_os_release="$(readlink -f /etc/os-release)"
sed -e 's/^VERSION_ID=.*/VERSION_ID="20.04"/' /tmp/os-release.orig > "$real_os_release"
run "${TEST_ENV[@]}" "$(base v1)"
expect_refused "unsupported OS version is refused with a clear message" "unsupported operating system"
cat /tmp/os-release.orig > "$real_os_release"
RUN_PATH="/ctx/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" run "${TEST_ENV[@]}" "$(base v1)"
expect_refused "non-x86_64 CPU is refused with a clear message" "unsupported CPU architecture: aarch64"
run "${TEST_ENV[@]}" "$(base v1)" NETWORK=devnet
expect_refused "unknown NETWORK is refused" "NETWORK must be"
run "${TEST_ENV[@]}" "$(base v1)" "NODE_NAME=bad name; rm -rf /"
expect_refused "NODE_NAME with shell/unit metacharacters is refused" "NODE_NAME may only contain"
run "${TEST_ENV[@]}" "$(base v1)" "PUBLIC_URL=https://x.example --dev"
expect_refused "PUBLIC_URL with extra flags is refused" "PUBLIC_URL must look like"
run "${TEST_ENV[@]}" "$(base v1)" DATA_DIR=relative/dir
expect_refused "relative DATA_DIR is refused" "DATA_DIR must be"
run "${TEST_ENV[@]}" "$(base v1)" API_PORT=99999
expect_refused "out-of-range API_PORT is refused" "port number"
run "${TEST_ENV[@]}" "$(base v1)" -- --frobnicate
expect_refused "unknown option is refused" "unknown option"
check "…none of these changed anything" test "$(state)" = "$EMPTY"

section "dry run on a bare image"
if command -v jq > /dev/null 2>&1; then
  ok "(jq already present — skipping the missing-tools check)"
else
  run "${TEST_ENV[@]}" "$(base v1)" -- --dry-run
  expect_refused "dry run does not install packages; names what is missing" "missing tools:.*jq"
fi

section "valid release installs (NO_START=1)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node
expect_ok "install succeeds"
check "loud TEST MODE warning is printed" logged "TEST MODE"
check "signature reported OK" logged "signature OK"
V1_SHA="$(manifest_sha v1)"
check "binary installed and matches the signed sha256" test "$(sha $BIN)" = "$V1_SHA"
check "binary is 0755 root:root" test "$(mode_owner $BIN)" = "755 root:root"
check "no .prev binary on a first install" test ! -e "$BIN.prev"
check "system user exists with no login shell" bash -c 'getent passwd rougechain | grep -q ":/usr/sbin/nologin$"'
check "system user has a system uid (<1000)" test "$(id -u rougechain)" -lt 1000
check "data dir is 0700 rougechain" test "$(mode_owner $DATA)" = "700 rougechain:rougechain"
check "node-keys.json generated, 0600 rougechain" test "$(mode_owner $KEYS)" = "600 rougechain:rougechain"
check "node-keys.json holds a key" jq -e '.public_key_hex | length > 0' "$KEYS"
check "genesis installed and matches the manifest" test "$(sha $CONF/genesis.json)" = "$(jq -r .genesis.sha256 $CONF/manifest.json)"
check "verified manifest + signature recorded" test -s "$CONF/manifest.json" -a -s "$CONF/manifest.json.ed25519.sig"
check "unit file is 0644 root" test "$(mode_owner $UNIT)" = "644 root:root"
check "unit: managed marker" grep -q "^# Managed by RougeChain install-validator.sh" "$UNIT"
check "unit: runs as the dedicated user" grep -q "^User=rougechain$" "$UNIT"
check "unit: API bound to 127.0.0.1:5100, gRPC 4100" grep -q -- "--host 127.0.0.1 --api-port 5100 --port 4100" "$UNIT"
check "unit: mainnet chain id + genesis + peers" bash -c "grep -q -- '--chain-id rougechain-mainnet-1' $UNIT && grep -q -- '--genesis $CONF/genesis.json' $UNIT && grep -q -- '--peers https://api.rougechain.io/api' $UNIT"
check "unit: data dir + node name" bash -c "grep -q -- '--data-dir $DATA' $UNIT && grep -q -- '--node-name ci-node' $UNIT"
check "unit: NO --mine by default" bash -c "! grep -q -- '--mine' $UNIT"
check "unit: no --public-url by default" bash -c "! grep -q -- '--public-url' $UNIT"
check "unit: never --dev" bash -c "! grep -q -- '--dev' $UNIT"
for opt in NoNewPrivileges=yes ProtectSystem=strict "ReadWritePaths=$DATA" ProtectHome=yes PrivateTmp=yes PrivateDevices=yes \
  ProtectKernelTunables=yes ProtectControlGroups=yes RestrictSUIDSGID=yes LockPersonality=yes "CapabilityBoundingSet=" UMask=0077 Restart=always; do
  check "unit: $opt" grep -qx -- "$opt" "$UNIT"
done
check "service not started (NO_START=1, no systemd)" logged "not started"
check "next steps: back up the key, stake, VALIDATOR=1" bash -c "grep -q 'BACK UP THE NODE KEY' $LOG && grep -q 'stake 10000' $LOG && grep -q 'VALIDATOR=1' $LOG"
check "no temp dir left behind" bash -c '! ls -d /tmp/tmp.* 2>/dev/null | grep -q .'

section "re-run is idempotent and keeps keys"
KEY_SHA="$(sha $KEYS)"; KEY_INODE="$(stat -c %i $KEYS)"
echo "chain data sentinel" > "$DATA/sentinel"; chown rougechain:rougechain "$DATA/sentinel"
BEFORE="$(state)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node
expect_ok "second run succeeds"
check "nothing changed on disk (binary, unit, keys, data, perms)" test "$(state)" = "$BEFORE"
check "node key untouched (same content, same inode)" test "$(sha $KEYS)" = "$KEY_SHA" -a "$(stat -c %i $KEYS)" = "$KEY_INODE"
check "says the key was kept" logged "node key exists — keeping it"
check "says the binary is current" logged "already installed and matches"
check "no .prev binary created by a no-op re-run" test ! -e "$BIN.prev"
chmod 0644 "$KEYS"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node
check "loose key permissions are tightened back to 0600, content untouched" test "$(mode_owner $KEYS)" = "600 rougechain:rougechain" -a "$(sha $KEYS)" = "$KEY_SHA"

section "forged / missing signatures are refused"
BEFORE="$(state)"
run "${TEST_ENV[@]}" "$(base forged)" NO_START=1
expect_refused "manifest edited after signing is refused" "SIGNATURE CHECK FAILED"
check "…with a final refusal, nothing installed" logged "no release manifest with a valid signature"
run "${TEST_ENV[@]}" "$(base wrongkey)" NO_START=1
expect_refused "manifest signed by a different key is refused" "SIGNATURE CHECK FAILED"
run "${TEST_ENV[@]}" "$(base garbage)" NO_START=1
expect_refused "garbage signature file is refused" "SIGNATURE CHECK FAILED"
run "${TEST_ENV[@]}" "$(base truncsig)" NO_START=1
expect_refused "truncated (63-byte) signature is refused" "SIGNATURE CHECK FAILED"
run "${TEST_ENV[@]}" "$(base nosig)" NO_START=1
expect_refused "manifest without a signature file is refused" "could not fetch the signature"
run "${TEST_ENV[@]}" "$(base othersig)" NO_START=1
expect_refused "a valid signature of a DIFFERENT manifest is refused" "SIGNATURE CHECK FAILED"
run "${TEST_ENV[@]}" "RELEASE_BASE_URLS=$WEB/rel/forged $WEB/rel/wrongkey" NO_START=1
expect_refused "all sources forged → refused" "no release manifest with a valid signature"
check "state unchanged after every refusal" test "$(state)" = "$BEFORE"

section "binary / genesis not matching the signed manifest is refused"
reset_state
run "${TEST_ENV[@]}" "$(base badsha)" NO_START=1
expect_refused "binary with the right size but wrong sha256 is refused" "sha256 .* does not match the signed manifest"
check "…nothing installed" test ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"
run "${TEST_ENV[@]}" "$(base badsize)" NO_START=1
expect_refused "binary with the wrong size is refused" "could not obtain a binary matching the signed manifest"
check "…nothing installed" test ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"
run "${TEST_ENV[@]}" "$(base badgenesis)" NO_START=1
expect_refused "genesis not matching the manifest is refused" "could not obtain a genesis file matching the signed manifest"
check "…nothing installed (binary neither)" test ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"

section "manifest content checks (validly signed, still refused)"
run "${TEST_ENV[@]}" "$(base mininst)" NO_START=1
expect_refused "min_installer_version newer than this installer" "too old for release"
run "${TEST_ENV[@]}" "$(base wrongnet)" NO_START=1
expect_refused "testnet manifest served as the mainnet manifest" "manifest is for network 'testnet'"
check "…nothing installed" test ! -e "$BIN" -a ! -e "$UNIT"

section "dry run"
EMPTY2="$(state)"
run "${TEST_ENV[@]}" "$(base v1)" -- --dry-run
expect_ok "dry run succeeds on a valid release"
check "dry run verified signature + binary" bash -c "grep -q 'signature OK' $LOG && grep -q 'binary verified' $LOG && grep -q 'Nothing was changed' $LOG"
check "dry run changed nothing (no user, no files)" bash -c "test \"$(state)\" = \"$EMPTY2\" && ! getent passwd rougechain"
run "${TEST_ENV[@]}" "$(base forged)" -- --dry-run
expect_refused "dry run fails on a forged release" "SIGNATURE CHECK FAILED"

section "mirror fallback"
run "${TEST_ENV[@]}" "RELEASE_BASE_URLS=http://rc-inst-test-web:8081/down $WEB/rel/v1" NO_START=1
expect_ok "manifest: primary down (connection refused) → mirror used"
check "…fallback was reported" logged "could not fetch http://rc-inst-test-web:8081/down/manifest-mainnet.json"
check "…installed from the mirror source" logged "source: $WEB/rel/v1/manifest-mainnet.json"
reset_state
run "${TEST_ENV[@]}" "RELEASE_BASE_URLS=$WEB/rel/missing $WEB/rel/v1" NO_START=1
expect_ok "manifest: primary 404 → mirror used"
reset_state
run "${TEST_ENV[@]}" "RELEASE_BASE_URLS=$WEB/rel/forged $WEB/rel/v1" NO_START=1
expect_ok "manifest: primary serves a forged manifest → ignored, verified mirror used"
check "…and the forgery was reported loudly" logged "SIGNATURE CHECK FAILED for $WEB/rel/forged"
reset_state
run "${TEST_ENV[@]}" "$(base mirror)" NO_START=1
expect_ok "binary: primary down, 2nd 404, 3rd tampered → 4th (good mirror) installed"
check "…connection failure reported" logged "binary: download failed from http://rc-inst-test-web:8081/"
check "…tampered mirror rejected by sha256" logged "binary: sha256 .* does not match the signed manifest"
check "…installed binary matches the signed sha256" test "$(sha $BIN)" = "$V1_SHA"
check "genesis: primary 404 → mirror used" bash -c "grep -q 'genesis: download failed' $LOG && test -s $CONF/genesis.json"

section "upgrade in place keeps a .prev binary, keys and data"
reset_state
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
KEY_SHA="$(sha $KEYS)"
echo "chain data sentinel" > "$DATA/sentinel"; chown rougechain:rougechain "$DATA/sentinel"
run "${TEST_ENV[@]}" "$(base v2)" NO_START=1
expect_ok "upgrade v1 → v2 succeeds"
V2_SHA="$(manifest_sha v2)"
check "new binary installed" test "$(sha $BIN)" = "$V2_SHA" -a "$V2_SHA" != "$V1_SHA"
check ".prev is the v1 binary" test "$(sha $BIN.prev)" = "$V1_SHA"
check "node key untouched" test "$(sha $KEYS)" = "$KEY_SHA" -a "$(mode_owner $KEYS)" = "600 rougechain:rougechain"
check "chain data untouched" grep -q "chain data sentinel" "$DATA/sentinel"
check "recorded manifest is v2" test "$(jq -r .version $CONF/manifest.json)" = "9.1.0"
check "no leftover .new file" test ! -e "$BIN.new"
BEFORE="$(state)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_refused "downgrade v2 → v1 (replayed old manifest) is refused" "refusing to downgrade"
check "…state unchanged" test "$(state)" = "$BEFORE"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 ALLOW_DOWNGRADE=1
expect_ok "explicit ALLOW_DOWNGRADE=1 rolls back"
check "…binary is v1 again, .prev is v2, key untouched" test "$(sha $BIN)" = "$V1_SHA" -a "$(sha $BIN.prev)" = "$V2_SHA" -a "$(sha $KEYS)" = "$KEY_SHA"

section "validator opt-in + options"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 VALIDATOR=1 PUBLIC_URL=https://node.example.com NODE_NAME=my-validator API_PORT=5200 P2P_PORT=4200 ALLOW_DOWNGRADE=1
expect_ok "re-run with VALIDATOR=1 PUBLIC_URL=… succeeds"
check "unit: --mine present" grep -q -- "^  --mine$" "$UNIT"
check "unit: --public-url present" grep -q -- "--public-url https://node.example.com" "$UNIT"
check "unit: custom ports + name" bash -c "grep -q -- '--api-port 5200 --port 4200' $UNIT && grep -q -- '--node-name my-validator' $UNIT"
check "unit: still bound to 127.0.0.1" grep -q -- "--host 127.0.0.1" "$UNIT"
check "node key untouched" test "$(sha $KEYS)" = "$KEY_SHA"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 VALIDATOR=1 ALLOW_DOWNGRADE=1
check "VALIDATOR=1 without PUBLIC_URL warns" logged "VALIDATOR=1 without PUBLIC_URL"

section "existing keys / data are never replaced"
reset_state
useradd --system --user-group --home-dir /var/lib/rougechain --no-create-home --shell /usr/sbin/nologin rougechain
install -d -m 0700 -o rougechain -g rougechain /var/lib/rougechain "$DATA"
echo '{"algorithm":"ML-DSA-65","public_key_hex":"feedfacefeedfacefeedface","secret_key_hex":"PRE-EXISTING-STAKED-KEY"}' > "$KEYS"
chown rougechain:rougechain "$KEYS"; chmod 0600 "$KEYS"
KEY_SHA="$(sha $KEYS)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_ok "install over a pre-existing data dir + key succeeds"
check "pre-existing key is byte-identical" test "$(sha $KEYS)" = "$KEY_SHA"
check "reports the existing public key" logged "public key feedfacefeedface"
reset_state
install -d -m 0755 /srv/otherdata
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 DATA_DIR=/srv/otherdata
expect_refused "existing DATA_DIR owned by someone else is refused (no chown -R)" "exists but is owned by 'root'"
check "…its owner was not changed" test "$(stat -c %U /srv/otherdata)" = "root"
rm -rf /srv/otherdata
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 DATA_DIR=/srv/rc-data
expect_ok "custom DATA_DIR installs"
check "custom data dir 0700 rougechain + key 0600" test "$(mode_owner /srv/rc-data)" = "700 rougechain:rougechain" -a "$(mode_owner /srv/rc-data/node-keys.json)" = "600 rougechain:rougechain"
check "unit uses the custom data dir (ReadWritePaths too)" bash -c "grep -q -- '--data-dir /srv/rc-data' $UNIT && grep -qx 'ReadWritePaths=/srv/rc-data' $UNIT"
rm -rf /srv/rc-data

section "legacy (source-build) unit is not silently replaced"
reset_state
mkdir -p /etc/systemd/system
printf '[Service]\nUser=ubuntu\nExecStart=/home/ubuntu/rougechain/core/target/release/quantum-vault-daemon --mine --data-dir /home/ubuntu/.quantum-vault/mainnet\n' > "$UNIT"
LEGACY_SHA="$(sha $UNIT)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_refused "unit not written by this installer → refused with migration steps" "was not written by this installer"
check "…legacy unit untouched, nothing installed" test "$(sha $UNIT)" = "$LEGACY_SHA" -a ! -e "$BIN" -a ! -e "$DATA"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 REPLACE_LEGACY_UNIT=1
expect_refused "REPLACE_LEGACY_UNIT=1 without the node's existing key is refused (no new identity)" "refusing to generate a new identity"
check "…legacy unit untouched, nothing installed" test "$(sha $UNIT)" = "$LEGACY_SHA" -a ! -e "$BIN" -a ! -e "$DATA"
# the documented migration: create the user, move the old data dir (with its key) into place
useradd --system --user-group --home-dir /var/lib/rougechain --no-create-home --shell /usr/sbin/nologin rougechain
mkdir -p /var/lib/rougechain /home/ubuntu/.quantum-vault/mainnet/chain-db
echo '{"algorithm":"ML-DSA-65","public_key_hex":"0123456789abcdef0123","secret_key_hex":"LEGACY-STAKED-KEY"}' > /home/ubuntu/.quantum-vault/mainnet/node-keys.json
echo "journal" > /home/ubuntu/.quantum-vault/mainnet/finality-signing-journal
LEGACY_KEY_SHA="$(sha /home/ubuntu/.quantum-vault/mainnet/node-keys.json)"
mv /home/ubuntu/.quantum-vault/mainnet "$DATA"
chown -R rougechain:rougechain /var/lib/rougechain
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 REPLACE_LEGACY_UNIT=1 VALIDATOR=1 PUBLIC_URL=https://node.example.com
expect_ok "documented migration (move data dir, REPLACE_LEGACY_UNIT=1) succeeds"
check "…old unit kept as .legacy" test "$(sha $UNIT.legacy)" = "$LEGACY_SHA"
check "…the node keeps its key and its data" test "$(sha $KEYS)" = "$LEGACY_KEY_SHA" -a -s "$DATA/finality-signing-journal" -a "$(mode_owner $KEYS)" = "600 rougechain:rougechain"
check "…new unit is the managed, sandboxed one" bash -c "grep -q '^# Managed by RougeChain' $UNIT && grep -q '^User=rougechain$' $UNIT && grep -q -- '--mine' $UNIT"
rm -rf /home/ubuntu

section "testnet"
reset_state
run "${TEST_ENV[@]}" "$(base testnet)" NO_START=1 NETWORK=testnet
expect_ok "testnet install succeeds (manifest without a genesis)"
TUNIT=/etc/systemd/system/rougechain-validator-testnet.service
check "separate binary + unit + data dir" test -x /usr/local/bin/quantum-vault-daemon-testnet -a -s "$TUNIT" -a -s /var/lib/rougechain/testnet/node-keys.json
check "unit: testnet chain id, ports 5101/4101, testnet peer, no --genesis" bash -c "grep -q -- '--chain-id rougechain-devnet-1' $TUNIT && grep -q -- '--api-port 5101 --port 4101' $TUNIT && grep -q -- '--peers https://testnet.rougechain.io/api' $TUNIT && ! grep -q -- '--genesis' $TUNIT"
check "mainnet paths not created" test ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_ok "mainnet installs next to testnet"
check "both units present, separate keys" test -s "$UNIT" -a -s "$TUNIT" -a "$(sha $KEYS)" != "$(sha /var/lib/rougechain/testnet/node-keys.json)"

section "piped execution (curl … | sudo bash)"
reset_state
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=piped bash > "$LOG" 2>&1
RC=$?
expect_ok "installer piped into bash from the web server succeeds"
check "…installed binary, key and unit" test "$(sha $BIN)" = "$V1_SHA" -a "$(mode_owner $KEYS)" = "600 rougechain:rougechain" -a -s "$UNIT"
check "…ran to the end (next steps printed)" logged "Upgrades: re-run this installer"
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base v1)" bash -s -- --dry-run > "$LOG" 2>&1
RC=$?
expect_ok "piped with arguments (bash -s -- --dry-run) succeeds"

section "unit file is valid for systemd"
if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd > /tmp/apt-systemd.log 2>&1; then
  systemd-analyze verify "$UNIT" > "$LOG" 2>&1
  SA_RC=$?
  # Only complaints about this unit count (the container has no other units / no running manager).
  if grep -E "rougechain-validator\.service" "$LOG" | grep -qiE "unknown|invalid|failed to parse|not executable|ignoring|bad"; then
    bad "systemd-analyze verify: problems reported for the unit (exit $SA_RC)"
  else
    : > "$LOG"; ok "systemd-analyze verify: no unknown or invalid directives ($(systemd --version | head -n 1))"
  fi
else
  cp /tmp/apt-systemd.log "$LOG"; bad "could not install systemd to verify the unit"
fi

# shellcheck disable=SC1091
printf '\n%s: %d passed, %d failed\n' "$(. /etc/os-release && echo "$ID $VERSION_ID")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
