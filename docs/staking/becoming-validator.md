# Becoming a Validator

Validators produce blocks and earn transaction fees on RougeChain. This guide walks you through the full process.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| XRGE balance | At least 1,000 XRGE (+ fees) |
| Wallet | A RougeChain wallet with signing keys |
| Node (optional) | Running a node earns you more blocks |

## Step 1: Get XRGE

If you're on testnet, use the faucet:

1. Visit [rougechain.io](https://rougechain.io)
2. Go to **Wallet** and click **Request from Faucet**
3. Repeat until you have at least 1,000 XRGE

## Step 2: Stake Tokens

### Via Web UI

1. Navigate to the **Validators** page
2. Click **Stake**
3. Enter your stake amount (minimum 1,000 XRGE)
4. Confirm the transaction
5. Your wallet signs the stake transaction with ML-DSA-65

### Via v2 API (Client-Side Signing)

```bash
curl -X POST https://testnet.rougechain.io/api/v2/stake \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "your-public-key-hex",
    "amount": 1000,
    "nonce": 1706745600000,
    "signature": "your-ml-dsa65-signature-hex"
  }'
```

## Step 3: Verify Your Validator Status

```bash
curl "https://testnet.rougechain.io/api/validators"
```

Look for your public key in the response:

```json
{
  "validators": [
    {
      "publicKey": "your-public-key",
      "stake": 1000.0,
      "status": "active",
      "blocksProposed": 0
    }
  ]
}
```

## Step 4: Run a Mining Node (Recommended)

While staking alone makes you a validator, running a node ensures you're online to produce blocks when selected:

```bash
./quantum-vault-daemon \
  --mine \
  --api-port 5100 \
  --peers "https://testnet.rougechain.io/api" \
  --public-url "https://mynode.example.com"
```

## Increasing Your Stake

You can add more XRGE to increase your block proposal probability:

```bash
# Stake additional 500 XRGE
curl -X POST https://testnet.rougechain.io/api/v2/stake \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "your-public-key-hex",
    "amount": 500,
    "nonce": 1706745600001,
    "signature": "your-signature-hex"
  }'
```

Your total stake accumulates.

## Validator Selection Algorithm

Proposer selection uses three factors:

1. **Stake weight** — Higher stake gives proportionally higher probability
2. **Quantum entropy** — Sourced from [ANU QRNG](https://qrng.anu.edu.au/) (quantum vacuum fluctuations); falls back to local CSPRNG if unavailable
3. **Block context** — Previous block hash and height are mixed into the seed for deterministic verifiability

This means even validators with the minimum stake will produce blocks, just less frequently. The entropy source (`"quantum"` or `"local"`) is visible on the validator dashboard.

## Leaving the Validator Set

See [Unstaking](../staking/README.md#unstake) — after unstaking below the minimum, you're removed from the active validator set.
