# V3 Post-Quantum XRGE Bridge

> **Status: AUDIT CANDIDATE — NOT ACTIVATED.** `BridgeVaultV3` is not deployed to Base mainnet and
> does not hold any XRGE. The production XRGE bridge is the R1 bridge described in
> [XRGE Bridge](xrge-bridge.md). See [Status & Roadmap](../status.md).

## What V3 changes

Today, XRGE is released on Base by a classical (ECDSA) relayer key under a Safe multisig. V3
replaces that authorization with **ML-DSA-65 (FIPS 204) signatures verified on-chain on Base**:

1. RougeChain finalizes blocks with verified validator votes ([FINALITY_V2](../staking/finality.md)).
2. Finalized XRGE withdrawals are grouped into **epochs**. Each epoch has a deterministic Merkle
   root that any node can recompute from chain history.
3. An **M-of-N post-quantum root authority** signs the epoch root with ML-DSA-65. Each authority
   member independently **reconstructs the root from finalized history before signing** — a member
   never signs a root just because another machine supplied the hash.
4. `BridgeVaultV3` accepts the root only if an on-chain verifier confirms the threshold of
   ML-DSA-65 signatures. No ECDSA signature, pairing check or SNARK wrapper is in the
   authorization path.
5. A user (or anyone on their behalf) releases XRGE with a Merkle proof against an accepted root.
   Each withdrawal can be released once.

The intended property: an attacker who holds **every classical Base-side key** (Safe, guardian,
relayer, servers) but not the post-quantum authority threshold cannot get a forged root accepted,
move XRGE, or weaken the vault's controls.

## Verifier architecture (table-in-proof)

- The verifier contract is **immutable and stateless** (no owner, no upgrade path).
- Authority public keys live in immutable, content-addressed **authority tables** on Base. The
  proof names the table it uses; the vault stores only a commitment to the current authority set.
- Keys are held in canonical (sorted) order, and signer indexes must be strictly increasing, so a
  proof has one valid encoding.

## What has been done

- Vault, verifier and ML-DSA-65 core are frozen as **Audit Candidate 1** with pinned compilers,
  vendored dependencies and a byte-for-byte reproducible build.
- Test coverage includes NIST ACVP ML-DSA-65 vectors, cross-language differential tests
  (Rust ⇄ JavaScript ⇄ EVM), malformed-proof and attack suites, and end-to-end 2-of-3 and 3-of-5
  runs with the real Rust signer.
- The exact audit-candidate bytecode was deployed and exercised on a **local OP-stack devnet**
  (real `op-geth` / `op-node`), using throwaway keys and a throwaway ERC-20. Measured gas is about
  3.4M (2-of-3) to 5.0M (3-of-5) per root verification.

## What has NOT been done

- No external audit yet.
- No deployment to Base mainnet (or any public network).
- No production authority keys; the authority size (e.g. 2-of-3 vs 3-of-5) is not decided.
- No activation height chosen; no XRGE migrated.

## Out of scope

- **qETH and qUSDC** stay on `RougeBridge` with classical Base-side authorization.
- **Bitcoin / qBTC** is a separate bridge and is not part of V3.

## Known limitations (to be reviewed by auditors)

- The Keccak-f[1600] helper used by the verifier is third-party raw EVM bytecode with no
  high-level source; it is pinned by code hash and covered by behavioural tests only.
- The ML-DSA-65 core is third-party assembly close to the EVM contract size limit.
- RougeChain validator stake is currently concentrated, which limits what finality proves.
