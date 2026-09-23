# Transaction-integrity release (supersedes the standalone C1 branch)

Branch `consensus/tx-integrity`, based on the deployed production commit `2c0f3c2` (via the C1 draft
`9d99ccf`). **Activation scheduled: `TX_UNIQUENESS_ACTIVATION_HEIGHT = Some(90)`. Not yet deployed.**
Found by the 2026-09-23 adversarial review (C1) and by the transaction-identity check it required.

## The two defects

**D1 — signed-payload field binding (CRITICAL, remotely exploitable before containment).** A V2
transaction carries the client's signed JSON in `signed_payload`; the node verifies the ML-DSA-65
signature over that JSON, but the executable fields (`payload`, `fee`) are separate struct fields
filled in by the API handler and were never checked against the JSON at mempool admission or block
import. Anyone holding a victim's public signed payload (every V2 tx in chain history) could rewrite
recipient and amount and submit it through the unauthenticated `/api/tx/broadcast` route or, as a
staked proposer, include it in a block. PoC: forged 900 XRGE transfer accepted by both paths.
Containment on 2026-09-23: nginx returns 403 for `/api/tx/broadcast` on the primary (node #2 handled
separately by the operator).

**D2 — transaction replay (C1).** Block import never checked that a signed transaction had not
already been included; a proposer could re-include any historical signed tx and debit the sender
again; a replayed `bridge_withdraw` would halt V3 epoch building. The mempool's gap-tolerant nonce
check is bypassed by a proposer, and is itself insufficient (mainnet history has timestamp nonces and
nonce-store resets).

## The fix (daemon only)

1. **One canonical V2 mapping** — `core/daemon/src/v2_binding.rs`. `derive_v2_fields(tx_type, json)`
   reproduces, expression for expression, what the 22 `/api/v2/*` handlers did inline (transfer,
   batch transfer, create_token, mint_tokens, approve, transfer_from, create_pool, add/remove_liquidity,
   swap, stake, unstake, 7 NFT ops, shield, shielded_transfer, unshield). `build_v2_tx` is now the
   only constructor those handlers use. `verify_v2_binding(tx)` re-derives from `signed_payload` and
   requires `payload` and `fee` (and `version`, `from`) to match exactly.
   A second signed format is bound too: the `rougechain` CLI envelope `{tx_type, from, nonce, fee,
   payload}` (mainnet blocks 29, 49–52, 59), where tx_type, nonce, fee and payload are all inside the
   signed bytes. Nonce in format (A) is server-assigned and stays unbound; it is excluded from the
   identity, so it cannot mint a "new" transaction.
2. **Key-bound identity** — `quantum_vault_types::tx_identity`: V2 = sha256(0x02‖pk‖signed_payload);
   V1 = sha256(0x01‖signed fields). Signature re-encoding, owner re-signing, attached payloads and
   nonce edits do not change it; every signed field does (and breaks the signature).
3. **Ingress (node-local, live on upgrade, no fork needed):** `insert_tx_to_mempool` — the single
   admission choke point for API, P2P and node-signed txs — runs `verify_v2_binding` and refuses any
   identity already in the chain; the producer drops such txs.
4. **Consensus rule from `TX_UNIQUENESS_ACTIVATION_HEIGHT`:** a block is invalid if any tx fails the
   V2 binding, repeats an identity within the block, or has an identity already included. Checked in
   `import_block` before the pre-apply snapshot; a rejected block leaves no state, receipt or index
   change (tested).
5. **tx-seen index** (`tx-seen-db`, identity → height): written only after a block is durable;
   `ensure_tx_seen_index` rebuilds it from the stored chain at start, after recovery and — fail-closed —
   inside the consensus check whenever its recorded tip ≠ chain tip (crash between append and record,
   failed write). Marker key `__indexed_tip_v2` forces a rebuild on upgrade from the C1 draft.
6. Not changed: consensus serialization (block/tx encoding, hashes, state root), nonce semantics,
   proposer selection, any activation constant. `TxPayload` gains `PartialEq` (no wire effect).

## Tests (daemon: 141 = 132 pre-existing + 9 `tx_uniqueness_tests` + 5 `v2_binding_tests` − overlap; see report)
* every V2 type round-trips through the mapping and ≥120 field mutations (recipient, amount, fee,
  version, type, token, supply, spender, allowance, owner, pool, LP, NFT ids/royalties/price, shielded
  fields, smuggled field, swapped payload, wrong `from`) are refused; CLI envelope binds type/nonce/fee/
  payload; forged transfer refused at ingress and by consensus with no state/receipt/index mutation;
  legacy acceptance below N pinned; nonce-edited replay refused as a replay; V1 identity fixed by
  signed fields only; in-block duplicate; activation boundary; crash window; recovery re-import;
  **all 26 historical mainnet V2 transactions satisfy the binding** (fixture `tests/fixtures/mainnet-v2-txs-h20-60.json`).
