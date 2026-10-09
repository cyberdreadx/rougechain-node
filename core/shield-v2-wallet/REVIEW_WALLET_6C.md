# REVIEW_WALLET_6C — final confirmation pass

**CONDITIONS NOT MET: RW6B-1, RW6B-2 and RW6B-3 are fixed and the caps are sound, but one thing remains and it is not Low — a single configured node can make `confirm_state` (and the listing node can make `scan_pages`) answer `request:`, the caller's class, by putting a lone-surrogate string or a member nested deeper than 128 into its report or page (RW6C-1). For `confirm_state` that is any one lying node, in every round of every session: nothing is ever confirmed.**

Reviewed: `fix/shield-v2-wallet-settlement-6` @ `1b61659` — `git diff fec27d7..1b61659`, the
Resolution in `REVIEW_WALLET_6B.md`, `tests/common/client_loop.rs`, `NOTES.md` §6,
`UI_CONTRACT.md` obligation 9, `core/shield-v2-wasm/src/api.rs`. Date: 2026-10-07. Branch
`review/shield-v2-wallet-6c`. **Nothing was fixed.** Tests: `tests/review_wallet_6c.rs` (4, all
pass) and `core/shield-v2-wasm/tests/review_wallet_6c.rs` (2; 1 fails on purpose).

**For the owner, plainly.** No funds can be lost by anything found in this pass or the two
before it. RW6C-1 is a stall, not a loss: locks hold, nothing is released, nothing false is
confirmed — but the stall has no bound while the lying node stays configured, so it is a
blocker and not a documented limit. It does not need another review round of this size: it is
one narrow change with two possible homes (below), and its check is the one failing test here
turning green. Everything else that remains is Low / Info and I would accept it as documented
limits (listed at the end).

| # | Severity | Finding | Where | Test |
|---|---|---|---|---|
| RW6C-1 | **Medium** (G3, G4) | `confirm_state` and `scan_pages` read the whole ARRAY with one `serde_json::from_str`. Two things a node can put inside its own element make that call fail, although the client did exactly what obligation 9 says (parsed the answer, took the JSON object, under 4 KiB, wrote the array with `JSON.stringify`): a string that is a lone surrogate escape (`"\ud800"`), and any member nested more than 128 deep. Answer: `request: state reports: malformed JSON …` / `request: pages: malformed JSON …`. The documents promise the opposite ("anything … no report from that node … never an error"; "exactly as `scan`, with the element's index"), give step 3 of the loop no rule for an error of `confirm_state`, and class `request:` as the caller's (STOP(fault)); the reference `unwrap()`s. **`confirm_state`: every configured node is asked every round, so ONE lying node — whichever node is listed from — fails every state check.** `scan_pages`: the listing node stops the session, as in RW6B-1 | `shield-v2-wasm/src/api.rs` (`confirm_state`: `let raw: Vec<Value> = serde_json::from_str(reports_json)`; `scan_pages`: `let pages: Vec<Value> = …`); `NOTES.md` §6, the table of the exports; `UI_CONTRACT.md` 9 | `rw6c_f1_…` (wasm crate) **FAILS**: 8 of 8 cases |

The round trip was checked on this host: `JSON.stringify([JSON.parse(body)])` in Node keeps
the `\ud800` escape and the 200-deep member. Through `scan` (one body) the same page is
`listing: … not a listing page` — a strike — so the single-page path is not affected.

*Directions (not done), either is enough:* **core** — the two exports take an array of
STRINGS (each the text of one answer or one report) and read each on its own, or keep the
array of objects and, when the outer read fails, split it without interpreting the elements;
**or contract** — the client builds every report from its seven known members only (six
checked as a number or 64 lowercase hexadecimal characters, plus its own `node_id`), and
answers `request: pages:` from `scan_pages` by handing the same bodies to `scan` one by one.
The core route is the one that cannot be forgotten by three clients.

---

## 1. The earlier tests — **confirmed**

* `rw6b_f1_…` (wasm), `rw6b_f2_…`, `rw6b_f3_…` pass. So do the other five of
  `review_wallet_6b.rs` (the demonstration included) and all ten of `review_wallet_6.rs`.
