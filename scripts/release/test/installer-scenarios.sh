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
CLI=/usr/local/bin/rougechain
UNIT=/etc/systemd/system/rougechain-validator.service
UPDATER=/usr/local/lib/rougechain/install-validator.sh
UPD_CMD=/usr/local/bin/rougechain-update
UPD_UNIT=/etc/systemd/system/rougechain-update.service
UPD_TIMER=/etc/systemd/system/rougechain-update.timer
UPD_STATE=/var/lib/rougechain-updater/mainnet/state
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
    find /usr/local/bin /usr/local/lib/rougechain /etc/rougechain /var/lib/rougechain /etc/systemd/system -type f -exec sha256sum {} + 2>/dev/null | sort -k 2
    find /usr/local/bin /usr/local/lib/rougechain /etc/rougechain /var/lib/rougechain /etc/systemd/system -exec stat -c '%n %a %U %G' {} + 2>/dev/null | sort
    getent passwd rougechain || true
  } | sha256sum | cut -d ' ' -f 1
}
reset_state() {
  rm -rf /usr/local/bin/quantum-vault-daemon* /usr/local/bin/rougechain* /etc/rougechain /var/lib/rougechain /etc/systemd/system/rougechain-validator*
  rm -rf /usr/local/lib/rougechain /var/lib/rougechain-updater /etc/systemd/system/rougechain-update*
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
# The committed installer carries the real release key once keys are provisioned, so the guard is
# tested on a copy with the placeholder put back.
REAL_INSTALLER="$INSTALLER"
INSTALLER=/tmp/install-validator.placeholder.sh
sed 's|^RELEASE_ED25519_PUBKEY_B64=.*|RELEASE_ED25519_PUBKEY_B64="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"|' "$REAL_INSTALLER" > "$INSTALLER"
check "placeholder copy differs from the committed installer only when a key is embedded" grep -q '^RELEASE_ED25519_PUBKEY_B64="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"$' "$INSTALLER"
run "$(base v1)"
expect_refused "installer with the placeholder key refuses to run" "placeholder key"
check "…and changed nothing" test "$(state)" = "$EMPTY"
INSTALLER="$REAL_INSTALLER"
if ! grep -q '^RELEASE_ED25519_PUBKEY_B64="PLACEHOLDER_RELEASE_KEY_NOT_PROVISIONED"$' "$INSTALLER"; then
  # A release signed by any other key (here: the test key) must be refused by the production key.
  run "$(base v1)"
  if [ "$RC" -ne 0 ]; then ok "installer with the production key refuses a release signed by another key"; else bad "installer with the production key ACCEPTED a release signed by another key"; fi
  check "…and changed nothing" test "$(state)" = "$EMPTY"
fi
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
V1_CLI_SHA="$(curl -fsS "$WEB/rel/v1/manifest-mainnet.json" | jq -r .cli.sha256)"
check "rougechain CLI installed and matches the signed sha256" test "$(sha $CLI)" = "$V1_CLI_SHA"
check "CLI is 0755 root:root, no .prev on a first install" test "$(mode_owner $CLI)" = "755 root:root" -a ! -e "$CLI.prev"
check "next steps use the installed CLI as the service user (whoami, stake, validator-status)" bash -c "grep -q 'sudo -u rougechain rougechain --node-keys $KEYS whoami' $LOG && grep -q 'sudo -u rougechain rougechain --node-keys $KEYS stake 10000' $LOG && grep -q 'sudo -u rougechain rougechain --node-keys $KEYS validator-status' $LOG"
check "next steps do not tell the operator to build the CLI, and need no --rpc" bash -c "! grep -q 'cargo build' $LOG && ! grep -q -- '--rpc' $LOG"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo > /dev/null 2>&1
check "the printed command works: service user can read the 0600 key via sudo -u" bash -c "sudo -u rougechain rougechain --node-keys $KEYS whoami | grep -q 'net=mainnet user=rougechain Address: rouge1test'"
check "…and via runuser (no sudo)" bash -c "runuser -u rougechain -- rougechain --node-keys $KEYS whoami | grep -q 'Address: rouge1test'"
check "…while another unprivileged user cannot read the key" bash -c "! runuser -u nobody -- rougechain --node-keys $KEYS whoami"
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
check "both signatures recorded with the manifest" test -s "$CONF/manifest.json.mldsa65.sig"
check "ML-DSA-65: signature present, reported as not verified (no CLI with 'release verify' installed)" logged "ML-DSA-65 signature present; not verified yet"

section "auto-update is set up by the installer"
check "updater installed: the installer file itself, 0755 root" bash -c "cmp -s $UPDATER /src/install-validator.sh && test \"\$(stat -c '%a %U:%G' $UPDATER)\" = '755 root:root'"
check "…and the log says where it came from (a file, not a release signature)" logged "installed the updater: $UPDATER .*installer file run by the operator .*not covered by a release signature"
check "rougechain-update command installed, 0755 root, runs the installed updater" bash -c "test \"\$(stat -c '%a %U:%G' $UPD_CMD)\" = '755 root:root' && test \"\$($UPD_CMD --version)\" = \"\$(bash /src/install-validator.sh --version)\""
check "update.conf written: MODE=auto, 0644 root, documented defaults" bash -c "grep -qx 'MODE=auto' $CONF/update.conf && grep -qx 'PIN_VERSION=' $CONF/update.conf && grep -qx 'OPTIONAL_DELAY_MAX_SECS=21600' $CONF/update.conf && test \"\$(stat -c '%a %U:%G' $CONF/update.conf)\" = '644 root:root'"
check "update service unit: oneshot, runs rougechain-update run --network mainnet" bash -c "grep -qx 'Type=oneshot' $UPD_UNIT && grep -qx 'ExecStart=/usr/local/bin/rougechain-update run --network mainnet' $UPD_UNIT && grep -qx 'SyslogIdentifier=rougechain-update' $UPD_UNIT"
check "update timer unit: hourly, per-host fixed random delay, persistent" bash -c "grep -qx 'OnCalendar=hourly' $UPD_TIMER && grep -qx 'RandomizedDelaySec=30min' $UPD_TIMER && grep -qx 'FixedRandomDelay=yes' $UPD_TIMER && grep -qx 'Persistent=yes' $UPD_TIMER && grep -qx 'Unit=rougechain-update.service' $UPD_TIMER"
check "units are 0644 root" test "$(mode_owner $UPD_UNIT)" = "644 root:root" -a "$(mode_owner $UPD_TIMER)" = "644 root:root"
check "no systemd here: timer written, not enabled — and said so" logged "auto-update timer was written but not enabled"
check "next steps describe automatic upgrades" bash -c "grep -q 'Upgrades: AUTOMATIC' $LOG && grep -q 'rougechain-update status' $LOG"
check "updater state dir is root-owned, not writable by the service user" test "$(mode_owner /var/lib/rougechain-updater/mainnet)" = "755 root:root"
"$UPD_CMD" status > "$LOG" 2>&1; RC=$?
expect_ok "rougechain-update status works"
check "…shows mode, installed release, updater origin" bash -c "grep -qE 'mode +auto' $LOG && grep -qE 'installed release +9\.0\.0' $LOG && grep -qE 'updater +v[0-9.]+ .*installer file run by the operator' $LOG && grep -qE 'failed releases +none' $LOG"
runuser -u nobody -- "$UPD_CMD" status > "$LOG" 2>&1; RC=$?
expect_ok "status works without root"
runuser -u nobody -- "$UPD_CMD" run > "$LOG" 2>&1; RC=$?
expect_refused "run needs root" "run as root"

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
check "CLI reported current, no .prev CLI created" bash -c "grep -q 'rougechain CLI already installed and matches' $LOG && test ! -e $CLI.prev"
chmod 0644 "$KEYS"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node
check "loose key permissions are tightened back to 0600, content untouched" test "$(mode_owner $KEYS)" = "600 rougechain:rougechain" -a "$(sha $KEYS)" = "$KEY_SHA"

section "auto-update settings: opt-out, and an existing update.conf is kept"
CONF_NOMODE="$(sed 's/^MODE=.*//' "$CONF/update.conf" | sha256sum)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node AUTO_UPDATE=0
expect_ok "re-run with AUTO_UPDATE=0 succeeds"
check "…MODE=off, nothing else in update.conf changed" bash -c "grep -qx 'MODE=off' $CONF/update.conf && test \"\$(sed 's/^MODE=.*//' $CONF/update.conf | sha256sum)\" = '$CONF_NOMODE'"
check "…and says so" bash -c "grep -q 'AUTO_UPDATE=0: set MODE=off' $LOG && grep -q 'auto-update is OFF' $LOG"
check "…the updater program stays installed (manual runs remain possible)" test -x "$UPD_CMD" -a -s "$UPDATER"
sed -i 's/^PIN_VERSION=.*/PIN_VERSION=9.0.0/; s/^HEALTH_DEADLINE_SECS=.*/HEALTH_DEADLINE_SECS=77/' "$CONF/update.conf"
echo "# operator note" >> "$CONF/update.conf"
CONF_SHA="$(sha $CONF/update.conf)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node
expect_ok "re-run without AUTO_UPDATE"
check "…update.conf is byte-identical (the opt-out and the operator's settings survive)" test "$(sha $CONF/update.conf)" = "$CONF_SHA"
check "…and says it kept it" logged "keeping the existing $CONF/update.conf \(MODE=off\)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node AUTO_UPDATE=1
expect_ok "re-run with AUTO_UPDATE=1"
check "…MODE=auto again; PIN_VERSION, the changed number and the comment are kept" bash -c "grep -qx 'MODE=auto' $CONF/update.conf && grep -qx 'PIN_VERSION=9.0.0' $CONF/update.conf && grep -qx 'HEALTH_DEADLINE_SECS=77' $CONF/update.conf && grep -qx '# operator note' $CONF/update.conf"
"$UPD_CMD" status > "$LOG" 2>&1
check "status shows the pin" bash -c "grep -qE 'pinned version +9\.0\.0' $LOG"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 AUTO_UPDATE=yes
expect_refused "AUTO_UPDATE must be 0 or 1" "AUTO_UPDATE must be 0 or 1"
reset_state
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node AUTO_UPDATE=0
expect_ok "fresh install with AUTO_UPDATE=0"
check "…update.conf MODE=off from the start; next steps say auto-update is off" bash -c "grep -qx 'MODE=off' $CONF/update.conf && grep -q 'auto-update is OFF' $LOG"
reset_state
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=ci-node

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

run "${TEST_ENV[@]}" "$(base badcli)" NO_START=1
expect_refused "CLI with the right size but wrong sha256 is refused" "cli: sha256 .* does not match the signed manifest"
check "…with a final refusal, nothing installed (node binary neither)" bash -c "grep -q 'could not obtain a rougechain CLI matching the signed manifest' $LOG && test ! -e $BIN -a ! -e $CLI -a ! -e $UNIT -a ! -e $DATA"
run "${TEST_ENV[@]}" "$(base badredirect)" NO_START=1
expect_refused "a redirecting mirror that leads to a tampered binary is refused" "sha256 .* does not match the signed manifest"
check "…nothing installed" test ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"

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
check "cli: primary down, 2nd tampered → 3rd (good mirror) installed" bash -c "grep -q 'cli: download failed from http://rc-inst-test-web:8081/' $LOG && grep -q 'cli: sha256 .* does not match the signed manifest' $LOG && test \"\$(sha256sum $CLI | cut -d ' ' -f 1)\" = $V1_CLI_SHA"

section "GitHub-style mirror: 302 redirect to the file"
check "fixture: the mirror really answers 302 with a Location" bash -c "curl -s -o /dev/null -w '%{http_code} %{redirect_url}' '$WEB/cgi-bin/dl?v1/quantum-vault-daemon-test' | grep -q '^302 http://rc-inst-test-web:8080/files/v1/quantum-vault-daemon-test$'"
reset_state
run "${TEST_ENV[@]}" "$(base redirect)" NO_START=1
expect_ok "primaries down, mirrors redirect (302) → install succeeds"
check "…the redirecting mirrors were the source" bash -c "grep -q 'downloading binary: $WEB/cgi-bin/dl' $LOG && grep -q 'downloading cli: $WEB/cgi-bin/dl' $LOG && grep -q 'downloading genesis: $WEB/cgi-bin/dl' $LOG"
check "…binary, CLI and genesis all match the signed manifest" test "$(sha $BIN)" = "$V1_SHA" -a "$(sha $CLI)" = "$V1_CLI_SHA" -a "$(sha $CONF/genesis.json)" = "$(jq -r .genesis.sha256 $CONF/manifest.json)"

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
check "no leftover .new file" test ! -e "$BIN.new" -a ! -e "$CLI.new"
V2_CLI_SHA="$(curl -fsS "$WEB/rel/v2/manifest-mainnet.json" | jq -r .cli.sha256)"
check "new CLI installed, rougechain.prev is the v1 CLI" test "$(sha $CLI)" = "$V2_CLI_SHA" -a "$(sha $CLI.prev)" = "$V1_CLI_SHA" -a "$V2_CLI_SHA" != "$V1_CLI_SHA"
check "upgraded CLI runs" bash -c "$CLI --version | grep -q 'fake-v2'"
BEFORE="$(state)"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_refused "downgrade v2 → v1 (replayed old manifest) is refused" "refusing to downgrade"
check "…state unchanged" test "$(state)" = "$BEFORE"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1 ALLOW_DOWNGRADE=1
expect_ok "explicit ALLOW_DOWNGRADE=1 rolls back"
check "…binary is v1 again, .prev is v2, key untouched" test "$(sha $BIN)" = "$V1_SHA" -a "$(sha $BIN.prev)" = "$V2_SHA" -a "$(sha $KEYS)" = "$KEY_SHA"

section "release without the CLI (cli: null)"
reset_state
run "${TEST_ENV[@]}" "$(base nocli)" NO_START=1
expect_ok "install succeeds when the manifest has no cli"
check "…node installed, no CLI installed" test "$(sha $BIN)" = "$V1_SHA" -a -s "$UNIT" -a -s "$KEYS" -a ! -e "$CLI"
check "…next steps fall back to building the CLI from source" bash -c "grep -q 'does not include the .rougechain. CLI' $LOG && grep -q 'cargo build --release -p quantum-vault-cli' $LOG && ! grep -q 'sudo -u rougechain' $LOG"
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
expect_ok "re-run with a release that has the CLI adds it"
check "…CLI now installed, node binary untouched (no .prev)" test "$(sha $CLI)" = "$V1_CLI_SHA" -a ! -e "$BIN.prev" -a ! -e "$CLI.prev"
run "${TEST_ENV[@]}" "$(base nocli)" NO_START=1
expect_ok "re-run with a release without the CLI again"
check "…an already installed CLI is left in place" test "$(sha $CLI)" = "$V1_CLI_SHA"
reset_state
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
KEY_SHA="$(sha $KEYS)"
run "${TEST_ENV[@]}" "$(base v2)" NO_START=1

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
check "testnet CLI installed under its own name; next steps use --network testnet and the command works" bash -c "test -x /usr/local/bin/rougechain-testnet && grep -q 'sudo -u rougechain rougechain-testnet --network testnet --node-keys /var/lib/rougechain/testnet/node-keys.json stake 10000' $LOG && sudo -u rougechain rougechain-testnet --network testnet --node-keys /var/lib/rougechain/testnet/node-keys.json whoami | grep -q 'net=testnet user=rougechain Address: rouge1test'"
check "separate binary + unit + data dir" test -x /usr/local/bin/quantum-vault-daemon-testnet -a -s "$TUNIT" -a -s /var/lib/rougechain/testnet/node-keys.json
check "testnet has its own update units, settings and state" bash -c "grep -qx 'ExecStart=/usr/local/bin/rougechain-update run --network testnet' /etc/systemd/system/rougechain-update-testnet.service && grep -qx 'Unit=rougechain-update-testnet.service' /etc/systemd/system/rougechain-update-testnet.timer && grep -qx 'MODE=auto' /etc/rougechain/testnet/update.conf && test -d /var/lib/rougechain-updater/testnet && test ! -e $UPD_UNIT"
check "rougechain-update status --network testnet" bash -c "$UPD_CMD status --network testnet | grep -q 'RougeChain auto-update — testnet' && $UPD_CMD status --network testnet | grep -qE 'installed release +9\.0\.0'"
check "rougechain-update refuses an unknown network" bash -c "! $UPD_CMD status --network devnet"
check "unit: testnet chain id, ports 5101/4101, testnet peer, no --genesis" bash -c "grep -q -- '--chain-id rougechain-devnet-1' $TUNIT && grep -q -- '--api-port 5101 --port 4101' $TUNIT && grep -q -- '--peers https://testnet.rougechain.io/api' $TUNIT && ! grep -q -- '--genesis' $TUNIT"
check "mainnet paths not created" test ! -e "$BIN" -a ! -e "$CLI" -a ! -e "$UNIT" -a ! -e "$DATA"
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
# Bootstrap rule: a piped installer does not have its own bytes, and release v1 names no updater
# in its signed manifest → no updater is installed (nothing unsigned is fetched to become one).
check "piped + release without an updater entry: NO updater, NO timer installed" test ! -e "$UPDATER" -a ! -e "$UPD_CMD" -a ! -e "$UPD_UNIT" -a ! -e "$UPD_TIMER"
check "…and the operator is told, with what to do" bash -c "grep -q 'AUTO-UPDATE WAS NOT INSTALLED' $LOG && grep -q 're-run this same command after the next release' $LOG && grep -q 'NOT available yet' $LOG"
check "…update.conf is still written (settings are recorded for later)" grep -qx 'MODE=auto' "$CONF/update.conf"
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base v1ins)" NO_START=1 NODE_NAME=piped bash > "$LOG" 2>&1
RC=$?
expect_ok "piped, release WITH a signed updater entry succeeds"
INS_SHA="$(curl -fsS "$WEB/rel/v1ins/manifest-mainnet.json" | jq -r .installer.sha256)"
check "…the updater is the file named in the signed manifest (sha256), 0755 root" test "$(sha $UPDATER)" = "$INS_SHA" -a "$(mode_owner $UPDATER)" = "755 root:root"
check "…origin recorded as the signed release; command + timer installed" bash -c "grep -q 'installed the updater: .*from: signed release 9.0.0' $LOG && grep -q 'updater verified: sha256' $LOG && grep -qx 'UPDATER_SOURCE=signed release 9.0.0' $UPD_STATE && test -x $UPD_CMD -a -s $UPD_TIMER"
check "…next steps describe automatic upgrades" logged "Upgrades: AUTOMATIC"
reset_state
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base insbad)" NO_START=1 NODE_NAME=piped bash > "$LOG" 2>&1
RC=$?
expect_refused "an updater script that does not match the signed manifest is refused" "updater: sha256 .* does not match the signed manifest"
check "…nothing installed at all" test ! -e "$UPDATER" -a ! -e "$BIN" -a ! -e "$UNIT" -a ! -e "$DATA"
# A file run keeps a NEWER installed updater, and replaces an older or equal one with the signed one.
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
sed 's/^INSTALLER_VERSION=.*/INSTALLER_VERSION="99.0.0"/' /src/install-validator.sh > "$UPDATER"
NEWER_SHA="$(sha $UPDATER)"
run "${TEST_ENV[@]}" "$(base v1ins)" NO_START=1
expect_ok "re-run while a NEWER updater is installed"
check "…the newer updater is kept (never replaced by an older one)" bash -c "test \"\$(sha256sum $UPDATER | cut -d ' ' -f 1)\" = $NEWER_SHA && grep -q 'is newer than the one in release' $LOG"
cp /src/install-validator.sh "$UPDATER"; echo "# local change" >> "$UPDATER"
run "${TEST_ENV[@]}" "$(base v1ins)" NO_START=1
expect_ok "re-run while an equal-version, different updater is installed"
check "…it is replaced by the signed one, the old one kept as .prev" bash -c "test \"\$(sha256sum $UPDATER | cut -d ' ' -f 1)\" = $INS_SHA && grep -q '# local change' $UPDATER.prev"
reset_state
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base v1)" NO_START=1 NODE_NAME=piped bash > "$LOG" 2>&1
curl -fsS "$WEB/installer/install-validator.sh" | env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  "${TEST_ENV[@]}" "$(base v1)" bash -s -- --dry-run > "$LOG" 2>&1
RC=$?
expect_ok "piped with arguments (bash -s -- --dry-run) succeeds"

