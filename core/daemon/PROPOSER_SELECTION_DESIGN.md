# Deterministic proposer selection — design record (no code yet)

Status: **design only**, 2026-09-23. Branch `consensus/proposer-selection-design` (on top of the active
tx-integrity release `350f028`). Nothing here is implemented; no activation height is proposed.

## 0. Why (facts from the live chain and the code)

* `import_block` accepts a block from **any** validator with `stake > 0` (proposer-auth check, `node.rs`
  `PROPOSER_AUTH_ACTIVATION_HEIGHT`). Two staked nodes with the same mempool race each other. This produced
  the real one-block fork at height 60 on 2026-09-23 (primary and node #2 each sealed a block 60 with the same
  transaction, 0.7 s apart). There is no fork choice and no reorg (`peer.rs`: "no longer chain wins"), so a
  split is permanent until one side is manually resynced.
* The only selection logic that exists today is **informational**: `get_selection_info` mixes external ANU
  entropy (or a local CSPRNG) into a seed — non-deterministic across nodes, never enforced, and it cannot be
  used for consensus.
* `check_missed_blocks` increments `missed_blocks` for **every** non-proposing staked validator on every
  block and auto-slashes at 50 (10 % of stake, jailed 20 blocks). Under a single-producer reality this
  punishes validators for not winning a race they were never selected for: the outside validator was
  slashed at height 69 (`stake 10,000 → 9,000, jailed until 89`) for exactly this reason, and **node #2 —
  non-mining by instruction — will be slashed at ≈ height 109** (staked at 59, 50 misses) unless the rule
  changes first. Any proposer-selection release must redefine "missed" in the same activation.
* Validator state (`ValidatorState { stake, slash_count, jailed_until, missed_blocks, … }`) is consensus
  state: it is derived only from block contents and is pinned by the F49 fork tables. It is stored in a
  sled tree keyed by public-key string; `list_validators` returns sled key order (byte-lexicographic). That
  happens to be deterministic, but nothing in the code promises it — the rule below must sort explicitly.
* Block headers carry `proposer_pub_key`, `time` (proposer-chosen, **not validated** on import), `prev_hash`,
  `tx_hash`, `state_root`. The block hash covers the proposer's ML-DSA-65 signature, and ML-DSA signing is
  randomized: a proposer can produce many distinct valid hashes for the same block content. Any rule that
  derives randomness from the previous block's hash or signature is therefore grindable by the previous
  proposer.

## 1. Core invariant

For every height `H ≥ A` (activation) and canonical parent `P` (the accepted block at `H-1`), every honest
node derives the same single public key `proposer(H)` from `P`'s post-state, and a block at `H` whose
`header.proposer_pub_key ≠ proposer(H)` is consensus-invalid (rejected before the pre-apply snapshot, like the
tx-integrity rule, so it leaves no state, receipt or index change).

## 2. Validator-set snapshot (shared by every option)

`proposer(H)` is computed from **S(H−1)** = the validator state after applying block `H−1` (the tip's
post-state), which every node holds identically because it is derived only from blocks. Concretely:

1. Take every validator record after `H−1`. **Eligible** ⇔ `stake > 0` **and** `jailed_until ≤ H`
   (the existing jail semantics: `jailed_until` is the first height at which the validator is active again).
2. **Order** eligible validators by the raw public-key bytes (hex-decoded, ascending). Ties are impossible
   (distinct keys). Never by stake, never by insertion or iteration order.
3. Joins: a `stake` tx included in block `H−1` makes the validator eligible for `H` (its record exists after
   `H−1`); a stake tx in block `H` does not affect `proposer(H)` (it is judged against S(H−1)). Exits: an
   `unstake` that brings stake to 0 in `H−1` removes eligibility for `H`. Stake changes reorder nothing (order
   is by key). Jailing in `H−1` (auto-slash) removes eligibility for `H` through `jailed_until`.
4. No node-local cache: the implementation reads the validator store after the tip is applied, or —
   during replay/recovery — after applying `H−1` through the normal import path. Deriving from any other
   snapshot (a cached list, the store during a partially applied block) is a bug by definition.

`missed_blocks`, `blocks_proposed`, `entropy_contributions` and `name` are **not** inputs.

## 3. Options

### Option 1 — deterministic round-robin over the ordered eligible set

`proposer(H) = E[H mod |E|]` where `E` is the ordered eligible set from §2.

* Consensus safety: exact — one key per height, derived from S(H−1) only. Nothing to grind: the schedule
  depends on the set and the height, not on any proposer-chosen bytes.
