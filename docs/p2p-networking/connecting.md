# Connecting to Peers

Connect your RougeChain node to the network to sync blocks and broadcast transactions.

## Connect to Testnet

The simplest way to join the network:

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

Your node will:
1. Download all blocks from the peer
2. Verify each block's PQC signatures
3. Build the local chain state
4. Start receiving new blocks in real-time

> **⚠️ Important: Your node is syncing but INVISIBLE to the network.**
>
> Without `--public-url`, your node pulls blocks from peers but **never registers itself**. Other nodes won't know it exists, and it won't appear on the [network globe](https://rougechain.io/blockchain).
>
> To be discoverable, add `--public-url` with your node's reachable address:
>
> ```bash
> ./quantum-vault-daemon \
>   --api-port 5100 \
>   --node-name "MyNode" \
>   --public-url "https://your-server.com:5100" \
>   --peers "https://testnet.rougechain.io/api"
> ```
>
> If running locally without a public IP, your node works fine for personal use — it just won't be visible to the rest of the network.

## Connect to Multiple Peers

For better reliability, connect to multiple peers:

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://api.rougechain.io/api,https://node2.example.com,https://node3.example.com"
```

Or via environment variable:

```bash
export QV_PEERS="https://api.rougechain.io/api,https://node2.example.com"
./quantum-vault-daemon --api-port 5100
```

## Verify Connection

Check that your node has peers:

```bash
curl http://127.0.0.1:5100/api/peers
```

Expected response:
```json
{
  "peers": [
    "https://testnet.rougechain.io/api"
  ],
  "count": 1
}
```

## Sync Status

Check if your node is synced:

```bash
curl http://127.0.0.1:5100/api/health
```

```json
{
  "status": "ok",
  "chain_id": "rougechain-devnet-1",
  "height": 12345
}
```

Compare the `height` with the testnet to confirm you're in sync:

```bash
curl https://testnet.rougechain.io/api/health
```

## Connection Flow

```
Your Node                          Peer Node
    │                                  │
    │── GET /api/health ──────────────►│
    │◄─── { height: 12345 } ──────────│
    │                                  │
    │── GET /api/blocks?from=0 ───────►│
    │◄─── [ block0, block1, ... ] ────│
    │                                  │
    │   (verify signatures, apply)     │
    │                                  │
    │── GET /api/peers ───────────────►│
    │◄─── { peers: [...] } ───────────│
    │                                  │
    │   (discover new peers)           │
```

## Firewall & Exposure

**Do not expose the daemon's REST API port (5100) to the public internet** — it
serves state-changing endpoints. Bind the daemon to `127.0.0.1` and put a reverse
proxy (nginx + TLS) in front of it; open only the proxy's port 443. See
[Public Node Security](public-node.md).

| Port | Bind | Exposure |
|------|------|----------|
| 443 (nginx/TLS) | public | ✅ the only port open to the internet |
| 5100 (daemon REST API) | `127.0.0.1` | ❌ never open to the public |
| 4100 (P2P) | as needed | reachable by peers only; restrict where possible |

```bash
# Expose ONLY the reverse proxy; keep the daemon API private:
sudo ufw allow 443/tcp
sudo ufw deny 5100/tcp
```

## Troubleshooting

### "Connection refused"

- Check that the peer URL is correct and reachable
- Verify the peer node is running
- Check for firewall restrictions

### Node stuck syncing

- The initial sync may take time on long chains
- Monitor progress by watching the `height` increase via `/api/health`
- Try connecting to a different peer

### "Chain ID mismatch"

- Ensure your `--chain-id` matches the network you're connecting to
- Testnet uses `rougechain-devnet-1`
