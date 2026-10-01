#!/usr/bin/env bash
#
# End-to-end test of scripts/install-validator.sh in Docker.
#
#   scripts/release/test-installer.sh                  # ubuntu:24.04 + debian:12 + ubuntu:22.04
#   IMAGES="debian:12" scripts/release/test-installer.sh
#   REAL_BINARY=/srv/rougechain-releases/quantum-vault-daemon-<…> scripts/release/test-installer.sh
#
# It generates throw-away TEST release keys, signs fixture manifests with the real tooling
# (make-manifest / sign-manifest), serves them with a small fake node binary from a local HTTP
# server on a private Docker network, and runs the installer in fresh containers (no systemd:
# NO_START=1; files, permissions and the unit are checked instead). The matrix is in
# test/installer-scenarios.sh. Exit code: 0 only if every check in every image passed.
#
# REAL_BINARY (optional): also install the REAL node binary (with core/daemon/genesis-mainnet.json),
#   let it generate its key, then run the unit's exact ExecStart as the service user on a
#   read-only root filesystem with no capabilities and no-new-privileges (an approximation of
#   the unit's sandbox — real systemd is not available in a container) and wait for /api/health.
#   REAL_SYNC=1 additionally lets it sync from the public mainnet node (read-only traffic) and
#   requires it to reach REAL_SYNC_MIN_HEIGHT (default 200).
# REAL_CLI (optional, with REAL_BINARY): also ship the REAL rougechain CLI in that release and
#   run the printed `sudo -u rougechain rougechain --node-keys … whoami` (offline) — with
#   REAL_SYNC=1 also `validator-status` (read-only requests to the public mainnet API).
# KEEP_IMAGES=1: do not remove images this run pulled.
#
# Needs: docker, Node.js >= 20 (and `npm ci` in scripts/release — done automatically).
# Everything it creates is named rc-inst-test-* and removed on exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGES="${IMAGES:-ubuntu:24.04 debian:12 ubuntu:22.04}"
WEB_IMAGE="busybox:1.36"
NET="rc-inst-test-net"
WEB="rc-inst-test-web"
WEB_URL="http://$WEB:8080"
DOWN_URL="http://$WEB:8081"
REAL_IMAGE="rc-inst-test-real-img"
PASSPHRASE="installer-test-passphrase"
TMP="$(mktemp -d)"
PULLED=()

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
cleanup() {
  local rc=$?
  docker rm -f -v "$WEB" rc-inst-test-run rc-inst-test-real > /dev/null 2>&1 || true
  docker rmi -f "$REAL_IMAGE" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  if [ "${KEEP_IMAGES:-0}" != 1 ] && [ ${#PULLED[@]} -gt 0 ]; then
    docker rmi "${PULLED[@]}" > /dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

ensure_image() {
  if ! docker image inspect "$1" > /dev/null 2>&1; then
    echo "pulling $1"
    docker pull -q "$1" > /dev/null
    PULLED+=("$1")
  fi
}

command -v docker > /dev/null || { echo "docker is required" >&2; exit 1; }
command -v node > /dev/null || { echo "Node.js >= 20 is required" >&2; exit 1; }
if [ ! -d "$HERE/node_modules/@noble/post-quantum" ]; then
  say "installing release tooling dependencies (npm ci)"
  (cd "$HERE" && npm ci --no-audit --no-fund > /dev/null)
fi

# ── fixtures ─────────────────────────────────────────────────────────────────
say "building fixtures (TEST keys, fake binaries, signed manifests)"
WWW="$TMP/www"; CTX="$TMP/ctx"; FILES="$WWW/files"
mkdir -p "$FILES/v1" "$FILES/v2" "$FILES/tampered" "$FILES/short" "$FILES/badgenesis" "$WWW/rel" "$CTX/shims"
export RELEASE_KEY_PASSPHRASE="$PASSPHRASE"
tool() { node "$HERE/$1" "${@:2}" > "$TMP/tool.log" 2>&1 || { cat "$TMP/tool.log" >&2; echo "fixture step failed: $*" >&2; exit 1; }; }

tool keygen.mjs --out "$TMP/test-keys.json" --pub-dir "$CTX/keys"
tool keygen.mjs --out "$TMP/other-keys.json" --pub-dir "$TMP/other-keys"

# A stand-in for quantum-vault-daemon: implements only what the installer invokes
# (--print-state-digest initialises the data dir and creates node-keys.json if absent).
fake_binary() { # fake_binary TAG DEST
  cat > "$2" <<FAKE
#!/bin/bash
# fake quantum-vault-daemon ($1) for installer tests
dd=""; digest=0
while [ \$# -gt 0 ]; do
  case "\$1" in --data-dir) dd="\$2"; shift ;; --print-state-digest) digest=1 ;; esac
  shift
done
if [ "\$digest" = 1 ]; then
  [ -d "\$dd" ] || exit 3
  if [ ! -e "\$dd/node-keys.json" ]; then
    pk="\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '{"algorithm":"ML-DSA-65","public_key_hex":"%s","secret_key_hex":"TEST-ONLY-%s"}\n' "\$pk" "\$pk" > "\$dd/node-keys.json"
  fi
  mkdir -p "\$dd/chain-db"; echo '{"fake":"$1"}'; exit 0
fi
echo "fake daemon $1"; exit 0
FAKE
  chmod 0755 "$2"
}
# A stand-in for the rougechain CLI: --version, and `whoami` reads the --node-keys file.
fake_cli() { # fake_cli TAG DEST
  cat > "$2" <<FAKE
#!/bin/bash
# fake rougechain CLI ($1) for installer tests
keys=""; rpc=""; cmd=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --version) echo "rougechain fake-$1"; exit 0 ;;
    --node-keys) keys="\$2"; shift ;;
    --rpc) rpc="\$2"; shift ;;
    *) cmd="\$1" ;;
  esac
  shift
