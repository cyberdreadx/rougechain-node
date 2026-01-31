# API Reference

The RougeChain node exposes a REST API on the configured `--api-port` (default: 5100).

## Base URL

```
http://127.0.0.1:5100/api
```

For the public testnet:
```
https://testnet.rougechain.io/api
```

## Endpoints Overview

### System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Node health check |
| `/api/stats` | GET | Network statistics |

### Blockchain

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/blocks` | GET | Get all blocks |
| `/api/blocks/summary` | GET | Block summary for charts |
| `/api/txs` | GET | Get transactions |

### Wallet

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wallet/create` | POST | Create new wallet |
| `/api/balance/:publicKey` | GET | Get balance |
| `/api/faucet` | POST | Request testnet tokens |
| `/api/tx/submit` | POST | Submit transaction |

### Staking

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/validators` | GET | List validators |
| `/api/stake/submit` | POST | Stake tokens |
| `/api/unstake/submit` | POST | Unstake tokens |

### Tokens

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/token/create` | POST | Create custom token |

### P2P

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/peers` | GET | List known peers |
| `/api/peers/register` | POST | Register as peer |
| `/api/blocks/import` | POST | Import block from peer |
| `/api/tx/broadcast` | POST | Receive broadcasted tx |

### Messenger

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/messenger/wallets` | GET | List messenger wallets |
| `/api/messenger/wallets/register` | POST | Register wallet |
| `/api/messenger/conversations` | GET/POST | Conversations |
| `/api/messenger/messages` | GET/POST | Messages |

## Authentication

Some endpoints require an API key (if configured on the node):

```bash
curl -H "X-API-Key: your-api-key" https://testnet.rougechain.io/api/stats
```

## Rate Limiting

Default limits:
- Read endpoints: 120 requests/minute
- Write endpoints: 30 requests/minute

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 115
```