* Byte-identical: `git diff fec27d7..1b61659` is empty for
  `core/shield-v2-wallet/tests/review_wallet_6.rs`, `…/review_wallet_6b.rs` and
  `core/shield-v2-wasm/tests/review_wallet_6b.rs` (and `aafcf37..1b61659` for the first).
* `git diff fec27d7..1b61659 --stat` over both test directories: `common/client_loop.rs`,
  `settlement_properties.rs` and two new files. No earlier test was edited.
* **The widened assertion** of the property test: "a refuted listing is kept" accepted
  `Rescan` or `Leave { ban: true }`; it now also accepts exactly
  `Leave { ban: false, why: "rescans that blamed nobody" }`. That LEAVE always rescans
  (`plan_leave`: `leave_rescans` forces it, also when the node is the only one left), so the
  refuted listing is not kept in that branch either. It hides nothing.

## 2. RW6B-1 — **fixed for what it was; RW6C-1 is what is left of it**

`scan_pages` is all or nothing and names the page: `rw6c_sound_scan_pages_is_all_or_nothing_…`
(the Rust call: one call ≡ page by page; index 2, 1, 1, 0 for four refused batches; the state
equal each time; a non-page keeps its mark inside a batch). Twelve more batches on the wasm
surface (a number, a string, an array, the node's error answer, the same page twice, a page
that does not continue, a bad digest in the third page, a page with only `active`, a
transaction twice, a batch in a batch → `listing: page <i>:` with the right index; an object
or a cut-off array as the argument → `request:`) and twelve more reports (negative, fractional
and 2⁶⁴ heights, a count as text, upper-case / short / array / number hashes, `node_id` missing
or a number, the report in an array or one level down → `malformed`, no vote, no dissent, the
honest two confirm; all twelve at once: `malformed = 12`): `rw6c_sound_more_malformed_batches_and_reports`
passes. One leniency, harmless (by reading, not run): an element with a duplicate key is read as its
last value in a batch and refused by `scan`.

## 3. RW6B-2, the discriminator — **confirmed**

* **The node's real answers** (`main.rs` `shield_v2_notes`, `node.rs` `shield_v2_notes_since`):
  the page with `success: true` → a page; `{ "active": false, … }` → a page, read as "not
  active"; `{ "success": false, "error": … }`, an empty body, a proxy's page, the query
  extractor's plain-text refusal → no page: K − 1 times `Go`, then `Leave` without a ban.
  Nothing honest is misclassified in either direction; `{ "success": false, "txs": [] }` and
  an object with one member of a page are pages and are banned
  (`rw6c_sound_the_nodes_own_answers_are_classified_…`).
* **Can a liar dodge every ban with bodies that carry none of the five?** Yes, and it is
  silence: `after_scan_error` → `after_no_answer`, the same strike, the same LEAVE after K,
  the same term of the bound.
