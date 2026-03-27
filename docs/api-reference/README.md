# API Reference

The RougeChain node exposes a REST API on the configured `--api-port` (default: 5101).

> **Important:** All write operations (POST/PUT/DELETE) require **v2 signed requests** using ML-DSA-65 client-side signing. Legacy unsigned v1 write endpoints return `410 GONE` in production. Private keys never leave your application.

## Base URL

```
http://127.0.0.1:5100/api
```

For the public testnet:
```
https://testnet.rougechain.io/api
```

## Address Format

RougeChain uses **Bech32m** addresses with the `rouge1` prefix (e.g., `rouge1q8f3x7k2m4n9p...`). These are derived from the SHA-256 hash of the raw ML-DSA-65 public key.

All API endpoints expect **raw hex public keys**, not `rouge1` addresses:

```
✅ /api/balance/d67d8da279755a...
❌ /api/balance/rouge1q8f3x7k2m4n9p...
```

> **Tip:** Use `GET /api/resolve/:input` to convert between `rouge1…` addresses and hex public keys.

## v2 Signed Request Format

All write endpoints use a standard signed-request envelope:

```json
{
  "payload": {
    "...endpoint-specific fields...",
    "from": "your-signing-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "ml-dsa65-signature-of-payload-hex",
  "public_key": "your-signing-public-key-hex"
}
```

The `payload` is JSON-serialized with keys sorted alphabetically, then signed with your ML-DSA-65 private key. The server verifies the signature, checks the timestamp (must be within 60 seconds), and rejects replayed nonces.

## Endpoints Overview

### System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Node health check |
| `/api/stats` | GET | Network statistics |
| `/api/ws` | GET | WebSocket for real-time events |
| `/api/price/xrge` | GET | Current XRGE price |

### Blockchain

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/blocks` | GET | Get all blocks |
| `/api/blocks/summary` | GET | Block summary for charts |
| `/api/block/:height` | GET | Get block by height |
| `/api/txs` | GET | Get transactions |
| `/api/tx/:hash` | GET | Get transaction by hash |
| `/api/tx/:hash/receipt` | GET | Get transaction receipt |
| `/api/events` | GET | Get all events |

### Wallet & Accounts

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/balance/:publicKey` | GET | Get XRGE balance |
| `/api/balance/:publicKey/:token` | GET | Get token balance |
| `/api/account/:pubkey/nonce` | GET | Get account nonce |
| `/api/resolve/:input` | GET | Resolve address ↔ public key |
| `/api/address/:pubkey/transactions` | GET | Get address transactions |
| `/api/v2/transfer` | POST | Transfer tokens (signed) |
| `/api/v2/faucet` | POST | Request testnet tokens (signed) |

### Tokens

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tokens` | GET | List all tokens |
| `/api/token/:symbol/metadata` | GET | Get token metadata |
| `/api/token/:symbol/holders` | GET | Get token holders |
| `/api/token/:symbol/transactions` | GET | Get token transactions |
| `/api/burn-address` | GET | Get official burn address |
| `/api/burned` | GET | Get burned token stats |
| `/api/v2/token/create` | POST | Create token (signed) |
| `/api/v2/token/metadata/update` | POST | Update token metadata (signed) |
| `/api/v2/token/metadata/claim` | POST | Claim metadata ownership (signed) |

### Token Allowances (ERC-20 Style)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/token/approve` | POST | Approve spender allowance (signed) |
| `/api/v2/token/transfer-from` | POST | Transfer using allowance (signed) |
| `/api/v2/token/freeze` | POST | Freeze/unfreeze token transfers (signed) |
| `/api/token/allowance` | GET | Check specific allowance |
| `/api/token/allowances` | GET | List allowances by owner/spender |
| `/api/allowances/:pubkey` | GET | List all allowances for a key |
| `/api/locks/:pubkey` | GET | Get token locks |

### Staking & Validators

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/validators` | GET | List validators |
| `/api/validators/stats` | GET | Validator vote stats |
| `/api/selection` | GET | Proposer selection |
| `/api/finality` | GET | Finality status |
| `/api/votes` | GET | Vote quorum info |
| `/api/v2/stake` | POST | Stake tokens (signed) |
| `/api/v2/unstake` | POST | Unstake tokens (signed) |

### Token Staking Pools

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/staking/pools` | GET | List all staking pools |
| `/api/staking/pool/:pool_id` | GET | Get staking pool details |
| `/api/staking/stakes/:pubkey` | GET | Get stakes by owner |
| `/api/staking/pool/:pool_id/stakes` | GET | Get stakes in a pool |

