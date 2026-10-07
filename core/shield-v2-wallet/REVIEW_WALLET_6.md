# REVIEW_WALLET_6 — confirmation review: are the conditions of REVIEW_WALLET_5 met?

**CONDITIONS NOT MET: condition 1 (the client loop) is met in part only — (1) a liar that votes honestly in the state check and lists one transaction a block late gets the honest listing node banned, and with three nodes ends the session as the only listing node (RW6-1); (2) one page with a digest that is not canonical makes `scan` answer `non_canonical:`, for which the loop's only rule is STOP — one lying node stops every session with its first answer (RW6-2); (3) an honest node that answers "the pool is not active" is banned (RW6-3). Conditions 2 to 10 are met as claimed; no edited test was weakened.**

Reviewed: `fix/shield-v2-wallet-settlement-4` @ `b59088b` — the diff `0d3f2bd..b59088b`, the
Resolution in `REVIEW_WALLET_5.md`, `UI_CONTRACT.md`, `NOTES.md` §6 and §14,
`tests/common/client_loop.rs`, `tests/settlement_properties.rs`, `tests/review_wallet_5.rs`,
`tests/review_wallet_5_resolution.rs`, spec §5.5 (W-20). The reviewer wrote none of it. Date:
2026-10-07. Branch `review/shield-v2-wallet-6`. **Nothing was fixed.** Scope: confirm or refute
the three claims below, nothing wider. Tests: `tests/review_wallet_6.rs` (10; 3 fail on purpose).

What stands, plainly: nothing found here loses money, releases a lock or confirms something that
is not on the chain. All three findings are liveness (G3, G4) and all three are in the LOOP —
the part three clients are about to transcribe — which is why they are conditions and not notes.
Two of them need a one-line rule each; the first needs a decision.

| # | Severity | Violates | Finding | Where | Test |
|---|---|---|---|---|---|
| RW6-1 | **Medium** | G4, G3; condition 1 (b) | `listing_refuted` is treated as evidence against the CURRENT listing node. It is raised for dissent at ANY height the state has a checkpoint for, also below the confirmed height, and those checkpoints are a previous listing node's word when the state was handed on without a rescan ("everything it holds is confirmed"). A liar lists the truth with one pool transaction one block late, votes honestly for the tip (confirmed), falls behind and is left; one honest node one or two blocks behind for three rounds then reports the height in between — truthfully — and the liar reports something else for it: refuted, and the node listed from is honest. Three nodes: both honest nodes banned, the liar the only node left, the loop never stops, nothing confirmed for the rest of the session. Five nodes, two liars: the same first ban | `client_loop.rs:183–185`, `226–232`; `NOTES.md:573`, `606`, `648–655`; `store.rs:2852–2873` | `rw6_f1_…` **FAILS** |
| RW6-2 | **Medium** | G4, G3; condition 1 (d); the Resolution's claim "no page makes `scan` answer anything but `listing:` or `rescan_required:`" | A page whose `nf1`, `nf2` or `cm_out` is 64 hexadecimal characters that are not a canonical digest (`ff…ff`) is answered with `WalletError::NonCanonical` (`non_canonical:`). The loop: "anything else → STOP(fault), no rescan, no retry". `listed_from` is stored, so the next session starts at the same node and stops at the same page. One liar, one page, every session; no honest lag needed | `store.rs:3143`, `3150` (`field::digest(..)?`); `client_loop.rs:126`; `NOTES.md:554`, `629–634`; known to the suite: `wallet_flow.rs:266` accepts that error from `scan` | `rw6_f2_…` **FAILS** |
| RW6-3 | Low | condition 1 ("an honest node is never banned") | A node of a chain without an activation height answers `{ "active": false, … }` (`core/daemon/src/node.rs`, `shield_v2_notes_since`). Step 1 calls "the page is not active" a short page and bans the node: three honest nodes, three rounds, "no honest listing node reachable". That is every mainnet node until the pool is activated | `client_loop.rs:129`; `NOTES.md:558–560` | `rw6_f3_…` **FAILS** |

---

## Check 1 — the ten conditions

