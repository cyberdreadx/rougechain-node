# Network upgrade schedule

Each protocol upgrade turns on at a block height. Mainnet and testnet have **separate schedules**:
testnet ran old software through mainnet's upgrade heights, so it upgrades at its own, later heights.
The node picks the schedule from its chain id at startup, prints it in the log (`[upgrades] …`) and
reports it in `GET /api/stats` as `upgrade_schedule`. Source: `core/daemon/src/upgrades.rs`.

| Upgrade | Mainnet (`rougechain-mainnet-1`) | Testnet (`rougechain-devnet-1`) |
|---|---|---|
| Transaction integrity (tx uniqueness + signed-payload binding) | 90 | 1200 |
| Proposer selection, Release 1 | 100 | 1250 |
| Verified BFT finality (FINALITY_V2) | 150 | 1250 |
| Player-signed contracts (GAME_READY) | 150 | 1200 |
| Tokens, NFTs, randomness, multi-hop, state root v2 (GAME_READY 2) | 160 | 1200 |
| `host_block_hash` commit-then-settle (GAME_READY 3) | 170 | 1200 |
| Payable contract calls (`attach`) | 190 | 1200 |
| Mintable custom tokens (TOKEN_MINTING) | 235 | 1360 |
| Contracts read NFT royalty (CONTRACT_NFT_ROYALTY) | 235 | 1360 |
| Monetary-integrity rule (MONETARY_INTEGRITY) | 245 | 1390 |
| Signatures commit to the chain id (CHAIN_ID_BINDING) | not scheduled | not scheduled |
| Contracts read the chain id (CONTRACT_CHAIN_ID) | not scheduled | not scheduled |
| Pool transactions apply all-or-nothing (AMM_INTEGRITY) | 260 | 1440 |

**Every height in this table has been reached** (except the `not scheduled` rows and AMM_INTEGRITY
on mainnet, set to 260 on 2026-10-09 with mainnet at 252; testnet passed 1440 the same day) on both networks (mainnet height 251,
testnet past 1390, on 2026-10-06). Nothing else is scheduled beyond them; the next consensus changes — restoring the
types suspended at 245, the shielded pool V2, and the consensus redesign decided on 2026-10-06 — have
no heights yet and will be announced in advance (see [Status & Roadmap](../status.md)).

**Testnet validator cleanup (block 1240, testnet only):** 99% of testnet's stake sat on validator
`4e094d21…`, whose key nobody holds, so it could never sign finality votes. At block 1240 its stake is
returned to its balance and set to zero, and the testnet node's own key (staked beforehand) becomes the
largest validator. The finality validator replay starts from the validator set recorded at that block,
because testnet's earliest blocks predate stored receipts. Proposer selection and finality turn on at
1250. None of this exists on mainnet (`validator_retirement` is `None` there).

**Rules for changing the schedule**

- Mainnet heights are history and never change; a unit test (`mainnet_schedule_is_pinned`) fails if
  they do.
- To schedule an upgrade on either network: set its height in `upgrades.rs` **above the current tip**,
  rebuild, install on every node of that network **before** the height, and update this page.
- Mainnet and testnet share one binary: a release carries both schedules, so installing it on the
  primary updates both services — each still follows its own schedule.

## Runbook: activating TOKEN_MINTING (together with CONTRACT_NFT_ROYALTY)

> Completed: testnet 1360, mainnet 235. Kept as the template for the next scheduled upgrade.

TOKEN_MINTING is a hard fork: from its height, `create_token` may carry `token_mintable` /
`token_max_supply`, `mint_tokens` is applied under the new rules, and once a mintable token exists the
header state root also commits the mint ledger. An old node drops the two new fields when it reads a
block and applies `mint_tokens` under the old rules, so from the first mintable token or mint it
computes a different state root and rejects the block. Every node must run the new binary **before**
the height.

> Corrected 2026-10-06: an earlier version of this page said an old node rejects such a block because
> it "computes a different block `tx_hash`". That was wrong: what an old node disagrees on is the
> state root.

CONTRACT_NFT_ROYALTY is planned for the **same height**. It is a smaller fork: from its height every
contract call links `host_nft_royalty_bps` / `host_nft_royalty_recipient`, so a call to a contract that
imports them succeeds where an old node fails it (an old node then rejects the block). From the same
height an `nft_create_collection` whose `royaltyBps` is above `10000` (over 100%) or not an exact
integer is invalid (refused by the API, mempool and producer; a block carrying one is rejected) — an
old node would accept that block, so this too requires the new binary everywhere. No transaction
or state-root format changes. Activating both at one height means one coordinated install. They are
two independent schedule fields — set **both** to the same `H`.

1. **Pick the height** — well above the network's current tip (`curl -s localhost:5100/api/stats` →
   `network_height`), leaving time to install everywhere (testnet first, then mainnet).
2. **Set it** in `core/daemon/src/upgrades.rs`: `token_minting: Some(H)` **and**
   `contract_nft_royalty: Some(H)` in `TESTNET` (and later in `MAINNET` via
   `node::TOKEN_MINTING_ACTIVATION_HEIGHT` and `node::CONTRACT_NFT_ROYALTY_ACTIVATION_HEIGHT`). Update
   `mainnet_schedule_is_pinned` / `testnet_schedule_is_pinned` to the chosen values, and this page's
   table.
