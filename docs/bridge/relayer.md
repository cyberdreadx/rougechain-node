# Bridge Relayer

The bridge relayer is an off-chain process that connects RougeChain L1 with Base. It
fulfills withdrawals (L1 → Base), watches for deposits to auto-claim (Base → L1), and
can refund withdrawals that cannot be released (disabled in production).

> For the full configuration table and operational notes, see
> [`scripts/README.md`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/README.md).

## How It Works

1. Polls the node for pending ETH, USDC and XRGE withdrawals and releases the corresponding asset on Base
2. Marks each release fulfilled; on repeated failure, reports it. Auto-refund exists but is **disabled in production** (`AUTO_REFUND=false`)
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
XRGE_BRIDGE_VAULT="0x..."            # BridgeVaultV2 contract address
AUTO_REFUND="false"                  # Production setting: failed withdrawals are handled manually
DEPOSIT_WATCHER="true"               # Auto-claim deposits
# ALERT_WEBHOOK_URL=                 # Optional Slack/Discord webhook

# Run as a singleton under a process supervisor — never run two relayers against one wallet
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

## Daemon Withdraw Guardrails

Independent of the on-chain contracts, the RougeChain daemon enforces its own withdraw controls (an operator pause, a per-transaction cap, and a required Base confirmation depth for deposit claims, default 6). Operator configuration is documented in the repository's [`scripts/README.md`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/README.md).

## Security Considerations

- The relayer signs Base transactions with a **classical ECDSA key**. This is the R1 production design; the V3 XRGE bridge (not activated) removes this key from XRGE authorization

- The relayer's EVM private key should be stored securely (not in code)
- Use a dedicated wallet with limited funds for the relayer
- The RougeBridge owner is currently a single operator key, not a multisig; that key also performs releases. The guardian role is held by a 2-of-3 Safe multisig, which can pause the bridge and cancel queued large releases. Other protections include the 24-hour timelock on large releases and daemon-side controls. Migrating ownership to multisig control is a planned security improvement.
- The `BRIDGE_RELAYER_SECRET` should be a strong random string