| # | Kind | Verdict | What I verified myself |
|---|---|---|---|
| 1 | documents (the loop) | **PARTLY** | (a) **met**: a node that never reaches its tip, serves true but short pages, or serves the truth and then empty heights is left or banned inside the bound, n = 3 and n = 5, new and restored wallet (`rw6_sound_consistent_liars_…`; the two restated `rw5_demo_…loop` tests pass). (b) **NOT met**: RW6-1 — the liar is not "among them"; the honest node is. (c) **met** by reading: `rescan_required:` → `Decision::Rescan`, `L` stays, `bad` untouched (`client_loop.rs:123`, `248`). (d) **partly**: there is a rule for every error and `state_invariant:` stops; but a page reaches "anything else" (RW6-2). Stops when every node is banned and keeps `bad`: **met** (`rw5_demo_a_listing_node_…` last case; `rw6_sound_every_honest_node_unreachable_…` — and RW6-3 shows the stop firing on honest nodes). The property test's adversary has six persistent strategies and its client is `Session`: confirmed by reading and by two runs; none of the six is RW6-1, RW6-2 or RW6-3 |
| 2 | CORE | **MET** | `rw5_f1_…`, `rw5_f1b_…` pass; in each exactly one set-up line differs from the review's text (hunk census below). Property test `PROP_SEED_BASE=7000 PROP_RUNS=100 PROP_STEPS=1000`: passes, 934 s. `PROP_SEED_BASE=9000 PROP_RUNS=150` (not reported by the fixer): passes, 192 s. Five hostile pages of my own × full / viewing key × with / without a pending payment × synced / mid-rescan, each followed by two pages with the full key: 136 calls of `scan`, 128 accepted, 8 refused as `listing:`, **0 `state_invariant`**; every returned state reads back, every refused page leaves the state equal (`rw6_c2_…`). Read `validate` clause by clause against `scan_inner`: I found no reachable path. (RW6-2 is `non_canonical:`, not `state_invariant:` — condition 2 as worded is met; the wider sentence in §14 is not true) |
| 3 | UI-CONTRACT | **MET** (as a document) | `UI_CONTRACT.md` obligation 1, with a check a reviewer can perform. `common::configure` makes no statement; every call site of `configure_as_sole_copy` / `assert_no_other_copy_…` in the single-scenario tests is a wallet the test calls new, or a false statement by name (2: `rw3_demo` second half, `rw5_demo_the_override_stands` (b)); the property test also makes it for its live second device, as the fixer discloses |
| 4 | UI-CONTRACT | **MET** (document + reference) | Obligation 2; `Session::first_check_may_run`. Both checks the condition asks for, at the reference: one node a block ahead → no state check that round, `embargo_until` = height + 128 in the next; one node silent → exactly 5 waits, then height + 384 (`rw6_c4_…`, passes) |
| 5 | UI-CONTRACT | **MET** (document) | Obligation 3: blocks, the rate with its period, "an idle chain makes no blocks", no countdown, re-submit the stored envelope |
| 6 | CORE | **MET** | `rw5_f2_…`, `rw5_f3_…` pass and are byte for byte the review's (no hunk in either). IPv4-in-IPv6 list read against the RFCs: mapped `::ffff:0:0/96`, compatible `::/96` (not `::`, `::1`), translated `::ffff:0:0:0/96`, NAT64 well-known `64:ff9b::/96`, 6to4 `2002::/16`. Eight further spellings (upper case, uncompressed, mixed, with port and path) are one host (`rw6_c6_…`, passes). Not recognised, by design and stated: Teredo, ISATAP, a network-chosen NAT64 prefix — and, not stated, the local-use prefix `64:ff9b:1::/48` (RFC 8215) and an IPv4 loopback address in translated or compatible form (it is then not "loopback" either, so it cannot be mixed into a development set). 6to4 errs on the safe side: two different hosts of one 6to4 prefix are refused together |
| 7 | UI-CONTRACT | **MET** (document) | Obligation 4, with `listed_from` |
| 8 | INHERENT | **MET** (stated) | Limit 5: 257 / 321 blocks, the syncing node, "not a guarantee" |
| 9 | INHERENT | **MET** (stated) | Limit 6 and "For product owners"; the open decision is left to the owner |
| 10 | INHERENT | **MET** (stated) | Limit 7 |

