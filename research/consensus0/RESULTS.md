# CONSENSUS-0, stage 1 — results

> **Status, 2026-10-06.** Built and run on branch `research/consensus0` (from `design/consensus-r2` @ `85d1b40`),
> against `docs/CONSENSUS_R2_DESIGN.md` with the owner's decisions of §10. No node code, service, key or
> configuration was touched. The design document was **not** edited: every rule this work had to decide is
> listed in §2 as a proposed amendment.
>
> **Short version.** The state machine, the chain rules, the simulator and the checkers exist and pass.
> 15,280 seeded schedules with mixed faults below one third ran on this host with **zero violations of
> P1–P10**. Getting there found **three defects in the design that matter** (§7: F1, F2, F3) and several
> smaller ones. The exit criteria of §9 are **not** met yet: the 10^6-schedule campaign, the complete
> 4-validator × 2-round exploration and the independent review against Algorithm 1 are still open (§8).

## 1. What was built

A standalone crate, `research/consensus0/` (8,051 lines of Rust, 1,967 of them tests; dependencies: `rand_chacha`, `rand_core`).

| Module | Lines | Content |
|---|---:|---|
| `types` | 705 | Ids, modelled hash and signature, the real signed bytes of §3.2, ML-DSA-65 sizes, exact 256-bit `mul_div`, `q` and `t1`, certificate, evidence |
| `schedule` | 283 | §3.3 proposer rotation, exactly; the 50/30/20 table is reproduced row by row |
| `chain` | 1,100 | Blocks, heartbeats, epochs, delayed additions / immediate removals, cap 32, minimum 100,000 XRGE with 30-day grace, admission approval, 21-day slashable unbonding, evidence and tombstones, certificate-based jailing, rewards with the per-time subsidy, activation boundary |
| `machine` | 1,239 | `step(state, input) → (state, outputs)` for one validator. No clock, I/O, threads or randomness; integer arithmetic; no `unwrap` on input-derived data |
| `node` | 375 | Driver glue: machine + ledger + mempool + the §3.7 records |
| `sim` | 774 | Seeded event queue; delay, loss, duplication, reordering, partitions, per-message filters, stabilisation time, clock offsets; ten fault behaviours |
| `props` | 364 | Checkers P1–P10 |
| `campaign`, `explore`, bins | 1,152 | Scenario generation, measurements, bounded exhaustive explorer, two binaries |
| `mutation` | 61 | Broken rule variants, compiled into tests only |
| tests | 1,967 | 65 tests |

What is modelled and what is real: signatures and hashes are models (a vote is valid iff signed by the key
the harness holds); the signed byte strings and every byte count (vote 3,356 B, signature 3,309 B,
certificate `47 + ⌈n/8⌉ + 3,309·k`) are the real ones.

## 2. Rules made explicit — proposed amendments to the design

Each item is a place where the design was silent or ambiguous. The code implements the rule stated here and
names it in a comment (`rule Rn`).

**Round state machine (§3.4, §3.5)**

- **R1.** *Commit needs the block, from any round.* A block commits when precommits `≥ q` exist for it in
  some round and the validator holds the block from a correctly signed proposal of **any** round of that
  height. The published rule asks for the proposal of the commit round itself; they differ only when a
  re-proposal message was missed, and §3.8 already lets block + certificate commit alone.
- **R1b.** *T2 gates prevotes only.* A header time too far ahead of the local clock gives a nil prevote
  (§3.5). It does not stop the validator from locking on, or committing, a block that others gave a quorum.
- **R2.** *Round skip.* "Votes from stake `≥ t1` in a round `r' > r`" counts distinct senders of any message
  (proposal, prevote, precommit) of that round; if several rounds qualify, the highest is entered.
- **R6.** *The proposer runs the propose timeout too.* Under §3.4 a proposer may have nothing to propose; it
  must still move on. (The published algorithm starts this timeout only for non-proposers.)
- **R7.** *Commit wait.* It delays only start rules 1 and 2 of §3.4 (own work, heartbeat). A proposal or
  `≥ t1` of votes for the height starts it at once. The wait is skipped, or ends early, as soon as a precommit
  from every member of the parent's set is held.
