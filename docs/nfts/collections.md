# NFT Collections

## Creating a Collection

1. Go to the **NFT Explorer** page
2. Click **Create Collection**
3. Fill in:
   - **Symbol** — Short identifier (e.g., "ROGUE")
   - **Name** — Full collection name
   - **Max Supply** — Maximum number of NFTs (optional, 0 = unlimited)
   - **Royalty** — Royalty percentage in basis points (e.g., 500 = 5%)
   - **Image** — Collection cover image URL
   - **Description** — Collection description
4. Click **Create**

The collection ID is generated from `creator_pubkey:SYMBOL`.

## Collection Properties

| Property | Description |
|----------|-------------|
| `id` | Unique identifier (creator:symbol) |
| `symbol` | Short token symbol |
| `name` | Full collection name |
| `creator` | Creator's public key |
| `max_supply` | Max tokens (0 = unlimited) |
| `royalty_bps` | Royalty in basis points |
| `frozen` | Whether minting is frozen |
| `total_minted` | Number of tokens minted |

## Freezing a Collection

Collection creators can freeze their collections to permanently prevent further minting. This is irreversible and signals to holders that the supply is final.

## Browsing Collections

The NFT Explorer page shows all collections with their stats, floor price, and total items. Click any collection to view its individual tokens.
