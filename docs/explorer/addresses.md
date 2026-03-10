# Block Explorer — Addresses

## Address Detail Page

URL: `/address/:pubkey`

Shows comprehensive information for any RougeChain address:

### Balances

- XRGE balance
- All token balances (qETH, qUSDC, custom tokens)
- Staked amount (if any)

### Transaction History

Paginated list of all transactions where this address is the sender or recipient, including:
- Transfers
- Swaps
- Staking operations
- Bridge operations
- NFT operations

### NFTs Owned

List of all NFTs currently owned by this address, grouped by collection.

## API

```
GET /api/balance/:public_key                    — XRGE balance
GET /api/balance/:public_key/:token_symbol      — Token balance
GET /api/address/:public_key/transactions       — Transaction history (paginated)
GET /api/nft/owner/:pubkey                      — NFTs owned
```
