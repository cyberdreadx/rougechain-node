# P2P Networking

RougeChain uses a peer-to-peer network for block propagation, transaction broadcasting, and peer discovery.

## How It Works

```
┌─────────────┐     blocks/txs      ┌─────────────┐
│   Node A    │ ◄─────────────────► │   Node B    │
│  (mining)   │                     │  (syncing)  │
└─────────────┘                     └─────────────┘
       ▲                                   ▲
       │           peer discovery          │
       └───────────────┬───────────────────┘
                       │
                       ▼
               ┌─────────────┐
               │   Node C    │
               │ (new peer)  │
               └─────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **Block Sync** | Nodes download and verify blocks from peers |
| **Transaction Broadcast** | Submitted txs propagate to all peers |
| **Peer Discovery** | Nodes share their peer lists with each other |
| **Genesis Reset** | New nodes automatically adopt the network's chain |

## Connecting to the Network

### As a Syncing Node

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

### As a Mining Node

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api"
```

## Peer Discovery

Nodes automatically discover new peers every 30 seconds by:

1. Querying known peers via `GET /api/peers`
2. Adding any new peers to their list
3. Optionally registering themselves via `POST /api/peers/register`

### Enable Self-Registration

```bash
./quantum-vault-daemon \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

This tells other nodes how to reach you.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/peers` | GET | List known peers |
| `/api/peers/register` | POST | Register as a peer |
| `/api/blocks/import` | POST | Import a block (peer-to-peer) |
| `/api/tx/broadcast` | POST | Receive a broadcasted transaction |

## Next Steps

- [Connecting to Peers](connecting.md)
- [Peer Discovery](discovery.md)
- [Running a Public Node](public-node.md)