done
pk="\$(sed -n 's/.*"public_key_hex":"\([0-9a-f]*\)".*/\1/p' "\$keys")" || exit 4
[ -n "\$pk" ] || { echo "Failed to read node-keys file \$keys" >&2; exit 4; }
echo "cmd=\$cmd rpc=\$rpc user=\$(id -un) Address: rouge1test\${pk:0:12}"
FAKE
  chmod 0755 "$2"
}
NAME="quantum-vault-daemon-test"
CLI_NAME="rougechain-test"
fake_cli "v1" "$FILES/v1/$CLI_NAME"
fake_cli "v2" "$FILES/v2/$CLI_NAME"
fake_cli "vX" "$FILES/tampered/$CLI_NAME"                   # same size as v1, different bytes
[ "$(stat -c %s "$FILES/v1/$CLI_NAME")" = "$(stat -c %s "$FILES/tampered/$CLI_NAME")" ] || { echo "fixture error: tampered cli size differs" >&2; exit 1; }
# A mirror that answers like GitHub release assets do: 302 to the real location.
mkdir -p "$WWW/cgi-bin"
# shellcheck disable=SC2016
printf '#!/bin/sh\nprintf '"'"'HTTP/1.0 302 Found\\r\\nLocation: http://rc-inst-test-web:8080/files/%%s\\r\\n\\r\\n'"'"' "$QUERY_STRING"\n' > "$WWW/cgi-bin/dl"
chmod 0755 "$WWW/cgi-bin/dl"
fake_binary "v1" "$FILES/v1/$NAME"
fake_binary "v2" "$FILES/v2/$NAME"
fake_binary "vX" "$FILES/tampered/$NAME"                    # same size as v1, different bytes
head -c 100 "$FILES/v1/$NAME" > "$FILES/short/$NAME"        # different size
[ "$(stat -c %s "$FILES/v1/$NAME")" = "$(stat -c %s "$FILES/tampered/$NAME")" ] || { echo "fixture error: tampered binary size differs" >&2; exit 1; }
printf '{"chain_id":"rougechain-mainnet-1","genesis_time":1}\n' > "$FILES/genesis-mainnet.json"
printf '{"chain_id":"rougechain-mainnet-1","genesis_time":2}\n' > "$FILES/badgenesis/genesis-mainnet.json"
# shellcheck disable=SC2016
printf '#!/bin/sh\nif [ "$1" = "-m" ]; then echo aarch64; else exec /usr/bin/uname "$@"; fi\n' > "$CTX/shims/uname"
chmod 0755 "$CTX/shims/uname"