section "unit files are valid for systemd"
reset_state
run "${TEST_ENV[@]}" "$(base v1)" NO_START=1
if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd > /tmp/apt-systemd.log 2>&1; then
  systemd-analyze verify "$UNIT" > "$LOG" 2>&1
  SA_RC=$?
  # Only complaints about this unit count (the container has no other units / no running manager).
  if grep -E "rougechain-validator\.service" "$LOG" | grep -qiE "unknown|invalid|failed to parse|not executable|ignoring|bad"; then
    bad "systemd-analyze verify: problems reported for the unit (exit $SA_RC)"
  else
    : > "$LOG"; ok "systemd-analyze verify: no unknown or invalid directives ($(systemd --version | head -n 1))"
  fi
  systemd-analyze verify "$UPD_UNIT" "$UPD_TIMER" > "$LOG" 2>&1
  SA_RC=$?
  if grep -E "rougechain-update\.(service|timer)" "$LOG" | grep -qiE "unknown|invalid|failed to parse|not executable|ignoring|bad"; then
    bad "systemd-analyze verify: problems reported for the auto-update service/timer (exit $SA_RC)"
  else
    : > "$LOG"; ok "systemd-analyze verify: auto-update service + timer have no unknown or invalid directives"
  fi
  if systemd-analyze calendar hourly > "$LOG" 2>&1; then : > "$LOG"; ok "systemd-analyze calendar: 'hourly' is a valid OnCalendar value"; else bad "systemd-analyze calendar hourly"; fi
else
  cp /tmp/apt-systemd.log "$LOG"; bad "could not install systemd to verify the unit"
fi

# shellcheck disable=SC1091
printf '\n%s: %d passed, %d failed\n' "$(. /etc/os-release && echo "$ID $VERSION_ID")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
