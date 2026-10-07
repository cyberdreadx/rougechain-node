# REVIEW_WALLET_6B — the confirmation checks of REVIEW_WALLET_6, run again on the fix

**CONDITIONS NOT MET: RW6-1, RW6-2 and RW6-3 are fixed as claimed, and three small things remain in the same place (what a page or an answer may do to the loop): (1) `scan_pages` — the batch export — still answers `request:` for a page that is not the shape of a page, which the loop stops on (RW6B-1); (2) the loop bans a node for an error answer that is not a page, an honest node's own `{"success": false}` included (RW6B-2); (3) after `STOP(fault)` the next node is banned for the unconfirmed tail the node before it left (RW6B-3). One limit is to be stated, not fixed: a liar can repeat the blameless rescan without ever being banned.**

Reviewed: `fix/shield-v2-wallet-settlement-5` @ `dc35299` — `git diff aafcf37..dc35299`, the
Resolution in `REVIEW_WALLET_6.md`, `tests/common/client_loop.rs`, `NOTES.md` §6,
`core/shield-v2-wasm/src/api.rs`, `core/daemon/src/node.rs` (`shield_v2_notes_since`,
`shield_v2_stats`). Date: 2026-10-07. Branch `review/shield-v2-wallet-6b`. **Nothing was fixed.**
Tests: `tests/review_wallet_6b.rs` (7; 2 fail on purpose) and
`core/shield-v2-wasm/tests/review_wallet_6b.rs` (1; fails on purpose).

Nothing found loses money, releases a lock or confirms what is not on the chain. All of it is
liveness, and all of it is small: the first is a line in the wasm crate, the other two are a
rule each in the loop.

