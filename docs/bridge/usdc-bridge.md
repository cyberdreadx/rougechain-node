# USDC Bridge (qUSDC)

> **Status: LIVE (hardened R1 bridge), tested end-to-end.** qUSDC uses classical Base-side
> authorization and is **outside the scope of the V3 post-quantum XRGE bridge**.

qUSDC is a 1:1 representation of **USDC on Base mainnet** on RougeChain, with 6 decimals. It uses
the same `RougeBridge` contract as qETH (`0x0c09C764AdC024497729cd452ECfeE8869d35d83`).

**USDC on Base mainnet:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Deposit (USDC → qUSDC)

1. Approve `RougeBridge` to spend your USDC.
2. Call `depositERC20(usdc, amount, rougechainPubkey)` (the Bridge page does this for you).
3. The relayer's deposit watcher claims the deposit automatically once it reaches the required
   confirmation depth (default 6). The node verifies the on-chain deposit before minting qUSDC.

## Withdraw (qUSDC → USDC)

1. On the **Bridge** page choose **Bridge Out** and select **USDC**.
2. Enter the amount and your Base address, then submit the signed withdrawal.
3. qUSDC is burned on RougeChain and the relayer releases USDC on Base. Each withdrawal is paid at
   most once. Automatic refunds are disabled in production; failed releases are handled by the
   operators.

See [Bridge Security Model](security-model.md).
