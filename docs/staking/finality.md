# Finality

RougeChain uses verified BFT finality (FINALITY_V2) **since block 150**.

| | Status |
|---|---|
| FINALITY_V2 (Release 2a) | **LIVE** (`FINALITY_V2_ACTIVATION_HEIGHT = Some(150)`) |
| Legacy finality indicator | Blocks 0–149 only |

**What mainnet enforces from block 151:** every block header carries `parent_commit`, a finality
certificate for its parent block — ML-DSA-65 precommits from validators holding more than two thirds
of total stake, checked against the validator set for that height. A node rejects a block without a
valid certificate, and a producer waits for its parent's certificate before building on it. Check any
height with `GET /api/finality/:height`.

**What Release 2a does not include:** a fallback proposer, skip certificates, rotating proposers and
slashing on evidence. Those were planned as "Release 2b" and "Release 3"; on 2026-10-06 they were
folded into a broader consensus redesign (Tendermint-style rounds, rotating stake-weighted proposers,
a capped active set, a consensus-enforced minimum stake, evidence-based slashing) that is **decided
but not built** — see [Status & Roadmap](../status.md). If the designated proposer is offline, no
block is produced until it returns. Three validators are staked and the largest holds more than
99.9 % of the stake, so the ⅔ quorum is currently met by that validator alone. No slashing of any
kind is active; the legacy `slash` transaction is rejected since block 245.

## Legacy behavior (blocks 0–149)

Blocks are proposed and signed with ML-DSA-65 by staked validators, and every node validates
blocks and state independently. The `finalized_height` value and the `/api/finality` and
`/api/votes` endpoints report a **node-local, informational** finality indicator. In the legacy
implementation, votes are not cryptographically verified as a stake-weighted quorum and are not
exchanged between validators.

Treat legacy "finalized" as a status display, **not** as a BFT guarantee. Nothing that moves
funds (block validity, the bridge, payouts) depends on it. The production bridge relies on its own
checks and confirmation depths instead.

## How FINALITY_V2 works

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

FINALITY_V2 is a coordinated validator upgrade, tested on multi-node devnets before activation.
It went live at block 150 (2026-09-28). It is a prerequisite of the
[V3 XRGE bridge](../bridge/v3-xrge-bridge.md), which only signs withdrawal roots for finalized blocks;
V3 itself is not activated.
