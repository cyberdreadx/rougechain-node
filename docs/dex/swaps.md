# Swaps

## Making a Swap

1. Go to the **Swap** page
2. Select the input token and output token
3. Enter the amount to swap
4. Review the quote (output amount, price impact, minimum received)
5. Click **Swap**

## Slippage Protection

Set your maximum slippage tolerance to protect against price movements during your transaction. If the actual output would be less than your minimum, the transaction is rejected.

Default slippage: 0.5%

## Price Impact

Price impact shows how much your trade will move the pool price. Large trades relative to pool size have higher price impact.

| Price Impact | Severity |
|-------------|----------|
| < 1% | Low |
| 1-5% | Medium |
| > 5% | High (warning shown) |

## Multi-Hop Routing

If no direct pool exists between your tokens, the router automatically finds a path through XRGE:

```
TOKEN_A → XRGE → TOKEN_B
```

This uses two swaps internally but is handled in a single transaction.

## Fees

- **0.3%** of the input amount goes to liquidity providers
- **1 XRGE** base transaction fee
