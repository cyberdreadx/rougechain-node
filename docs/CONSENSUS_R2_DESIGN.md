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
| Accountability | Conflicting prevotes or precommits in one `(height, round)` are self-contained evidence. Breaking a lock across rounds is not provable from two signatures | Similar | Precommit + skip in one round |

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

---

## 3. The protocol as it would run here

### 3.1 Per-validator state

`height`, `round`, `step ∈ {propose, prevote, precommit}`, `locked_round` and `locked_block` (initially none),
`valid_round` and `valid_block` (initially none). All but `step` timers are persisted (§3.7).

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
B. A large validator can therefore hold consecutive rounds, each costing one propose timeout. (In this example
A holds half the stake, so the chain could not commit without it in any case: §7.)

### 3.4 When a height starts, and empty blocks

A validator that has committed `h−1` waits in "new height" and enters round 0 of `h` (starting the propose
timeout) when the first of these happens:

1. it holds an admissible pending transaction or evidence item;
2. a heartbeat is due: its clock is at or past `time(h−1) + T_HB`;
3. it receives a valid proposal for `(h, any round)`;
4. it has received votes for height `h` from validators holding at least `t1`.

Rule 4 is Algorithm 1's "more than one third are in a later round, so join them" applied to the waiting
state; it guarantees that validators whose mempool is empty do not hold back a round that the others have
started. A proposer whose mempool is empty and whose heartbeat is not due does not propose; if others have
work, their timers expire, they prevote nil, and the next round's proposer serves them. This is how a
withholding proposer loses its turn.

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
4, 10 and 30 validators; at 10 minutes, 1.9, 4.8 and 14.3 MB per day.

### 3.5 Round rules

These are Algorithm 1's rules with "2f+1" read as stake `≥ q` and "f+1" as stake `≥ t1`.

| Trigger (in round `r` of height `h`) | Action |
|---|---|
| Round starts and I am the proposer | Propose `valid_block` if I have one (with `pol = valid_round`), otherwise build a block with `header.round = r` |
| Round starts and I am not the proposer | Start the propose timeout |
| Valid proposal with `pol = none`, step is propose | Prevote the block if I am unlocked or locked on that same block; otherwise prevote nil. Step ← prevote |
| Valid proposal with `pol = vr < r` and prevotes `≥ q` for that block in round `vr`, step is propose | Prevote the block if `locked_round ≤ vr` or I am locked on that same block; otherwise nil. Step ← prevote. **This is the only way a lock is released** |
| Propose timeout, step is propose | Prevote nil. Step ← prevote |
| Prevotes `≥ q` for anything in round `r`, first time, step is prevote | Start the prevote timeout |
| Proposal and prevotes `≥ q` for that block in round `r`, first time, step ≥ prevote | If step is prevote: **lock** (`locked_block`, `locked_round ← r`), precommit the block, step ← precommit. In any case `valid_block`, `valid_round ← r` |
| Prevotes `≥ q` for nil in round `r`, step is prevote | Precommit nil. Step ← precommit |
| Prevote timeout, step is prevote | Precommit nil. Step ← precommit |
| Precommits `≥ q` for anything in round `r`, first time | Start the precommit timeout |
| Precommit timeout | Start round `r + 1` |
| Proposal and precommits `≥ q` for that block in **any** round `r'` | **Commit**: apply and append the block, store the certificate, go to height `h + 1` |
| Votes from stake `≥ t1` in a round `r' > r` | Start round `r'` |

"Valid proposal" means: signed by the scheduled proposer of `(h, r)`; the block's parent is my committed
`h−1` and it carries a valid certificate for it; `header.round ≤ r` and the header's proposer is the scheduled
proposer of `(h, header.round)`; header time obeys LC1 T1 (after the parent) and T2 (not more than the drift
bound ahead of my clock) — a T2 failure is a nil prevote in this round, not a rejection of the block for ever;
every transaction rule of §1.1 holds; and speculative execution reproduces `state_root`. Execution uses the
existing snapshot-and-restore path (`node.rs:1593-1641`) and always restores; nothing is appended before commit.

