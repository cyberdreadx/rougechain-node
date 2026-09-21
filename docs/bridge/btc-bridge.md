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

## Deploy

### Daemon env
| Var | Meaning |
|---|---|
| `QV_BRIDGE_BTC_CUSTODY` | Custody BTC address to watch (set to the relayer's derived address). Empty = BTC bridge disabled. |
| `QV_BRIDGE_BTC_NETWORK` | `mainnet` (default) or `testnet`. |
| `QV_BRIDGE_BTC_MIN_CONFIRMATIONS` | Confirmations before honoring a deposit/payout (default 2). |
| `QV_BTC_ESPLORA_PRIMARY` / `QV_BTC_ESPLORA_SECONDARY` | Override the two Esplora bases (network-aware defaults otherwise). |
| `QV_BTC_ALLOW_SINGLE_PROVIDER` | `true` to honor a deposit on the primary alone if the secondary is down (default false = safer). |
| `BRIDGE_RELAYER_SECRET` | Shared secret; the relayer sends it to fulfill payouts. |

### Relayer
Copy `btc-bridge-relayer.env.example` → `btc-bridge-relayer.env`, fill in `BRIDGE_BTC_CUSTODY_WIF`
and `BRIDGE_RELAYER_SECRET`, then `npm run relayer:btc`. It prints the custody address it derives —
set the daemon's `QV_BRIDGE_BTC_CUSTODY` to that exact address, and fund it.

### Go-live checklist
1. **Testnet first.** `QV_BRIDGE_BTC_NETWORK=testnet` on both daemon and relayer. Run a full
   deposit + withdraw round-trip. The relayer stays in **dry-run** (`BTC_RELAYER_LIVE` unset) until
   you've watched it build a correct payout.
2. Set `BTC_MAX_WITHDRAW_SATS` to a sane per-payout ceiling.
3. Flip `BTC_RELAYER_LIVE=true` only after the testnet round-trip looks right.
4. On mainnet, keep the custody key cold for the deposit-only period if you want; the hot key is
   only needed once you enable withdrawals. Run the relayer as a singleton (two against one wallet
   can double-spend UTXOs). Keep `BRIDGE_DATA_DIR` persistent (the idempotency state lives there).

### Emergency stop
`QV_BRIDGE_BTC_CUSTODY` unset disables new deposits; `QV_BRIDGE_WITHDRAW_PAUSED=true` on the daemon
halts all withdrawals (shared kill switch); stop the relayer process to halt payouts.