## Check 2 — the edited tests

Method: every hunk of `git diff 0d3f2bd..b59088b` over the test files mapped to the function it
lies in (old side and new side), then every hunk read. `src/*tests*` and
`core/shield-v2-wasm/tests`: no change. **The fixer's count is right: 54 tests, and 4 more
through two shared scenario functions.** Not in that count, and described separately by the
fixer: the property test itself (about 880 lines changed) — a 55th.

**(a) Set-up only — one line (`configure_as_sole_copy` for a wallet the test calls new), nothing
else in the test changed: 43.** The node set of the added line is the set the test's own helper
configured before (checked for `review_wallet_2`: three nodes; `_3`: three; `rw3_f4b`,
`rw3_a_format_3`, `review_wallet_1`, `wallet_flow`: the two that `confirm` used to configure).

| File | Tests |
|---|---|
| `review_wallet_1` (3) | `rw1_f7_…` (two lines: the paying state, and the state "what `mark_pending` refuses" is asserted on), `rw1_sound_every_byte_…`, `rw1_sound_a_tampered_state_blob_…` |
| `review_wallet_2` (9) | `rw2_f1_…`, `rw2_f2_swapped_…`, `rw2_f2_a_hidden_spend_…`, `rw2_f3_the_same_two_inputs_…`, `rw2_f5_…`, `rw2_sound_the_release_height_…`, `rw2_f7_…`, `rw2_i3_…`, `rw2_i4_i5_…` |
| `review_wallet_3` (10) | `rw3_f1_…`, `rw3_f2_…`, `rw3_f3_…`, `rw3_f4b_…`, `rw3_f7_…`, `rw3_f7b_…`, `rw3_f7d_…`, `rw3_f5_…`, `rw3_sound_shifting_…`, `rw3_sound_idle_heights_…` |
| `review_wallet_4` (8) | `rw4_f5_…`, `rw4_demo_the_restore_embargo_…` (the "new wallet" half; the restored half was already `set_nodes` without the statement), `rw4_sound_a_spend_built_on_a_stale_…`, `rw4_sound_usable_window_…`, `rw4_sound_reports_for_heights_…`, `rw4_f4_…`, `rw4_sound_a_hostile_sender_…`, `rw4_demo_two_different_states_…` |
| `review_wallet_4_resolution` (7) | `rw4r_f5_fuzz_…`, `rw4r_f5_a_format_4_state_…`, `rw4r_f5_recover_locks_…`, `rw4r_f1_a_restored_state_builds_nothing_…` (the LOST device), `rw4r_f3_…`, `rw4r_f4_…`, `rw4r_i10_…` |
| `review_wallet_5` (4) | `rw5_f1_…` (+1 line), `rw5_f1b_…` (1 line changed), `rw5_sound_an_accepted_page_…`, `rw5_sound_the_longest_expiry_…` |
| `wallet_flow` (2) | `shield_transfer_unshield_with_real_proofs` (Alice's wallet and Bob's), `selection_and_merge` |
| through a shared function (4) | `restore_embargo_scenario` (the lost device `d1`): `rw4_f1_…`, `rw4_f1b_…`, `rw4_sound_without_lag_…`; `stale_quorum` (the lost device): `rw5_demo_the_restore_embargo_holds_…` |

`rw4_f4`: the line makes the refusal the test names (`recipient_mixed_address:`) the one that
fires; without it the build is refused earlier, by the embargo. A repair of the test, not a
weakening. `rw5_f1` / `rw5_f1b`: confirmed — one set-up line each, no assertion, scenario or
accepted outcome touched.

**(a′) Set-up only, several lines — a SECOND device that has to spend lets its embargo run out
(advance the chain to `spend_embargo_until`, scan, confirm, `spend_gate().is_ok()`); no assertion
changed: 3.** `rw2_f3_another_transaction_…` (+11 −2), `rw3_f7c_…` (+9 −2), `rw4_f3_…` (+5).
The chain of each is 128 blocks longer; every assertion is relative to it.