**Timeouts.** `timeout_X(r) = min(base_X + r · delta_X, cap)`. Options, with estimated time to finality for a
one-way network delay of 0.2 s **[est.; to be measured in §9]**:

| Setting | Propose base / delta | Prevote and precommit base / delta | Cap | Normal case | One absent proposer | Two in a row |
|---|---|---|---|---:|---:|---:|
| Fast (CometBFT's defaults as I recall them **[confirm]**) | 3 s / 0.5 s | 1 s / 0.5 s | 60 s | ≈ 1 s | ≈ 5 s | ≈ 8 s |
| **Moderate (recommended start)** | 6 s / 2 s | 2 s / 1 s | 120 s | ≈ 1 s | ≈ 8 s | ≈ 16 s |
| Slow (Release 2 design §2.5 figures) | 20 s / 10 s | 5 s / 5 s | 300 s | ≈ 1 s | ≈ 22 s | ≈ 52 s |

The normal case is three message delays plus a short "commit wait" (0.5 s recommended) during which the next
proposer collects late precommits so that the certificate lists everyone (§3.6). Timeouts are per-node
settings; they affect speed and never safety. Validators need synchronised clocks only for the T2 bound.

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

### 3.7 What is persisted before signing

| Before | Must be durable (fsynced) | Exists today? |
|---|---|---|
| Any prevote or precommit | Journal slot `(chain, key, type, height, round) → block hash or nil` | Yes for round 0 and a hash (`journal.rs:103-136`); needs rounds and `nil` |
| Any proposal | Journal slot `(chain, key, height, round) → block hash`, plus the block | Partly: `(height, parent)` (`node.rs:3986-4011`) |
| A precommit for a block | `locked_round`, `locked_block` (full bytes) | No |
| Leaving a round | `height`, `round`, `valid_round`, `valid_block` | No |

On restart a validator reloads this state, never re-enters a round below the stored one, re-sends its
journaled votes (re-signing identical bytes is harmless, `journal.rs:12-14`) and resumes. A lock that is not
persisted is the classic way an honest validator breaks safety after a crash, so "no lock file, no precommit"
is the rule, in the same spirit as "no journal, no vote" (`node.rs:3360-3361`). As today, none of this
protects a key that runs on two machines; §4 makes that slashable.

### 3.8 Catching up

* **Behind by whole blocks.** Fetch blocks in order. Block `h` is accepted with a certificate for it: the one
  embedded in `h + 1`, or a standalone one for the tip. Verify, apply, append. Never sign anything for a
  height that is already committed locally or for which a valid certificate has been seen.
* **Inside the current height.** On connect, peers exchange `(height, round)` and which votes they hold; a
  late node receives the proposal and votes it lacks. The `≥ t1` rule moves it to the current round, and the
  commit rule lets it commit from any round.
* **Unchanged:** a node never replaces a committed block (`peer.rs:201-207`). With commit-before-append there
  is no longer an uncommitted tip to be stuck on (scenario 6).

---

## 4. Accountability

### 4.1 Offences and evidence

| Offence | Evidence | Penalty |
|---|---|---|
| **Duplicate vote**: two prevotes, or two precommits, by one key for the same `(chain, height, round)` with different `block` values (a hash against another hash, or against nil) | The two signed votes | Slash and permanent removal (§4.3) |
| Duplicate proposal for one `(height, round)` | — | Not slashed at first, as in CometBFT **[confirm]**: the proposer that exploits it must also double-vote, which is caught above. Add later if wanted (LC1 D-13) |
| Breaking a lock across rounds ("amnesia") | Not provable from two signatures | None. This is why honest locks must be durable (§3.7) |
| Precommit on a block whose parent is not canonical (LC1 E2) | One vote + the header | Owner decision LC1 D-13; this design does not need it |
| Downtime | Absence from commit certificates (§4.4) | Jail, no slash |

### 4.2 Evidence transaction

A new typed item, not a signed user transaction and **not** the `slash` type: LC1's E1 envelope (LC1 §17.2,
9,704 B) with `round` (u32) and `vote_type` (u8) added — 9,709 B: offender key, the two block values, the two
signatures, and a proof that the key was in `E(height)`. Anyone may submit it; it pays no fee; a block may
carry a bounded number. Verification in block `b`, all deterministic:

