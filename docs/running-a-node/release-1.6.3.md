# RougeChain node release 1.6.3 — messenger and mail hardening (2026-10)

**Recommended for every node. Not a consensus change:** no activation height, no state change, and a
node that has not installed it keeps following the chain. Nodes that serve the public API should
install it promptly.

## What changed

- **Messenger directory.** A directory entry can only be replaced by the wallet that owns it,
  identified by the signing key that authenticates the request. An encryption key that is already
  registered to another wallet is refused. Mail names and mail folders follow the owning wallet only.
- **Legacy read routes retired.** `GET /api/mail/inbox`, `/api/mail/sent`, `/api/mail/trash`,
  `/api/mail/message/:id`, `/api/messenger/conversations` and `/api/messenger/messages` return
  `410 Gone` (outside `--dev`). Clients use the signed routes: `POST /api/v2/mail/folder`,
  `/api/v2/messenger/conversations/list` and `/api/v2/messenger/messages/list`.
- **Suspended transaction types** are refused by the shielded API routes before any request data
  is processed, with `this transaction type is suspended`.

Everything in release 1.6.2 is included; the upgrade schedule is unchanged (mainnet 235 / 235 / 245,
testnet 1360 / 1360 / 1390, all active).

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `58c0288fc0137f35f4b986be24b010589ff4783c58239bde229f6a7014ab6171` |
| Size | 28,441,912 bytes |
| Source | quantum-vault `8eacc0d`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-directory-hardening-8eacc0d` |

Built twice from clean; the two builds were byte-identical. The release is described by a manifest
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-directory-hardening-8eacc0d
echo "58c0288fc0137f35f4b986be24b010589ff4783c58239bde229f6a7014ab6171  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.3" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before and
`curl -s -o /dev/null -w '%{http_code}\n' "localhost:5100/api/mail/inbox?walletId=x"` prints `410`.

To go back, stop the node, restore the `.pre-1.6.3` binary and start it again.
