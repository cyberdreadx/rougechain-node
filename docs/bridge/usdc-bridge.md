# USDC Bridge (qUSDC)

Bridge USDC from Base to RougeChain as **qUSDC**, and back.

## Overview

qUSDC is a wrapped representation of USDC on RougeChain. It maintains a 1:1 peg with USDC locked in the RougeBridge contract on Base.

**USDC Contract on Base mainnet:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
(Base Sepolia test USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`)

## Deposit (USDC → qUSDC)

1. Approve the RougeBridge contract to spend your USDC
2. Call `depositERC20(usdc_address, amount, rougechainPubkey)` on the contract
3. The relayer's **deposit watcher** detects the `BridgeDepositERC20` event and
   auto-claims it — qUSDC is minted to your L1 wallet, no manual step needed.
4. Manual fallback: on the **Bridge** page select **USDC** → **Bridge In**, paste the
   EVM tx hash, and claim.

The node parses the ERC-20 Transfer event from the transaction receipt to determine the amount. USDC uses 6 decimals, and qUSDC uses the same 6-decimal precision.

## Withdraw (qUSDC → USDC)

1. Go to **Bridge** page, select **USDC**, switch to **Bridge Out**
2. Enter amount and destination EVM address
3. Click **Bridge Out qUSDC**

The relayer calls `releaseERC20()` on the RougeBridge contract to send USDC back to your EVM address. If the release keeps failing, the withdrawal is auto-refunded as qUSDC on L1.

## Fees

| Operation | Fee |
|-----------|-----|
| Deposit | Gas on Base |
| Withdraw | 0.1 XRGE |
