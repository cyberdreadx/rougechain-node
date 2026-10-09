# RougeChain node release 1.6.5 — AMM_INTEGRITY included, not scheduled (2026-10)

**Recommended for every node. Nothing activates with this release:** it carries the consensus rule
AMM_INTEGRITY without an activation height, so a node that installs it validates and produces
exactly as release 1.6.4 does, and a node that has not installed it keeps following the chain.
Validators should install it now: the rule can only be given a height once every validator runs a
release that contains it.

## What changed

- **AMM_INTEGRITY is in the node, unscheduled.** From its activation height, pool transactions
  (`create_pool`, `add_liquidity`, `remove_liquidity`, `swap`) apply all-or-nothing:
  - a transaction that cannot take effect changes nothing, pays no fee and does not make the block
    invalid;
  - a swap route must name 2 to 4 tokens, start at the input token, end at the output token, use no
    pool twice, and every pool on it must exist and pay out;
  - a pair has one pool, whatever the order or letter case of the two symbols;
  - amounts are computed with checked integer arithmetic;
  - the fee of a token-to-XRGE swap is counted as collected.

  The rule and what it does not cover are described in the
  [upgrade schedule](upgrade-schedule.md#amm-integrity). `upgrade_schedule.amm_integrity` in
  `GET /api/stats` is `null` on every network. The height will come in a later, announced release —
  testnet first.
- `quantum-vault-daemon --version` reports `1.6.5`. The `rougechain` CLI is unchanged (1.3.0),
  rebuilt from the same commit.

Everything in release 1.6.4 is included; the upgrade schedule is unchanged (mainnet 235 / 235 / 245,
testnet 1360 / 1360 / 1390, all active). This binary replays mainnet history from block 1 to the
same state root as 1.6.4.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `d4ac78ef1082a0ff12af71734d67dab1caf9c5e267a7530c2264bd00f2a7da8f` |
| Size | 29,404,488 bytes |
| Source | quantum-vault `e433489`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-amm-integrity-e433489` |
| CLI | `rougechain` 1.3.0, `rougechain-e433489`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves (node and CLI). Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-amm-integrity-e433489
echo "d4ac78ef1082a0ff12af71734d67dab1caf9c5e267a7530c2264bd00f2a7da8f  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.5" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before, `"$BIN" --version` prints
`quantum-vault-daemon 1.6.5`, and `curl -s localhost:5100/api/stats | jq .upgrade_schedule` shows
`amm_integrity` as `null`.

To go back, stop the node, restore the `.pre-1.6.5` binary and start it again.
