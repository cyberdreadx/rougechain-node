# RougeChain node release 1.6.4 — signatures commit to the network (2026-10)

**Recommended for every node. Not a consensus change:** no activation height, no state change, and a
node that has not installed it keeps following the chain. Nodes that serve the public API should
install it promptly — it is step 1 of the [network-binding rollout](upgrade-schedule.md).

## What changed

- **Signatures commit to the network.** Wallets now put the network they sign for into the signed
  bytes (`chainId` in `/api/v2` payloads and in signed mail, messenger, name and vote requests;
  `chain_id` in a `rougechain` CLI envelope). The node refuses a signed payload that names another
  network with `CHAIN_ID_MISMATCH` — at the API, in the mempool and when producing a block. A payload
  that names no network is still accepted. See [Security](../security.md#network-binding).
- **`REQUIRE_SIGNED_CHAIN_ID`** (`--require-signed-chain-id` / `QV_REQUIRE_SIGNED_CHAIN_ID`, default
  **off**). When on, the node also refuses payloads that name no network (`CHAIN_ID_REQUIRED`).
  Leave it off for now: turn it on once the wallets your users sign with have shipped the field
  (site, `@rougechain/sdk` 1.15.0, extension 1.9.0, Qwalla 1.3.0, CLI 1.3.0) and your node no longer
  receives payloads without it — testnet first, announced in the
  [upgrade schedule](upgrade-schedule.md) (rollout step 3).
- **Batch submissions get the same checks as single ones.** Every item of
  `POST /api/v2/batch-submit` now goes through the checks of a single `/api/v2` submission: the
  5-minute timestamp window, the signature replay guard (shared with the single routes and kept
  across restarts), the network rule, `from` = signer and the signed `account_nonce`. Verification is
  all-or-nothing: if any item fails, or the same signature appears twice, the whole batch is refused
  (`success: false`, `accepted: 0`, a result per item), nothing is queued and no signature is used up,
  so the valid items can be sent again unchanged. A batch that passes is offered to the mempool item
  by item, as before.
- **Balances.** `GET /api/balance/:publicKey/XRGE` returns the native XRGE balance (`native: true`);
  it used to answer 0. Both balance routes also return the stored integers as decimal strings
  (`balance_raw` + `decimals`; `balance_quanta` + `token_balances_raw`) — use these for any threshold
  check ([Units and precision](../advanced/wallet-authentication.md#units-and-precision)).
- **Present but not active.** The shielded pool V2 code is included and inactive
  (`upgrade_schedule.shield_v2` is `null` on every network). The consensus rules CHAIN_ID_BINDING and
  CONTRACT_CHAIN_ID are included and unscheduled (`chain_id_binding` / `contract_chain_id` are
  `null`); each will get its height in a later, announced release.
- `quantum-vault-daemon --version` reports `1.6.4` (earlier binaries reported `0.1.0`).

Everything in release 1.6.3 is included; the upgrade schedule is unchanged (mainnet 235 / 235 / 245,
testnet 1360 / 1360 / 1390, all active). This binary replays mainnet and testnet history to the same
state roots as 1.6.3.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `05a320122175c8c6847448f6ab358a17592365e3ab8f881b5d982788d4587573` |
| Size | 29,383,808 bytes |
| Source | quantum-vault `0be1493`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-network-binding-0be1493` |
| CLI | `rougechain` 1.3.0, `rougechain-0be1493`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves (node and CLI). Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-network-binding-0be1493
echo "05a320122175c8c6847448f6ab358a17592365e3ab8f881b5d982788d4587573  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.4" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before, `"$BIN" --version` prints
`quantum-vault-daemon 1.6.4`, and `curl -s localhost:5100/api/stats | jq .upgrade_schedule` shows
`chain_id_binding`, `contract_chain_id` and `shield_v2` as `null`.

To go back, stop the node, restore the `.pre-1.6.4` binary and start it again.
