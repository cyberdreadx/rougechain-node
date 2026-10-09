# RougeChain node release 1.6.6 — AMM_INTEGRITY on testnet at block 1440 (2026-10)

**Mandatory for every testnet node before testnet block 1440. Recommended on mainnet, where nothing
activates:** AMM_INTEGRITY has no mainnet height, so a mainnet node on this release validates and
produces exactly as on 1.6.4 and 1.6.5.

## What changed

- **AMM_INTEGRITY activates on testnet at height 1440** (`upgrade_schedule.amm_integrity` is `1440`
  on testnet and `null` on mainnet). From that block, pool transactions (`create_pool`,
  `add_liquidity`, `remove_liquidity`, `swap`) apply all-or-nothing: one that cannot take effect
  changes nothing, pays no fee and does not make the block invalid; swap routes are validated; a
  pair has one pool; amounts use checked integer arithmetic; the fee of a token-to-XRGE swap is
  counted as collected. See the [upgrade schedule](upgrade-schedule.md#amm-integrity).
- A testnet node on an older release cannot follow the chain past the first block at or above 1440
  whose pool transactions the old and the new rules judge differently. Installing this release and
  restarting is enough to catch up.
- `quantum-vault-daemon --version` reports `1.6.6`. The `rougechain` CLI is unchanged (1.3.0).

Everything in release 1.6.5 is included. The mainnet schedule is unchanged, and this binary replays
mainnet history from block 1 to the same state root as 1.6.5.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `bdcfefda3db51fbfc8a100c5c6228c42e8836c96d4bec18dbf82e47d1c59f6db` |
| Size | 29,405,144 bytes |
| Source | quantum-vault `b7bf14b`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-amm-testnet-1440-b7bf14b` |
| CLI | `rougechain` 1.3.0, `rougechain-b7bf14b`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves (node and CLI). Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-amm-testnet-1440-b7bf14b
echo "bdcfefda3db51fbfc8a100c5c6228c42e8836c96d4bec18dbf82e47d1c59f6db  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.6" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before, `"$BIN" --version` prints
`quantum-vault-daemon 1.6.6`, and `curl -s localhost:5100/api/stats | jq .upgrade_schedule.amm_integrity`
prints `1440` on testnet and `null` on mainnet.

To go back (mainnet, or testnet before block 1440), stop the node, restore the `.pre-1.6.6` binary
and start it again.
