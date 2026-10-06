#!/usr/bin/env bash
# Builds the WebAssembly package of the shielded pool V2 wallet core into ./pkg.
# ./pkg is generated output and is NOT committed (see .gitignore).
#
#   ./build.sh            # release .wasm + JavaScript/TypeScript bindings (needs wasm-bindgen-cli)
#   WASM_ONLY=1 ./build.sh   # the .wasm alone (needs only the rustup target)
#   CARGO_JOBS=1 ./build.sh  # limit build parallelism
#
# Needs: rustup target `wasm32-unknown-unknown`; `wasm-bindgen` (wasm-bindgen-cli) at EXACTLY the
# version of the `wasm-bindgen` crate in core/Cargo.lock; optionally `wasm-opt` (binaryen).
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
PKG=quantum-vault-shield-v2-wasm
OUT=pkg

if ! rustup target list --installed | grep -qx "$TARGET"; then
  echo "missing rustup target: rustup target add $TARGET" >&2
  exit 1
fi

# Size and speed for this build only (the workspace's release profile is the node's and is left
# alone): whole-program optimisation, one codegen unit, no debug info.
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-fat}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-1}"
export CARGO_PROFILE_RELEASE_DEBUG=false

cargo build --release --locked --target "$TARGET" -p "$PKG" ${CARGO_JOBS:+-j "$CARGO_JOBS"}
WASM="../target/$TARGET/release/quantum_vault_shield_v2_wasm.wasm"
echo "built $WASM ($(wc -c < "$WASM") bytes)"

if [ "${WASM_ONLY:-0}" = "1" ]; then
  exit 0
fi

WANT=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' ../Cargo.lock)
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen-cli is not installed. Install the version the lock file pins:" >&2
  echo "  cargo install wasm-bindgen-cli --version $WANT --locked" >&2
  exit 2
fi
HAVE=$(wasm-bindgen --version | awk '{ print $2 }')
if [ "$HAVE" != "$WANT" ]; then
  echo "wasm-bindgen-cli is $HAVE but core/Cargo.lock pins wasm-bindgen $WANT; they must match" >&2
  exit 2
fi

rm -rf "$OUT"
# `web`: an ES module with an explicit async init — works in a page, a Web Worker and an
# extension service worker. Bundlers consume it as well.
wasm-bindgen --target web --out-dir "$OUT" "$WASM"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 -o "$OUT/quantum_vault_shield_v2_wasm_bg.wasm" "$OUT/quantum_vault_shield_v2_wasm_bg.wasm"
fi
ls -l "$OUT"
