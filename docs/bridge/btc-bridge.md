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
   `evmAddress: <destination BTC address>`, `amountUnits: <sats>` (signed).
2. The withdrawal appears in `GET /api/bridge/btc/withdrawals`. The **BTC relayer**
   (`scripts/btc-bridge-relayer.ts`) builds, signs, and broadcasts the Bitcoin payout from custody.
3. Once confirmed, the relayer calls `DELETE /api/bridge/btc/withdrawals/:txId` `{ btcTxid }`. The
   daemon verifies the payout on-chain (custody-funded, paid the recipient ≥ owed sats, enough
   confirmations) before marking it fulfilled.

## Operators

Deployment and operations notes for the BTC relayer live in the repository's
[`scripts/README.md`](https://github.com/cyberdreadx/rougechain-node/blob/main/scripts/README.md).
