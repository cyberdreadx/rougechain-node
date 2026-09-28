# RougeChain node release — finality and game-ready contracts (2026-09-28)

**Mandatory upgrade for every mainnet validator and full node.** Three consensus changes are
**already active on mainnet**:

| Change | Constant (`core/daemon/src/node.rs`) | Activation height |
|---|---|---|
| Verified BFT finality — Release 2a | `FINALITY_V2_ACTIVATION_HEIGHT` | **150** |
| Player-signed contract calls and deployments (GAME_READY) | `GAME_READY_ACTIVATION_HEIGHT` | **150** |
| Game-ready contracts: tokens, NFTs, randomness, multi-hop moves, state root v2 (GAME_READY 2) | `GAME_READY_2_ACTIVATION_HEIGHT` | **160** |
| Grind-proof rolls: `host_block_hash` (GAME_READY 3) | `GAME_READY_3_ACTIVATION_HEIGHT` | **170** — upgrade before block 170 |

A node without them cannot follow mainnet past block 150: from block 151 every block carries its
parent's finality certificate, and from block 160 the header's state root also commits NFTs and
contract state.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `718200bca08ff7f147d7a83ccaef4440b1c805bbd3f48266b9f90d614327d8de` (supersedes `5e5ca98c…` and `46e29456…`: exact JSON float parsing, required to import block 177) |
| Size | 28,021,264 bytes |
| Source commit | `653874b`, branch `fix/commit-settle-randomness` |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), cargo 1.94.0 (85eff7c80 2026-01-15), `x86_64-unknown-linux-gnu` |

This exact binary runs on both operator nodes. It was built twice from clean and the two builds were
byte-identical.

**Verify you are on the canonical chain:**

- block 150 has hash `559e66ee9384aaeea91b5dc70285b3c1cbc2805dab1752632003c85007c81b52`
- block 160 has hash `4592f38543195a6c619418f778e9897f09c99bab048a83afe29d8cdf5b5277c0`
- `state_root` from `curl -s localhost:5100/api/stats` equals `https://api.rougechain.io/api/stats`
  at the same height

## What changed

**Exact JSON number parsing (required to follow block 177).** A contract call's fee is
`gasLimit × 0.000001`; for about 18% of gas limits that number prints with many digits (block 177:
`0.0018369999999999999`) and the previous build's JSON parser read it back one unit off, so nodes that
receive blocks over the network rejected block 177. This build parses numbers exactly. It changes no
rule and needs no activation height.

**Finality (≥ 150).** Validators sign ML-DSA-65 precommits; a block is final once signers holding more
than two thirds of stake have signed it. From block 151 every block header carries `parent_commit`, the
verified certificate for its parent, and a node refuses to import or build on a block without one. See
[Finality](../staking/finality.md).

**Player-signed contracts (≥ 150).** `contract_call` and `contract_deploy` must be signed by the caller
(`POST /api/v2/contract/execute` and `/api/v2/contract/publish`); the contract sees the verified signer
as its caller, and the signer pays the fee (deploy 10 XRGE; call `gasLimit × 0.000001` XRGE).
Node-signed contract transactions are invalid. Contracts can read their call arguments.

**Game-ready contracts (≥ 160).** Contracts can hold and send custom tokens and NFTs, create their own
NFT collection and mint to players, and draw per-transaction randomness (`host_random`). Moves made
inside cross-contract calls are applied. The block state root also covers NFT collections and ownership
and contract code and storage. See [Smart Contracts](../advanced/smart-contracts.md).

**API (no consensus change).** `POST /api/contract/:addr/query` (free dry run), contract events paging
(`?before=&tx=`), WebSocket topic `contract:<addr>`, receipts that report `Failed` when a contract call
reverts, and the LP fee ledger (`GET /api/pool/:id/earnings/:owner`).

## Upgrade

Stop the node, back up `node-keys.json` and the data directory, then build the public
[`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) main branch and restart:

```bash
sudo systemctl stop rougechain-validator
cp -a ~/.quantum-vault/mainnet ~/.quantum-vault/mainnet.backup-$(date +%Y%m%d)
cd ~/rougechain && git pull --ff-only
source ~/.cargo/env && cd core && cargo build --release --locked -p quantum-vault-daemon
sudo systemctl start rougechain-validator
```

After the restart, compare the block 150 and 160 hashes and the `state_root` above with the public
node. If anything differs, the node applied blocks under the old rules: resync from an empty data
directory (keep `node-keys.json`).
