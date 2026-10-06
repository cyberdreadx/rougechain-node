# Consensus and incentive redesign ("Consensus R2") — design record

> **Status: design only, 2026-10-06. Branch `design/consensus-r2`, written against commit `66d4455`.**
> Nothing here is implemented, scheduled or approved. No code, key, stake or configuration was changed, and
> nothing was built or run. Activation heights are the owner's decision (`core/daemon/src/upgrades.rs:1-16`).
>
> **What was read.** `core/daemon/src/node.rs` (the parts cited), `core/finality/src/{lib,journal,validator_replay}.rs`
> (complete), `core/daemon/src/upgrades.rs` (complete), `core/daemon/src/finality_net.rs:150-219`,
> `core/daemon/src/peer.rs:200-300`, `core/types/src/lib.rs:200-330`, `core/daemon/src/units.rs:58-83`,
> `core/daemon/PROPOSER_SELECTION_DESIGN.md` and `PROPOSER_SELECTION_RELEASE2_DESIGN.md` (complete), and, in the
> `qv-trustless` worktree, `docs/VALIDATOR_DECENTRALIZATION_PLAN.md` (complete, "the decentralization plan") and
> `docs/LC1_IMPLEMENTATION_SPEC.md` §1, §2, §4, §8, §9, §12, §15–§17, §26 ("LC1").
> **Not read:** `core/crypto`, the rest of `core/storage`, the rest of `peer.rs` and `main.rs`, live chain state.
> Statements about the live validator set are taken from the documents above or from the owner's brief and are
> marked as such. Statements about external protocols come from their published papers and specifications as
> the author recalls them; each one the implementation depends on is marked **[confirm]** and must be checked
> against the specification text before code is written. Numbers marked **[est.]** are estimates.
>
> **Amended 2026-10-06 by Amendment 1** (branch `design/consensus-r2-amend-1`, from `research/consensus0`),
> after stage 1 of the CONSENSUS-0 simulator. Still design only: the simulator is a standalone research crate,
> and no node code, key, stake or configuration was changed. The list of changes follows the table of terms;
> the questions it leaves for the owner are in §12. Statements of the first paragraph ("nothing was built or
> run") describe the first version.

Terms, defined once:

| Term | Meaning |
|---|---|
| `T(h)`, `E(h)` | Total eligible stake and the eligible validator set for height `h`: validators with `stake > 0` that are not jailed, in the state after block `h−1` |
| quorum `q` | `⌊2T/3⌋ + 1` (`core/finality/src/lib.rs:50-55`): the least stake that is more than two thirds of `T` |
| one-third bound `t1` | `⌊T/3⌋ + 1`: the least stake that is more than one third of `T` |
| certificate | A set of signatures over one block from validators whose stake reaches `q` |
| round | One attempt, by one proposer, to get a block committed at a height |
| equivocation | Two different signed messages by one key for the same slot (same chain, height, round and type) |
| quanta | The ledger unit: 1 XRGE = 10^9 quanta (`core/daemon/src/units.rs:23`). Validator stake is stored in whole XRGE (`node.rs:7022-7023`) |
| F, O | The founding operator and today's outside validator, as in the decentralization plan |

---

## Amendment 1 (2026-10-06) — after CONSENSUS-0 stage 1

CONSENSUS-0 (§9) is the simulator this design asked for before any node code. Its first stage was built and
run on branch `research/consensus0`; its report is `research/consensus0/RESULTS.md`. To make the state
machine complete it had to decide 32 points the first version left open or ambiguous (rules **R1–R31** and
**R1b**), and it found 16 defects or under-specifications in the design (**F1–F16**), three of them serious.
This amendment folds all of that into the text. It is documentation only: no code, key, stake, service or
configuration was touched, and nothing was built or run to write it.

**Conventions used by the amendment.**

| Mark | Meaning |
|---|---|
| MUST, MUST NOT | Normative: an implementation that does otherwise is not an implementation of this design |
| "Am.1: R*n*" / "Am.1: F*n*" | The passage was added or changed by this amendment because of that rule or defect of `RESULTS.md` |
| `[A1:n]` | Line *n* of Algorithm 1 of arXiv:1807.04938, as tagged in the simulator's state machine. "A1" here is the algorithm, not this amendment |
| **[unverified against the paper's text]** | Written from memory of the paper; to be checked by the independent review (§9.1) |
| **[confirm]**, **[est.]** | As in the first version. No **[confirm]** was removed: none of them has been verified |

**The three serious defects, in one sentence each.**

| Defect | What was wrong | Where it is corrected |
|---|---|---|
| F1 | Keeping only a validator's first vote in a slot lets one equivocator below one third stop the chain for good | §3.5.1 (new), §4.2 |
| F2 | The "three distinct proposers" condition for jailing counted the proposers of the whole window, so a single proposer could still jail a rival | §4.4 rule 2, property P9 in §9 |
| F3 | The claim that a fork always yields double-sign evidence is false for forks made across rounds | §4.1 and §4.1.1 (new), §3.7, §7, property P3 in §9; open option in §12 |

**Every change, by section.**

| Section | Change | Cause |
|---|---|---|
| Status note, this section | Added | — |
| §2.3 | Accountability row: a cross-round fork leaves no evidence | F3 |
| §2.4 | Table of the further knowing differences from Algorithm 1; per-value vote counting stated as the published model, not a deviation | R1, R1b, R2, R6, R7, R8, R10 |
| §3.1 | What is persisted and what is recovered; invariants I1–I4 | R30 |
| §3.3 | Which total the entry penalty uses; priorities across set changes; one step per height and when; a failed round costs two timeouts, not one; measured fairness | R3, R4, R5, F5, F14 |
| §3.4 | Start rule 3 worded exactly; the proposer runs the propose timeout; commit wait rules; pending work must be shared and what a stranded lone validator does; measured certificate bytes per day | R6, R7, R11, F4 |
| §3.5 | Rule table rewritten with Algorithm 1 line tags; commit from any round; T2 gates prevotes only; round skip counts senders and takes the highest round; invalid proposal; header time; "valid proposal" split into four parts with the consequence of each; drift value is a placeholder; **time-to-finality estimates replaced by the measured table** | R1, R1b, R2, R6, R8, R9, R29, R30, F5, F16 |
| §3.5.1 (new) | Votes are tallied per value; a conflicting second vote is evidence and still counts; why this restores liveness and does not weaken safety | R10, F1 |
| §3.6 | Late precommits for the committed block are accepted; measured completeness of certificates against the commit wait, and what follows for slow validators | R7, F9 |
| §3.7 | Persist-before-send order; restart rules; two machines with one key are slashable only for same-slot conflicts | R30, F3 |
| §3.8 | A certified block commits in any step, T2 not applied; set-aside votes are re-offered; storage bounds on rounds and blocks are required | R29, R1b, R10, F11, F12 |
| §4.1 | "Amnesia" row says plainly that no evidence exists and such a fork is unpunished; duplicate proposals and storage | F3, F12 |
| §4.1.1 (new) | What is provable after a fork (same-round) and what is not (cross-round); the justification-round option, its limits and its cost | F3 |
| §4.2 | Evidence window inclusive; V2 evidence is round 0 only; new rule 5 (no evidence against a tombstoned key) replacing simulator rule R28; the receiver counts the conflicting vote; evidence is gossiped; evidence before unbonding release; an open point on the floor rule | R14, R28, F10, R10, F1, R11 |
| §4.3 | Remainder of a partly slashed bond; pending stake of a tombstoned key | R15, R16, F15 |
| §4.4 | **Rule 2 rewritten**; window contents; how rule 3 is evaluated; return from jail; table of what the decided values mean in practice | R19, F2, R20, R21, R22, F6, F7, F9, F15 |
| §4.5 | Entries slashable up to and including their release block | R14 |
| §5.1 | Residual rule for `unearned`; `fee_tx_count`; who is paid; first block; V2 certificate at the boundary; conservation as checked | R26, R27 |
| §5.2 | Omission was observed, as slowness rather than hostility | F9 |
| §6.2 | Weight from quanta; weight 0 is not active | R13 |
| §6.4 | Decided minimum shown; the cap acts at epoch boundaries only; epoch and maturity arithmetic; admission tally; grace and its consequence for today's set; **the active set can never be empty** | R17, R18, R24, R25, F8, F13, F15 |
| §6.6 (new) | The order of effects inside a block | R12 |
| §7 | Rows for crash faults, stake above one third, partitions and one key on two machines restated; table of what today's stake does under the new rules; pointer to the admission tally | F3, F5, F1, R17 |
| §8.1, §8.2 | Stage C caveats; boundary rules for the V2 certificate and pre-fork evidence | F7, F3, R21, R26 |
| §9 | Status after stage 1; P3 and P9 restated, P4 and P7 made precise; §9.1 status of each exit criterion; §9.2 measured tables; §9.3 where the simulator is behind this text | F2, F3, R23, R27, R31, F14 |
| §10 | "See Amendment 1" added to rows 2, 3, 4, 5, 6, 8 and 11. **No outcome changed** | F2, F3, F5–F8, F13, R14, R17, R18 |
| §12 (new) | Owner decisions needed after Amendment 1 | F3, F5–F9, F11–F13 |

**Where each rule landed.**

| Rule | Section | Rule | Section | Rule | Section |
|---|---|---|---|---|---|
| R1 | §3.5 | R12 | §6.6 | R23 | §9 (P4) |
| R1b | §3.5, §3.8 | R13 | §6.2 | R24 | §6.4 |
| R2 | §3.5 | R14 | §4.2, §4.5 | R25 | §6.4 |
| R3, R4, R5 | §3.3 | R15, R16 | §4.3 | R26, R27 | §5.1, §9 (P7) |
| R6 | §3.4, §3.5 | R17, R18 | §6.4 | R28 | §4.2 rule 5 (superseded, see below) |
| R7 | §3.4 | R19, R20, R21 | §4.4 | R29 | §3.5, §3.8 |
| R8, R9 | §3.5 | R22 | §4.4, §6.4 | R30 | §3.1, §3.5, §3.7 |
| R10 | §3.5.1 | | | R31 | §9 (P3), §4.1.1 |
| R11 | §3.4, §4.2 | | | | |

**What happened to each defect.**

| Defect | Outcome |
|---|---|
| F1, F2 | Corrected in the text |
| F3 | Claims corrected; the remedy is an option, not adopted (§4.1.1, §12 item 4) |
| F4 | Assumption written down; behaviour of a stranded validator specified (§3.4) |
| F5 | Estimates replaced by measurements (§3.5); a possible speed-up is left to the owner (§12 item 6) |
| F6, F7, F8 | Consequences stated where the rules are (§4.4, §6.4); put to the owner (§12 items 1–3) |
| F9 | Stated with the measured table (§3.6, §5.2); the remedy is left to the owner (§12 item 5) |
| F10 | Corrected: such evidence is inadmissible (§4.2 rule 5) |
| F11, F12 | Requirement stated (§3.8); the limits are left open (§12 item 8) |
| F13 | Rule stated (§6.4); one sub-case left to the owner (§12 item 7) |
| F14 | Recorded as measured, not proved (§3.3, §9.1) |
| F15 | The rules the simulator had to choose are now normative (R15–R18, R20, R21) |
| F16 | Recorded as a placeholder that keeps its **[confirm]** (§3.5) |

**Four rules in this amendment go beyond what the simulator implements** and therefore have no test evidence
yet (§9.3): evidence against a tombstoned key is inadmissible (the simulator implements R28, which this
supersedes); the active set can never be empty; a validator re-offers its pending work periodically; and
the storage bounds of §3.8. The first three were suggested by `RESULTS.md` (F10, F13, F4) and are written
here as rules; they MUST be added to the simulator before the exit criteria of §9 are judged.

---

## 1. Current state

### 1.1 Rules as the code applies them

| Area | What the code does | Source |
|---|---|---|
| Proposer | For height `H` the only valid proposer is the validator with the greatest stake among those with `stake > 0` and `jailed_until ≤ H`, read from the validator store after `H−1`; ties go to the lowest raw key bytes. There is no rotation and no fallback | `node.rs:3954-3983`; import check `1575-1577`; producer check `3663-3675`; active from height 100 (`node.rs:205`, `upgrades.rs:69`) |
| When a block is produced | A loop calls `mine_pending` when a transaction arrives or every `block_time_ms` (default 400). It returns without a block if the mempool is empty, or empty after filtering. **There are no empty blocks and no heartbeat.** Height does not advance while there are no transactions | `main.rs:99, 773-776, 866-870`; `node.rs:3677-3680, 3712-3714` |
| Producer sequence | Re-use a journaled proposal for this slot if one exists; wait until the tip has a persisted certificate; check designation; drain the mempool; apply; compute the state root; sign; journal the proposal; **append the block to the chain**; then vote. The block is on the producer's chain before anyone has voted | `node.rs:3646-3662, 3765-3789, 3855` |
| Header time | Set from the producer's local clock. **Import never reads it.** Contract and pool execution do read it | `node.rs:3719`; uses at `5001, 5368` |
| Import checks | Height is tip + 1; `prev_hash` is the tip; proposer signature and block hash; proposer is staked; every transaction signature; transaction uniqueness and signed-payload binding; per-type rules including MONETARY_INTEGRITY; designated proposer; parent certificate; then speculative apply, state-root equality, validator effects and append, with a full rollback on any failure | `node.rs:1455-1660` |
| Not checked on import | Header `time`; header `chain_id` (only the peer-sync wrapper compares it, `peer.rs:211-215`); any round number (the header has none, `core/types/src/lib.rs:205-230`). I found no block-size or transaction-count limit in `import_block` |  |
| Vote message | `ROUGECHAIN_FINALITY_VOTE_V2\|chain=…\|type=…\|height=…\|round=…\|block=…`, signed with the voter's own ML-DSA-65 key. Only round 0 is accepted | `core/finality/src/lib.rs:20-35, 85` |
| What is signed per block | After a node imports or produces a block it signs **both** a `prevote` and a `precommit` for it, round 0, through the signing journal. Only precommits are counted; the prevote is signed, gossiped and never used | `node.rs:3349-3368`; `lib.rs:112, 143` |
| When a node votes | Unconditionally, after it has applied and appended the block. There is no timeout, no vote for "nothing" and no way to withdraw a block once appended | `node.rs:1657, 1692` |
| Quorum and certificate | A proof is built the moment recorded precommits reach `q`; votes for a height that already has a proof are ignored and the stored votes are dropped. The next producer embeds that stored proof. **A certificate therefore holds the votes that reached quorum first, not every signer** | `node.rs:3108, 3140, 3369-3377, 3736`; `lib.rs:116-125` |
| Certificate checks | Height and hash match the parent; at most 1,024 votes and no more votes than validators; each vote is a round-0 precommit by an eligible key with a valid signature; no duplicate voter; recomputed stake `≥ q`; the totals written in the proof must equal the recomputed ones | `lib.rs:132-153`; `node.rs:3180-3201` |
| Certificate encoding | The proof is a JSON object inside the JSON header, with keys and signatures as hex text. LC1 §12.2 measured about 10.9 kB per vote (4,242 B header without a certificate, 15,154 B with one vote). Raw sizes are 1,952 B per key and 3,309 B per signature (LC1 §0; the 3,904-character key at `upgrades.rs:164` agrees) | `core/types/src/lib.rs:221-229, 242-270, 311-313` |
| Validator set for a height | Snapshot of `stake > 0 ∧ jailed_until ≤ H−1` recorded when the tip is `H−1`, trusted only if it equals a replay of accepted history. Note the off-by-one against the proposer rule (`≤ H`) | `node.rs:3081-3090, 3283-3288, 7396-7409`; `validator_replay.rs:114-117` |
| Double-sign protection | Local only: one immutable fsynced file per `(chain, key, vote type, height, round)`; a proposal journal per `(height, parent)`. Both bind one data directory. The same key on two machines is not covered | `journal.rs:1-20, 54-58, 103-127`; `node.rs:3986-4011` |
| Vote transport | HTTP: a background task posts undelivered votes to each peer once per second and pulls proofs; blocks are pushed at production and pulled by a sync loop. No fork choice: a node never replaces its chain | `finality_net.rs:160-194, 212-218`; `peer.rs:201-237, 278-300` |
| Staking | `stake` debits the balance and adds whole XRGE to the sender's validator record; the sender's key is the validator key and the node's signing key. **Consensus requires only `amount > 0`**; the 10,000 XRGE minimum is in the API handlers only. Stake counts from the next height | `node.rs:7006-7025, 7431-7436`; minimum at `main.rs:6605-6609`, `node.rs:2997-3000` |
| Unstaking | Voting stake drops at once; the amount enters a queue and is credited when a block at `height + 500` or later is applied. Because blocks need transactions, 500 blocks has no fixed duration (the code says so). Queue amounts are `f64`. Queued funds are untouched by any slash | `node.rs:45-47, 788-794, 7026-7062, 7483-7501` |
| Rewards | Only when a block collected fees: burn `min(fees, base_fee × tx_count / 2)`; raise the remainder to 0.1 XRGE from `__staking_rewards__` if lower; pay 20 % to the proposer, 70 % to **every eligible validator pro rata to stake**, and the rest to `__treasury__`. No check that a validator voted or was online | `node.rs:5481-5491, 6845-6900` |
| Base fee | Dynamic: starts at 0.1 XRGE, moves up to 12.5 % per block toward a 10-transaction target, floor 0.001 XRGE | `node.rs:57-60, 4183-4199` |
| Downtime | Legacy rule (count a miss for every non-proposer, slash 10 % and jail 20 blocks at 50) is frozen from height 100. Nothing replaces it: no validator is ever jailed or removed for being offline | `node.rs:43-51, 7504-7518` |
| `slash` transaction | The apply path cuts 10 % of the target's stake (at least 1) and jails it 20 blocks. I found **no evidence or authorisation check** in that path. MONETARY_INTEGRITY makes any block carrying a `slash` invalid from height 245 and the mempool refuses it at every height. The cut stake is credited nowhere | `node.rs:7445, 7565-7578`; `390-396, 437-445` |
| "Delegation" types | `delegate` / `undelegate` are suspended by MONETARY_INTEGRITY. In the code they are **governance voting-power delegation** (`governance_store.set_delegation`), not stake delegation, and the comment at `421-425` says their apply function has had no call site since F=49 | `node.rs:426-433, 6648-6668` |
| Replay mirror | `validator_replay.rs` re-implements the validator state machine so snapshots can be checked. Every rule change below must be made in both places (a mismatch once threatened to stop finality: Release 2 design §10) | `validator_replay.rs:8-20, 64-112` |
| Floating point in consensus today | Transaction `fee` is `f64` and is added to amounts in `f64` before conversion (`node.rs:7007-7018`); unbonding amounts are `f64` (`788-794`). New rules in this design are integer-only; these two are existing debts (LC1 §14–§15.5 lists the conversions) |  |

**Live set.** The owner's brief gives stakes of roughly 100,090,000 / 10,000 / 9,000 XRGE, with one operator
running the first two. The repository documents give 100,000 / 10,000 / 9,000 (Release 2 design §0, 2026-09-27;
decentralization plan §3.2). I did not query the chain. Either way one key holds more than two thirds, so its
own precommit completes every certificate and every conclusion below is the same.

### 1.2 Failure scenarios today

| # | Scenario | What happens | Why |
|---|---|---|---|
| 1 | The designated proposer is offline | No block is produced. Transactions queue (mempool cap 2,000, `node.rs:52`); unbonding does not mature; nothing recovers automatically | Other validators refuse to seal (`node.rs:3663-3675`); there is no fallback (Release 1 design §4) |
| 2 | The proposer withholds transactions | Indefinite censorship. It is the only proposer at every height and no rule forces inclusion. It also chooses `time` freely | `node.rs:3967-3973, 3719` |
| 3 | A validator signs two blocks at one height | Each block is valid alone. A node keeps the first and rejects the second by height; nodes that saw different blocks split for good. A key with `≥ q` can certify both. Conflicting votes are rejected and forgotten; there is no evidence format and no penalty | `node.rs:1455`; `lib.rs:89, 95-97`; `peer.rs:201-207` |
| 4 | A validator is registered and never online | It stays in `T`, is paid its pro-rata share of the 70 % pool in every fee-paying block, and is never jailed. If the offline stake exceeds `T − q`, the producer appends one block and then waits for a certificate that cannot form: the chain halts | `node.rs:6883-6891, 7504-7518, 3651-3661` |
| 5 | Stake is bought cheaply | (a) More than the top stake: the buyer is the sole proposer from the next height (scenarios 1 and 2 at will). (b) `X ≥ ⌈T/2⌉` added: the buyer holds more than a third and halts finality by not voting. (c) `X ≥ 2T + 1` added: the buyer finalizes alone. There is no activation delay, no consensus minimum, no cap and no admission step. Unstaking afterwards costs only the 500-block wait | `node.rs:7008, 7396-7409`; thresholds as in the decentralization plan §5.3 |
| 6 | A block is appended but never certified (slow or partitioned voters) | The producer's and importers' chains hold a tip that is not final and cannot be replaced; production waits | `node.rs:3651-3661`; no un-append path exists |

---

## 2. Choice of protocol

### 2.1 Candidates

* **(T) Tendermint.** Three steps per round — propose, prevote, precommit — with a lock: a validator that
  precommits a block will not prevote a different one in a later round unless it sees more than two thirds
  of prevotes for it from a later round. Rounds end by timeout. Specified in Buchman, Kwon, Milosevic, *The
  latest gossip on BFT consensus* (arXiv:1807.04938), Algorithm 1; implemented and further specified by
  CometBFT (`spec/consensus` in its repository) **[confirm]**.
* **(H) HotStuff family** (Yin et al., PODC 2019; two-chain variants such as Jolteon / DiemBFT v4). One vote
  per view, sent to the next leader, who packs a quorum of votes into a quorum certificate (QC) carried by
  its proposal. A block is final when a chain of two (or three) QCs in consecutive views stands on it. View
  changes use timeout certificates.
* **(K) Keep the single-vote scheme and add the Release 2b fallback** (precommit or skip per round, skip
  certificates; `PROPOSER_SELECTION_RELEASE2_DESIGN.md` §2).

### 2.2 Bytes and message counts with ML-DSA-65

Assumptions: binary encoding; a vote on the wire is type 1 + height 8 + round 4 + block hash 32 + validator
index 2 + signature 3,309 = **3,356 B**; every validator votes; one round; votes are sent directly to every
other validator. The on-chain certificate layout is the one in §3.6 (47 B + bitmap + 3,309 B per signer).

| Validators `n` | 4 | 10 | 30 |
|---|---:|---:|---:|
| Signers needed for quorum at equal stakes | 3 | 7 | 21 |
| **Certificate, all signers (§3.6)** | **13,284 B** | **33,139 B** | **99,321 B** |
| Certificate, minimum quorum only | 9,975 B | 23,212 B | 69,540 B |
| Same certificate in LC1 `CERT_V2` layout (keys included, 43 + 5,261 per vote) | 21,087 B | 52,653 B | 157,873 B |
| Same certificate in today's JSON-hex encoding (≈ 10.9 kB per vote, LC1 §12.2) **[est.]** | ≈ 43.6 kB | ≈ 109 kB | ≈ 327 kB |
| Distinct signatures per block: T / H / K | 9 / 5 / 5 | 21 / 11 / 11 | 61 / 31 / 31 |
| Distinct vote + proposal-signature bytes per block: T | 30,157 | 70,429 | 204,669 |
| … H and K | 16,733 | 36,869 | 103,989 |
| Vote deliveries per block, network-wide: T | 24 | 180 | 1,740 |
| … K (one vote type, all-to-all) | 12 | 90 | 870 |
| … H (votes go to one leader) | 4 | 10 | 30 |
| Vote bytes sent network-wide per block: T | 80.5 kB | 604 kB | 5.84 MB |
| Today, for comparison: 2 JSON votes per validator (§1.1) **[est.]** | ≈ 86 kB distinct | ≈ 214 kB | ≈ 642 kB |

Reading: Tendermint costs twice the votes of the other two. At 30 validators that is about 195 kB sent and
received per validator per block, and the chain produces tens of blocks a day (§5.4), so the cost is
negligible in absolute terms. In binary form Tendermint's distinct bytes per block are **about a third of
what today's single-round scheme already sends**, because today's votes are hex-in-JSON and include an unused
prevote. What is stored forever is the certificate, and that is the same for all three once every signer is
included. HotStuff's linear message count depends on aggregating signatures; without aggregation its QC is
the same list of ML-DSA signatures, so its advantage here is only the factor of two in votes.

### 2.3 Comparison

| Criterion | (T) Tendermint | (H) HotStuff family | (K) Current + Release 2b |
|---|---|---|---|
| Safety argument | Published proof, model-checked specifications, years of production use with stake-weighted votes | Published proofs; several variants with different commit rules; the mechanism that advances views (the pacemaker) is specified separately and varies between systems | None published. The decentralization plan §4.2 found that any single proposer, or a slow network, can leave a round permanently stuck (some validators precommitted, the rest skipped, neither side reaches `q`). Fixing it means adding nil votes and locks, which is Tendermint under another name |
| Fit with existing certificates | Direct. A commit is "precommits from `≥ q` for one `(height, round, hash)`", which is today's `FinalityProof` plus a round number. The parent-certificate rule (`node.rs:3180-3201`) stays | Partial. A QC in the header fits, but a block is final only after one or two further blocks. With blocks produced on demand, the last transaction before a quiet period would not be final until filler blocks were produced | Direct |
| Messages and bytes | 2 votes per validator per round | 1 vote; QC without aggregation is as large as a commit | 1 vote (today's code already sends 2) |
| Stake-weighted proposer rotation | Specified (proposer priority) | Not part of the protocol; must be added | Not specified; Release 2b keeps "largest stake first" |
| Implementation risk here | High in one place: the node must vote on a block before appending it (today it appends first, §1.1). The journal already has prevote and precommit slots per round (`journal.rs:54-58`); the vote book, snapshot and certificate verifier carry over | Higher: the same propose/commit separation, plus a pacemaker, timeout certificates, and a chain-based commit rule that the storage and the "final parent" rule do not have | Looks lowest, but any fallback needs the same propose/commit separation (a block imported in a skipped round must be discarded, and no such path exists), and the protocol itself would be new |
| Light clients (LC1) | One certificate proves one header. LC1's statement R4 changes from "round-0 precommits" to "precommits of one round, the round carried in the certificate" | A client must check a chain of two or three QCs and the view numbers between them | As Tendermint, plus skip certificates for every skipped round |
| Accountability | Conflicting prevotes or precommits in one `(height, round)` are self-contained evidence. Breaking a lock across rounds is not provable from two signatures, so a fork made that way leaves no evidence (§4.1.1; Am.1: F3) | Similar | Precommit + skip in one round |

### 2.4 Decision

**Adopt Tendermint (T).** The two strongest reasons: (1) it is the only candidate whose rules for exactly this
situation — rounds, locks, stake-weighted quorums, weighted proposer rotation, evidence, light clients — are
published, proved and long-exercised, and option K would have to grow into it to fix its known stuck-round
defect; (2) its commit is the certificate this chain already produces, verifies and embeds, with one added
field, so finality stays "one certificate per block" for nodes and for LC1, which HotStuff cannot offer on a
chain that produces blocks only on demand.

**Specifications the implementation follows:** Algorithm 1 of arXiv:1807.04938 for the round state machine,
line by line; CometBFT `spec/consensus/proposer-selection.md` for proposer priority; CometBFT
`spec/consensus/evidence.md` for duplicate-vote evidence; CometBFT's proposer-based timestamps for header
time **[confirm all four paths and texts]**.

**Deliberate deviations**, each to be tested in CONSENSUS-0 (§9):

| # | Deviation | Reason |
|---|---|---|
| D1 | ML-DSA-65 signatures; no aggregation; text signed bytes in the existing style (§3.2) | Hard constraint |
| D2 | A height starts on demand, not continuously (§3.4) | Blocks exist only when there is work or a heartbeat is due |
| D3 | Weights are whole-XRGE stake in `u128`; thresholds are `q` and `t1` as defined above; priorities are `i128` with checked arithmetic and floor division | Integer-only rule; the reference uses 64-bit voting power |
| D4 | No vote timestamps. Header time is chosen by the proposer and bounded as in LC1 §15.1 | Saves 8 B per vote; LC1 already defines the time rules |
| D5 | Set changes take effect as defined in §6.4 (additions at an epoch boundary, removals at the next height), not after a fixed two-height delay | Matches today's "next height" behaviour and LC1 §9; additions are delayed for the reasons in §7 |
| D6 | The commit certificate must list every precommit the next proposer holds, and rewards are paid from it (§3.6, §5) | Owner goal 3 |
| D7 | Round timeouts grow linearly and stop growing at a cap (§3.5) | An operator-visible bound; the proof needs timeouts to exceed the real network delay eventually, which a cap of minutes satisfies in practice |

**Further places where the rules knowingly differ from Algorithm 1** (Am.1). CONSENSUS-0 had to decide these
to make the state machine complete; each is now normative text in the section named and each MUST be covered
by the independent review (§9). They are consequences of D2 and D6 or of the paper being silent, not new
design goals.

| Rule | Difference from the published algorithm **[unverified against the paper's text]** | Where |
|---|---|---|
| R1 | A block commits on precommits `≥ q` of some round plus the block from a proposal of **any** round of the height; the paper asks for the proposal of the commit round | §3.5 |
| R1b | The header-time bound T2 gates the prevote only; it never prevents locking on or committing a block that reached a quorum | §3.5 |
| R2 | When several later rounds each hold senders of stake `≥ t1`, the **highest** is entered | §3.5 |
| R6 | The proposer runs the propose timeout too (the paper starts it only for non-proposers), because under D2 a proposer may have nothing to propose | §3.5 |
| R7 | A commit wait delays a validator's own reasons to start the next height (D6) | §3.4 |
| R8 | An invalid block from the scheduled proposer gets an immediate nil prevote | §3.5 |

Counting votes per value (R10, §3.5.1) is **not** a deviation: it is the paper's message-log model as the
author recalls it **[unverified against the paper's text]**; the earlier text of this document had departed
from it by implying "keep a validator's first vote".

---

## 3. The protocol as it would run here

### 3.1 Per-validator state

`height`, `round`, `step ∈ {propose, prevote, precommit}`, `locked_round` and `locked_block` (initially none),
`valid_round` and `valid_block` (initially none). `height`, `round`, the lock and the valid pair are persisted
(§3.7). `step` is not stored: after a restart it is recovered from the signing journal (R30, §3.7). Timers are
never persisted.

The state machine MUST keep these invariants at every step (they are checked by the CONSENSUS-0 tests and
explorer; Am.1):

| # | Invariant |
|---|---|
| I1 | At most one value is ever signed per `(type, height, round)`; the journal slot decides, also after a restart from persisted state |
| I2 | `locked_round ≤ round`, `valid_round ≤ round`, `locked_round ≤ valid_round` |
| I3 | A non-nil precommit in round `r` implies the validator is locked on that block with `locked_round = r` |
| I4 | `round` never decreases within a height |

### 3.2 Messages and signed bytes

All three are signed with the validator's consensus key (§6.1). The bytes are ASCII with `|` separators,
decimal integers without leading zeros and lowercase hex, as in `lib.rs:31-35`:

```
ROUGECHAIN_CONSENSUS_V3|chain=<chain id>|type=proposal|height=<h>|round=<r>|pol=<vr or "none">|block=<64 hex>
ROUGECHAIN_CONSENSUS_V3|chain=<chain id>|type=prevote|height=<h>|round=<r>|block=<64 hex or "nil">
ROUGECHAIN_CONSENSUS_V3|chain=<chain id>|type=precommit|height=<h>|round=<r>|block=<64 hex or "nil">
```

* A new domain tag is used so that no pre-fork vote can be read as a post-fork one, and so that the old
  verifier's round-0 restriction (`lib.rs:85`, `journal.rs:47`) is left intact for history.
* `block` is the block hash. Today the hash covers the builder's signature (`core/types/src/lib.rs:323-328`);
  that is acceptable because a block, once built, is re-proposed byte-for-byte. LC1's header-only hash (§4.3)
  is cleaner and is assumed if LC1 is active.
* A **proposal** carries the full block, the round `r`, and `pol` (the proposer's `valid_round`, or none).
* The block header gains `round`: the round in which the block was first built. The header's proposer must be
  the scheduled proposer of `(height, header.round)` (§3.3). A later round's proposer may re-propose that
  same block; the proposal signature is then the later proposer's, the block and its rewards remain the
  builder's.
* Wire form of a vote: 3,356 B (§2.2). Votes are pushed to peers when created or first accepted, not polled
  once a second as now (`finality_net.rs:212-218`); the existing rate limits and "only keys in the set" rule stay.

### 3.3 Proposer schedule (integer arithmetic)

Consensus state holds a signed priority `P_i` (`i128`) for each active validator, with weights `w_i` (stake in
whole XRGE, §6) and `W = Σ w_i`. The proposer for `(h, 0)` is produced by one **step**; the proposer for
`(h, r)` by `r` further steps applied to a scratch copy, so failed rounds do not alter the stored priorities
**[confirm against CometBFT; this is my reading]**.

```
step(P, w):
  for each i:  P_i ← P_i + w_i                       # checked add
  p ← the i with the greatest P_i; ties → lowest key hash
  P_p ← P_p − W
  return p
on any change of the active set or of a weight, before the next step:
  a new validator starts at P = −(W + ⌊W/8⌋)         # cannot propose immediately on entry
  if max(P) − min(P) > 2W:  P_i ← floor_div(P_i · 2W, max(P) − min(P))     # i256 intermediate
  avg ← floor_div(Σ P_i, n);  P_i ← P_i − avg                              # keep priorities centred
```

`floor_div` rounds toward negative infinity. `W` must stay below 2^100 so no step can overflow `i128`
(checked; a violation makes the block invalid). At the activation height all priorities are 0, so the first
proposer is the greatest stake with the lowest-key tie-break — the same key as today's rule.

The pseudocode left three points open. They are fixed as follows (Am.1: R3, R4, R5), and all three remain the
author's reading of the reference **[confirm against CometBFT]**:

* **R3.** On a set change, `W` in the entry penalty `−(W + ⌊W/8⌋)` and in the `2W` bound MUST be the **new**
  total weight, after the change.
* **R4.** A validator that stays in the set MUST keep its priority across a set change. A key that leaves the
  set and later returns MUST be treated as new (it receives the entry penalty again). While the set and all
  weights are unchanged, priorities MUST NOT be rescaled or re-centred: the last two lines of the pseudocode
  run only on a change.
* **R5.** The stored priorities MUST advance by exactly one step per committed height, whatever round the
  block committed in (failed rounds use the scratch copy only). That step MUST be taken before the block's
  own set changes are applied (the order of §6.6).

**Worked example**, stakes A = 50, B = 30, C = 20 (`W = 100`), fixed set, key order A < B < C:

| Height | Priorities after adding weights (A, B, C) | Proposer | Priorities after (A, B, C) |
|---:|---|:---:|---|
| 1 | 50, 30, 20 | A | −50, 30, 20 |
| 2 | 0, 60, 40 | B | 0, −40, 40 |
| 3 | 50, −10, 60 | C | 50, −10, −40 |
| 4 | 100, 20, −20 | A | 0, 20, −20 |
| 5 | 50, 50, 0 | A (tie, lowest key) | −50, 50, 0 |
| 6 | 0, 80, 20 | B | 0, −20, 20 |
| 7 | 50, 10, 40 | A | −50, 10, 40 |
| 8 | 0, 40, 60 | C | 0, 40, −40 |
| 9 | 50, 70, −20 | B | 50, −30, −20 |
| 10 | 100, 0, 0 | A | 0, 0, 0 |

A proposes 5 of 10, B 3, C 2: exactly the stake shares, with no randomness and nothing a proposer can grind.
Rounds use the same step on a scratch copy. At height 4, if A does not propose, round 1 is one more step from
(0, 20, −20): weights added give (50, 50, 0) and the tie selects A again; round 2 gives (0, 80, 20) and selects
B. A large validator can therefore hold consecutive rounds, each costing one propose timeout plus one
precommit timeout (§3.5; Am.1: F5). (In this example A holds half the stake, so the chain could not commit
without it in any case: §7.)

CONSENSUS-0 reproduced this table row by row and measured the fairness bound of P6 (§9): the worst deviation
from the exact stake share was 0.988 of one slot over 65 stake shapes × 3,000 slots. The bound "within one
slot" held everywhere it was tried; it is measured, not proved (Am.1: F14).

### 3.4 When a height starts, and empty blocks

A validator that has committed `h−1` waits in "new height" and enters round 0 of `h` (starting the propose
timeout) when the first of these happens:

1. it holds an admissible pending transaction or evidence item;
2. a heartbeat is due: its clock is at or past `time(h−1) + T_HB`;
3. it receives a proposal for `(h, any round)` that is valid in the sense of §3.5, the local-clock bound T2
   aside (parts (a)–(c) there);
4. it has received votes for height `h` from distinct validators holding at least `t1`.

Rule 4 is Algorithm 1's "more than one third are in a later round, so join them" applied to the waiting
state; it guarantees that validators whose mempool is empty do not hold back a round that the others have
started. A proposer whose mempool is empty and whose heartbeat is not due does not propose; if others have
work, their timers expire, they prevote nil, and the next round's proposer serves them. This is how a
withholding proposer loses its turn. Because a proposer may have nothing to propose, it MUST run the propose
timeout like everyone else (R6, §3.5).

**Commit wait (Am.1: R7).** After committing `h−1` a validator starts a commit wait (0.5 s recommended, a
per-node setting) during which it collects late precommits for `h−1`, so that the certificate it may have to
assemble lists everyone (§3.6).

* The wait MUST delay only start rules 1 and 2 (the validator's own reasons to start).
* Start rules 3 and 4 MUST take effect at once, wait or no wait: somebody else has already started the height.
* The wait MUST be skipped, or end early, as soon as the validator holds a precommit for the committed block
  from every member of `E(h−1)`.
* The wait is not part of the time to finality of block `h−1`, which is already committed; it delays the
  start of the next height (§3.5).

**Pending work must be shared (Am.1: R11, F4).** Start rule 1 is live only if the pending item reaches the
scheduled proposer or validators holding `≥ t1`. A validator that alone holds pending work, is not the
proposer and holds less than `t1` enters round 0, prevotes nil when its propose timeout expires, and then
has no rule left to fire: no quorum of prevotes forms, so no further timeout starts. The chain is unharmed,
but the item is not served. Therefore:

* Evidence items MUST be gossiped to peers exactly like transactions, on creation and on first receipt.
* A validator that has entered a round under start rule 1 and has not seen the height commit MUST re-offer
  its admissible pending items to its peers at least once per propose-timeout interval until the height
  commits. (The interval is a node setting, not a consensus rule; a re-offer is ordinary gossip.)
* The nil prevote such a validator has already signed for round 0 stands (I1). When the others start the
  height, it takes part normally from the step it is in, and the round-skip rule of §3.5 (R2) moves it
  forward if they are in a later round.

CONSENSUS-0 confirmed the other consequences of on-demand heights: nothing happens without work; one small
validator cannot start a height for the others; votes from `≥ t1` or a proposal do; an idle proposer loses
its turn; heartbeat-only heights fall at exactly `T_HB`.

**Empty blocks.** The protocol does not need them to be live. They are needed because header time is the
only clock consensus can read (LC1 §15.1):

| Needs a block to happen | Without heartbeats |
|---|---|
| Unbonding release and the evidence window, once they are time-based (§4.5) | Funds stay locked while the chain is idle (safe, but arbitrary) |
| Jail expiry and epoch boundaries (§4.4, §6.4) | Delayed until the next transaction |
| Putting the last block's certificate on chain, which pays its signers (§5) and bounds light-client staleness (LC1 §16) | Delayed until the next transaction |
| Noticing that a validator went offline during a quiet period | Not noticed until traffic resumes |

**Recommendation:** heartbeat blocks at interval `T_HB`, as LC1 §16 defines them (zero transactions allowed
only when `time ≥ parent.time + T_HB`), proposed by the scheduled proposer of that height and voted like any
block. Cost at one heartbeat per hour, all signers: 0.32 MB, 0.80 MB and 2.38 MB of certificates per day at
4, 10 and 30 validators; at 10 minutes, 1.9, 4.8 and 14.3 MB per day. (CONSENSUS-0 reproduced the hourly
figures over one idle simulated day of 24 blocks: 318,816 B, 795,336 B and 2,383,704 B.)

### 3.5 Round rules

These are Algorithm 1's rules with "2f+1" read as stake `≥ q` and "f+1" as stake `≥ t1`. The last column
names the line of Algorithm 1 (arXiv:1807.04938) the rule implements, in the form `[A1:n]` that the
CONSENSUS-0 state machine uses. **All sixteen line tags were written from memory of the paper and are
[unverified against the paper's text]**; checking them is part of the independent review (§9). Rules marked
R*n* were made explicit by CONSENSUS-0 (Am.1) and replace the looser wording of the first version.

| Trigger (in round `r` of height `h`) | Action | Line |
|---|---|---|
| Round `r` starts | Step ← propose. Persist `height`, `round` and the valid pair (§3.7). Every validator, **the proposer included**, MUST start the propose timeout (R6) | `[A1:11]` |
| Round starts and I am the proposer | If I have already signed a proposal for `(h, r)` (a restart), send that one again and nothing else (R30). Otherwise propose `valid_block` if I have one (with `pol = valid_round`). Otherwise, if I have work or a heartbeat is due (§3.4), build a block with `header.round = r` and the header time of R9. With nothing to propose I send nothing; my propose timeout runs | `[A1:15-16]`, `[A1:18]` |
| Valid proposal with `pol = none`, step is propose | Prevote the block if it passes T2 and I am unlocked or locked on that same block; otherwise prevote nil. Step ← prevote | `[A1:22]` |
| Valid proposal with `pol = vr < r` and prevotes `≥ q` for that block in round `vr`, step is propose | Prevote the block if it passes T2 and (`locked_round ≤ vr` or I am locked on that same block); otherwise nil. Step ← prevote. **This is the only way a lock is released** | `[A1:28]` |
| Correctly signed proposal from the scheduled proposer of `(h, r)` whose block is invalid, no valid proposal held for round `r`, step is propose (R8) | Prevote nil at once, without waiting for the timeout. Step ← prevote | `[A1:22-26]`, the "else" branch |
| Propose timeout of round `r`, still in round `r`, step is propose | Prevote nil. Step ← prevote | `[A1:57]` |
| Prevotes `≥ q` for anything in round `r`, first time, step is prevote | Start the prevote timeout | `[A1:34]` |
| Proposal and prevotes `≥ q` for that block in round `r`, first time, step ≥ prevote | If step is prevote: **lock** (`locked_block`, `locked_round ← r`), persist the lock, precommit the block, step ← precommit. In any case `valid_block`, `valid_round ← r`, persisted before the precommit is sent. T2 is not consulted (R1b) | `[A1:36]`, `[A1:38-41]`, `[A1:42-43]` |
| Prevotes `≥ q` for nil in round `r`, step is prevote | Precommit nil. Step ← precommit | `[A1:44]` |
| Prevote timeout of round `r`, still in round `r`, step is prevote | Precommit nil. Step ← precommit | `[A1:61]` |
| Precommits `≥ q` for anything in round `r`, first time | Start the precommit timeout | `[A1:47]` |
| Precommit timeout of round `r`, still in round `r` | Start round `r + 1` | `[A1:65]` |
| Precommits `≥ q` for one block in **any** round `r'` of height `h`, and I hold that block (R1) | **Commit**, in any step, including while waiting in "new height" (R29): apply and append the block, store the certificate, go to height `h + 1`. T2 is not consulted (R1b) | `[A1:49]` |
| Messages of a round `r' > r` from distinct senders holding `≥ t1` (R2) | Start round `r'`. If several rounds qualify, start the highest | `[A1:55]` |

The rules that the table compresses, stated in full (Am.1):

* **R1. Commit needs the block, from any round.** A validator MUST commit a block when it holds precommits
  `≥ q` for it in some round **and** holds the block itself from a correctly signed proposal of **any** round
  of that height that it did not judge invalid. It MUST NOT wait for the proposal message of the commit round.
  (The published rule asks for the proposal of the commit round. The two differ only when the message that
  re-proposed the block in a later round was missed, and §3.8 already lets a block plus its certificate
  commit alone.)
* **R1b. T2 gates prevotes only.** A header time too far ahead of the local clock MUST produce a nil prevote
  in that round and nothing else. It MUST NOT stop the validator from recording the proposal, from locking on
  and precommitting the block once prevotes `≥ q` for it are held, or from committing it. Rationale: T2
  depends on a local clock, and a validator whose clock is behind must not be the one that keeps a block
  with a quorum from committing.
* **R2. Round skip.** "Messages of round `r'`" counts each distinct sender once, whichever of proposal,
  prevote or precommit it sent, by its weight. If several rounds above the current one each reach `t1`, the
  validator MUST enter the highest.
* **R6. The proposer runs the propose timeout too.** A proposer with nothing to propose (§3.4) MUST still
  move on when the timeout expires, by the same rule as everyone else.
* **R8. Invalid proposal.** See "valid proposal" below, cases (b) and (c).
* **R9. Header time.** The proposer MUST set the header time to `max(local clock, parent time + 1 ms)`.

"Valid proposal" is decided in four parts, and the part that fails decides what happens:

| Part | Check | If it fails |
|---|---|---|
| (a) Origin | The proposal is for my current height and is signed by the scheduled proposer of `(h, r)` | The message MUST be ignored: it is not stored, starts nothing, and its sender is not counted for R2 |
| (b) Consensus-level block checks | Block height is `h`; its parent is my committed `h−1`; `header.round ≤ r`; the header's proposer is the scheduled proposer of `(h, header.round)`; `pol` is none or `< r` | The block is **invalid** (R8): nil prevote at once. The block MUST NOT be stored as a known block (it can never satisfy R1) |
| (c) Block validation | It carries a valid certificate for the parent; header time obeys LC1 T1 (strictly after the parent); every transaction rule of §1.1 holds; evidence and the other block rules of §4–§6 hold; speculative execution reproduces `state_root` | As (b) |
| (d) Local clock, LC1 T2 | Header time is not more than the drift bound ahead of my clock | Nil prevote **in this round only** (R1b). The proposal is stored and the block is known; it is acceptable in a later round and can be locked on and committed in this one |

Execution uses the existing snapshot-and-restore path (`node.rs:1593-1641`) and always restores; nothing is
appended before commit. The T2 drift bound is the value of LC1 §15.1; that section was not available to
CONSENSUS-0, which used 10 s as a placeholder **[confirm]** (Am.1: F16).

#### 3.5.1 Counting votes (Am.1: R10, defect F1)

For every `(height, round, vote type)` a validator keeps a tally. The rules are normative:

1. A vote MUST be counted for the value it names (a block hash or nil), once per `(validator, value)`.
2. Each validator's weight MUST be counted exactly once in "votes for anything", however many different
   values it signed in that slot.
3. A second vote by one validator in a slot, for a different value, is a **duplicate vote**. The receiver
   MUST build evidence from the pair (§4.2) **and MUST still count the second vote for its own value**. It
   MUST NOT discard it, and it MUST NOT keep "the first vote only".
4. Storage bound: a further value from a validator that already has a vote in the slot is stored and counted
   only if that value is nil or a block for which the receiver holds a proposal. Otherwise the vote is set
   aside (the evidence is still built) and MUST be accepted when it is offered again after the block has
   become known; the vote exchange of §3.8 MUST offer it again.

**The defect this removes (F1).** The first version described today's behaviour — a vote that conflicts with
one already held is rejected — and added only "and build evidence". Under rounds that rule lets one
equivocating validator holding less than one third stop the chain permanently. It sends one prevote to some
validators and a conflicting prevote to the others. A validator in the first group sees a quorum for block X
and locks on X. The others stored the other vote first, reject the vote for X, and can therefore never see
that quorum: they refuse every later re-proposal of X (its proof-of-lock round has no quorum in their books),
while the locked validator refuses everything except X. No round can succeed, and because slashing needs a
block, the equivocator is never removed. CONSENSUS-0 found this in its campaign (86 rounds and three
simulated hours without a commit) and has a regression test for it.

**Why counting per value restores liveness.** With rules 1–4 a validator's tally is a function of the **set**
of votes it has received, not of the order in which they arrived. Once the network delivers, every honest
validator holds the same set, so every honest validator computes the same tallies. A quorum that one honest
validator saw and locked on is then a quorum for all of them, and the lock-release rule (`[A1:28]`) works as
the published proof assumes: the locked block can be re-proposed with its proof-of-lock round and everyone
accepts it. Under "first vote only", two honest validators holding exactly the same votes could disagree for
ever about whether a quorum existed.

**Why it does not weaken safety.** The safety argument never relied on receivers discarding votes. It rests
on one fact: in a single slot two different values cannot both reach `q`, because the two quorums would share
signers holding at least `2q − T`, which is more than one third of `T`, and honest validators sign at most one
value per slot (I1). That fact is about the votes that **exist**; it holds for the union of all votes and
therefore for every validator's view of them, however they are counted. Below one third of faulty stake,
counting an equivocator for both of its values can never complete a second quorum. At or above one third no
counting rule gives safety (§7). "First vote only" added no protection in either case — the equivocator was
already counted for X by some validators and for Y by others — it only removed the honest validators' ability
to converge. Rule 2 keeps equivocation from inflating the "for anything" totals that start timeouts.

**Timeouts.** `timeout_X(r) = min(base_X + r · delta_X, cap)`. The three settings considered:

| Setting | Propose base / delta | Prevote and precommit base / delta | Cap |
|---|---|---|---|
| Fast (CometBFT's defaults as I recall them **[confirm]**) | 3 s / 0.5 s | 1 s / 0.5 s | 60 s |
| **Moderate (decided, decision 2)** | 6 s / 2 s | 2 s / 1 s | 120 s |
| Slow (Release 2 design §2.5 figures) | 20 s / 10 s | 5 s / 5 s | 300 s |

Under the moderate setting the propose timeout reaches the cap at round 57 and the vote timeouts at round 118.

**Measured time to finality** (CONSENSUS-0 stage 1; Am.1: F5). Ten equal validators, a fixed one-way delay,
milliseconds from the submission of a transaction to its commit. These figures replace the estimates of the
first version (≈ 1 s / ≈ 8 s / ≈ 16 s for the moderate setting at 0.2 s), which were too low for absent
proposers.

| Timeouts | One-way delay | Normal case | 1 absent proposer | 2 in a row | 3 in a row |
|---|---:|---:|---:|---:|---:|
| **Moderate (decided)** | 50 ms | 170 | 8,286 | 19,386 | 33,494 |
| | 200 ms | 680 | 9,142 | 20,542 | 34,975 |
| | 1 s | 3,402 | 13,707 | 26,711 | 42,875 |
| | 3 s | 10,207 | 25,120 | 42,132 | 62,625 |
| Fast | 200 ms | 680 | 5,142 | 10,542 | 16,975 |
| Slow | 200 ms | 680 | 26,142 | 66,542 | 121,975 |

How to read it:

* **Normal case:** three message delays (proposal, prevote, precommit) plus up to one delay for the
  transaction to reach the proposer. The commit wait is **not** part of it (R7): the block is final when the
  precommits arrive; the wait only delays the start of the next height.
* **An absent proposer costs its round's propose timeout plus its round's precommit timeout**, plus two
  message delays for the nil votes: validators prevote nil when the propose timeout expires, a quorum of nil
  prevotes gives nil precommits at once, and the quorum of precommits "for anything" then starts the
  precommit timeout, which must expire before the next round starts. With the moderate setting that is
  6 + 2 = 8 s for round 0, 8 + 3 = 11 s for round 1, 10 + 4 = 14 s for round 2: about 8, 19 and 33 s before
  message delays. The first version counted only the propose timeouts.
* A change that would shorten recovery (entering the next round at once on a quorum of **nil** precommits)
  is a further deviation from the published rules; it is not adopted and is listed in §12.

Timeouts are per-node settings; they affect speed and never safety. Validators need synchronised clocks only
for the T2 bound.

### 3.6 Commit certificate

Carried by block `h + 1` for block `h`, digest in the header as LC1 §12.2 arranges:

| Field | Size |
|---|---:|
| `cert_version` | 1 |
| `height` (of the certified block) | 8 |
| `round` (the commit round) | 4 |
| `block_hash` | 32 |
| `n_set` = number of validators in `E(height)` | 2 |
| signer bitmap over `E(height)` in key-hash order | `⌈n_set / 8⌉` |
| one 3,309-byte precommit signature per set bit, in the same order | `3,309 · k` |

Size `47 + ⌈n/8⌉ + 3,309·k`: the figures in §2.2. Rules: every signature is a precommit for exactly
`(height, round, block_hash)`; signer stake `≥ q`; `round ≥` the certified header's `round`. Keys are not
repeated: a full node has them from the validator state, and a light-client prover supplies them as a witness
checked against `validator_state_root` (LC1 §9.1). **The proposer of `h + 1` must include every valid
precommit for the commit round that it holds**; this cannot be verified (nobody can prove what it held), so
§5 makes omission unprofitable instead. Nodes also keep their own "seen" certificate for the tip and serve it
(a `/finality/:height` route is already used for this, `peer.rs:278-300`), since the canonical one only appears with the next block.

A validator MUST keep accepting precommits for the block it has just committed (same height, commit round and
hash, from members of that height's set) until it has proposed or seen the next block, and add them to the
certificate it holds; this is what the commit wait of §3.4 is for.

**How complete the certificate is in practice (Am.1: F9).** "Lists everyone" is a goal, not a guarantee: the
certificate is only as complete as the commit wait is long compared with real network delays. Measured in
CONSENSUS-0 with 10 honest validators, delays uniform between 5 ms and the maximum shown, and a transaction
every 300 ms (so the next height starts as early as the rules allow):

| Maximum delay | Commit wait | Signers listed | Fewest in one certificate |
|---:|---:|---:|---:|
| 50 ms | 500 ms | 99.9 % | 8 of 10 |
| 200 ms | 500 ms | 99.9 % | 8 of 10 |
| 400 ms | 500 ms | 99.9 % | 9 of 10 |
| 1 s | 500 ms | 97.6 % | 8 of 10 |
| 3 s | 500 ms | 89.4 % | 8 of 10 |
| 1 s | none | 70.0 % | 7 of 10 (a bare quorum) |
| 1 s | 2 s | 99.7 % | 9 of 10 |

Consequences, stated so that nothing else in this document over-claims:

* With no wait a certificate is a bare quorum, as today. The wait is what makes D6 work.
* A validator that is honest and online but slower than the wait is left out of some certificates. It loses
  that block's reward (§5) and collects absences from **many different** proposers — exactly what the
  downtime rule counts (§4.4). The distinct-proposer rule protects against a hostile proposer, not against
  being slow.
* Whether to lengthen the wait, or to let later blocks add missed signatures (§5.2), needs real delay data
  from testnet. It is not decided here; see §12.

### 3.7 What is persisted before signing

| Before | Must be durable (fsynced) | Exists today? |
|---|---|---|
| Any prevote or precommit | Journal slot `(chain, key, type, height, round) → block hash or nil` | Yes for round 0 and a hash (`journal.rs:103-136`); needs rounds and `nil` |
| Any proposal | Journal slot `(chain, key, height, round) → block hash`, plus the block | Partly: `(height, parent)` (`node.rs:3986-4011`) |
| A precommit for a block | `locked_round`, `locked_block` (full bytes) | No |
| Leaving a round | `height`, `round`, `valid_round`, `valid_block` | No |

**Order (normative).** Every record in the table MUST be durable before the message that depends on it leaves
the process. Within one step the order is: valid pair, then lock, then the journal slot, then the send.

On restart a validator reloads this state, never re-enters a round below the stored one, re-sends its
journaled votes (re-signing identical bytes is harmless, `journal.rs:12-14`) and resumes. The details the
first version left open are fixed as follows (Am.1: R30):

* The stored records MUST be resumed only if they are for the height the validator is now at **and** round 0
  of that height had been entered. Otherwise the validator waits in "new height" (§3.4) with nothing to resume.
* The step MUST be taken from the journal: a journaled precommit for the stored round means step
  "precommit"; otherwise a journaled prevote for it means "prevote"; otherwise "propose".
* Where a journal slot already holds a value, **that value wins** over whatever the rules would now choose.
  The validator re-sends exactly those bytes and MUST NOT sign anything else for the slot (I1).
* The proposal of a round MUST be sent at most once per `(height, round)` in content: after a restart the
  journaled proposal is sent again, never a newly built one.

A lock that is not persisted is the classic way an honest validator breaks safety after a crash, so "no lock
file, no precommit" is the rule, in the same spirit as "no journal, no vote" (`node.rs:3360-3361`).
CONSENSUS-0 showed both directions: restarting **without** this state forked 15 of 600 schedules, and the
same 600 schedules restarting **with** it produced no violation and no double-sign. As today, none of this
protects a key that runs on two machines. §4 makes that slashable **when the two machines sign different
values in one slot**; two machines that disagree only about a lock, in different rounds, leave no evidence
(§4.1.1; Am.1: F3).

### 3.8 Catching up

* **Behind by whole blocks.** Fetch blocks in order. Block `h` is accepted with a certificate for it: the one
  embedded in `h + 1`, or a standalone one for the tip. Verify, apply, append. Never sign anything for a
  height that is already committed locally or for which a valid certificate has been seen. A block with a
  valid certificate MUST be committed in whatever step the validator is in, including while it waits in
  "new height"; the local-clock bound T2 MUST NOT be applied to it (Am.1: R29, R1b).
* **Inside the current height.** On connect, peers exchange `(height, round)` and which votes they hold; a
  late node receives the proposal and votes it lacks. The `≥ t1` rule moves it to the current round, and the
  commit rule lets it commit from any round (R1, R2). The exchange MUST include votes that a peer set aside
  under rule 4 of §3.5.1, so that they are offered again once the block is known.
* **Bounds on what is stored (Am.1: F11, F12).** Neither Algorithm 1 nor the CONSENSUS-0 model limits the
  round number of a vote or the number of different blocks one proposer may sign for one round, so a faulty
  validator could make others store without limit. The node MUST bound both: (i) votes and proposals for
  rounds above its own are kept for at most a fixed number of rounds per sender, and (ii) at most a fixed
  number of distinct blocks are kept per `(height, round)`. Whatever the limits, two things MUST remain
  true: a validator can always follow senders holding `≥ t1` into a higher round (R2), and it can always
  obtain a block for which it sees precommits `≥ q` (R1, R29). The limits and the eviction rule are not
  chosen here (§12); they MUST be added to the state machine and tested in CONSENSUS-0 before stage B code.
* **Unchanged:** a node never replaces a committed block (`peer.rs:201-207`). With commit-before-append there
  is no longer an uncommitted tip to be stuck on (scenario 6).

---

## 4. Accountability

### 4.1 Offences and evidence

| Offence | Evidence | Penalty |
|---|---|---|
| **Duplicate vote**: two prevotes, or two precommits, by one key for the same `(chain, height, round)` with different `block` values (a hash against another hash, or against nil) | The two signed votes | Slash and permanent removal (§4.3) |
| Duplicate proposal for one `(height, round)` | — | Not slashed at first, as in CometBFT **[confirm]**: the proposer that exploits it must also double-vote, which is caught above. Add later if wanted (LC1 D-13). It does let a proposer make others store several blocks for one round, which the node must bound (§3.8; Am.1: F12) |
| Breaking a lock across rounds ("amnesia"): precommitting block X in round `r` and then prevoting a different block in a later round without a proof-of-lock round `≥ r` | **None exists.** The two votes are in different slots and each slot holds one value, so no pair of signatures proves it | None. Honest locks must be durable (§3.7). **A fork made this way is unpunished** (§4.1.1) |
| Precommit on a block whose parent is not canonical (LC1 E2) | One vote + the header | Owner decision LC1 D-13; this design does not need it |
| Downtime | Absence from commit certificates (§4.4) | Jail, no slash |

#### 4.1.1 What is and is not provable after a fork (Am.1: defect F3)

The first version claimed in three places (property P3, §3.7 and §7) that two blocks committed at one height
always yield double-sign evidence against keys holding at least `2q − T`. That is true for one kind of fork
and false for the other. The precise statements:

| Case | What happened | What can be proved |
|---|---|---|
| **Same-round fork** | Two different blocks each received precommits `≥ q` in the **same** round of one height | **Provable.** The two certificates share signers holding at least `2q − T` (more than one third of `T`). Each of those keys signed two precommits for one slot: a duplicate vote, self-contained evidence under §4.2. The evidence exists as soon as anyone holds both certificates. CONSENSUS-0: every fork its randomised runs produced above the fault bound (23 in one run, 13 in another) had evidence against `≥ 2q − T`. Its colluding-validator behaviour splits votes within a round and never breaks a lock across rounds, so those runs exercise this case only |
| **Cross-round fork** | Block X received precommits `≥ q` in round `r`; block Y received precommits `≥ q` in a later round `r'` of the same height. Keys holding `≥ 2q − T` precommitted X in round `r` and then voted for Y in round `r'`, breaking their locks | **Not provable.** Every key signed one value per slot, so **no duplicate vote exists**. The votes show that somebody among the overlap broke a lock, but a validator that precommitted X in round `r` may legitimately prevote Y later if it saw a proof-of-lock for Y in a round `≥ r`, and nothing in a vote says whether it did. CONSENSUS-0 has a scripted test of this: two honest validators, two committed blocks, zero evidence |

Both cases need malicious stake of `2q − T` or more, that is, above one third; below that bound neither fork
can happen (P1). The gap is therefore not a safety defect. It is an **accountability** defect: an attacker
holding more than one third who forks the chain across rounds loses nothing under the rules as they stand,
and "slashing makes the attack cost the overlap's stake" (§7) holds only for same-round forks. The same gap
covers an operator who runs one key on two machines whose lock files differ.

**Option, not adopted: votes that carry their justification round.** The standard remedy in the published
work on accountable Tendermint variants, as the author recalls it **[unverified against the published
texts]**, is to make every prevote for a block state the round that justifies it: the voter's own lock round
if it is locked on that block, otherwise the proof-of-lock round of the proposal, otherwise "none".

* **What becomes checkable.** A precommit for X in round `r` together with a prevote by the same key for a
  different block in a later round whose stated justification round is below `r`, or "none", is
  self-contained evidence of two signatures, verified like a duplicate vote. An honest validator can never
  produce that pair: after precommitting in round `r` its lock round is at least `r`, and it prevotes another
  block only on a proof-of-lock round at or above its lock round.
* **What does not.** A violator can state a justification round `≥ r` for which no quorum of prevotes ever
  existed. Two signatures cannot prove that a quorum did **not** exist. Closing that hole needs a further
  mechanism (for example, an obligation to produce the claimed prevotes when challenged), and that mechanism
  is the hard part of the design. Without it the option turns "no evidence at all" into "evidence unless the
  violator signs a specific false claim".
* **Cost.** 4 bytes per prevote on the wire (a `u32` with one value reserved for "none"): 3,356 B → 3,360 B.
  Precommits and commit certificates are unchanged, so nothing is added to the chain or to light clients.
  Per block at 30 validators: 120 B of distinct data and 3,480 B sent network-wide (870 prevote deliveries).
  The signed text of a prevote gains one field, so it MUST be fixed before the V3 bytes of §3.2 are frozen
  or it costs a new domain tag later. A second evidence type of about the size of the first (≈ 9.7 kB
  **[est.]**) is added.
* **Why it is not simply adopted.** It is new protocol surface that Algorithm 1 does not have; the exact
  definition of the field, the evidence rule and the challenge mechanism need their own design, their own
  CONSENSUS-0 properties and their own review. It is listed for the owner in §12.

### 4.2 Evidence transaction

A new typed item, not a signed user transaction and **not** the `slash` type: LC1's E1 envelope (LC1 §17.2,
9,704 B) with `round` (u32) and `vote_type` (u8) added — 9,709 B: offender key, the two block values, the two
signatures, and a proof that the key was in `E(height)`. Anyone may submit it; it pays no fee; a block may
carry a bounded number. Verification in block `b`, all deterministic:

1. `height < b`, and the header time of `b` minus the canonical header time at `height` is within the
   evidence window. The window is **inclusive**: age `≤ EVIDENCE_MAX_AGE` is accepted, one millisecond more
   is not (Am.1: R14).
2. The key was eligible at `height` (LC1 §17.4 opening, or the node's stored set for that height).
3. Both signatures verify over the §3.2 bytes (or the V2 bytes for a pre-fork height, where the round MUST
   be 0) for the same `(height, round, type)` and different `block` values.
4. The key is not already penalised for an offence at or below this height (LC1 §17.9's floor rule, which
   makes each unit of stake slashable once).
5. The key is not tombstoned (Am.1: F10, replacing the simulator's rule R28). While the slash fraction is
   100 % (decision 4) a tombstoned key has nothing left that a later offence could cut: its bond is gone and
   every unbonding entry created at or after its first penalised offence has been cut in full. CONSENSUS-0
   implemented the floor rule literally (R28): evidence for a later offence by a tombstoned key was valid,
   cut nothing, and still counted as pending work, so anyone holding old conflicting votes could force
   blocks that do nothing. Such evidence is therefore inadmissible. If the fraction is ever set below 100 %
   this rule MUST be revisited together with R15 (§4.3), because a remainder then exists that a second
   offence could reach.

Invalid or inadmissible evidence makes the block invalid; nodes MUST NOT gossip it or treat it as pending
work. The number of evidence items per block is bounded; CONSENSUS-0 used 8 **[est.]**.

A node that receives a vote conflicting with one it holds MUST build the evidence itself **and MUST still
count the vote** as §3.5.1 requires. The first version said "instead of only rejecting it", which kept the
rejection; that reading halts the chain (F1). Evidence items MUST be gossiped like transactions (R11, §3.4).

**Order within a block (Am.1: R14).** Evidence MUST be applied before unbonding entries are released in the
same block (the full order is in §6.6). Otherwise an entry that matures in the last block of the window
would be paid out in the very block that carries the evidence against it.

**Open point on rule 4 (Am.1).** As quoted, the floor rule rejects evidence for an offence **below** a height
that has already been penalised. Unbonding entries created between that earlier offence and the penalised
one were not reached by the first penalty (which cuts entries created at or after its own offence height,
§4.3) and cannot be reached by the second. Whether LC1 §17.9 intends this was not checked **[confirm]**. It
is not resolved here (§12 item 10); if rule 4 is changed, rule 5 must be changed with it.

### 4.3 Slashing

* **Amount.** `cut(x) = ⌊x · NUM / DEN⌋`, computed exactly (LC1 §17.7 gives the overflow-free form; the
  existing `units::mul_div` saturates on wide products, `units.rs:74-80`, and must not be used here). It
  applies to the validator's own bond, to every delegation to it (§6), and to unbonding entries created at or
  after the offence height. **Recommended: 100 % while only self-stake exists; decide again before delegation
  opens** (decision 4). Rationale: honest software cannot commit this offence on one machine (`journal.rs`),
  so the only honest victim is an operator running one key twice, which the onboarding rules forbid.
* **Removal.** The key is tombstoned: never eligible again (LC1 `TOMBSTONE`). The operator may withdraw what
  is left after unbonding and start again with a new key.
* **What is left (Am.1: R15, R16, F15).** The first version did not say what happens to two amounts:
  * If the slash fraction is ever below 100 %, the remainder of the bond MUST enter unbonding automatically
    in the block that applies the slash, with the full unbonding period. (At 100 % there is no remainder.)
  * Stake of the tombstoned key that is still **pending** — included but not yet active under §6.4 — MUST be
    refunded to its owner, not cut: stake that was never active cannot have signed.
* **Destination.** Slashed stake is **burned**, with an explicit state counter. Today a cut is simply
  subtracted and credited nowhere (`node.rs:7573-7577`). No reporter reward: evidence can be copied and the
  proposer can always claim it (LC1 D-8). Not the treasury: nobody who can influence slashing should gain from it.

### 4.4 Downtime: jailing from certificates

Once certificates list all signers and proposers rotate, absence is an on-chain fact. Per validator, state
keeps a **window**: for each of the last `W` certificates that concern it, whether it signed and which
proposer assembled the certificate (the proposer of the block that carries it). A validator is jailed when
**all** of these hold:

1. it is absent from more than `M` of the certificates in its window;
2. **the certificates it is absent from** were assembled by at least `m` distinct proposers (Am.1: R19,
   defect F2);
3. jailing it would not leave any single remaining key with one third or more of the remaining stake, and
   would not bring the stake jailed inside the window above one third of `T` (the plan's cap; otherwise
   jailing could hand the chain to whoever is left).

**Rule 2 was wrong in the first version (F2).** It read "those `W` certificates were assembled by at least
`m` distinct proposers". That is true of almost any window on a chain whose proposers rotate, so it
restrained nothing: one proposer holding more than `M` of the `W` slots could jail a rival simply by leaving
it out of its own certificates — the objection in the decentralization plan §7 item 6 that the rule was
written to answer. Counting the proposers behind the **absences** closes it: however many slots a single
proposer holds, the absences it creates come from one proposer, and fewer than `m` proposers acting together
can never satisfy rule 2. CONSENSUS-0 implements both readings; the old one is caught by property P9 and the
new one is not.

The details the first version left open are fixed as follows (Am.1: R20, R21, R22, F15):

* **R21. What the window holds.** Only certificates for heights at which the validator was in the set. The
  window MUST start empty at the activation of this rule, at unjail and at every entry or re-entry into the
  active set. It is judged from its first entry: it need not be full. The V2 certificate verified at the
  activation boundary (§8.2) MUST NOT be counted, because V2 certificates do not list every signer.
* **R20. How rule 3 is evaluated.** When several validators qualify under rules 1 and 2 in one block, they
  MUST be evaluated one at a time in key order, each against the set as it stands after the previous
  jailings in that block. "`T`" is the total stake of the set at that moment. "Inside the window" means
  jailed in the last `W` heights.
* **R22. Return.** Jailing removes the validator from `E` from the next height. An `unjail` transaction,
  signed by its operator key, is valid once at least `JAIL_MS` of header time has passed. `unjail` is an
  **addition** under §6.4: the validator returns at the first epoch boundary at least 24 hours after the
  request, with an empty window. No slash; rewards stop because it is not a signer.

Decided values (decision 4): `W = 200`, `M = 100`, `m = 3`, `JAIL_MS` = 1 hour. Jailing only helps while the
chain still commits, that is while offline stake is at most `T − q`; beyond that the chain halts safely and
returns when validators do.

**What the decided values mean in practice (Am.1: F6, F7).** These are consequences of the rules above, not
changes to them. Each is put to the owner in §12.

| Consequence | Why |
|---|---|
| A "1 hour" jail keeps a validator out for roughly 25 to 49 hours | R22: one hour before `unjail` is valid, then the first daily epoch boundary at least 24 hours after the request |
| On a quiet chain a validator must be offline for more than four days before rule 1 can be met | The window counts certificates, not time. At the hourly heartbeat there are about 24 certificates a day, and "more than 100" needs 101 |
| With today's stake nobody can be jailed at all | Rule 3 forbids any jailing that leaves one key with a third or more of what remains, and one key holds 99.98 %. Rule 2 cannot be met either while one key proposes almost every block |
| In a set of four equal validators nobody can be jailed either | Jailing one leaves three keys with exactly one third each, which rule 3 forbids. This is the rule working as written (a set of three cannot lose anyone, §7); it follows from the arithmetic and was not tested separately. Jailing first becomes possible with five equal validators |
| A validator that is online but slower than the commit wait collects absences from many proposers | §3.6 (F9). Rule 2 does not protect it |

### 4.5 Unbonding period and evidence window

Stake that signed must stay slashable for as long as evidence is accepted, or a validator can unstake, wait,
and then publish conflicting history at no cost. Therefore: unbonding becomes time-based
(`release_at = header time + UNBONDING_PERIOD`), unbonding entries are slashable, and
`EVIDENCE_MAX_AGE = UNBONDING_PERIOD` — exactly LC1 §15.3–§15.4 and §17.8. The evidence window is inclusive and
evidence is applied before releases in the same block (§4.2; Am.1: R14), so an entry is slashable up to and
including the block in which it would be released. **Recommended: 21 days** (LC1 D-5
offers 14, 21, 28). Today's 500 blocks at roughly 20 blocks a day **[est., §5.4]** is about 25 days by
accident and could be minutes under load; existing queue entries keep their height rule (LC1 §15.5).

### 4.6 Reconciliation with `slash` and MONETARY_INTEGRITY

MONETARY_INTEGRITY part (b) stays exactly as it is: a transaction of type `slash` is never valid again
(`node.rs:390-396, 441`). Penalties enter only through evidence items (§4.2) and the certificate-derived
jailing rule (§4.4), both verified by every node from block contents alone. The frozen missed-block rule and
the `slash` arm of `apply_validator_tx` remain only for replaying history below the fork
(`node.rs:7504-7546, 7565-7578`; `validator_replay.rs:80-86, 97-108`). The per-type conservation table in the
tests (`node.rs:13940-13957`) gains the evidence item, with the burn counted.

---

## 5. Rewards

### 5.1 Formula

For block `b` at height `h`, built by proposer `p`, carrying the certificate for `h−1` with signer set
`S ⊆ E(h−1)`. Let `T = T(h−1)`, `s_i` the stake of validator `i`, `W_S = Σ_{i∈S} s_i`. All values in quanta,
all divisions floor, all products exact (256-bit intermediate where needed).

```
burn      = min(fees, base_fee · fee_tx_count / 2)                 # unchanged (node.rs:6854-6855)
pool      = fees − burn + subsidy                                  # subsidy: §5.3
treasury  = pool · 10 / 100
prop_base = pool · 5 / 100                                         # for building the block
prop_incl = (pool · 15 / 100) · W_S / T                            # for including signers
vote_i    = (pool · 70 / 100) · s_i / T        for i ∈ S           # denominator is T, not W_S
vote_i    = 0                                  for i ∉ S
unearned  = pool − treasury − prop_base − prop_incl − Σ vote_i     # goes to __staking_rewards__
```

`p` receives `prop_base + prop_incl` (plus `vote_p` if it signed `h−1`). The sum of all credits plus
`unearned` equals `pool` exactly. Under delegation, `vote_i` is split by §6.3.

Points the formula left open, now fixed (Am.1: R26, R27):

* `unearned` MUST be computed as the residual shown (pool minus everything paid), never by a formula of its
  own; otherwise rounding remainders vanish. CONSENSUS-0's reward-conservation check catches the difference.
* `fee_tx_count` counts the transactions in the block that paid a non-zero fee.
* Signers are paid by their weight in `E(h−1)`, the set that signed, even if they have left the set since.
* The block directly above genesis carries no certificate: `S` is empty and all vote and inclusion shares
  are unearned.
* The V2 certificate carried by the first block of the new rules (§8.2) is paid by this formula, with `S` the
  signers it lists.
* **Conservation, as checked (P7).** For every block, in quanta: `credits + burn + unearned = fees + subsidy`.
  The reserve's net change is `unearned − subsidy`. Total supply — liquid, bonded, pending, unbonding and
  burned together — never changes.
* CONSENSUS-0 held the base fee constant; the dynamic base fee of §1.1 is not part of this design and was not
  modelled.

### 5.2 Properties

* **An offline validator earns nothing**: it is not in `S`, and it does not propose.
* **Omitting a signature never pays.** Because each signer's share is divided by `T`, not by the stake that
  was included, leaving out validator `j` does not raise anyone's `vote_i`; it lowers the proposer's own
  `prop_incl` by `(15 % of pool) · s_j / T`. The withheld share goes to the reserve, not to the proposer.
* **Why this is enough without late inclusion.** A proposer could still omit a rival at a loss to itself. The
  rival loses one block's share only when that proposer has the turn, and jailing ignores omissions by fewer
  than `m` proposers (§4.4, as corrected by R19). Letting later blocks add missed signatures would close the
  remaining gap at 3,309 B per late signature; it was left out "unless CONSENSUS-0 or testnet data shows
  omission in practice".
* **CONSENSUS-0 did show omission, of a different kind (Am.1: F9).** Not hostile omission, but honest
  validators left out because they were slower than the commit wait: 10.6 % of signatures at delays up to 3 s
  with the 0.5 s wait (table in §3.6). They lose those blocks' shares, which go to the reserve. Whether late
  inclusion or a longer wait is the answer is open (§12).
* **Proposing well pays**: 5 % plus up to 15 %, in proportion to stake over time because the schedule is (§3.3).

### 5.3 Burn, treasury and the reserve

* Burn and the 10 % treasury share are unchanged.
* `__staking_rewards__` holds 10,800,000,000 XRGE in the genesis file in the repository
  (`core/daemon/genesis.json:26-30`; I did not check the live balance). Today it tops each fee-paying block's
  pool up to 0.1 XRGE (`node.rs:6864-6873`). That floor pays per block, and a block needs only one
  transaction, so **a proposer can farm it**: a transaction paying the 0.001 XRGE floor fee yields a 0.1 XRGE
  pool. With one proposer this was the owner paying itself; under rotation it is an extraction any proposer can run.
* **Change:** replace the per-block floor with a per-time subsidy:
  `subsidy = min(reserve, RATE · (time(b) − time(b−1)) / 1000)`, capped at `RATE · T_HB`. More blocks then do
  not mean more subsidy, heartbeats carry it through quiet periods, and unearned shares return to the reserve.
  `RATE` (quanta per second) is the owner's budget decision; `RATE = 0` is valid.

### 5.4 Worked example and what rewards are worth

Four validators A 40,000 / B 30,000 / C 20,000 / D 10,000 (`T = 100,000`, `q = 66,667`). D is offline. Block
`b` is proposed by B and carries the certificate for `b−1` signed by A, B, C (`W_S = 90,000`). It has 10
transactions paying 0.1 XRGE each, base fee at the 0.001 floor, no subsidy.

| Item | Calculation | Quanta | XRGE |
|---|---|---:|---:|
| Fees | 10 × 0.1 | 1,000,000,000 | 1.000 |
| Burn | 10 × 1,000,000 / 2 | 5,000,000 | 0.005 |
| Pool | | 995,000,000 | 0.995 |
| Treasury | 10 % | 99,500,000 | 0.0995 |
| Proposer base (B) | 5 % | 49,750,000 | 0.04975 |
| Proposer inclusion (B) | 149,250,000 × 90,000 / 100,000 | 134,325,000 | 0.134325 |
| A, signer | 696,500,000 × 40 % | 278,600,000 | 0.2786 |
| B, signer | × 30 % | 208,950,000 | 0.20895 |
| C, signer | × 20 % | 139,300,000 | 0.1393 |
| D, offline | | 0 | 0 |
| Unearned → reserve | 14,925,000 + 69,650,000 | 84,575,000 | 0.084575 |
| **Total** | | **995,000,000** | **0.995** |

Under today's rule D would have been paid 0.06965 XRGE for doing nothing (`node.rs:6887-6891`).

**Plainly:** the activation heights 90 to 190 were reached between 2026-09-23 and 2026-09-28
(`upgrades.rs:63-65`), about 20 blocks a day **[est.]**. At a pool of 0.1 to 1 XRGE per block the whole
validator set shares roughly 2 to 20 XRGE a day **[est.]**, and XRGE's value is small. Fee rewards do not
cover a server. Until usage grows, operators will join for other reasons (belief in the project, a role in
it, or a subsidy the owner chooses to pay from the reserve), and the design should not pretend otherwise. Two
consequences: the reserve subsidy `RATE` is the real incentive lever and is a budget decision; and because
slashing a nearly worthless stake deters little, security in this period rests on the non-stake measures of §7.

---

## 6. Keys and delegation

### 6.1 Three keys per validator

| Key | Use | Where it lives | Today |
|---|---|---|---|
| **Consensus key** (ML-DSA-65) | Signs proposals and votes only. Holds no funds, cannot move stake | On the validator machine | One key does everything: it votes (`node.rs:3351`), it is the staking account (`7019`), and rewards are credited to it (`6889`). A stolen server key can unstake and take the funds |
| **Operator key** | Creates the validator, sets commission, rotates the consensus key, unjails, unbonds self-stake | Off the server | — |
| **Withdrawal address** | Receives rewards and released self-bond. Changed only by a transaction signed by the current withdrawal key | Cold | — |

A validator is identified by an id derived from its creation transaction, not by its consensus key. Existing
validators migrate with operator = withdrawal = consensus key and can then separate them.

**Rotation.** `rotate_consensus_key` (operator-signed, carries a signature by the new key) takes effect at
the next epoch boundary (§6.4). The old key stays slashable for the evidence window: state maps each retired
key to its validator id until then. In LC1 terms rotation removes one leaf and inserts another in the same block.

### 6.2 Delegation model

Non-custodial: delegated XRGE is locked in the delegator's own bond record, never credited to the validator.

* `bond_delegate(validator, amount)` and `bond_undelegate(validator, amount)`, new transaction types. The
  suspended `delegate` / `undelegate` names are **not reused**: in the code they mean governance vote
  delegation (`node.rs:6648-6668`) and stay suspended.
* A validator's **weight** = its self-bond plus all delegations to it, in whole XRGE (fractions do not count).
  Bonds are held in quanta; weight is `⌊bond / 10^9⌋` (Am.1: R13). A validator whose weight is 0 MUST NOT be
  in the active set.
  Weight is what `E`, `T`, the proposer schedule and LC1's leaf `stake` use, so the leaf format does not change:
  a delegation appears to a light client as a stake operation on the validator's leaf.
* Undelegating uses the same queue and period as unstaking (§4.5) and the entry stays slashable.
  `bond_redelegate` (move to another validator without waiting) is allowed, with the moved amount remaining
  slashable for offences of the old validator during the window.
* **Slashing** cuts self-bond and every delegation by the same fraction. A different fraction for delegators
  would let an operator hold its own stake as a "delegation" from a second account and pay the lower rate.

### 6.3 Rewards under delegation

`vote_i` from §5.1 is split: `commission = vote_i · rate_bps / 10,000` to the validator's withdrawal address;
the rest is added to a per-validator running index `reward_per_unit` (scaled by 10^18, exact 256-bit
arithmetic) over the validator's total bonded quanta, self-bond included. A bond's claimable reward is
`amount · (index_now − index_at_last_change)`, settled whenever the bond changes or on `claim`. Rewards do not
compound into weight, so weights change only on explicit transactions and slashes. Rounding remainders go to
the reserve. Proposer rewards are split the same way.

### 6.4 Bounds, set size and timing

| Parameter | Recommendation **[decision 6, 7]** | Reason |
|---|---|---|
| Minimum self-bond | Recommended 10,000 XRGE; **decided 100,000 XRGE with a 30-day grace (decision 6)**; enforced in consensus (today API-only, `main.rs:6605-6609`; LC1 §9.5). Falling below it (by unbonding or a slash) removes the validator from the active set | A validator must have its own funds at risk |
| Active-set cap | 32 by weight, ties to the lowest key hash; the rest are candidates (bonded, not voting, not paid, not jailable) | 99 kB certificates at 30 (§2.2); LC1 D-4 lists 32 |
| Commission | Floor 5 %, ceiling fixed by the validator at creation and at most 50 %, change at most 1 percentage point per epoch | A floor stops a large operator buying delegations at 0 %; the change limit stops a sudden jump to 100 % |
| Delegation concentration | A new delegation is refused if it would take the validator above 25 % of active weight | Soft brake only; it cannot stop one operator running several validators |
| Epoch | The first block whose header time crosses a 24-hour boundary | Needs heartbeats (§3.4) |
| Additions (new validator, more stake or delegation, unjail, key rotation, entering the active set) | Take effect at the first epoch boundary at least `ACTIVATION_DELAY` (24 h) after inclusion | Makes set changes predictable and visible in advance (§7) and lets several validators become active at the same height (§8.4) |
| Removals (unbond, slash, jail, falling below the minimum) | Next height, as today | A removal must not be delayable |
| Falling out of the cap | At an epoch boundary only (R18) | Nothing can enter between boundaries, so nothing can be pushed out between them |

The rules behind the table, made explicit by CONSENSUS-0 (Am.1: R17, R18, R24, R25, F15):

* **R25. Epoch boundary and maturity.** The epoch boundary is the first block with
  `⌊time / 24 h⌋ > ⌊parent time / 24 h⌋`. An addition is mature at a boundary when
  `boundary time − inclusion time ≥ 24 h`. An addition therefore takes between 24 and 48 hours.
* **R18. Cap.** The cap MUST be applied at epoch boundaries only, over the validators already active plus the
  candidates that qualify at that boundary, by weight, ties to the lowest key. A candidate qualifies when it
  meets the minimum (or is in its grace), is admitted (R17), is not tombstoned or jailed, and has a weight
  above zero.
* **R17. Admission approval (decision 8).** Approvals are given by `approve_validator` transactions from
  validators in the active set. They MUST be tallied at each such transaction against the set of **that
  block**: an approver that has since left the set weighs nothing. Approval is final once the tally reaches
  `q`. Validators already in the set when the rule activates need none. To enter at a boundary a candidate
  needs **both** its stake and its approval to be at least 24 hours old at that boundary.
* **R24. Grace (decision 6).** The grace is a flag held by every validator in the set at activation. It MUST
  be cleared for all of them at the first epoch boundary at least 30 days after the activation of the stage
  that introduces the minimum (stage A; CONSENSUS-0 models a single activation height). A validator still
  below the minimum leaves the active set at that boundary and is under the ordinary rule afterwards.
  **With today's stakes this removes the two validators holding 10,000 and 9,000 XRGE and leaves a set of
  one** unless they are topped up first (Am.1: F8; §12).
* **Unjail** is an addition (R22, §4.4).

**The active set MUST never be empty (Am.1: F13).** The first version had no such rule. If the last validator
unbonds, or every validator is below the minimum when the grace ends, no proposer is scheduled, no block is
ever valid again, and only a new release could restart the chain (CONSENSUS-0 has a test showing the halt).
The rule:

* After every block the set for the next height MUST contain at least one validator with weight above zero.
* An `unbond` (or, later, `bond_undelegate`) that would break this MUST be an invalid transaction.
* The automatic removals — below the minimum, end of grace, jailing — MUST NOT remove the last remaining
  validator. Where several would leave in one block they are processed in ascending order of weight, ties
  to the higher key first, and processing stops while one remains; that validator stays active although it
  is below the minimum, and becomes removable as soon as another validator is active.
* The case this does not settle is a slash of the last remaining validator. That needs a choice and is
  listed in §12.

This rule prevents a permanent halt. It does not make a set of one acceptable: such a set has no fault
tolerance of any kind (§7).

### 6.5 Before delegation may be enabled

1. §4 is live: evidence, slashing of bonded and unbonding stake, time-based unbonding, downtime jailing.
2. §5 is live: an offline validator earns nothing, so delegators get a signal.
3. §6.1 is live: delegated stake cannot be redirected by whoever steals a server key.
4. No single operator holds one third or more of weight, with at least four independent operators (the
   decentralization plan's target). Until then a delegator's funds are slashable at the discretion of whoever
   controls the proposer slot and the quorum (LC1 §17.11), and delegation would only concentrate weight further.
5. The 256-bit reward arithmetic has test vectors and the conservation property (§9) holds over long runs.

### 6.6 Order of effects inside one block (Am.1: R12)

The first version did not fix the order in which a block's effects are applied. Several rules depend on it
(R5, R14, R20, R26), so it is consensus-critical and MUST be exactly this, in the node and in the replay
mirror (`validator_replay.rs`):

| Step | Effect | Depends on the order because |
|---:|---|---|
| 1 | Header checks and verification of the parent's certificate | Everything below assumes a valid header |
| 2 | One proposer-priority step (§3.3) | R5: before this block's own set changes |
| 3 | Transactions | |
| 4 | Evidence: slashing and tombstones (§4.2, §4.3) | R14: before step 7 |
| 5 | Rewards from the parent's certificate (§5) | Signers are paid by their weight in `E(h−1)` (R26), whatever steps 3 and 4 did |
| 6 | Downtime observation and jailing (§4.4) | Uses the same certificate; R20 |
| 7 | Release of matured unbonding entries (§4.5) | After evidence |
| 8 | Epoch processing, if this block is a boundary: matured additions, unjails, end of grace, the cap (§6.4) | |
| 9 | Removals for falling below the minimum or to weight 0 (§6.4), subject to the non-empty rule | After step 8, so a top-up maturing at this boundary counts |
| 10 | The new active set, and re-weighting of the priorities for it (§3.3, R3, R4) | |

---

## 7. Security analysis

"Faulty" means stake that is offline or malicious. Guarantees assume every honest validator keeps durable
state (§3.7) and runs each key on one machine.

| Adversary | Safety (no two blocks committed at a height) | Liveness | Notes |
|---|---|---|---|
| Faulty stake at most `T − q` (less than one third) | **Guaranteed** | **Guaranteed** once the network delivers within the timeouts: some round has an honest proposer and enough honest votes | Censorship is limited to the faulty proposers' own turns |
| Crash-only faults `< T/3` | Guaranteed | Guaranteed; each absent proposer costs one propose timeout plus one precommit timeout (measured in §3.5; Am.1: F5) | The "one operator's machine is down" requirement is met when no machine holds `> T − q` |
| Malicious stake of `2q − T` or more (above one third) but below `q` | **Not guaranteed**: with control of message delivery it can commit two blocks. Both certificates share signers holding at least `2q − T`. **If both blocks were committed in the same round**, those signers are provably double-signers (duplicate-vote evidence, §4.1.1). **If the blocks were committed in different rounds, no evidence exists** and nobody can be slashed (Am.1: F3) | Not guaranteed: it can stop the chain by not voting. That is a halt, never a fork | Slashing makes a same-round safety attack cost the overlap's stake — which is only a deterrent if stake has value. A cross-round attack costs the attacker nothing under the present rules; the remedy is an open option (§4.1.1, §12) |
| Malicious stake `≥ q` (more than two thirds) | None. It can commit anything, including invalid state transitions on its own nodes' say-so; honest full nodes reject invalid blocks but cannot outvote | None | No BFT protocol helps. Evidence can be censored (LC1 §17.11). Today one key is in this position |
| Network partition, no malicious stake | Guaranteed | The side with `≥ q` continues; if neither side has `q`, both stop and resume on healing. Locks made before the split are released only by the lock rule, so no stuck state (property P5, §9). This depends on counting votes per value (§3.5.1): CONSENSUS-0 found a stuck lock under the first version's wording (F1) and none after the correction | Today a partition can leave an appended, uncertified tip (scenario 6) |
| Long-range attack: keys that once held `≥ q` and have unbonded sign an alternative history | Full nodes: not affected, they never replace committed blocks (`peer.rs:201-207`). **New nodes and light clients are exposed** if they start from old data | — | Mitigated by: unbonding and evidence window of 21 days with slashable unbonding stake (§4.5); new nodes must start from a checkpoint younger than the unbonding period — compiled into the release (releases already pin history: `upgrades.rs:8-10`, and the checkpoint check at `node.rs:1607-1611`) or obtained from a trusted source; LC1's light client refuses checkpoints older than `MAX_CHECKPOINT_AGE` |
| Stale consensus key after rotation | As above for the retired key | — | Retired keys stay slashable for the evidence window (§6.1) |
| One key on two machines (honest mistake) | Can produce a real double-sign | — | Slashed like any other when the two machines sign different values in one slot; this is the only honest path to a slash and it is avoidable. If the machines differ only in their locks, across rounds, the fault is real but leaves no evidence (§4.1.1) |

**Small sets.** With equal stakes:

| `n` | Signers needed (`q`) | Offline validators tolerated | Malicious validators tolerated for safety (`2q − T − 1`) | Comment |
|---:|---:|---:|---:|---|
| 1 | 1 | 0 | 0 | A single signer; no fault tolerance of any kind |
| 2 | 2 | 0 | 1 | Either one halts the chain; neither can fork it alone |
| 3 | 3 | 0 | 2 | Any one halts; unequal stakes let two finalize without the third (decentralization plan §4.1) |
| **4** | **3** | **1** | **1** | **The smallest set that survives one failure of either kind** |
| 10 | 7 | 3 | 3 | |
| 30 | 21 | 9 | 11 | |

Below four the protocol stays safe and stops instead of forking; it simply cannot lose a validator. What
matters is stake, not head count: any key above one third recreates the `n ≤ 3` rows, which is today's state.

**Today's stake under the new rules, as tested (Am.1).** CONSENSUS-0 ran the protocol with today's
distribution (about 99.98 % on one key). The results match the table above and are stated here so that
nobody expects more from stage B than it gives:

| Question | Result |
|---|---|
| Who commits blocks? | The large key alone. Its own prevote and precommit are a quorum; no message from anyone else is needed |
| Can the two small validators stop or fork it? | No |
| Who proposes? | The large key, in every round the others could reach (checked for 2,000 rounds) |
| What if the large key is offline? | A halt, never a fork. The others hold 0.019 % of the stake: no quorum of any kind forms, no timeout even starts, and no block is produced in any number of rounds |
| What if the large key signs two blocks? | Honest small validators can commit different blocks. The double-signing is provable when it is in one slot, but nobody can outvote the key that did it |
| Can downtime jailing act? | No (§4.4) |

Stage B changes nothing in this respect until stake is spread (§8.1, §8.4).

**Cheap stake.** With today's figures as supplied (`T` ≈ 100,109,000) an outsider needs about `T/2` ≈ 50 million
XRGE to halt and `2T + 1` ≈ 200 million to finalize alone (formulas: decentralization plan §5.3); with the
repository's figures (`T` = 119,000) the numbers are 59,500 and 238,001. Whether that is expensive depends on
market price and liquidity, which this document does not assess. If the founding operator reduces its stake to
let others in, both thresholds fall with it.

| Protection | Depends on stake being expensive? |
|---|---|
| Signatures cannot be forged; a certificate needs `q` of the *registered* set | No |
| Honest validators cannot double-sign from one machine (durable journal and locks) | No |
| A halt instead of a fork when quorum is missing; no chain replacement | No |
| Set changes visible a day ahead (activation delay, epochs) | No |
| Active-set cap, minimum self-bond in consensus, admission approval (below) | No (they restrict *who*, not *how much*) |
| Fresh-checkpoint rule for new nodes; pinned history in releases | No |
| The bridge's separate 2-of-3 authority (not part of this design) | No |
| The one-third and two-thirds thresholds against a buyer | **Yes** |
| Slashing as a deterrent; unbonding as a cost | **Yes** |
| Rewards as a reason to behave | **Yes** |

**Interim, non-stake mitigations the owner can adopt:**

| Measure | What it stops | Trade-off |
|---|---|---|
| Active-set cap + consensus minimum self-bond | Dust validators inflating certificates and forcing extra rounds; unbounded set growth | The cap makes slots scarce: a buyer can also push honest small validators out by out-staking them. Squatting costs `minimum × cap` |
| Activation delay (24 h) and epoch boundaries | Surprise takeovers: stake bought now cannot vote or propose until a known later block | Only buys time. Useful only if someone watches and there is a response (below); honest newcomers wait a day |
| **Admission approval**: a new validator becomes active only after an `approve_validator` vote by validators holding `≥ q` (today: the founding operator); tallying rule R17 in §6.4 | Purchase of a blocking or controlling position by an unknown party, regardless of price | Permissioned: the incumbents can refuse anyone, and it is centralised for as long as one operator holds `q`. It must be announced as temporary, with a stated exit condition (for example: removed by fork once at least five independent operators are active and no operator holds one third). It does not stop an approved validator from being bought later, nor delegation to an approved validator, which is why delegation waits (§6.5) |

Recommendation: all three from stage A, admission approval stated publicly as an interim measure.

---

## 8. Migration

Each stage is its own fork height in `UpgradeSchedule` (`upgrades.rs:23-52`), with history below it replaying
byte-identically (new header fields use the omit-when-absent pattern of `core/types/src/lib.rs:221-229`, or
LC1's Header V2 if that is active), mirrored in `validator_replay.rs`, rehearsed on testnet first.

### 8.1 Stages

| Stage | Content | On the wire | In state | Safe alone because |
|---|---|---|---|---|
| **A. Accounting** | Binary certificate listing all held precommits (§3.6) with a commit wait; per-validator signing bitmap; consensus minimum self-bond, active-set cap, activation delay and epochs, admission approval; header time rules T1/T2 and heartbeat blocks; reward formula of §5 (signers only, per-time subsidy); stop signing the unused prevote | Certificate encoding; heartbeat blocks; `approve_validator` | Bitmaps; epoch and pending-activation records; `time` validated; fee split | Who proposes and how votes decide are unchanged: still one proposer, round 0. No new way to halt or fork. Gives on-chain participation data before any power moves |
| **B. Rounds and rotation** | Tendermint rounds, locks and timeouts (§3); stake-weighted proposer schedule; propose/commit separation in the node; durable consensus state; pushed vote transport | V3 signed bytes; proposal and nil votes; `round` in header and certificate | Proposer priorities | With today's stake it behaves as today (the large key proposes almost always and completes quorum alone); the new paths only matter once stake is spread. Removes scenarios 1, 2 and 6 |
| **C. Accountability** | Evidence items and slashing with tombstones; time-based, slashable unbonding (integer amounts); downtime jailing and `unjail` | Evidence item; `unjail` | Tombstones with floors; unbonding entries by time; burn counter | Honest single-machine validators cannot be slashed; jailing has the concentration cap and the distinct-proposer rule (as corrected, R19). With today's stake jailing cannot act at all, and cross-round forks are not punished (§4.4, §4.1.1; Am.1) |
| **D. Key separation** | Operator and withdrawal keys; consensus-key rotation | `create_validator`, `edit_validator`, `rotate_consensus_key`, `set_withdrawal` | Validator ids; retired-key map | Existing validators keep working with all three roles on one key until they choose to split |
| **E. Delegation** | `bond_delegate` / `bond_undelegate` / `bond_redelegate` / `claim`; commission | Those types | Bond records; reward indexes | Gated on §6.5 |

Order rationale: A makes participation measurable and closes the admission gaps before anything else; B is
the largest change and benefits from A's data and time rules; C needs B's rotation for jailing to be fair and
uses the same evidence format with rounds from the start; D before E so no delegated funds ever sit under a
hot key. C could precede B (the evidence format already carries `round`, which would be 0) if the owner wants
double-signing slashable before rotation; jailing would still wait for B.

### 8.2 Activation boundary (stage B, height `F_B`)

* Block `F_B − 1` is produced and certified under today's rules (V2 round-0 precommits). Block `F_B` is the
  first proposed under §3 and carries that V2 certificate: **a certificate is always verified under the rules
  of the height it certifies** (as LC1 §12.3 does at its own boundary).
* Priorities start at zero at `F_B`, so the first proposer is today's designated proposer (§3.3).
* The V2 certificate carried by block `F_B` is paid by the reward formula of §5 (R26) and is not counted in
  any downtime window (R21). V3 bytes for a height below `F_B` and V2 bytes for a height at or above it MUST
  both be refused. Double-signing before the fork stays punishable inside the evidence window, verified
  over the V2 bytes with round 0 (§4.2). CONSENSUS-0 has a test for each of these (Am.1).
* Journals: V3 slots are distinct from V2 slots; nothing signed before the fork can conflict with anything after.
* Every validator must run the release before `F_B − 1`. If validators holding more than `T − q` have not
  upgraded, the chain stops at `F_B` without forking and resumes when they upgrade.

### 8.3 Line-up with LC1

| LC1 item | Effect of this design | Action |
|---|---|---|
| §12.1 `CERT_V2`, §12.5 "round 0 only" | Certificate gains `round`, a bitmap and all signers; vote bytes become V3 | Amend LC1 before `L` is chosen, or activate stage B first. LC1 D-11 already names this choice; doing it after `L` costs a header version and a new light-client instance |
| §9.7 designated proposer | Replaced by the schedule of §3.3. The light-client proposer check is optional (LC1 §4.2), so priorities can live under `state_root`, not in the validator leaf | Keep the leaf unchanged |
| §9.1 leaf `stake` | Becomes weight (self-bond + delegations); `key_hash` is the consensus key's | No format change; rotation and delegation appear as leaf operations (LC1 §10 needs operation kinds for them) |
| §9.5, §9.6 minimum and cap | Same rules, delivered in stage A | Use LC1's parameters (D-3, D-4) |
| §15, §16 time and heartbeats | Adopted as written; T2 becomes "prevote nil" under rounds | LC1 §15.2's argument against a lower time bound assumed one round; it can be revisited |
| §17 evidence and slashing | Adopted, with `round` and vote type added to E1; LC1 D-15(b) (delayed set changes) is §6.4 | Decide D-15 together with decision 6 here |

### 8.4 Redistributing stake without making the chain easier to stall

Today one machine's absence halts the chain (the founding operator's primary). The rule for every step:
**the number of independent failures needed to stop the chain never goes below its current value, and no
party other than F ever gains the ability to stop it alone.**

| Step | Requires | State | Failures needed to halt |
|---|---|---|---|
| 0. Today | — | One key above `q` | 1 (that machine) |
| 1. F spreads its own stake over four or more machines, each below one third | Stage B live (otherwise the designated machine still halts alone); admission approval live | F's machines 25 % each; others small | 2 of F's machines. Strictly better than today |
| 2. Independent operators join with small stake, together below the margin that keeps "any one F machine may fail" true (with four equal F machines: about 10 % of `T` in total **[est.]**) | Stages A–C live; onboarding criteria of the decentralization plan §9 | F still holds `q` | 2. Outsiders cannot halt. Their participation record is read from certificates (stage A), which the plan's O-7 could not do |
| 3. Move to the target (every operator below one third and still so after any one exit, e.g. the plan's 5-R shape) | Stage C live; records from step 2 | Independents raise stake first, **all becoming active at one epoch boundary** (§6.4), then F unbonds in one block | 2 operators, at every block of the transition |

Two orderings must be avoided. *F unbonds before others' stake is active:* total stake drops and a buyer's
thresholds drop with it (plan §5.1 "wrong order"); with unbonding the stake cannot be re-used for weeks, so F
funds its new keys from liquid XRGE first and unbonds afterwards. *Independents activate one at a time:* the
chain passes through two- and three-operator states in which each can halt alone; epoch activation exists to
make simultaneous activation a protocol fact instead of a timing hope.

### 8.5 Testnet rehearsal

Testnet has its own schedule (`upgrades.rs:85-99`). Each stage runs there first with at least four, ideally
seven, validators on separate keys (never mainnet keys) and no key above one third, for a soak period
**[est. two weeks per stage]** including: killing the proposer; killing two validators; a partition and its
healing; restart in the middle of a round; one key deliberately run on two machines (stage C: evidence must
appear and slash); a day with no transactions (heartbeats, epochs, unbonding release); and crossing the fork
height with one validator still on the old release.

---

## 9. Validation before any node code: CONSENSUS-0

A deterministic simulator, built before the node is touched and **run off the validator host**.

> **Status after stage 1 (Am.1, 2026-10-06).** The state machine, the chain rules, the simulator and the
> checkers exist (`research/consensus0/`, branch `research/consensus0`; results in its `RESULTS.md`) and
> pass on a small campaign. **The exit criteria are not met.** §9.1 gives the status of each criterion,
> §9.2 the measured results, §9.3 what stage 1 did not cover. Stage 1 implemented the first version of this
> document plus rules R1–R31; where Amendment 1 goes beyond them (§9.3) the simulator is behind the text.

**Shape.** The consensus rules are written once as a pure state machine with no clock, network or disk:
`step(state, input) → (state, outputs)`, where inputs are messages, timer expiries and "transaction pending",
and outputs are messages to send, timers to set, values to persist and commits. The simulator drives many
instances from one seeded event queue; the node later drives the same code from real I/O. What is tested is
then what ships.

**Model.**

| Element | Detail |
|---|---|
| Validators | 1 to 30, arbitrary integer stakes, including today's distribution, 4 equal, the plan's 5-R, and 50/30/20 |
| Network | Per-message delay drawn from a seeded schedule; drop; duplication; reordering; partitions with scripted start and end; a "stabilisation time" after which delays are bounded |
| Faults | Crash; crash and restart with and without the persisted state of §3.7 (the latter must be shown unsafe, to prove the test can see it); equivocating proposer; double-voting validators; validators that vote nil always; a proposer that omits signatures or transactions |
| Chain behaviour | On-demand heights and heartbeats (§3.4); set changes at epoch boundaries; unbonding; jailing; evidence inclusion; reward payment |
| Clocks | Per-validator offset, to exercise the T2 bound |

**Properties checked on every run.** P3, P4, P7 and P9 are restated by Amendment 1; the others are unchanged.

| # | Property |
|---|---|
| P1 Agreement | No two honest validators commit different blocks at one height, whenever faulty stake is below one third |
| P2 Validity | Every committed block was proposed by a scheduled proposer and passes block validation |
| P3 Accountability (restated; Am.1: F3, R31) | Whenever two different blocks each receive precommits `≥ q` **in the same round** of one height, duplicate-vote evidence exists against keys holding at least `2q − T`. "Exists" means: among the votes signed by or delivered to non-Byzantine validators there are, for each of those keys, two conflicting votes in one slot. **Nothing is claimed for blocks committed in different rounds**: such a fork leaves no duplicate vote (§4.1.1) |
| P4 Liveness (made precise; Am.1: R23) | After stabilisation, with faulty stake below one third and a transaction pending **at every running honest validator**, a block commits within a bounded number of rounds. As checked: commit round `≤ 3n + 10` for every height whose predecessor committed after stabilisation, and at the end of the run every running honest validator is at the chain tip, idle, with no admissible transaction left. The bound `3n + 10` is the simulator's choice, not a derived one |
| P5 No stuck locks | After a partition heals, no honest validator stays locked on a block that cannot be committed (the Release 2b defect) |
| P6 Proposer fairness | Over a long run with a fixed set, each validator's share of round-0 slots equals its stake share to within one slot; the 50/30/20 table of §3.3 is reproduced exactly |
| P7 Reward conservation (made precise; Am.1: R27) | For every block, in quanta, exactly: `credits + burn + unearned = fees + subsidy`; the reserve's net change is `unearned − subsidy`; total supply (liquid + bonded + pending + unbonding + burned) never changes; an offline validator's balance never rises |
| P8 Slash conservation | Each unit of stake is cut at most once; bonded + unbonding + burned is conserved |
| P9 Jail safety (restated; Am.1: F2, R19) | A validator is jailed only if **the certificates it is absent from** were assembled by at least `m` distinct proposers. Consequently no group of fewer than `m` proposers can jail a validator by omitting it, however many slots the group holds. Jailing never leaves a remaining key at or above one third of the remaining stake. **Not claimed:** that an honest validator slower than the commit wait is never jailed (§3.6, F9) |
| P10 Replay | Re-running a recorded message schedule yields identical states and hashes |

**Measurements.** Bytes per vote, per certificate and per block of consensus traffic at 4, 10 and 30
validators with real ML-DSA-65 sizes (to confirm §2.2); certificate bytes per day under each heartbeat
interval; time to finality in the normal case and with 1, 2 and 3 consecutive absent proposers under each
timeout setting of §3.5 and delays of 50 ms, 200 ms, 1 s and 3 s; rounds per height under partitions; and
ML-DSA signing and verification cost per block at 30 validators on validator-class hardware.

**Exit criteria.** All properties hold over a large seeded campaign **[est. 10^6 schedules]** and over
exhaustive exploration of small cases (4 validators, 2 rounds); the deviations D1–D7 each have targeted tests;
an independent reviewer has read the state machine against Algorithm 1 line by line (the same review the
Release 2 design §3 asked for). The criteria are unchanged by Amendment 1; they apply to the design as
amended, so the simulator must first be brought up to this text (§9.3).

### 9.1 Status of the exit criteria after stage 1

| Criterion | Done in stage 1 | Remains |
|---|---|---|
| All properties over a campaign of about 10^6 schedules | 15,280 schedules (1.5 % of the target) on the validator host, throttled: zero violations of P1–P10, with P3 not applicable below the fault bound | The 10^6 campaign, **on a machine that is not a validator**: about 57,000 CPU-seconds, **≈ 16 CPU-hours** (14 of them for the 30-validator share), roughly one hour of wall time on an idle 16-core machine, under 60 MB of memory per job. A script for it exists in the simulator directory |
| Exhaustive exploration of 4 validators × 2 rounds | 3 validators × 1 round and 3 × 2 rounds explored completely, no violation. Every 4-validator case stopped at the 75 s time limit, none complete, no violation in what was reached | **Not met.** Complete 4 × 2 exploration needs either far more states on another machine or a partial-order reduction in the explorer, which is not written |
| Targeted tests for D1–D7 | All seven have tests, and so do the stuck-lock scenario, absent proposers, unbonding inside and outside the window, the activation boundary and today's stake | Nothing for D1–D7 as such. Tests for the rules Amendment 1 adds (§9.3) |
| Independent line-by-line review against Algorithm 1 | Not started; it cannot be done by the author of the code. The state machine carries sixteen line tags (§3.5), **all written from memory and unverified against the paper's text** | The review itself, by someone who did not write the code, with the paper's text in hand. It MUST cover the knowing differences: R1, R1b, R2, R6, R7, R8 and the on-demand start (D2) |

Further items that stage 1 itself reported as open, each to be closed before the criteria can be called met:

| Item | State |
|---|---|
| 443 of the 15,280 runs did not go quiet before the simulator's hard stop | In each of them every running non-Byzantine validator was idle at the chain tip with nothing admissible pending (which is what P4 checks). The leftover activity is presumed to be on Byzantine-behaviour nodes or evidence gossip. **Not investigated; to be investigated**, because "presumed" is not a result |
| Randomised faults do not include lock-breaking across rounds | The simulator's colluding validators equivocate within a round; the cross-round case is covered by one scripted test and, for honest validators, by restart without state. A randomised behaviour that breaks locks across rounds is needed before the P1 and P3 results can be read as covering it |
| P8 has no negative test | Nothing shows the slash-conservation checker firing on a broken rule. A planted mutation is needed |
| P4 and P5 have no planted mutation | They fired on three real defects during development (among them F1 and F4), which shows they can; that is not a regression test |
| P6 "within one slot" | Held everywhere tried (worst 0.988); not proved (F14) |
| Proposer-priority rules against CometBFT; "duplicate proposals are not slashed"; LC1's time rules beyond T1 and T2; the T2 drift value | Not checked against their sources. Every **[confirm]** in this document stands |
| The "plan5" stake profile | Assumed as five operators at 24 / 22 / 20 / 18 / 16 %, because the decentralization plan was not available in the simulator's worktree. To be replaced by the plan's real 5-R shape |
| ML-DSA-65 signing and verification cost | Not measured: the simulator models signatures. By count, at 30 validators one round costs each validator 2 signatures (3 for the proposer) and about 89 verifications |
| A real network, real disks | Not covered. The persist-before-send order is tested as an output order; nothing is fsynced in the simulator |

### 9.2 Measured results of stage 1

**Campaign** (262 s of CPU, faults drawn from the simulator's classes — crash, restart with and without
state, equivocating proposer, double vote, coalition, nil voter, withholding proposer, stalling, mixed, and
partition — with total faulty stake strictly below one third): 15,280 schedules, 129,516 committed heights,
34.9 million validator inputs; 10,688 double-sign slashes and 168 downtime jailings occurred along the way.

| Validators | Stake profile | Schedules | Heights committed | Forks | P1–P10 violations |
|---:|---|---:|---:|---:|---:|
| 4 | equal | 4,000 | 33,159 | 0 | 0 |
| 3 | today (100,090,000 / 10,000 / 9,000) | 1,500 | 13,017 | 0 | 0 |
| 3 | 50 / 30 / 20 | 1,500 | 12,510 | 0 | 0 |
| 5 | plan5 (assumed) | 1,500 | 12,328 | 0 | 0 |
| 7 | random | 1,500 | 12,817 | 0 | 0 |
| 10 | equal | 2,500 | 21,433 | 0 | 0 |
| 10 | random | 2,500 | 21,647 | 0 | 0 |
| 30 | equal | 140 | 1,303 | 0 | 0 |
| 30 | random | 140 | 1,302 | 0 | 0 |
| | **Total** | **15,280** | **129,516** | **0** | **0** |

| Property | Runs it applied to | Result |
|---|---:|---|
| P1 Agreement | 15,280 | 0 violations |
| P2 Validity | 15,280 | 0 (every committed block replayed by an independent ledger from genesis) |
| P3 Accountability | 0 below the bound (no fork to judge) | Above the bound, in a separate run with half the stake colluding (246 schedules): 23 forks, evidence against `≥ 2q − T` in all 23. A scripted cross-round fork has no evidence: the first version of P3 was false (F3) |
| P4 Liveness | 15,280 | 0 (three real failures found and fixed on the way: F1, F4 and a restart defect in the simulator) |
| P5 No stuck locks | 15,280 | 0 (F1 was a stuck lock) |
| P6 Proposer fairness | 15,280 | 0; worst error 0.967 slot in the campaign, 0.988 over 65 stake shapes × 3,000 slots |
| P7 Reward conservation | 15,280 | 0 |
| P8 Slash conservation | 15,280 | 0 (10,688 slashes) |
| P9 Jail safety | 15,280 | 0 (168 jailings) |
| P10 Replay | 1,528 | 0 |

**Rounds needed to commit.**

| Scenario | Round 0 | Round 1 | Round 2 | Round 3 | Higher |
|---|---:|---:|---:|---:|---|
| Campaign, mixed faults below one third (129,516 heights) | 121,422 (93.75 %) | 7,637 (5.90 %) | 435 | 15 | rounds 4, 5, 6, 8, 12, 16 and 18, once each |
| Partitions and loss only, 4 validators, 2,000 schedules | 94.9 % | 5.1 % | — | — | — |
| Partitions and loss only, 10 validators, 600 schedules | 94.2 % | 5.7 % | one height | — | — |

**Bounded exhaustive exploration** (one height, every interleaving of deliveries and timeouts, 75 s limit per case):

| Case | States | Transitions | Complete? | Violations or stuck states |
|---|---:|---:|---|---|
| 3 validators × 1 round | 16,111 | 78,381 | **yes** | none |
| 3 validators × 2 rounds | 974,231 | 6,106,515 | **yes** | none |
| 4 validators × 1 round | 757,760 | 7,390,969 | no (time limit) | none so far |
| 4 validators × 2 rounds | 774,144 | 7,564,928 | no (time limit) | none so far |
| 4 × 2, one Byzantine validator | 987,136 | 5,393,782 | no (time limit) | none so far |
| 4 × 2, permuted order | 868,352 | 3,959,820 | no (time limit) | none so far |
| 4 × 2, Byzantine, permuted order | 733,184 | 5,267,737 | no (time limit) | none so far |

**Can the checkers see failures?** Each row breaks one rule on purpose; the named property must fire.

| Broken rule or situation | Must be caught by | Fired? |
|---|---|---|
| Restart without persisted state, 600 schedules | P1 | Yes: 15 of 600 schedules fork. With state: none |
| Faulty stake of one half, 120 schedules | fork reachable; P3 | 13 forks, evidence `≥ 2q − T` in all 13 |
| Cross-round fork (scripted) | P3 as first written | P3 as first written fails: no duplicate vote exists (F3) |
| No lock on precommit | P1 | Yes |
| Quorum of `⌊2T/3⌋` instead of `q` | P1 | Yes |
| Schedule not weighted by stake | P6 | Yes |
| Jailing without the distinct-proposer rule | P9 | Yes |
| §4.4 rule 2 as first written | P9 | Yes (this is F2) |
| Rounding leak in rewards | P7 | Yes |
| Tampered block, changed proposer, removed schedule entry | P2, P2, P10 | Yes, all three |
| Any broken slashing rule | P8 | **No test exists** |

**Consensus traffic per block**, one round, all honest. The figures of §2.2 are reproduced exactly:

| Validators | Votes signed | Distinct vote + proposal-signature bytes | Vote deliveries | Vote bytes sent network-wide | Certificate, all signers |
|---:|---:|---:|---:|---:|---:|
| 4 | 8 | 30,157 | 24 | 80,544 | 13,284 |
| 10 | 20 | 70,429 | 180 | 604,080 | 33,139 |
| 30 | 60 | 204,669 | 1,740 | 5,839,440 | 99,321 |

One vote is 3,356 B on the wire. Time to finality is in §3.5, certificates per day in §3.4, certificate
completeness in §3.6.

### 9.3 What the simulator does not yet reflect

Amendment 1 states some rules that go beyond what stage 1 implemented. Until the simulator has them and the
campaign has been re-run, they are design text without test evidence:

| Rule in this document | Simulator today |
|---|---|
| Evidence against a tombstoned key is inadmissible (§4.2 rule 5) | Implements R28: such evidence is valid and cuts nothing |
| The active set can never be empty (§6.4) | No such rule; a test shows the permanent halt |
| A validator with pending work re-offers it periodically (§3.4) | Evidence is gossiped like transactions (R11); no periodic re-offer |
| Bounds on stored rounds and on blocks per round (§3.8) | None |
| Anything the owner decides in §12 (a time-based downtime window, immediate unjail, justification rounds in votes, late inclusion) | Not modelled |

Sampled, not exhaustive, in stage 1: clock offsets up to 0.8 s; delays up to 9 s before stabilisation and
0.4 s after; at most two partitions per run. Out of scope for the simulator so far: stages D and E (key
separation, rotation, delegation, commission), the dynamic base fee, transaction signatures, and LC1's
header format and light-client rules.

---

## 10. Decisions for the owner

All eleven decisions were taken by the owner on 2026-10-06; the outcome is recorded in bold in each row.
Amendment 1 changes none of the outcomes. Where it touches a decision the row says "see Amendment 1" and
names the place; the questions it raises are in §12.

| # | Decision | Recommendation | If the alternative is chosen |
|---|---|---|---|
| 1 | Protocol family | Tendermint, following the published algorithm (§2.4). **DECIDED by the owner 2026-10-06: adopted, with ML-DSA-65 as the only vote signature scheme.** | HotStuff: transactions before a quiet period are not final without filler blocks, and more new machinery. Current + Release 2b: fewer votes, but the known stuck-round defect has to be fixed by inventing rules nobody has reviewed |
| 2 | Round timeouts | Moderate: propose 6 s + 2 s per round, votes 2 s + 1 s, cap 120 s; tune after CONSENSUS-0 and testnet  **DECIDED by the owner 2026-10-06: adopted as the starting point.** *See Amendment 1: measured recovery times replace the estimates (§3.5, F5); the decided values are unchanged.* | Fast: quicker recovery from an absent proposer, more wasted rounds on slow links. Slow: fewer wasted rounds, 20 s and more of delay whenever a proposer is absent |
| 3 | Empty blocks | Heartbeat every hour (LC1 D-6 default); no other empty blocks  **DECIDED by the owner 2026-10-06: adopted.** *See Amendment 1: at this interval the certificate-count downtime window spans more than four days (§4.4, F7; §12 item 2).* | None: time-based unbonding, jailing, epochs and light-client freshness all stall when the chain is idle. Every 10–15 minutes: fresher, 4–6 times the certificate storage (§3.4) |
| 4 | Penalties | Double-sign: 100 % and permanent removal while only self-stake exists, burned, no reporter reward; revisit before delegation. Downtime: jail 1 hour after missing more than 100 of 200 certificates across at least 3 proposers, no slash  **DECIDED by the owner 2026-10-06: adopted.** *See Amendment 1: the 3-proposer rule is restated so that it counts the proposers behind the absences (§4.4, F2); the 1-hour jail is in effect 25 to 49 hours (F6; §12 item 1); the 100-of-200 window is more than four days at the hourly heartbeat and cannot act with today's stake (F7; §12 item 2); double-sign slashing does not reach cross-round forks (§4.1.1, F3; §12 item 4).* | Lower double-sign fraction: cheaper attack, gentler on an operator who ran a key twice. Slashing for downtime: punishes outages that harm nobody but the validator. Reporter reward: copied evidence and proposer front-running |
| 5 | Unbonding period = evidence window | 21 days of header time  **DECIDED by the owner 2026-10-06: adopted.** *See Amendment 1: the window is inclusive and evidence is applied before releases in the same block (§4.2, R14).* | Shorter: stake leaves before misbehaviour can be punished and new nodes need fresher checkpoints. Longer: safer, less attractive to stakers. Keeping 500 blocks: the period is unpredictable and can be very short under load |
| 6 | Active-set cap, minimum self-bond, timing of set changes | Cap 32; 10,000 XRGE in consensus; additions at a daily epoch boundary after 24 h, removals at once. **DECIDED by the owner 2026-10-06: adopted with the minimum raised to 100,000 XRGE, and a 30-day grace period after activation for validators already in the set to reach it; a validator still below the minimum after the grace period leaves the active set at the next epoch boundary.** *See Amendment 1: with today's stakes this removes the two small validators after the grace and leaves a set of one (§6.4, F8; §12 item 3); the active set may never become empty (§6.4, F13); the cap is applied at epoch boundaries only (R18).* | Larger cap: more open, certificates grow by 3.3 kB per validator per block. No delay: a buyer's stake counts at the next block. Lower minimum: cheaper squatting |
| 7 | Commission bounds | Floor 5 %, validator-fixed ceiling up to 50 %, change at most 1 point per epoch  **DECIDED by the owner 2026-10-06: adopted.** | No floor: large operators can attract all delegation at 0 %. No change limit: a validator can raise commission to the ceiling overnight |
| 8 | Interim admission control | Approval by `≥ q` of current stake, announced as temporary with a written exit condition. **DECIDED by the owner 2026-10-06: adopted.** *See Amendment 1: how approvals are tallied is now stated (§6.4, R17).* | None: anyone who can buy enough XRGE can halt or take the chain from the next epoch. Permanent: the chain is permissioned in fact |
| 9 | Reserve subsidy | Replace the 0.1 XRGE per-block floor with a per-time rate; choose `RATE` as a budget  **DECIDED by the owner 2026-10-06: adopted. Finding: the live mainnet `__staking_rewards__` balance is 0 XRGE (the repository genesis value of 10.8 B was never applied on mainnet), so the existing floor has paid nothing. The owner will fund the reserve by a plain transfer; `RATE` is then set to spend that budget over about two years with a full set of 32.** | Keep the floor: any proposer can farm it with minimum-fee transactions once proposers rotate (§5.3). `RATE = 0`: no income for operators beyond negligible fees |
| 10 | Order of stages and relation to LC1 | A → B → C → D → E; stage B before LC1's activation, or folded into LC1's text first  **DECIDED by the owner 2026-10-06: adopted.** | C before B: double-signing becomes slashable sooner, jailing still waits. LC1 first: rounds later force a new header version and a new light-client instance (LC1 D-11) |
| 11 | CONSENSUS-0 and independent review as a gate | No node code for stage B before §9's exit criteria are met  **DECIDED by the owner 2026-10-06: adopted.** *See Amendment 1: stage 1 is done and the criteria are not yet met (§9.1).* | Faster start, with protocol errors found on testnet or mainnet instead of in a simulator |

---

## 11. What this document does not do

It changes no code, schedule, key, stake or configuration (nor does Amendment 1); proposes no activation height; does not assess the
market value or liquidity of XRGE; does not redesign the bridge or its authority; and does not replace LC1 or
the decentralization plan — it names where they must be amended (§8.3) and relies on the plan's arithmetic and
onboarding criteria. Open points the code left ambiguous to me: whether any block-size limit exists outside
`import_block` (§1.1); the live balance of `__staking_rewards__` and the live validator stakes (§1.1, §5.3);
and whether the genesis fields `min_stake` and `max_validators` (`core/daemon/genesis.json:5-6`) are read by
any consensus path — the stake apply path I read does not use them (`node.rs:7006-7025`).

---

## 12. Owner decisions needed after Amendment 1

None of the eleven decisions of §10 is reopened as such. Testing showed that some of them have consequences
that were not visible when they were taken, and that a few questions were never asked. Each item below says
what was found, what is recommended, and what happens if the other choice is made. Nothing here is urgent
for the live chain: all of it concerns rules that are not yet built.

### 12.1 The four main questions

**1. How long is a validator really out after being jailed for downtime? (F6)**

*DECIDED by the owner 2026-10-07: keep the rule and describe it truthfully — "jailed for at least 1 hour; returns at the first daily epoch boundary at least 24 hours after asking" (in practice 25 to 49 hours).*

*What was found.* The decision says "jail 1 hour". The same design says a jailed validator comes back like
any newcomer: at the next daily changeover that is at least 24 hours after it asks to return. Put together,
a validator jailed for "1 hour" is out for about **25 to 49 hours**.

*Recommendation.* Keep the rule and describe it truthfully: "jailed for at least 1 hour; returns at the first
daily epoch boundary at least 24 hours after asking". This is what was simulated, it needs no new rule, and
a day or two out is proportionate for a validator that had to be absent for a long time to be jailed at all
(see item 2).

*If the alternative is chosen* (return at the next block once the hour has passed): validators with a short
outage are back quickly and lose less income. In exchange, the set of validators can change at a moment
chosen by the returning validator instead of only at the daily changeover, which is the protection the
24-hour delay exists to give; the rule must be added to the simulator and re-tested, and LC1 must allow an
addition between epoch boundaries.

**2. How long must a validator be offline before it is jailed? (F7)**

*DECIDED by the owner 2026-10-07: adopt the time-based window recommended below (last 24 hours of chain time, at least 12 certificates concerning the validator, absent from more than half, absences under at least 3 different proposers), replacing "100 of the last 200 certificates". It must be added to the simulator and tested before it is relied on.*

*What was found.* The decision counts blocks: "absent from more than 100 of the last 200 certificates". On a
quiet chain there is one block an hour, so 101 missed certificates is **more than four days offline**. On a
busy chain the same rule could act within minutes. The number means something different every day. Also,
whatever the window, **no validator can be jailed at all while one key holds 99.98 % of the stake**: the
safety rule that stops jailing from concentrating power forbids it. That is consistent with the planned
order of work, but it was not written down.

*Recommendation.* Replace the block count with a time window, keeping everything else: a validator is jailed
when, among the certificates of the last 24 hours of chain time, at least 12 concern it and it is absent
from more than half of them, the absences coming from at least 3 different proposers. At the hourly
heartbeat on a quiet chain this acts after a little more than 12 hours offline. The state it needs stays
small (it can be kept as 24 hourly totals per validator). It must be added to the simulator and tested
before it is relied on; one refinement to test there is counting "hours in which the validator was mostly
absent" instead of raw certificates, so that one very busy hour cannot outweigh a quiet day.

*If the alternative is chosen* (keep 100 of 200): a validator can be offline for four days on a quiet chain
and still be counted in the total and block a share of the quorum, while on a busy chain a short outage
could be enough to jail it. Nothing breaks; the rule is simply unpredictable.

**3. The 100,000 XRGE minimum removes both small validators after 30 days (F8)**

*DECIDED by the owner 2026-10-07: keep 100,000 XRGE. Every validator that is meant to stay is topped up, or told the date and amount, before stage A is given an activation height; "all intended validators are at or above the minimum" is a condition for scheduling stage A.*

*What was found.* The two small validators hold 10,000 and 9,000 XRGE. The decided minimum is 100,000 with a
30-day grace. If nothing else happens, both leave the active set when the grace ends and the chain is back
to **one validator**. (A new rule in this amendment guarantees that the last validator can never be removed,
so the chain would not stop — but it would have no second signer.)

*Recommendation.* Keep 100,000 XRGE. Before stage A is given an activation date, make sure each validator
that is meant to stay has at least 100,000 XRGE bonded, or has been told the date by which it must, with
the 24-to-48-hour activation delay in mind. Treat "all intended validators are at or above the minimum" as
a condition for scheduling stage A.

*If the alternative is chosen* (lower the minimum to 9,000 or 10,000, or lengthen the grace): nobody needs
topping up. A low minimum makes it cheap to occupy validator slots: filling all 32 slots costs 32 times the
minimum, 320,000 XRGE at 10,000 against 3,200,000 at 100,000. A longer grace only postpones the same
question.

**4. A fork made by breaking locks across rounds cannot be punished (F3)**

*DECIDED by the owner 2026-10-07: accept the restated guarantee for now. The justification-round remedy (§4.1.1) is to be written up as its own design and tested in the simulator; the owner takes the yes-or-no decision on it before the format of the new votes is frozen for stage B.*

*What was found.* The design promised that anyone who helps create two conflicting blocks can be proved
guilty and lose their stake. Testing showed this is true only when both blocks are approved in the same
voting round. If the attackers approve one block in one round and a different block in a later round, each
of their signatures looks legitimate on its own and **there is nothing to prove with**. Such an attack needs
more than one third of all stake, and a group that large can also simply stop the chain, so this is not a
new way to break the chain. It is a missing penalty. The document now says so plainly in every place that
claimed otherwise.

*Recommendation.* Accept the restated guarantee for now, and have the known remedy — votes that state which
earlier round justifies them, 4 extra bytes per prevote, nothing added to the chain (§4.1.1) — written up
as its own design and tested in the simulator. Take the yes-or-no decision **before the format of the new
votes is frozen for stage B**, because adding a field to signed votes afterwards costs another change of
vote format.

*If the alternative is chosen.* Never adopting it: a group above one third can fork the chain without losing
stake. That matters little while stake is worth little (§5.4) and more once it has value and outsiders
delegate. Adopting it now without its own design: new, unreviewed rules at the centre of a protocol whose
main attraction is that it is published and proved; and the simple form still leaves a loophole (a
violator can sign a false claim that cannot be disproved from two signatures), so it could give a false
sense of completeness.

### 12.2 Smaller choices left open

| # | Question | Recommendation | If the other choice is made |
|---|---|---|---|
| 5 | Honest validators on slow links are left out of certificates when they answer later than the 0.5-second commit wait; they lose that block's reward and collect absences (F9, §3.6). Lengthen the wait, let later blocks add late signatures, or neither? | Decide after testnet has measured real delays between validators. Keep 0.5 s until then. The wait is a per-node setting and can be changed without a fork; late inclusion is a rule change | Lengthening now: every quiet-period block starts up to that much later, for a problem not yet observed on a real network. Late inclusion now: 3,309 B per late signature and a new rule to review. Neither, ever: validators far from the others are paid less and jailed more easily |
| 6 | Recovery from an absent proposer takes about 9, 21 and 35 seconds for one, two and three in a row, more than first estimated (F5). Shorten it by moving on as soon as two thirds have voted "nothing"? | No. Keep the published rules and the decided timeouts; revisit with testnet data | Recovery is 2, 3, 4 … seconds faster per failed round, at the price of another departure from the published algorithm that the independent review must then cover |
| 7 | The last remaining validator is proved to have double-signed. Slashing it would empty the validator set and stop the chain for good (F13) | Hold the evidence: it is not accepted while it would empty the set, and stays usable for the 21-day window once another validator is active | Apply it and halt: the chain stops until a new release names a new set. In either case a sole validator is the only block producer and could keep the evidence out anyway |
| 8 | Limits on how many future rounds and how many competing blocks a node stores (F11, F12, §3.8) | Have the values and the discard rule set in the stage B implementation design and tested in the simulator; make that part of the gate of decision 11 | No limits: a faulty validator can fill other nodes' memory. Limits chosen without tests: a risk of honest validators being unable to follow the others |
| 9 | From when do the 30 days of grace run? Decision 6 says "after activation"; the minimum arrives with stage A (R24) | From the activation of stage A | From a later stage: a longer effective grace, and the minimum is not enforced on existing validators until then |
| 10 | Evidence for an **earlier** offence arriving after a later one was punished is rejected by the floor rule as quoted from LC1 (§4.2), so funds withdrawn between the two offences are not reached | First check LC1 §17.9's text **[confirm]**; if it reads as quoted, amend it so that earlier-offence evidence can still cut those withdrawals | Left as is: which offence is reported first decides how much is slashed |

### 12.3 What is not asked

The independent review, the large campaign off the validator host, the complete small-case exploration and
the open simulator items of §9.1 and §9.3 are work, not decisions: they are already required by decision 11.
