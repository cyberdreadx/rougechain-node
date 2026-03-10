# Block Explorer — Blocks

## Block List

The **Blockchain** page shows all blocks in reverse chronological order with:

- Block height (index)
- Block hash (truncated)
- Timestamp
- Number of transactions
- Proposer address

Click any block to view its full details.

## Block Detail Page

URL: `/block/:height`

Shows:

| Field | Description |
|-------|-------------|
| Height | Block number in the chain |
| Hash | SHA-256 hash of the block |
| Previous Hash | Hash of the parent block |
| Timestamp | When the block was created |
| Proposer | Public key of the block proposer |
| Transaction Count | Number of transactions in the block |

Below the header, all transactions in the block are listed with their type, sender, recipient, amount, and fee.

## API

```
GET /api/blocks              — List all blocks (paginated)
GET /api/block/:height       — Get a specific block by height
GET /api/blocks/summary      — Block summary for charts
```
