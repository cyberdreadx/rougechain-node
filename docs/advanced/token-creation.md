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
   - **Logo** — Upload an image or paste a URL (optional)
4. Confirm and sign the transaction

Uploaded logos are compressed to WebP (max 256×256, ≤100 KB) and stored on-chain as base64 data URIs. They display across the wallet, swap, pools, and explorer.

### Via SDK

```typescript
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.generate();

await rc.createToken(wallet, {
  name: "My Token",
  symbol: "MTK",
  totalSupply: 1_000_000,
  image: "https://example.com/logo.png", // or a data:image/webp;base64,... URI
});
```

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
      "decimals": 8,
      "image": "https://example.com/logo.png"
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

## Token Metadata

Every token has on-chain metadata that the creator can manage:

| Field | Description |
|-------|-------------|
| `image` | Logo URL or base64 data URI |
| `description` | Token description |
| `website` | Project website |
| `twitter` | X/Twitter handle |
| `discord` | Discord invite link |

### Updating Metadata

Only the original creator can update metadata:

```typescript
await rc.updateTokenMetadata(wallet, {
  symbol: "MTK",
  image: "data:image/webp;base64,UklGR...",
  description: "A community token for...",
  website: "https://mytoken.io",
  twitter: "@mytoken",
  discord: "discord.gg/mytoken",
});
```

Logo images can be:
- **URLs** — `https://...`, `ipfs://...`
- **Data URIs** — `data:image/webp;base64,...` (stored directly on-chain, persists forever)

The web UI provides an **Upload** button that compresses images to WebP and stores them as base64 on-chain.

## Token Standards

RougeChain tokens are native protocol-level assets (not smart contract tokens). This means:

- No ERC-20 compatibility (different chain architecture)
- Transfers are first-class transactions
- All token operations are signed with ML-DSA-65
- Quantum-resistant by default
