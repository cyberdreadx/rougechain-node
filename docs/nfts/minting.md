# Minting & Trading NFTs

## Minting

### Single Mint

1. Open a collection page
2. Click **Mint NFT**
3. Enter the token name and optional metadata URI / attributes
4. Click **Mint**

Only the collection creator can mint new tokens.

### Batch Mint

Mint multiple NFTs at once:

1. Open a collection page
2. Click **Batch Mint**
3. Provide a list of names (and optional URIs/attributes for each)
4. Click **Mint All**

Fee is 5 XRGE per NFT in the batch.

## Token Properties

Each NFT has:

| Property | Description |
|----------|-------------|
| `token_id` | Sequential ID within the collection |
| `name` | Token name |
| `owner` | Current owner's address (`rouge1...`) |
| `creator` | Original minter |
| `metadata_uri` | Link to off-chain metadata (IPFS, HTTP) |
| `attributes` | On-chain key-value attributes |
| `locked` | Whether the token is locked (non-transferable) |
| `created_at` | Timestamp of minting |

## Transferring

1. Open the NFT detail page
2. Click **Transfer**
3. Enter the recipient's RougeChain address (`rouge1...`)
4. Optionally set a sale price (for marketplace tracking)
5. Confirm

Locked NFTs cannot be transferred until unlocked by the owner.

## Burning

Permanently destroy an NFT:

1. Open the NFT detail page
2. Click **Burn**
3. Confirm

Only the current owner can burn. This action is irreversible.

## Locking

Lock an NFT to prevent it from being transferred:

1. Open the NFT detail page
2. Toggle **Lock**

Only the owner can lock/unlock their NFTs.
