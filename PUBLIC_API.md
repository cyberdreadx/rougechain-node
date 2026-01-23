# Public API Documentation

## Base URL

```
http://YOUR_SERVER_IP:5100/api
# Or with domain:
https://your-domain.com/api
```

## Endpoints

### 1. Create Wallet

Generate a new post-quantum wallet (ML-DSA-65 keypair).

**Endpoint:** `POST /api/wallet/create`

**Request:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "publicKey": "a1b2c3d4...",
  "privateKey": "e5f6g7h8...",
  "algorithm": "ML-DSA-65"
}
```

**Example:**
```bash
curl -X POST http://your-server:5100/api/wallet/create
```

⚠️ **Security Note**: In production, generate keys client-side and never send private keys over the network.

---

### 2. Submit Transaction

Submit a transfer transaction to the network.

**Endpoint:** `POST /api/tx/submit`

**Request:**
```json
{
  "fromPrivateKey": "your-private-key-hex",
  "fromPublicKey": "your-public-key-hex",
  "toPublicKey": "recipient-public-key-hex",
  "amount": 100.5,
  "fee": 0.1
}
```

**Response:**
```json
{
  "success": true,
  "txId": "transaction-hash-hex",
  "tx": {
    "version": 1,
    "type": "transfer",
    "fromPubKey": "...",
    "nonce": 1234567890,
    "payload": {
      "toPubKeyHex": "...",
      "amount": 100.5
    },
    "fee": 0.1,
    "sig": "..."
  }
}
```

**Example:**
```bash
curl -X POST http://your-server:5100/api/tx/submit \
  -H "Content-Type: application/json" \
  -d '{
    "fromPrivateKey": "...",
    "fromPublicKey": "...",
    "toPublicKey": "...",
    "amount": 100,
    "fee": 0.1
  }'
```

---

### 3. Get Balance

Get the XRGE balance for a public key.

**Endpoint:** `GET /api/balance/{publicKey}`

**Response:**
```json
{
  "success": true,
  "balance": 1000.5
}
```

**Example:**
```bash
curl http://your-server:5100/api/balance/a1b2c3d4...
```

---

### 4. Get Node Stats

Get current node statistics.

**Endpoint:** `GET /api/stats`

**Response:**
```json
{
  "connectedPeers": 5,
  "networkHeight": 1234,
  "isMining": true,
  "nodeId": "uuid-here",
  "totalFeesCollected": 50.5,
  "feesInLastBlock": 0.3
}
```

**Example:**
```bash
curl http://your-server:5100/api/stats
```

---

### 5. Get Blocks

Get all blocks in the chain.

**Endpoint:** `GET /api/blocks`

**Response:**
```json
{
  "blocks": [
    {
      "version": 1,
      "header": {
        "version": 1,
        "chainId": "rougechain-devnet-1",
        "height": 0,
        "time": 1234567890,
        "prevHash": "0000...",
        "txHash": "...",
        "proposerPubKey": "..."
      },
      "txs": [...],
      "proposerSig": "...",
      "hash": "..."
    }
  ]
}
```

**Example:**
```bash
curl http://your-server:5100/api/blocks
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Error message here"
}
```

**HTTP Status Codes:**
- `200`: Success
- `400`: Bad Request (invalid parameters)
- `404`: Not Found
- `500`: Internal Server Error

---

## Rate Limiting

Currently no rate limiting is implemented. For production, add:
- Rate limiting per IP
- Transaction size limits
- Mempool size limits

---

## Security Best Practices

1. **Never send private keys over HTTP**
   - Generate keys client-side
   - Use HTTPS in production
   - Consider encrypting private keys before transmission

2. **Validate all inputs**
   - Check public key format
   - Validate amounts (positive, within limits)
   - Verify signatures client-side before submitting

3. **Use HTTPS**
   - Deploy behind reverse proxy (Nginx/Caddy)
   - Use Let's Encrypt for free SSL

4. **Monitor and log**
   - Log all API requests
   - Monitor for suspicious activity
   - Set up alerts for unusual patterns

---

## Frontend Integration

### JavaScript/TypeScript Example

```typescript
const API_URL = "http://your-server:5100/api";

// Create wallet (client-side is better!)
async function createWallet() {
  const res = await fetch(`${API_URL}/wallet/create`, {
    method: "POST",
  });
  return res.json();
}

// Submit transaction
async function sendTransaction(
  fromPrivateKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: number
) {
  const res = await fetch(`${API_URL}/tx/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromPrivateKey,
      fromPublicKey,
      toPublicKey,
      amount,
      fee: 0.1,
    }),
  });
  return res.json();
}

// Get balance
async function getBalance(publicKey: string) {
  const res = await fetch(`${API_URL}/balance/${publicKey}`);
  return res.json();
}
```

---

## Next Steps

1. **State System**: Implement proper balance tracking
2. **Nonce Management**: Track transaction nonces
3. **Token Support**: Add token creation/transfers
4. **WebSocket**: Real-time updates for transactions
5. **Authentication**: Optional API keys for rate limiting
