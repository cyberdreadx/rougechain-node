# Proposer selection Release 2 — design record (no code yet)

Status: **design only**, 2026-09-27. Branch `design/proposer-selection-r2` (on the deployed node line,
`ca2a952` = votes + GAME_READY Phase 0 dormant). Nothing here is implemented; no activation height is
proposed. Scope set by the owner on 2026-09-23: skip certificates and a deterministic fallback, reusing the
FINALITY_V2 vote machinery, **no slashing** (slashing and equivocation penalties are Release 3).

## 0. The problem, and the finding that shapes this design

Release 1 (active since height 100) names one designated proposer per height: the eligible validator with
the most stake. It has no fallback, so **if the primary goes down, the chain stops** until it returns.
Release 1's record (§4) sketched the fix: the next validator may propose height `H` if it carries a *skip
certificate* — signatures from at least ⅔ of eligible stake saying the designated proposer missed `H`.

**That sketch cannot work at today's stake distribution.** Live validator set (2026-09-27, height 135):

| Validator | Stake | Share | Notes |
|---|---:|---:|---|
| `8ccf7878…` (primary) | 100,000 | 84.0 % | produces every block |
| `c97f59a2…` (node #2, hel1) | 10,000 | 8.4 % | online, not mining |
| `21e0ed0a…` (outside) | 9,000 | 7.6 % | slashed at 69 under the old rule; has never proposed |
| **Total** | **119,000** | | ⅔ quorum = **79,334** |

Any ⅔-of-stake certificate needs the primary's signature. When the primary is down — the only case a
fallback exists for — no certificate can form, so the fallback never fires. **Release 2's liveness gain is
exactly zero until no single validator holds ⅓ of stake or more.** The general condition: to keep producing
blocks while validator `X` is offline, the other online validators must hold more than ⅔ of stake, i.e. `X`
must hold less than ⅓ (and every other offline validator's stake counts against the margin too).

This is not a flaw in the certificate idea; it is what "safe without a clock or fork choice" costs. The two
ways around it are rejected:

* **Count validators instead of stake** (one validator, one vote): staking is permissionless and the
  consensus minimum stake is 1 quantum (`PROPOSER_SELECTION_DESIGN.md` §12), so an attacker registers many
  cheap validators and controls the quorum. Unsafe.
* **Timeout-based fallback without certificates** (node B proposes if it hasn't seen a block for T seconds):
  B's clock is not a fact node C can verify, two blocks at one height both look valid, and RougeChain has no
  fork choice or reorg — the split is permanent (this is exactly the height-60 fork of 2026-09-23). Unsafe.

So Release 2 has two halves: **(A) a protocol** that is safe with any stake distribution and live whenever
more than ⅔ of stake is online, and **(B) an operational prerequisite** — spread the stake — without which
(A) changes nothing in practice.

## 1. What already exists and is reused

The FINALITY_V2 crate (`core/finality`, currently only on the bridge branches, audit candidate
`a7bf119`; not on the deployed line) provides, tested:

* `vote_signing_message(chain, type, height, round, block_hash)` — domain-separated
  `ROUGECHAIN_FINALITY_VOTE_V2|chain=…|type=…|height=…|round=…|block=…`, signed with the validator's OWN
  ML-DSA-65 key (legacy votes signed by the node key while claiming the top validator's identity never verify).
* `ValidatorSetSnapshot` — the eligible set (stake > 0, not jailed) after block `H-1`; `quorum() =
  floor(2·total/3) + 1`, checked arithmetic.
* `verify_finality_proof` — recomputes voting stake from verified votes against the snapshot; the numbers a
  proof claims are never trusted; ≤ 1024 votes; duplicates and non-precommits rejected.
* `SigningJournal` — one immutable, fsynced file per `(chain, validator, type, height, round)` slot created
  by atomic hard-link: a validator can **never** sign two different hashes for one slot, across crashes,
  restarts and concurrent processes. Out of scope: the same key on two machines.
* The Release 1 code: `designated_proposer(H)`, the proposal journal (anti-equivocation for proposers), the
  frozen missed-block accounting.

What FINALITY_V2 deliberately does **not** have: `ONLY_ROUND = 0` ("RougeChain has no round-change / locking
protocol"). Release 2 adds rounds, so that constant is lifted — carefully, per §3.

## 2. The protocol (A)

### 2.1 Rounds and proposers

Height `H` proceeds in rounds `r = 0, 1, 2, …`. The proposer order for `H` is the eligible set after `H-1`
sorted by stake descending, ties by lowest raw public-key bytes (Release 1's ordering, extended to a list):

* round 0 → `order[0]` = today's designated proposer (Release 1 unchanged when everything is healthy);
* round `r` → `order[r mod n]`.

### 2.2 Two vote types per round, mutually exclusive

For each `(H, r)` an honest validator signs **at most one** of:

* **`precommit(H, r, block_hash)`** — "I received a valid block for round `r` from the round's proposer";
* **`skip(H, r)`** — "I saw no valid block for round `r` in time" (the message's `block` field is the
  parent hash, so a skip is bound to one fork).

Exclusivity is enforced by the signing journal (§3): both vote types for one `(H, r)` go through a single
journal slot, so a validator that has precommitted can never skip that round, and vice versa.

When a validator signs `skip` is a **local** decision (a timeout, §2.5); that is fine, because what other
nodes verify is the certificate, never the clock.

### 2.3 Certificates

* **Commit certificate** for `(H, r, hash)`: precommits from ≥ quorum stake. A block at `H` is *final* once
  it has one.
* **Skip certificate** for `(H, r)`: skips from ≥ quorum stake.

### 2.4 Validity rules (consensus, from activation)

A block at height `H`, round `r`, proposed by `P`:

1. `P == order[r mod n]` (round 0 is Release 1's rule).
2. If `r > 0`: the block carries skip certificates for every round `0 … r-1` (in practice one per missed
   round; rounds only advance on certificates).
3. The block carries the **commit certificate of its parent** (`H-1`). A block may only extend a *final*
   parent. This is the rule that makes the chain safe without a fork choice.
4. Everything Release 1 and earlier already require (signatures, tx rules, state root, uniqueness, V2 binding).

New header fields, added with the same `skip_serializing_if = None` pattern as `state_root`, so every
pre-activation header serializes to the identical bytes and keeps its hash and signature:

* `round: Option<u32>`
* `skip_certs: Option<Vec<SkipCertificate>>`
* `parent_commit: Option<CommitCertificate>`

Certificates reference voters by public key and carry signatures; the snapshot supplies the stakes.

### 2.5 Timing (local, never consensus)

RougeChain only produces a block when there are transactions (`mine_pending` returns `None` on an empty
mempool). So "the proposer is late" is measured from work existing, not from a fixed slot:

* A validator starts the round-0 timer for `H` when it holds a valid pending transaction and has the final
  block `H-1`.
* Default timeouts: round 0 = 20 s, then +10 s per round (tunable per node; they affect latency only, never
  safety).
* On timeout without a valid proposal, sign and gossip `skip(H, r)`; on seeing a skip certificate, move to
  `r+1` and restart the timer.

### 2.6 Transport

Votes travel over the existing HTTP peer layer: a new `POST /api/consensus/vote` (signature-checked,
rate-limited, accepted only from keys in the current snapshot) and gossip to configured validator peers.
Each ML-DSA-65 vote is about 3.4 KB; with 4–7 validators a commit certificate is 14–24 KB per block, which is
acceptable. The route must be reachable between validators and stays behind nginx for everyone else.

## 3. Why it is safe (and what must still be reviewed)

Assume validators controlling less than ⅓ of stake misbehave.

* **Two final blocks at one height are impossible.** Two commit certificates for different hashes in the
  same round would need two quorums, which overlap in more than ⅓ of stake, so an honest validator would have
  signed two precommits in one slot — the journal forbids it.
* **A round cannot be both committed and skipped.** A commit certificate and a skip certificate for the same
  `(H, r)` overlap in the same way; an honest validator would have signed both in one slot — forbidden.
* **A block from an abandoned round cannot come back.** Once a skip certificate for `(H, r)` exists, the
  quorum that signed it can no longer precommit round `r`, and the rest is below quorum — so the late round-`r`
  block can never become final, and rule 3 means nothing can extend it.
* **Across rounds:** could round 0 and round 1 both produce final blocks? Round 1 needs a skip certificate for
  round 0, which (previous point) means round 0 can never be committed. Only one round per height can finalize.

This is a deliberately small protocol (one vote per round instead of Tendermint's prevote + precommit with
locks). The argument above is why the single exclusive vote is enough *here*: a proposer never re-proposes
across rounds, and a round only ends by certificate. It still needs an **independent review** before code,
specifically: liveness under partial synchrony, and the gossip of late certificates.

What it does **not** give: protection when ⅓ or more of stake misbehaves (true of every BFT design);
protection against one key running on two machines (the journal can't see another disk); penalties for
signing twice (evidence only — penalties are Release 3).

## 4. Validator admission hardening (from Release 1 §12)

Release 1 found that anyone can become the designated proposer by staking more than the primary in one block,
and that the consensus minimum stake is 1 quantum. With rounds, a cheap validator could also force extra
rounds. Release 2 should activate together with:

* **Consensus minimum stake** of 10,000 XRGE (today only the API enforces it);
* **Stake activation delay**: new or increased stake counts for the proposer order and the quorum only after
  it has been staked for `E` blocks (proposal: 100). Unstake stays immediate for selection, as today.

## 5. The operational prerequisite (B): spread the stake

Protocol (A) is live only while the online validators hold more than ⅔ of stake. Recommended target, all
keys still the owner's, on independent infrastructure (different providers and regions):

| Validator | Stake | Host |
|---|---:|---|
| Primary | 25,000 | srv421059 (current) |
| Node #2 | 25,000 | Hetzner hel1 (current) |
| Node #3 | 25,000 | new, different provider |
| Node #4 | 25,000 | new, different provider |
| Outside validator | 9,000 | as today |

Total 109,000, quorum 72,667. **Any one owner node can be down, and the outside validator offline at the same
time, and blocks still get produced** (the remaining three hold 75,000). The primary's other 75,000 XRGE is
unstaked and moved to the new validator keys. This is **infrastructure resilience, not decentralization**:
one owner still controls the quorum, exactly like the founder 2-of-3 bridge authority. Real decentralization
needs independent operators holding more than ⅓ of stake; this design makes that possible without another
protocol change.

Until (B) is done, activating (A) is harmless but useless.

## 6. Rollout, in two steps

**Release 2a — finality (FINALITY_V2 on the node line).** Every block needs its parent's commit certificate
(rule 3); round 0 only; still the designated proposer. Result: real finality (today `finalized_height` is
informational), and it proves the vote transport, journal and certificate size on mainnet before any
proposer can change. Liveness is unchanged (a primary outage still halts).

**Release 2b — rounds and skip certificates.** Rules 1–2, timeouts, fallback proposers, admission hardening
(§4). Needs (B) in place to matter.

Each step gets its own activation height, the replay tests against the mainnet fixtures, and the same
coordinated rollout as the tx-integrity and proposer-selection upgrades. Bundle the GAME_READY Phase 0 rule and
the governance transaction types into 2a's activation height so the network goes through one upgrade.

## 7. Missed-block accounting

Skip certificates make a missed round an on-chain fact for the first time. Release 2 records it (per-validator
counter, carried in state) but **applies no penalty**; slashing on missed rounds and on double-signing
evidence is Release 3, as scoped.

## 8. Tests required before implementation is complete

* Unit: proposer order for rounds; certificate verification (quorum recomputed, wrong round, wrong parent,
  duplicate voter, non-snapshot voter, stake overflow); header serialization byte-identical before activation.
* Journal: precommit then skip in one slot refused, and the reverse; crash between journal write and signing.
* Consensus: block without parent commit certificate rejected; round-1 block without round-0 skip certificate
  rejected; late round-0 block after a skip certificate never finalizes; two nodes, one partitioned, converge.
* Liveness harness: 5 validators with §5 stakes, primary killed at random heights — chain continues;
  kill two owner nodes — chain halts safely (no split); heal — resumes.
* Replay: mainnet 0→tip unchanged below activation.

## 9. Decisions needed from the owner

1. Approve the two-step rollout (2a finality first, then 2b fallback).
2. Approve the stake target in §5: two more validator machines (provider choice), and moving 75,000 XRGE of
   the primary's stake to them.
3. Approve the admission hardening in §4 (10,000 XRGE consensus minimum; 100-block activation delay).
4. Independent review of §3 before implementation (recommended: the same auditor as the bridge, as an add-on).
