# NFTs

RougeChain supports on-chain NFTs with collections, minting, transfers, and marketplace features — all secured by post-quantum cryptography.

## Features

- **Collections** — Create NFT collections with configurable max supply, royalties, and metadata
- **Minting** — Mint single or batch NFTs with metadata URIs and custom attributes
- **Transfers** — Send NFTs to any RougeChain address with optional sale price tracking
- **Burning** — Permanently destroy NFTs
- **Locking** — Lock individual NFTs to prevent transfers
- **Freezing** — Freeze entire collections to prevent further minting

## Fee Structure

| Operation | Fee (XRGE) |
|-----------|-----------|
| Create Collection | 50 |
| Mint NFT | 5 |
| Batch Mint | 5 per NFT |
| Transfer | 1 |
| Burn | 0.1 |
| Lock/Unlock | 0.1 |
| Freeze Collection | 0.1 |

## Security

All NFT operations use the v2 signed transaction API — transactions are signed client-side with ML-DSA-65 and verified on-chain. Only collection creators can mint, and only token owners can transfer or burn.