### AMM/DEX

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pools` | GET | List liquidity pools |
| `/api/pool/:pool_id` | GET | Get pool details |
| `/api/pool/:pool_id/prices` | GET | Get price history |
| `/api/pool/:pool_id/events` | GET | Get pool events |
| `/api/pool/:pool_id/stats` | GET | Get pool statistics |
| `/api/swap/quote` | POST | Get swap quote |
| `/api/v2/pool/create` | POST | Create liquidity pool (signed) |
| `/api/v2/pool/add-liquidity` | POST | Add liquidity (signed) |
| `/api/v2/pool/remove-liquidity` | POST | Remove liquidity (signed) |
| `/api/v2/swap/execute` | POST | Execute swap (signed) |

### NFTs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/nft/collections` | GET | List collections |
| `/api/nft/collection/:id` | GET | Get collection |
| `/api/nft/collection/:id/tokens` | GET | Get collection tokens |
| `/api/nft/token/:coll/:id` | GET | Get specific NFT |
| `/api/nft/owner/:pubkey` | GET | Get NFTs by owner |
| `/api/v2/nft/collection/create` | POST | Create collection (signed) |
| `/api/v2/nft/mint` | POST | Mint NFT (signed) |
| `/api/v2/nft/batch-mint` | POST | Batch mint (signed) |
| `/api/v2/nft/transfer` | POST | Transfer NFT (signed) |
| `/api/v2/nft/burn` | POST | Burn NFT (signed) |
| `/api/v2/nft/lock` | POST | Lock/unlock NFT (signed) |
| `/api/v2/nft/freeze-collection` | POST | Freeze collection (signed) |

### Smart Contracts

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/contract/deploy` | POST | Deploy WASM contract (signed) |
| `/api/v2/contract/call` | POST | Call contract method (signed) |
| `/api/contract/:address` | GET | Get contract metadata |
| `/api/contract/:address/state` | GET | Get contract state |
| `/api/contract/:address/events` | GET | Get contract events |

### Bridge (ETH/USDC + XRGE)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bridge/config` | GET | ETH/USDC bridge config |
| `/api/bridge/claim` | POST | Claim bridge deposit |
| `/api/bridge/withdraw` | POST | Withdraw to EVM |
| `/api/bridge/withdrawals` | GET | List pending withdrawals |
| `/api/bridge/withdrawals/:txId` | DELETE | Fulfill withdrawal |
| `/api/bridge/xrge/config` | GET | XRGE bridge config |
| `/api/bridge/xrge/claim` | POST | Claim XRGE deposit |
| `/api/bridge/xrge/withdraw` | POST | Withdraw XRGE to EVM |
| `/api/bridge/xrge/withdrawals` | GET | List XRGE withdrawals |
| `/api/bridge/xrge/withdrawals/:txId` | DELETE | Fulfill XRGE withdrawal |

### Shielded Transactions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/shielded/shield` | POST | Shield tokens (signed) |
| `/api/v2/shielded/transfer` | POST | Private transfer (signed) |
| `/api/v2/shielded/unshield` | POST | Unshield tokens (signed) |
| `/api/shielded/stats` | GET | Shielded pool statistics |
| `/api/shielded/nullifier/:hash` | GET | Check nullifier |

### Rollup (Phase 3)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/rollup/status` | GET | Rollup status |
| `/api/v2/rollup/batch/:id` | GET | Get rollup batch |
| `/api/v2/rollup/submit` | POST | Submit rollup transfer (signed) |

### Governance

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/governance/proposals` | GET | List all proposals |
| `/api/governance/proposals/:token` | GET | Proposals by token |
| `/api/governance/proposal/:id` | GET | Get proposal details |
| `/api/governance/proposal/:id/votes` | GET | Get proposal votes |

### Messenger

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/messenger/wallets` | GET | List messenger wallets |
| `/api/v2/messenger/wallets/register` | POST | Register wallet (signed) |
| `/api/v2/messenger/conversations` | POST | Create conversation (signed) |
| `/api/v2/messenger/conversations/list` | POST | List conversations (signed) |
| `/api/v2/messenger/conversations/delete` | POST | Delete conversation (signed) |
| `/api/v2/messenger/messages` | POST | Send message (signed) |
| `/api/v2/messenger/messages/list` | POST | List messages (signed) |
| `/api/v2/messenger/messages/read` | POST | Mark as read (signed) |
| `/api/v2/messenger/messages/delete` | POST | Delete message (signed) |

### Mail

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/names/register` | POST | Register mail name (signed) |
| `/api/v2/names/release` | POST | Release a name (signed) |
| `/api/names/resolve/:name` | GET | Resolve name → wallet |
| `/api/names/reverse/:walletId` | GET | Reverse lookup → name |
| `/api/v2/mail/send` | POST | Send encrypted mail (signed) |
| `/api/v2/mail/folder` | POST | Get inbox/sent/trash (signed) |
| `/api/v2/mail/message` | POST | Get single mail item (signed) |
| `/api/v2/mail/read` | POST | Mark as read (signed) |
| `/api/v2/mail/move` | POST | Move to folder (signed) |
| `/api/v2/mail/delete` | POST | Delete permanently (signed) |

### Push Notifications

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/push/register` | POST | Register push token (PQC-signed) |
| `/api/push/unregister` | POST | Unregister push token (PQC-signed) |

### P2P

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/peers` | GET | List known peers |
| `/api/peers/register` | POST | Register as peer |
| `/api/blocks/import` | POST | Import block from peer |
| `/api/tx/broadcast` | POST | Receive broadcasted tx |

## Authentication

Some endpoints require an API key (if configured on the node):

```bash
curl -H "X-API-Key: your-api-key" https://testnet.rougechain.io/api/stats
```

## Rate Limiting

Rate limiting is disabled by default (`--rate-limit-per-minute 0`). When enabled, the node supports tiered limits:
- **Tier 1 (Validators):** Proven via `X-Validator-Key` header + signature
- **Tier 2 (Registered peers):** Recognized by IP
- **Tier 3 (Public):** Separate limits for read and write endpoints
