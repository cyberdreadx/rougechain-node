# RougeChain node release 1.6.2 — monetary-integrity rule (2026-10)

**Mandatory upgrade for every mainnet validator and full node — install it before block 235.**
This release contains the two changes that activate at 235 (see the
[previous notice](mandatory-upgrade-2026-10.md)) and one new consensus rule at 245, so a node that
installs it now is ready for both heights with a single upgrade.

| Change | Constant (`core/daemon/src/node.rs`) | Mainnet | Testnet |
|---|---|---|---|
| Mintable tokens (TOKEN_MINTING) | `TOKEN_MINTING_ACTIVATION_HEIGHT` | 235 | 1360 (active) |
| Contract royalty reads and royalty cap (CONTRACT_NFT_ROYALTY) | `CONTRACT_NFT_ROYALTY_ACTIVATION_HEIGHT` | 235 | 1360 (active) |
| Monetary-integrity rule (MONETARY_INTEGRITY) | `MONETARY_INTEGRITY_ACTIVATION_HEIGHT` | **245** | **1390** |

A node on an older build stops following mainnet at the first block from 235 that uses a new
feature, or at the first block from 245 that the new rule judges differently: it stays at the height
before it and applies nothing wrong. Installing this build and restarting is enough to continue — no
resync.

## What the monetary-integrity rule does (≥ 245)

From block 245 a block is invalid if it carries a transaction that:

- has a fee that is not a finite number of zero or more;
- is of type `slash`;
- sets the faucet flag (mainnet has no faucet; testnet keeps its faucet);
- is of a **suspended type**: `shield`, `shielded_transfer`, `unshield`, `token_lock`,
  `token_unlock`, `create_staking_pool`, `token_stake`, `token_unstake`, `create_proposal`,
  `cast_vote`, `execute_proposal`, `delegate`, `undelegate`, `token_approve`, `token_transfer_from`.

The suspended features are switched off until a later release restores them. On mainnet the shielded
pool is empty and none of the other types has ever been used, so no funds are affected. Transfers,
validator staking, swaps and liquidity, tokens and minting, NFTs, contracts, the bridge, messaging
and mail are unchanged. Nothing changes below the activation height; mainnet history replays
identically.

**Also in this build (no activation height):** stricter verification on the manual bridge-deposit
claim route, the gRPC faucet honours the faucet switch, and the node no longer accepts or produces
transactions with an invalid fee.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `c43773c898fa12897ace7d2dca80f95626da63d3bf5cf3c81fafb7a4a60f86a1` |
| Size | 28,441,848 bytes |
| Source | quantum-vault `2c96256`; the public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) source follows once the release is active |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-monetary-integrity-2c96256` |

Built twice from clean; the two builds were byte-identical. The same binary carries testnet's
schedule. The release is described by a manifest signed with the release keys
([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Check with `rougechain-update status`.

Otherwise back up `node-keys.json` and the data directory, then install the release binary:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-monetary-integrity-2c96256
echo "c43773c898fa12897ace7d2dca80f95626da63d3bf5cf3c81fafb7a4a60f86a1  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.2" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart:

```bash
curl -s localhost:5100/api/stats | python3 -c "import json,sys;d=json.load(sys.stdin);u=d['upgrade_schedule'];print(d['network_height'], u['token_minting'], u['contract_nft_royalty'], u['monetary_integrity'])"
```

It should print the current height followed by `235 235 245`, and the node's `state_root` should
equal `https://api.rougechain.io/api/stats` at the same height.

To go back, stop the node, restore the `.pre-1.6.2` binary and start it again. That is safe only
below block 235.
