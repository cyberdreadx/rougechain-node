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
| Minimum stake | 1,000 XRGE |
| Unbonding period | ~7 days |
| Slashing | Not implemented (testnet) |

## Become a Validator

### Via Web UI

1. Go to the **Validators** page
2. Click **Stake**
3. Enter amount (min 1,000 XRGE)
4. Confirm transaction

### Via API

```bash
curl -X POST https://testnet.rougechain.io/api/stake/submit \
  -H "Content-Type: application/json" \
  -d '{
    "fromPrivateKey": "your-private-key",
    "fromPublicKey": "your-public-key",
    "amount": 1000
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
      "stake": 1000.0,
      "status": "active",
      "blocksProposed": 42
    }
  ]
}
```

## Unstake

### Via API

```bash
curl -X POST https://testnet.rougechain.io/api/unstake/submit \
  -H "Content-Type: application/json" \
  -d '{
    "fromPrivateKey": "your-private-key",
    "fromPublicKey": "your-public-key",
    "amount": 500
  }'
```

## Validator Selection

Block proposers are selected using:

1. **Stake weight** - Higher stake = higher probability
2. **Quantum entropy** - Unpredictable randomness
3. **Round-robin fallback** - Ensures all validators participate

## Rewards

Validators earn:

- **Transaction fees** from blocks they produce
- **Base block reward** (if configured)

Fees are credited immediately when a block is finalized.

## PQC Security

All validator operations use **ML-DSA-65** signatures:

- Block proposals are signed
- Stake/unstake transactions are signed
- Signatures are verified by all nodes

This ensures quantum-resistant security for the entire consensus process.
