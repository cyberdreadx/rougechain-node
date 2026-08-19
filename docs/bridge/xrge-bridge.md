# XRGE Bridge

Bridge XRGE tokens between Base (EVM) and RougeChain L1 using the **BridgeVault** contract.

## Overview

Unlike qETH/qUSDC (which are wrapped assets), XRGE is the native token of RougeChain. The XRGE bridge allows moving XRGE between its ERC-20 representation on Base and the L1 network.

**XRGE Token on Base:** `0x147120faEC9277ec02d957584CFCD92B56A24317`

## Deposit (Base XRGE → L1 XRGE)

1. Approve the **BridgeVault** contract to spend your XRGE
2. Call `deposit(amount, rougechainPubkey)` on the BridgeVault
3. The vault locks your XRGE and emits a `BridgeDeposit` event carrying your L1 key
4. The relayer's **deposit watcher** detects the event and auto-claims it — XRGE is
   credited to your L1 wallet after the node verifies the on-chain transfer. No manual
   claim is needed.

The manual fallback endpoint `/api/bridge/xrge/claim` **requires an `evmSignature`** (sign
the claim message with the wallet that sent the XRGE) and **ignores any caller-supplied
`amount`** — the amount and depositor are derived from the actual on-chain
`Transfer(from → vault)` log emitted by the XRGE token, and the deposit must reach the
required confirmation depth (`QV_BRIDGE_MIN_CONFIRMATIONS`, default 6) before it mints.

## Withdraw (L1 XRGE → Base XRGE)

1. Go to the **Bridge** page and use the **XRGE Bridge Out** tab
2. Enter the amount and your Base EVM address
3. Submit the signed withdrawal
4. The relayer calls `release()` on the BridgeVault to unlock your XRGE on Base
5. If the release can't be completed after repeated attempts, the withdrawal is
   **auto-refunded** — your XRGE is re-minted on L1. Status is shown on the Bridge page.

## BridgeVault Contract

The BridgeVault is a lock-and-release contract:

- `deposit(amount, rougechainPubkey)` — Lock XRGE, emit event for relayer
- `release(to, amount, l1TxId)` — Owner (relayer) releases XRGE back to user
- `vaultBalance()` — View how much XRGE the vault holds
- `emergencyWithdraw(token)` — Admin-only emergency recovery

Liquidity in the vault = total XRGE locked by depositors minus released amounts.