**(b) Assertion changed: 5.**

| Test | Old assertion | New assertion | Judgement |
|---|---|---|---|
| `rw3_demo_a_restored_device_has_no_locks_and_a_second_payment_from_another_note_pays_twice` | `b.pending().is_empty() && b.balances().spendable == 16 Q`; `bobs.balance() == 8 Q` ("LIMIT: Bob is paid twice") | two runs. Without a statement: `b.pending().is_empty() && b.balances().confirmed == 16 Q`; the build is `RestoredRecently { until }`; `until >= t1_expiry`; after the embargo the payment is built, `t1`'s expiry is below the chain's height, `bob == 4 Q`. With the user's false statement: `bob == 8 Q` | **Stronger.** The old test paid twice only because the helper made the statement for the restored device. The name's limit is now asserted for exactly the case in which it remains (a false statement), and the default is asserted to pay once. `spendable` became `confirmed` because an embargoed state has nothing spendable; in the false-statement run the payment itself shows the note was spendable. "Paid once" rests on the node's stateless expiry rule, as in `restore_embargo_scenario` |
| `rw4r_f1_the_embargo_base_is_bounded_and_the_users_statement_is_recorded_and_conditional` → `…_and_stands` | with the statement and a node one block ahead: `base_of(&s) == (tip + 1, tip + 129, false)` and the build is `RestoredRecently`; "not accepted once the base exists" | with the statement and a claim of `tip + 1`, `tip + 300`, `u64::MAX`: `base_of(&s) == (tip, tip, true)`, the build succeeds, the statement is refused afterwards; WITHOUT the statement and a node ahead: `(tip + 1, tip + 129, false)`, statement refused, build `RestoredRecently` | **A behaviour was traded, on the review's instruction** (RW5-5: "an unconditional recorded statement, or no override at all"). The part that bounds the base and the part "not accepted once the base exists" are kept and now run on a state without the statement |
| `rw5_demo_the_override_is_lost_to_a_one_block_race_…` → `rw5_demo_the_override_stands_…` | (a) `Until { 40, base 41, until 169, waived: false }`, gate closed; (b) with the leader silent: waived, `bob == 8 Q` | (a) `Until { 40, 40, 40, waived: true }`, gate open, pays; (b) with EVERY node answering: waived, `bob == 8 Q` | Restated with the rule it asserted. (b) now states the cost of the trade in the open: a false statement pays twice whatever the reports show |
| `rw5_sound_twin_notes_exist_only_in_a_lying_listing_and_are_one_note_to_every_rule` → `…_a_listing_that_shows_a_transaction_twice_is_refused` | the twin is stored; `(confirmed, unverified, spendable) == (16 Q, 10 Q, 16 Q)`; selection never uses it; a transaction from both is refused; a lock on one locks both; after a rescan one note | the page is `listing:` with both keys, for the same transaction again AND for other outputs under the same nullifiers; `w == before`; balances and lock unchanged; a state TEXT with two notes of one `rho` is refused and `recover_locks` keeps the entry; the honest listing goes on, the lock holds | **At least as strong**: every old assertion was about a state that can no longer exist (`validate`: one `rho`, one note). The second forged page is a case the old test did not have |
| `rw4_sound_own_outputs_from_the_record_are_credited_once_and_only_on_confirmed_data`, case (b) | `doubled.scan(twice).unwrap()`; `c.matched_height.is_none() && doubled.balances().confirmed == 0` | `scan(twice)` is `Err(Listing)`; `doubled == untouched && c.matched_height.is_none() && doubled.balance() == 0` | **Stronger** for the name ("credited once"): the total balance is 0, not only the confirmed one. Cases (a) and (c) unchanged |

**(c) Fixture or restated: 3 (+1).**

