# Staking Rewards

Validators earn rewards for producing blocks on RougeChain.

## Reward Sources

| Source | Description |
|--------|-------------|
| **Transaction fees** | All fees from transactions in your block |
| **Base block reward** | Fixed reward per block (if configured) |

## How Rewards Work

1. A validator is selected to propose a block
2. The validator assembles pending transactions
3. All transaction fees in that block go to the proposer
4. Rewards are credited immediately upon block finalization

## Fee Structure

| Transaction Type | Fee |
|-----------------|-----|
| Transfer | 0.1 XRGE |
| Token creation | 100 XRGE |
| Pool creation | 10 XRGE |
| Swap | 0.3% (to LPs, not validators) |
| Stake/Unstake | 0.1 XRGE |

Validators earn the flat fees (transfer, token creation, pool creation, stake/unstake). Swap fees go to liquidity providers.

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
| Blocks per day | ~86,400 (1s block time) |
| Your blocks per day | ~8,640 |
| Avg fee per block | 0.5 XRGE |
| Daily earnings | ~4,320 XRGE |

These are approximate — actual returns vary with network conditions.

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
