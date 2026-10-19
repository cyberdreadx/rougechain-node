# RougeChain node release 1.6.9: shielded pool V2 submit route (2026-10)

**Recommended for every node, mainnet and testnet.** No consensus rule changes and no new
activation height.

## What changed

- Adds `POST /api/shield-v2/submit`, the route wallets use to send shielded pool V2 transactions
  (`shield_v2`, `shielded_transfer_v2`, `unshield_v2`). It accepts those three types only and turns
  everything else away. The shielded pool V2 has no activation height on either network, so until
  one is set the node refuses every transaction sent there, exactly as before.
- A node that accepts such a transaction forwards it to its peers on the same route, so it reaches
  the block producer whichever node the wallet sent it to.
- `quantum-vault-daemon --version` reports `1.6.9`. The `rougechain` CLI is unchanged (1.3.0).

Everything in release 1.6.8 is included. The chain rules are unchanged; this binary replays mainnet
and testnet history to the same state roots as 1.6.8.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `d7e39beb1e8537182bebbf3f0f0bc94cf86615774970e73f90d763dc9020605f` |
| Size | 29,545,824 bytes |
| Source | quantum-vault `dc85da7`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-shieldsubmit-dc85da7` |
| CLI | `rougechain` 1.3.0, `rougechain-290d4a2`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-shieldsubmit-dc85da7
echo "d7e39beb1e8537182bebbf3f0f0bc94cf86615774970e73f90d763dc9020605f  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.9" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before and `"$BIN" --version` prints
`quantum-vault-daemon 1.6.9`.

To go back, stop the node, restore the `.pre-1.6.9` binary and start it again.
