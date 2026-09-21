# Status & Roadmap

This page is the single source of truth for **what is live** versus **what is built but not
activated**. If another page disagrees with this one, this page wins — please open an issue.

_Last reviewed: 2026-09-21._

> RougeChain is post-quantum-secured at the L1 level. The current production XRGE bridge remains
> on the hardened R1 architecture. A V3 XRGE bridge using ML-DSA-65 post-quantum authorization has
> been built and is undergoing final rehearsal before production activation.

## Live today

| Component | Status | Notes |
|---|---|---|
| RougeChain mainnet (`rougechain-mainnet-1`) | **LIVE** | ML-DSA-65 accounts, transactions and block signatures |
| R1 production bridge (Base mainnet ⇄ RougeChain) | **LIVE** | Hardened R1 architecture; see [Bridge Security Model](bridge/security-model.md) |
| XRGE bridge (`BridgeVaultV2`) | **TESTED / USABLE** | Deposit, withdrawal and payout paths tested end-to-end on mainnet |
| qETH bridge (`RougeBridge`) | **TESTED / USABLE** | Same |
| qUSDC bridge (`RougeBridge`) | **TESTED / USABLE** | Same |

The production XRGE bridge **still relies on classical (ECDSA / Safe multisig) authorization on the
Base side.** It is hardened, capped and monitored, but it is not post-quantum on Base.

## Built and tested — NOT activated

| Component | Status |
|---|---|
| V3 XRGE bridge (`BridgeVaultV3`) | **AUDIT CANDIDATE / NOT ACTIVATED** — not deployed to Base mainnet |
| ML-DSA-65 post-quantum root authorization (on-chain verifier) | Built, tested, frozen for audit — not deployed |
| Table-in-proof verifier architecture | Built, tested, frozen for audit — not deployed |
| Deterministic epoch / withdrawal-root pipeline | Built and tested — not running in production |
| Post-quantum root-authority signer | Built and tested — no production keys exist, no production root has been signed |
| Post-quantum authority rotation + deterministic authority schedule | Built and tested — not in use |
| Reproducible V3 contract build / audit candidate | Complete |
| OP-stack deployment rehearsal (local devnet, throwaway keys and token) | Substantially complete |
| FINALITY_V2 | **BUILT / NOT ACTIVATED** |

Both activation constants in the node — `FINALITY_V2_ACTIVATION_HEIGHT` and
`V3_BRIDGE_ACTIVATION_HEIGHT` — are **`None`**. No activation height has been chosen.

## Scope of V3

- V3 changes the **XRGE** withdrawal authorization path on Base to ML-DSA-65.
- **qETH and qUSDC are outside the V3 scope.** They stay on `RougeBridge` with classical Base-side
  authorization.
- **The Bitcoin bridge is a separate system** and is not part of V3. See [Bitcoin Bridge](bridge/btc-bridge.md).

## Roadmap

| Milestone | State |
|---|---|
| R1 bridge hardening | ✅ Complete (live) |
| V3 architecture | ✅ Complete |
| Reproducible audit candidate | ✅ Complete |
| OP-stack rehearsal | 🟡 Substantially complete |
| External review / audit | ⏳ Pending |
| Production deployment of V3 | ⏳ Pending |
| Activation (FINALITY_V2, then V3) | ⏳ Pending |

Activation will be announced in advance with the exact block heights. Until then, nothing on this
page in the "not activated" table protects user funds.
