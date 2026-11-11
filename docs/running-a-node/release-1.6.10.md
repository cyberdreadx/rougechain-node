# RougeChain node release 1.6.10: shielded pool V2 on testnet at block 1480 (2026-10)

> **Superseded before publication by [release 1.6.11](release-1.6.11.md).** 1.6.10 was never
> published to the release server: a second testnet node rejected testnet block 1467 (a faucet
> payout) on its state root, and 1.6.11 fixes that. Install 1.6.11.

**Required for every testnet node before testnet block 1480. Recommended for mainnet nodes.**
Mainnet consensus is unchanged: the shielded pool V2 has no activation height on mainnet.

## What changed

- **Testnet:** the shielded pool V2 (`shield_v2`, `shielded_transfer_v2`, `unshield_v2`) activates
  at **testnet block 1480**. From that block testnet nodes accept, verify and apply these
  transactions under the rules of the shielded pool V2 specification, and the
  `POST /api/shield-v2/submit` route added in 1.6.9 starts admitting them. A testnet node still on
  1.6.9 or older will reject the first block that carries one, so upgrade before block 1480.
- **Mainnet:** no change. The release replays mainnet history to the same state root as 1.6.9.
- **Installer 2.1.1** (`install-validator.sh`): adds Ubuntu 26.04 to the supported systems. Nodes
  with auto-update replace their updater with this signed version. No other behaviour changes.
- `quantum-vault-daemon --version` reports `1.6.10`. The `rougechain` CLI is unchanged (1.3.0).

Everything in release 1.6.9 is included.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `09042df42c321aac660d07b7191b1dd7ba6389c6c55127730c368719e20722df` |
| Size | 29,544,272 bytes |
| Source | quantum-vault `5afe534`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-shield1480-5afe534` |
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
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-shield1480-5afe534
echo "09042df42c321aac660d07b7191b1dd7ba6389c6c55127730c368719e20722df  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.10" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before, `"$BIN" --version` prints
`quantum-vault-daemon 1.6.10`, and on testnet `GET /api/stats` shows `"shield_v2": 1480` in
`upgrade_schedule`.

To go back, stop the node, restore the `.pre-1.6.10` binary and start it again (on testnet only
before block 1480).
