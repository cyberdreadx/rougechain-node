# Peers API

Endpoints for P2P peer management and discovery.

## List Peers

Get all known peers.

```http
GET /api/peers
```

### Response

```json
{
  "peers": [
    "https://testnet.rougechain.io/api",
    "https://node2.example.com/api"
  ],
  "count": 2
}
```

---

## Register Peer

Register this node with another peer (enables discovery).

```http
POST /api/peers/register
Content-Type: application/json
```

### Request Body

```json
{
  "peerUrl": "https://mynode.example.com"
}
```

### Response

```json
{
  "success": true,
  "message": "Peer registered"
}
```

If the peer is already known:

```json
{
  "success": true,
  "message": "Peer already known"
}
```

---

## Import Block (P2P)

Receive a block from a peer (used for block propagation).

```http
POST /api/blocks/import
Content-Type: application/json
```

### Request Body

The full block object:

```json
{
  "version": 1,
  "header": {
    "version": 1,
    "chainId": "rougechain-devnet-1",
    "height": 42,
    "time": 1706745600000,
    "prevHash": "abc123...",
    "txHash": "def456...",
    "proposerPubKey": "..."
  },
  "txs": [...],
  "proposerSig": "...",
  "hash": "..."
}
```

### Response

```json
{
  "success": true
}
```

### Error Response

```json
{
  "success": false,
  "error": "Block height 42 doesn't extend tip height 40"
}
```

---

## Broadcast Transaction (P2P)

Receive a transaction broadcast from a peer.

```http
POST /api/tx/broadcast
Content-Type: application/json
```

### Request Body

The full transaction object.

### Response

```json
{
  "success": true
}
```

---

## Peer Discovery Flow

```
1. Node A starts with --peers "https://seed.example.com"

2. Node A calls GET /api/peers on seed node
   → Receives list of other peers

3. Node A adds new peers to its list

4. If Node A has --public-url, it calls POST /api/peers/register
   on all known peers to announce itself

5. Every 30 seconds, repeat steps 2-4
```

This creates a mesh network where all nodes eventually discover each other.
