# DEX & AMM

RougeChain includes a built-in decentralized exchange (DEX) powered by an Automated Market Maker (AMM) using the constant product formula (x * y = k).

## Overview

- **Create pools** for any token pair
- **Swap** between tokens with slippage protection
- **Provide liquidity** and earn fees from trades
- **Multi-hop routing** for tokens without direct pools

All operations are signed client-side with ML-DSA-65 — your private key never leaves the browser.

## Fee Structure

| Operation | Fee |
|-----------|-----|
| Create Pool | 100 XRGE |
| Swap | 0.3% of input + 1 XRGE tx fee |
| Add Liquidity | 1 XRGE |
| Remove Liquidity | 1 XRGE |

The 0.3% swap fee is distributed to liquidity providers proportional to their share of the pool.

## Pool Mechanics

Pools use the **Constant Product Market Maker** model:

```
reserve_a × reserve_b = k (constant)
```

When a user swaps token A for token B:
1. Token A is added to the pool
2. Token B is removed, maintaining the constant product
3. 0.3% fee is taken from the input amount
4. Price impact increases with larger trades relative to pool size

## LP Tokens

When you provide liquidity, you receive LP tokens representing your share of the pool. When you remove liquidity, you burn LP tokens and receive your proportional share of both tokens in the pool.
