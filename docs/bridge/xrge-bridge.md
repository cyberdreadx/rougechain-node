# XRGE Bridge

Bridge XRGE tokens between Base (EVM) and RougeChain L1 using the **BridgeVault** contract.

## Overview

Unlike qETH/qUSDC (which are wrapped assets), XRGE is the native token of RougeChain. The XRGE bridge allows moving XRGE between its ERC-20 representation on Base and the L1 network.

**XRGE Token on Base:** `0x147120faEC9277ec02d957584CFCD92B56A24317`

## Deposit (Base XRGE → L1 XRGE)

1. Approve the **BridgeVault** contract to spend your XRGE
2. Call `deposit(amount, rougechainPubkey)` on the BridgeVault
3. The vault locks your XRGE and emits a `BridgeDeposit` event
4. Call the `/api/bridge/xrge/claim` endpoint with the transaction hash
5. The node verifies the receipt and credits XRGE on L1

## Withdraw (L1 XRGE → Base XRGE)

1. Go to the **Bridge** page and use the **XRGE Bridge Out** tab
2. Enter the amount and your Base EVM address
3. Submit the signed withdrawal
4. The relayer calls `release()` on the BridgeVault to unlock your XRGE on Base

## BridgeVault Contract

The BridgeVault is a lock-and-release contract:

- `deposit(amount, rougechainPubkey)` — Lock XRGE, emit event for relayer
- `release(to, amount, l1TxId)` — Owner (relayer) releases XRGE back to user
- `vaultBalance()` — View how much XRGE the vault holds
- `emergencyWithdraw(token)` — Admin-only emergency recovery

Liquidity in the vault = total XRGE locked by depositors minus released amounts.
