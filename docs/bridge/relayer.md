# Bridge Relayer

The bridge relayer is an off-chain process that connects RougeChain L1 with Base. It
fulfills withdrawals (L1 → Base), watches for deposits to auto-claim (Base → L1), and
refunds withdrawals that cannot be released.

> For the full configuration table and operational notes, see
> [`scripts/README.md`](https://github.com/cyberdreadx/quantum-vault/blob/main/scripts/README.md).

## How It Works

1. Polls the node for pending ETH and XRGE withdrawals and releases the corresponding asset on Base
2. Marks each release fulfilled; on repeated failure, reports it and **auto-refunds** the owner on L1
3. **Deposit watcher:** scans the bridge contracts for deposit events and auto-claims them on L1
4. Alerts (console + optional webhook) on repeated failures

## Running the Relayer

The relayer and the daemon share `bridge-relayer.env` (copy from `bridge-relayer.env.example`):

```bash
# Key variables (see bridge-relayer.env.example for the full list)
CORE_API_URL="http://localhost:5100"
BRIDGE_CUSTODY_PRIVATE_KEY="0x..."   # EVM private key for the bridge wallet
BRIDGE_RELAYER_SECRET="your-secret"  # Shared secret for API authentication
BASE_CHAIN="mainnet"
BASE_RPC_URL="https://mainnet.base.org"   # NOTE: var name is BASE_RPC_URL
ROUGE_BRIDGE_ADDRESS="0x..."         # RougeBridge contract address
XRGE_BRIDGE_VAULT="0x..."            # BridgeVault contract address
AUTO_REFUND="true"                   # Auto-refund failed withdrawals
DEPOSIT_WATCHER="true"               # Auto-claim deposits
# ALERT_WEBHOOK_URL=                 # Optional Slack/Discord webhook

# Production: systemd (replaces the old pm2 process — never run both)
sudo systemctl restart bridge-relayer.service

# Local
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