- **R8.** *Invalid proposal.* A correctly signed proposal from the scheduled proposer whose block is invalid —
  including `header.round > r`, a header proposer that is not the scheduled proposer of `(h, header.round)`,
  or `pol ≥ r` — gets an immediate nil prevote.
- **R9.** *Header time.* The proposer uses `max(local clock, parent time + 1 ms)`.
- **R10.** *Votes are tallied per value.* A validator counts once per value it signed and once in "votes
  for anything". A second, different vote in a slot is evidence **and still a vote for its own value**; it
  is stored only if the value is nil or a block the validator holds a proposal for. See F1: the design's
  implied "keep the first vote" rule halts the chain.
- **R11.** *Pending work must be shared.* Evidence items are gossiped like transactions. Start rule 1 of §3.4
  is live only if the pending item reaches the proposer or `≥ t1` of stake (F4).
- **R29.** *Catch-up.* A block with a valid certificate is committed in any step, including while waiting
  in "new height"; T2 is not applied to it.
- **R30.** *Restart.* The records are resumed only if round 0 of that height had been entered; the step is
  taken from the journal (a journaled precommit of the stored round means "precommit" step); the journaled
  value wins over whatever the rules would now choose; the proposal of a round is sent once.

**Proposer schedule (§3.3)**

- **R3.** On a set change, `W` in the entry penalty `−(W + ⌊W/8⌋)` and in the `2W` bound is the **new** total.
- **R4.** Validators that stay keep their priority; a key that leaves and returns is new. With an unchanged
  set nothing is rescaled or re-centred.
- **R5.** The stored priorities advance by exactly one step per height whatever round committed, and that
  step is taken before the block's own set changes are applied.

**Chain rules (§4, §5, §6.4)**

- **R12.** *Order inside a block:* header and certificate checks → priority step → transactions → evidence →
  rewards → downtime observation and jailing → unbonding release → epoch processing → minimum-stake removals
  → new set and re-weighting.
- **R13.** Bonds are held in quanta; weight is `⌊bond / 10^9⌋` whole XRGE.
- **R14.** Evidence is applied before unbonding release in the same block, and the evidence window is
  inclusive (`age ≤ 21 days`). Otherwise an entry that matures in the last block of the window escapes.
- **R15.** If the slash fraction is ever below 100 %, what is left of the bond enters unbonding
  automatically at the slash.
- **R16.** Stake that is still pending (not yet active) when its key is tombstoned is refunded, not cut.
- **R17.** *Admission approval.* Approvals are tallied at each `approve` transaction against the set of that
  block; approvers that have left weigh nothing; approval is final once reached; validators in the set at
  activation need none. Entry needs **both** the stake and the approval to be at least 24 h old at the boundary.
- **R18.** The cap is applied at epoch boundaries only (the only moment anything can enter), over the
  active validators plus qualifying candidates, by weight, ties to the lowest key.
- **R19.** *§4.4 rule 2:* the certificates the validator is **absent from** must have been assembled by at
  least `m` distinct proposers. See F2: the literal text counts the proposers of the whole window.
- **R20.** *§4.4 rule 3:* candidates are evaluated one at a time in key order against the set as it shrinks;
  "T" is the current total; "inside the window" is the last `W` heights.
- **R21.** A validator's window holds only certificates of heights at which it was in the set, starts
  empty at activation, unjail and (re-)entry, and is judged from the first entry (it need not be full).
  The V2 certificate at the activation boundary is not counted.
- **R22.** `unjail` is an addition (§6.4): the validator returns at the first epoch boundary at least 24 h
  after the request (F6).
- **R24.** The grace is a flag cleared for everyone at the first epoch boundary at least 30 days after
  activation; a legacy validator below the minimum leaves at that boundary and is under the ordinary rule after.
- **R25.** The epoch boundary is the first block with `⌊time / 24 h⌋ > ⌊parent time / 24 h⌋`; an addition is
  mature when `boundary time − inclusion time ≥ 24 h`.
