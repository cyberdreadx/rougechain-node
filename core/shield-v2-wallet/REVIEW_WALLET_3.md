# REVIEW_WALLET_3 — third independent review: the settlement redesign

Reviewed: `fix/shield-v2-wallet-settlement` @ `188d0ed` — the redesign `5a6e7c4..188d0ed` of
`core/shield-v2-wallet` (`store.rs` in full), `core/shield-v2-wasm/src/api.rs`, the node side it
relies on (`core/shield-v2/src/pool.rs`, `core/daemon/src/node.rs` `shield_v2_stats` /
`shield_v2_notes_since`, `core/daemon/src/shield_v2.rs`), `tests/settlement_properties.rs`, the
CI workflow, against spec §4, §5.4, §5.5 and `NOTES.md` §6, §11. The reviewer did not write any
of it. Date: 2026-10-06. Branch `review/shield-v2-wallet-3`. **Nothing was fixed.** Every confirmed
defect has a regression test that fails on purpose.

Threat model tested: a strict minority of the configured nodes lying in any way, a hostile sender,
a hostile payee, several devices on one phrase, restore, migration, a crash at any point; honest
majority of configured nodes. Guarantees: **G1** no double payment by the wallet's behaviour;
**G2** confirmed balance ≤ the true balance at the confirmed height; **G3** no permanent lock or
loss from view while an honest quorum is reachable; **G4** one lying or unreachable node causes
delay only.

## Verdict

**NOT READY: G1 and G2 hold — I could not make the redesigned settlement pay twice or confirm
money that is not there — but G3 and G4 do not. One lying node can (a) stop all confirmation for
ever when it is one of three (RW3-1) and (b) with a single empty listing page make the next
payment's lock permanent (RW3-7). Three Medium findings lose funds from the wallet's view or
leave the lock to the client's discipline.**

The part the two earlier reviews broke is sound this time. "Mined", "superseded" and "expired"
are decided only at a height at which a quorum reported the wallet's root, nullifier hash and
both counts; with every transaction listed as exactly two nullifiers and two outputs, a listing
that matches all four at height `C` has, up to `C`, the chain's transactions and no others, in
the chain's grouping. I found no listing, report set, ordering, rescan, migration or crash point
that makes the wallet call a live transaction dead, or a missing one mined (section 3).

What is not sound is everything that needs the confirmed height to **advance**, and two places
where the redesign's own principle — *believe nothing one node says* — was not applied: the
height the expiry bound is measured from, and the ciphertexts.

| # | Severity | Violates | Finding | Where | Test (fails on purpose) |
|---|---|---|---|---|---|
| RW3-1 | **High** | G4, G3 | One lying node of three makes every `confirm_state` call `diverged`: the confirmed height never moves, nothing becomes spendable, no lock is ever released. The report names heights, not nodes. The documented way out ("drop a node") confirms a forgery with two liars of five, because the quorum is a majority of the reports passed, not of the nodes configured | `store.rs:1462`, `1470–1482`; `ConfirmReport` (`701–728`); `NOTES.md` §6 item 4 | `rw3_f1_…`; `rw3_demo_dropping_nodes_…` (passes: shows the unsafe way out) |
| RW3-7 | **High** | G3, G4 | The expiry bound is measured from the SCANNED height, which is the listing node's claim. One empty page "my tip is a million blocks further" ⇒ the next payment is built and recorded with an expiry a million blocks away ⇒ if it is withheld, its inputs are locked for good, also after an honest rescan and an honest quorum; and the transaction really stays minable far beyond 128 blocks | `store.rs:1328` (`mark_pending`), `1569` (`scan` accepts the tip claim); `api.rs:342–357`, `477`, `513`; `tx.rs:81–88` | `rw3_f7_…` |
| RW3-2 | Medium | G3, G4 | Ciphertexts are in neither half of the confirmed state. A listing node that blanks or swaps them hides notes from a wallet that is "confirmed" at the tip. For a pending transaction's own change the wallet has the proof in hand (the change commitment entered the confirmed tree, no note came with it), settles `mined`, and the change is silently gone | `store.rs:1641–1646`, `1398–1401`; `Resolution` doc `647` | `rw3_f2_…`; `rw3_demo_swapped_ciphertexts_…` (passes: the undetectable general case) |
| RW3-4 | Medium | G3 | A restore/rescan stores SPENT notes and prunes only in `confirm_state` (callable at the tip). After 65,536 lifetime notes — all spent — every later note is "counted, not stored": the live balance is invisible and unspendable, and a further rescan repeats it | `store.rs:1727–1731`, `1502–1514`, `1169` (doc: "merge notes … then rescan") | `rw3_f4_…` |
| RW3-5 | Medium | G1 (by client error) | `build_transfer` / `build_unshield` return a proven, submittable transaction and no state: the lock is a second call plus a persist, ordered only by documentation. A client that submits first has a live payment the wallet does not know, and a second payment from another note is planned without complaint | `api.rs:366–390`, `467–523`, `532–537` | wasm `rw3_f5_…` |
| RW3-3 | Low | G3 | The wallet's OWN change below `min_note_value` (default 1 XRGE) is dropped like a stranger's dust: in no balance, unspendable from that state. `select_inputs` plans it silently (only wasm `plan_payment` flags it) | `store.rs:1722–1726`; `select.rs:67–77` | `rw3_f3_…` |
| RW3-6 | Low | — (outside the model: needs the designated proposer) | An honest node's `report` shows the pool state of a block that is being applied speculatively and is then rejected: `(H, state)` for a height whose block it never accepted. The handler takes no lock against block application | `node.rs:5419` (pool commit inside apply), `1706` (block stored later), `5710–5757` | daemon `node::shield_v2_daemon_tests::rw3_f6_…` |
| RW3-8 | Low | — | Node ids are compared byte for byte: one endpoint in three spellings is three nodes | `store.rs:1454–1462` | `rw3_demo_quorum_arithmetic_…` (passes) |
| RW3-9 | Info | — | The property test cannot see RW3-1, RW3-2, RW3-4, RW3-7: section 4 | `tests/settlement_properties.rs` | mutation table |
| RW3-10 | Info | G1 residual | A restored device (or a second device) has no locks; a second payment from another note while the first is withheld pays twice | inherent | `rw3_demo_a_restored_device_…` (passes) |

Tests added: 13 (11 wallet, 1 wasm, 1 daemon). **7 fail on purpose**, 6 pass.

