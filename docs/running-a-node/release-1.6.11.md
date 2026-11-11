# RougeChain node release 1.6.11: testnet faucet fix; shielded pool V2 on testnet at block 1480 (2026-10)

**Required for every testnet node before testnet block 1480. Recommended for mainnet nodes.**
Mainnet consensus is unchanged: the shielded pool V2 has no activation height on mainnet.

## What changed

- **Testnet: faucet payouts apply the same on every node.** Testnet runs without a genesis file, so
  a node decided whether a faucet payout creates new coins by comparing the sender with *its own*
  key. Only the node holding the faucet key applied it as a mint; every other testnet node applied
  it as an ordinary transfer and rejected the block on its state root (first seen at testnet block
  1467). From 1.6.11 a fixed testnet mint-authority key (the project's testnet node, `41d7fc30…`,
  which signed every testnet faucet payout) decides on every testnet node. The producing node's
  result is unchanged, so testnet history is unchanged. Mainnet keeps its genesis authority set.
- **Testnet:** the shielded pool V2 (`shield_v2`, `shielded_transfer_v2`, `unshield_v2`) activates
  at **testnet block 1480**. From that block testnet nodes accept, verify and apply these
  transactions under the rules of the shielded pool V2 specification, and the
  `POST /api/shield-v2/submit` route added in 1.6.9 starts admitting them. A testnet node on
  an older release will reject the first block that carries one, so upgrade before block 1480.
- **Mainnet:** no change. The release replays mainnet history to the same state root as 1.6.9.
- **Installer 2.1.1** (`install-validator.sh`): adds Ubuntu 26.04 to the supported systems. Nodes
  with auto-update replace their updater with this signed version. No other behaviour changes.
- `quantum-vault-daemon --version` reports `1.6.11`. The `rougechain` CLI is unchanged (1.3.0).

Everything in release 1.6.9 is included, and everything planned for 1.6.10 (which was never published).

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `471567227439993159a169e5ab1c99b9a7373bb81cf7654cf2c5967ad59111b5` |
| Size | 29,531,048 bytes |
| Source | quantum-vault `c208989`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-testnetfix-c208989` |
| CLI | `rougechain` 1.3.0, `rougechain-290d4a2`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |
| Installer | `install-validator-2.1.1-aec42822.sh`, sha256 `aec428220a10040e6ab73a78acccf47ddf9eb450d0e5e367ab119c1080b8b83f` |

Built twice from clean; the two builds were byte-identical. The release is described by manifests
signed with the release keys ([Signed releases](releases.md)). The testnet manifest marks the release
mandatory with `upgrade_before_height` 1480, so testnet nodes with auto-update install it within
minutes of seeing it.

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-testnetfix-c208989
echo "471567227439993159a169e5ab1c99b9a7373bb81cf7654cf2c5967ad59111b5  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.11" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before, `"$BIN" --version` prints
`quantum-vault-daemon 1.6.11`, and on testnet `GET /api/stats` shows `"shield_v2": 1480` in
`upgrade_schedule`.

To go back, stop the node, restore the `.pre-1.6.11` binary and start it again (on testnet only
before block 1480).
