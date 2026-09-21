# Bridge Overview

> **Status:** the **R1 production bridge is LIVE** on Base mainnet. XRGE, qETH and qUSDC paths have
> been tested end-to-end. Base-side authorization is **classical**: XRGE uses a Safe multisig plus a capped relayer
> key; qETH/qUSDC (`RougeBridge`) are currently owned by a single operator key. The post-quantum **V3 XRGE bridge is built but NOT activated** — see
> [V3 Post-Quantum XRGE Bridge](v3-xrge-bridge.md) and [Status & Roadmap](../status.md).

RougeChain has two separate bridge systems:

| System | Assets | Counterpart chain | Page |
|---|---|---|---|
| **Base bridge (R1)** | XRGE, qETH, qUSDC | Base mainnet | this page, [XRGE](xrge-bridge.md), [qETH](eth-bridge.md), [qUSDC](usdc-bridge.md) |
| **Bitcoin bridge** | qBTC | Bitcoin | [Bitcoin Bridge](btc-bridge.md) — separate architecture, not part of the Base bridge or V3 |

The rest of this page describes the Base bridge.

RougeChain supports bridging assets between **Base mainnet** (EVM, chain id `8453`) and the RougeChain L1 network. The bridge uses a lock-and-mint / burn-and-release model with a dedicated smart contract. (Base Sepolia, chain id `84532`, is supported for testing via `BASE_CHAIN=sepolia`.)

## Supported Assets

| EVM Asset | RougeChain Asset | Decimals | Direction |
|-----------|-----------------|----------|-----------|
| ETH       | qETH            | 6 (L1 units) | Both ways |
| XRGE      | XRGE            | 18 (EVM) / whole units (L1) | Both ways |
| USDC      | qUSDC           | 6        | Both ways |

> XRGE uses the `BridgeVaultV2` contract; ETH and USDC use the `RougeBridge` contract.

## How It Works

### Deposit (EVM → RougeChain)

1. User deposits ETH or USDC into **RougeBridge**, or XRGE into **BridgeVaultV2**, on Base
2. The **deposit watcher** in the relayer detects the deposit event and auto-claims it
   on L1 — the node verifies the deposit on-chain and mints the L1 asset (qETH, qUSDC or
   XRGE) to the recipient encoded in the deposit. No manual step is required.
3. As a fallback, the user can still call the **claim** endpoint with the EVM tx hash
   (e.g. if the watcher is disabled). Claims are deduped, so auto- and manual claims of
   the same deposit can't double-mint.

> Every claim is verified against the **actual on-chain Base deposit** (the `Transfer`
> to the custody contract / vault) — never a caller-supplied amount — and requires a
> valid EVM signature plus a confirmation depth (`QV_BRIDGE_MIN_CONFIRMATIONS`, default 6)
> before minting.

### Withdrawal (RougeChain → EVM)

1. User submits a signed **bridge_withdraw** transaction on RougeChain, burning the wrapped token
2. The withdrawal is recorded in the pending withdrawals store with its owner key, token,
   and `status`
3. The **bridge relayer** polls for pending withdrawals and releases the corresponding asset on Base
4. Each withdrawal is paid at most once, and fulfillment is re-verified on Base at confirmation
   depth. If a release keeps failing, the relayer reports it and the withdrawal is handled by the operators. Automatic refunds are **disabled in production** as part of the R1 hardening; status (`pending` / `failed` / `refunded`) is exposed via the API and the Bridge page.

## Security

See [Bridge Security Model](security-model.md) for the full trust model. In short:

- **Client-side signing** — Private keys never leave the browser. Withdraw transactions are signed locally using ML-DSA-65
- **Classical Base-side authorization** — releases on Base are authorized by ECDSA keys (capped hot relayer under a Safe multisig). This is hardened but not post-quantum; V3 changes it for XRGE only, once activated
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
│  BridgeVaultV2   │           │  - /…/refund      │
│  - deposit()     │──watcher─▶│  - /bridge/xrge/* │
│  - release()     │◀─relayer──│                  │
└──────────────────┘           └──────────────────┘
       deposit watcher: Base → L1 auto-claim
       relayer release + refund: L1 → Base
```
