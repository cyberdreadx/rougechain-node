# Security Overview

An honest summary of what is post-quantum-secured today and what is not. For live/pending status
see [Status & Roadmap](status.md).

## RougeChain L1 — post-quantum-secured

- Accounts, transactions, validator block signatures and staking operations use **ML-DSA-65**
  (FIPS 204). Messaging and mail use **ML-KEM-768** (FIPS 203).
- Transactions are signed client-side; private keys do not leave the wallet.
- These algorithms are quantum-resistant under current cryptographic understanding. No system can
  promise more than that, and implementation bugs remain possible.

## Bridges — mixed

| Path | Today |
|---|---|
| RougeChain side of every bridge | ML-DSA-65-signed withdrawals |
| XRGE on Base (`BridgeVaultV2`) | **Classical** Base-side authorization (Safe multisig + capped relayer key). Hardened R1 architecture. |
| qETH / qUSDC on Base (`RougeBridge`) | **Classical** Base-side authorization |
| Bitcoin (qBTC) | Separate bridge; Bitcoin custody uses Bitcoin's classical signatures |

So: assets held **on RougeChain** are protected by post-quantum signatures. The **Base-side
custody** of bridged assets is not post-quantum today.

## What V3 will change (not activated)

The [V3 XRGE bridge](bridge/v3-xrge-bridge.md) changes the **XRGE** authorization path on Base to
on-chain-verified ML-DSA-65 signatures from an M-of-N authority. It has been built, frozen as an
audit candidate and rehearsed, but is **not deployed or activated**, and it has not yet been
externally audited.

- **qETH and qUSDC remain outside the V3 post-quantum scope.**
- **The Bitcoin bridge is separate** from the Base bridge architecture and from V3.

## Finality

Legacy finality is an informational indicator. Verified BFT finality
([FINALITY_V2](staking/finality.md)) is implemented and tested but **not activated**.

## Decentralization

Validator stake and bridge operation are currently concentrated in a small operator set. This is a
known limitation and part of the roadmap.
