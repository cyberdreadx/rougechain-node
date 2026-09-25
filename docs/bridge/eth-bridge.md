# ETH Bridge (qETH)

Bridge ETH from Base mainnet to RougeChain as **qETH**, and back.

> **Status: LIVE (hardened R1 bridge), tested end-to-end.** qETH uses classical Base-side
> authorization and is **outside the scope of the V3 post-quantum XRGE bridge**.

## Deposit (ETH → qETH)

### Step 1: Send ETH to the Bridge

Connect your MetaMask (or other EVM wallet) to Base and call `depositETH(rougechainPubkey)`
on the RougeBridge contract (the Bridge page does this for you), passing your RougeChain
public key. This emits a `BridgeDepositETH` event carrying your recipient key.

### Step 2: Automatic claim

The relayer's **deposit watcher** sees the event and claims it for you — qETH is minted
to the RougeChain key you encoded in the deposit, once the deposit reaches the required
confirmation depth (`QV_BRIDGE_MIN_CONFIRMATIONS`, default 6 Base confirmations).
**No manual claim step is needed.**

The node verifies before minting:
- The transaction exists on Base and was sent to the correct contract
- The amount and sender match the deposit
- The transaction has at least the required confirmation depth (default 6)
- It hasn't been claimed before (auto-claim and manual claim share one dedup store)

**Manual fallback:** if the watcher is disabled, use the **Bridge In** tab — paste the
EVM tx hash, sign the claim message with your EVM wallet, and click **Claim**.

### Conversion Rate

1 ETH = 1,000,000 qETH units (6 decimal precision). Deposit amounts should be multiples of
0.000001 ETH (1e12 wei); smaller remainders cannot be represented on L1.

For example, depositing 0.01 ETH gives you 10,000 qETH units.

## Withdraw (qETH → ETH)

1. Go to the **Bridge** page and select the **Bridge Out** tab
2. Select **ETH** as the token
3. Enter the amount of qETH to bridge out
4. Enter the Base address to receive ETH
5. Click **Bridge Out**

The transaction is signed client-side (your private key never leaves the browser), then:
- qETH is burned on RougeChain
- A pending withdrawal is created
- The bridge relayer picks it up and sends ETH to your EVM address
- Release status (`pending` / `failed` / `refunded`) shows on the Bridge page. Automatic
  refunds are **disabled in production**; a release that can't be completed is handled by the
  operators.

A 0.1 XRGE fee is charged for the withdrawal transaction.

## Fees

| Operation | Fee |
|-----------|-----|
| Deposit (ETH → qETH) | Gas on Base only |
| Withdraw (qETH → ETH) | 0.1 XRGE |
