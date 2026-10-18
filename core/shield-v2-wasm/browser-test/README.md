# Browser harness — the shielded pool V2 WebAssembly package in a real browser

First run of `core/shield-v2-wasm` (wasm-bindgen `--target web`) in a browser: headless Chromium,
main thread and a module Web Worker, against the wallet test vectors, with every proof the browser
built checked natively by the node's own code. No site UI, no network node.

| File | What |
|---|---|
| `index.html` | the page (a button for a manual run; the driver calls `window.harness.*`) |
| `harness.mjs` | main-thread module: instantiate, keys, scan / confirm, malformed corpus, secrecy checks; drives the worker |
| `worker.mjs` | module Web Worker: instantiates the package and proves (`build_shield` / `build_transfer` / `build_unshield`); counts `crypto.getRandomValues` and `Math.random` |
| `run.mjs` | Playwright driver: static server on 127.0.0.1 (random port), headless Chromium, hands the envelopes to the verifier, prints the result |
| `verifier/` | native verifier (Rust, its own workspace): **`core/daemon/src/shield_v2.rs` compiled in verbatim** (`#[path]`) + `quantum-vault-shield-v2` with its default features (no prover) |

## How to run

```sh
cd core/shield-v2-wasm
cargo install --locked wasm-bindgen-cli --version 0.2.128   # = the wasm-bindgen crate in core/Cargo.lock
CARGO_JOBS=1 ./build.sh                                      # → pkg/ (gitignored)

cd browser-test/verifier
cp ../../../Cargo.lock .                                     # the node's versions (the copy is gitignored)
CARGO_TARGET_DIR=../../../target cargo build --release -j 1

cd ..
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
CHROMIUM_LIBS=/path/to/extra/libs \
node run.mjs --verifier ../../target/release/shield-v2-browser-verifier --out /tmp/result.json
```

On the production host everything ran inside
`systemd-run --user --scope -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice -n 19`,
cargo with `-j 1`, Playwright/Chromium from `~/pw-check` with its extracted system libraries.
Exit code 0 = every check passed. Delete `core/target` afterwards.

## What is checked

**a. Instantiate.** `init({ module_or_path })` on the main thread and inside a `type: "module"`
worker; all 26 exports present.

**b. Keys.** For both vector wallets: the BIP-39 seed from the phrase (Web Crypto PBKDF2) equals
`bip39_seed`; `shielded_address`, `parse_address`, `export_scan_key` (with and without `nk`)
against `keys.json`; the address decoded (bech32m in JS) into version, pk, ek and check, and every
derived value of `keys.json` recomputed (`address_check`, `address_bytes_sha256`,
`address_payload_sha256`, fingerprint, `ml_kem_768_dk_sha256`, ek and z inside dk, `*_elements`).
21 of the 26 fields per wallet are checked; the other five (`sk`, `sk_okm`, `sk_elements` and the
two HKDF labels) are not exposed by any export — by design.