* Historical replay of mainnet blocks 0–48 (existing fixture) unchanged.

## Recovery / rollback surface
RougeChain has no reorg or chain-replacement path: `peer.rs` refuses "longer chain wins";
`reset_chain` is used only by `recover_from_history`, which clears the index and re-imports every
stored block through `import_block` (re-recording it). A rejected block is rolled back by the
pre-apply snapshot and never reaches the index. Those are the only paths, and both are tested.

## Remaining unauthenticated transaction ingress (not changed by this release)
* `/api/tx/broadcast` — raw TxV1 from anyone; after this release a tx must be validly signed AND
  bound AND new, so it degrades to a spam vector like any mempool. Currently 403 at nginx on the
  primary; the CLI (`rougechain stake/transfer`) depends on it — re-open only after rollout, or point
  the CLI at `/api/v2/*`.
* `/api/v2/contract/deploy` and `/api/v2/contract/call` — plain JSON, no signature; the node signs
  with its own key and pays gas from its own balance; `caller` is a free string. Operator-balance
  griefing and contract-level impersonation; recommend a 403 at nginx until authenticated.
* `/api/faucet`, `/api/faucet/bridge`, bridge claim routes — node-signed by design, verified against
  external chains or cooldowns.
* Legacy raw-private-key routes (`/api/tx/submit`, `/api/token/create`, stake/unstake, pool/swap) are
  410 Gone unless `--dev`.

## Activation procedure
1. Choose N = live tip + 25 (rounded slightly); record tip, N, UTC time, commits, binary sha256,
   toolchain.
2. Set the constant, tag, publish to `rougechain-node`, replay mainnet history with the release.
3. Upgrade **every** validator (primary, node #2, the external validator) before the tip reaches N;
   confirm identical version, binary hash, activation height, chain id, tip and peering on all three.
4. Cross N; verify: identical block hash on all three, rule active, API replay refused, proposed
   replay refused, balances unchanged, normal txs execute, peers synchronized. Observe further blocks.

## Activation record

| Item | Value |
|---|---|
| Selection time (UTC) | 2026-09-23T15:06:18Z |
| Live canonical tip at selection | height 60, hash `ea90a89107bb741743516e41d3fb5428816cf95a69f46e660992075a0bc79096`, state root `069a9d03c9eec33915caac641e1c5b89faa7077d40df387315ff7f7a65bc27e4` (primary and node #2 in agreement; node #2 non-mining; P2P containment in place) |
| Activation height N | **90** (tip + 25, rounded up) |
| Blocks to activation | 30 (mainnet mines on demand) |
| Source commit | `175358f3b3569f1840ca5650f42f6de6ad359b2d` (branch `consensus/tx-integrity`; code identical to `34bccdb`, which set N — the later commits touch only this file) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), cargo 1.94.0 (85eff7c80 2026-01-15), stable-x86_64-unknown-linux-gnu; `Cargo.lock` frozen (`--locked --offline`) |
| Build | `cargo build --release --locked --offline -p quantum-vault-daemon` with `SOURCE_DATE_EPOCH` = commit time and `RUSTFLAGS=--remap-path-prefix` for source → `/build/src`, target → `/build/target`, cargo home → `/build/cargo`, home → `/build/home`. Two fresh checkouts + fresh target dirs at the SAME absolute path produced byte-identical binaries (cargo's crate-metadata hash includes the package path, so the path must match; a first attempt at two different paths differed only in LLVM anonymous symbol ids). |
| Binary SHA-256 | **`9ad81dbf98e8e78a86b34be61af2360a34dba055f9f7a4be81b1a69c15942287`** (26,639,552 bytes), `quantum-vault-daemon`, reproduced twice |
| Test results at N = 90 | daemon 140 passed / 0 failed / 1 ignored (incl. canonical replay 0→60 pinned to tip `ea90a891…` / root `069a9d03…`); workspace 231 passed / 0 failed |
| Active proposers to upgrade | primary `8ccf7878…` (mining), node #2 `c97f59a2…` (non-mining, must still run the rule); outside validator `21e0ed0a…` staked but never connected/produced — cannot reach either node under containment |
