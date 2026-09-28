# Network upgrade schedule

Each protocol upgrade turns on at a block height. Mainnet and testnet have **separate schedules**:
testnet ran old software through mainnet's upgrade heights, so it upgrades at its own, later heights.
The node picks the schedule from its chain id at startup, prints it in the log (`[upgrades] …`) and
reports it in `GET /api/stats` as `upgrade_schedule`. Source: `core/daemon/src/upgrades.rs`.

| Upgrade | Mainnet (`rougechain-mainnet-1`) | Testnet (`rougechain-devnet-1`) |
|---|---|---|
| Transaction integrity (tx uniqueness + signed-payload binding) | 90 | 1200 |
| Proposer selection, Release 1 | 100 | not scheduled |
| Verified BFT finality (FINALITY_V2) | 150 | not scheduled |
| Player-signed contracts (GAME_READY) | 150 | 1200 |
| Tokens, NFTs, randomness, multi-hop, state root v2 (GAME_READY 2) | 160 | 1200 |
| `host_block_hash` commit-then-settle (GAME_READY 3) | 170 | 1200 |
| Payable contract calls (`attach`) | 190 | 1200 |

**Why proposer selection and finality are off on testnet:** testnet's block producer is not its
largest staker, and those upgrades require blocks from the largest staker and signatures from two
thirds of stake. They'll be scheduled once testnet's validator set is arranged.

**Rules for changing the schedule**

- Mainnet heights are history and never change; a unit test (`mainnet_schedule_is_pinned`) fails if
  they do.
- To schedule an upgrade on either network: set its height in `upgrades.rs` **above the current tip**,
  rebuild, install on every node of that network **before** the height, and update this page.
- Mainnet and testnet share one binary: a release carries both schedules, so installing it on the
  primary updates both services — each still follows its own schedule.
