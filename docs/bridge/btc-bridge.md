# Bitcoin Bridge (BTC ⇄ qBTC)

> **Status: separate system, staged rollout.** The Bitcoin bridge is independent of the Base
> bridge (R1) and is **not part of the V3 XRGE bridge**. On mainnet, BTC payouts (qBTC → BTC) are
> currently **not being served** while the rollout is staged. Do not send significant value; check
> [Status & Roadmap](../status.md).

Bridges native **Bitcoin** to **qBTC** on RougeChain L1 and back. qBTC held on RougeChain is controlled
by ML-DSA-65 keys. The BTC backing it sits in a Bitcoin custody address protected by Bitcoin's own
(classical) signatures, so the bridge custody itself is **not** post-quantum.

qBTC uses **8 decimals — 1 on-chain unit = 1 satoshi.**

## Why it's built differently from the ETH/USDC bridges

Bitcoin has no event logs and no EVM signatures, so none of the `eth_getLogs` / ECDSA machinery
applies. Two design choices carry the security:

1. **Recipient binding via `OP_RETURN`.** A depositor writes their RougeChain address into an
   `OP_RETURN` output of the very transaction that funds custody. The binding is baked into a
   signed Bitcoin transaction, so knowing a txid does not let anyone redirect the mint. No xpub,
   no HD derivation — the minimal key/quantum surface.
2. **Two-provider cross-check.** Every deposit is verified against two independent Esplora
   providers (mempool.space + blockstream.info by default). Both must agree on the custody amount
   and the recipient and both must meet the confirmation depth, so no single API can fabricate a
   deposit. If a provider is unreachable the daemon fails **closed** (the claim is idempotent and
   pollable, so an outage only delays).

**The daemon holds no Bitcoin key.** Deposits use a watch-only custody address. The hot key lives
only in the external BTC relayer, which pays withdrawals out; the daemon then re-verifies each
payout on the Bitcoin chain before marking it fulfilled.

## Deposit flow (BTC → qBTC)

1. User sends BTC to the custody address **with an `OP_RETURN` output** containing their RougeChain
   address. (Wallets that support OP_RETURN: Sparrow, Electrum, BlueWallet advanced, bitcoinjs.)
2. User submits the txid to `POST /api/bridge/btc/claim` `{ btcTxid, recipientRougechainPubkey? }`.
   The frontend polls this until it succeeds.
3. The daemon cross-checks both providers, then mints qBTC (sats) to the OP_RETURN recipient.
   Dedupe key: `btc:{txid}`.

## Withdraw flow (qBTC → BTC)

1. User burns qBTC via `POST /api/bridge/withdraw` with `tokenSymbol: "qBTC"`,
   `evmAddress: <destination BTC address>`, `amountUnits: <sats>` (signed). Amounts below the
   minimum (`btcMinWithdrawSats`, default 2 000 sats) are rejected before anything is burned.
2. The withdrawal appears in `GET /api/bridge/btc/withdrawals`. The **BTC relayer**
   (`scripts/btc-bridge-relayer.ts`) builds, signs, and broadcasts the Bitcoin payout from custody,
   sending the destination the burned amount **minus the payout's Bitcoin network fee**.
3. Once confirmed, the relayer calls `DELETE /api/bridge/btc/withdrawals/:txId` `{ btcTxid }`. The
   daemon verifies the payout on-chain (custody-funded, enough confirmations, and paid the
   recipient the owed sats minus at most the capped network fee) before marking it fulfilled.

## Fees and minimum

**The withdrawer pays the Bitcoin network fee.** For a withdrawal of `N` sats the relayer builds a
payout transaction and sends the destination `N − fee`, where `fee` is that transaction's real
network fee (its virtual size × the current fee rate, rounded up). Custody's change is
`inputs − N`, so custody's balance falls by exactly the `N` sats that were burned.

Example: a 5 000-sat withdrawal at 1 sat/vB. A typical payout (one custody input, destination +
change outputs) is 141 vB, so the fee is 141 sats and the destination receives **4 859 sats**.

| Rule | Value |
|---|---|
| Minimum withdrawal | `btcMinWithdrawSats` from `GET /api/bridge/config` (default **2 000 sats**) |
| Network-fee cap | `btcMaxNetworkFeeSats` (default **10 000 sats**). When fees are higher the payout waits until they drop — it is never paid with a larger fee. |
| Tiny remainders | If `N − fee` would be at or below the Bitcoin dust limit (546 sats) at current fees, the payout is not sent and the withdrawal is held for manual review — never silently lost. |

The site shows an **estimate** of the fee (mempool.space rate × ~141 vB) and "you receive ≈ amount −
fee"; the exact fee depends on the transaction the relayer builds.

**Node verification rule.** A payout is accepted when it is funded by custody, has the required
confirmations, pays the destination a non-zero amount, and either pays the full owed amount
(the pre-fee-policy form, still accepted) or `paid + fee ≥ owed` with `fee ≤` the cap. The node
computes `fee` itself from the Bitcoin transaction data (sum of inputs minus sum of outputs,
cross-checked against the provider's reported fee); it never takes the fee from the relayer.

## Operators

Deployment and operations notes for the BTC relayer live in the repository's
[`scripts/README.md`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/README.md).
