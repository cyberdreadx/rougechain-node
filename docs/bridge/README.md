# Bridge

RougeChain supports bridging assets between **Base Sepolia** (EVM) and the RougeChain L1 network. The bridge uses a lock-and-mint / burn-and-release model with a dedicated smart contract.

## Supported Assets

| EVM Asset | RougeChain Asset | Decimals | Direction |
|-----------|-----------------|----------|-----------|
| ETH       | qETH            | 6 (L1 units) | Both ways |
| USDC      | qUSDC           | 6        | Both ways |
| XRGE      | XRGE            | 18 (EVM) / whole units (L1) | Both ways |

## How It Works

### Deposit (EVM → RougeChain)

1. User deposits ETH, USDC, or XRGE into the **RougeBridge** smart contract on Base Sepolia
2. User calls the **claim** endpoint on RougeChain with the EVM transaction hash
3. The node verifies the deposit on-chain and mints the wrapped token (qETH, qUSDC, or XRGE) on L1

### Withdrawal (RougeChain → EVM)

1. User submits a signed **bridge_withdraw** transaction on RougeChain, burning the wrapped token
2. The withdrawal is recorded in the pending withdrawals store
3. The **bridge relayer** polls for pending withdrawals and releases the corresponding asset from the contract on EVM

## Security

- **Client-side signing** — Private keys never leave the browser. Withdraw transactions are signed locally using ML-DSA-65
- **RougeBridge contract** — Pausable, with guardian role for emergencies, timelock on large withdrawals
- **Relayer authentication** — The relayer uses a `BRIDGE_RELAYER_SECRET` for API authentication
- **Replay protection** — Claimed transaction hashes are persisted to prevent double-claims
- **EVM signature verification** — ETH claims require an EVM `personal_sign` to prove deposit ownership

## Architecture

```
Base Sepolia (EVM)              RougeChain L1
┌──────────────────┐           ┌──────────────────┐
│  RougeBridge.sol │           │  Node Daemon     │
│  - depositETH() │──relayer──│  - /bridge/claim  │
│  - depositERC20()│           │  - /bridge/withdraw│
│  - releaseETH() │◀─relayer──│  - withdraw store │
│  - releaseERC20()│           │                  │
│  BridgeVault.sol │           │                  │
│  - deposit()     │──relayer──│  - /bridge/xrge/* │
│  - release()     │◀─relayer──│                  │
└──────────────────┘           └──────────────────┘
```
