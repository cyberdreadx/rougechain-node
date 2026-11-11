#!/usr/bin/env bash
# Builds the IDE's local test chain (the node's contract VM compiled to WebAssembly) and writes the
# browser bindings into apps/site-next/src/ide/vm/, which IS committed: the site's Netlify build has
# no Rust toolchain. Rebuild and commit whenever core/vm or this crate changes.
#
#   ./build.sh               # release .wasm + browser bindings (needs wasm-bindgen-cli)
#   CARGO_JOBS=1 ./build.sh  # limit build parallelism
#
# Needs: rustup target `wasm32-unknown-unknown`; `wasm-bindgen` (wasm-bindgen-cli) at EXACTLY the
# version of the `wasm-bindgen` crate in core/Cargo.lock.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
OUT=../../apps/site-next/src/ide/vm

# Size for this build only (the workspace's release profile is the node's and is left alone).
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-fat}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-1}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${CARGO_PROFILE_RELEASE_OPT_LEVEL:-s}"
export CARGO_PROFILE_RELEASE_DEBUG=false

cargo build --release --locked --target "$TARGET" -p quantum-vault-vm-wasm ${CARGO_JOBS:+-j "$CARGO_JOBS"}
TARGET_DIR="${CARGO_TARGET_DIR:-../target}"
WASM="$TARGET_DIR/$TARGET/release/quantum_vault_vm_wasm.wasm"

WANT=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' ../Cargo.lock)
HAVE=$(wasm-bindgen --version | awk '{print $2}')
if [ "$WANT" != "$HAVE" ]; then
  echo "wasm-bindgen-cli $HAVE does not match the lock file ($WANT):" >&2
  echo "  cargo install wasm-bindgen-cli --version $WANT --locked" >&2
  exit 1
fi
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" "$WASM"
echo "wrote $OUT ($(wc -c < "$OUT/quantum_vault_vm_wasm_bg.wasm") bytes wasm)"
