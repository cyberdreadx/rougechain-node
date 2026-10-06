# Token Creation

Create custom tokens on RougeChain. Tokens can be traded on the built-in AMM/DEX.

## Overview

| Property | Value |
|----------|-------|
| Creation fee | 100 XRGE |
| Supply | Set at creation — the full supply is minted to the creator. Fixed unless the token is created **mintable** (creator can mint more, optional cap; live since block 235) — see [Mintable tokens](#mintable-tokens-active-since-block-235) |
| Decimals | Not configurable — user-created tokens are whole units (0 decimals) |
| Trading | Via AMM liquidity pools |

## Create a Token

### Via Web UI

1. Navigate to the **Token Explorer** page
2. Click **Create Token**
3. Fill in token details:
   - **Name** — Full name (e.g., "My Token")
   - **Symbol** — Ticker symbol (e.g., "MTK")
   - **Total Supply** — Full supply, minted to you at creation
   - **Logo** — Upload an image or paste a URL (optional)
4. Confirm and sign the transaction

Uploaded logos are compressed to WebP (max 256×256) and stored on-chain as base64 data URIs. The node rejects an inline `data:` logo larger than **32 KiB** (and a logo URL longer than 2,048 bytes), so for a detailed image host it and paste a URL. Logos display across the wallet, swap, pools, and explorer.

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

The request body is the signed envelope `{ payload, signature, public_key }`. The `from`, `timestamp`, and `nonce` fields go **inside** `payload`, and `from` must equal the signing public key.

```bash
curl -X POST https://testnet.rougechain.io/api/v2/token/create \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "token_name": "My Token",
      "token_symbol": "MTK",
      "initial_supply": 1000000,
      "image": "https://example.com/logo.png",
      "from": "your-public-key-hex",
      "timestamp": 1706745600000,
      "nonce": "random-hex"
    },
    "signature": "your-ml-dsa65-signature-hex",
    "public_key": "your-public-key-hex"
  }'
```

Raw-HTTP field names are snake_case: `token_name` (1–64 chars), `token_symbol` (1–10 chars, no whitespace, must be unused), `initial_supply` (> 0), plus optional `image` and `description`. The 100 XRGE fee is set by the node regardless of any `fee` in the payload. There is no `decimals` field.

### Response

```json
{
  "success": true,
  "token_symbol": "MTK",
  "message": "Token creation transaction submitted"
}
```

The token exists once the transaction is included in a block.

## After Creation

Once created, the entire supply is credited to the creator's wallet. You can then:

1. **Transfer** tokens to other wallets
2. **Create a liquidity pool** to enable trading
3. **Burn** tokens by sending to the burn address

## Mintable tokens (active since block 235)

> **Status: LIVE on mainnet since block 235 and on testnet since block 1360** (`TOKEN_MINTING`).
> `GET /api/stats` → `upgrade_schedule.token_minting` shows the height. On a network where the height
> has not been reached the node refuses `mintable` / `max_supply` on `/api/v2/token/create` with
> `token minting is not active yet` and refuses every `/api/v2/token/mint`.

A token can be created **mintable**, with an optional cap. Add to the signed
create payload:

| Field | Type | Meaning |
|-------|------|---------|
| `mintable` | boolean | `true`: the creator may mint more later. Omit (or `false`) for a fixed-supply token. |
| `max_supply` | integer | Optional cap on **total issuance** (initial supply + everything ever minted). Requires `mintable: true`; must be ≥ `initial_supply`. Omit for no cap. |

Rules (enforced by every node when the transaction is included in a block):

- Only the token's **creator** (the key that signed the `create_token`) can mint.
- Only tokens created mintable **at or after the activation height** can be minted; tokens created
  earlier stay fixed-supply.
- `amount` and `max_supply` are JSON **integers** (a float or string is refused), at most
  9,007,199,254,740,991 (2^53 − 1). A mintable token's `initial_supply` has the same bound.
- `initial_supply + total_minted + amount` must stay ≤ `max_supply` when a cap is set. Burning does
  not free room: the cap bounds issuance, not circulating supply.
- A mint costs a 1 XRGE fee. A mint that breaks a rule when its block is built is skipped (no fee, no
  tokens); minting exactly up to the cap is allowed.
- `total_minted` is updated when the mint is included in a block, not when it is submitted.

```bash
# create (from activation)
curl -X POST https://testnet.rougechain.io/api/v2/token/create -H "Content-Type: application/json" -d '{
  "payload": { "token_name": "My Token", "token_symbol": "MTK", "initial_supply": 1000000,
               "mintable": true, "max_supply": 5000000,
               "from": "your-public-key-hex", "timestamp": 1706745600000, "nonce": "random-hex" },
  "signature": "...", "public_key": "your-public-key-hex" }'

# mint (creator only)
curl -X POST https://testnet.rougechain.io/api/v2/token/mint -H "Content-Type: application/json" -d '{
  "payload": { "token_symbol": "MTK", "amount": 250000,
               "from": "your-public-key-hex", "timestamp": 1706745600001, "nonce": "random-hex" },
  "signature": "...", "public_key": "your-public-key-hex" }'
```

`GET /api/token/:symbol/metadata` and `GET /api/tokens` report `mintable` (true only for a token a
block created mintable), `max_supply` (`null` = uncapped), `total_minted`, and for a mintable token
`initial_supply` and `mint_enabled_height`. `GET /api/token/:symbol/holders` counts minted supply in
`total_supply`.

### With the SDK (1.12.0+)

```typescript
if (await rc.isTokenMintingActive()) {          // reads /api/stats upgrade_schedule.token_minting
  await rc.createToken(wallet, { name: "My Token", symbol: "MTK", totalSupply: 1_000_000,
                                 mintable: true, maxSupply: 5_000_000 });  // maxSupply optional
  await rc.mintTokens(wallet, { symbol: "MTK", amount: 250_000 });      // signed mint_tokens, 1 XRGE
}
```

The SDK validates the numbers before signing (integers, `maxSupply` ≥ `totalSupply`, at most
2^53 − 1) and returns `{ success: false, error }` instead of posting an invalid request.

### On rougechain.io

The **Create a token** dialog shows a **Mintable** option (and an optional **Max supply**) only on
a network where the upgrade is active. On a mintable token's page in the Explorer, the token's
creator sees **Mint more** (amount, room left under the cap, 1 XRGE fee); it signs with the local
wallet or the connected extension / Qwalla. Everyone sees the initial, minted and max supply.

## Creating a Liquidity Pool

To make your token tradeable on the DEX:

```bash
curl -X POST https://testnet.rougechain.io/api/v2/pool/create \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "token_a": "XRGE",
      "token_b": "MTK",
      "amount_a": 1000,
      "amount_b": 10000,
      "from": "your-public-key-hex",
      "timestamp": 1706745600001,
      "nonce": "random-hex"
    },
    "signature": "your-signature-hex",
    "public_key": "your-public-key-hex"
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
