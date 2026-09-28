# GAME_READY: making RougeChain a contract and game platform

Branch `feat/game-ready-phase0`, based on the deployed line (`9eea813` + Regenerate votes `bf60840`).
**Phase 0 ACTIVE on mainnet since block 150. GAME_READY 2 (tokens, NFTs, randomness) implemented;
activation `GAME_READY_2_ACTIVATION_HEIGHT` — see the release branch.**

## Why Phase 0 comes first

Contract calls were not authenticated. `POST /api/v2/contract/call` took an unsigned `caller` field
from the request body, simulated the call, then **signed a `contract_call` transaction with the
node's own key**, carrying the claimed caller in `payload.to_pub_key_hex`. Block execution passed that
field to the contract as `host_get_caller`. So a contract could not know who was calling it: if a
contract held value and let its owner withdraw, anyone could claim to be the owner. The node operator
also paid every call's fee. Deployment worked the same way (unsigned `deployer`).

Exposure today: none. Mainnet has never carried a contract transaction (blocks 0–135 checked), and
nginx returns 403 for `/api/v2/contract/deploy` and `/api/v2/contract/call`. Contracts must not hold
value until GAME_READY is active.

Two VM defects are fixed alongside: contracts could not read their call arguments (the runtime took
`_args_json` and dropped it), and a module that did not export `memory` made every host function
`panic!` inside block execution.

## Phase 0 — what this branch changes

| Area | Change |
|---|---|
| Consensus rule | `game_ready_tx_rule(tx, height)` in `node.rs`, checked at block import, mempool admission and block production. **From activation:** a `contract_call` / `contract_deploy` must carry a signed payload (player-signed `/api/v2/*` format or the CLI envelope). Node-signed contract txs are invalid. **Before activation:** the player-signed `/api/v2/*` contract format is refused, exactly as nodes without this code refuse it (their `v2_binding` has no contract types), so pre-activation validity is unchanged. |
| Signed-payload binding | `v2_binding::derive_v2_fields` gains `contract_call` (`contractAddr`, `method`, `args`, `gasLimit` → fee = gasLimit × 0.000001 XRGE) and `contract_deploy` (`wasm`; flat 10 XRGE fee; address = first 20 bytes of sha256("rougechain/contract/v2" ‖ from ‖ signed nonce ‖ sha256(wasm)), so nobody else can claim or pre-empt it). |
| Execution | From activation the caller / deployer the contract sees is `tx.from_pub_key` (the verified signer), never the unsigned field; the signer pays the fee. Bytecode that fails deployment validation is not installed (on every node alike; the fee is still charged). |
| API | `POST /api/v2/contract/execute` (signed call: dry-run first, refuses a call that would fail or exceed its gas limit) and `POST /api/v2/contract/publish` (signed deploy: validates bytecode, returns the derived address). From activation, `/api/v2/contract/call` becomes a preview (dry run, `submitted: false`) and `/api/v2/contract/deploy` returns 410. |
| VM | `host_get_args_len() → i32` and `host_read_args(buf_ptr, buf_len) → i32`: the call's arguments as JSON (`{}` when none). `validate_contract_wasm` (size, compiles, exports `memory`). A module without exported `memory` now fails the call cleanly (no state change) instead of panicking the node. |

### Tests

* VM: `contract_reads_its_call_arguments`, `module_without_exported_memory_fails_cleanly_and_is_rejected_for_deploy` (11 VM tests pass).
* Node (`game_ready_tests`): binding derivation (fee from gas, address bound to deployer and nonce);
  before activation a player-signed deploy block is refused like old nodes; after activation the
  contract records the verified signer as its caller and the signer pays deploy + gas; a node-signed
  call claiming another caller is invalid at import and in the mempool; undeployable bytecode is
  installed nowhere. Full daemon suite: 164 passed / 0 failed / 1 ignored, including the canonical
  mainnet replay 0→95.

### Not in Phase 0