# release DIR NETWORK VERSION BINARY_FILE [make-manifest args…] — make + sign into www/rel/DIR
release() {
  local dir="$WWW/rel/$1" net="$2" ver="$3" bin="$4"
  shift 4
  mkdir -p "$dir"
  tool make-manifest.mjs --allow-http --network "$net" --version "$ver" --released 2026-10-01 \
    --binary "$bin" --source-commit 0000000 --mandatory --upgrade-before-height 235 \
    --activation token_minting=235 --out "$dir/manifest-$net.json" "$@"
  tool sign-manifest.mjs --allow-http --yes --key "$TMP/test-keys.json" "$dir/manifest-$net.json"
}
GEN=(--genesis "$FILES/genesis-mainnet.json" --genesis-url "$WEB_URL/files/genesis-mainnet.json")
CLI1=(--cli "$FILES/v1/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/v1/$CLI_NAME")
CLI2=(--cli "$FILES/v2/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/v2/$CLI_NAME")
MF="manifest-mainnet.json"

release v1 mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" "${GEN[@]}" "${CLI1[@]}"
release v2 mainnet 9.1.0 "$FILES/v2/$NAME" --binary-url "$WEB_URL/files/v2/$NAME" "${GEN[@]}" "${CLI2[@]}"
# a release without the CLI (cli: null), and one newer than v2 that drops it again
release nocli mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" "${GEN[@]}" --no-cli
# the CLI served does not match the signed manifest (same size, different bytes; no mirror)
release badcli mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" "${GEN[@]}" \
  --cli "$FILES/v1/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$WEB_URL/files/tampered/$CLI_NAME"
# GitHub-style mirrors: primaries down, every mirror answers 302 → the file
release redirect mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$DOWN_URL/files/v1/$NAME" --binary-mirror "$WEB_URL/cgi-bin/dl?v1/$NAME" \
  --cli "$FILES/v1/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$DOWN_URL/files/v1/$CLI_NAME" --cli-mirror "$WEB_URL/cgi-bin/dl?v1/$CLI_NAME" \
  --genesis "$FILES/genesis-mainnet.json" --genesis-url "$DOWN_URL/files/genesis-mainnet.json" --genesis-mirror "$WEB_URL/cgi-bin/dl?genesis-mainnet.json"
# a redirecting mirror that leads to a tampered file must still be refused
release badredirect mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$DOWN_URL/files/v1/$NAME" --binary-mirror "$WEB_URL/cgi-bin/dl?tampered/$NAME" "${GEN[@]}" --no-cli
# forged: edited after signing (still schema-valid)
mkdir -p "$WWW/rel/forged"; cp "$WWW/rel/v1/$MF.ed25519.sig" "$WWW/rel/forged/"
sed 's#/files/v1/#/files/tampered/#' "$WWW/rel/v1/$MF" > "$WWW/rel/forged/$MF"
cmp -s "$WWW/rel/v1/$MF" "$WWW/rel/forged/$MF" && { echo "fixture error: forged manifest is identical" >&2; exit 1; }
# wrongkey: properly signed, but by a key the installer does not trust
mkdir -p "$WWW/rel/wrongkey"; cp "$WWW/rel/v1/$MF" "$WWW/rel/wrongkey/"
tool sign-manifest.mjs --allow-http --yes --key "$TMP/other-keys.json" "$WWW/rel/wrongkey/$MF"
# garbage / truncated / missing / other-manifest signatures
mkdir -p "$WWW/rel/garbage" "$WWW/rel/truncsig" "$WWW/rel/nosig" "$WWW/rel/othersig"
for d in garbage truncsig nosig othersig; do cp "$WWW/rel/v1/$MF" "$WWW/rel/$d/"; done
echo "this is not a signature" > "$WWW/rel/garbage/$MF.ed25519.sig"
base64 -d "$WWW/rel/v1/$MF.ed25519.sig" | head -c 63 | base64 -w 0 > "$WWW/rel/truncsig/$MF.ed25519.sig"
cp "$WWW/rel/v2/$MF.ed25519.sig" "$WWW/rel/othersig/$MF.ed25519.sig"
# validly signed manifests whose files do not match
release badsha mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/tampered/$NAME" "${GEN[@]}" "${CLI1[@]}"
release badsize mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/short/$NAME" "${GEN[@]}" --no-cli
release badgenesis mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" "${CLI1[@]}" \
  --genesis "$FILES/genesis-mainnet.json" --genesis-url "$WEB_URL/files/badgenesis/genesis-mainnet.json" --genesis-mirror "$WEB_URL/files/missing.json"
