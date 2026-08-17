# API Reference — NFTs

All write operations use the v2 signed transaction API (client-side signing).

## Read Endpoints

### List Collections

```
GET /api/nft/collections
```

### Get Collection

```
GET /api/nft/collection/:id
```

### Get Collection Tokens

```
GET /api/nft/collection/:id/tokens
```

### Get Token

```
GET /api/nft/token/:collection_id/:token_id
```

### Get NFTs by Owner

```
GET /api/nft/owner/:pubkey
```

## Write Endpoints (v2 Signed)

All write endpoints accept a signed transaction body:

```json
{
  "payload": { "type": "nft_mint", "..." },
  "signature": "...",
  "public_key": "..."
}
```

### Create Collection

```
POST /api/v2/nft/collection/create
```

**Payload fields:** `symbol`, `name`, `maxSupply`, `royaltyBps`, `royaltyRecipient`, `image`, `description`
**Fee:** 50 XRGE

- `royaltyBps` — royalty in basis points (`500` = 5%).
- `royaltyRecipient` — *(optional)* wallet that receives secondary-sale royalties. **Defaults to the creator** when omitted, and is fixed at creation. Must be a normal wallet address — ⚠️ **never a contract address** (funds sent to a contract are permanently lost).

### Mint NFT

```
POST /api/v2/nft/mint
```

**Payload fields:** `collectionId`, `name`, `metadataUri`, `attributes`
**Fee:** 5 XRGE

### Batch Mint

```
POST /api/v2/nft/batch-mint
```

**Payload fields:** `collectionId`, `names`, `uris`, `batchAttributes`
**Fee:** 5 XRGE per NFT

### Transfer NFT

```
POST /api/v2/nft/transfer
```

**Payload fields:** `collectionId`, `tokenId`, `to`, `salePrice`
**Fee:** 1 XRGE

When `salePrice > 0` and the collection has a royalty, the sender also pays `salePrice × royaltyBps / 10000` XRGE to the collection's `royaltyRecipient` (on top of the fee). `salePrice` is self-declared — a transfer with no `salePrice` pays no royalty.

### Burn NFT

```
POST /api/v2/nft/burn
```

**Payload fields:** `collectionId`, `tokenId`
**Fee:** 0.1 XRGE

### Lock/Unlock NFT

```
POST /api/v2/nft/lock
```

**Payload fields:** `collectionId`, `tokenId`, `locked`
**Fee:** 0.1 XRGE

### Freeze Collection

```
POST /api/v2/nft/freeze-collection
```

**Payload fields:** `collectionId`, `frozen`
**Fee:** 0.1 XRGE
