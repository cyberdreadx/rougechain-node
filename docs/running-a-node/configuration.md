# Configuration

All node configuration is done via command-line flags or environment variables.

## CLI Options

| Flag | Env Variable | Default | Description |
|------|--------------|---------|-------------|
| `--host` | - | `127.0.0.1` | Bind address for API/gRPC. Use `0.0.0.0` for public nodes |
| `--port` | - | `4101` | gRPC port |
| `--api-port` | - | `5101` | HTTP API port |
| `--chain-id` | - | `rougechain-devnet-1` | Chain identifier |
| `--block-time-ms` | - | `400` | Block production interval (ms) |
| `--mine` | - | `false` | Enable block production |
| `--node-name` | `QV_NODE_NAME` | - | Human-readable name shown on the network globe |
| `--data-dir` | - | `~/.quantum-vault/core-node` | Data storage directory |
| `--peers` | `QV_PEERS` | - | Comma-separated peer URLs |
| `--public-url` | `QV_PUBLIC_URL` | - | This node's public URL for peer discovery |
| `--api-keys` | `QV_API_KEYS` | - | Comma-separated API keys |
| `--rate-limit-per-minute` | - | `0` (unlimited) | Rate limit for API requests |
| `--dev` | - | `false` | Dev mode: enables legacy v1 unsigned write endpoints **and** allows any CORS origin |
| — | `QV_CORS_ORIGINS` | *(built-in list)* | Comma-separated origins allowed to call the API from a browser |
| — | `QV_FAUCET_ENABLED` | `false` | Enable the faucet endpoints (testnet/dev only — never set on mainnet) |

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
  --host 0.0.0.0 \
  --api-port 5100 \
  --node-name "MyNode" \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

Once running, visit `http://localhost:5100` in your browser to see the **built-in node dashboard** with live stats, peer list, and block height.

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
├── chain.jsonl          # Block data (append-only)
├── tip.json             # Current chain tip
├── validators-db/       # Validator state (RocksDB)
└── messenger-db/        # Messenger data (RocksDB)
```

## Running with Systemd (Linux)

Create `/etc/systemd/system/rougechain.service`:

```ini
[Unit]
Description=RougeChain Node
After=network.target

[Service]
Type=simple
User=rougechain
ExecStart=/opt/rougechain/quantum-vault-daemon --mine --host 0.0.0.0 --api-port 5100 --node-name "MyNode" --public-url "https://mynode.example.com" --peers "https://testnet.rougechain.io/api"
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