- **R26.** *Rewards.* Signers are paid by their weight in `E(h−1)` even if they have left since; the block
  directly above genesis has no certificate and all vote shares are unearned; the V2 certificate at the
  boundary is paid by the new formula; `fee_tx_count` counts transactions with a non-zero fee. The base fee
  is constant in this model.
- **R27.** *P7 reads* `credits + burn + unearned = fees + subsidy`; the reserve's net change is
  `unearned − subsidy`; total supply (liquid + bonded + pending + unbonding + burned) never changes.
- **R28.** Under the floor rule (§4.2 rule 4) evidence for a later offence by an already tombstoned key is
  valid and cuts nothing (F10).

**Checkers (§9)**

- **R23.** *P4.* "Pending" means pending at every running honest validator. "Bounded" is checked as commit
  round `≤ 3n + 10` for heights whose predecessor committed after stabilisation, plus: at the end of the run
  every running honest validator is at the chain tip, idle, with no admissible transaction left.
- **R31.** *P3.* "Evidence exists" means: among the votes signed by or delivered to non-Byzantine
  validators, there are two conflicting votes in one slot.

## 3. Properties — what was run and the result

**Campaign on this host** (`./host_campaign.sh`, 262 s of CPU at nice 19): 15,280 schedules, 129,516
committed heights, 34.9 million node inputs. Faults drawn from all eleven classes with total faulty stake
strictly below one third; 10,688 double-sign slashes and 168 downtime jailings happened along the way.

| Validators | Profile | Seeds | Heights | Forks | P1–P10 violations |
|---:|---|---:|---:|---:|---:|
| 4 | equal | 4,000 | 33,159 | 0 | 0 |
| 3 | today (100,090,000 / 10,000 / 9,000) | 1,500 | 13,017 | 0 | 0 |
| 3 | 50-30-20 | 1,500 | 12,510 | 0 | 0 |
| 5 | plan5 (assumed 24/22/20/18/16 %) | 1,500 | 12,328 | 0 | 0 |
| 7 | random | 1,500 | 12,817 | 0 | 0 |
| 10 | equal | 2,500 | 21,433 | 0 | 0 |
| 10 | random | 2,500 | 21,647 | 0 | 0 |
| 30 | equal | 140 | 1,303 | 0 | 0 |
| 30 | random | 140 | 1,302 | 0 | 0 |
| | **Total** | **15,280** | **129,516** | **0** | **0** |

| Property | Applicable in | How it is checked | Result |
|---|---:|---|---|
| P1 Agreement | 15,280 runs | No two non-Byzantine validators commit different blocks at a height; every chain is a prefix of the longest | 0 violations |
| P2 Validity | 15,280 | An independent ledger replays every committed block from genesis (scheduled proposer, certificate, all block rules); the commit certificate is re-verified | 0 |
| P3 Accountability | 0 below the bound (no fork to judge) | On a fork: duplicate-vote evidence against `≥ 2q − T` | Above the bound (separate run, half the stake colluding, 246 schedules): 23 forks, evidence `≥ 2q − T` in all 23. **False for cross-round forks** (F3) |
| P4 Liveness | 15,280 | R23 | 0 (three real failures found and fixed on the way: §7 F1, F4 and one restart bug) |
| P5 No stuck locks | 15,280 | No honest validator still holds a lock when the run ends; plus two scripted tests of the Release 2b scenario | 0 (F1 was a stuck lock) |
| P6 Proposer fairness | 15,280 (over the prefix of each run in which the set is unchanged) | `|slots·W − N·w| ≤ W` at every prefix; 50/30/20 table exact | 0; worst error 0.967 slot in the campaign, 0.988 over 65 stake shapes × 3,000 slots |
| P7 Reward conservation | 15,280 | R27, every block; an always-offline validator's balance never rises | 0 |
| P8 Slash conservation | 15,280 | Burn counter equals the sum of cuts; no second cut of bonded stake; supply constant | 0 (10,688 slashes) |
| P9 Jail safety | 15,280 | Every jailing has `≥ m` distinct proposers behind the omissions; no key at or above one third afterwards; no honest online validator jailed | 0 (168 jailings) |
| P10 Replay | 1,528 | The recorded input schedule is fed to fresh validators; every intermediate and final state hash must match | 0 |