| Test | What changed | Judgement |
|---|---|---|
| `rw3_a_format_3_state_is_migrated_…` | the fixture removes the five fields format 5 added (it used to write "version 3" over a format-5 text); one set-up line; assertions unchanged | The fixture is now what a format-3 client wrote. The old fixture is refused as damaged (RW5-9) — a deliberate change of the core, asserted in `rw5r_f9_…` |
| `rw5_demo_a_listing_node_that_never_reaches_its_tip_is_never_left_…` → `…_is_left_and_the_tip_is_confirmed` | asserted non-termination of the old loop; runs `common::client_loop`, four liars × new / restored wallet, asserts tip confirmed inside a bound, one LEAVE, banned only on evidence, and the stop when every node lies | Restated as condition 1 asked. It passes; it does not contain RW6-1 to RW6-3 |
| `rw5_demo_one_lying_listing_node_gets_both_honest_nodes_blamed_…` → `…_gets_no_honest_node_blamed_…` | the review's scenario adapted to the new loop (phases 2 and 3 differ: which honest node lags, where the forged block sits) | Restated. "Phase for phase" is a little generous; the claim its name makes is refuted for another consistent liar by `rw6_f1_…` |
| (`settlement_guarantees_hold_against_an_independent_model`) | the client is `Session`; persistent strategies; three invariants that restated the code deleted, model invariants added | Not read line by line. Run on two ranges (below): passes. Its "only a lying node is ever banned" and "no page makes `scan` answer anything but `listing:` / `rescan_required:`" hold in its world because its adversary has no height-shifted listing, no page with a digest that is not canonical and no inactive page — RW4-6 and RW5-8 once more |

