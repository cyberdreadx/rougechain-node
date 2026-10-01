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
| Mintable custom tokens (TOKEN_MINTING) | not scheduled | not scheduled |

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

## Runbook: activating TOKEN_MINTING

TOKEN_MINTING is a hard fork: from its height, `create_token` may carry `token_mintable` /
`token_max_supply` (an old node drops those fields, computes a different block `tx_hash` and rejects
the block), `mint_tokens` is applied under the new rules, and once a mintable token exists the header
state root also commits the mint ledger. Every node must run the new binary **before** the height.

1. **Pick the height** — well above the network's current tip (`curl -s localhost:5100/api/stats` →
   `network_height`), leaving time to install everywhere (testnet first, then mainnet).
2. **Set it** in `core/daemon/src/upgrades.rs`: `token_minting: Some(H)` in `TESTNET` (and later in
   `MAINNET` via `node::TOKEN_MINTING_ACTIVATION_HEIGHT`). Update `mainnet_schedule_is_pinned` /
   `testnet_schedule_is_pinned` to the chosen value, and this page's table.
3. **Test** in a clean worktree (never in the live build dir): `cargo test -p quantum-vault-daemon -j 2`
   — includes `token_minting_tests` and the mainnet history replays — and `cargo check --workspace`.
4. **Build and install on every node** of that network (primary, node #2, any outside validator)
   **before** `H`; restart each. Confirm the startup log line `[upgrades] … token minting Some(H)` and
   `GET /api/stats` → `upgrade_schedule.token_minting == H` on every node.
5. **At/after `H`, verify**:
   - every node reports the same `state_root` at the same height (`/api/stats`);
   - create a test token with `"mintable": true, "max_supply": …`, then
     `GET /api/token/<SYM>/metadata` shows `mintable: true` on every node;
   - mint once as the creator: balance and `total_minted` move by exactly the amount on every node;
   - a mint by another key, a mint above the cap and a mint of a non-mintable token are refused;
   - roots still agree after those blocks.
6. **Then** enable the SDK / site UI for `mintable` / `max_supply` / mint.

Rollback before `H` is just reinstalling the previous binary. After a mintable token exists, a node
without the upgrade cannot follow the chain.