443 of the 15,280 runs did not go quiet before the simulator's hard stop. In each of them every running
non-Byzantine validator was idle at the chain tip with nothing admissible pending (that is what P4 checks),
so the leftover activity was on Byzantine-behaviour nodes or evidence gossip. I did not look into those
runs further.

Commit rounds over the campaign: round 0 — 121,422 heights (93.75 %); round 1 — 7,637 (5.90 %); round 2 —
435; round 3 — 15; rounds 4, 5, 6, 8, 12, 16, 18 — once each. With partitions and pre-stabilisation loss
only (no faulty validators): 4 validators, 2,000 seeds — 94.9 % round 0, 5.1 % round 1; 10 validators,
600 seeds — 94.2 % / 5.7 % / one height in round 2.

**Bounded exhaustive exploration** (`bin/exhaustive`, one height, every interleaving of deliveries and
timeouts, 75 s limit each on this host):

| Case | States | Transitions | Bound reached? | Violations / stuck states |
|---|---:|---:|---|---|
| 3 validators × 1 round | 16,111 | 78,381 | no — complete | none |
| 3 validators × 2 rounds | 974,231 | 6,106,515 | no — **complete** | none |
| 4 validators × 1 round | 757,760 | 7,390,969 | yes (time) | none so far |
| 4 validators × 2 rounds | 774,144 | 7,564,928 | yes (time) | none so far |
| 4 × 2, one Byzantine validator | 987,136 | 5,393,782 | yes (time) | none so far |
| 4 × 2, permuted order (seed 7) | 868,352 | 3,959,820 | yes (time) | none so far |
| 4 × 2, Byzantine, permuted order | 733,184 | 5,267,737 | yes (time) | none so far |

**The exit criterion "exhaustive exploration of 4 validators, 2 rounds" is not met.** At about 12,000
states per second here the 4-validator space did not finish even for one round. It needs either far more
states off this host, or a partial-order reduction in the explorer (not written).

## 4. Self-tests: can the checkers see failures?