* The browser extension signs only the transaction types it knows; one-tap game moves need it to sign
  `contract_call` (Phase 4).
* SDK helpers for `execute` / `publish` and the `rc.game` wrapper (Phase 4).
* The `erc20_template` example and the smart-contract docs still describe the old ABI (Phase 1).

## Later phases (from the scope review)

| Phase | Content | Size |
|---|---|---|
| 1 | Live contract events (per-contract websocket feed, paged events, events in receipts); fix `erc20_template` + docs | S–M |
| 2 | Contracts hold and move native tokens and NFTs (host functions checked after execution like XRGE custody); contracts own collections and mint to players; mintable tokens with an enforced max supply (and fix SDK `mintTokens`); NFTs + contract storage in the state root | L |
| 3 | Randomness: recent block hash + commit-reveal helper now; validator VRF / beacon after FINALITY_V2 and proposer rotation | S now, L later |
| 4 | Contract txs in block order; lazy storage loading + storage fee; extension signs any tx type; `rc.game` SDK + example game contract on testnet | M each |

Recommendation: bundle the governance transaction types (for Regenerate votes on-chain) into the same
activation height, so one coordinated upgrade covers both.

## Activation procedure

1. Choose N a few blocks ahead; set `GAME_READY_ACTIVATION_HEIGHT = Some(N)`; rebuild reproducibly.
2. Run the full suite plus the canonical replay; publish to `rougechain-node`; announce to outside validators.
3. Install on every node before N (same pattern as `TX_INTEGRITY_FORK.md`).
4. After N: open `/api/v2/contract/execute` and `/api/v2/contract/publish` at nginx (keep
   `/api/v2/contract/deploy` blocked; `/api/v2/contract/call` may be opened as a preview).
5. Verify on mainnet: a node-signed contract tx is refused; a player-signed deploy installs at the
   predicted address; a call records the signer as caller and debits the signer's fee.

## GAME_READY 2 — tokens, NFTs, randomness, live events (branch `feat/game-ready-phase1`)

**Consensus (from `GAME_READY_2_ACTIVATION_HEIGHT`):** every contract call runs with the host
functions below linked (`quantum_vault_vm::game`); before activation they are not linked, so a
module importing them fails to instantiate exactly as on older nodes. The VM reads token balances
and NFTs through a `ChainView` snapshot, keeps a per-call overlay, and returns `ChainEffect`s that
the node applies in order only when the call succeeds. Invalid effects reject the block (fail closed).

**Multi-hop:** cross-contract sub-calls also run with these functions, each over an `OverlayView`
that includes every move made before it (caller first, then earlier sub-calls); successful
sub-calls' XRGE deltas and effects are merged into the top-level result and applied (a failed
sub-call's moves are dropped). Sub-calls get their own randomness (`sub_call_seed`). Before
activation, a call that made cross-contract calls still applies no XRGE moves, as before.

| Host function | Result |
|---|---|
| `host_token_balance(sym, addr) -> i64` | raw token units (-1 invalid) |
| `host_token_transfer(sym, to, amount) -> i32` | moves the contract's own tokens; 0 ok, 1 insufficient, 2 invalid |
| `host_nft_owner(col, id, out, cap) -> i32` | owner bytes written, -1 not found, -2 buffer small |
| `host_nft_transfer(col, id, to) -> i32` | moves an NFT the contract owns; 0 ok, 1 not the contract's, 2 not found/locked |
| `host_nft_create_collection(sym, name, max_supply, out, cap) -> i32` | creates `col:<addr[..16]>:<SYM>` owned by the contract; writes the id; -1 exists |
| `host_nft_mint(col, to, name, meta_json, ...) -> i64` | token id; contract must be the collection creator; -1 not creator, -2 sold out, -3 missing/frozen |
| `host_random(out) -> i32` | 32 bytes: sha256(sha256("rougechain/rand/v1"‖parent hash‖0‖tx hash) ‖ counter) |

