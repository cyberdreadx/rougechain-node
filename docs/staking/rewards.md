# Staking Rewards

Validators earn a share of the transaction fees in every block on RougeChain.

## Reward Sources

| Source | Description |
|--------|-------------|
| **Transaction fees** | Your share of the tip pool from transactions in each block (proposer + stake-weighted validator share) |

There is no fixed block reward: validator income comes only from fees. The minimum-tip subsidy described below exists in the code but pays nothing on mainnet, because its reserve is empty.

## How Rewards Work

1. The designated proposer (the eligible validator with the most stake) proposes a block when there are pending transactions
2. The proposer assembles pending transactions; each transaction's full signed fee is debited from its sender
3. Fees are split, not paid entirely to the proposer: up to **half of the base fee per transaction is burned** (`burned = min(total fees, base fee × tx count ÷ 2)`), and the remaining tip pool is distributed **20% to the proposer, 70% among all staked, non-jailed validators (stake-weighted), and 10% to the treasury**. If the tip pool is below 0.1 XRGE the code tops it up from the `__staking_rewards__` reserve — which holds **0 XRGE** on mainnet (2026-10-06; it was never funded), so no top-up happens. Every validator in the set is paid its stake-weighted share whether or not it voted on the block.
4. Rewards are credited when the block is applied to state

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

- **Your stake** relative to total staked — determines your share of the 70% validator pool in every block
- **Network activity** — more transactions = more fees per block
- **Whether you are the designated proposer** — only the validator with the most stake proposes, and it also receives the 20% proposer share

### Example

| Scenario | Value |
|----------|-------|
| Your stake | 10,000 XRGE |
| Total staked | 100,000 XRGE (illustrative — mainnet's total is about 100.1 M XRGE, over 99.9 % of it in one validator, so a 10,000 XRGE stake earns about 0.01 % of the validator pool today) |
| Your share | 10% |
| Your share of the validator pool | 10% of 70% of each block's tip pool |
| Avg fee per block | varies with network activity |

Your earnings are your ~10% share of the 70% validator pool in every block,
whoever proposes it (plus the 20% proposer share only if you are the designated
proposer). Blocks
are produced as transactions arrive, so daily volume tracks real network
activity — on a quiet chain that is low, and there is **no fixed "blocks per
day."** These figures are illustrative, not a yield promise; actual returns vary
with usage.

## Compounding

Rewards are added to your balance, not your stake. To compound:

1. Periodically stake your accumulated rewards
2. This increases your share of the validator pool
3. Leading to more rewards (and, if your stake becomes the largest, the proposer slot)

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