# mirrors: primary down, 404, tampered, then good
release mirror mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$DOWN_URL/files/v1/$NAME" \
  --binary-mirror "$WEB_URL/files/missing/$NAME" --binary-mirror "$WEB_URL/files/tampered/$NAME" --binary-mirror "$WEB_URL/files/v1/$NAME" \
  --cli "$FILES/v1/$CLI_NAME" --cli-name "$CLI_NAME" --cli-url "$DOWN_URL/files/v1/$CLI_NAME" \
  --cli-mirror "$WEB_URL/files/tampered/$CLI_NAME" --cli-mirror "$WEB_URL/files/v1/$CLI_NAME" \
  --genesis "$FILES/genesis-mainnet.json" --genesis-url "$WEB_URL/files/missing.json" --genesis-mirror "$WEB_URL/files/genesis-mainnet.json"
release mininst mainnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" "${GEN[@]}" --no-cli --min-installer-version 99.0.0
release testnet testnet 9.0.0 "$FILES/v1/$NAME" --binary-url "$WEB_URL/files/v1/$NAME" --no-genesis "${CLI1[@]}"
# wrongnet: a correctly signed TESTNET manifest served under the mainnet file name
mkdir -p "$WWW/rel/wrongnet"
cp "$WWW/rel/testnet/manifest-testnet.json" "$WWW/rel/wrongnet/$MF"
cp "$WWW/rel/testnet/manifest-testnet.json.ed25519.sig" "$WWW/rel/wrongnet/$MF.ed25519.sig"

# Every fixture that is meant to be validly signed must pass the real verifier (both signatures).
for d in v1 v2 nocli badcli redirect badredirect badsha badsize badgenesis mirror mininst; do
  tool verify-manifest.mjs --allow-http --keys-dir "$CTX/keys" "$WWW/rel/$d/$MF"
done
tool verify-manifest.mjs --allow-http --keys-dir "$CTX/keys" "$WWW/rel/testnet/manifest-testnet.json"
if node "$HERE/verify-manifest.mjs" --allow-http --keys-dir "$CTX/keys" "$WWW/rel/forged/$MF" > /dev/null 2>&1; then
  echo "fixture error: the forged manifest verifies" >&2; exit 1
fi

REAL=0
if [ -n "${REAL_BINARY:-}" ]; then
  [ -f "$REAL_BINARY" ] || { echo "REAL_BINARY: $REAL_BINARY not found" >&2; exit 1; }
  REAL=1
  mkdir -p "$FILES/real"
  cp "$REAL_BINARY" "$FILES/real/quantum-vault-daemon-real"
  chmod 0755 "$FILES/real/quantum-vault-daemon-real"
  cp "$REPO/core/daemon/genesis-mainnet.json" "$FILES/real/genesis-mainnet.json"
  REAL_CLI_ARGS=(--no-cli)
  if [ -n "${REAL_CLI:-}" ]; then
    [ -f "$REAL_CLI" ] || { echo "REAL_CLI: $REAL_CLI not found" >&2; exit 1; }
    cp "$REAL_CLI" "$FILES/real/rougechain-real"
    chmod 0755 "$FILES/real/rougechain-real"
    REAL_CLI_ARGS=(--cli "$FILES/real/rougechain-real" --cli-name rougechain-real --cli-url "$WEB_URL/files/real/rougechain-real")
  fi
  release real mainnet 9.0.0 "$FILES/real/quantum-vault-daemon-real" --binary-url "$WEB_URL/files/real/quantum-vault-daemon-real" \
    --genesis "$FILES/real/genesis-mainnet.json" --genesis-url "$WEB_URL/files/real/genesis-mainnet.json" "${REAL_CLI_ARGS[@]}"
fi
mkdir -p "$WWW/installer" && cp "$REPO/scripts/install-validator.sh" "$WWW/installer/"   # for the `curl | bash` scenario
chmod -R a+rX "$TMP"

# ── fixture server ───────────────────────────────────────────────────────────
say "starting the fixture server"
ensure_image "$WEB_IMAGE"
docker rm -f "$WEB" > /dev/null 2>&1 || true
docker network rm "$NET" > /dev/null 2>&1 || true
docker network create "$NET" > /dev/null
docker run -d --name "$WEB" --network "$NET" -v "$WWW:/www:ro" "$WEB_IMAGE" httpd -f -p 8080 -h /www > /dev/null

