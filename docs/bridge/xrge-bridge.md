# XRGE Bridge

Bridge XRGE tokens between Base mainnet and RougeChain L1 using the **BridgeVaultV2** contract.

> **Status: LIVE (hardened R1 bridge), tested end-to-end.** Releases on Base are authorized with
> **classical** keys (a capped relayer key under a Safe 2-of-3 multisig). The post-quantum
> [V3 XRGE bridge](v3-xrge-bridge.md) is built but **not activated**; nothing on this page uses it.

## Overview

Unlike qETH/qUSDC (which are wrapped assets), XRGE is the native token of RougeChain. The XRGE bridge allows moving XRGE between its ERC-20 representation on Base and the L1 network.

**XRGE token on Base mainnet:** `0x147120faEC9277ec02d957584CFCD92B56A24317`
**BridgeVaultV2:** `0x7BB10752E99e8872d7D2DE5D92bfd43cd935Cd2D`

Amounts on RougeChain are whole XRGE; the ERC-20 uses 18 decimals.

## Deposit (Base XRGE → L1 XRGE)

1. Approve the **BridgeVaultV2** contract to spend your XRGE
2. Call `deposit(amount, rougechainPubkey)` on the vault
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
4. The relayer calls `release()` on the vault to unlock your XRGE on Base, within the vault's
   per-transaction and daily caps. Each withdrawal is paid at most once.
5. If a release can't be completed, it is reported and handled by the operators. Automatic
   refunds are **disabled in production**. Status is shown on the Bridge page.

## BridgeVaultV2 Contract

A lock-and-release contract owned by a Safe multisig (2-of-3), with a separate capped relayer role:

- `deposit(amount, rougechainPubkey)` — Lock XRGE, emit event for relayer
- `release(to, amount, l1TxId)` — relayer role only, within per-transaction and rolling daily caps, while unpaused
- `vaultBalance()` — View how much XRGE the vault holds
- Emergency withdrawal — multisig only, behind a 48-hour timelock

Liquidity in the vault = total XRGE locked by depositors minus released amounts.