1. `height < b`, and the header time of `b` minus the canonical header time at `height` is within the evidence window.
2. The key was eligible at `height` (LC1 §17.4 opening, or the node's stored set for that height).
3. Both signatures verify over the §3.2 bytes (or the V2 bytes for a pre-fork height) for the same
   `(height, round, type)` and different `block` values.
4. The key is not already penalised for an offence at or below this height (LC1 §17.9's floor rule, which
   makes each unit of stake slashable once).

Invalid evidence makes the block invalid. A node that receives a vote conflicting with one it holds builds
the evidence itself instead of only rejecting it, as it does now (`lib.rs:95-97`).

### 4.3 Slashing

* **Amount.** `cut(x) = ⌊x · NUM / DEN⌋`, computed exactly (LC1 §17.7 gives the overflow-free form; the
  existing `units::mul_div` saturates on wide products, `units.rs:74-80`, and must not be used here). It
  applies to the validator's own bond, to every delegation to it (§6), and to unbonding entries created at or
  after the offence height. **Recommended: 100 % while only self-stake exists; decide again before delegation
  opens** (decision 4). Rationale: honest software cannot commit this offence on one machine (`journal.rs`),
  so the only honest victim is an operator running one key twice, which the onboarding rules forbid.
* **Removal.** The key is tombstoned: never eligible again (LC1 `TOMBSTONE`). The operator may withdraw what
  is left after unbonding and start again with a new key.
* **Destination.** Slashed stake is **burned**, with an explicit state counter. Today a cut is simply
  subtracted and credited nowhere (`node.rs:7573-7577`). No reporter reward: evidence can be copied and the
  proposer can always claim it (LC1 D-8). Not the treasury: nobody who can influence slashing should gain from it.

### 4.4 Downtime: jailing from certificates

Once certificates list all signers and proposers rotate, absence is an on-chain fact. Per validator, state
keeps a bitmap over the last `W` certificates. A validator is jailed when **all** of these hold:

1. it is absent from more than `M` of the last `W` certificates;
2. those `W` certificates were assembled by at least `m` distinct proposers (so one proposer cannot jail a
   rival by omitting it — the objection in the decentralization plan §7 item 6);
3. jailing it would not leave any single remaining key with one third or more of the remaining stake, and
   would not bring the stake jailed inside the window above one third of `T` (the plan's cap; otherwise
   jailing could hand the chain to whoever is left).

Effect: removed from `E` from the next height for at least `JAIL_MS` of header time; no slash; rewards stop
because it is not a signer. It returns by an `unjail` transaction signed by its operator key after the jail
time, and its bitmap restarts. Starting values **[est., decision 4]**: `W = 200`, `M = 100`, `m = 3`,
`JAIL_MS` = 1 hour. Jailing only helps while the chain still commits, that is while offline stake is at most
`T − q`; beyond that the chain halts safely and returns when validators do.

### 4.5 Unbonding period and evidence window

Stake that signed must stay slashable for as long as evidence is accepted, or a validator can unstake, wait,
and then publish conflicting history at no cost. Therefore: unbonding becomes time-based
(`release_at = header time + UNBONDING_PERIOD`), unbonding entries are slashable, and
`EVIDENCE_MAX_AGE = UNBONDING_PERIOD` — exactly LC1 §15.3–§15.4 and §17.8. **Recommended: 21 days** (LC1 D-5
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

### 5.2 Properties

* **An offline validator earns nothing**: it is not in `S`, and it does not propose.
* **Omitting a signature never pays.** Because each signer's share is divided by `T`, not by the stake that
  was included, leaving out validator `j` does not raise anyone's `vote_i`; it lowers the proposer's own
  `prop_incl` by `(15 % of pool) · s_j / T`. The withheld share goes to the reserve, not to the proposer.
* **Why this is enough without late inclusion.** A proposer could still omit a rival at a loss to itself. The
  rival loses one block's share only when that proposer has the turn, and jailing ignores omissions by fewer
  than `m` proposers (§4.4). Letting later blocks add missed signatures would close the remaining gap at
  3,309 B per late signature; it is left out unless CONSENSUS-0 or testnet data shows omission in practice.
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
| Minimum self-bond | 10,000 XRGE, enforced in consensus (today API-only, `main.rs:6605-6609`; LC1 §9.5). Falling below it (by unbonding or a slash) removes the validator from the active set | A validator must have its own funds at risk |
| Active-set cap | 32 by weight, ties to the lowest key hash; the rest are candidates (bonded, not voting, not paid, not jailable) | 99 kB certificates at 30 (§2.2); LC1 D-4 lists 32 |
| Commission | Floor 5 %, ceiling fixed by the validator at creation and at most 50 %, change at most 1 percentage point per epoch | A floor stops a large operator buying delegations at 0 %; the change limit stops a sudden jump to 100 % |
| Delegation concentration | A new delegation is refused if it would take the validator above 25 % of active weight | Soft brake only; it cannot stop one operator running several validators |
| Epoch | The first block whose header time crosses a 24-hour boundary | Needs heartbeats (§3.4) |
| Additions (new validator, more stake or delegation, unjail, key rotation, entering the active set) | Take effect at the first epoch boundary at least `ACTIVATION_DELAY` (24 h) after inclusion | Makes set changes predictable and visible in advance (§7) and lets several validators become active at the same height (§8.4) |
| Removals (unbond, slash, jail, falling out of the cap) | Next height, as today | A removal must not be delayable |

### 6.5 Before delegation may be enabled

1. §4 is live: evidence, slashing of bonded and unbonding stake, time-based unbonding, downtime jailing.
2. §5 is live: an offline validator earns nothing, so delegators get a signal.
3. §6.1 is live: delegated stake cannot be redirected by whoever steals a server key.
4. No single operator holds one third or more of weight, with at least four independent operators (the
   decentralization plan's target). Until then a delegator's funds are slashable at the discretion of whoever
   controls the proposer slot and the quorum (LC1 §17.11), and delegation would only concentrate weight further.
5. The 256-bit reward arithmetic has test vectors and the conservation property (§9) holds over long runs.

---

## 7. Security analysis

"Faulty" means stake that is offline or malicious. Guarantees assume every honest validator keeps durable
state (§3.7) and runs each key on one machine.

| Adversary | Safety (no two blocks committed at a height) | Liveness | Notes |
|---|---|---|---|
| Faulty stake at most `T − q` (less than one third) | **Guaranteed** | **Guaranteed** once the network delivers within the timeouts: some round has an honest proposer and enough honest votes | Censorship is limited to the faulty proposers' own turns |
| Crash-only faults `< T/3` | Guaranteed | Guaranteed; each absent proposer costs one propose timeout | The "one operator's machine is down" requirement is met when no machine holds `> T − q` |
| Malicious stake of `2q − T` or more (above one third) but below `q` | **Not guaranteed**: with control of message delivery it can commit two blocks. Both certificates share signers holding at least `2q − T`, who are provably double-signers once evidence exists (§4) | Not guaranteed: it can stop the chain by not voting. That is a halt, never a fork | Slashing makes the safety attack cost the overlap's stake — which is only a deterrent if stake has value |
| Malicious stake `≥ q` (more than two thirds) | None. It can commit anything, including invalid state transitions on its own nodes' say-so; honest full nodes reject invalid blocks but cannot outvote | None | No BFT protocol helps. Evidence can be censored (LC1 §17.11). Today one key is in this position |
| Network partition, no malicious stake | Guaranteed | The side with `≥ q` continues; if neither side has `q`, both stop and resume on healing. Locks made before the split are released only by the lock rule, so no stuck state (property P5, §9) | Today a partition can leave an appended, uncertified tip (scenario 6) |
| Long-range attack: keys that once held `≥ q` and have unbonded sign an alternative history | Full nodes: not affected, they never replace committed blocks (`peer.rs:201-207`). **New nodes and light clients are exposed** if they start from old data | — | Mitigated by: unbonding and evidence window of 21 days with slashable unbonding stake (§4.5); new nodes must start from a checkpoint younger than the unbonding period — compiled into the release (releases already pin history: `upgrades.rs:8-10`, and the checkpoint check at `node.rs:1607-1611`) or obtained from a trusted source; LC1's light client refuses checkpoints older than `MAX_CHECKPOINT_AGE` |
| Stale consensus key after rotation | As above for the retired key | — | Retired keys stay slashable for the evidence window (§6.1) |
| One key on two machines (honest mistake) | Can produce a real double-sign | — | Slashed like any other; this is the only honest path to a slash and it is avoidable |

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
| **Admission approval**: a new validator becomes active only after an `approve_validator` vote by validators holding `≥ q` (today: the founding operator) | Purchase of a blocking or controlling position by an unknown party, regardless of price | Permissioned: the incumbents can refuse anyone, and it is centralised for as long as one operator holds `q`. It must be announced as temporary, with a stated exit condition (for example: removed by fork once at least five independent operators are active and no operator holds one third). It does not stop an approved validator from being bought later, nor delegation to an approved validator, which is why delegation waits (§6.5) |

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
| **C. Accountability** | Evidence items and slashing with tombstones; time-based, slashable unbonding (integer amounts); downtime jailing and `unjail` | Evidence item; `unjail` | Tombstones with floors; unbonding entries by time; burn counter | Honest single-machine validators cannot be slashed; jailing has the concentration cap and the distinct-proposer rule |
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

**Properties checked on every run.**

| # | Property |
|---|---|
| P1 Agreement | No two honest validators commit different blocks at one height, whenever faulty stake is below one third |
| P2 Validity | Every committed block was proposed by a scheduled proposer and passes block validation |
| P3 Accountability | Whenever two blocks are committed at one height, evidence exists against keys holding at least `2q − T` |
| P4 Liveness | After stabilisation, with faulty stake below one third and a pending transaction, a block commits within a bounded number of rounds |
| P5 No stuck locks | After a partition heals, no honest validator stays locked on a block that cannot be committed (the Release 2b defect) |
| P6 Proposer fairness | Over a long run with a fixed set, each validator's share of round-0 slots equals its stake share to within one slot; the 50/30/20 table of §3.3 is reproduced exactly |
| P7 Reward conservation | For every block: credits + burn + reserve change = fees + subsidy, in quanta, exactly; an offline validator's balance never rises |
| P8 Slash conservation | Each unit of stake is cut at most once; bonded + unbonding + burned is conserved |
| P9 Jail safety | No sequence of omissions by fewer than `m` proposers jails an honest, online validator; jailing never leaves a key at or above one third |
| P10 Replay | Re-running a recorded message schedule yields identical states and hashes |

**Measurements.** Bytes per vote, per certificate and per block of consensus traffic at 4, 10 and 30
validators with real ML-DSA-65 sizes (to confirm §2.2); certificate bytes per day under each heartbeat
interval; time to finality in the normal case and with 1, 2 and 3 consecutive absent proposers under each
timeout setting of §3.5 and delays of 50 ms, 200 ms, 1 s and 3 s; rounds per height under partitions; and
ML-DSA signing and verification cost per block at 30 validators on validator-class hardware.

**Exit criteria.** All properties hold over a large seeded campaign **[est. 10^6 schedules]** and over
exhaustive exploration of small cases (4 validators, 2 rounds); the deviations D1–D7 each have targeted tests;
an independent reviewer has read the state machine against Algorithm 1 line by line (the same review the
Release 2 design §3 asked for).

---

## 10. Decisions for the owner

| # | Decision | Recommendation | If the alternative is chosen |
|---|---|---|---|
| 1 | Protocol family | Tendermint, following the published algorithm (§2.4). **DECIDED by the owner 2026-10-06: adopted, with ML-DSA-65 as the only vote signature scheme.** | HotStuff: transactions before a quiet period are not final without filler blocks, and more new machinery. Current + Release 2b: fewer votes, but the known stuck-round defect has to be fixed by inventing rules nobody has reviewed |
| 2 | Round timeouts | Moderate: propose 6 s + 2 s per round, votes 2 s + 1 s, cap 120 s; tune after CONSENSUS-0 and testnet | Fast: quicker recovery from an absent proposer, more wasted rounds on slow links. Slow: fewer wasted rounds, 20 s and more of delay whenever a proposer is absent |
| 3 | Empty blocks | Heartbeat every hour (LC1 D-6 default); no other empty blocks | None: time-based unbonding, jailing, epochs and light-client freshness all stall when the chain is idle. Every 10–15 minutes: fresher, 4–6 times the certificate storage (§3.4) |
| 4 | Penalties | Double-sign: 100 % and permanent removal while only self-stake exists, burned, no reporter reward; revisit before delegation. Downtime: jail 1 hour after missing more than 100 of 200 certificates across at least 3 proposers, no slash | Lower double-sign fraction: cheaper attack, gentler on an operator who ran a key twice. Slashing for downtime: punishes outages that harm nobody but the validator. Reporter reward: copied evidence and proposer front-running |
| 5 | Unbonding period = evidence window | 21 days of header time | Shorter: stake leaves before misbehaviour can be punished and new nodes need fresher checkpoints. Longer: safer, less attractive to stakers. Keeping 500 blocks: the period is unpredictable and can be very short under load |
| 6 | Active-set cap, minimum self-bond, timing of set changes | Cap 32; 10,000 XRGE in consensus; additions at a daily epoch boundary after 24 h, removals at once | Larger cap: more open, certificates grow by 3.3 kB per validator per block. No delay: a buyer's stake counts at the next block. Lower minimum: cheaper squatting |
| 7 | Commission bounds | Floor 5 %, validator-fixed ceiling up to 50 %, change at most 1 point per epoch | No floor: large operators can attract all delegation at 0 %. No change limit: a validator can raise commission to the ceiling overnight |
| 8 | Interim admission control | Approval by `≥ q` of current stake, announced as temporary with a written exit condition. **DECIDED by the owner 2026-10-06: adopted.** | None: anyone who can buy enough XRGE can halt or take the chain from the next epoch. Permanent: the chain is permissioned in fact |
| 9 | Reserve subsidy | Replace the 0.1 XRGE per-block floor with a per-time rate; choose `RATE` as a budget | Keep the floor: any proposer can farm it with minimum-fee transactions once proposers rotate (§5.3). `RATE = 0`: no income for operators beyond negligible fees |
| 10 | Order of stages and relation to LC1 | A → B → C → D → E; stage B before LC1's activation, or folded into LC1's text first | C before B: double-signing becomes slashable sooner, jailing still waits. LC1 first: rounds later force a new header version and a new light-client instance (LC1 D-11) |
| 11 | CONSENSUS-0 and independent review as a gate | No node code for stage B before §9's exit criteria are met | Faster start, with protocol errors found on testnet or mainnet instead of in a simulator |

---

## 11. What this document does not do

It changes no code, schedule, key, stake or configuration; proposes no activation height; does not assess the
market value or liquidity of XRGE; does not redesign the bridge or its authority; and does not replace LC1 or
the decentralization plan — it names where they must be amended (§8.3) and relies on the plan's arithmetic and
onboarding criteria. Open points the code left ambiguous to me: whether any block-size limit exists outside
`import_block` (§1.1); the live balance of `__staking_rewards__` and the live validator stakes (§1.1, §5.3);
and whether the genesis fields `min_stake` and `max_validators` (`core/daemon/genesis.json:5-6`) are read by
any consensus path — the stake apply path I read does not use them (`node.rs:7006-7025`).
