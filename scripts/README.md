# Bridge Relayer

The bridge relayer automates **bridge-out** fulfillment: it polls pending qETH→ETH withdrawals and sends ETH from the custody wallet to users on Base Sepolia.

## Requirements

- **Custody wallet**: The same EVM address that receives bridge deposits (from Bridge In) must hold the private key. This wallet receives ETH and pays out withdrawals.
- Base Sepolia RPC access (public or your own)

## Setup

1. Export the custody wallet's **private key** (the address configured as `QV_BRIDGE_CUSTODY_ADDRESS`).

2. Set environment variables:

```bash
export CORE_API_URL="http://localhost:5101"       # RougeChain API
export BRIDGE_CUSTODY_PRIVATE_KEY="0x..."        # Private key (required)
export BASE_SEPOLIA_RPC="https://sepolia.base.org"  # Optional, default above
export POLL_INTERVAL_MS=5000                     # Optional, default 5s
```

3. Run the relayer:

```bash
npm run relayer
```

Or with env inline:

```bash
BRIDGE_CUSTODY_PRIVATE_KEY=0x... npm run relayer
```

## Flow

1. Polls `GET /api/bridge/withdrawals` every N seconds
2. For each pending withdrawal: sends `amount_units × 10^12` wei to `evm_address`
3. On success: calls `DELETE /api/bridge/withdrawals/:txId` to mark fulfilled
4. Skips withdrawals if custody balance is insufficient (logs warning)

## Security

- **Never expose `BRIDGE_CUSTODY_PRIVATE_KEY`** — use env vars, not config files
- Run the relayer on a trusted machine with network access to both the node API and Base Sepolia
- The custody wallet should only hold amounts needed for withdrawals (or keep excess in cold storage)