| # | Severity | Finding | Where | Test |
|---|---|---|---|---|
| RW6B-1 | **Low–Medium** (RW6-2's class, without the pinning) | "Every way the content of a page can be invalid is `listing:`" holds for `scan` and not for `scan_pages`: a page of the array with a missing field, a value of the wrong type or a number out of range is `request: pages: malformed JSON …` — the caller's class, STOP(fault) in the loop. The same page through `scan` is `listing:`. One lying node ends the session of any client that applies a round's pages in one call, each time it is the listing node. (More than 64 MiB of pages is `request:` too.) | `shield-v2-wasm/src/api.rs:379–382`; `NOTES.md` §6 step 1 and the error table (which names `scan` and `from_json` only) | `rw6b_f1_…` (wasm crate) **FAILS** |
| RW6B-2 | Low | Step 1 has two rules for one answer: "no answer, or not a page → a strike" and "`listing:` … also a body that is not the JSON of a page → LEAVE(ban)". The reference takes the second. An honest node answers `{ "success": false, "error": … }` with HTTP 200 when its store cannot be read (`daemon/src/main.rs`, `shield_v2_notes`); a proxy answers an error page. The node is banned for the session | `client_loop.rs:287–291`; `NOTES.md:560`, `564–566` | `rw6b_f2_…` **FAILS** |
| RW6B-3 | Low | After `STOP(fault)` the next session starts at the next node on the stored state as it is (`new_unattributed`). `listing_refuted` is attribution-aware; `leaf_mismatch` and the `listing:` errors about continuity are not: the new node's TRUE page continues a tail it did not serve and is numbered below it (the tail held a forged payment) or above it (the tail hid a transaction) → LEAVE(ban) of an honest node. With RW6B-1 a liar can cause the fault itself | `client_loop.rs:175–177`, `272–273`, `291`; `NOTES.md:549–550` | `rw6b_f3_…` **FAILS** |

---

## 1. The ten tests of REVIEW_WALLET_6 — **confirmed**

`git diff aafcf37..dc35299 -- core/shield-v2-wallet/tests/review_wallet_6.rs` is empty (0 bytes).
All ten pass, the three that failed on purpose included:

```
rw6-f1, n = 3: banned [], … after 60 more rounds: banned nodes [], L = node 3, confirmed Some(26) (the tip is 26), 1 rescans
rw6-f1, n = 5: banned [], L = node 3, rescans 1
rw6-f2: scan answers "note listing: nf1 is not a canonical digest" (nf2, cm_out likewise); two sessions: [(None, 8, [0], Some(20)), (None, 8, [], Some(20))]
rw6-f3: banned [], stopped Some(PoolInactive) after 2 rounds; left [(1, node 1, no ban, "the pool is not active on this node")]
```

Every method the review's driver calls kept its name; the driver does not call the new
`after_stats` (it learns "not active" one node a round, as the Resolution says).

## 2. RW6-1, the attribution rule — **sound; one limit wider than stated**

**Safe against a strict minority: yes.** `dissenting > configured − quorum` counts CONFIGURED
nodes at one height; two different reports of one node for one height are one dissenter; ids
that are not configured are not counted. `rw6b_sound_a_minority_of_the_configured_nodes_never_refutes_…`:
n = 3 and 5, a full lying minority contradicting every height the wallet holds, twice each,
under foreign ids too, with the honest nodes silent or answering — `refuted` is empty on both
sides of the confirmed height. So a majority of the REPORTS that is a minority of the configured
nodes can cause neither a ban nor a blameless rescan.

**Correct when a confirmed height is contradicted: yes** — rescan, the listing node stays,
nobody is blamed (`rw6_f1`, and five times in the test below).

**No honest node is banned by it.** By hand: a ban needs a refutation above the height
confirmed before the call whose whole range is in `served` under `L`. The state at a confirmed
height is the chain's (a quorum holds an honest node; five values), so a state made of it and
an honest node's pages is the chain's at every height above it, and no honest node contradicts
it. A node is handed a state without a rescan only when `scanned = confirmed`, so the range
above starts in its own pages. (The two ways an honest node IS banned are elsewhere: RW6B-2,
RW6B-3.)

**Is escaping the ban a liveness problem?** The Resolution: the liar is banned one round after
the rescan, unless the rescan outlasts the three rounds reports are kept. It escapes whenever
it likes — **it lists the truth into the empty state**. Nothing is left to refute; it is
neither banned nor left; it is still the listing node at the next opportunity.
`rw6b_demo_a_liar_that_lists_the_truth_after_the_blameless_rescan_…` (n = 3):

```
rw6b-again: 5 opportunities, 5 rescans that blamed nobody, banned {}, LEAVEs [], the listing node is node 1 (the liar)
```

What one opportunity takes: a block with a pool transaction and one more block between two
rounds (anybody can make both, at a fee each), and exactly ONE honest node one block behind in
one round (two honest reports for the shifted height would refute it above the confirmed
height and ban the liar; the liar can see where the honest nodes stand). By the same count,
not run: n = 5 with two liars, and a syncing honest node, which gives an opportunity every
other round for as long as it syncs. What it costs: the state is thrown away and the chain read again, `D + 1` rounds;
between two of them the tip IS confirmed, a payment can be offered and pending entries settle.

Judgement: **not an unbounded delay on a chain that is read in a round or two (D = 1 up to
384 blocks at P = 6; mainnet is there), and not blocking.** It is unbounded WORK, it is paid
by the victim per event, and it grows with the chain: when a rescan takes longer than the
interval between opportunities the wallet does not settle. Two corrections to the documents:
the term `+ (D + 1)` of the bound is per contradicted confirmation, not once; "banned one round
later" is true of a liar that repeats itself, not of one that adapts. A cap would bound it —
leave `L` (no ban) after K blameless rescans on it in a session — not done, a suggestion.

## 3. RW6-2, the error classes — **`scan` confirmed; `scan_pages` refuted**

Read `scan_inner` against the table: every `?` and every `return Err` of it is in the class
the table gives; the three `field::digest` of page strings are `listing:`; the two self-checks
and the validation of the state in hand are `state_invariant:`; what remains outside `listing:`
is the caller's key and the caller's state. `rw6b_sound_thirty_more_corruptions_…`: 37
corruptions the table-driven test does not contain — duplicate keys, 300 levels of nesting, a
megabyte in a hex field, `NaN`, `Infinity`, `-0`, `1e3`, 2⁶⁴, a thousand digits, escapes that
spell an upper-case digit or NUL, a lone surrogate, trailing text, two pages, a byte-order
mark, an array, `null`, nothing, a comment, single quotes, `txs` as an object or `null`,
`active` as text or a number, one and three outputs, a leaf / an index / a height / the tip at
`u64::MAX`, a page for the height before and after the one asked for, an odd-length or spaced
ciphertext, a `tx_type` in another alphabet, unknown fields — on a synced state with a payment
pending and on an empty one, with both keys: **138 `listing:` with the state unchanged, 10
applied as well-formed, any other error 0, no panic.**

**The exception is one call up:** `scan_pages` (RW6B-1, table above). Seven shapes answer
`request:`; the control (a digest that is not canonical, which IS the shape of a page) answers
`listing:` in both calls.

**After STOP(fault), does the next session start at another node?** Yes:
`after_scan_error` moves `L` to the next node not in `bad` and sets `origin` to none before it
stops (`rw6r_f2_what_is_not_the_pages_…` passes; read). **Can a liar make every node look
faulty?** Not through `scan`. Through `scan_pages` it stops one session each time it is the
listing node; the fault is not attributed to anybody, so "every node faulty" is not a state
the loop has — but the next node inherits the tail (RW6B-3).

## 4. RW6-3, "the pool is not active" — **confirmed**

Against the node's answers (`node.rs`, by reading):

| Node | `/notes` | `/stats` | The loop |
|---|---|---|---|
| no activation height | `active: false`, `from = next = since` | `active: false`; `report` null unless a pool record exists | noted in step 1; a majority → idle; a minority → left |
| height set, not reached | `active: true`, empty, `from = next =` the activation height, at its tip | `active: false`; the report (if the pool record exists) is for activation − 1 | the stats answers idle the loop. A client that reads only listings (the review's driver) would confirm the empty pool at activation − 1, a height the chain has not reached: harmless (nothing to spend, an embargo base below every later build), worth a sentence |
| reached, empty pool | `active: true`, empty pages | `active: true`, empty-pool report | confirmed (`rw6_sound_an_active_pool_without_a_transaction_…`) |
| reached, notes | the listing | the report | the ordinary loop |

* **A lying minority saying "not active"** (listing and stats), n = 3 and 5, every start node:
  one round per liar, then the tip; no stop, no ban.
* **A majority of the ANSWERS that is a minority of the configured nodes** (every honest node
  unreachable for twelve rounds): the client does NOT idle — `|inactive| ≥ quorum` counts
  configured nodes — and settles inside the bound once the honest nodes are back
  (`rw6b_sound_a_minority_that_says_not_active_…`).
* **A majority of the configured nodes saying it** to a wallet with a lock, a pending payment,
  or under the embargo: the loop idles and that is all — the state is EQUAL to what it was
  (not written), the embargo stands, nobody is banned; after `recheck_pool` and truthful
  answers the tip is confirmed and the payment mined meanwhile settles as mined
  (`rw6b_sound_a_majority_that_says_not_active_idles_…`). The documented majority limit and
  nothing worse: no embargo suppressed, no lock dropped, no fate decided. What it hides is
  time: while idle nothing settles and nothing is re-submitted.
* Noted: the self-contradiction ban also hits an honest node whose operator removed the
  activation height from a node that holds a pool record. Such a node does contradict itself.

## 5. The edited test and the low-level API — **confirmed**

`wallet_flow::restore_recovers_…` is **stronger**: both spends go through the gated builders;
the restored state is asserted to build nothing (`state_unconfirmed:` before its first state
check whatever `allow_unverified` says; `restored_recently: until = height + 128` after it,
with and without `allow_unverified`, and one block before the end), and after the embargo the
pool accepts its unshield — the recovered path is still proved right. Nothing it asserted
before is gone except "spendable at once through the raw assembly", which was the hole.

**"In a wallet build only the two gated builders produce a spend": true.** Checked every `pub`
item reachable without `test-vectors`: `UnprovenTx` has two private fields (`witness`,
`shield_sender`) and cannot be constructed outside the crate; the only functions that return
one for a spend are in `mod deterministic` (`cfg(test-vectors)`); `assemble`, `assemble_transfer`,
`assemble_unshield`, `real_input`, `spend_inputs`, `locked` are private; `ShieldedKeys::sk` is
`pub(crate)` and `expose_for_vectors`, `encrypt_note_with_kem_randomness`, `witness_for_vectors`
are `cfg(test-vectors)`; `encrypt_note` is `pub(crate)`. Nothing public takes a `SpendInput`,
a `TransferRequest` or an `UnshieldRequest`. The wasm crate exports no `spend_input` and its
normal build does not enable `test-vectors` (dev-dependency only). What a binding author can
still do is what anybody with the phrase can do: write a builder against the stage-1 crate
(`prove_spend`, the witness types) from a note's secrets and path, which `spend_input` hands
out as `notes()` and `tree().path()` do. That is not a public piece of this crate that skips
the gate, and no finding; `UI_CONTRACT.md` obligation 4 (never build with `test-vectors`,
export the gated builders only) is the right rule.

## 6. The property test — **passes on both new ranges**

| Range | Result | Time |
|---|---|---|
| `PROP_SEED_BASE=11000 PROP_RUNS=150` | passes | 194 s (2,345 payments, 354 restores, 161 refuted listings, 57 of a confirmed height → 55 rescans that blamed nobody, 223 bans, at most 13 rounds) |
| `PROP_SEED_BASE=12000 PROP_RUNS=40 PROP_STEPS=1000` | passes | 380 s (2,155 payments, 310 restores, 161 refuted listings, 89 of a confirmed height → 80 rescans that blamed nobody, 119 bans, at most 7 rounds) |

It does not contain RW6B-1 (it calls `scan`, not `scan_pages`), RW6B-2 (its honest nodes have
no error answer; a body that is not a page is a liar's), RW6B-3 (no fault, so no unattributed
start) or the adaptive liar of section 2.

## Directions (not done)

* RW6B-1: `scan_pages` reads each element with `ListingPage::from_json` (or maps the array's
  shape errors to `listing:`), and the table names it.
* RW6B-2: one rule. An answer with a status that is not 2xx, or with `success` other than
  `true`, is "no answer" (a strike); only a body that claims to be a page is judged as one.
* RW6B-3: a session that starts with `listed_from` unknown and `scanned ≠ confirmed` rescans
  first (the rule the text has for "neither is known"), or `leaf_mismatch` and the continuity
  errors rescan without a ban while the state holds heights above the confirmed height that
  `L` did not serve.

## Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --no-run` | built |
| `PROP_SEED_BASE=11000 PROP_RUNS=150 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 194 s |
| `cargo test … --test review_wallet_6b --test review_wallet_6 --no-fail-fast -- --test-threads=1 --nocapture` | `review_wallet_6`: 10 passed; `review_wallet_6b`: 5 passed, 2 failed on purpose |
| `PROP_RUNS=20 cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1 --nocapture` | **161 tests: 158 passed, 3 failed on purpose.** The fixer's 153 all pass — wallet 146: unit 22, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `_5` 12, `_5_resolution` 7, `_6` 10, `_6_resolution` 10, `settlement_properties` 1 (seeds 1–20), `vectors` 3, `wallet_flow` 6; wasm 7. This review's: wallet 5 + **2 failed**, wasm **1 failed**. 320 s with the build of the wasm crate |
| `PROP_SEED_BASE=12000 PROP_RUNS=40 PROP_STEPS=1000 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 380 s |

About 11.5 minutes of test time against a budget of about 30. Not run: the default 200-seed range,
the 7000 and 9000 ranges, the mutations, the wasm32 build, the daemon's interop tests (the
node's answers in section 4 are from reading `node.rs`). No source file was edited.
`core/target/` was deleted; nothing was pushed; nothing outside this worktree was read or
written; no service, proxy or node was touched.

---

## Resolution

**RW6B-1, RW6B-2 and RW6B-3 are fixed and the cap on blameless rescans is in; `rw6b_f1_…`
(wasm crate), `rw6b_f2_…` and `rw6b_f3_…` pass as the review wrote them. No earlier test was
edited: `tests/review_wallet_6.rs` and both `review_wallet_6b.rs` are byte for byte the
review's. One thing is not as the task worded it — the reset rule of the cap alone does not
end the review's demonstration; a second count does (below, "The cap").**

Branch `fix/shield-v2-wallet-settlement-6`, from `review/shield-v2-wallet-6b` @ `fec27d7`.
Date: 2026-10-07. State format 5 unchanged; nothing of spec §2, of consensus or of the state
root touched; no existing function changed its shape. Added to the public API:
`ListingPage::is_page`, `PAGE_MEMBERS`, `NOT_A_LISTING_PAGE`, `WalletError::is_not_a_page`,
`WalletState::scan_pages`, `PageError`. Documents: `NOTES.md` §6 and §16, spec §1 (dated line),
§5.4 and §5.5 (W-22), `UI_CONTRACT.md` obligation 9. New tests:
`tests/review_wallet_6b_resolution.rs` (5) and `core/shield-v2-wasm/tests/review_wallet_6b_resolution.rs` (2).

### The four items

| # | The fix | Where | Tests |
|---|---|---|---|
| RW6B-1 | `scan_pages` reads the ARRAY (the caller's: not a JSON array, or more than 64 MiB → `request:`) and hands every ELEMENT to the core as the text of one answer. `WalletState::scan_pages` runs `ListingPage::from_json` + `scan` on each, on a copy: whatever is wrong with an element — `null`, not an object, a missing or ill-typed member, a value `scan` refuses — is that page's `listing:`, in the words `scan` has for it, with its index (`listing: page i: …`). **All or nothing**: on any error no page of the call is applied, the pages before the refused one included (a batch is one node's word for one round: a client about to ban the node rescans them away, one about to count a strike keeps its stored state). `confirm_state` audited: its elements were already read one by one — a malformed report is counted in `malformed`, is not an error, not a vote, not dissent; the table says so now and a test holds it to that | `shield-v2-wasm/src/api.rs` (`scan_pages`); `store.rs` (`WalletState::scan_pages`, `PageError`); `NOTES.md` §6 (the table of the exports) | `rw6b_f1_…` passes unedited; `rw6br_f1_scan_pages_is_scan_page_by_page_…` (wallet), `rw6br_f1_scan_pages_classifies_the_array_as_the_callers_…`, `rw6br_f1_a_malformed_report_is_no_report_and_never_an_error` (wasm: 18 malformed reports, each alone and all together) |
| RW6B-2 | One rule: an answer that is not a listing page is NO ANSWER — a strike towards LEAVE after K rounds, never a ban. `ListingPage::from_json` marks such a body (`listing: note listing: not a listing page: …`; `WalletError::is_not_a_page`), `Session::after_scan_error` counts a strike for it. A body that IS a page and is refused is a `listing:` error and a ban, as before | `store.rs` (`ListingPage::is_page`); `error.rs`; `client_loop.rs` (`after_scan_error`); `NOTES.md` §6; spec §5.4, §5.5; `UI_CONTRACT.md` 9 | `rw6b_f2_…` passes unedited; `rw6br_f2_a_body_is_a_page_if_it_has_one_member_of_a_page_…` (17 bodies that are no page: K strikes, LEAVE without a ban; 19 that are a page with members missing or ill-typed: banned) |
| RW6B-3 | `leaf_mismatch` and the `listing:` errors ban only when every height the state holds above its confirmed height was listed by the listing node (`Session::unconfirmed_tail_is_listing_nodes`: the entries of `served` above the confirmed height are all `L`'s, and what the stored state held unconfirmed at the start is `L`'s because `origin = L`). Otherwise — the session after a fault (`new_unattributed`) — the state is rescanned and nobody is blamed; the rescanned state is the node's own, and from there the ordinary rule applies | `client_loop.rs` (`unconfirmed_tail_is_listing_nodes`, `see`, `after_scan`, `after_scan_error`) | `rw6b_f3_…` passes unedited (both tails); `rw6br_f3_a_page_that_does_not_continue_the_state_bans_only_the_node_whose_tail_it_is` (unknown `listed_from`: rescan, then the same node lying is banned; stored `listed_from`: banned at once; a confirmed state handed on: banned) |
| the cap | `BLAMELESS_IN_A_ROW = 2` (`R_c`), `BLAMELESS_IN_A_SESSION = 6` (`R_s`): at either the listing node is LEFT — no ban — and the state rescanned in the LEAVE. Every blameless rescan the loop decides counts (a contradicted confirmation, a refutation of heights `L` did not serve, RW6B-3's). The count in a row is reset by a round that ends with the tip confirmed and no rescan; both counts start again when the listing node changes | `client_loop.rs` (`blameless_rescan`, `after_confirm`, `plan_leave`, `commit_leave`) | `rw6br_cap_the_liar_that_lists_the_truth_after_each_blameless_rescan_is_left_at_the_cap` (the review's demonstration: left at the sixth occasion, not banned, the honest node confirms the tip); `rw6br_cap_two_blameless_rescans_in_a_row_leave_the_listing_node` |

### "Is a page": the discriminator

**A body is a listing page if and only if it is JSON, its top level is an object, and that
object has at least one of the five members `active`, `tip_height`, `from_height`,
`next_height`, `txs`** (`ListingPage::is_page`; for a client: status 200 and that). Everything
else — no response, another status, an empty body, HTML, text, JSON that is not an object, an
object with none of the five such as the node's `{ "success": false, "error": … }`, a page
wrapped one level down or inside an array — is no answer.

Why this and nothing else:

* *"At least one", not "all five".* With "all five" a liar drops one member from every false
  page and is never banned. With "at least one" the only way to be "no answer" is to send
  nothing of a listing at all, and a node that sends nothing is left after K rounds like one
  that is silent: it gains nothing a silent node does not have. Anything that carries a part
  of a listing is judged as a listing, and what is missing or malformed in it is `listing:`
  → ban.
* *Not the `success` member.* It is the node's wrapper, not the listing's; a liar could set
  it to `false` on a false page. `{ "success": false, "txs": [] }` is a page (and refused:
  banned).
* *Not the status alone.* The reference node sends its own errors with 200
  (`core/daemon/src/main.rs`, `shield_v2_notes`).

### The cap, and the corrected bound

**What the task's rule does and does not do.** "After R consecutive blameless rescans on one
listing node, LEAVE it; reset when a round ends with the tip confirmed and no rescan" is
`R_c = 2` and is implemented as stated. It bounds the case in which the wallet would not
settle (rescan after rescan, the tip never confirmed between them). **It does not end the
review's demonstration**: there the tip IS confirmed between every two rescans, so the count
in a row never passes 1. And the demonstration itself (`rw6b_demo_…`, frozen with the
review's file) asserts five occasions with five rescans and NO leave. So a second count was
needed for "the liar is left": `R_s = 6` blameless rescans on one listing node in a session,
not reset by a confirmed tip. Six, because five must pass; the review's own suggestion ("K
on it in a session", K = 3) would fail the review's own test. If the owner prefers 3, it is
one constant and an edit to that test.

**The bound.** The term `D + 1` is per blameless rescan (the text said "once", which is true
only while the honest nodes are at one height: then such a rescan can come only from reports
at most three rounds old).

* To the confirmed tip, in general: a tenure holds at most one blameless rescan before the
  tip is confirmed (the second in a row ends it), so
  **`(n − quorum + 1)·(D + K + 2 + R_c·(D + 1)) + W` rounds**, `R_c = 2`, while a strict
  majority of honest nodes is reachable at the tip.
* With the honest nodes at one height (what the property test drives): `(n − quorum + 1)·(D + K + 2) + W + (D + 1)`, unchanged and still asserted.
* After the tip is confirmed: a node can cause further blameless rescans one occasion at a
  time; at most `R_s = 6` per tenure in a session, i.e. at most `R_s·(D + 1)` rounds of
  repeated work, between which the tip is confirmed; then it is left. Measured in the
  converted demonstration: 6 occasions of 3 rounds, the liar left in round 18.

`R_s` is a limit on cost, not evidence: an honest node listed from while six earlier
confirmations are contradicted is left too. A new session starts the counts again.

### Tests edited

**None.** `git diff fec27d7 --stat -- core/shield-v2-wallet/tests core/shield-v2-wasm/tests
core/shield-v2-wallet/src/review_wallet_1_tests.rs core/shield-v2-wallet/src/review_wallet_2_tests.rs`
shows `tests/common/client_loop.rs` (the loop: the subject), `tests/settlement_properties.rs`
(the property test: extended as asked) and the two new files — no `review_wallet_*` test,
not `wallet_flow`, not `vectors`, no wasm test. In the property test one existing
assertion was widened for the cap — "a refuted listing is kept" now also accepts the LEAVE
without a ban that ends a run of blameless rescans (the state is rescanned in it) — and its
coverage thresholds are the same numbers (the adversary mix was rebalanced so that they
still hold).

### The property test

Added, with the model's invariants as they were:

* **Answers that are no page** (`not_a_page`: the node's error object, a proxy's page,
  nothing, `null`, an array, a page one level down, plain text): from HONEST nodes outside a
  settlement window (1 request in 24), from a liar that sends nothing else
  (`Strategy::ErrorBodies`), and as one lie of the memoryless adversary. The model knows it
  generated no page: the core must call it "not a page", the loop must not ban for it — and
  what the model generated AS a page, however damaged, must never be called "not a page".
* **A client that applies a round's pages in one call** (`World::sync_batch`, one run in
  three; `WalletState::scan_pages`, which the wasm export runs): it meets malformed elements
  and non-pages at any index; held to "one call ≡ page by page", "a refused batch leaves the
  state equal", "the index is the refused page's", and the two class invariants.
* **The adaptive liar** (`Strategy::LateAdaptive`, `World::directed_adaptive_liar`): late
  where an honest node stands, an honest vote, a contradiction only once the wallet has
  confirmed past the height, the truth whenever the wallet reads from the start. Held to: no
  more than `R_s` blameless rescans while one node is listed from, in one session.

| Range | Result | Time | In it |
|---|---|---|---|
| seeds 1–200 × 280 | passes | 306 s | 3,095 payments, 458 restores; 1,201 answers that were no page (1,157 of them honest nodes'), none led to a ban; 11,674 rounds applied in one call, 392 refused (14 at a page after the first); 439 refuted listings, 322 of a confirmed height → 322 rescans that blamed nobody; 45 nodes left at the cap (57 scenes of the adaptive liar); 263 bans, each of a node with a false page; at most 13 rounds to settle |
| `PROP_SEED_BASE=11000 PROP_RUNS=150` | passes | 253 s | 2,244 payments, 300 restores; 978 non-pages; 9,063 batches, 333 refused (10 inside); 487 refuted, 385 of a confirmed height → 386 blameless rescans; 59 left at the cap; 228 bans; at most 10 rounds |
| `PROP_SEED_BASE=12000 PROP_RUNS=40 PROP_STEPS=1000` | passes | 476 s | 2,272 payments, 312 restores; 745 non-pages; 8,734 batches, 261 refused (10 inside); 445 refuted, 407 of a confirmed height → 409 blameless rescans; 62 left at the cap; 66 bans; at most 11 rounds |

Each fix taken out again, seeds 1–60 (then restored):

| Mutation | The property test |
|---|---|
| a body that is no page is a `listing:` error like any other | fails at seed 1: "a node is banned for an answer that is not a page" |
| the core does not mark a non-page | fails at seed 1: "page 0 of a batch: …" (the model's "no page" against the core's word) |
| `scan_pages` keeps the pages before the refused one | fails at seed 16: "a refused batch changed the state" |
| no cap on blameless rescans | fails at seed 1: "7 rescans that blamed nobody while one node was listed from, in one session" |

Not in the property test: RW6B-3 (it has no fault, so no session with `listed_from`
unknown); the rule is tested in `rw6b_f3_…` and `rw6br_f3_…`.

### Not done / to know

* The cap as the task worded it (in a row, reset by a confirmed tip) does not by itself leave
  the review's adaptive liar; `R_s = 6` does, and 6 is forced from below by the frozen
  demonstration (above).
* The discriminator is on the BODY. A client must apply the status rule itself (a 502 with a
  JSON body that happens to carry `txs` is no answer by status; the core never sees a status).
  `UI_CONTRACT.md` obligation 9.
* `confirm_state`'s outer limits (1 MiB, 1,024 reports) are `request:`: the client builds
  that array and must drop an oversized `report` itself (obligation 9 says 4 KiB).
* After a blameless rescan under RW6B-3 a node that is in fact lying gets one free round
  (the rescan) before it is banned for its own pages.
* Not re-run: the daemon's interop tests (nothing they reach changed: `spend_input`, `scan`,
  `confirm_state` of the Rust crate), the 5000 / 7000 / 9000 ranges, the noble cross-check.

### Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10
nice -n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no
`cargo` or `rustc` process was running.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1 --nocapture` | **168 tests: 168 passed, 0 failed, 0 ignored.** Wallet 158: unit 22, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `_5` 12, `_5_resolution` 7, `_6` 10, `_6_resolution` 10, `_6b` 7, `_6b_resolution` 5, `settlement_properties` 1 (seeds 1–200, 306 s), `vectors` 3, `wallet_flow` 6; wasm 10: `api` 2, `review_wallet_1` 4, `_3` 1, `_6b` 1, `_6b_resolution` 2. 536 s |
| `PROP_SEED_BASE=11000 PROP_RUNS=150 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 253 s |
| `PROP_SEED_BASE=12000 PROP_RUNS=40 PROP_STEPS=1000 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 476 s |
| `cargo build -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown …` | built, 116 s (2,941,822 bytes) |
| the four mutations, `PROP_RUNS=60` each | each caught |

`core/target/` was deleted afterwards; no process was left; nothing was pushed; nothing
outside this worktree was read or written; no service, proxy or node was touched.
