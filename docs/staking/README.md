# Staking & Validators

RougeChain uses Proof of Stake (PoS) for consensus. Validators stake XRGE tokens to participate in block production and earn rewards.

## How It Works

1. **Stake tokens** - Lock XRGE to become a validator
2. **Propose blocks** - Selected validators propose new blocks
3. **Earn rewards** - Collect transaction fees from blocks you produce
4. **Unstake** - Wait for unbonding period to withdraw

## Requirements

| Requirement | Value |
|-------------|-------|
| Minimum stake | 10,000 XRGE |
| Unbonding period | ~7 days |
| Slashing | Not implemented (testnet) |

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

Block proposers are selected using:

1. **Stake weight** - Higher stake = higher probability
2. **Quantum entropy** - Unpredictable randomness
3. **Round-robin fallback** - Ensures all validators participate

## Rewards

Validators earn from an **EIP-1559-inspired fee model**:

| Component | Distribution |
|-----------|-------------|
| Base fee | 50% burned, 50% to block proposer |
| Priority fee (tip) | 100% to block proposer |
| Minimum tip | 0.1 XRGE per block |

Fees are credited immediately when a block is finalized. See [Validator Economics](becoming-validator.md) for detailed reward calculations.

## PQC Security

All validator operations use **ML-DSA-65** signatures:

- Block proposals are signed
- Stake/unstake transactions are signed
- Signatures are verified by all nodes

This ensures quantum-resistant security for the entire consensus process.
