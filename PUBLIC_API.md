# Public API Documentation

## Base URL

```
http://YOUR_SERVER_IP:5100/api
# Or with domain:
https://your-domain.com/api
```

## Authentication

All endpoints (except `/api/health`) require an API key when enabled on the core node.
Send one of the following:

- Header: `X-API-Key: YOUR_API_KEY`
- Header: `Authorization: Bearer YOUR_API_KEY`

## Security: Client-Side Signing (v2 API)

The v2 API endpoints accept **pre-signed transactions** - your private key **never leaves your browser**.

All v2 endpoints expect this format:
```json
{
  "payload": { /* transaction-specific fields */ },
  "signature": "hex-encoded-ml-dsa-65-signature",
  "public_key": "your-public-key-hex"
}
```

See the [Secure v2 API](#secure-v2-api-endpoints) section below.

---

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

### 6. Get Transactions

Get recent transactions (newest first).

**Endpoint:** `GET /api/txs?limit=200&offset=0`

**Response:**
```json
{
  "txs": [
    {
      "txId": "transaction-hash-hex",
      "blockHeight": 42,
      "blockHash": "block-hash-hex",
      "blockTime": 1712345678,
      "tx": {
        "version": 1,
        "tx_type": "transfer",
        "from_pub_key": "...",
        "nonce": 1234567890,
        "payload": {
          "to_pub_key_hex": "...",
          "amount": 100
        },
        "fee": 0.1,
        "sig": "..."
      }
    }
  ],
  "total": 100
}
```

**Example:**
```bash
curl http://your-server:5100/api/txs?limit=50
```

---

### 7. Get Validators

Get the current validator set and stake amounts.

**Endpoint:** `GET /api/validators`

**Response:**
```json
{
  "success": true,
  "validators": [
    {
      "publicKey": "...",
      "stake": "10000",
      "status": "active",
      "slashCount": 0,
      "jailedUntil": 0,
      "entropyContributions": 0
    }
  ],
  "totalStake": "10000"
}
```

---

### 7. Proposer Selection

Get the current proposer selection info.

**Endpoint:** `GET /api/selection`

---

### 8. Finality Status

Get finalized height and quorum stake.

**Endpoint:** `GET /api/finality`

---

### 9. Vote Summary

Get vote quorum status for a given height.

**Endpoint:** `GET /api/votes?height={height}`

---

### 10. Validator Vote Stats

Aggregate vote participation stats.

**Endpoint:** `GET /api/validators/stats`

---

### 11. Submit Stake

Submit a validator stake transaction.

**Endpoint:** `POST /api/stake/submit`

---

### 12. Submit Unstake

Submit a validator unstake transaction.

**Endpoint:** `POST /api/unstake/submit`

---

### 13. Submit Vote

Submit a validator prevote or precommit.

**Endpoint:** `POST /api/votes/submit`

---

### 14. Submit Entropy Contribution

Submit a quantum entropy contribution (metadata only).

**Endpoint:** `POST /api/entropy/submit`

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
- `429`: Too Many Requests (rate limited)

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

---

## AMM/DEX Endpoints

### Get All Pools

**Endpoint:** `GET /api/pools`

**Response:**
```json
{
  "pools": [
    {
      "pool_id": "XRGE-QSHIB",
      "token_a": "XRGE",
      "token_b": "QSHIB",
      "reserve_a": 10000,
      "reserve_b": 50000,
      "total_lp_supply": 22360,
      "fee_rate": 0.003
    }
  ]
}
```

### Get Pool Details

**Endpoint:** `GET /api/pool/{pool_id}`

### Get Pool Price History

**Endpoint:** `GET /api/pool/{pool_id}/prices`

### Get Pool Events

**Endpoint:** `GET /api/pool/{pool_id}/events`

### Get Pool Stats

**Endpoint:** `GET /api/pool/{pool_id}/stats`

### Get Swap Quote

**Endpoint:** `POST /api/swap/quote`

**Request:**
```json
{
  "token_in": "XRGE",
  "token_out": "QSHIB",
  "amount_in": 100
}
```

**Response:**
```json
{
  "success": true,
  "amount_out": 495,
  "price_impact": 0.5,
  "path": ["XRGE", "QSHIB"],
  "pools": ["XRGE-QSHIB"]
}
```

---

## Burn Address

### Get Burn Address

Get the official burn address for token burning.

**Endpoint:** `GET /api/burn-address`

**Response:**
```json
{
  "burn_address": "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD",
  "description": "Official burn address. Tokens sent here are permanently destroyed and tracked on-chain."
}
```

### Get Burned Tokens

Get total burned amounts for all tokens.

**Endpoint:** `GET /api/burned`

**Response:**
```json
{
  "burned": {
    "XRGE": 50000,
    "QSHIB": 1000000
  },
  "total_xrge_burned": 50000
}
```

---

## Secure v2 API Endpoints

All v2 endpoints accept **pre-signed transactions**. Private keys never leave the client.

### Transaction Payload Format

```typescript
{
  payload: {
    type: "transfer" | "swap" | "create_pool" | "add_liquidity" | "remove_liquidity" | "stake" | "unstake" | "faucet",
    from: "sender-public-key",
    timestamp: 1234567890123,  // Must be within 5 minutes
    nonce: "random-hex-nonce",
    // ... transaction-specific fields
  },
  signature: "ml-dsa-65-signature-hex",
  public_key: "sender-public-key"
}
```

### v2 Transfer

**Endpoint:** `POST /api/v2/transfer`

**Payload fields:**
```json
{
  "type": "transfer",
  "from": "sender-public-key",
  "to": "recipient-public-key",
  "amount": 100,
  "fee": 1,
  "token": "XRGE",
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Create Token

**Endpoint:** `POST /api/v2/token/create`

**Payload fields:**
```json
{
  "type": "create_token",
  "from": "creator-public-key",
  "token_name": "My Token",
  "token_symbol": "MTK",
  "initial_supply": 1000000,
  "fee": 10,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Swap

**Endpoint:** `POST /api/v2/swap/execute`

**Payload fields:**
```json
{
  "type": "swap",
  "from": "sender-public-key",
  "token_in": "XRGE",
  "token_out": "QSHIB",
  "amount_in": 100,
  "min_amount_out": 490,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Create Pool

**Endpoint:** `POST /api/v2/pool/create`

**Payload fields:**
```json
{
  "type": "create_pool",
  "from": "creator-public-key",
  "token_a": "XRGE",
  "token_b": "QSHIB",
  "amount_a": 1000,
  "amount_b": 5000,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Add Liquidity

**Endpoint:** `POST /api/v2/pool/add-liquidity`

**Payload fields:**
```json
{
  "type": "add_liquidity",
  "from": "sender-public-key",
  "pool_id": "XRGE-QSHIB",
  "amount_a": 100,
  "amount_b": 500,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Remove Liquidity

**Endpoint:** `POST /api/v2/pool/remove-liquidity`

**Payload fields:**
```json
{
  "type": "remove_liquidity",
  "from": "sender-public-key",
  "pool_id": "XRGE-QSHIB",
  "lp_amount": 100,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Stake

**Endpoint:** `POST /api/v2/stake`

**Payload fields:**
```json
{
  "type": "stake",
  "from": "sender-public-key",
  "amount": 1000,
  "fee": 1,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Unstake

**Endpoint:** `POST /api/v2/unstake`

**Payload fields:**
```json
{
  "type": "unstake",
  "from": "sender-public-key",
  "amount": 1000,
  "fee": 1,
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

### v2 Faucet

**Endpoint:** `POST /api/v2/faucet`

**Payload fields:**
```json
{
  "type": "faucet",
  "from": "sender-public-key",
  "timestamp": 1234567890123,
  "nonce": "random-hex"
}
```

---

## Burning Tokens

To burn tokens, send a transfer to the official burn address:

```typescript
import { secureBurn, BURN_ADDRESS } from "@/lib/secure-api";

// Burn 100 XRGE
await secureBurn(wallet.publicKey, wallet.privateKey, 100);

// Burn 50 custom tokens
await secureBurn(wallet.publicKey, wallet.privateKey, 50, 1, "MYTOKEN");

// Check burned amounts
const { data } = await getBurnedTokens();
console.log("Total XRGE burned:", data.total_xrge_burned);
```

---

## Frontend Integration (Secure v2)

### TypeScript Example with Client-Side Signing

```typescript
import { 
  secureTransfer, 
  secureSwap, 
  secureCreatePool,
  secureBurn,
  BURN_ADDRESS 
} from "@/lib/secure-api";

// Transfer tokens (private key never leaves browser)
const result = await secureTransfer(
  wallet.publicKey,
  wallet.privateKey,  // Used only for local signing
  recipientPublicKey,
  100,  // amount
  1,    // fee
  "XRGE"
);

// Swap tokens
await secureSwap(
  wallet.publicKey,
  wallet.privateKey,
  "XRGE",    // token in
  "QSHIB",   // token out
  100,       // amount in
  490        // min amount out
);

// Create a liquidity pool
await secureCreatePool(
  wallet.publicKey,
  wallet.privateKey,
  "XRGE",
  "MYTOKEN",
  1000,  // initial XRGE
  5000   // initial MYTOKEN
);

// Burn tokens permanently
await secureBurn(wallet.publicKey, wallet.privateKey, 100, 1, "XRGE");
```
