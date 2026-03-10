# Block Explorer — Transactions

## Transaction List

The **Transactions** page shows all transactions across the network with:

- Transaction hash
- Type (transfer, swap, stake, bridge, NFT, etc.)
- Sender and recipient
- Amount
- Block number
- Timestamp

## Transaction Detail Page

URL: `/tx/:hash`

Shows the full transaction details:

| Field | Description |
|-------|-------------|
| Hash | Transaction hash (SHA-256) |
| Type | Transaction type |
| From | Sender public key |
| To | Recipient public key |
| Amount | Transaction amount |
| Fee | Transaction fee (XRGE) |
| Token | Token symbol (if applicable) |
| Block | Block height containing this tx |
| Timestamp | When the transaction was processed |
| Signature | PQC signature (ML-DSA-65) |

## Transaction Types

| Type | Description |
|------|-------------|
| `transfer` | Token transfer between addresses |
| `create_token` | New token creation |
| `stake` | Staking tokens |
| `unstake` | Unstaking tokens |
| `create_pool` | Creating a liquidity pool |
| `add_liquidity` | Adding liquidity to a pool |
| `remove_liquidity` | Removing liquidity from a pool |
| `swap` | Token swap via AMM |
| `bridge_mint` | Minting bridged tokens (qETH, qUSDC) |
| `bridge_withdraw` | Burning bridged tokens for withdrawal |
| `nft_create_collection` | Creating an NFT collection |
| `nft_mint` | Minting an NFT |
| `nft_transfer` | Transferring an NFT |
| `nft_burn` | Burning an NFT |

## API

```
GET /api/txs                                    — List recent transactions
GET /api/tx/:hash                               — Get transaction by hash
GET /api/address/:public_key/transactions       — Get transactions for an address
```
