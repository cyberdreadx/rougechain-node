# Token Creation

Create custom tokens on RougeChain. Tokens can be traded on the built-in AMM/DEX.

## Overview

| Property | Value |
|----------|-------|
| Creation fee | 100 XRGE |
| Max supply | Set at creation (immutable) |
| Decimals | Configurable |
| Trading | Via AMM liquidity pools |

## Create a Token

### Via Web UI

1. Navigate to the **Token Explorer** page
2. Click **Create Token**
3. Fill in token details:
   - **Name** — Full name (e.g., "My Token")
   - **Symbol** — Ticker symbol (e.g., "MTK")
   - **Total Supply** — Maximum supply
   - **Decimals** — Decimal places (typically 8)
4. Confirm and sign the transaction

### Via v2 API

```bash
curl -X POST https://testnet.rougechain.io/api/v2/token/create \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "your-public-key-hex",
    "payload": {
      "name": "My Token",
      "symbol": "MTK",
      "totalSupply": 1000000,
      "decimals": 8
    },
    "nonce": 1706745600000,
    "signature": "your-ml-dsa65-signature-hex"
  }'
```

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "token": {
    "symbol": "MTK",
    "name": "My Token",
    "totalSupply": 1000000,
    "decimals": 8,
    "creator": "your-public-key"
  }
}
```

## After Creation

Once created, the entire supply is credited to the creator's wallet. You can then:

1. **Transfer** tokens to other wallets
2. **Create a liquidity pool** to enable trading
3. **Burn** tokens by sending to the burn address

## Creating a Liquidity Pool

To make your token tradeable on the DEX:

```bash
curl -X POST https://testnet.rougechain.io/api/v2/pool/create \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "your-public-key-hex",
    "payload": {
      "tokenA": "XRGE",
      "tokenB": "MTK",
      "amountA": 1000,
      "amountB": 10000
    },
    "nonce": 1706745600001,
    "signature": "your-signature-hex"
  }'
```

This creates an XRGE/MTK pool with an initial price of 0.1 XRGE per MTK.

Pool creation costs 10 XRGE.

## Token Burning

Send tokens to the burn address to permanently remove them from circulation:

```
XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD
```

Burned amounts are tracked on-chain and queryable via `GET /api/burned`.

## Listing on the DEX

Tokens are automatically listed on the DEX once a liquidity pool is created. Users can then:

- Swap between your token and XRGE
- Add/remove liquidity
- View price charts and pool stats

## Token Standards

RougeChain tokens are native protocol-level assets (not smart contract tokens). This means:

- No ERC-20 compatibility (different chain architecture)
- Transfers are first-class transactions
- All token operations are signed with ML-DSA-65
- Quantum-resistant by default
