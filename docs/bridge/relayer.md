# Bridge Relayer

The bridge relayer is an off-chain process that monitors pending withdrawals on RougeChain and executes the corresponding releases on Base Sepolia.

## How It Works

1. Polls the RougeChain node for pending ETH and XRGE withdrawals
2. For each pending withdrawal, sends the corresponding asset on Base Sepolia
3. Marks the withdrawal as fulfilled on the node

## Running the Relayer

```bash
# Required environment variables
export CORE_API_URL="http://localhost:5101"
export BRIDGE_CUSTODY_PRIVATE_KEY="0x..."   # EVM private key for the bridge wallet
export BRIDGE_RELAYER_SECRET="your-secret"  # Shared secret for API authentication
export BASE_SEPOLIA_RPC="https://sepolia.base.org"

# Optional
export XRGE_BRIDGE_VAULT="0x..."            # BridgeVault contract address
export ROUGE_BRIDGE_ADDRESS="0x..."         # RougeBridge contract address
export USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
export POLL_INTERVAL_MS="5000"

# Run
npx tsx scripts/bridge-relayer.ts
```

## Authentication

The relayer authenticates with the node using the `BRIDGE_RELAYER_SECRET` environment variable. This is sent as the `x-bridge-relayer-secret` HTTP header when marking withdrawals as fulfilled.

Set the same secret on both the relayer and the node:

```bash
# On the node
export BRIDGE_RELAYER_SECRET="your-secret"

# On the relayer
export BRIDGE_RELAYER_SECRET="your-secret"
```

## Contract Mode vs Legacy Mode

- **With `ROUGE_BRIDGE_ADDRESS`** — The relayer calls `releaseETH()` / `releaseERC20()` on the RougeBridge contract
- **Without it** — Falls back to raw ETH transfers from the custody wallet (legacy mode)
- **With `XRGE_BRIDGE_VAULT`** — Enables XRGE bridge support via the BridgeVault contract

## Security Considerations

- The relayer's EVM private key should be stored securely (not in code)
- Use a dedicated wallet with limited funds for the relayer
- For production, the RougeBridge contract owner should be a multisig
- The `BRIDGE_RELAYER_SECRET` should be a strong random string
