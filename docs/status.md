# Status & Roadmap

This page is the single source of truth for **what is live** versus **what is built but not
activated**. If another page disagrees with this one, this page wins — please open an issue.

_Last reviewed: 2026-10-06 (mainnet height 251)._

> RougeChain is post-quantum-secured at the L1 level. The current production XRGE bridge remains
> on the hardened R1 architecture. A V3 XRGE bridge using ML-DSA-65 post-quantum authorization has
> been built and rehearsed; it is not deployed and awaits an external audit.

## ⚠️ Current node release: 1.6.3 (blocks 235 and 245 have passed)

Mainnet activated mintable tokens and contract royalty reads at **block 235** and the
monetary-integrity rule at **block 245** (2026-10-05). Every node must run release **1.6.2 or later**
to follow the chain ([upgrade notice](running-a-node/mandatory-upgrade-2026-10-245.md)); release
**1.6.3** (messenger and mail hardening, not a consensus change) is recommended for every node and
is what the operator nodes run ([release notes](running-a-node/release-1.6.3.md)). Nodes installed
with the one-line installer [update themselves](running-a-node/auto-update.md). The full schedule is
in [Upgrade schedule](running-a-node/upgrade-schedule.md).

## Suspended since block 245

The monetary-integrity rule makes a block invalid if it carries one of these transaction types:
`shield`, `shielded_transfer`, `unshield`, `token_lock`, `token_unlock`, `create_staking_pool`,
`token_stake`, `token_unstake`, `create_proposal`, `cast_vote`, `execute_proposal`, `delegate`,
`undelegate`, `token_approve`, `token_transfer_from`. The features behind them — **shielded
transfers, token locking, token staking pools, on-chain governance and voting, vote delegation** —
are therefore **not available**, however an older page or client describes them.

- *Why.* Their ledger effects were applied without the state checks they depend on. The V1 shielded
  pool's proof established value balance only and did not bind a withdrawal to a specific note, and
  its prover has no zero-knowledge mode, so it did not deliver privacy. The other types were never
  used on mainnet. The mainnet shielded pool was empty when it was suspended; no funds are affected.
- *What replaces them.* A redesigned shielded pool (V2) is specified and in development: a
  Plonky3-based STARK with a hiding mode (proofs of about 190 KB, verify about 6 ms, prove about 3 s
  on a phone), launching under a 1,000,000 XRGE pool cap before the external audit. It is **not
  audited**, and nothing may claim audited privacy until it is. The other types are being rebuilt
  with their checks in consensus; no activation height exists. Token allowances are unaffected
  (`approve` / `transfer_from` stay enabled). Treasury decisions for Regenerate use the node-hosted
  [votes](api-reference/regenerate.md) in the meantime.

## Earlier mandatory node upgrade (block 49)

