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
