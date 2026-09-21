# Bridge Security Model

This page states plainly who can authorize what, today and under V3. See
[Status & Roadmap](../status.md) for what is live.

## Today: the hardened R1 bridge (LIVE)

| Layer | Protection |
|---|---|
| RougeChain side | Withdrawals are ML-DSA-65-signed transactions. A withdrawal either burns and records a payout atomically or fails with a receipt — it cannot burn without a payout record or create a payout without a burn. |
| Deposits | Every mint is verified against the actual Base transaction (contract, sender, amount) at a confirmation depth (default 6). Claims are de-duplicated, so a deposit cannot mint twice. |
| Payouts | Each withdrawal is paid at most once; fulfillment is re-verified on Base at confirmation depth before it is marked complete. |
| XRGE vault (`BridgeVaultV2`) | Owned by a **Safe multisig (2-of-3)**. A separate hot relayer key can only call `release()` within per-transaction and rolling daily caps, and only while unpaused. Emergency withdrawal is behind a 48-hour timelock. |
| qETH / qUSDC (`RougeBridge`) | Pausable, guardian role, timelock on large releases, replay protection by L1 transaction id. |
| Operations | Daemon-side kill switch and per-transaction cap; automatic refunds are **disabled** in production (failed releases are handled manually). |

**The trust assumption:** releases on Base are authorized by **classical ECDSA keys** (the relayer
key and the Safe owners). These are conventional, quantum-vulnerable signatures. The R1 bridge
limits the damage a compromised relayer key can do (caps, pause, multisig control), but it does not
make the Base side post-quantum. The bridge is also operated by a small team, not a decentralized
set.

## V3 (NOT ACTIVATED): XRGE only

V3 moves **XRGE** release authorization to an M-of-N **ML-DSA-65** authority verified on-chain, on
top of verified RougeChain finality. Classical keys keep only limited roles (pausing, and actions
that are themselves gated by the post-quantum authority). Details:
[V3 Post-Quantum XRGE Bridge](v3-xrge-bridge.md), [Authority Rotation](authority-rotation.md).

| Asset | Today | After V3 activation |
|---|---|---|
| XRGE | R1, classical Base-side authorization | ML-DSA-65 authorization on Base |
| qETH | R1, classical Base-side authorization | **Unchanged** (outside V3 scope) |
| qUSDC | R1, classical Base-side authorization | **Unchanged** (outside V3 scope) |
| qBTC | Separate Bitcoin bridge | **Unchanged** (separate system) |

## What V3 does not fix

- Base itself, the XRGE ERC-20, and users' EVM wallets use classical cryptography.
- qETH/qUSDC custody remains classical.
- Bitcoin custody uses Bitcoin's own (classical) signatures.
- V3 is unaudited until the external review completes.