If you run a RougeChain mainnet node or validator, **you must upgrade.** On 2026-09-18 mainnet
activated a protocol upgrade at **block 49** (bridge security hardening and a fix to validator-stake
accounting). The upgraded code is on the public repository:
[`rougechain-node` main](https://github.com/cyberdreadx/rougechain-node).

A node running a build from before 2026-09-18 may show the correct block height, but it executes
blocks with the old rules and ends up with incorrect balances and validator state. There is no
partial fix: upgrade and resync. **Stake is unaffected** — an un-upgraded validator simply is not
participating.

```bash
sudo systemctl stop rougechain-validator
cp -a ~/.quantum-vault/mainnet ~/.quantum-vault/mainnet.backup     # keep a backup
cd ~/rougechain && git pull --ff-only
source ~/.cargo/env && cd core && cargo build --release --locked -p quantum-vault-daemon
mv ~/.quantum-vault/mainnet ~/.quantum-vault/mainnet.old
mkdir -p ~/.quantum-vault/mainnet
cp ~/.quantum-vault/mainnet.backup/node-keys.json ~/.quantum-vault/mainnet/
sudo systemctl start rougechain-validator
```

Paths and the service name are those of a source-build install (repository in `~/rougechain`, data
in `~/.quantum-vault/mainnet`); adjust them to your setup. A node installed with the current
`install-validator.sh` runs a signed release binary instead (`/usr/local/bin/quantum-vault-daemon`,
with the `rougechain` CLI from the same release in `/usr/local/bin/rougechain`; data in
`/var/lib/rougechain/mainnet`) and is upgraded by re-running the installer, which verifies
the release signature before installing anything — see [Signed releases](running-a-node/releases.md).
`node-keys.json` is your validator identity — keep it and never share it. A fresh sync takes under
a minute.

**Verify you are on the canonical chain:**

- block 49 has hash `4c7ec92d9fc4dd24146036474128072d07d146d5cde93a0d31c0462eea895abb`
  (`curl -s "localhost:5100/api/blocks?limit=100"`)
- `state_root` from `curl -s localhost:5100/api/stats` equals the one at
  `https://api.rougechain.io/api/stats` at the same height

## Live today

| Component | Status | Notes |
|---|---|---|
| RougeChain mainnet (`rougechain-mainnet-1`) | **LIVE** | ML-DSA-65 accounts, transactions and block signatures |
| R1 production bridge (Base mainnet ⇄ RougeChain) | **LIVE** | Hardened R1 architecture; see [Bridge Security Model](bridge/security-model.md) |
| XRGE bridge (`BridgeVaultV2`) | **TESTED / USABLE** | Deposit, withdrawal and payout paths tested end-to-end on mainnet |
| qETH bridge (`RougeBridge`) | **TESTED / USABLE** | Same |
| qUSDC bridge (`RougeBridge`) | **TESTED / USABLE** | Same |
| Verified BFT finality (FINALITY_V2, Release 2a) | **LIVE since block 150** | Every block carries its parent's ≥⅔-stake certificate; see [Finality](staking/finality.md) |
| Player-signed contracts (GAME_READY) | **LIVE since block 150** | Deploy and call signed by the player; see [Smart Contracts](advanced/smart-contracts.md) |
| Game-ready contracts (GAME_READY 2) | **LIVE since block 160** | Tokens, NFTs, collections and minting, randomness, multi-hop moves; state root covers NFTs and contract state |
| Grind-proof game rolls (GAME_READY 3, `host_block_hash`) | **LIVE since block 170** | Commit-then-settle randomness; one-step `host_random` rolls can be ground by the sender |
| Payable contract calls (`attach`) | **LIVE since block 190** | Pay XRGE or tokens with a contract call; moves only if the call succeeds |
| Mintable custom tokens (creator-only minting, optional cap) | **LIVE since block 235** | Tokens created before 235 stay fixed-supply; see [Token creation](advanced/token-creation.md) |
| Contracts read NFT royalties (`host_nft_royalty_bps` / `host_nft_royalty_recipient`) | **LIVE since block 235** | Royalties above 100 % refused at collection creation; `nft_marketplace` example |
| Monetary-integrity rule | **LIVE since block 245** | Fee range, no `slash`, no faucet on mainnet, suspended types above |
| LP fee collection | **LIVE** | "Collect fees" on Pools withdraws only fee earnings |
| ETH / USDC deposits through the bridge contract (`depositETH` / `depositERC20`, auto-claimed) | **LIVE — reopened 2026-10-05** | The manual claim route is closed at the public endpoint |
| Bitcoin deposits (BTC → qBTC) | **LIVE** | Bitcoin **withdrawals are switched off** in the site while the relayer is stopped; see [Bitcoin Bridge](bridge/btc-bridge.md) |

The production XRGE bridge **still relies on classical (ECDSA / Safe multisig) authorization on the
Base side.** It is hardened, capped and monitored, but it is not post-quantum on Base. The ETH/USDC
contract is owned by a single operator hot key. No bridge component has been externally audited.

## Validators and staking, as they run today

| Fact | Today |
|---|---|
| Staked validators | **3** — about 100.09 M XRGE (the operator's producing validator), 10,000 XRGE (the operator's second node, non-producing) and 9,000 XRGE (an outside key) |
| Block production | One validator produces every block (designated proposer = largest stake, since block 100); no fallback proposer — if it is offline the chain stops |
| Finality | FINALITY_V2 since block 150; the largest validator's own vote reaches the ⅔ quorum |
| Minimum stake | 10,000 XRGE is enforced by the node **API** only (`/api/v2/stake`, CLI). Consensus accepts any positive stake — hence a 9,000 XRGE validator |
| Slashing | **None active.** Missed-block accounting frozen since block 100; the legacy `slash` transaction is rejected from block 245; evidence-based slashing does not exist yet |
| Unbonding | 500 blocks (a block count, not a duration) |
| Rewards | Fees only: half the base fee per transaction burned, tip pool 20 % proposer / 70 % all validators by stake (no participation check) / 10 % `__treasury__`. The 0.1 XRGE minimum-tip floor draws from `__staking_rewards__`, which holds **0 XRGE** on mainnet — so it pays nothing |

## Built and tested — NOT activated

| Component | Status |
|---|---|
| V3 XRGE bridge (`BridgeVaultV3`) | **AUDIT CANDIDATE / NOT ACTIVATED** — not deployed to Base mainnet |
| ML-DSA-65 post-quantum root authorization (on-chain verifier) | Built, tested, frozen for audit — not deployed |
| Table-in-proof verifier architecture | Built, tested, frozen for audit — not deployed |
| Deterministic epoch / withdrawal-root pipeline | Built and tested — not running in production |
| Post-quantum root-authority signer | Built and tested — a 2-of-3 genesis authority set has been assembled offline; no production root has been signed |
| Post-quantum authority rotation + deterministic authority schedule | Built and tested, rehearsed end to end on a throwaway network — not in use |
| Reproducible V3 contract build / audit candidate | Complete |
| OP-stack deployment rehearsal (local devnet, throwaway keys and token) | Complete |
| Shielded pool V2 | Specified, in development — see "Suspended since block 245" |

## Consensus redesign — decided 2026-10-06, NOT built

A redesign of consensus was decided on 2026-10-06. **Nothing of it is implemented or scheduled**; it is
gated on a consensus simulator and an independent review, and will ship as staged forks **A–E** whose
heights will be announced in advance. It supersedes the earlier "Release 2b" and "Release 3" plans.

| Element | Planned |
|---|---|
| Rounds | Tendermint-style rounds with ML-DSA-65 prevotes and precommits |
| Proposer | Rotating, stake-weighted, in place of the fixed largest-stake proposer |
| Active set | Capped at 32 validators |
| Minimum stake | 100,000 XRGE **enforced by consensus**, with a 30-day grace period for existing validators |
| Unbonding | 21 days |
| Slashing | Evidence-based: double-signing 100 % of stake; downtime jail only |
| Liveness | Hourly heartbeat blocks so the chain advances without transactions |
| Rewards | A per-time reserve subsidy in addition to fees |
| Admission | Temporary approval of new validators, with a written exit condition |
| Later | Validator key separation and delegation |

`FINALITY_V2_ACTIVATION_HEIGHT` is **150** (active). `V3_BRIDGE_ACTIVATION_HEIGHT` is **`None`**: no
activation height has been chosen for the V3 bridge.

## Scope of V3

- V3 changes the **XRGE** withdrawal authorization path on Base to ML-DSA-65.
- **qETH and qUSDC are outside the V3 scope.** They stay on `RougeBridge` with classical Base-side
  authorization.
- **The Bitcoin bridge is a separate system** and is not part of V3. See [Bitcoin Bridge](bridge/btc-bridge.md).

## Roadmap

| Milestone | State |
|---|---|
| R1 bridge hardening | ✅ Complete (live) |
| V3 architecture | ✅ Complete |
| Reproducible audit candidate | ✅ Complete |
| OP-stack rehearsal | 🟡 Substantially complete |
| External review / audit | ⏳ Pending |
| Production deployment of V3 | ⏳ Pending |
| FINALITY_V2 activation | ✅ Live (block 150) |
| Game-ready contracts (GAME_READY 1 + 2 + 3, payable calls) | ✅ Live (blocks 150, 160, 170, 190) |
| Mintable tokens, contract royalty reads | ✅ Live (block 235) |
| Monetary-integrity rule | ✅ Live (block 245) |
| Shielded pool V2 | 🟡 In development, unaudited |
| Restoring the other suspended types | ⏳ Being rebuilt, no height |
| Consensus redesign (forks A–E) | ⏳ Decided, not built; simulator + independent review first |
| V3 activation | ⏳ Pending |

Activation will be announced in advance with the exact block heights. Until then, nothing on this
page in the "not activated" table protects user funds.
