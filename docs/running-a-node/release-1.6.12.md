# RougeChain node release 1.6.12: public social likers and following feed (2026-11)

**Optional for every node, mainnet and testnet.** No consensus rule changes and no new activation
height.

## What changed

- `GET /api/social/post/:postId/likers?limit&offset` returns `{ likers, total }`: the wallets that
  liked a post (the reverse of the existing per-wallet likes route). `limit` is at most 200.
- `GET /api/social/user/:pubkey/feed?limit&offset` returns `{ posts }`: recent posts from every
  account `pubkey` follows, newest first, without a signed request. The follow graph and the posts
  were already public; the signed `/api/v2/social/feed` stays. `limit` is at most 100, `offset` at
  most 1000.
- `quantum-vault-daemon --version` reports `1.6.12`. The `rougechain` CLI is unchanged (1.3.0).

Social data is kept by each node and is not part of the chain, so the chain rules are unchanged:
this binary replays mainnet history to the same state root as 1.6.11. Everything in release 1.6.11
is included.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `e4bc9aed1f5e74e9f887affa25a2f5be71ae26ace7e3b0ec747c95d1ecda7032` |
| Size | 29,563,008 bytes |
| Source | quantum-vault `96ada5d`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-social-96ada5d` |
| CLI | `rougechain` 1.3.0, `rougechain-290d4a2`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` (rebuilt from this source: identical) |
| Installer | `install-validator-2.1.1-aec42822.sh` (unchanged) |

Built twice from clean; the two builds were byte-identical. The release is described by manifests
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-social-96ada5d
echo "e4bc9aed1f5e74e9f887affa25a2f5be71ae26ace7e3b0ec747c95d1ecda7032  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.12" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before and `"$BIN" --version` prints
`quantum-vault-daemon 1.6.12`.

To go back, stop the node, restore the `.pre-1.6.12` binary and start it again.