---

## 1. Findings

### RW3-1 (High; G4, G3) — one liar of three freezes the wallet

`confirm_state` confirms nothing if any report at a comparable height differs from the wallet's
state (`store.rs:1470–1482`). Test `rw3_f1_…`: three nodes, two honest and identical to the
wallet, the third reporting another nullifier hash for the same height. Output:

```
three nodes, one liar, 6 state checks over 246 blocks: matched 0, diverged 6; confirmed height
Some(3) (was Some(3)); t1 expired at height 67 and the chain is at 249: resolve settled 0 and
left 1 pending; locked 10000000000 quanta, unverified 6000000000 quanta
```

This is the implemented and documented behaviour ("any conflict confirms nothing for the whole
call"), and it is permanent for as long as the liar answers.

*Can the caller exclude the node?* Only by not passing its report. `ConfirmReport` carries
`conflicts` (heights) and no node id (`store.rs:701–728`), so the caller must find the dissenter
itself. And leaving nodes out is unsafe as the API stands: the quorum is
`max(asked, majority of the distinct ids IN THE CALL)` (`store.rs:1462`). `rw3_demo_dropping_…`:
five configured nodes, two of them a liar's, the wallet's listing is the liar's and contains a
forged 50 XRGE. All five → `diverged`. The two that "do not conflict" alone, default quorum →
**confirmed, spendable 60 XRGE, the chain holds 10** (G2 broken by following `NOTES.md` §6 item 4,
"drop a node"). With `quorum = 3` (majority of the five configured) the same call confirms
nothing. Neither the core nor the notes say that the quorum must be pinned to the configured set.

*The rule buys nothing inside the model.* A match by a strict majority of the configured nodes
contains an honest node; an honest node's report is the truth for its height; so the wallet's
state at that height is the chain's whatever the minority says. Mutation M4 (section 4) removes
the rule: **every test of the crate still passes**, the property test with identical statistics.

*Direction (not done).* `confirm_state` takes the number of configured nodes (or the full
configured id list) and applies the majority of THAT; a minority that disagrees is returned by
id (`dissenting: [node_id]`) and does not block; `diverged` is kept for "no quorum and somebody
contradicts the wallet". Document that the quorum is never computed from a subset.

Quorum arithmetic found (`rw3_demo_quorum_…`): n = 1, 2, 3, 4, 5 agreeing nodes → quorum 2, 2,
2, 3, 3; one node never confirms by default; a duplicate id counts once. Sound for a strict
minority of liars **if all configured nodes are passed in every call**.

### RW3-7 (High; G3, G4) — the expiry bound rests on one node's word

`scan` checks a page's `next_height` against the same page's `tip_height` (`store.rs:1569`) —
the node's own claim. `build_transfer` takes `anchor_height` = the scanned height
(`api.rs:346–351`, `477`), the default expiry is that + 64 (`tx.rs:81`), and `mark_pending` bounds
the expiry by the scanned height + 128 (`store.rs:1328`). The confirmed height is not consulted.

`rw3_f7_…`: a confirmed wallet (16 XRGE, true height 4) scans one empty page with
`tip_height = 1,000,004`. Nothing looks wrong: the notes stay confirmed, the root is the chain's.
It pays; `expiry_height = 1,000,068`; `mark_pending` accepts. The node withholds. Then only honest
nodes: `fresh_for_rescan`, an honest listing, an honest quorum 601 blocks later:

```
(a) t1 mined 200 blocks after it was built on a copy of the chain: true; (b) after an honest
rescan and an honest quorum at height 605 (601 blocks after the build): settled 0, still pending
1, locked 10000000000 quanta; t1 can still be mined on that chain: false; blocks until the
wallet's rule releases it: 999463
```

The inputs are locked for good by one lying page — the lock survives every recovery the notes
prescribe — and (a) the transaction outlives the 128 blocks that are "the only thing that limits
how long a transaction can be mined" (spec §5.5): in an idle pool it is minable indefinitely. The
wallet never calls it dead, so this is not a double payment by the wallet (G1 holds); it is a
permanent lock plus a payment the node can release at will while the user has no "retry" and no
"cancel". A restore from the phrase is the only way out, and that is RW3-10.

*Direction (not done).* Measure the bound from the confirmed height: `mark_pending` refuses an
expiry above `confirmed_height + 128`, the wasm builders refuse a scanned height that is not the
confirmed height (or build against the confirmed height's root, which is in the window), and the
property test asserts "every entry is settled once the TRUE chain is 128 blocks past its build
and that height is confirmed".

### RW3-2 (Medium; G3, G4) — ciphertexts are not confirmed; the change of a mined payment can vanish

The root commits commitments, the hash commits nullifiers; `kem_ct` / `note_ct` are in neither.
A listing node can blank them or swap them between outputs: trial decryption fails (the AAD is
the commitment), the note is not found, and root, hash and counts still match an honest quorum.
No mis-credit is possible (the recipient check recomputes the commitment with `rho` from the
listed nullifiers) — tried, sound. What is possible is hiding:

* `rw3_demo_swapped_ciphertexts_…` — an incoming 7 XRGE payment: the wallet is confirmed at the
  tip with 10 XRGE, the chain holds 17, nothing flags it. Not detectable by the core; it needs a
  second listing or a ciphertext commitment in the reported state. **Not documented anywhere**
  (`NOTES.md` §6 item 4 lists forged payments, withheld transactions and swapped nullifiers).
* `rw3_f2_…` — the wallet's own change. `t1` is mined; the listing blanks the change output's
  ciphertexts; two honest nodes confirm; `resolve` returns `mined`:
  ```
  t1 settled as mined on confirmed data; the chain holds 5000000000 quanta for the wallet, the
  wallet shows confirmed 0 / unverified 0 / expected change 0; below_minimum 0, over_capacity 0;
  a note with the change commitment is stored: false
  ```
  The settlement table says "its change is a confirmed note". Here the wallet HAS the evidence:
  `PendingChange.cm` is in the confirmed tree and no note with that commitment is stored.

*Direction.* Keep `r` of the change in the pending record (the builder has it) and credit the
change from the record when the entry settles as mined; failing that, return such an entry under
a fourth name ("mined, change not found: your listing node altered the block — rescan
elsewhere"). For incoming notes: fetch the listing from two nodes and compare a hash of the
pages, or (consensus) add a ciphertext hash to the pool record. Document the limit.

### RW3-4 (Medium; G3) — a restore fills the capacity with spent notes

`scan` stores every note it finds and refuses to store once `notes.len() >= 65,536`
(`store.rs:1727`); spent notes leave only in `confirm_state` → `prune` (`1502`), which a restore
can first call at the tip. `rw3_f4_…` (a crafted listing of 32,769 transactions, each spending
the two notes of the one before):

```
restore over 32769 transactions: 65536 notes stored during the scan (0 unspent), over_capacity
{ count: 2, total: 101000000000 }; after the state check 65024 notes pruned, 512 stored; balance
0 quanta, on the chain 101000000000
```

A wallet with ≥ 65,536 notes in its lifetime (change notes count) loses sight of everything
after them at its next restore or `rescan_state` — and `rescan_state` is what `diverged` and
every `listing:` error prescribe. The advice in the `over_capacity` doc ("merge notes or raise
the minimum note value, then rescan") cannot help: the spent notes are what fills the state.
Raising `min_note_value` helps only if the old notes were smaller than the live ones.

*As an attack* (hostile sender): 32,768 transactions with two 1-XRGE outputs each = **32,768 XRGE
in fees plus 65,536 XRGE handed to the victim**. While the 65,536 notes are unspent, later
incoming payments are not stored (the documented cap); after the victim has spent them, every
future restore is blind to later notes of the same size or smaller than the minimum it would
have to set. Recoverable by a rescan with `min_note_value` above the attacker's note size, at the
price of every honest note below it. There is no "higher cap" parameter.

*Direction.* During a scan, do not count spent notes towards the capacity (drop a note into
`pruned` when its nullifier appears more than 256 blocks below the page's height — it becomes
exact once confirmed, and a rescan repeats it), or cap UNSPENT notes.

### RW3-5 (Medium; G1 by client error) — build and lock are two calls

`build_transfer` / `build_unshield` return `envelope_json` — complete, proven, valid the moment
it exists — and no state (`api.rs:366–390`). `mark_pending` is another call; persisting its
result a third step. wasm `rw3_f5_…`:

```
after build_transfer returned a submittable transaction: result has a state: false; pending
entries in the client's state: 0; spendable "16000000000"; the same payment is planned again from
the same note: true; a payment from the other note is planned: true
```

With the documented order (mark, persist, then submit) a crash at any point is safe: I found no
crash window inside the core, and the revision check refuses a stale copy. But the order is the
client's, in three clients, across an async proving worker, a service worker that is killed
when idle, and a `stale_state:` retry path. One client that submits before the marked state is
durable has rebuilt REVIEW_WALLET_1 F-7. *Direction:* the build calls take `expected_revision`
and return `{ state, revision, … }` with the inputs already locked; the transaction and the
lock leave the core together. `mark_pending` also never sees the body (stated in the Resolution):
an atomic build removes that gap too.

### RW3-3 (Low; G3) — own change below the minimum note value

No adversary. 10 XRGE note, pay 8.5, fee 1 → 0.5 XRGE change; mined, settled `mined`:

```
the chain holds 3500000000 quanta for the wallet; after `mined` the wallet shows confirmed
3000000000 + unverified 0, expected change 0, below_minimum { count: 1, total: 500000000 }; a
rescan with min_note_value = 1 shows 3500000000
```

Up to 0.999999999 XRGE per payment, unbounded in sum; `expected_change` shows it until it is
mined, then it is gone. Recoverable only by a full rescan with `min_note_value = 1` (then
spendable as a second input). Documented as a cost; the wasm `plan_payment` flags it,
`select_inputs` does not. The dust rule is for strangers' notes: a note announced by the
wallet's own pending record should be stored whatever its size.

### RW3-6 (Low; outside the model) — the atomic `report` is atomic over a speculative state

`report` is one read of the pool record — that part of RW2-6 is fixed, and it is consistent with
`notes` (the leaf range is written in the same store commit; a block's listing appears only after
`append_block`). But the pool record is committed inside `apply_balance_block`
(`node.rs:5419`), before the state root is compared and before the block is stored (`1706`), and
rolled back if the block is rejected; `shield_v2_stats` reads the store without any lock against
that. daemon `rw3_f6_…`:

```
tip 3; report before {"height":3,"note_count":2,…}; report while the rejected block was applied
{"height":4,"note_count":4,…} (tip_height in the same answer: 3)
```

For an accepted block the window only makes the report one block ahead of the listing (harmless:
not comparable, retry). For a rejected block an honest node vouches for a state no chain had.
Reaching the apply stage needs the designated proposer's signature (`node.rs:1625`), so the
attacker is a validator plus the wallet's listing node, timing two honest nodes inside the
window — e.g. to get `C = expiry_height` confirmed one block early and a withheld transaction
called expired, then mine it at exactly `expiry_height`. Outside the stated model; narrow; but an
honest node should not say it. *Direction:* report from the last ACCEPTED block (report only
when `next_height − 1 ≤ tip`, i.e. answer the pre-apply state or `null` while they differ).

`nullifier_acc_step` / `NULLIFIER_ACC_TAG` made `pub`: visibility only, no change of the
function or of any consensus path (diff of `pool.rs` is ten lines of visibility and comments).

### RW3-8 (Low) — node ids

`"https://node.example"`, `"https://node.example/"`, `"HTTPS://NODE.EXAMPLE"` are three nodes and
confirm alone (`rw3_demo_quorum_…`). The contract ("the endpoint you configured") is stated; the
client must normalise and deduplicate its configuration (scheme and host lower-cased, no
trailing slash, one entry per origin) before it calls the core.

### RW3-10 (Info) — devices without shared state

Device B (or the same device after a restore) has no record of A's pending transaction. Same
inputs chosen → the two transactions conflict, one is `superseded`: safe. Another note chosen
while the first is withheld → both are mined (`rw3_demo_a_restored_device_…`). No wallet core
can prevent it; the UI can: after a restore or first sync on a new device, say so, and do not
offer payments until a height 128 blocks above the restore height is confirmed (or let the user
override knowingly).

---

## 2. Outside the model — what happens, plainly

* **A majority of the configured nodes lies, or one operator is behind most endpoints.**
  Everything "confirmed" is theirs: forged notes become confirmed and spendable (G2), a live
  transaction is settled as `expired` and the retry pays twice (G1), a mined one is hidden.
  `NOTES.md` §11.6 and the Resolution say this; it is not hidden. With RW3-1's way out it happens
  already with a MINORITY (two of five) if the client drops nodes with the default quorum.
* **A validator in the attack** (RW3-6): honest nodes can be made to report a rejected block.
* **A reorganisation below the confirmed height**: the confirmed height never goes back; a
  settlement made on a dropped block stays made. Assumed away (`NOTES.md` §2 item 16).
* **A tampered state blob**: `from_json` validates shape, not truth; the client must
  authenticate the stored state.

## 3. The attack surface, item by item

1. **Raising `C`.** Not possible for a minority (all nodes passed, quorum from the configured
   set). The height IS bound: a report is compared with `state_at(report.height)`, and a match
   needs a quorum at the same height. Idle heights repeat root and hash, so an old state is a
   true state for a later idle height — a stale honest report confirms its own height only; a
   liar re-labelling it is one node (`rw3_sound_idle_heights_…`). Reports above the scanned
   height or below the oldest of 256 checkpoints are `not_comparable`, never a match. Mutations
   M2, M11, M13 are caught. **Freezing `C`:** RW3-1.
2. **Listing vs report.** With two nullifiers and two outputs per listed transaction, leaf
   positions checked, and the scan starting at leaf 0, equal root + hash + counts at `C` force the
   same sequence and the same grouping up to `C`: regrouping within a block is not expressible.
   Heights inside a confirmed span are free (`tx_hash`, `tx_type` too: display only, never
   evidence): a mined transaction can be listed at another height but not across a confirmed
   height in either direction (`rw3_sound_shifting_…`). Ciphertexts: RW3-2.
3. **Transitions.** `pending → seen_* → settled` only at `seen_height ≤ C`; `seen` above `C`
   with `C ≥ expiry` → `expired`, which is right (a block above the expiry cannot hold it);
   mined at exactly `expiry_height` → the `mined` arm is tested first (node rule: `expiry <
   height` refuses, `shield_v2.rs:320`, consensus at import); seen-then-unseen after a rescan →
   reset (M5 caught); `expired` then appearing → impossible while the quorum is honest;
   `superseded` by an invention → never confirmed; crash between writes → every call is
   whole-state in, whole-state out, `expect_revision` refuses a stale copy (the storage-side
   compare-and-swap is the client's). `mark_pending` skipped: RW3-5.
4. **Restore / migration.** RW3-10; RW3-4. Migration 1→3, 2→3: every lock kept (property test,
   M25 caught); the synthetic expiry is the old scanned height + 128, so a liar-inflated old
   height only lengthens it; the format-1 unbounded expiry is a stated residual.
5. **Pruning, caps, dust.** RW3-4, RW3-3. Pruned notes are spent ≥ 256 blocks below `C`: never
   needed for proving. `below_minimum` / `over_capacity` only lower the balance (G2 holds).
6. **Property test.** Section 4.
7. **Node side.** RW3-6; `pub` export sound. CI: the split is coherent. Note: the wallet step
   has no `--no-fail-fast`, so a failing target (the seven tests of this review) hides the
   targets after it — `settlement_properties` runs after `review_wallet_3` alphabetically.

## 4. The property test, and the mutations

Each mutation applied to `store.rs` alone, then
`cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --test settlement_properties`;
the four it missed were run against the whole wallet suite. All reverted.

| # | Mutation | Property test | Whole suite |
|---|---|---|---|
| M1 | `resolve` settles at the scanned height | **caught** (I3, seed 2) | |
| M2 | a report is compared by root and note count only (no nullifier hash) | **caught** (I2, seed 6) | |
| M4 | a conflict no longer blocks (flag kept) | **NOT caught** — identical statistics | **NOT caught by any test** |
| M4b | as M4, flag dropped | caught only by the `diverged > 40` statistics threshold | |
| M5 | `fresh_for_rescan` keeps `seen_*` | **caught** (I3, seed 2) | |
| M6 | any nullifier match marks ALL inputs spent (RW2-3) | **caught** (closing balance, seed 15) | |
| M7 | `mined` ignores the outputs (nullifier pair only) | **NOT caught** | caught by `rw2_f3_the_same_two_inputs…` |
| M8 | `expired` one block early | **caught** (I3, seed 10) | |
| M9 | quorum not raised to a majority | **NOT caught** | caught by `rw1_f1_…`, `rw2_f4_…` |
| M10 | every note confirmed on any match | **caught** (I2, seed 1) | |
| M11 | the match height is the scanned height | **caught** (seed 1) | |
| M12 | `expired` tested before `mined` | **caught** (I3, seed 2) | |
| M13 | agreeing reports counted, not distinct nodes | **caught** (seed 1) | |
| M21 | the recipient check does not compare the commitment | **NOT caught** | caught by `rw1_sound_listing_…`, `rw2_f2_…` |
| M25 | migrated lock expires at the old scanned height (no + 128) | **caught** (I3, seed 2) | |

What the misses say about the test's model:

* **Its liar only ever echoes the wallet.** There is no node that contradicts a CORRECT wallet,
  so "confirmed in a call with a dissenting minority" never occurs (M4) — the blind spot of
  RW3-1 — and there is never more than one liar id or more than three nodes (M9).
* **Its truth trusts the recorded expiry.** `close()` advances the true chain past
  `max(expiry)` whatever that is, and `pay()` builds on the scanned height after a lying-tip page
  (its lie kind 2 adds up to 300 blocks). An unbounded expiry is simply waited out: RW3-7 is
  inside the test's world and invisible to it. Missing invariant: *an entry is settled once the
  true chain is 128 blocks past the true height of its build and that height is confirmed.*
* **It measures the true balance with the code under test** (`reference.scan`, same decryption,
  same capacity) and never alters a ciphertext: RW3-2 and RW3-4 cannot show.
* **No hostile sender** (M21) and no second device choosing the same pair (M7); both are covered
  by single-scenario tests, not by the invariants.
* I1 is checked only where the harness builds; a client that skips `mark_pending` is not a step.

## 5. Checked and found sound

Settlement on confirmed data only (M1, M5, M8, M12); both halves of the state compared, with
counts (M2); height binding (M11); distinct-id counting (M13); grouping of nullifiers with
outputs; `superseded` marking only the input whose own nullifier appeared (M6); `mined` at
exactly the expiry height; no release on a "rejected" answer or a claimed height; locks by
commitment through a rescan; migrations keep every lock (M25); pruning; `to_json` ⊆ `from_json`;
the single read behind `report` and its consistency with `notes` for accepted blocks; the `pub`
export; the node's expiry rule (`expiry_height ≥ H`, at import).

## 6. Tests added

| File | Test | Result |
|---|---|---|
| `shield-v2-wallet/tests/review_wallet_3.rs` | `rw3_f1_one_lying_node_of_three_freezes_confirmation_and_every_lock` | **FAILS** |
| | `rw3_f2_a_blanked_change_ciphertext_settles_as_mined_and_the_change_is_silently_gone` | **FAILS** |
| | `rw3_f3_own_change_below_the_minimum_note_value_leaves_the_wallets_view` | **FAILS** |
| | `rw3_f4_a_restore_counts_spent_notes_towards_the_capacity_and_drops_the_live_ones` | **FAILS** |
| | `rw3_f7_one_lying_page_inflates_the_expiry_and_the_lock_never_ends` | **FAILS** |
| | `rw3_demo_dropping_nodes_until_nothing_conflicts_confirms_a_forgery_with_two_liars_of_five` | passes |
| | `rw3_demo_quorum_arithmetic_and_node_ids_are_compared_byte_for_byte` | passes |
| | `rw3_demo_swapped_ciphertexts_hide_an_incoming_payment_from_a_fully_confirmed_wallet` | passes |
| | `rw3_demo_a_restored_device_has_no_locks_and_a_second_payment_from_another_note_pays_twice` | passes |
| | `rw3_sound_shifting_a_mined_transaction_to_another_height_cannot_make_it_expired` | passes |
| | `rw3_sound_idle_heights_and_stale_reports_do_not_raise_the_confirmed_height` | passes |
| `shield-v2-wasm/tests/review_wallet_3.rs` | `rw3_f5_a_built_transaction_is_submittable_before_anything_is_locked` | **FAILS** |
| `daemon/src/node.rs` (`shield_v2_daemon_tests`) | `rw3_f6_the_stats_report_shows_a_block_that_is_applied_speculatively_and_then_rejected` | **FAILS** |

**These seven failures are in CI's selection** (the wallet step and the release daemon step).

## 7. Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, foreground, one at a time.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --test settlement_properties` (unmodified) | 1 passed |
| the same, once per mutation (15 runs) | table in section 4 |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --no-fail-fast` under M4, M7, M9, M21 | M4: all pass; M7, M9, M21: caught as listed |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` (before `rw3_f7` was added) | 76 tests: 71 passed, 5 failed on purpose (wallet 69: unit 21, `review_wallet_1` 14, `review_wallet_2` 14, `review_wallet_3` 6 + 4 failed, `settlement_properties` 1, `vectors` 3, `wallet_flow` 6; wasm 7: `api` 2, `review_wallet_1` 4, `review_wallet_3` 1 failed) |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --test review_wallet_3 --no-fail-fast -- --test-threads=1` (final file) | 11 tests: 6 passed, 5 failed on purpose |
| `cargo test -p quantum-vault-shield-v2-wasm --test review_wallet_3` | 1 failed on purpose |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_daemon_tests::rw3_f6 --test-threads=1` | 1 failed on purpose, 296 filtered out |

`core/target/` was deleted afterwards.

## 8. Out of reach

* GitHub Actions; anything as WebAssembly; any network node.
* RW3-6 is shown with the explicit apply / restore of the existing rollback test, not with a
  concurrent HTTP request against an importing node.
* The other daemon tests, the `quantum-vault-shield-v2` suites and the noble cross-check were not
  re-run (no source of theirs changed; one test was added to `node.rs`).
* The property test was judged and mutated, not extended.
* The viewing-key-only path (`nk = None`) with pending transactions was read, not attacked.

## 9. Conditions for a "READY"

1. RW3-1: quorum from the configured set, dissenters named, a minority conflict does not block.
2. RW3-7: the expiry bound measured from the confirmed height.
3. RW3-2 (change), RW3-4, RW3-5 fixed; RW3-2 (incoming) documented with a client rule.
4. The property test gets a contradicting liar, several liar ids, altered ciphertexts, an
   independent true-balance oracle and the bounded-settlement invariant; M4 or its replacement is
   then caught.

---

## Resolution

Branch `fix/shield-v2-wallet-settlement-2`, from `review/shield-v2-wallet-3` @ `dd02c86`.
Date: 2026-10-06. Every `rw3_f*` test passes and asserts the safe behaviour; the three demos
that showed behaviour which is now fixed are regression tests (`rw3_f1b`, `rw3_f2b`, `rw3_f8`);
one demo is left, RW3-10, which no wallet core can remove. Nothing was pushed. **None of this
has been read by a second person.**

Commits:

| Commit | What |
|---|---|
| `625a08b` | wallet core: configured nodes and quorum, `spend_base`, build-and-lock, own outputs from the record, ciphertext hash, cap on unspent notes, state format 4, the tests of the three reviews |
| `f4a6942` | the property test, rewritten around an independent model |
| `19e19da` | wasm surface |
| `dec53b4` | node: node-local ciphertext hash, report of accepted blocks |
| `ea989b6` | the property test strengthened until every mutation is caught by an invariant |
| *(this commit)* | spec amendments W-16, W-17; `NOTES.md` §5–§7, §12; this section |

### Per finding

| # | Fix | Where | Commit | Test |
|---|---|---|---|---|
| RW3-1 (High) | The quorum is a strict majority of the CONFIGURED nodes, stored in the state (`set_nodes`). `confirm_state(reports)` has no quorum argument, counts a configured node once per height, ignores unconfigured ids, returns the dissenters by node and height and is not blocked by them; `listing_refuted` when more nodes contradict the wallet than a lying minority can be. Fewer than two configured nodes confirm nothing. "Drop a node" is deleted from `NOTES.md` | `store.rs` `set_nodes`, `quorum`, `confirm_state`, `ConfirmReport`, `Dissent` | `625a08b` | `rw3_f1_…`, `rw3_f1b_…`, `rw3_f8_…`; `rw1_f1_…`, `rw2_f4_…` rewritten; property test |
| RW3-8 (Low) | Node ids are canonical http(s) origins (`canonical_node_id`): scheme and host lower-cased, default port, path, query, fragment, trailing slash and one trailing dot removed, duplicates collapsed; anything else is refused by `set_nodes` and not counted by `confirm_state`. A stored set that is not canonical is refused by `from_json` | `store.rs` `canonical_node_id` | `625a08b` | `rw3_f8_…` (12 accepted spellings, 20 refusals) |
| RW3-7 (High) | The anchor and the height the expiry is measured from come from the confirmed checkpoint: `spend_base` → `(tree root, confirmed height)`; the builders take no height from the caller; an anchor above the confirmed height is refused unless `allow_unverified`, and then the expiry is still measured from the confirmed height. `mark_pending` refuses an expiry above the confirmed height + 128 and a state without a confirmed height. `scan` still accepts a node's tip claim — nothing depends on it any more | `store.rs` `spend_base`, `mark_pending`; `tx.rs` `spend_inputs` | `625a08b` | `rw3_f7_…`, `rw3_f7b_…`, **`rw3_f7c_…` (the bound G3: 4 fates × 4 minority behaviours)**; property test (expiry ≤ TRUE height at the build + 128; the client's loop ends) |
| RW3-5 (Medium) | `build_transfer(state, expected_revision, keys, params)` / `build_unshield(…)` → `LockedTx { tx, state }`: the transaction and the state in which its inputs are locked and its entry recorded (outputs, nullifiers, own outputs with `r`, expiry), the record written BEFORE the proof is made. No exported function returns a proven spend without it; the wasm `mark_pending` is removed. `abandon_unsubmitted(nullifier)` sets `abandoned_hint` and releases nothing | `tx.rs` `build_transfer`, `build_unshield`, `LockedTx`, `SpendOptions`; `api.rs` | `625a08b`, `19e19da` | `rw3_f5_…` (wallet and wasm), `wallet_flow`, daemon interop |
| RW3-2 (Medium) (a) | Own outputs never depend on a ciphertext: the pending record holds `(cm, value, r)` of the change and of a payment to the wallet's own address; when the scan meets the commitment it recomputes it from the record and stores the note, with its position, path and nullifier | `store.rs` `scan` (`own_outputs`), `PendingChange.r`, `PendingTx.own_payment`; `tx.rs` `pending_of` | `625a08b` | `rw3_f2_…` |
| RW3-2 (Medium) (b) | The node keeps a node-local running hash over `(cm_out, kem_ct, note_ct)` of every accepted output and reports it as `report.ciphertext_acc`; the wallet rebuilds it from the listing with per-height checkpoints; `confirm_state` requires it. A listing with blanked or swapped ciphertexts cannot be confirmed | `storage/src/shield_v2_store.rs` (side record), `daemon/src/shield_v2.rs` (`ciphertext_acc_step`, `DaemonPoolStore`), `daemon/src/node.rs`; `store.rs` `ciphertext_acc_step` | `dec53b4`, `625a08b` | `rw3_f2b_…`; daemon `rw3_f2_the_ciphertext_hash_is_node_local_…`; interop (`sync` compares the two implementations) |
| RW3-4 (Medium) | The cap applies to unspent notes received from others, is a parameter (`with_limits`, `fresh_for_rescan_with`, wasm `new_state` / `rescan_state`; default 65,536, at most 1,048,576), and `over_capacity` is recovered by a rescan with a higher cap. A scan keeps at most 4,096 spent notes (`MAX_SPENT_RETAINED`) and drops the rest into `pruned` at the end of each page | `store.rs` `scan`, `drop_old_spent`, `validate` | `625a08b` | `rw3_f4_…` (65,538 notes: 2 unspent stored, at most 8,194 held at the end of any page), `rw3_f4b_…` |
| RW3-3 (Low) | Own outputs are stored whatever their size: those the pending record opens, and — so that a restore finds them — any output for this wallet in a transaction that spends one of this wallet's notes. `select_inputs` prefers a clean change (zero, or ≥ the minimum): smallest single note with one, else smallest pair with one, else the plain rule with `change_below_minimum: true` | `store.rs` `scan`; `select.rs` | `625a08b` | `rw3_f3_…` |
| RW3-6 (Low) | `report` is the record of the last ACCEPTED block, written after `append_block` (import and producer path) and at start-up; `shield_v2_stats` serves it instead of the pool record | `daemon/src/node.rs` `shield_v2_mark_accepted`, `shield_v2_stats`; `AcceptedReport` | `dec53b4` | daemon `rw3_f6_…` (passes) |
| RW3-9 (Info) | The property test is rewritten around an independent model | `tests/settlement_properties.rs` | `f4a6942`, `ea989b6` | mutation table below |
| RW3-10 (Info) | Documented: locks are per device; what the UI must tell the user and the 128-block embargo after a restore. The property test's client follows that rule and the test asserts that it is sufficient | spec §5.5 (W-17), `NOTES.md` §6 item 7 | this commit | `rw3_demo_a_restored_device_…` (the limit); property test (`end_embargo`) |

**Found by the new property test, not by the review.** A listing node can append a "block" above
every honest tip in which a note of the wallet is spent (for instance the wallet's own withheld
transaction, listed as mined 400 blocks in the future). Nobody reports that height, so nothing
contradicts it, everything up to the real tip matches, and the note is out of every balance until
the chain gets there. `confirm_state` now returns `quorum_tip` (the quorum-th highest height the
configured nodes claim) and `listing_ahead`; the client asks again and, if it stays, rescans
against another node (`rw3_f7d_…`; spec §5.4).

### The quorum rule, as implemented

`n` = the number of CONFIGURED nodes (in the state). `quorum = max(2, ⌊n/2⌋ + 1)`: 1→2 (never
reached), 2→2, 3→2, 4→3, 5→3, 6→4, 7→4. A height `h` is confirmed **iff** at least `quorum`
configured nodes each made exactly one report for `h` and it equals the wallet's
`(tree_root, nullifier_acc, ciphertext_acc, note_count, nullifier_count)` at `h`. The confirmed
height is the highest such `h` ever. Reports under unconfigured ids are not counted; a node with
two different reports for `h` dissents at `h`; dissent never blocks; the threshold never depends
on the reports supplied; `set_nodes` is the only call that changes it and it un-confirms nothing.

### The expiry rule, as implemented

`MAX_EXPIRY_OFFSET = 128`, `DEFAULT_EXPIRY_OFFSET = 64`. For a transfer or an unshield with
confirmed height `C`: `C < expiry_height ≤ C + 128`, default `C + 64`; no confirmed height ⇒ no
build. The node accepts a transaction in block `H` while `expiry_height ≥ H`
(`daemon/src/shield_v2.rs`, check 7), so the last block that can hold it is `expiry_height`.
`resolve` settles an entry at the latest when `C ≥ expiry_height`. Since `C` at the build is a
height the chain has reached, an entry is settled no later than 128 blocks after its build plus
the time to get that height confirmed.

### The API for build-and-lock

```rust
// quantum-vault-shield-v2-wallet
pub struct SpendOptions<'a> { pub chain_id: &'a str, pub inputs: &'a [u64], pub expiry_height: Option<u64>,
                              pub allow_unverified: bool, pub max_fee: Option<u64> }
pub struct TransferParams<'a> { pub spend: SpendOptions<'a>, pub recipient: &'a ShieldedAddress, pub amount: u64, pub fee: u64 }
pub struct UnshieldParams<'a> { pub spend: SpendOptions<'a>, pub to_account: [u8; 32], pub v_out: u64, pub fee: u64 }
pub struct LockedTx { pub tx: BuiltTx, pub state: WalletState }
pub fn build_transfer(state: &WalletState, expected_revision: u64, keys: &ShieldedKeys, p: &TransferParams) -> Result<LockedTx, WalletError>;
pub fn build_unshield(state: &WalletState, expected_revision: u64, keys: &ShieldedKeys, p: &UnshieldParams) -> Result<LockedTx, WalletError>;
impl WalletState { pub fn abandon_unsubmitted(&mut self, nullifier: &[u8; 32]) -> bool; }  // a hint; releases nothing
```

wasm: `build_transfer(seed, state_json, params_json, expected_revision)` and `build_unshield(…)`
return `{ state, revision, envelope_json, … }`; `abandon_unsubmitted(state_json, nullifier_hex,
expected_revision)`; `set_nodes(state_json, nodes_json, expected_revision)`;
`confirm_state(state_json, reports_json, expected_revision)`. Removed: `mark_pending`,
`confirm_roots`. **The client rule: persist the returned state, then submit.**

### The node-local field, and why it is outside consensus

`ShieldV2Store` gained two keys in its sled tree: `"x"`, the side record (the ciphertext hash and
the leaf count it covers), and `"r"`, the report of the last accepted block. Neither is in the
metadata record `"m"` (`encode_stored_pool`), which is the only thing the state-root section of
spec §4.8 reads (`PoolState::state_root_section`, unchanged; `core/shield-v2` is not touched by
this branch). The side record is written in the same `apply_batch` as the pool record, captured
by `snapshot` and put back by `restore`, removed by `clear`, and rebuilt at start-up from the
stored blocks if a store has leaves and no valid record.

Proof by test (`node::shield_v2_daemon_tests::rw3_f2_the_ciphertext_hash_is_node_local_outside_the_state_root_and_rolled_back`):
node y has its side record overwritten with garbage; the state root of y is unchanged and equal
to node x's; both import three more V2 blocks and an empty one; after each, block hash, state
root, pool record bytes and both counters are identical on x and y, while x reports the hash and y
reports `null`; a speculative apply followed by a restore leaves side record and accepted record
byte for byte as before; `shield_v2_rebuild_ciphertext_acc` gives y the value x has.
`state_root_is_byte_identical_before_activation` and `node::strict_historical_replay_tests`
(the mainnet fixture) pass unchanged.

### The mutation table against the new property test

Each mutation applied to `store.rs` (R5: `tx.rs`) alone, then
`cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --test settlement_properties`,
then reverted. **26 of 26 are caught by the property test alone**, each by an invariant (the
message of the failing assertion is given).

| # | Mutation | Caught by |
|---|---|---|
| M1 | `resolve` settles at the scanned height | "settled as expired while the true chain can still mine it" (seed 5) |
| M2 | a report is compared by root and note count only | "the state confirmed at height 5 is not the chain's" (seed 1) |
| M4 | "a conflict no longer blocks" | *this is now the specified behaviour (RW3-1); its inverse is R1 below* |
| M4b | as M4, flag dropped | *not applicable: `diverged` no longer gates anything* |
| M5 | `fresh_for_rescan` keeps `seen_*` | "to_json writes what from_json reads" (the state is invalid) |
| M6 | any nullifier match marks ALL inputs spent | "the confirmed balance is not the true balance at the tip" (seed 21) |
| M7 | `mined` ignores the outputs (nullifier pair only) | "the listing showed the wallet's own transaction and its change is not stored" (seed 41) — *was a miss* |
| M8 | `expired` one block early | "settled as expired while the true chain can still mine it (height 69, expiry 70)" (seed 3) |
| M9 | the quorum is 2 whatever the configured set | "the state confirmed at height 1143 is not the chain's" (seed 1) — *was a miss* |
| M9b | the quorum is a majority of the reports supplied (the RW3-1 demo) | "the state confirmed at height 1698 is not the chain's" (seed 3) |
| M10 | every note confirmed on any match | "confirmed balance 73500000000 exceeds the true balance 25266877027" (seed 33) |
| M11 | the match height is the scanned height | "a height was confirmed that the true chain has not reached" (seed 1) |
| M12 | `expired` tested before `mined` | "a MINED transaction was settled as expired" (seed 1) |
| M13 | agreeing reports counted, not distinct nodes | "the state confirmed at height 1143 is not the chain's" (seed 1) |
| M21 | the recipient check does not compare the commitment | "confirmed balance 1031000000000 exceeds the true balance 32439750832" (seed 1) — *was a miss* |
| M25 | a migrated lock expires at the old scanned height (no + 128) | "settled as expired while the true chain can still mine it" (seed 1) |
| R1 (RW3-1) | a dissenting node blocks the call — *M4 was the miss that hid this* | "not settled after 18 rounds with an honest majority reachable" (seed 3) |
| R7 (RW3-7) | the expiry is measured from the scanned height | "expiry 890 is more than 128 blocks above the true height 588" (seed 5) |
| R2 (RW3-2) | the ciphertext hash is not compared | "the state confirmed at height 2212 is not the chain's" (seed 1) |
| R4 (RW3-4) | the cap counts stored notes, spent ones included | "notes counted as over capacity although the wallet never held 14 unspent notes (peak 8)" (seed 4) |
| R2a | the change is not taken from the pending record | "the listing showed the wallet's own transaction and its change is not stored" (seed 22) |
| R3 | own outputs below the minimum are not stored | "the confirmed balance is not the true balance at the tip" (seed 9) |
| R5 | the builder returns the state without the lock | "locked.is_locked(p) …" (first payment) |
| R8 | a report under an unconfigured id counts | "a height was confirmed that the true chain has not reached" (seed 1) |
| R9 | `listing_ahead` is never set | "the wallet's balance IS the true balance" (seed 3) |
| R10 | `listing_refuted` is never set | "not settled after 18 rounds with an honest majority reachable" (seed 1) |
| R11 | locks are held by leaf position, not by commitment | "a note a pending transaction spends is not locked (at leaf 19)" (seed 7) |
| R12 | `abandon_unsubmitted` releases the lock | "s.abandon_unsubmitted(…) && s.is_locked(…)" |

The first version of the new test (`f4a6942`) missed M8, M9b and R2a and caught R11 only
through a coverage threshold; `ea989b6` added what was missing from the model (honest nodes that
do not answer and a client that hands in only agreeing reports; a release in the very last valid
block; blanked ciphertexts of the wallet's own outputs; leaves shifted by a forged transaction in
front of a rescan, with a lock invariant taken from the oracle's books).

What the test's model is, so that its own blind spots can be judged: the oracle (`RefChain`)
keeps its own nullifier set, hashes (SHA-256 with the tags written out in the test), anchor
window and expiry rule, reads bodies at the byte offsets of spec §3.2, and enters every note in
its books from what the MAKER of the transaction knows — never by scanning or decrypting. It is
cross-checked against the stage-1 `Pool` after every block. It shares with the code under test:
the Poseidon tree hash and the nullifier / `rho` derivations of `quantum_vault_shield_v2::reference`
(the chain's primitives), and the wallet's own assembly to MAKE transactions (bodies are then
read independently). One transaction per block; no reorganisations; proofs are not made.

### Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running. (The tool that ran them moves a command to the background after
ten minutes; the two that took longer — the first release build of the daemon and the
`test-prover` suite — were waited for before any other `cargo` command was started.)

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` | **83 passed, 0 failed, 0 ignored**: wallet 76 (unit 21, `review_wallet_1` 14, `review_wallet_2` 14, `review_wallet_3` 17, `settlement_properties` 1, `vectors` 3, `wallet_flow` 6), wasm 7 (`api` 2, `review_wallet_1` 4, `review_wallet_3` 1) |
| the property test alone, once per mutation (26 runs on the final test) | table above |
| `cargo build -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown` | succeeds, no warnings; 2,620,985 bytes |
| `cargo test -p quantum-vault-shield-v2 --features test-prover -- --test-threads=1` | 71 passed, 0 failed, 1 ignored (`prover::measure_proving_time`, a measurement that was ignored before; this crate is not changed by the branch): unit 6, `forgery` 10, `negative` 17, `pool` 17, `prover` 4, `review2_wrapper` 5, `review_node_1` 3, `review_verifier` 3, `vectors` 6 |
| `cargo test -p quantum-vault-shield-v2 -- --test-threads=1` | 35 passed, 0 failed, 0 ignored: unit 2, `pool` 17, `review2_wrapper` 5, `review_node_1` 3, `review_verifier` 3, `vectors` 5 |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_daemon_tests --test-threads=1` | 11 passed (10 before + `rw3_f2_…`; `rw3_f6_…` passes), 287 filtered out |
| `… -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed |
| `… -- node::shield_v2_review_node_1_tests --test-threads=1` | 5 passed |
| `… -- shield_v2::tests --test-threads=1` | 6 passed |
| `… -- node::strict_historical_replay_tests --test-threads=1` | 3 passed |
| `cargo test -p quantum-vault-storage` | 19 passed |
| `cargo build -p quantum-vault-daemon` | succeeds |
| `cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2` | `quantum-vault-shield-v2 feature "default"` only; the normal and build graph of the daemon contains neither the wallet nor the wasm crate |
| `NOBLE_ROOT=… node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 checks passed (read-only) |

`core/target/` was deleted afterwards.

### What remains trust in nodes

* A MAJORITY of the configured nodes lying together — or one operator behind most of them — is
  believed in everything: forged notes are confirmed and spendable (G2), a live transaction is
  settled as `expired` and the retry pays twice (G1), a mined one is hidden. No proof against the
  chain exists; that needs header commitments and a light client.
* Who the configured nodes are is the configuring party's decision. The core cannot tell two
  names of one machine apart; canonicalisation collapses spellings, not operators.
* `ciphertext_acc` is a statement of each node about its own store, not consensus data: an honest
  node whose side record is missing reports `null` (and then does not count), and nothing but the
  quorum stands behind the value.
* An honest node's report is trusted to describe a block it accepted. A proposer that equivocates
  can make honest nodes accept different blocks at one height; that is a consensus failure.
* A reorganisation below the confirmed height is not handled (the confirmed height never goes
  back).
* Locks are per device (RW3-10): the embargo after a restore is the UI's to enforce.

### Not done

* **A wallet with one configured node does not work**: nothing is confirmed, so nothing is
  spendable by default and no transfer or unshield can be built — as the task specified ("a
  single-node wallet shows everything as unverified"), but it also removes the former "my own
  node, quorum 1" mode, and with it the single-node development setup. Whether a deliberate,
  loudly named single-node mode should exist is a product decision that was not taken here.
* The client loop (ask every node, rotate the listing node, rescan on `listing_refuted` /
  persistent `listing_ahead`, the embargo after a restore) exists as documentation and as the
  property test's client; no client code was written, and no part of the core makes a request.
* `listing_ahead` cannot distinguish an honest listing node that is a block ahead from one that
  invented a block; the core returns the signal and the client decides after asking again.
* A format-3 state built after a lying page keeps its long expiry (stated in `from_json`):
  shortening it would release a lock on a transaction that is still valid.
* The side record of an already running node is rebuilt at start-up from its stored blocks; this
  path is tested through `shield_v2_rebuild_ciphertext_acc` in the daemon test, not by restarting
  a node on an old data directory. No node was started, stopped or touched.
* `MAX_SPENT_RETAINED` (4,096) is exercised by `rw3_f4_…` only; the property test's histories are
  far shorter.
* The JavaScript / TypeScript bindings were not generated (`wasm-bindgen-cli` is not installed);
  nothing was run as WebAssembly. GitHub Actions was not run.
* The viewing-key-only path (`nk = None`) with pending transactions is still only read, as in the
  review; own outputs of a restore are recognised only with `nk`.