* Liveness: a height assigned to an offline validator **halts the chain** (§4). With today's set that is 2
  of every 3 heights (node #2 non-mining, outside validator never connected).
* Manipulation: a validator can influence its slot only by changing the set (joining with a new key changes
  everyone's position). Bounded, visible on-chain, costs stake.
* Joins/exits/jail/stake: handled by §2; a set change shifts the rotation for all following heights, which
  is fine because every node sees the same set.
* Ordering: explicit key-byte sort, required.
* Recovery: pure function of stored blocks; replay derives the same schedule.
* Complexity: small — one function, one validity check, one fork gate.

### Option 2 — stake-weighted deterministic selection

Walk the ordered eligible set with cumulative stake and pick the validator whose interval contains
`seed(H) mod total_stake`, with `seed(H)` a deterministic function of `H` and the set (e.g. keccak of
`H ‖ sorted keys ‖ stakes`).

* Consensus safety: exact if the seed excludes proposer-chosen bytes.
* Liveness: same halt behaviour as Option 1, but the primary (83 % of stake) would be selected ≈ 83 % of the
  time, so the chain halts ≈ 17 % of heights instead of 67 %.
* Manipulation: stake changes move the intervals; a validator can shift its own probability by staking, which
  is the intended economics, but small stake adjustments in `H−1` can flip the winner of `H` — a cheap,
  legitimate-looking way to steer specific heights (grinding via stake, not via hashes).
* Joins/exits/jail: as §2; every stake change re-partitions the intervals.
* Ordering: required for the interval walk.
* Recovery: deterministic.
* Complexity: moderate (u128 arithmetic, interval walk, more edge cases to test).

### Option 3 — pseudo-random selection from previous canonical block data

`seed(H) = keccak(prev_hash ‖ H)` (or from `P`'s signature, `tx_hash`, `time`), index into the ordered set.

* Consensus safety: exact (the parent is canonical for everyone).
* Liveness: same halt behaviour; unpredictable which heights halt.
* **Manipulation: grindable.** The parent's proposer chooses `time`, the transaction subset (`tx_hash`) and,
  because ML-DSA signing is randomized, can re-sign the same block until the resulting hash selects itself or
  an ally for `H`. With one dominant producer this is not a theoretical concern. A commit-reveal or VRF scheme
  fixes it but is a far larger change with its own key-management requirements.
* Complexity: low to implement, high to make honest. **Rejected** for this release.

### Option 0 — designated proposer (the minimal rule)

`proposer(H)` = the eligible validator with the **largest stake** in S(H−1), ties broken by the lowest
public-key bytes. With today's state that is the primary (`8ccf7878…`, 100,000) at every height.

* Consensus safety: exact, no proposer-chosen inputs, no grinding.
* Liveness: exactly today's reality — the chain advances iff the primary is up. No new halt modes.
* Manipulation: the only way to take over production is to out-stake the current producer (> 100,000 XRGE
  today) — visible, expensive, and if the new top staker then stays offline the chain halts (a liveness
  attack that costs the attacker their stake's liquidity; slashing it needs Release 2's missed-slot
  evidence). Option 1 has the same attack for 1/|E| of the heights at a lower cost (10,000 XRGE).
* Joins/exits/jail/stake: §2; only the maximum matters.
* Complexity: the smallest possible — one comparison over the ordered set.

## 4. Liveness — what happens when the selected proposer is offline

There is no fork choice, so a wrong fallback is worse than a halt: two "valid" blocks at one height split
the chain permanently. Local timeouts cannot be used: node A's clock saying "the proposer is late" is not a
fact node B can verify, so a block justified by a timeout is unverifiable and the race returns.

**Decision for Release 1: favour safety. If `proposer(H)` does not produce, the chain halts at `H−1`** until
that proposer returns or the validator set changes (an `unstake`/`stake` cannot be included without a block,
so recovery from a permanently lost designated key is an operator-coordinated intervention: a scheduled rule
change, exactly as F49 and this fork were). With Option 0 this is the status quo; with Option 1 it would be a
regression (2/3 of heights halt today).

Release 2 (not designed here): a **clock-free fallback** where the next validator in order may propose `H`
only by embedding a *skip certificate* — signatures from ≥ ⅔ of eligible stake over
`SKIP ‖ chain_id ‖ H ‖ parent_hash ‖ missed_proposer`. Every node can verify the certificate without any
notion of time; the vote machinery already exists in the FINALITY_V2 code (RC1 lineage). That is the point at
which round-robin becomes safe to enable and at which "missed slot" becomes an on-chain fact that can be
slashed.

## 5. Equivocation

Two blocks at the same `H` with the same parent, both signed by `proposer(H)`, different hashes.

* Under this release both are **individually valid** (the rule only names the proposer). Each node keeps the
  first one it accepts; a second one at the same height fails `height != tip + 1`. Nodes that received
  different first blocks split — but now only the designated proposer can cause it, by signing twice.
* Detection: on import rejection "height does not extend tip", if the rejected block's `prev_hash` equals
  our tip's parent and its `proposer_pub_key` equals our tip's proposer and its hash differs, that is
  equivocation. Persist both signed headers as evidence (a small `equivocation-db` tree keyed by
  `height ‖ proposer`), log loudly, expose on `/api/validators`.
* Slashing: **Release 2**. Evidence persistence and detection are cheap and safe to ship now; the penalty
  needs an on-chain `slash` tx carrying the two headers so every node applies it deterministically, which is
  new consensus surface and must not be bundled with the race fix.

## 6. Missed-block accounting — must change in the same activation

From `A` on, `check_missed_blocks` must not increment `missed_blocks` for validators that were **not**
`proposer(H)`. Under the halt design a missed slot never appears on-chain, so the counter cannot advance for
anyone; the auto-slash path becomes inert until Release 2's skip certificates make misses observable. Below
`A` the historical behaviour is kept byte-for-byte (the outside validator's slash at 69 is part of history).
**Operational note: with the current rule still active, node #2 is slashed 1,000 XRGE and jailed 20 blocks at
≈ height 109. Fourteen more mainnet blocks are enough to trigger it.** Either this release activates before
that height, or block production is deliberately held, or the slash is accepted.

## 7. Activation and history

* `PROPOSER_SELECTION_ACTIVATION_HEIGHT: Option<u64>` compiled constant + test-only override, same pattern
  as `TX_UNIQUENESS_ACTIVATION_HEIGHT`; the check runs in `import_block` after the signature checks and the
  tx-uniqueness check, before the pre-apply snapshot; the producer refuses to seal a block for a height it is
  not the proposer of (node-local, live on upgrade — this alone stops the race between *upgraded* nodes).
* Below `A`: unchanged (any staked validator). All 96 canonical mainnet blocks (0–95) were produced by
  `8ccf7878…`, so the existing replay gates (`mainnet-blocks-0-48`, `0-60`, to be extended to the tip)
  must pass unchanged with `A = None` and with any `A ≤ 96`.
* Chain id: mainnet only, like F49 (`fork_applies()`), or all chains — to decide; testnet runs the same binary.

## 8. Recommendation

**Ship Option 0 (designated proposer = max-stake eligible validator, key-byte tie-break) with the §6 missed-block
change and §5 evidence-only equivocation handling, halt-on-absence liveness.** It removes the real
vulnerability (a second staked validator producing a competing block) with a single comparison over consensus
state, adds no new transaction types, no randomness, no clocks, no fallback path that could be gamed, and
changes nothing about how the chain runs today. Round-robin (Option 1) is the right *second* step, but only
together with skip certificates; enabling it now would halt the chain on 2 of every 3 heights.

## 9. Tests required before implementation is complete

1. Two validators seal the same height on the same parent → exactly the designated one is accepted on both
   nodes; the other is rejected with a proposer-rule error and no state change.
2. Unauthorized proposer (staked, eligible, not designated) rejected at `H ≥ A`.
3. Authorized proposer accepted at `H ≥ A`.
4. Activation boundary: `A−1` accepts a non-designated staked proposer (legacy), `A` rejects it.
5. Validator joins in block `H−1` with the largest stake → designated for `H`; joins in block `H` → not
   until `H+1`. Same for an unstake that drops the leader.
6. Jailed validator (`jailed_until > H`) is skipped even if it has the largest stake; eligible again at
   `jailed_until`.
7. Restart/recovery: `recover_from_history` and a fresh node re-derive the same `proposer(H)` for every
   historical height; the snapshot path and the rebuild path agree.
8. Ordering determinism: the same set inserted in shuffled orders (and with `list_validators` order
   perturbed in a test double) yields the same ordered set and the same proposer.
9. Historical replay: fixtures 0–48, 0–60 and a new 0–95 fixture pass with `A = None` and with `A = 1`.
10. Two separate node instances (separate data dirs) fed the same blocks report the same proposer for
    `tip+1` via a read-only API field.
11. Equivocation: two valid blocks by the designated proposer at one height → the second is rejected as
    non-extending, evidence persisted with both headers, surfaced on the API; no slashing.
12. Designated proposer offline: no other validator's block is accepted at `H`; the chain stays at `H−1`;
    when the designated proposer produces `H`, it is accepted and the chain continues.
13. `missed_blocks` does not increment for non-designated validators at `H ≥ A`; it does below `A`.

## 10. Operational constraints during this work

Node #2 and the outside validator stay non-mining; public block-import and peer-registration ingress stay
blocked at the edge; the active tx-integrity rule is untouched.

## 11. Approved amendments (2026-09-23) and implementation notes

* **Rule as approved:** `proposer(H)` = greatest stake among validators with `stake > 0 && jailed_until ≤ H`
  in the canonical validator state after `H−1`; ties → lowest raw public-key bytes; unauthorized proposer
  rejected in `import_block` before the pre-apply snapshot. No fallback, rotation, randomness or slashing.
* **Amendment 1 — missed-block freeze:** from the activation height `check_missed_blocks` performs no
  `missed_blocks` increment, no auto-slash and no auto-jail for anyone; historical counters are left as
  they are; `blocks_proposed` (informational; pre-existing double count per import preserved) still counts.
* **Amendment 2 — producer anti-equivocation journal (node-local):** `proposal-journal-db` keyed by
  `(height, parent_hash)` holds the complete sealed block. Write ordering in `mine_pending`: snapshot →
  apply → root → sign → **journal (flushed)** → validator effects → append (commit) → broadcast. A second,
  different block for a journaled slot is refused (`EQUIVOCATION GUARD`). A journaled block that was never
  appended (crash between journal and append) is re-imported through the normal import path at the next
  `mine_pending` and at `init`, and handed back for broadcast, so the chain is not stranded. If that
  re-import ever fails the producer refuses to seal anything for that slot and raises a high-severity
  error (operator inspects `proposal-journal-db`).
  A record written by an attempt that then FAILS before append in the same process (rollback path) is
  withdrawn with the rollback: that block was never durable and never broadcast, so no second proposal
  can have been seen by anyone. The producer also refuses to seal a height it is not
  designated for (node-local; stops the race between upgraded nodes before the fork activates).
  **Limitation:** the journal binds one *process*; copying the proposer private key to a second machine
  defeats it. Running more than one active producer with the same proposer key is unsupported.

## 12. Validator admission — security consideration (unchanged in this release)

Answers, from the code as it runs today:

| Question | Answer |
|---|---|
| Can any account become proposer-eligible simply by staking? | **Yes.** A `stake` transaction from any funded account creates the validator record; eligibility for selection is `stake > 0 && jailed_until ≤ H`. |
| Is validator registration permissionless? | **Yes.** No allow-list, no genesis membership requirement, no identity binding beyond the signing key. |
| Is there a minimum stake? | **Only at the API.** `/api/v2/stake` and the CLI refuse `< 10,000 XRGE`; the consensus apply path (`apply_balance_tx_inner`, `"stake"`) enforces only `amount > 0` and sufficient balance. A raw block or a modified client can stake 1 XRGE. |
| Is stake immediately effective for proposer selection at H+1? | **Yes.** A stake applied in block `H` is in the validator state after `H`, so it counts for `proposer(H+1)`. |
| Can stake be withdrawn immediately? | The validator's `stake` field is reduced **immediately** by an `unstake` (it stops counting for selection at the next height); the XRGE itself is released after the 500-block unbonding period. |
| Can an attacker temporarily out-stake the current producer and then exit? | **Yes, in two blocks.** Stake `> 100,000 XRGE` in block `H`, be the designated proposer from `H+1`, then unstake (the XRGE is locked for 500 blocks but nothing else is at stake). While designated and offline, the chain halts (no fallback); while designated and online, they control block production and transaction inclusion. **Cost:** the liquid XRGE required, ≈ 100,001 XRGE at today's stake distribution, locked for 500 blocks. Whether that is expensive depends on XRGE's market price and Base DEX liquidity, which were not assessed here and should not be assumed. |

Implications carried into Release 2: a minimum stake and/or an activation delay (stake effective after N
blocks) and an unbonding-period slash for a designated proposer that halts the chain are the natural
mitigations; none is part of Release 1.

## 13. Release 1 — release record

| Item | Value |
|---|---|
| Activation | `PROPOSER_SELECTION_ACTIVATION_HEIGHT = Some(100)` (approved 2026-09-23; canonical tip 95 = `ea25cc0b353ce4055982268de59fcae45ac93e22033fe9a297e51228de48f793`, state root `5620f4efc2f7041c2373eb9c0c60cd23893048cff874abba23408dee860b6318`) |
| Source commit | `b69d0c9e71a5353ad3d487c1ec5923c9a0967841` (branch `consensus/proposer-selection`; commit time 2026-09-23T17:44:05Z) |
| Binary | `quantum-vault-daemon-proposer-selection-b69d0c9`, 26,866,528 bytes, sha256 `d50f7e5d34d03200f6efc45c8b7b63c61079e7f9d5b5c70f5b3c3c3544105eba` |
| Build | `cargo build --release --locked --offline -p quantum-vault-daemon`, `SOURCE_DATE_EPOCH=1790185445`, `RUSTFLAGS` remap-path-prefix (src→`/build/src`, target→`/build/target`, `~/.cargo`→`/build/cargo`, `$HOME`→`/build/home`); two fresh checkouts + fresh targets at the same absolute path → byte-identical |
| Toolchain | rustc 1.94.0 (4a4ef493e 2026-03-02), cargo 1.94.0 (85eff7c80 2026-01-15), x86_64-unknown-linux-gnu |
| Tests (at `b69d0c9`) | daemon 156 passed / 0 failed / 1 ignored (table generator); workspace 247 / 0 / 1; includes the 0–95 canonical replay gates (`t13_t14_*`) |
| Verification tool | `sign-block-b69d0c9` (sha256 `18bf9610943d5f667bc1bf95491777a8c3552a043add31675787019dc86eb32e`): re-signs a canonical block with another validator key, changing only the proposer identity, to exercise the rejection path without enabling mining |
| Read-only report | startup log line `[consensus] proposer selection: …` and `/api/stats` fields `proposer_selection_activation_height`, `designated_proposer_next_height`, `proposer_selection_active_next`, `designated_proposer_next` |
| Designated proposer for 100 | `8ccf7878…` (100,000 stake); `c97f59a2…` (10,000) and `21e0ed0a…` (9,000) eligible, not selected |

## 14. Release 1 — activation record (mainnet, 2026-09-23)

Binary `d50f7e5d…` (commit `b69d0c9`) installed on the primary (18:13 UTC, rollback copy
`quantum-vault-daemon.pre-proposer-selection` = tx-integrity binary `9ad81dbf…`) and on node #2
(18:51 UTC, by the operator, checksum verified). Both reported at startup
`activation height Some(100); next height 96 (rule inactive); designated proposer for 96: 8ccf7878…`.
Blocks 96–99 produced deliberately (one transfer each); both nodes identical after each block.

| Check | Evidence |
|---|---|
| Both nodes derive the proposer for 100 | at tip 99 both `/api/stats`: `designated_proposer_next_height=100`, `proposer_selection_active_next=true`, `designated_proposer_next=8ccf7878…` |
| Competing block, tip 99 | node #2 built a fresh empty block 100 (parent `74757a95…`, proposer `c97f59a2…`, hash `6c96a1c0…`) with `sign-block-v2` (no mining). Node #2 local import and primary import both returned `block 100 rejected: proposer c97f59a2409eb025 is not the designated proposer (8ccf7878003b2668)`; repeat submission gave the same result |
| No mutation on rejection | before/after diff on both nodes: height 99, finalized 99, state root `2c321119…`, fee totals, all validator counters (stake/missed/slash/jail/proposed), operator and node #2 balances unchanged; primary `proposal-journal-db` files untouched |
| Canonical block 100 | proposer `8ccf7878…`, hash `1610395d908b9a5925345aa8074520214e8b8963ab1e0e4d14f298ed83ccd746`, state root `35db41adc96379c52179d5efa95776eaa88c07f77d4ae617db140226aea408fb`, accepted by primary (producer) and node #2 (import), identical on both |
| A/B on a scratch node held at 99 (same binary, same state) | competing block → rejected (proposer rule), tip/root unchanged; canonical block 100 → accepted, root `35db41ad…`; competing block again at tip 100 → rejected by the height check (ordering as designed) |
| Missed-block freeze | node #2 `missedBlocks` 41 at 99 (legacy rule would have auto-slashed at 50); still 41 at 100 and at 106; `21e0ed0a` unchanged (11 missed, jailedUntil 89) |
| No slash / jail | no slash, jail, equivocation or HIGH SEVERITY log lines; `slashCount`/`jailedUntil` unchanged on both nodes |
| Observation | blocks 101–106 produced normally; primary and node #2 identical hash + state root after every block |

Node #2 remains non-mining. `/api/blocks/import` and `/api/peers/register` remain 403 at nginx.
