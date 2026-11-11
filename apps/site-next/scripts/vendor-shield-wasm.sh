#!/usr/bin/env bash
# Regenerates src/shield/vendor/ — the wasm-bindgen `--target web` package of
# core/shield-v2-wasm that the /shield page loads in its Web Worker — and prints the sha256 of
# every file for src/shield/vendor/VENDORED.md.
#
#   apps/site-next/scripts/vendor-shield-wasm.sh
#
# Needs what core/shield-v2-wasm/build.sh needs: the rustup target wasm32-unknown-unknown and
# wasm-bindgen-cli at EXACTLY the version core/Cargo.lock pins (0.2.128). The build uses
# build.sh's profile (fat LTO, one codegen unit). On a shared host run it inside a memory /
# CPU-limited scope, e.g.
#   systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 \
#     nice -n 19 env CARGO_JOBS=1 apps/site-next/scripts/vendor-shield-wasm.sh
# The script deletes the Cargo target directory and pkg/ it created when it is done.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
crate="$repo/core/shield-v2-wasm"
vendor="$here/../src/shield/vendor"

target_existed=0
[ -d "$repo/core/target" ] && target_existed=1

CARGO_JOBS="${CARGO_JOBS:-1}" "$crate/build.sh"

files=(quantum_vault_shield_v2_wasm.js quantum_vault_shield_v2_wasm.d.ts quantum_vault_shield_v2_wasm_bg.wasm quantum_vault_shield_v2_wasm_bg.wasm.d.ts)
for f in "${files[@]}"; do
  cp "$crate/pkg/$f" "$vendor/$f"
done
rm -rf "$crate/pkg"
if [ "$target_existed" = "0" ]; then
  rm -rf "$repo/core/target"
fi

echo "source commit: $(git -C "$repo" log -1 --format=%H -- core/shield-v2-wasm core/shield-v2-wallet core/shield-v2 core/types core/Cargo.lock)"
( cd "$vendor" && sha256sum "${files[@]}" && wc -c "${files[@]}" )
