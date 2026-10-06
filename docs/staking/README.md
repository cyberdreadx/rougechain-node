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
| Minimum stake | 10,000 XRGE — enforced by the node **API** on every stake call (`/api/v2/stake`, CLI), **not by consensus**: block apply accepts any positive stake, and one mainnet validator holds 9,000 XRGE |
| Unbonding period | 500 blocks (a block count, not a duration) |
| Slashing | **None active.** The code carries 10 % per violation and a 20-block jail, but automatic missed-block slashing is frozen since height 100, the legacy `slash` transaction is rejected since height 245, and evidence-based slashing does not exist yet |
| Validators on mainnet (2026-10-06) | 3: about 100.09 M XRGE (producing), 10,000 XRGE and 9,000 XRGE (both non-producing) |

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
| Minimum tip | The code tops the tip pool up to 0.1 XRGE per block from the `__staking_rewards__` reserve — but on mainnet that reserve holds **0 XRGE** (never funded), so the floor pays nothing |

Fees are credited when a block is applied to state. The validator share goes to every validator in
the set by stake, with no check that the validator took part in finality. There is no block subsidy:
with today's activity, rewards are small (about 541 XRGE of fees were collected over the whole chain
up to 2026-10-06, before burning and splitting). See [Validator Economics](becoming-validator.md) for detailed reward calculations.

## PQC Security

All validator operations use **ML-DSA-65** signatures:

- Block proposals are signed
- Stake/unstake transactions are signed
- Signatures are verified by all nodes

Block production and staking are therefore signed with quantum-resistant keys.

> **Finality:** verified BFT finality (FINALITY_V2 — verified ML-DSA-65 votes, recomputed quorum,
> anti-equivocation journals) is **active on mainnet since height 150**. Every block from 151 carries a
> ⅔-stake commit certificate for its parent. See [Finality](finality.md).

> **Planned, not built:** a consensus redesign decided on 2026-10-06 — rotating stake-weighted
> proposers, Tendermint-style rounds, an active set capped at 32, a **consensus-enforced minimum of
> 100,000 XRGE** (30-day grace for existing validators), 21-day unbonding and evidence-based slashing.
> Heights will be announced in advance; see [Status & Roadmap](../status.md#consensus-redesign--decided-2026-10-06-not-built).
> Until then, everything on this page describes the rules as they run today.
