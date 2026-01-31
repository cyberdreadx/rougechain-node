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
| `/api/burn-address` | GET | Get official burn address |
| `/api/burned` | GET | Get burned token stats |

### AMM/DEX

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pools` | GET | List liquidity pools |
| `/api/pool/:pool_id` | GET | Get pool details |
| `/api/pool/:pool_id/prices` | GET | Get price history |
| `/api/pool/:pool_id/events` | GET | Get pool events |
| `/api/pool/:pool_id/stats` | GET | Get pool statistics |
| `/api/pool/create` | POST | Create liquidity pool |
| `/api/pool/add-liquidity` | POST | Add liquidity |
| `/api/pool/remove-liquidity` | POST | Remove liquidity |
| `/api/swap/quote` | POST | Get swap quote |
| `/api/swap/execute` | POST | Execute swap |

### Secure v2 API (Client-Side Signing)

All v2 endpoints accept pre-signed transactions. Private keys never leave the client.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/transfer` | POST | Transfer tokens |
| `/api/v2/token/create` | POST | Create token |
| `/api/v2/pool/create` | POST | Create pool |
| `/api/v2/pool/add-liquidity` | POST | Add liquidity |
| `/api/v2/pool/remove-liquidity` | POST | Remove liquidity |
| `/api/v2/swap/execute` | POST | Execute swap |
| `/api/v2/stake` | POST | Stake tokens |
| `/api/v2/unstake` | POST | Unstake tokens |
| `/api/v2/faucet` | POST | Request faucet |

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
