# NFT Collections

## Creating a Collection

1. Go to the **NFT Explorer** page
2. Click **Create Collection**
3. Fill in:
   - **Symbol** — Short identifier (e.g., "ROGUE")
   - **Name** — Full collection name
   - **Max Supply** — Maximum number of NFTs (optional, 0 = unlimited)
   - **Royalty** — Royalty percentage in basis points (e.g., 500 = 5%)
   - **Royalty recipient** — *(optional)* wallet that receives royalties. Defaults to the creator when omitted.
   - **Image** — Collection cover image URL
   - **Description** — Collection description
4. Click **Create**

The collection ID is generated from `creator_pubkey:SYMBOL`.

## Royalties

Set a `royaltyBps` (basis points — `500` = 5%, `1000` = 10%) when creating a collection to earn on secondary sales. From the CONTRACT_NFT_ROYALTY upgrade, `royaltyBps` must be an integer from `0` to `10000` (100%); a higher value is rejected at creation.

- **When it's paid:** on an `nft_transfer` that declares a `salePrice > 0`. The royalty is `salePrice × royaltyBps / 10000`, in XRGE.
- **Who pays:** the **sender** (the current owner initiating the transfer). It is deducted from their XRGE balance *on top of* the 1 XRGE transfer fee.
- **Who receives:** the collection's `royaltyRecipient`. If you didn't set one, this is the **creator**. If you set one at creation, it is that address — a wallet or a contract. The recipient is fixed at creation and cannot be changed afterward.

### Routing royalties to another wallet or a contract

Pass `royaltyRecipient` at creation to send royalties somewhere other than the creator:

- **A wallet** — for example a shared payout wallet or a treasury. Anything the wallet's owner does with the royalty afterwards (such as splitting it) happens off-chain.
- **A contract** — for trustless on-chain splits. Since mainnet block 18 contracts hold XRGE and pay it out with their own code, so a royalty-splitter contract (see [`contracts/royalty_splitter`](https://github.com/cyberdreadx/rougechain-node/tree/main/contracts/royalty_splitter) and [Contract XRGE custody](../advanced/contract-xrge-custody.md)) can receive royalties and fan them out to collaborators by fixed shares. Deploy the contract first and use its address.

> ⚠️ **The node does not check the recipient address.** Royalties sent to a mistyped address, or to a contract that has no way to pay XRGE out, cannot be recovered — only a contract's own code can move its XRGE. Double-check the address, and only use contracts whose payout function you have tested.

> **Note on enforcement:** `salePrice` is self-declared in the transfer payload — there is no on-chain marketplace escrow. A transfer sent with no `salePrice` (or `0`) pays no royalty. Royalties are honored by marketplaces/apps that populate `salePrice`, not enforced against every possible transfer.

## Collection Properties

| Property | Description |
|----------|-------------|
| `id` | Unique identifier (creator:symbol) |
| `symbol` | Short token symbol |
| `name` | Full collection name |
| `creator` | Creator's public key |
| `max_supply` | Max tokens (0 = unlimited) |
| `royalty_bps` | Royalty in basis points |
| `royalty_recipient` | Wallet that receives royalties (defaults to `creator`) |
| `frozen` | Whether minting is frozen |
| `total_minted` | Number of tokens minted |

## Freezing a Collection

Collection creators can freeze their collections to permanently prevent further minting. This is irreversible and signals to holders that the supply is final.

## Browsing Collections

The NFT Explorer page shows all collections with their stats, floor price, and total items. Click any collection to view its individual tokens.