**c. Scan.** The vector chain (`transactions.json`: shield @3, transfer @4, unshield @5) served
the way a node serves it — one `/api/shield-v2/notes` page per block and one
`/api/shield-v2/stats` body per height, both as **raw body strings**, the report's
`ciphertext_acc` computed in JS with the node's formula — and fed through `scan` (page by page,
`confirm_state` with three configured nodes after each block), `scan_pages` (one call) and a
viewing-key-only scan. Balances after every block match the vectors (wallet-1: 9 → 3 → 0.5 XRGE;
wallet-2: 0 → 5 → 5), the wallet's tree root and nullifier hash equal `state_root.json`, its
ciphertext hash equals the JS one, one node's report alone confirms nothing. Plus a foreign
listing (16 pages × 8 transactions of random, nobody's outputs) for timing.

**d. Prove in the worker.** From the confirmed wallet-2 state the harness built (configured nodes,
`assert_sole_copy`, scanned and confirmed at the tip): three shields, three transfers, three
unshields, each timed. `crypto.getRandomValues` is wrapped and counted (2 calls, 64 bytes per
proof), `Math.random` is wrapped (0 calls), a 20 ms timer on the UI thread measures how long it is
ever starved while the worker proves.

**e. Native verification.** Every envelope → `serde_json` → `TxV1` → the node's
`shield_v2_tx_rule` at height 6, chain `rougechain-devnet-1` (checks 1–12 of spec §3.6) →
public inputs recomputed from the body equal the browser's → `verify_proof` / `verify_spend` →
`Pool::validate_block` against the pool state reached by replaying the vector chain (itself
checked against `state_root.json` at every height). The shield gets a placeholder signature via
`attach_signature`: the stateless rule does not verify signatures (the daemon's signature path
does), and no ML-DSA key is involved here.

**f. Malformed input.** The native corpus of `tests/api.rs` (`malformed_input_is_an_error_never_a_panic`)
ported to JS, extended to the five exports it does not name and to browser-side strings (lone
surrogate, 10,000-deep nesting, a 1 MiB member): 1,184 calls over all 26 exports, every expected
refusal a coded error (`code: …`), no `WebAssembly.RuntimeError`, the module still correct after.

**g. Secrets.** `console` is wrapped in both threads (and Playwright listens): the package wrote
nothing. Every result and error of every call (main thread and worker) is searched for both
wallets' `sk`, `sk_okm` and seed in hex: none.

## Results (2026-10-08)

**All figures: loaded 2-vCPU production host (AMD EPYC 7543P, shared with a running validator,
load 0.8–3.5), headless Chromium 153 (`chromium_headless_shell`), nice 19, CPUWeight 10.** Not a
quiet machine; not a phone.

| Quantity | Figure |
|---|---|
| `.wasm`, workspace release profile — rustc output / after wasm-bindgen | 2,938,154 B (gzip -9 809,203) / 2,327,505 B (gzip -9 710,444) |
| `.wasm`, `build.sh` profile (fat LTO, 1 CGU) — rustc output / after wasm-bindgen (**what `pkg/` ships**) | 2,603,911 B (gzip -9 774,478) / **2,034,492 B (gzip -9 663,050; brotli 493,350)** |
| … + `wasm-opt -O3` (binaryen 123 via `npx`, not installed) / `-Oz` | 1,736,674 B (gzip -9 611,630) / 1,723,321 B (gzip -9 612,899) |
| JS glue (`pkg/*.js`) | 38,080 B (gzip -9 5,765) |
| Instantiate (fetch + compile + instantiate), main thread | 50 – 151 ms (`import()` of the glue 5 ms) |
| Instantiate in the worker | 31 – 41 ms |
| BIP-39 seed (PBKDF2, Web Crypto) / `shielded_address` / `export_scan_key` | 1.4 – 10 ms / 0.5 – 3.4 ms / 0.3 – 0.8 ms |
| `scan` of one vector page (1 transaction) / `confirm_state` (3 reports) | 1.3 – 13 ms / 0.4 – 8.5 ms |
| `scan_pages`, 16 pages × 8 foreign tx (256 outputs, all trial-decrypted) | 83 – 110 ms ≈ 0.33 – 0.43 ms per output |
| **Prove, in the worker, median of 3** — shield / transfer / unshield | **6.83 s / 5.55 s / 5.51 s** (run 2); 7.19 / 5.68 / 5.77 s (run 1) |
| … with the `wasm-opt -O3` build | 5.53 / 5.32 / 5.32 s |
| First proof in a fresh worker (cold JIT tier-up) | 6.5 – 16.6 s |
| Proof size | 182,155 – 187,915 B |
| Peak memory: worker wasm linear memory after a proof | 397,541,376 B = **379 MiB** (1.2 MiB after instantiate; it never shrinks) |
| Peak memory: renderer process (page + worker), VmHWM | 524 – 558 MiB; RSS back to ~130 MiB after `worker.terminate()` |
| `performance.measureUserAgentSpecificMemory` | unavailable — not in a dedicated worker, and "not available" in this headless shell even on a cross-origin-isolated page; `performance.memory` main thread only (JS heap 12 MB) |
| UI thread while the worker proves | largest 20 ms-timer gap 57 – 275 ms (CPU contention on 2 cores, not blocking) |
| `verify_spend` natively (node build, release) | 5.5 – 13.5 ms, median 6.6 ms |

Against the earlier measurements: the native production prover on this host 2.85 s median
(`core/shield-v2-wallet/NOTES.md` §4) — the browser is ≈ 1.9× native; the research crate in
Node-wasm on this host 6.7 s; **SHIELD-2 on an iPhone (iOS 18.7, WebKit, 4 cores; research
prover, background worker): 3.62 s median, 377 MB wasm memory** (`research/shield2/RESULTS.md`,
addendum 2026-10-05). The idle phone was faster than this loaded 2-vCPU server; the memory figure
is the same (379 MiB here).

## Friction for a site / extension developer

1. **Import of a `--target web` package.** `import init, { … } from "…/quantum_vault_shield_v2_wasm.js"`
   then `await init({ module_or_path: wasmUrl })` — the object form; the positional form is
   deprecated and `console.warn`s. The default `init()` resolves the `.wasm` with
   `new URL("…_bg.wasm", import.meta.url)`. Vite rewrites that pattern in app source, but not after
   esbuild pre-bundling of a dependency: either `optimizeDeps.exclude` the package, or import the
   URL explicitly (`import wasmUrl from "…_bg.wasm?url"`) and pass it. Vite **workers** default to
   `worker.format: "iife"`, which cannot code-split: set `worker: { format: "es" }` and create the
   worker with `new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" })`.
   Module workers: Chrome 80, Safari 15, Firefox 114.
2. **MIME type.** `WebAssembly.instantiateStreaming` requires `application/wasm`. Netlify serves
   `.wasm` with it (this harness's server does too). But the site's SPA catch-all
   (`apps/site-next/public/_redirects`: `/* /index.html 200`) turns a wrong `.wasm` path into
   `text/html` with status 200: wasm-bindgen then warns on the console, falls back to
   `WebAssembly.instantiate` and fails with "expected magic word". Ship the `.wasm` as a hashed
   Vite asset under `/assets/` (already `immutable`-cached by `netlify.toml`).
3. **COOP/COEP: not needed.** The package uses no threads and no `SharedArrayBuffer`; everything
   passed without them. They were set only for one extra run, to try
   `measureUserAgentSpecificMemory` (unavailable anyway). Do not add them to the site for this —
   they would break cross-origin embeds.
4. **Proving takes ~5.5 s here, the first one in a fresh worker up to ~16 s.** Run every `build_*`
   in a worker; "cancel" is `worker.terminate()` (no cooperative cancel inside a proof). A proof
   result is ~0.4 MB of hex plus the state, copied by `postMessage`.
5. **Memory.** One instance grows to 379 MiB of linear memory while proving and WebAssembly never
   gives it back: terminate the worker after a payment (the renderer fell from 558 MiB peak to
   ~130 MiB) and accept the cold start of the next one, or keep one worker for a session. One proof
   at a time. Mobile Safari kills a tab that exceeds its memory budget (lower on older/low-RAM
   iPhones) and a failed `memory.grow` is a `RangeError` inside the proof; the one iPhone measured
   (377 MB) was fine; nothing lower-end was tested.
6. **The seed.** Exports that spend take the 64-byte seed as a `Uint8Array`; the module wipes its
   own copy, not the caller's — `seed.fill(0)` after the call, and do not keep it in the worker.
7. **Randomness** is `crypto.getRandomValues` only (2 calls, 64 bytes per proof; nothing in the
   scan path); `Math.random` is never called. A page must not polyfill or stub `crypto`.

## Content security policy

**Site (`apps/site-next`, served as rougechain.io by the repo-root `netlify.toml`).** Today it sends
**no CSP at all** — neither `netlify.toml` (root or `apps/site-next/`) nor `_headers` nor a
`<meta http-equiv>` in `index.html` sets one — so nothing blocks the package now, and **nothing
has to change**. If a CSP is ever added, it must contain at least:
`script-src 'self' 'wasm-unsafe-eval'` (compiling WebAssembly; Safari before 16 needs
`'unsafe-eval'` instead), `worker-src 'self'` (plus `blob:` only if the worker is inlined), and
`connect-src` allowing the origin of the `.wasm` (it is fetched).

**Extension (`apps/extension/manifest.json`, identical in `public/`).** MV3,
`"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`
— **already sufficient; no CSP change**. What must change is where the proof runs: the module
service worker (`service-worker.js`) cannot create a `Worker`, may not use dynamic `import()`, and
is stopped when idle; the popup closes (and kills its worker) when it loses focus. Prove in an
**offscreen document** (add the `"offscreen"` permission; `chrome.offscreen.createDocument({ reasons: ["WORKERS"], … })`)
or in an extension tab, with the `.wasm` and the worker script packaged in the extension
(extension pages need no `web_accessible_resources` for them).
