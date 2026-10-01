# Status & Roadmap

This page is the single source of truth for **what is live** versus **what is built but not
activated**. If another page disagrees with this one, this page wins — please open an issue.

_Last reviewed: 2026-09-28._

> RougeChain is post-quantum-secured at the L1 level. The current production XRGE bridge remains
> on the hardened R1 architecture. A V3 XRGE bridge using ML-DSA-65 post-quantum authorization has
> been built and is undergoing final rehearsal before production activation.

## ⚠️ Mandatory node upgrade (blocks 150 and 160)

Mainnet activated verified BFT finality and player-signed contracts at **block 150** and game-ready
contracts (tokens, NFTs, randomness, state root v2) at **block 160**. Every node must run the
2026-09-28 release: [upgrade guide](running-a-node/mandatory-upgrade-2026-09-28.md).

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

Paths and the service name are the `install-validator.sh` defaults; adjust them to your setup.
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
| LP fee collection | **LIVE** | "Collect fees" on Pools withdraws only fee earnings |

The production XRGE bridge **still relies on classical (ECDSA / Safe multisig) authorization on the
Base side.** It is hardened, capped and monitored, but it is not post-quantum on Base.

## Built and tested — NOT activated

| Component | Status |
|---|---|
| V3 XRGE bridge (`BridgeVaultV3`) | **AUDIT CANDIDATE / NOT ACTIVATED** — not deployed to Base mainnet |
| ML-DSA-65 post-quantum root authorization (on-chain verifier) | Built, tested, frozen for audit — not deployed |
| Table-in-proof verifier architecture | Built, tested, frozen for audit — not deployed |
| Deterministic epoch / withdrawal-root pipeline | Built and tested — not running in production |
| Post-quantum root-authority signer | Built and tested — no production keys exist, no production root has been signed |
| Post-quantum authority rotation + deterministic authority schedule | Built and tested — not in use |
| Reproducible V3 contract build / audit candidate | Complete |
| OP-stack deployment rehearsal (local devnet, throwaway keys and token) | Substantially complete |
| Consensus Release 2b (fallback proposer, skip certificates, slashing tied to them) | Designed — not built |
| Consensus Release 3 (slashing on equivocation evidence) | Planned — not built |

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
| Game-ready contracts (GAME_READY 1 + 2) | ✅ Live (blocks 150, 160) |
| V3 activation | ⏳ Pending |

Activation will be announced in advance with the exact block heights. Until then, nothing on this
page in the "not activated" table protects user funds.
