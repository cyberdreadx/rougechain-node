# Authority Rotation (V3)

> **Status: BUILT AND TESTED — NOT IN USE.** This describes the V3 XRGE bridge, which is
> [not activated](../status.md). No production authority exists yet.

The V3 post-quantum root authority is an M-of-N set of ML-DSA-65 keys. Rotation replaces that set
without upgrading any contract.

## Design

- The vault and verifier are immutable. The vault stores a **commitment** to the current authority
  set (version, threshold and member key hashes).
- A new set is published as a new immutable **authority table** on Base, together with the
  pre-expanded key data the verifier needs.
- The **current** authority signs a rotation to the new commitment with ML-DSA-65. The vault
  enforces a **48-hour timelock** between proposing and executing a rotation.
- A rotation **manifest** binds the Base-side rotation to a RougeChain-side **authority schedule**
  record, so every node derives the same "which authority signs which epoch" answer from chain
  history.

## Safety checks before anything is signed

- The rotation signer **reconstructs** the new set commitment from the actual keys and the
  on-chain table contents before signing; it does not sign a supplied hash.
- Every member of the new set must take part in the ceremony, and at least two independent
  checkers must confirm the on-chain tables match the intended keys.
- A durable signing journal prevents signing two different rotations for the same version.
- Root signing for an epoch is refused until the matching schedule record and Base-side state are
  both observed (publication gate).

## Known hazard

The vault cannot check that a new commitment is well-formed. A rotation to a wrong commitment
would leave the new authority unable to sign (the bridge fails closed — funds cannot move, but
they are not exposed). The checks above exist to prevent this, and the design is flagged for
external review.

## Rehearsal status

Rotation has been rehearsed in tests and proposed on a local OP-stack devnet. Execution after the
real 48-hour timelock is the remaining rehearsal step.