# ── matrix ───────────────────────────────────────────────────────────────────
FAILED=()
SUMMARY=()
for image in $IMAGES; do
  say "installer scenarios on $image"
  ensure_image "$image"
  log="$TMP/run-${image//[:\/]/-}.log"
  if docker run --rm --name rc-inst-test-run --network "$NET" -e WEB="$WEB_URL" \
      -v "$REPO/scripts:/src:ro" -v "$CTX:/ctx:ro" "$image" bash /src/release/test/installer-scenarios.sh > "$log" 2>&1; then
    result="PASS"
  else
    result="FAIL"; FAILED+=("$image")
  fi
  if [ "$result" = "FAIL" ] || [ "${VERBOSE:-0}" = 1 ]; then cat "$log"; else grep -E "^\[|FAIL" "$log" | tr '\n' ' '; echo; fi
  SUMMARY+=("$result  $image  — $(tail -n 1 "$log")")
done

# ── optional: the real node binary ───────────────────────────────────────────
if [ "$REAL" = 1 ]; then
  image="${IMAGES%% *}"
  say "real binary on $image: install + key generation"
  log="$TMP/real.log"
  cat > "$CTX/real.sh" <<'REALSH'
set -euo pipefail
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  ROUGECHAIN_INSTALLER_TEST=1 ROUGECHAIN_INSTALLER_TEST_PUBKEY_FILE=/ctx/keys/release-ed25519.pub.pem \
  RELEASE_BASE_URLS="$WEB/rel/real" NO_START=1 NODE_NAME=installer-test bash /src/install-validator.sh 2>&1 | tee /tmp/install.log
K=/var/lib/rougechain/mainnet/node-keys.json
test "$(stat -c '%a %U' $K)" = "600 rougechain"
test "$(jq -r '.public_key_hex | length' $K)" = 3904
/usr/local/bin/quantum-vault-daemon --version
if [ "${HAVE_REAL_CLI:-0}" = 1 ]; then
  # The exact command form the installer prints: the CLI, as the service user, reading the 0600 node key.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo > /dev/null
  test "$(stat -c '%a %U:%G' /usr/local/bin/rougechain)" = "755 root:root"
  /usr/local/bin/rougechain --version
  who="$(sudo -u rougechain rougechain --rpc https://api.rougechain.io --node-keys $K whoami)"
  echo "$who"
  echo "$who" | grep -q '^Address: rouge1'
  grep -q "sudo -u rougechain rougechain --rpc https://api.rougechain.io --node-keys $K stake 10000" /tmp/install.log
  if [ "${REAL_SYNC:-0}" = 1 ]; then
    # read-only requests to the public mainnet API
    sudo -u rougechain rougechain --rpc https://api.rougechain.io --node-keys $K validator-status | tee /tmp/vs.log
    grep -q 'RPC height: *[0-9]' /tmp/vs.log
  fi
fi
# anything the daemon or the CLI wrote outside the data dir?
stray="$(find / -xdev -user rougechain -not -path '/proc/*' -not -path '/var/lib/rougechain*' 2>/dev/null | head -n 5)"
test -z "$stray" || { echo "daemon wrote outside its data dir: $stray"; exit 1; }
# The unit's ExecStart (continuation lines joined), for the sandboxed run below.
awk '/^ExecStart=/{f=1; sub(/^ExecStart=/,"")} f{l=$0; c=sub(/\\$/,"",l); printf "%s ", l; if(!c) exit}' \
  /etc/systemd/system/rougechain-validator.service > /etc/rougechain/mainnet/execstart
