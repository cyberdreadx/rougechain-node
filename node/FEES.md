# Fee Mechanism in RougeChain L1

## Overview

Transaction fees in RougeChain L1 are collected from users and distributed to **block proposers (miners)** as an incentive for block production and network security.

## Fee Structure

### Current Fee Rates (Devnet)

- **Transfer**: `0.1 XRGE` per transfer transaction
- **Token Creation**: `100 XRGE` to create a new token
- **Mint**: `1 XRGE` per mint operation

## Where Fees Go

### Block Proposer (Miner)

**All fees from transactions in a block go to the block proposer** (the node that successfully mines/proposes the block).

- When a node mines a block, it collects **all fees from all transactions** included in that block
- The proposer's public key is stored in `block.header.proposerPubKey`
- Fees are automatically calculated and tracked per block

### Example

If a block contains:
- 5 transfer transactions (5 × 0.1 = 0.5 XRGE)
- 1 token creation (100 XRGE)

**Total fees**: 100.5 XRGE → goes to the block proposer

## Fee Collection Flow

1. **Transaction Creation**: User creates a transaction and includes a fee
2. **Mempool**: Transaction enters the mempool with its fee
3. **Block Mining**: Miner selects transactions (including their fees) and creates a block
4. **Fee Collection**: All fees from transactions in the block are credited to the proposer
5. **Block Validation**: Other nodes validate the block and accept it
6. **Fee Distribution**: Fees are effectively "collected" by the proposer (tracked in block data)

## Current Implementation Status

### ✅ Implemented
- Fee constants defined
- Fees included in transactions
- Fee tracking per block
- Fee statistics API endpoint (`/api/stats` shows `totalFeesCollected` and `feesInLastBlock`)
- Console logging shows fees collected per block

### 🔄 Future Enhancements
- **State System**: When a full state/balance system is implemented, fees will be automatically credited to the proposer's account balance
- **Fee Splitting**: Could be extended to split fees between proposer and validators (e.g., 50% proposer, 50% validators)
- **Dynamic Fees**: Could implement dynamic fee markets based on network congestion
- **Fee Burning**: Option to burn a portion of fees to reduce supply

## Fee Economics

### Incentives
- **Miners**: Earn fees by producing blocks
- **Network Security**: Fees incentivize honest block production
- **Spam Prevention**: Fees prevent spam transactions

### Fee Recipient
Currently, fees go **100% to the block proposer**. This is a simple model suitable for devnet. In production, you might want to:
- Split fees between proposer and validators
- Burn a percentage of fees
- Distribute fees to a treasury/DAO

## API

Query fee statistics via the node's HTTP API:

```bash
curl http://127.0.0.1:5100/api/stats
```

Response includes:
```json
{
  "totalFeesCollected": 150.5,
  "feesInLastBlock": 0.3,
  ...
}
```

## Notes

- Fees are denominated in **XRGE** (native token)
- Fees are deducted from the sender's balance (when state system is implemented)
- Fees are paid even if a transaction fails (to prevent spam)
- Minimum fee is enforced to prevent dust transactions
