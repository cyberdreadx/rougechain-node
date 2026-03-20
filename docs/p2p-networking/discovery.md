# Peer Discovery

RougeChain nodes automatically discover other nodes on the network through a gossip-based peer exchange protocol.

## How Discovery Works

```
1. Node A starts with seed peer(s) via --peers
2. Node A queries GET /api/peers on each known peer
3. Each peer returns its own list of known peers
4. Node A adds any new peers to its local list
5. If --public-url is set, Node A registers itself on peers
6. Repeat every 30 seconds
```

Over time, all nodes in the network discover each other, forming a mesh.

## Discovery Interval

Peer discovery runs automatically every **30 seconds**. No configuration is needed.

## Seed Peers

The first peer(s) you connect to act as seeds for discovery. From them, your node learns about the rest of the network.

```bash
# Single seed
./quantum-vault-daemon --peers "https://testnet.rougechain.io/api"

# Multiple seeds for redundancy
./quantum-vault-daemon --peers "https://testnet.rougechain.io,https://backup.example.com"
```

## Self-Registration

To make your node discoverable by others, set `--public-url`:

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

Your node will call `POST /api/peers/register` on all known peers, announcing its presence. Other nodes will then include your URL in their peer lists.

## Discovery API

### Get Known Peers

```bash
curl http://127.0.0.1:5100/api/peers
```

```json
{
  "peers": [
    "https://testnet.rougechain.io/api",
    "https://node2.example.com/api",
    "https://node3.example.com/api"
  ],
  "count": 3
}
```

### Register as a Peer

```bash
curl -X POST https://testnet.rougechain.io/api/peers/register \
  -H "Content-Type: application/json" \
  -d '{"peerUrl": "https://mynode.example.com"}'
```

## Discovery Diagram

```
         Seed Node
        ┌─────────┐
        │  Node A  │ ◄── your --peers target
        └────┬────┘
             │
     GET /api/peers
             │
    ┌────────┼────────┐
    ▼        ▼        ▼
┌───────┐┌───────┐┌───────┐
│Node B ││Node C ││Node D │  ◄── discovered automatically
└───────┘└───────┘└───────┘
    │         │        │
    └─────────┼────────┘
              │
    More peers discovered
       from B, C, D...
```

## Privacy Considerations

- Your node's IP/URL is shared with all peers when using `--public-url`
- Without `--public-url`, your node connects outward but is not discoverable by others
- Consider using a reverse proxy or domain name instead of exposing raw IP addresses