REALSH
  docker rm -f rc-inst-test-real > /dev/null 2>&1 || true
  have_cli=0; if [ -n "${REAL_CLI:-}" ]; then have_cli=1; fi
  if docker run --name rc-inst-test-real --network "$NET" -e WEB="$WEB_URL" -e HAVE_REAL_CLI="$have_cli" -e REAL_SYNC="${REAL_SYNC:-0}" \
      -v "$REPO/scripts:/src:ro" -v "$CTX:/ctx:ro" "$image" bash /ctx/real.sh > "$log" 2>&1; then
    SUMMARY+=("PASS  real binary: installs, generates a 0600 ML-DSA-65 node key, writes nothing outside its data dir")
    if [ "$have_cli" = 1 ]; then
      SUMMARY+=("PASS  real CLI: installed 0755; 'sudo -u rougechain rougechain --node-keys … whoami' -> $(grep -m 1 '^Address: ' "$log" | cut -c 1-40)…")
    fi
    # Snapshot the installed system, then run the unit's ExecStart from it under restrictions
    # close to the unit's sandbox: read-only root, only the data dir writable, no capabilities,
    # no-new-privileges, the service user.
    docker commit rc-inst-test-real "$REAL_IMAGE" > /dev/null
    docker rm -f rc-inst-test-real > /dev/null
    say "real binary: the unit's ExecStart on a read-only filesystem, no capabilities, no-new-privileges"
    # shellcheck disable=SC2016
    run_cmd='umask 077; cmd="$(cat /etc/rougechain/mainnet/execstart)"; echo "ExecStart: $cmd"; exec $cmd'
    if [ "${REAL_SYNC:-0}" != 1 ]; then
      # No outside traffic: replace the peer with an address nothing listens on.
      # shellcheck disable=SC2016
      run_cmd='umask 077; cmd="$(sed "s#--peers [^ ]*#--peers http://127.0.0.1:9#" /etc/rougechain/mainnet/execstart)"; echo "ExecStart: $cmd"; exec $cmd'
    fi
    docker run -d --name rc-inst-test-real --read-only --cap-drop ALL --security-opt no-new-privileges \
      --user rougechain --tmpfs /tmp:rw,noexec,nosuid -e HOME=/var/lib/rougechain/mainnet -w /var/lib/rougechain/mainnet \
      -v /var/lib/rougechain/mainnet "$REAL_IMAGE" sh -c "$run_cmd" > /dev/null
    http_get() { docker exec rc-inst-test-real bash -c 'exec 3<>/dev/tcp/127.0.0.1/5100 && printf "GET $1 HTTP/1.0\r\nHost: x\r\n\r\n" >&3 && cat <&3' _ "$1" 2>/dev/null; }
    healthy=0
    for _ in $(seq 1 45); do
      if http_get /api/health | grep -q "200 OK"; then healthy=1; break; fi
      [ "$(docker inspect -f '{{.State.Running}}' rc-inst-test-real 2>/dev/null)" = "true" ] || break
      sleep 2
    done
    height=0
    if [ "$healthy" = 1 ] && [ "${REAL_SYNC:-0}" = 1 ]; then
      for _ in $(seq 1 60); do
        height="$(http_get /api/stats | tail -n 1 | sed -n 's/.*"network_height":\([0-9]*\).*/\1/p')"
        [ "${height:-0}" -ge "${REAL_SYNC_MIN_HEIGHT:-200}" ] && break
        sleep 3
      done
    fi
    stats="$(http_get /api/stats | tail -n 1 | head -c 700 || true)"
    running="$(docker inspect -f '{{.State.Running}}' rc-inst-test-real 2>/dev/null || echo false)"
    docker logs rc-inst-test-real > "$TMP/real-run.log" 2>&1 || true
    docker rm -f -v rc-inst-test-real > /dev/null 2>&1 || true
    head -n 1 "$TMP/real-run.log"
    echo "stats: $stats"
    if [ "$healthy" != 1 ] || [ "$running" != "true" ]; then
      tail -n 40 "$TMP/real-run.log"; FAILED+=("real-run"); SUMMARY+=("FAIL  real binary: ExecStart did not become healthy")
    elif [ "${REAL_SYNC:-0}" = 1 ] && [ "${height:-0}" -lt "${REAL_SYNC_MIN_HEIGHT:-200}" ]; then
      tail -n 40 "$TMP/real-run.log"; FAILED+=("real-sync"); SUMMARY+=("FAIL  real binary: did not sync past height ${REAL_SYNC_MIN_HEIGHT:-200} (reached ${height:-0})")
    else
      synced=""
      if [ "${REAL_SYNC:-0}" = 1 ]; then synced="; synced mainnet to height $height"; fi
      SUMMARY+=("PASS  real binary: ExecStart runs read-only / no capabilities / no-new-privileges as 'rougechain'; /api/health 200$synced")
    fi
  else
    cat "$log"; FAILED+=("real-install"); SUMMARY+=("FAIL  real binary install")
  fi
fi

say "summary"
printf '  %s\n' "${SUMMARY[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "ALL INSTALLER TESTS PASSED"