3. **Test** in a clean worktree (never in the live build dir): `cargo test -p quantum-vault-daemon -j 2`
   — includes `token_minting_tests`, the `nft_royalty` / `nft_marketplace` tests in `game_ready_tests`
   and the mainnet history replays — `cargo test -p quantum-vault-vm -j 2`, and `cargo check` (the default members; `--workspace` is refused on purpose, see `core/Cargo.toml` — and so is `--all-targets` with the daemon selected, for `build`, `check` and `clippy` alike, which is also what an editor runs by default: it builds the test targets next to the plain binary, the daemon's test dependencies bring in the shielded pool's prover, and the daemon refuses to compile with it; use `cargo test -p quantum-vault-daemon` for the tests).
4. **Build and install on every node** of that network (primary, node #2, any outside validator)
   **before** `H`; restart each. Confirm the startup log line
   `[upgrades] … token minting Some(H), contract NFT royalty Some(H)` and `GET /api/stats` →
   `upgrade_schedule.token_minting == H` and `upgrade_schedule.contract_nft_royalty == H` on every node.
5. **At/after `H`, verify**:
   - every node reports the same `state_root` at the same height (`/api/stats`);
   - create a test token with `"mintable": true, "max_supply": …`, then
     `GET /api/token/<SYM>/metadata` shows `mintable: true` on every node;
   - mint once as the creator: balance and `total_minted` move by exactly the amount on every node;
   - a mint by another key, a mint above the cap and a mint of a non-mintable token are refused;
   - CONTRACT_NFT_ROYALTY: `POST /api/v2/nft/collection/create` with `"royaltyBps": 10001` is refused
     (`royaltyBps must be an integer between 0 and 10000`); `10000` is accepted.
   - CONTRACT_NFT_ROYALTY: publish `contracts/nft_marketplace/nft_marketplace.wasm` (it can be
     published before `H`, but its calls only run from `H`). On a test collection with a royalty,
     `list`, escrow the NFT with `nft_transfer`, then `buy` with the exact price attached: the royalty
     recipient gains exactly `floor(price × bps / 10000)` quanta, the seller the rest, the buyer owns
     the NFT; a `buy` with the wrong amount fails and is refunded (only gas is charged);
   - roots still agree after those blocks.
6. **Then** enable the SDK / site UI for `mintable` / `max_supply` / mint, and tell marketplace
   developers the royalty host functions are live.

Rollback before `H` is just reinstalling the previous binary. After a mintable token exists (or a
call to a contract importing the royalty functions is included), a node without the upgrade cannot
follow the chain.

<a id="chain-id-binding"></a>

## Upgrade notice: CHAIN_ID_BINDING and CONTRACT_CHAIN_ID (not scheduled)

**What it is.** From node release 1.6.4 every wallet signs the chain id into its payloads, and nodes
refuse a payload that names another network (node rule, no fork). CHAIN_ID_BINDING makes the same
property a consensus rule; CONTRACT_CHAIN_ID gives contracts `host_get_chain_id`. Both are hard forks
with **no height on any network** (`upgrade_schedule.chain_id_binding` / `.contract_chain_id` are
`null`).

**The rule, from height `H`.** A block is invalid if any transaction's signed bytes do not commit to
this chain's id:

| Signature format | Required from `H` |
|---|---|
| `/api/v2` signed payload (`signed_payload`, flat JSON) | the signature verifies over `signed_payload` **only** (no fallback to another format), and the JSON has `chainId` equal to the chain id (exact string) |
| `rougechain` CLI envelope (`signed_payload` with `tx_type` + `payload`) | same, with `chain_id` in the envelope |
| V1 format (no `signed_payload`; node-signed transactions: faucet, bridge mints, cosigned bridge withdrawals, legacy node routes) | signed over the network-bound encoding `"rougechain/tx-v1/chain" ‖ 0x00 ‖ u64_be(len) ‖ chain id ‖ encode_tx_for_signing(tx)`; the plain V1 and legacy full-struct encodings are refused |
| SHIELD_V2 (`shield_v2`, signer-less `*_v2`) | unchanged — the body already carries `sha256(chain id)` and is checked by the SHIELD_V2 rule |

Below `H` nothing changes: blocks are accepted, executed and stored exactly as by release 1.6.3, and
the network-bound V1 encoding is not accepted (an older node would refuse it). Nodes start signing
their own V1 transactions in the network-bound encoding at `H` automatically.

**What must ship first, in this order.**

1. Node release 1.6.4 on every node of the network (node rule; harmless to older wallets).
2. Wallets that sign `chainId`: the site, `@rougechain/sdk` 1.15.0 (and every dApp built on it,
   after a dependency bump), browser extension 1.9.0, Qwalla 1.3.0, `rougechain` CLI 1.3.0, the
   MCP server. Watch the node log / API errors for payloads still arriving without the field.
3. Operators turn on `REQUIRE_SIGNED_CHAIN_ID` (testnet first). Only then is a payload without a
   network refused everywhere.
4. Pick `H` (well above the tip), set `chain_id_binding: Some(H)` (and, if wanted at the same time,
   `contract_chain_id: Some(H)`) for testnet in `core/daemon/src/upgrades.rs` — mainnet via
   `chain_binding::CHAIN_ID_BINDING_ACTIVATION_HEIGHT` / `node::CONTRACT_CHAIN_ID_ACTIVATION_HEIGHT` —
   update `mainnet_schedule_is_pinned` / `testnet_schedule_is_pinned` and this page, build, and install
   on **every** node of that network before `H`. Confirm the startup line
   `[upgrades] … chain id binding Some(H), contract chain id Some(H)` and `GET /api/stats` →
   `upgrade_schedule.chain_id_binding == H` on each node.
5. Any transaction still in a mempool at `H` without a network-bound signature is dropped by the
   producer and must be signed again.

<a id="amm-integrity"></a>

## Upgrade notice: AMM_INTEGRITY (mainnet 260, testnet 1440)

**What it is.** A hard fork that changes how the four pool transaction types — `create_pool`,
`add_liquidity`, `remove_liquidity`, `swap` — are executed. It activates on **mainnet at height 260**
(release 1.6.7; `upgrade_schedule.amm_integrity` is `260`) and has been active on **testnet since
height 1440** (release 1.6.6). Mainnet nodes must run release 1.6.7 or later before block 260. Source: `core/daemon/src/amm_integrity.rs`.

Node release 1.6.4 already keeps pool transactions that cannot take effect out of the blocks a node
produces. That protects a network only while every block producer runs it. AMM_INTEGRITY makes the
same outcome a rule of the chain, so it no longer depends on who produces the block.

**The rule, from height `H`.** A pool transaction either takes its full effect or changes nothing:
no fee is charged, no balance moves, no pool changes. It can never make its block invalid.

| Transaction | Takes effect only if |
|---|---|
| `swap` | the input amount is greater than zero; the two tokens differ; the route (the signed `swap_path`, or the direct pair when absent) names 2 to 4 tokens, starts at the input token, ends at the output token, and uses no pool twice; every pool on the route exists and returns more than zero; the final amount is at least the signed `min_amount_out`; the sender holds the input and the fee |
| `create_pool` | the two symbols are well formed and differ (compared without regard to letter case); both amounts are greater than zero; LP tokens would be minted; **no pool exists for the pair**, in either order or letter case; the sender holds both amounts and the fee |
| `add_liquidity` | the pool exists; both amounts are greater than zero; more than zero LP tokens would be minted; the sender holds both amounts and the fee |
| `remove_liquidity` | the pool exists; the sender holds the LP tokens; **both** sides return more than zero; the sender holds the fee |

When a transaction takes effect, all of its parts are written together: the sender's debit, the
pools on the route, and the credit. Amounts are computed with checked integer arithmetic; a value
out of range means the transaction has no effect. The fee is counted as collected whenever it is
charged (before `H`, the fee of a swap that pays out XRGE is taken from the sender but not
distributed).

**What does not change.** Prices (constant product, 0.3% of the input stays in the pool), the LP
minting and redemption formulas, XRGE pool amounts in whole XRGE, the state root layout, the
`/api/v2` request formats, and every block below `H`, which replays exactly as before.

**For wallets and apps.** No change is required. Two visible differences from `H`:

- A swap that misses its `min_amount_out` no longer costs the sender anything. Before `H` a node
  running 1.6.4 already leaves such a swap out of its blocks; from `H` the chain guarantees it.
- A transaction that has no effect is still included in a block when a producer includes it, and
  the chain does not record a per-transaction result. To learn whether a swap traded, compare
  balances or read the pool events (`GET /api/pool/:pool_id/events`).

Multi-pool routes are validated by the rule, but nodes do not yet accept a `swap_path` from the API
(no wallet signs one); that is a later, node-level change.

**Not part of this upgrade** (candidates for a later one): locking the minimum liquidity of a new
pool, taking only the matching amounts in `add_liquidity` with a signed minimum of LP tokens,
committing pool reserves in the state root, a deadline on swaps.

**Activation.**

1. Pick `H` (well above the tip), set `amm_integrity: Some(H)` for testnet in
   `core/daemon/src/upgrades.rs` — mainnet via `amm_integrity::AMM_INTEGRITY_ACTIVATION_HEIGHT` —
   update `mainnet_schedule_is_pinned` / `testnet_schedule_is_pinned` and this page, build, and
   install on **every** node of that network before `H`. A node without the upgrade cannot follow
   the chain past the first block at or above `H` whose pool transactions the two rule sets judge
   differently.
2. Confirm the startup line `[upgrades] … AMM integrity Some(H)` and `GET /api/stats` →
   `upgrade_schedule.amm_integrity == H` on each node.
3. After `H`, on testnet: one swap that trades, one swap signed with a minimum it cannot meet (the
   sender's balances must be unchanged), one liquidity add and one removal.
