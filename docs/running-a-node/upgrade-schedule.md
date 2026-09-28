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