* **Alternating** K − 1 non-page rounds with one good round: the node is never left — exactly
  as a node silent K − 1 rounds of K never was — but the good round has to DELIVER (the wallet
  at the quorum's tip, everything confirmed), so the wallet is at most K − 1 rounds stale on a
  chain that makes a block every round; with a "good" round one block short it is left in
  round K (`rw6c_sound_no_page_for_k_minus_one_rounds_…`). No standstill.

## 4. RW6B-3 — **confirmed**

`unconfirmed_tail_is_listing_nodes` by hand: an honest node's true page on a state whose
unconfirmed part is its own, or that holds only confirmed heights, cannot be a `listing:` error
or a `leaf_mismatch` (the state at a confirmed height has the chain's tree and hashes), so the
ban there stays evidence; on a tail that is not its own the answer is one blameless rescan,
after which everything is the node's. "One free round" for a node that is in fact lying is
exactly one per session that starts with `listed_from` unknown — bounded, and counted by the
cap. No new way found for an honest node to be banned or for a liar never to be left.

## 5. The caps — **sound; 6 is acceptable, 3 is better, and the test in the way is mine**

* `R_c = 2` in a row, `R_s = 6` per tenure (the second is named "in a session" but both
  counts start again when the listing node changes — the text of `NOTES.md` §6 says "per
  tenure in a session", which is the accurate reading).
* **The bound as now stated** — `(n − quorum + 1)·(D + K + 2 + R_c·(D + 1)) + W` to the
  confirmed tip, and afterwards at most `R_s·(D + 1)` rounds of repeated work per tenure —
  is correct and is in `NOTES.md` §6 and spec §5.5. It is finite per tenure; a session has as
  many tenures of a liar as there are times every honest node after it is left, which needs
  honest nodes to fail K rounds each. That is the pre-existing "honest nodes not at one
  height" caveat, not a new hole.
* **Can the cap take the client off its only useful honest node?** No. A blameless rescan on
  an honest listing node needs a false checkpoint in the state, and after one rescan under an
  honest node every height is that node's truth: at most one per tenure, never two in a row.
  `rw6c_sound_the_cap_leaves_the_adaptive_liar_and_never_an_honest_node` (n = 3, the adaptive
  liar, one honest node a block behind in every occasion, twelve occasions, each start node):

  ```
  start node 1 (the liar): 6 rescans, all on the liar; left [(round 23, node 1, no ban, "rescans that blamed nobody")]; then node 2, no further rescan
  start node 2: 0 rescans, no LEAVE        start node 3 (the lagging one): 0 rescans, no LEAVE
  ```

  The tip is confirmed at the end of every occasion; no honest node banned or left for it.
* **6 or lower?** 6 is acceptable: at this chain's length it is twelve rounds of repeated work,
  once per tenure. It is 6 only because my `rw6b_demo_…` asserts five rescans with no LEAVE.
  That test demonstrates a limit that no longer exists in that form; **restate it** (assert
  "left, not banned, at the cap") and set `R_s = K = 3`. Not a blocker either way.

## 6. Runs

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-run` | built |
| `cargo test … --test review_wallet_6c --no-fail-fast -- --test-threads=1 --nocapture` (both crates) | wallet 4 passed; wasm 1 passed, 1 failed on purpose |
| `PROP_SEED_BASE=15000 PROP_RUNS=150 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 235 s (2,306 payments, 339 restores, 279 rescans that blamed nobody, 224 bans, at most 12 rounds) |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1 --nocapture` (as CI, seeds 1–200) | **174 tests: 173 passed, 1 failed on purpose.** The fixer's 168 all pass — wallet 158: unit 22, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `_5` 12, `_5_resolution` 7, `_6` 10, `_6_resolution` 10, `_6b` 7, `_6b_resolution` 5, `settlement_properties` 1 (301 s), `vectors` 3, `wallet_flow` 6; wasm 10. This review's: wallet 4, wasm 1 + **1 failed**. 380 s |

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running. About 10.5 minutes of test time against a budget of about 25.
One `node -e` line checked the JavaScript round trip. Not run: the 11000 / 12000 ranges again,
the mutations, the wasm32 build, the daemon's interop tests. No source file was edited.
`core/target/` was deleted; nothing was pushed; nothing outside this worktree was read or
written; no service, proxy or node was touched.

## What remains

**Blocking (one):** RW6C-1.

**Low / Info — acceptable as documented limits, no further round needed for them:**

* `R_s = 6` where 3 would do; `rw6b_demo_…` to be restated with it (section 5).
* After a session that ended in a fault, a node that is in fact lying gets one free round
  (section 4).
* A node that answers nothing of a listing, or delivers only every K-th round, is never
  banned and keeps the wallet at most K − 1 rounds stale (section 3) — silence, as before.
* An adaptive liar costs at most `R_s·(D + 1)` rounds of repeated work per tenure; the cost
  grows with the chain's length (REVIEW_WALLET_6B, section 2).
* A client that reads only listing answers can confirm the empty pool at activation − 1
  before the chain is there (REVIEW_WALLET_6B, section 4).
* `scan_pages` reads a duplicate key in an element as its last value where `scan` refuses it.
* The property test contains none of RW6C-1 (it calls the Rust API, where reports are typed
  values and pages are separate texts).

---

## Resolution

**RW6C-1 is fixed in the core — `rw6c_f1_…` passes as the review wrote it, 8 of 8 cases — and
the cap per tenure is 3. Exactly one test of a review was edited: the demonstration
`rw6b_demo_…`, restated as this review asks (section 5), scenario unchanged.**

Branch `fix/shield-v2-wallet-settlement-7`, from `review/shield-v2-wallet-6c` @ `e06eec3`. Date:
2026-10-07. Nothing of spec §2, of consensus or of the state root is touched; no existing
function changed its shape. Added: the module `batch` of the wallet crate
(`json_array_elements`, `json_string_text`, `page_bodies`, `read_state_reports`). Documents:
`NOTES.md` §6 and §17, spec §1 (dated line), §5.4, §5.5 (W-23), `UI_CONTRACT.md` obligations 9
and 10. New tests: `core/shield-v2-wasm/tests/review_wallet_6c_resolution.rs` (2), two unit
tests of `batch`.

### RW6C-1 — how the array is split, and why no element can make it fail

`confirm_state` and `scan_pages` (`core/shield-v2-wasm/src/api.rs`) no longer hand their
argument to a JSON parser. `batch::json_array_elements` walks the text once and keeps three
things: whether it is inside a string (and whether the last character was a backslash), how
many `[` / `{` are open inside the outer array, and where the commas at depth 0 are. It returns
each element as its own slice of the text. It decodes no string, reads no number, does not
recurse, and has no limit of depth.

* A **lone surrogate escape** is, to it, a backslash and the character after it, inside a
  string: skipped.
* **Nesting** is a counter that goes up and comes back down: 200, 129 or 10,000 deep is the
  same.
* Everything else an element holds is not looked at.

So for an array whose elements are well-formed JSON — which is everything `JSON.stringify`
writes — the split cannot fail and cannot put a boundary in the wrong place, whatever a node
put inside its element. (`serde_json`'s `RawValue` was not used: it needs a feature of the
crate that this build does not enable, and it validates what it skips — the surrogate would
still be an error.) Whether an element is JSON at all is then the business of whoever reads
the element:

* **`scan_pages`**: each element's text goes to `WalletState::scan_pages`, i.e. to
  `ListingPage::from_json` + `scan` — the reader of `scan`'s argument. The answer is the one
  `scan` gives that body, with the index: `listing: page i: …`, or
  `listing: page i: note listing: not a listing page: …` for a body no reader reads. Nothing
  is re-written on the way any more (the elements were round-tripped through a JSON value
  before), which closes the Low of this review: **a duplicate member is refused by both
  paths**, in the same words. For the same reason the text for "not a listing page" is one
  fixed sentence now, without a position: the same alone and in a batch.
* **`confirm_state`**: each element is read on its own by `batch::read_state_reports`; an
  element that does not parse, is not an object, lacks a member, has one of the wrong type —
  anything — is counted in `malformed` and the others are read as if it were not there. The
  call does not fail for it.

Only the ARRAY is the caller's: a text whose top level is not an array (it does not start
with `[`, is not closed, or is followed by something), or one above the size cap (64 MiB of
pages, 1 MiB of reports), is `request:`.

**The accepted forms of an element** (all read the same way; the first of each is the
recommended one and is in `UI_CONTRACT.md` obligation 9 and `NOTES.md` §6):

| Export | Element | Meaning |
|---|---|---|
| `scan_pages` | a JSON string | **the raw body the node answered with** — the client never parses it |
| | anything else | the page as it stands in the array (an object written back by `JSON.stringify`) |
| `confirm_state` | `{ "node_id": <configured origin>, "stats": "<raw body of /api/shield-v2/stats>" }` | **the labelled raw body**: the core takes its `report`; `null` or absent is "no report" (not counted), a body that is not a JSON object or a `report` that is not an object is malformed |
| | `{ "node_id", "height", "tree_root", … }` | the labelled report as an object (as before) |
| | a JSON string | the text of either of the two |

**The sentences the review quotes are true now**: "anything … no report from that node …
never an error" and "exactly as `scan`, with the element's index" — and the table of the
exports in `NOTES.md` §6 says how (a paragraph "The array is split, not parsed").

**The loop.** Step 3 has a rule for an error of `confirm_state` (`NOTES.md` §6, spec §5.5;
`Session::after_confirm_error`): `stale_state:` → reload; anything else → STOP(fault) — the
client's own, or a bug; no node can cause it. The `unwrap()` in the reference client is gone.

**Tests.** `rw6c_f1_…` unedited: passes. `rw6cr_f1_no_report_of_one_node_can_fail_the_state_check_of_the_others`:
the review's two shapes and twenty more (lone low surrogate, a pair reversed, a surrogate
after 300 characters, exactly 129 deep, objects 500 deep, 3,000 deep, a surrogate inside a
deep member, NUL, a 400-digit number, `1e999`, brackets and quotes inside a string, a body cut
off, text, an unterminated string, a byte-order mark, nothing, a control character, a lone
bracket) — in a member of the report, in a member it does not have, as the whole element, as
a string and inside the raw body: 174 elements, each in every position of a 3- and a
5-element array, 1,392 calls: every one succeeds, the honest reports confirm, the element is
counted as malformed (or, when all that is odd is an extra member this library reads, is an
ordinary report). `rw6cr_f1_no_page_can_turn_a_batch_into_the_callers_error_…`: 66 bodies in
every position of a 3- and a 5-page batch, in both forms, 1,728 batches: each answered in
the words `scan` has for that body, with its index. Two unit tests of the splitter and of the
string reader (`src/batch.rs`).

One thing the tests showed that the review's wording does not say: a lone surrogate or a deep
value in a member a PAGE does not have is skipped unread by the page reader, in `scan` and in
`scan_pages` alike — the page is applied (112 positions of the table). Only in a member that
is read, or anywhere in a report, does it make the element unreadable.

### The cap per tenure: 3

`BLAMELESS_PER_TENURE = 3` (= K). The old name `BLAMELESS_IN_A_SESSION` is kept as an alias of
it: this review's `tests/review_wallet_6c.rs` imports it, and that file is not to be touched
(its cap test is written against the constant and passes with 3). `rw6b_demo_…` is restated —
same scenario, same per-cycle assertions; the final assertion is now "below the cap: not
left, lists; at the K-th rescan that blamed nobody: left, not banned, in round 3·K" — and
renamed `…_is_left_not_banned_at_the_cap`. `rw6br_cap_…` (the fixer's) follows the constant.
The bound: to the confirmed tip `(n − quorum + 1)·(D + K + 2 + R_c·(D + 1)) + W`, unchanged;
afterwards at most `R_t·(D + 1)` rounds of repeated work per tenure, `R_t = 3`.

### Tests edited

* **`tests/review_wallet_6b.rs`: the one demonstration**, as authorised (25 lines added, 15 removed: its
  doc comment, its name, its last assertion and its `println!`). Every other test of that file is
  untouched.
* Byte-identical to the reviews' commits (`git diff --quiet`): `tests/review_wallet_6.rs`
  (`aafcf37`), `core/shield-v2-wasm/tests/review_wallet_6b.rs` (`fec27d7`), both
  `review_wallet_6c.rs` (`e06eec3`).
* The fixer's own, as the task names: `tests/review_wallet_6b_resolution.rs` (the constant's
  name and two comments), `tests/common/client_loop.rs`, `tests/settlement_properties.rs`.
* No other test: `review_wallet_1` … `_5`, the `_resolution` files of 4, 5 and 6, `vectors`,
  `wallet_flow`, the wasm crate's `api`, `review_wallet_1`, `_3`, `_6b_resolution`.

### The property test

In half the runs the client hands its reports to the library the way a JavaScript client
does — ONE text, an array: `{ node_id, stats: "<raw body>" }`, the object written back, or a
string — and the lying nodes put elements between them that no reader reads (sixteen kinds:
a lone surrogate in a report, in a raw body, in a string; 200-deep members; bodies that are
not JSON, not objects, empty; `null`, a number, an array, `{}`; a negative height; a label
that is a list). In the batching runs the pages go the same way (raw bodies as strings, or
written back). The model's invariant: the array is read; every report that was a report
comes out exactly as it went in, in order; every element that was none is counted;
`confirm_state` never fails. Its adversary also answers the listing with a page whose
`tip_height` is a lone surrogate or 200 deep (no answer: a strike).

| Range | Result | Time | In it |
|---|---|---|---|
| seeds 1–200 × 280 | passes | 292 s | 3,085 payments, 450 restores; 12,227 report arrays and 5,644 page arrays read element by element, 24,126 unreadable elements among them — none an error; 1,260 answers that were no page; 319 refuted listings, 206 rescans that blamed nobody, 53 nodes left at the cap; 269 bans; at most 13 rounds |
| `PROP_SEED_BASE=15000 PROP_RUNS=150` | passes | 221 s | 2,297 payments, 340 restores; 9,009 report arrays, 4,183 page arrays, 18,197 unreadable elements; 1,074 non-pages; 246 refuted, 149 blameless rescans, 39 left at the cap; 227 bans; at most 10 rounds |

Mutation: `read_state_reports` parsing the array as one document first (the defect) — the
property test fails at seed 2: "the array of 4 reports (1 of them unreadable) is not read as
an array".

### The accepted Low / Info limits, and where each is documented

| Limit (this review, "What remains") | Where |
|---|---|
| `R_s = 6` where 3 would do; `rw6b_demo_…` to be restated | **done**: 3, restated (above) |
| After a session that ended in a fault, a node that is in fact lying gets one free round | `UI_CONTRACT.md` obligation 10 (b); `NOTES.md` §6 ("A page that does not continue the state …") |
| A node that answers nothing of a listing, or delivers only every K-th round, is never banned; the wallet is at most K − 1 rounds stale | `UI_CONTRACT.md` 10 (c); obligation 9 ("no answer") |
| An adaptive liar costs at most `R_t·(D + 1)` rounds of repeated work per tenure, growing with the chain's length | `UI_CONTRACT.md` 10 (a); `NOTES.md` §6 ("Rescans that blame nobody are capped", the bound); spec §5.5 (W-22, W-23) |
| A client that reads only listing answers can confirm the empty pool at activation − 1 before the chain is there | `UI_CONTRACT.md` 10 (d) and obligation 8 |
| `scan_pages` reads a duplicate key as its last value where `scan` refuses it | **fixed** (the same reader; `rw6cr_f1_no_page_…`) |
| The property test contains none of RW6C-1 | **closed**: it does now (above) |
| (new, from the fix) In an array a string is a raw body: a node whose whole answer is a JSON string that spells a page has it read as a page when a client writes parsed values back | `UI_CONTRACT.md` 10 (e); `NOTES.md` §6 |

### Not done

* `RawValue` was considered and not used (above); the splitter is ~45 lines with its own unit
  tests.
* The 1,024-report and 1 MiB / 64 MiB limits stay the caller's (`request:`): the client
  builds the array and drops an oversized answer (`UI_CONTRACT.md` 9).
* Not re-run: the 5000 / 7000 / 9000 / 11000 / 12000 ranges of the property test.

### Commands run

Each cargo command as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p
CPUWeight=10 nice -n 19 cargo … --release --locked --offline -j 1`, one at a time, after
checking that no `cargo` or `rustc` process was running.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1 --nocapture` | **178 tests: 178 passed, 0 failed, 0 ignored.** Wallet 164: unit 24, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `_5` 12, `_5_resolution` 7, `_6` 10, `_6_resolution` 10, `_6b` 7, `_6b_resolution` 5, `_6c` 4, `settlement_properties` 1 (seeds 1–200, 292 s), `vectors` 3, `wallet_flow` 6; wasm 14: `api` 2, `review_wallet_1` 4, `_3` 1, `_6b` 1, `_6b_resolution` 2, `_6c` 2, `_6c_resolution` 2. 514 s |
| `PROP_SEED_BASE=15000 PROP_RUNS=150 cargo test … --test settlement_properties -- --nocapture` | 1 passed, 221 s |
| `cargo build -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown …` | built, 109 s (2,938,154 bytes) |
| `cargo test -p quantum-vault-daemon … -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed, 0 failed (294 filtered out); 728 s with the build of the daemon |
| `NOBLE_ROOT=/home/cyberdreadx/qv-containment/node_modules node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 checks passed |
| the mutation, `PROP_RUNS=20` | caught (seed 2) |

`core/target/` was deleted afterwards; no process was left; nothing was pushed; apart from
reading that `node_modules` directory for the cross-check, nothing outside this worktree was
read or written; no service, proxy or node was touched.
