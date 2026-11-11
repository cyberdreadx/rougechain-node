# Vendored: the shielded pool V2 WebAssembly package

Generated output of `core/shield-v2-wasm` (wasm-bindgen `--target web`), committed here so the
site builds without a Rust toolchain. **Do not edit these files**: regenerate them with
`apps/site-next/scripts/vendor-shield-wasm.sh` and update this record.

| | |
|---|---|
| Source | `core/shield-v2-wasm` (+ `core/shield-v2-wallet`, `core/shield-v2`, `core/types`, `core/Cargo.lock`) at commit `8cd9f753d1d486888eebcd28b4bccb742f91ed4b` (the last commit touching them; `origin/main` was `57f3ec5`) |
| Built with | `core/shield-v2-wasm/build.sh` (release, fat LTO, one codegen unit, no debug info), rustc 1.94.0, target `wasm32-unknown-unknown`, `-j 1`; `wasm-bindgen` 0.2.128 (= `core/Cargo.lock`); no `wasm-opt` |
| Built on | 2026-10-08 |

| File | Bytes | sha256 |
|---|---|---|
| `quantum_vault_shield_v2_wasm_bg.wasm` | 2,034,492 | `9a7733c3896afc6401b1ef0b0731b611f85ca2416ec637d25606b12bb4773063` |
| `quantum_vault_shield_v2_wasm.js` | 38,080 | `1cf6e0878c68aacdf9d4932b34fa152d4063fa6d3db796de303395d4b6f6737e` |
| `quantum_vault_shield_v2_wasm.d.ts` | 21,694 | `455f090e11d73f0fd194d98c75691859a4e8015421ef3ec78d55f29ab745cc43` |
| `quantum_vault_shield_v2_wasm_bg.wasm.d.ts` | 3,510 | `43a2e5e06f950c4479b8a918bf0d18cfb7220557f77fdfc47c5a6a2ec49a8293` |

The `.wasm` is byte-identical in size to the `build.sh` figure in
`core/shield-v2-wasm/browser-test/README.md` (branch `feat/shield-v2-wasm-browser`).

## How the site loads it

* Only `src/shield/worker.ts` imports it — the module Web Worker of the `/shield` page — and the
  page itself is a lazy chunk that exists only when `VITE_SHIELD_V2_ENABLED=true` at build time.
* The `.wasm` is imported with `?url`, so Vite emits it as a hashed asset under `/assets/`
  (served `immutable` by `netlify.toml`, never caught by the SPA rewrite) and the worker passes
  that URL to `init({ module_or_path })` (README friction items 1 and 2).
* `vite.config.ts` sets `worker.format = "es"` (a module worker; code splitting inside it).
