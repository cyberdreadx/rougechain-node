# Staking Rewards

Validators earn rewards for producing blocks on RougeChain.

## Reward Sources

| Source | Description |
|--------|-------------|
| **Transaction fees** | Your share of the tip pool from transactions in each block (proposer + stake-weighted validator share) |
| **Base block reward** | Fixed reward per block (if configured) |

## How Rewards Work

1. A validator is selected to propose a block
2. The validator assembles pending transactions
3. Fees are split, not paid entirely to the proposer: **50% of the base fee is burned**, and the remaining tip pool is distributed **20% to the proposer, 70% among validators (stake-weighted), and 10% to the treasury**
4. Rewards are credited immediately upon block finalization

## Fee Structure

| Transaction Type | Fee |
|-----------------|-----|
| Transfer (wallet-signed) | 1 XRGE |
| Token creation | 100 XRGE |
| Pool creation | 10 XRGE |
| Swap | 1 XRGE network fee, plus 0.3% of the input to liquidity providers |
| Add / remove liquidity | 1 XRGE |
| Stake / Unstake | 1 XRGE |
| Bridge withdrawal | 0.1 XRGE |

These are the fees the node binds to each signed transaction type (`core/daemon/src/v2_binding.rs`).

The tip portion of these fees (after the base-fee burn) is split across the proposer, all validators (stake-weighted), and the treasury — see [How Rewards Work](#how-rewards-work). Swap fees go to liquidity providers, not validators.

## Estimated Returns

Rewards depend on:

- **Your stake** relative to total staked — determines how often you're selected
- **Network activity** — more transactions = more fees per block
- **Number of validators** — fewer validators means more blocks per validator

### Example

| Scenario | Value |
|----------|-------|
| Your stake | 10,000 XRGE |
| Total staked | 100,000 XRGE |
| Your share | 10% |
| Target block time | 400 ms |
| Your share of proposed blocks | ~10% (stake-weighted) |
| Avg fee per block | varies with network activity |

Your earnings are your ~10% share of the fees in the blocks you propose. Blocks
are produced as transactions arrive, so daily volume tracks real network
activity — on a quiet chain that is low, and there is **no fixed "blocks per
day."** These figures are illustrative, not a yield promise; actual returns vary
with usage.

## Compounding

Rewards are added to your balance, not your stake. To compound:

1. Periodically stake your accumulated rewards
2. This increases your proposer probability
3. Leading to more blocks and more rewards

## Checking Rewards

### Via Web UI

Go to the **Validators** page to see your validator stats including blocks proposed.

### Via API

```bash
# Check your balance (includes accumulated rewards)
curl "https://testnet.rougechain.io/api/balance/your-public-key"

# Check blocks proposed
curl "https://testnet.rougechain.io/api/validators"
```

## Tax Considerations

Staking rewards may be taxable income in your jurisdiction. Keep records of:

- Amount staked
- Rewards received (block by block)
- Token price at time of receipt
- Unstaking transactions

RougeChain does not provide tax advice. Consult a tax professional.