| Self-test | Scenario | Must be caught by | Fired? | Control (correct rules) |
|---|---|---|---|---|
| (a) Restart **without** persisted state | 600 schedules: one validator cut off as precommits fly, the other three crash and restart | P1 | **Yes — 15 of 600 schedules fork** (first: seed 3) | Same 600 schedules restarting **with** state: 0 violations, no double-sign |
| (a') same, one validator | Scripted: locked validator restarts, times out | duplicate-vote evidence | Yes: signs prevote X and prevote nil in one slot; the lock is gone | With state: lock kept, same bytes re-sent, re-proposes its locked block |
| (b) `≥ 1/3` faulty stake | Colluding half of four validators, 120 schedules | fork reachable; P3 | **13 forks; evidence `≥ 2q − T` in all 13**; P1 correctly not claimed | No fork whenever fewer than two colluders were drawn |
| (b') cross-round fork | Scripted: faulty pair precommits X in round 0 and Y in round 2 | P3 | **P3 as written fails: no duplicate vote exists** (F3) | — |
| (c) No lock on precommit | Scripted schedule (filters + partition) | P1 | Yes, fork at height 1 | Clean; height ends on the round-0 block |
| (c) Quorum `⌊2T/3⌋` | Four 1-XRGE validators split two and two | P1 | Yes. The explorer also finds it (30,812 states) | Clean; both halves wait and agree after healing |
| (c) Schedule not stake-weighted | 50/30/20, two days of heartbeats | P6 | Yes | Clean |
| (c) Jailing without the 3-proposer rule | One 25 % proposer omits two validators for three days | P9 | Yes | Clean; nobody jailed |
| (c) §4.4 rule 2 read literally | same | P9 | Yes (this is F2) | Clean |
| (c) Reward rounding leak | Uneven stakes, odd fees | P7 | Yes | Clean |
| Tampered record | A committed block replaced; the proposer changed; one schedule entry removed | P2, P2, P10 | Yes, all three | Clean |

No property failed to fire on its mutation. **Gaps in the self-tests:** P8 has no negative test (nothing
shows its checker firing); P4 and P5 have no planted mutation — they fired on three real bugs during
development (seeds 11, 102 and 844 of the 4-validator campaign), which shows they can, but that is not a
regression test.

## 5. Deviations D1–D7 and the other targeted tests

| Item | Test (`src/tests/…`) | What it shows |
|---|---|---|
| D1 signatures, bytes | `d1_signed_bytes_sizes_and_domain_separation`, `certificate_sizes_match_design_table_2_2` | Exact §3.2 strings; a signature binds chain, type, height, round, value and key; V2 and V3 never verify as each other; sizes as §2.2 |
| D2 on-demand heights | `d2_*` (three tests) | Nothing happens without work; one small validator cannot start a height; `≥ t1` of votes or a proposal does; an idle proposer loses its turn; heartbeat-only heights at exactly `T_HB` |
| D3 integer thresholds | `d3_thresholds_are_exact_in_stake_not_in_heads`, schedule and `mul_div` tests | 67 of 100 commits and 66 does not; 34 pulls a waiting validator in and 33 does not; weights up to 2^100 do not overflow |
| D4 header time | `d4_*` (two tests), `heartbeat_time_and_proposer_rules` | T2 failure is a nil prevote this round, the block is acceptable later; a block with a commit quorum is committed regardless of local T2; T1 enforced |
| D5 set changes | `d5_set_change_at_an_epoch_boundary_during_a_round`, `minimum_grace_admission_and_delayed_additions` | The set of a height is fixed for all its rounds; an addition lands exactly at the boundary block after 24 h; a removal counts at the next height |
| D6 certificate lists everyone | `d6_certificate_lists_every_precommit…`, `omitting_a_signature_lowers_the_proposers_own_reward` | The certificate holds exactly what the proposer held; the omitted signer is not paid; the proposer loses `15 % · s_j / T` |
| D7 timeouts | `d7_timeouts_grow_linearly_and_stop_at_the_cap` | 6 s + 2 s·r and 2 s + 1 s·r, capped at 120 s from round 57 / 118; the machine requests exactly these |
| Stuck lock (P5) | `p5_split_precommits_do_not_leave_the_round_stuck`, `p5_a_lock_on_a_dead_block_is_released…` | The Release 2b situation resolves in the next round; a lock on a block that cannot commit is released by a later proof-of-lock and by nothing else |
| Proposer absent 1, 2, 3 rounds | `absent_proposers_cost_one_round_each` | Commit in round 1, 2, 3 after exactly the failed rounds' timeouts |
| Unbonding slashed inside the window, not after | `unbonding_stake_is_slashable_inside_the_window_and_not_after`, `evidence_is_applied_before_unbonding_release…` | Entry created after the offence: cut; created before: not cut; evidence one millisecond past 21 days: block invalid |
| Activation boundary (§8.2) | `activation_boundary` | Block `F_B` carries and is verified against the V2 certificate; V3 bytes for the old height and V2 bytes for the new are both refused; first proposer is the greatest stake; pre-fork double-signing is still punishable |
| Today's stake (≈ 99.98 %) | `today_*` (three tests), `today_profile_halts…` | See below |

**Today's distribution — what the protocol does and does not give.** With one key above two thirds:
it commits every block **alone** (its own prevote and precommit are a quorum; no message from anyone is
needed), and the two small validators can neither stop nor fork it. It is the proposer of every round the
others could reach (checked for 2,000 rounds). **Liveness depends entirely on it:** with it offline the
others' nil prevotes are 0.019 % of the stake, no quorum of any kind forms, not even a timeout starts, and
no block is produced in any number of rounds — a halt, never a fork. **Safety depends entirely on it:** if it
signs two blocks, two honest small validators commit different blocks; the double-signing is provable (its
stake is far above `2q − T`) but nobody can outvote it. Downtime jailing cannot act at all in this shape
(F7). Stage B changes nothing here until stake is spread, as the design says in §8.1.

## 6. Measurements

**Time to finality**, 10 equal validators, fixed one-way delay, milliseconds from submission to commit
(all running validators commit in the same millisecond at a fixed delay). The normal case is three message
delays plus up to one delay of transaction gossip; the commit wait is not part of it.

| Timeouts | Delay | Normal | 1 absent proposer | 2 in a row | 3 in a row |
|---|---:|---:|---:|---:|---:|
| **Moderate (decided)** | 50 ms | 170 | 8,286 | 19,386 | 33,494 |
| | 200 ms | 680 | 9,142 | 20,542 | 34,975 |
| | 1 s | 3,402 | 13,707 | 26,711 | 42,875 |
| | 3 s | 10,207 | 25,120 | 42,132 | 62,625 |
| Fast | 200 ms | 680 | 5,142 | 10,542 | 16,975 |
| Slow | 200 ms | 680 | 26,142 | 66,542 | 121,975 |
| *Design estimate, moderate, 200 ms (§3.5)* | | *≈ 1,000* | *≈ 8,000* | *≈ 16,000* | — |

An absent proposer costs its round's propose timeout **plus** its precommit timeout (6 + 2 s, then 8 + 3 s,
then 10 + 4 s). The design's "two in a row ≈ 16 s" left the precommit timeouts out (F5).

**Consensus traffic per block**, one round, all honest — the §2.2 figures are reproduced exactly:

| Validators | Votes signed | Distinct vote + proposal-signature bytes | Vote deliveries | Vote bytes sent network-wide | Certificate, all signers |
|---:|---:|---:|---:|---:|---:|
| 4 | 8 | 30,157 | 24 | 80,544 | 13,284 |
| 10 | 20 | 70,429 | 180 | 604,080 | 33,139 |
| 30 | 60 | 204,669 | 1,740 | 5,839,440 | 99,321 |

One vote is 3,356 B on the wire. A block of consensus traffic is the row above plus the block body.

**Certificates per day at the hourly heartbeat**, one idle simulated day: 24 blocks; 318,816 B (0.32 MB),
795,336 B (0.80 MB) and 2,383,704 B (2.38 MB) at 4, 10 and 30 validators — §3.4's figures. (At a 10-minute
heartbeat the same formula gives 1.91, 4.77 and 14.30 MB.)

