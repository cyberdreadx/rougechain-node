# RougeChain node release 1.6.8 — NFT mint stability fix (2026-10)

**Recommended for every node, mainnet and testnet.** No consensus rule changes and no new
activation height.

## What changed

- Fixes a bug that could make a node stop producing and importing blocks, and stop answering its
  API, while it processed certain public NFT mints. A node that hit it stayed stuck until restarted,
  and would get stuck again on the same transaction. 1.6.8 processes those mints normally.
- Upgrade every node, including non-producing ones: a node still on an older release can get stuck
  importing a block that contains such a mint.
- `quantum-vault-daemon --version` reports `1.6.8`. The `rougechain` CLI is unchanged (1.3.0).

Everything in release 1.6.7 is included. The chain rules are unchanged; this binary replays mainnet
and testnet history to the same state roots as 1.6.7.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `b8c11945ef9c94017e2b1cb46472a4855f609b0ef16cb2fa1532d7a7dabf36e2` |
| Size | 29,400,544 bytes |
| Source | quantum-vault `290d4a2`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-nftfix-290d4a2` |
| CLI | `rougechain` 1.3.0, `rougechain-290d4a2`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves (node and CLI). Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-nftfix-290d4a2
echo "b8c11945ef9c94017e2b1cb46472a4855f609b0ef16cb2fa1532d7a7dabf36e2  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.8" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before and `"$BIN" --version` prints
`quantum-vault-daemon 1.6.8`.

To go back, stop the node, restore the `.pre-1.6.8` binary and start it again.
