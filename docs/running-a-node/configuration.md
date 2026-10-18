# Configuration

All node configuration is done via command-line flags or environment variables.

## CLI Options

| Flag | Env Variable | Default | Description |
|------|--------------|---------|-------------|
| `--host` | - | `127.0.0.1` | Bind address for API/gRPC. For public nodes keep `127.0.0.1` behind a reverse proxy (see [Public Node](../p2p-networking/public-node.md)); `0.0.0.0` exposes the API on every interface |
| `--port` | - | `4101` | gRPC port (client services; peers do not use it) |
| `--api-port` | - | `5101` | HTTP API port (also used for all peer traffic) |
| `--chain-id` | - | `rougechain-devnet-1` | Chain identifier (ignored when `--genesis` is given; the genesis file's `chain_id` wins) |
| `--genesis` | `QV_GENESIS` | - | Path to a genesis JSON file (e.g. `genesis-mainnet.json`) |
| `--block-time-ms` | - | `400` | How often the miner checks the mempool (ms). Blocks are only produced when there are transactions |
| `--mine` | - | `false` | Enable block production |
| `--node-name` | `QV_NODE_NAME` | - | Human-readable name shown on the network globe |
| `--data-dir` | - | `~/.quantum-vault/core-node` | Data storage directory |
| `--peers` | `QV_PEERS` | - | Comma-separated peer URLs |
| `--public-url` | `QV_PUBLIC_URL` | - | This node's public URL for peer discovery |
| `--api-keys` | `QV_API_KEYS` | - | Comma-separated API keys. When set, every non-exempt route (reads included) requires a key; see [Running a Node](README.md) |
| `--rate-limit-read-per-minute` | - | `0` (unlimited) | Per-client limit for `GET` requests |
| `--rate-limit-write-per-minute` | - | `0` (unlimited) | Per-client limit for all other methods |
| `--rate-limit-validator` | - | `0` (unlimited) | Limit for requests carrying valid signed validator headers |
| `--rate-limit-peer` | - | `0` (unlimited) | Limit for requests from registered peers (matched by IP) |
| `--rate-limit-per-minute` | - | `0` | Deprecated alias: used for both read and write limits when neither is set |
| `--trust-proxy` | `QV_TRUST_PROXY` | `false` | Key rate limits by `X-Real-IP` / rightmost `X-Forwarded-For` for requests from a loopback peer (a local reverse proxy); other peers are always keyed by socket IP |
| `--dev` | - | `false` | Dev mode: enables legacy v1 unsigned write endpoints **and** allows any CORS origin |
| — | `QV_CORS_ORIGINS` | *(built-in list)* | Comma-separated origins allowed to call the API from a browser |
| — | `QV_FAUCET_ENABLED` | `false` | Enable the faucet endpoints (testnet/dev only — never set on mainnet) |
| `--require-signed-chain-id` | `QV_REQUIRE_SIGNED_CHAIN_ID` | `false` | **REQUIRE_SIGNED_CHAIN_ID.** Refuse signed payloads (`/api/v2` transactions, signed mail/messenger/name requests, CLI envelopes) that do not name this node's chain id (`chainId`; `chain_id` in a CLI envelope), with `CHAIN_ID_REQUIRED`. A payload naming another chain id is always refused (`CHAIN_ID_MISMATCH`), whatever this flag says. Leave off until wallets have shipped the field — see [Security](../security.md#network-binding) |

### Browser access (CORS)

By default a node only accepts browser requests from a built-in allowlist (`localhost:5173`, `localhost:4173`, and the official `rougechain.io` / `rougee.app` origins). A dApp served from any other origin will get a CORS error in the browser (curl is unaffected). To allow your own front-end:

```bash
# Allowlist specific origins:
export QV_CORS_ORIGINS="https://mydapp.example.com,http://localhost:3000"

# Or, for local development, allow any origin:
./quantum-vault-daemon --dev --api-port 5100
```

> `QV_CORS_ORIGINS` takes an explicit comma-separated list — setting it to `"*"` does **not** produce a wildcard. To serve a true `Access-Control-Allow-Origin: *` publicly (as `api.rougechain.io` does), terminate at a reverse proxy (nginx) that strips the node's CORS header and emits `*` itself.

## Examples

### Local Development Node

```bash
./quantum-vault-daemon --mine --api-port 5100
```

### Syncing Node (No Mining)

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

### Public Mining Node

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --node-name "MyNode" \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

Keep the default `--host 127.0.0.1` and serve `--public-url` through a reverse proxy with TLS (see [Public Node](../p2p-networking/public-node.md)). Once running, visit `http://localhost:5100` in your browser to see the **built-in node dashboard** with live stats, peer list, and block height.

### Multiple Peers

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://node1.example.com,https://node2.example.com,https://node3.example.com"
```

### Custom Data Directory

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --data-dir "/var/lib/rougechain"
```

## Environment Variables

You can also use environment variables:

```bash
export QV_PEERS="https://testnet.rougechain.io/api"
export QV_PUBLIC_URL="https://mynode.example.com"
export QV_NODE_NAME="MyNode"
export QV_API_KEYS="key1,key2,key3"

./quantum-vault-daemon --mine --api-port 5100
```

## Data Directory Structure

```
~/.quantum-vault/core-node/
├── node-keys.json       # Node / validator identity keypair
├── chain-db/            # Blocks (sled)
├── validators-db/       # Validator state (sled)
├── messenger-db/        # Messenger data (sled)
├── finality-db/         # Finality certificates (sled)
├── …-db/                # Other sled trees (mail, pools, NFTs, tokens, nonces, …)
├── replay_guard.json    # Seen-signature replay guard
└── finality-signing-journal  # Vote anti-equivocation journal
```

All databases are [sled](https://github.com/spacejam/sled) trees. A legacy `chain.jsonl` is only read once, to migrate an old data directory into `chain-db` (it is then renamed to `chain.jsonl.bak`).

## Running with Systemd (Linux)

Create `/etc/systemd/system/rougechain.service`:

```ini
[Unit]
Description=RougeChain Node
After=network.target

[Service]
Type=simple
User=rougechain
ExecStart=/opt/rougechain/quantum-vault-daemon --mine --api-port 5100 --node-name "MyNode" --public-url "https://mynode.example.com" --peers "https://testnet.rougechain.io/api"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable rougechain
sudo systemctl start rougechain
sudo journalctl -u rougechain -f  # View logs
```