Also from activation: addresses a contract passes (`host_transfer`, `host_get_balance`, token/NFT
functions) are canonicalised, so paying `host_get_caller()` (a public key) credits the player's
rouge1 ledger entry; NFT owner checks in `nft_transfer`/`nft_burn`/`nft_lock` compare canonical
addresses. **`host_random` is sender-grindable** (the parent hash is public and the sender picks among
many signed variants of the tx) — see GAME_READY 3 below; never use it alone for value.

**State root v2:** from activation the header's state root is
`sha256("rougechain.stateroot.v2" ‖ balance root ‖ NFT collections (id, creator, minted, max,
frozen) ‖ NFT tokens (collection, id, owner, locked) ‖ contract code hashes ‖ contract storage)`
(`state_root::extend_state_root_v2`), so NFT ownership and contract state divergence is detected at
import like a balance divergence.

**API (no consensus change):** `POST /api/contract/:addr/query` (read-only dry run), events paging
`GET /api/contract/:addr/events?limit=&before=&tx=`, WebSocket topic `contract:<addr>` (and
`contracts`) with `{"type":"contract_event",...}` frames after a block is accepted, contract-call
receipts report `Failed(error)` when the call reverted.

**Example:** `contracts/loot_roll` (prebuilt `loot_roll.wasm`), exercised end to end by
`loot_roll_example_pays_prizes_from_its_treasury`.

**Tests:** `game_ready_2_contract_mints_nfts_pays_tokens_and_rolls`,
`game_ready_2_cross_contract_calls_move_tokens_and_xrge`,
`game_ready_2_state_root_covers_nfts_and_contract_storage_across_nodes` (second node imports and
agrees; a tampered NFT makes its next import fail), `loot_roll_example_pays_prizes_from_its_treasury`,
`before_game_ready_2_a_game_contract_cannot_run`.

**Still later:** validator VRF randomness (needs Release 2b's multi-validator set), lazy storage
loading + storage fees, incremental (Merkle) state root.

## GAME_READY 3 — grind-proof rolls (`GAME_READY_3_ACTIVATION_HEIGHT = Some(170)`)

Review finding (2026-09-28): `host_random`'s seed `sha256(tag ‖ parent hash ‖ tx hash)` is known to
the sender before sending and the sender controls the tx bytes, so a one-step roll can be ground
offline. Fix: `host_block_hash(height, out) -> i32` (32 bytes of a finished block within 256; `-1` for
the executing block, future or older heights; linked only from activation). Games commit (record H)
and settle from `host_block_hash(H+1)`: block H+1's hash covers the producer's ML-DSA signature and
the `parent_commit` finality signatures, which the player can't predict or choose. `contracts/loot_roll`
is now `roll` (commit) + `settle` (from H+2, expires after 250 blocks). Tests:
`loot_roll_example_commits_then_settles_from_a_later_block` (every roll recomputed from block H+1's
hash, the caller and H only — the commit tx is not an input), `host_block_hash_bounds_and_activation`.
Remaining bias: the single producer could withhold a block; VRF randomness is still planned.

## Payable calls (`PAYABLE_CALLS_ACTIVATION_HEIGHT`)

A `contract_call` may carry a signed `attach: {symbol, amount}` (integer: quanta for XRGE, raw token
units) → `TxPayload.contract_attach_symbol/amount`. Before activation such a call is invalid. From
activation the node checks the payer can cover it (else the call isn't executed; gas fee charged),
credits it to the contract in the balances the call sees (XRGE in the call's balance map, tokens in the
`ChainView`), and moves it for real only if the call succeeds — so a contract refuses a payment by
failing the call. `host_get_attached_amount() -> i64`, `host_get_attached_symbol(out, cap) -> i32`;
sub-calls see no attachment. Execute/query endpoints preview the paid call. `loot_roll`'s `roll` needs
≥ 0.5 XRGE attached. Test: `payable_calls_move_payment_only_on_success_and_relay_as_json` (two nodes,
every block relayed as JSON).
