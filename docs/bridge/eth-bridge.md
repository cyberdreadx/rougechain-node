# ETH Bridge (qETH)

Bridge ETH from Base Sepolia to RougeChain as **qETH**, and back.

## Deposit (ETH → qETH)

### Step 1: Send ETH to the Bridge

Connect your MetaMask (or other EVM wallet) to Base Sepolia and send ETH to the custody/bridge contract address shown on the Bridge page.

### Step 2: Claim qETH

1. Go to the **Bridge** page and select the **Bridge In** tab
2. Paste the EVM transaction hash
3. Sign the claim message with your EVM wallet (proves you made the deposit)
4. Click **Claim**

The node verifies:
- The transaction exists on Base Sepolia
- It was sent to the correct custody address
- The EVM signature matches the sender
- The transaction has sufficient confirmations
- It hasn't been claimed before

On success, qETH is minted to your RougeChain wallet.

### Conversion Rate

1 ETH = 1,000,000 qETH units (6 decimal precision)

For example, depositing 0.01 ETH gives you 10,000 qETH units.

## Withdraw (qETH → ETH)

1. Go to the **Bridge** page and select the **Bridge Out** tab
2. Select **ETH** as the token
3. Enter the amount of qETH to bridge out
4. Enter the Base Sepolia address to receive ETH
5. Click **Bridge Out**

The transaction is signed client-side (your private key never leaves the browser), then:
- qETH is burned on RougeChain
- A pending withdrawal is created
- The bridge relayer picks it up and sends ETH to your EVM address

A 0.1 XRGE fee is charged for the withdrawal transaction.

## Fees

| Operation | Fee |
|-----------|-----|
| Deposit (ETH → qETH) | Gas on Base Sepolia only |
| Withdraw (qETH → ETH) | 0.1 XRGE |
