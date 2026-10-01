# Staking & Validators

RougeChain uses Proof of Stake (PoS) for consensus. Validators stake XRGE tokens to participate in block production and earn rewards.

## How It Works

1. **Stake tokens** - Lock XRGE to become a validator
2. **Propose and vote** - The designated proposer (the validator with the most stake) proposes blocks; staked validators vote to finalize them
3. **Earn rewards** - Every staked validator earns a stake-weighted share of the fees in every block
4. **Unstake** - Wait for unbonding period to withdraw

## Requirements

| Requirement | Value |
|-------------|-------|
| Minimum stake | 10,000 XRGE (enforced on every stake call) |
| Unbonding period | 500 blocks |
| Slashing | 10% per violation; jailed for 20 blocks. Automatic missed-block slashing is frozen since height 100 |

## Become a Validator

### Via Web UI

1. Go to the **Validators** page
2. Click **Stake**
3. Enter amount (min 10,000 XRGE)
4. Confirm transaction

### Via SDK (Recommended)

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');
const wallet = Wallet.fromKeys(publicKey, privateKey);

await rc.stake(wallet, { amount: 10000 });
```

### Via API (v2 Signed Request)

All write operations require ML-DSA-65 client-side signing. See [Staking API](../api-reference/staking.md) for the full request format.

```bash
# The payload must be signed client-side with your ML-DSA-65 private key.
# Use the SDK or build the signed request manually:
curl -X POST https://testnet.rougechain.io/api/v2/stake \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "amount": 10000,
      "from": "your-public-key-hex",
      "timestamp": 1706745600000,
      "nonce": "random-hex"
    },
    "signature": "ml-dsa65-signature-hex",
    "public_key": "your-public-key-hex"
  }'
```

## Check Your Stake

```bash
curl "https://testnet.rougechain.io/api/validators?publicKey=your-public-key"
```

Response:
```json
{
  "validators": [
    {
      "publicKey": "your-public-key",
      "stake": 10000.0,
      "status": "active",
      "blocksProposed": 42
    }
  ]
}
```

## Unstake

### Via SDK

```typescript
await rc.unstake(wallet, { amount: 5000 });
```

### Via API (v2 Signed Request)

```bash
curl -X POST https://testnet.rougechain.io/api/v2/unstake \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "amount": 5000,
      "from": "your-public-key-hex",
      "timestamp": 1706745600000,
      "nonce": "random-hex"
    },
    "signature": "ml-dsa65-signature-hex",
    "public_key": "your-public-key-hex"
  }'
```

## Validator Selection

Since mainnet height 100, each block has exactly one **designated proposer**: the eligible validator (stake > 0, not jailed) with the **most stake**, ties going to the lowest raw public-key bytes. Selection is deterministic — no randomness and no rotation — and there is no fallback proposer yet. Blocks from any other validator are rejected. See [Becoming a Validator → Proposer selection](becoming-validator.md#proposer-selection).

> `GET /api/selection` reports this designated proposer for the next height (`rule: "designated_max_stake"`).

## Rewards

Validators earn from an **EIP-1559-inspired fee model**:

| Component | Distribution |
|-----------|-------------|
| Base fee | Half of the base fee per transaction is burned (capped at the fees collected); everything else flows into the block's tip pool |
| Tip pool | Proposer 20% · validators 70% (stake-weighted) · treasury 10% |
| Minimum tip | 0.1 XRGE per block (subsidized from staking reserves if needed) |

Fees are credited when a block is applied to state. See [Validator Economics](becoming-validator.md) for detailed reward calculations.

## PQC Security

All validator operations use **ML-DSA-65** signatures:

- Block proposals are signed
- Stake/unstake transactions are signed
- Signatures are verified by all nodes

Block production and staking are therefore signed with quantum-resistant keys.

> **Finality:** verified BFT finality (FINALITY_V2 — verified ML-DSA-65 votes, recomputed quorum,
> anti-equivocation journals) is **active on mainnet since height 150**. Every block from 151 carries a
> ⅔-stake commit certificate for its parent. See [Finality](finality.md).
