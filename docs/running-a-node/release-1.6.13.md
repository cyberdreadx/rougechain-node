# RougeChain node release 1.6.13: dependency security updates (2026-11)

**Optional for every node, mainnet and testnet.** No consensus rule changes and no new activation
height.

## What changed

- **TLS libraries updated.** rustls 0.23.46, rustls-webpki 0.103.16 and webpki-roots 1.0.11 fix the
  published advisories in the libraries the node uses for outgoing HTTPS connections (for example to
  Ethereum and Bitcoin endpoints).
- **tokio 1.53.3** fixes a soundness advisory in tokio's file-descriptor handling.
- **The REST API speaks HTTP/1.1 only.** Before, the API port also accepted cleartext HTTP/2.
  Nothing used that: nginx and other nodes connect over HTTP/1.1. Turning it off keeps an advisory
  in the older HTTP/2 library (h2 0.3) out of reach. If you put a proxy in front of the node, make
  sure it talks HTTP/1.1 to the node (nginx `proxy_pass` always does).
- `quantum-vault-daemon --version` reports `1.6.13`. The `rougechain` CLI is unchanged (1.3.0).

The chain rules are unchanged: this binary replays mainnet history to the same state root as 1.6.12.
Everything in release 1.6.12 is included.

## Production binary

| Item | Value |
|---|---|
| Binary | `quantum-vault-daemon` |
| sha256 | `59f9e30dc190121761c8f22563140a5b32506e4746d0f005aa866a5acac2d555` |
| Size | 29,570,464 bytes |
| Source | quantum-vault `4e9d3bc`; public [`rougechain-node`](https://github.com/cyberdreadx/rougechain-node) |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), `x86_64-unknown-linux-gnu` |
| Download | `https://api.rougechain.io/releases/quantum-vault-daemon-deps-4e9d3bc` |
| CLI | `rougechain` 1.3.0, `rougechain-290d4a2`, sha256 `0df5a526a120eeb12ac77a5a86b6b448bbdf80b371c63db0a4c1427ef22f6870` (unchanged) |
| Installer | `install-validator-2.1.1-aec42822.sh` (unchanged) |

Built twice from clean; the two builds were byte-identical. The release is described by manifests
signed with the release keys ([Signed releases](releases.md)).

## Upgrade

Nodes installed with the one-line installer and [auto-update](auto-update.md) install this release by
themselves. Otherwise:

```bash
curl -fLo /tmp/quantum-vault-daemon https://api.rougechain.io/releases/quantum-vault-daemon-deps-4e9d3bc
echo "59f9e30dc190121761c8f22563140a5b32506e4746d0f005aa866a5acac2d555  /tmp/quantum-vault-daemon" | sha256sum -c
systemctl cat rougechain-validator | grep ExecStart      # the first path is the binary your node runs
BIN=/path/from/ExecStart/quantum-vault-daemon             # set this to that path
sudo systemctl stop rougechain-validator
sudo cp -p "$BIN" "$BIN.pre-1.6.13" && sudo install -m 755 /tmp/quantum-vault-daemon "$BIN"
sudo systemctl start rougechain-validator
```

**Check** after the restart: the node follows the chain as before and `"$BIN" --version` prints
`quantum-vault-daemon 1.6.13`.

To go back, stop the node, restore the `.pre-1.6.13` binary and start it again.
