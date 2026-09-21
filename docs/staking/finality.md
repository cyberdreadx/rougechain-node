# Finality

RougeChain has two finality implementations. **Only the legacy one is active today.**

| | Status |
|---|---|
| Legacy finality | Active on mainnet |
| FINALITY_V2 | **BUILT / NOT ACTIVATED** (`FINALITY_V2_ACTIVATION_HEIGHT = None`) |

## Current (legacy) behavior

Blocks are proposed and signed with ML-DSA-65 by staked validators, and every node validates
blocks and state independently. The `finalized_height` value and the `/api/finality` and
`/api/votes` endpoints report a **node-local, informational** finality indicator. In the legacy
implementation, votes are not cryptographically verified as a stake-weighted quorum and are not
exchanged between validators.

Treat legacy "finalized" as a status display, **not** as a BFT guarantee. Nothing that moves
funds (block validity, the bridge, payouts) depends on it. The production bridge relies on its own
checks and confirmation depths instead.

## FINALITY_V2 (implemented and tested, not activated)

FINALITY_V2 replaces the legacy indicator with verifiable finality:

- **Verified votes.** Each vote is an ML-DSA-65 signature by the validator's own staked key over a
  domain-separated message (chain id, vote type, height, round, block hash).
- **Recomputed quorum.** A finality proof is only valid if the verifier recomputes the stake of the
  signers against the validator set for that height and it exceeds ⅔ of total stake. Votes for
  different block hashes never combine. Proofs are self-verifying, so a node can check a proof
  received from any peer.
- **Durable anti-equivocation journal.** Before signing, a validator durably records the vote. After
  a crash or restart it will refuse to sign a conflicting vote for the same height and round.
- **Validator-set provenance.** The validator set used for a height is derived by deterministic
  replay from a pinned base, not taken from a peer's claim.
- **Automatic vote propagation.** Votes are gossiped between validators with bounded, rate-limited
  intake, and finality proofs are distributed to non-validators.
- **Operator preflight.** `--finality-v2-preflight` checks that a node's key is the staked
  validator key before activation.

FINALITY_V2 is a coordinated validator upgrade, tested on multi-node devnets. It is required by
the [V3 XRGE bridge](../bridge/v3-xrge-bridge.md), which only signs withdrawal roots for blocks
with verified finality.

**It is not active.** No activation height has been chosen. Validator stake is also currently
concentrated in few keys, which limits what any BFT finality can guarantee until the validator set
broadens.