**The census.** Confirmed by reading every call site: no state that models a restore or a second
device is configured with `configure_as_sole_copy` except the two false statements made by name
(and the property test's live second device, which the fixer names: inherent limit 7).
`rw4_f1` / `rw4_f1b`: the restored device `d2` is configured with `configure` — **without** the
statement — and both pass because the core refuses the second build (`refused == true`): the
embargo base is the tip the leading honest node reported, not the lagging height.

**Did removing the voiding rule open a double payment an earlier test caught?** No. The only
tests that reached the embargo THROUGH the voiding rule were `rw4_f1` and `rw4_f1b` (REVIEW_WALLET_5
A.3), and they did so only because the helper made the statement for a restored device; that
device now makes none and is embargoed unconditionally — a stronger path than the one replaced.
What a restored device has now, plainly: **the embargo (128 blocks above the base; base up to 256
above the quorum's tip) unless the USER asserts sole copy; if the user asserts it falsely, nothing
in the core stands between that and a double payment** (`rw3_demo` second half, `rw5_demo_the_override_stands` (b)).
That is exactly condition 3 of the review ("the override's contract is the real control") and
its RW5-5 ("an unconditional recorded statement, or no override at all").

## Check 3 — the client loop

**Is `client_loop.rs` the algorithm of `NOTES.md` §6?** Yes, decision for decision: steps 0–3,
2a, 5 (`may_offer_payment`), LEAVE (`plan_leave` / `commit_leave`), the strike that is not taken
back in the round it was given. Differences, none material: the text says the reference uses
P = 6, `LoopClient` uses 4; `LoopClient::round` cannot express an unanswered listing request
(`after_no_answer` exists and the property test uses it; the two `rw5_demo_…loop` tests never
do — my driver adds it); "listed_from unknown → rescan" at the start of a session is the
caller's. Spec §5.5 mirrors the text, the three defects included.

**The bound `(n − quorum + 1)·(D + K + 2) + W`.** Justified for the adversaries it was derived
against, by hand:

* the quorum's tip `T` is the quorum-th highest claim, so liars cannot raise it above the highest
  honest tip, and catching up is forced at 64 heights a page (or the node is banned);
* once `scanned ≥ T` a round resets `strikes` only if what was scanned the round before is
  confirmed, so a tenure is at most `D + 1 + K`; at most `n − quorum` liars precede the first
  honest node; the honest tenure needs `D + 1`; `W` is spent once.

Measured (`rw6_sound_consistent_liars_…`): at most 10 rounds against 17 (n = 3), 14 against 23
(n = 5). Two things the derivation leans on that do not hold: "bans being evidence" (RW6-1,
RW6-3) and "a rule for every error" that goes on (RW6-2). One edge inside it: a listing node
that is always ONE EMPTY height ahead of a chain that grows a block every round is never struck
and `confirmed = scanned` never holds (no payment is offered); it needs a block per round and is
refuted by the first pool transaction — stated, not a finding.

**The adversaries, by hand and by test, n = 3 and n = 5** (liars first in the order):

| Adversary | Result | Test |
|---|---|---|
| never reaches its tip (the truth, then full pages to nowhere) | left after K strikes ("scanned stays above confirmed"), rescan, tip confirmed: 5 / 9 rounds, 10 / 14 restored | `rw6_sound_consistent_liars_…` |
| true but short pages | banned at its first page | same |
| the truth, then empty heights as its tip | left after K strikes, as the first | same |
| refuted (silent in the state check), then whatever | banned by `listing_refuted` in its first compared round | same |
| a forged payment, truthful in the state check | banned by `listing_refuted` | same |
| **truthful in the state check, one transaction listed a block late** | **the honest node is banned; n = 3: the session is the liar's** | `rw6_f1_…` **FAILS** |
| honest nodes 1–3 blocks apart for 12 rounds, the third node silent or reporting nonsense for every height in sight | no honest node banned; 1–2 rescans; settled once the nodes agree | `rw6_sound_honest_nodes_a_few_blocks_apart_…` |
| every honest node unreachable, then back (liars forging, truthful or silent; every start node) | no honest node banned, no stop, settled inside the bound after they are back, `bad` never cleared | `rw6_sound_every_honest_node_unreachable_…` |
| a pool that is active and empty | confirmed, no rescan | `rw6_sound_an_active_pool_without_a_transaction_…` |

**Are honest nodes ever banned?** By lag alone, by being unreachable, by a liar that only
reports: no. By RW6-1 (a liar plus one honest node one or two blocks behind for three rounds —
the shape of RW5-3) and by RW6-3: yes.

**Livelock.** None found with the honest majority at one height. With honest nodes apart the
loop leaves a node every K rounds, with a rescan when the node was ahead — the whole chain is
read again for one unconfirmed block at the tip. Work, as §6 says; at this chain's length D = 1.

### RW6-1 in detail

`NOTES.md` §6: *"A state whose scanned height is confirmed is the chain's, whoever listed it."*
True of the state AT that height; false of its history. `confirm_state` compares every reported
height with `state_at(height)` — the newest checkpoint at or below it — and sets
`listing_refuted` when dissent at ANY height exceeds `n − quorum`. A checkpoint below the
confirmed height was never looked at by a quorum.

```
rw6-f1, n = 3: left [(4, node 1, no ban, "behind the quorum's tip"), (5, node 2, BAN, "listing_refuted")]
… after 60 more rounds with both honest nodes at the tip: banned nodes [2, 3], L = node 1,
stopped None, confirmed None (the tip is 26)
rw6-f1, n = 5: left [(4, node 2, no ban, "behind the quorum's tip"), (5, node 3, BAN, "listing_refuted")]
```

Round 1: the liar lists block 21's transaction in block 22; it and the honest node at the tip
report 22 truthfully — confirmed at 22; the other honest node, at 21, dissents alone (not
refuted). Rounds 2–4: the chain is at 23, the liar "behind": left, no rescan. Round 5: the
honest node lists; the liar reports its own state for 21; the lagging node's true report for 21
is still among the last three rounds: two dissenters, `listing_refuted`, `LEAVE(ban)` of the
honest node. Nothing confirmed is wrong at any time; the balance is right. The honest nodes
answered truthfully in every round.

*Direction (not done; a decision):* the blame is exact only if every height `confirm_state` can
compare was listed by `L`. Either rescan on every change of node after all; or drop the
checkpoints below the confirmed height when a state is handed on; or have `confirm_state` say
WHERE it was refuted and ban only for a height above the height that was confirmed when `L` took
over (below it: rescan, nobody blamed).

### RW6-2 and RW6-3 in detail

```
rw6-f2: scan answers [("nf1", Err("nf1 is not a canonical digest")), ("nf2", …), ("cm_out", …)];
two sessions of the loop: [(Some(Fault("nf1 is not a canonical digest")), round 1, bad [], confirmed None), (the same)]
rw6-f3: three honest nodes of a chain without the pool: banned [0, 1, 2], stopped
Some(NoHonestListingNode) after 3 rounds
```

*Directions (not done):* RW6-2 — the three `field::digest(..)?` of a page's strings answer
`listing:` like every other malformed string of a page; and "anything else" from `scan` on a
page should not be able to hold a session (the review's condition 1 (d) asked for "RESCAN, list
from another node, report"). RW6-3 — an inactive page is not evidence: "the pool is not active
on this node", no ban.

## Outside the scope

**Blocking:** none beyond the three above.

**Noted, not blocking:**

* `wallet_flow::restore_recovers_notes_and_balance_but_no_outgoing_history` (unedited) builds an
  unshield from a restored, never-confirmed state through `spend_input_with(.., true)` and the
  raw assembly: the embargo gates `build_*` / `spend_base`, not the low-level Rust API.
  REVIEW_WALLET_5 checked the 26 wasm exports. A native binding (Qwalla, option A) must export
  the gated builders only.
* The property test proves less than its invariants say (Check 2, last row).
* `LoopClient` uses P = 4 where the documents say the reference uses 6.
* Condition 6: `64:ff9b:1::/48` and translated loopback forms (table above).
* `tests/review_wallet_6.rs` is in CI's selection: the wallet step is red on this branch until
  the three are fixed (it runs `--no-fail-fast`).

## Tests added (`tests/review_wallet_6.rs`)

| Test | Result |
|---|---|
| `rw6_f1_a_liar_that_votes_honestly_and_shifts_one_transaction_gets_the_honest_listing_node_banned` | **FAILS** (RW6-1) |
| `rw6_f2_a_page_with_a_digest_that_is_not_canonical_stops_the_loop_instead_of_banning_the_node` | **FAILS** (RW6-2) |
| `rw6_f3_an_honest_node_that_says_the_pool_is_not_active_is_banned` | **FAILS** (RW6-3) |
| `rw6_c2_five_hostile_pages_never_make_scan_answer_state_invariant` | passes |
| `rw6_c4_the_first_state_check_waits_for_every_node_and_at_most_w_rounds` | passes |
| `rw6_c6_ipv4_in_ipv6_spellings_are_one_host` | passes |
| `rw6_sound_consistent_liars_are_left_or_banned_within_the_bound_for_three_and_five_nodes` | passes |
| `rw6_sound_every_honest_node_unreachable_and_back_the_session_recovers_without_clearing_bans` | passes |
| `rw6_sound_honest_nodes_a_few_blocks_apart_with_a_liar_that_only_reports_are_never_banned` | passes |
| `rw6_sound_an_active_pool_without_a_transaction_is_confirmed` | passes |

Each failing test asserts the safe behaviour and turns green on a fix without an edit to what it
asserts.

## Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --no-run` | built |
| `PROP_SEED_BASE=7000 PROP_RUNS=100 PROP_STEPS=1000 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 934 s (4,871 payments, 781 restores, at most 13 rounds to settle) |
| `PROP_SEED_BASE=9000 PROP_RUNS=150 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 192 s (2,159 payments, 345 restores, at most 12 rounds) |
| `cargo test … --test review_wallet_6 --no-fail-fast -- --test-threads=1 --nocapture` | 10 tests: 7 passed, 3 failed on purpose, 2 s |
| `PROP_RUNS=20 cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1` | **143 tests: 140 passed, 3 failed on purpose.** Wallet: unit 22, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `_5` 12, `_5_resolution` 7, `_6` 7 + **3 failed**, `settlement_properties` 1 (seeds 1–20), `vectors` 3, `wallet_flow` 6; wasm 7. The fixer's 133 all pass. 343 s with the build of the wasm crate |

About 21 minutes of test time under the limits (the 7000 range is 15.5 of them), against a
budget of about 30. Not run: the default 200-seed range, the 5000 range, the mutations, the
censuses, the wasm32 build, the daemon's interop tests, the noble cross-check — the Resolution
reports them; nothing here contradicts them. No source file was edited. `core/target/` was
deleted. Nothing was pushed; nothing outside this worktree was read or written; no service,
proxy or node was touched.