**Certificate completeness under sustained load** (D6), 10 validators, delays uniform in 5 ms … max, a
transaction every 300 ms:

| Max delay | Commit wait | Signers listed | Fewest in one certificate |
|---:|---:|---:|---:|
| 50 ms | 500 ms | 99.9 % | 8 of 10 |
| 200 ms | 500 ms | 99.9 % | 8 of 10 |
| 400 ms | 500 ms | 99.9 % | 9 of 10 |
| 1 s | 500 ms | 97.6 % | 8 of 10 |
| 3 s | 500 ms | 89.4 % | 8 of 10 |
| 1 s | none | 70.0 % | 7 of 10 (a bare quorum) |
| 1 s | 2 s | 99.7 % | 9 of 10 |

**Not measured:** ML-DSA-65 signing and verification cost per block (no real signatures here). By count,
at 30 validators one round costs each validator 2 signatures (3 for the proposer) and about 89
verifications (58 votes, 1 proposal, 30 certificate signatures).

## 7. Defects and under-specifications found in the design

### High

- **F1. Counting only a validator's first vote lets one equivocator halt the chain for good.** §1.1 and §4.2
  describe today's behaviour (a conflicting vote is rejected; the design adds "and build evidence"). Found by
  the campaign (4 validators, seed 102): a colluding validator below one third showed validator 0 a prevote
  for block X and the others a different prevote. Validator 0 saw a quorum and locked on X; the others, who
  had stored the other vote first, could never see that quorum, so they refused every re-proposal of X while
  validator 0 refused everything else. 86 rounds and three simulated hours later nothing had committed, and
  since slashing needs a block, nothing ever would. **Amendment R10** (count per value, as the published
  algorithm's message-log model does) removes it. Regression test:
  `an_equivocators_votes_count_for_each_value_and_yield_evidence`. *This also applies to the node's current
  verifier if rounds are added on top of it.*
- **F2. §4.4 rule 2 as written does not give P9.** "Those W certificates were assembled by at least m
  distinct proposers" is true of almost any window, so a single proposer with enough slots can jail a rival
  by omitting it — the very objection the rule cites. P9 needs: the certificates the validator is *absent
  from* come from `≥ m` proposers (**R19**). Both readings are implemented as mutations; the literal one is
  caught by P9.
- **F3. P3 is false as stated.** It holds when both blocks are committed in the same round (every such fork
  in the tests had evidence `≥ 2q − T`). It fails when faulty validators precommit X in one round and Y in a
  later round: each slot holds one value, so no duplicate vote exists — §4.1 says as much ("not provable from
  two signatures"), which contradicts P3 and the "provably double-signers" claim in §7's table. Test:
  `b_cross_round_fork_leaves_no_duplicate_vote_evidence` (two honest validators, two blocks, zero evidence).
  Options for the owner: restate P3 for same-round forks only and say plainly that a cross-round attack by
  `≥ 1/3` is unpunished; or add an accountability mechanism for lock violations (votes that carry their
  proof-of-lock round), which is new protocol surface and needs its own design.

### Medium

- **F4. Start rule 1 of §3.4 can strand a validator.** A validator that alone holds pending work, is not the
  proposer and has less than `t1` enters round 0, prevotes nil on timeout and can never leave: no quorum of
  prevotes, so no further timeout starts. The chain is unharmed, but its transaction is not served and its
  nil prevote is already cast when the others later start that height. The simulator hit this twice (a
  restart bug in my code, and evidence known to one validator). Rule 1 needs the assumption written down
  (**R11**), and the design should say what a stranded validator does (for example: re-gossip its pending
  item on every timeout).
- **F5. §3.5's recovery times are too low.** Measured 9.1 s / 20.5 s / 35.0 s for one, two, three absent
  proposers at 0.2 s (design: ≈ 8 / ≈ 16). If faster recovery is wanted without touching the decided
  timeouts, moving to the next round at once on a quorum of **nil** precommits would save 2 s, 3 s, 4 s … per
  failed round; that is a change to the published rules and would need the same review.
- **F6. A one-hour jail is in effect a one-to-two-day jail.** §6.4 lists `unjail` as an addition, so return
  waits for the first epoch boundary at least 24 h after the request (**R22**). If one hour is meant, unjail
  must be exempt from the delay — which re-opens what the delay protects against.
- **F7. Decided jail parameters act slowly, and not at all today.** At about 24 blocks a day (hourly
  heartbeat, little traffic) "more than 100 of 200" is more than four days offline. With today's stake no
  jailing can ever happen: rule 3 forbids it while any key holds a third, and rule 2 cannot be met while one
  key proposes almost every block. Consistent with the stage order, but nowhere stated.
- **F8. Decision 6 removes today's two small validators after 30 days** (10,000 and 9,000 XRGE against a
  100,000 minimum) unless they are topped up — leaving a set of one. Tested as specified; the consequence is
  the owner's to confirm.
- **F9. The certificate is only as complete as the commit wait is long.** With delays above the 0.5 s wait,
  slow but honest validators are left out (10.6 % of signatures at 3 s), lose that block's reward, and collect
  absences from many different proposers — which is exactly what the jailing rule counts. Late inclusion
  (§5.2 leaves it out "unless CONSENSUS-0 shows omission in practice") or a wait matched to real delays
  should be decided with testnet delay data.
- **F10. Evidence can force empty-effect blocks.** Under the floor rule a tombstoned key can still be
  accused for later heights; each item is valid, cuts nothing, and counts as pending work (**R28**). Suggest:
  evidence against a tombstoned key with nothing left at stake is inadmissible.

### Low

- **F11.** Round numbers are unbounded: votes for arbitrarily high rounds must be stored. A bound or rate
  limit is needed in the node (the model has none).
- **F12.** An equivocating proposer can make validators hold an unbounded number of blocks per round; R10
  bounds the votes but not this.
- **F13.** Nothing prevents the active set from becoming empty (last validator unbonds; everyone below the
  minimum after the grace). With no scheduled proposer no block is ever valid again
  (`an_empty_active_set_halts_the_chain_for_good`). A rule is needed.
- **F14.** P6's "within one slot" held everywhere it was tried (worst 0.988) but is not proved here.
- **F15.** Unspecified and decided here: what happens to pending stake and to the remainder of a partly
  slashed bond (R15, R16); how approvals are tallied (R17); where the cap is applied (R18); the window
  details of jailing (R20, R21).
- **F16.** The T2 drift bound comes from LC1 §15.1, which was not available; 10 s is a placeholder **[confirm]**.

## 8. What is not covered

- **The 10^6-schedule campaign.** 15,280 schedules ran here (1.5 % of it).
- **Exhaustive exploration of 4 validators × 2 rounds** — bounded only (§3).
- **The independent line-by-line review against Algorithm 1.** Required by the exit criteria and not
  something the author of the code can do. Every rule in `machine.rs` carries a tag `[A1:n]` naming the line
  of arXiv:1807.04938 it implements — lines 11, 15–16, 18, 22 (and its `else`), 28, 34, 36, 38–41, 42–43, 44,
  47, 49, 55, 57, 61, 65. **All sixteen tags were written from memory of the paper, not checked against its
  text.** Places where the code knowingly differs from the paper: R1, R1b, R2 (highest round), R6, R7, R8,
  and the on-demand start (D2).
- **Not checked against their sources** (the design's **[confirm]** marks): the proposer-priority rules
  against CometBFT (R3–R5 follow the design's reading); "duplicate proposals are not slashed"; LC1's time
  rules beyond T1 and T2 as the design quotes them.
- **Real signatures and their cost; a real network; real disks** (the persist-before-send contract is
  expressed in the output order and tested, but nothing is fsynced here).
- **Stages D and E** (key separation, rotation, delegation, commission); the dynamic base fee; transaction
  signatures; LC1's header format and light-client rules.
- **The `plan5` profile is an assumption.** The decentralization plan's "5-R" shape was not available in
  this worktree; five operators at 24/22/20/18/16 % were used.
- **Sampled, not exhaustive:** clock offsets up to 0.8 s; delays up to 9 s before stabilisation and 0.4 s
  after; at most two partitions per run.

### The large campaign

On a machine that is **not** a validator:

```sh
cd research/consensus0
JOBS=16 ./large_campaign.sh        # 1,000,000 schedules in 501 jobs; logs/ ; exit 1 on any violation
```

which runs, per job, `./target/release/campaign --validators V --stake-profile P --seeds A..B --faults all
--long-every 16 --replay-every 10` over: 300,000 seeds at 4 equal; 50,000 each at today and 50-30-20;
100,000 at plan5; 150,000 at 7 random; 125,000 each at 10 equal and 10 random; 50,000 each at 30 equal and
30 random.

**Estimate.** Measured here (one core, nice 19, sharing the host with a validator): 1,058 and 712
schedules/s at 3 validators, 440 at 4, 275 at 5, 118 at 7, 56 at 10, 2.0 at 30. For the mix above that is
about 57,000 CPU-seconds, **≈ 16 CPU-hours**, of which the 30-validator share is 14. On an idle 16-core
machine: roughly one hour of wall time. Memory stays under 60 MB per job.

## 9. Reproduce

```sh
RUN="systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice -n 19"
$RUN cargo test --offline -j 1 -- --test-threads=1        # 65 tests, about 65 s
$RUN cargo build --offline --release --bins -j 1
./host_campaign.sh                                         # §3 table, 262 s CPU
$RUN ./target/release/campaign --measure                   # §6
$RUN ./target/release/exhaustive --validators 3 --rounds 2 --max-states 6000000 --max-seconds 75
$RUN ./target/release/campaign --seeds 0..246 --validators 4 --faults coalition,chaos,partition \
     --fault-bound 1/2 --long-every 0 --replay-every 0 --keep-going      # forks above the bound, P3 holds
rm -rf target
```
