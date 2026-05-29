# Bridge

RougeChain supports bridging assets between **Base mainnet** (EVM, chain id `8453`) and the RougeChain L1 network. The bridge uses a lock-and-mint / burn-and-release model with a dedicated smart contract. (Base Sepolia, chain id `84532`, is supported for testing via `BASE_CHAIN=sepolia`.)

## Supported Assets

| EVM Asset | RougeChain Asset | Decimals | Direction |
|-----------|-----------------|----------|-----------|
| ETH       | qETH            | 6 (L1 units) | Both ways |
| USDC      | qUSDC           | 6        | Both ways |
| XRGE      | XRGE            | 18 (EVM) / whole units (L1) | Both ways |

## How It Works

### Deposit (EVM → RougeChain)

1. User deposits ETH, USDC, or XRGE into the **RougeBridge** / **BridgeVault** contract on Base
2. The **deposit watcher** in the relayer detects the deposit event and auto-claims it
   on L1 — the node verifies the deposit on-chain and mints the wrapped token (qETH,
   qUSDC, or XRGE) to the recipient encoded in the deposit. No manual step is required.
3. As a fallback, the user can still call the **claim** endpoint with the EVM tx hash
   (e.g. if the watcher is disabled). Claims are deduped, so auto- and manual claims of
   the same deposit can't double-mint.

### Withdrawal (RougeChain → EVM)

1. User submits a signed **bridge_withdraw** transaction on RougeChain, burning the wrapped token
2. The withdrawal is recorded in the pending withdrawals store with its owner key, token,
   and `status`
3. The **bridge relayer** polls for pending withdrawals and releases the corresponding asset on Base
4. If a release keeps failing, the relayer reports it; after a threshold the withdrawal is
   **auto-refunded** — the burned tokens are re-minted to the owner on L1. Status
   (`pending` / `failed` / `refunded`) is exposed via the API and the Bridge page.

## Security

- **Client-side signing** — Private keys never leave the browser. Withdraw transactions are signed locally using ML-DSA-65
- **RougeBridge contract** — Pausable, with guardian role for emergencies, timelock on large withdrawals
- **Relayer authentication** — The relayer uses a `BRIDGE_RELAYER_SECRET` for API authentication
- **Replay protection** — Claimed transaction hashes are persisted to prevent double-claims; refunds use a `refund:<txId>` key so they can't be issued twice
- **EVM signature verification** — manual ETH claims require an EVM `personal_sign`; auto-claims re-verify the deposit tx on-chain (sender, amount, confirmations)

## Architecture

```
Base mainnet (EVM)              RougeChain L1
┌──────────────────┐           ┌──────────────────┐
│  RougeBridge.sol │  deposit  │  Node Daemon     │
│  - depositETH() │──watcher─▶│  - /deposit/      │
│  - depositERC20()│           │      auto-claim   │
│  - releaseETH() │◀─relayer──│  - /bridge/withdraw│
│  - releaseERC20()│  release  │  - withdraw store │
│  BridgeVault.sol │           │  - /…/refund      │
│  - deposit()     │──watcher─▶│  - /bridge/xrge/* │
│  - release()     │◀─relayer──│                  │
└──────────────────┘           └──────────────────┘
       deposit watcher: Base → L1 auto-claim
       relayer release + refund: L1 → Base
```
