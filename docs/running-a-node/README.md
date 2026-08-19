# Running a Node

Run your own RougeChain node to sync the chain, validate transactions, serve an API to others, and — if you stake — produce blocks and earn rewards.

The node software is **open source** on [GitHub](https://github.com/cyberdreadx/rougechain-node).

## Node Types

| Type | What it does | Key flags |
|------|--------------|-----------|
| **Full node** | Syncs and validates all blocks from peers | `--peers` |
| **Mining / validator node** | Produces blocks (requires ≥ 10,000 XRGE staked to be selected) | `--mine` |
| **Public node** | Serves an API/RPC to other users and apps | `--host 0.0.0.0` + reverse proxy |

A single node can be all three at once.

## Minimum System Requirements

RougeChain's node is deliberately lightweight — the Rust daemon is a single ~23 MB binary and the live mainnet validator holds a steady **~40 MB of RAM**. The heaviest part is *building* it, not running it.

### To run a node

| | Minimum | Recommended (public / validator) |
|---|---|---|
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 1 GB | 2–4 GB |
| Disk | 5 GB SSD | 20+ GB SSD (chain data grows over time; SSD matters for the embedded `sled` DB) |
| Network | Any stable broadband | ≥ 100 Mbps, static IP or a domain with TLS |
| OS | Linux (Ubuntu 22.04+), Windows, or Docker | Linux |

> The daemon itself uses tens of MB of RAM; the extra headroom is for the OS, chain-data growth, and serving concurrent API traffic.

### To build from source

| | Requirement |
|---|---|
| Rust | Recent stable toolchain (1.80+); the project builds on 1.94 |
| RAM during compile | ~4 GB |
| Free disk for `target/` | ~6 GB |
| Tools | `git`, a C toolchain (`build-essential` on Debian/Ubuntu) |

A clean release build takes roughly 2–5 minutes depending on cores. If you only want to *run* a node and not build it, you can also use the [Docker image](docker.md).

## Quick Start

```bash
# Clone and enter the workspace
git clone https://github.com/cyberdreadx/rougechain-node
cd rougechain-node/core

# Build the daemon (release)
cargo build --release -p quantum-vault-daemon
```

### Join Mainnet

Mainnet requires the mainnet genesis file (shipped in the repo) and the mainnet chain-id:

```bash
./target/release/quantum-vault-daemon \
  --genesis daemon/genesis-mainnet.json \
  --chain-id rougechain-mainnet-1 \
  --api-port 5100 \
  --data-dir ~/.quantum-vault/mainnet \
  --peers "https://api.rougechain.io/api" \
  --node-name my-node
```

Add `--mine` if you intend to validate (you'll only be selected once you've staked ≥ 10,000 XRGE — see [Staking](../staking/README.md)).

### Join Testnet

Testnet uses default parameters (no genesis file needed):

```bash
./target/release/quantum-vault-daemon \
  --chain-id rougechain-devnet-1 \
  --api-port 5101 \
  --data-dir ~/.quantum-vault/testnet \
  --peers "https://testnet.rougechain.io/api" \
  --node-name my-testnet-node
```

## Running a Public Node (for other people)

If you want your node to serve an API/RPC to users, wallets, or apps, run it as a **public node**. Do **not** expose the daemon port directly — put a TLS reverse proxy (nginx) in front and keep the daemon bound to localhost or firewalled.

Recommended operator setup:

1. **Bind and advertise** — run with `--host 0.0.0.0 --api-port 5100` (firewalled) and set `--public-url https://your-domain/api` so peers can reach you.
2. **Terminate TLS at nginx** — proxy `https://your-domain/api` → `http://127.0.0.1:5100`. A full nginx example is in [Running a Public Node](../p2p-networking/public-node.md).
3. **Protect writes** — set `--api-keys "<key1>,<key2>"` so only holders of a key can hit write endpoints. (Signed `/api/v2/*` and public `/api/faucet`, `/api/bridge/*` handle their own auth.)
4. **Rate-limit** — e.g. `--rate-limit-per-minute 120` (plus `--rate-limit-read/write-per-minute` for finer control) to keep a single client from overwhelming the node.
5. **Run under systemd** — so it restarts on crash/reboot. Example unit and hardening in [Public Node](../p2p-networking/public-node.md) and [Configuration](configuration.md).
6. **Monitor** — poll `/api/health` (liveness) and `/api/stats` (height, peers, mining) from your uptime checker.

> Security note: legacy `v1` write endpoints that accept a raw private key are **development-only** (enabled with `--dev`) and return `410 Gone` in a normal build — never run a public node with `--dev`.

## Verify It's Working

```bash
curl http://127.0.0.1:5100/api/health
```

Expected response (mainnet):
```json
{
  "status": "ok",
  "chain_id": "rougechain-mainnet-1",
  "height": 12345
}
```

Check sync progress and peers:
```bash
curl http://127.0.0.1:5100/api/stats
```

## Next Steps

- [Installation](installation.md) — detailed setup, per-OS
- [Configuration](configuration.md) — every CLI flag and environment variable
- [Running a Public Node](../p2p-networking/public-node.md) — full nginx + systemd operator guide
- [Mining](mining.md) — block production and validator selection
- [Staking](../staking/README.md) — the 10,000 XRGE minimum and rewards
