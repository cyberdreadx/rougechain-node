# REVIEW_WALLET_5 — fifth independent review: the state that always reads back, the embargo in the core, the client loop

Reviewed: `fix/shield-v2-wallet-settlement-3` @ `43166fb` — the rework `075325b..43166fb` of
`core/shield-v2-wallet` (`store.rs`, `tx.rs`, `select.rs` in full), `core/shield-v2-wasm/src/api.rs`,
`tests/settlement_properties.rs` and `tests/common/` in full, `REVIEW_WALLET_4.md` with its
Resolution, `NOTES.md` §6 (the normative client loop) and §13, spec §5.4, §5.5 with W-18 and
W-19. The reviewer wrote none of it. Date: 2026-10-06/07. Branch `review/shield-v2-wallet-5`.
**Nothing was fixed.** Tests: `tests/review_wallet_5.rs` (12; 4 fail on purpose).

Threat model and guarantees: as in REVIEW_WALLET_4 (a strict minority of the CONFIGURED nodes
lying arbitrarily; hostile senders and payees; several devices on one phrase; restores;
migrations; crashes; an honest strict majority, some of it unreachable or lagging). G1 no double
or unrequested payment by the wallet's own behaviour; G2 confirmed balance ≤ true balance at the
confirmed height; G3 every pending transaction settles and every owned unspent note becomes
spendable in bounded time; G4 a lying or unreachable minority causes bounded delay only.

## Verdict

**READY for UI integration with the following conditions.**

The two guarantees that cost money when they fail held against everything tried here: I found
no way to make the core pay twice, release a lock early, confirm a note that is not on the
chain, or lose a note or a lock (G1, G2, and the "nothing lost" half of G3). The state always
read back. The embargo arithmetic is what the documents say it is, to the block. The API shape
(`new_state` → `set_nodes` → `scan` → `confirm_state` → `resolve_pending` → `build_*` →
`{ state, envelope }`, `recover_locks`, `assert_sole_copy`) can be coded against and none of the
conditions below changes it.

What is NOT in order is liveness (G3, G4), in three places, and the evidence offered for it:

* **one defect in the core (RW5-1, Medium)**: a lying listing node can make `scan` answer
  `state_invariant` — the error the documents call "an implementation fault" and for which the
  client loop has no rule. **The shipped property test finds it by itself on a seed range the
  Resolution did not run** (seed 7032 at 1,000 steps: it fails on the unmodified code);
* **the normative client loop (RW5-2, RW5-3, Medium)**: against a lying listing node that
  behaves consistently — instead of at random, as the property test's adversary does — the loop
  as written does not terminate: it never leaves a node that never reaches its tip, and it
  blames (and bans) the honest node that was listed from when the lie came to light, until the
  liar is the only node left to list from;
* **the embargo is a number of blocks (RW5-4)** on a chain that makes blocks only for
  transactions: 128 to 384 blocks — by the operator's own block heights about 11 to 32 days at
  the present rate, and for ever on an idle chain. It applies to a NEW wallet as well. In
  practice every UI will make the override its default path, and the embargo will then protect
  exactly the users who did not click.

### Conditions

Each is concrete and checkable. **CORE** = a change in this crate; **UI-CONTRACT** = an
obligation of the client layer (or of the documents a client is written from); **INHERENT** = a
limit that follows from having no light client or from consensus parameters — to be stated to
the user, not fixed here.

**Before any client code for syncing is written from `NOTES.md` §6** (the loop is what three
clients will transcribe):

1. **UI-CONTRACT (documents) — the loop terminates against a consistent liar.** `NOTES.md` §6
   and spec §5.5 are amended so that (a) a listing node is left when the client did not reach
   `at_tip`, or `scanned_height` stayed above `confirmed_height`, for a bounded number of
   rounds while a quorum answers (RW5-2); (b) the nodes that are put into `bad` when a listing
   is refuted or a page is flagged are **every node that contributed a page to the state since
   its last rescan** — or the state is rescanned on every change of the listing node — so that
   the liar is among them (RW5-3); (c) `rescan_required:` is a RESCAN that blames nobody (it is
   the client's own worker that caused it); (d) there is a rule for `state_invariant:` from
   `scan` (RESCAN, list from another node, report) for as long as condition 2 is not met.
   *Check:* `rw5_demo_a_listing_node_that_never_reaches_its_tip_…` and
   `rw5_demo_one_lying_listing_node_gets_both_honest_nodes_blamed_…` restated for the amended
   loop end with the tip confirmed; the property test's adversary gets PERSISTENT strategies
   (the two of these tests at least) and its client stops when every node is in `bad`, as the
   loop says, instead of clearing the set (`settlement_properties.rs:1109–1114`).
2. **CORE — no page makes `scan` answer `state_invariant` (RW5-1).** *Check:* `rw5_f1_…` and
   `rw5_f1b_…` pass unedited; `PROP_SEED_BASE=7000 PROP_RUNS=100 PROP_STEPS=1000` passes.

**Before a release to users:**

3. **UI-CONTRACT — the override (`assert_sole_copy`) is never a default.** It is called without
   a question only for a phrase that was GENERATED on this device in this installation; for an
   imported or restored phrase only after the user was shown, and confirmed, the sentence of
   `NOTES.md` §6 item 7 (a); a restore after a LOST device defaults to the embargo. *Check:*
   code inspection of each client: every call site of `assert_sole_copy` is reached from
   "create new phrase" or from an explicit confirmation dialog, and none from a generic
   "initialise state" helper (the shared TEST helper `tests/common::configure` is exactly such
   a helper — do not copy it).
4. **UI-CONTRACT — the first state check of a state made by `new_state`** (while
   `summary.spend.embargo_until` is null) is made only with a report from EVERY configured
   node, all for one height; the client waits and asks again otherwise, for a bounded number of
   rounds that it shows to the user, before it accepts a first check with a node missing
   (which costs 256 blocks) — RW5-5. *Check:* a client test with one node one block ahead and
   one with a silent node.
5. **UI-CONTRACT — bounds are shown in blocks with the chain's present rate**, never as time
   alone: "128 blocks — at the rate of the last N days about D days; an idle chain makes no
   blocks". The envelope is stored with the state and re-submitted (condition 9 of
   REVIEW_WALLET_4, unchanged).
6. **CORE (small; RW5-6, RW5-7)** — `rescan_state` with another limit has its own
   `revision_id`; an IPv4 literal and its IPv4-mapped IPv6 form are one host. *Check:*
   `rw5_f2_…`, `rw5_f3_…` pass unedited.
7. **UI-CONTRACT (unchanged from REVIEW_WALLET_4 §8, still open by their nature):** durable
   write of `{ state, envelope }` before the submit, compare-and-swap on the LOADED
   `revision_id`; the state stored as the opaque text and authenticated at rest; an odd number
   ≥ 3 of nodes run by different operators; every configured node on a build that reports
   `ciphertext_acc`.

**INHERENT — to be stated, not fixed here:**

8. **The embargo is a margin of exactly 256 blocks of honest lag, not a proof** (section A.1):
   with 3, 5 or 7 nodes, a full lying minority and ONE honest node 257 blocks behind the height
   the lost device built at, a restored device pays twice. An honest node that is syncing
   answers `report` for every height it passes and nothing in the answer says so
   (`core/daemon/src/node.rs:5751–5761`).
9. **Every bound is a number of blocks on a chain without a block time** (RW5-4): the embargo
   (128–384), a lock after a lost submit (64), the life of a spend (64/128). A wallet-side
   clock cannot replace any of them — the earlier transaction stays valid in BLOCKS whatever
   time passes. What would: a consensus change (heartbeat blocks at a fixed cadence, or an
   expiry by block timestamp). That is O-8 again, with a number on it.
10. A majority of the configured nodes is believed in everything; one operator behind several
    host names is several nodes to the wallet; a second LIVE device has no locks (unchanged).

| # | Severity | Violates | Finding | Where | Test |
|---|---|---|---|---|---|
| RW5-1 | **Medium** | G4, G3 (delay without a bound under the documented loop; nothing lost) | A lying listing node makes `scan` answer `state_invariant`: (a) the viewing-key worker reads ONE page that lists a spend before the note it spends — every later scan with the full key is refused, on any node's pages, and the state is view-only (it builds nothing); (b) on the full key, a listing that repeats the note of a pending payment 12,417 times and then lists the payment. The state is intact and `rescan_state` recovers, but the documents call the error an implementation fault, the loop has no rule for it and the property test's client panics on it — **which it does, on the unmodified code, at seed 7032 × 1,000 steps** | `store.rs:3050–3052` (a remembered spend applied at its listed height) against `1979`; `2839–2857` against `1970–1971`; `NOTES.md` §6 step 1; `settlement_properties.rs:1102` | `rw5_f1_…`, `rw5_f1b_…` **FAIL**; the property test at `PROP_SEED_BASE=7000 PROP_RUNS=100 PROP_STEPS=1000` **FAILS** |
| RW5-2 | **Medium** | G4, G3 (the normative loop) | The loop leaves a listing node on three signals, all of which need the node to let the client reach `at_tip`, be refuted, or show pool transactions above the quorum's tip. A node whose pages make no progress (`next_height = from_height`, a far `tip_height`) triggers none: 40 rounds, 160 state revisions written, nothing confirmed, never left. A node that serves the truth and then EMPTY heights above the tip keeps `scanned > confirmed`: the core says `can_spend_now`, the loop's own condition for a payment is never met | `NOTES.md:500–517` (and spec §5.5); `store.rs:2931`, `3197`, `2747` | `rw5_demo_a_listing_node_that_never_reaches_its_tip_…` (passes: states the limit) |
| RW5-3 | **Medium** | G4, G3 (the normative loop) | `RESCAN(L)` puts the node listed from AT DETECTION into `bad`. After "L := next node (NO rescan)" that is an honest node whose true page disagrees with the liar's pages still in the state (`leaf_mismatch` — deviation B — or `listing_refuted`). The liar's own forged listing claims a low tip, is never comparable and never blamed. One liar of three and honest nodes one to three blocks apart for two rounds: both honest nodes in `bad`, the liar the only node left to list from, "every node in bad → stop" never fires. `rescan_required:` blames an honest node the same way | `NOTES.md:502`, `509`, `514–515`, `530–532` | `rw5_demo_one_lying_listing_node_gets_both_honest_nodes_blamed_…` (passes) |
| RW5-4 | Medium (product; not a core defect) | G3 | The embargo ends at a CONFIRMED HEIGHT. On an idle chain it never ends; at the present rate (the operator's heights: 100 on 2026-09-23, 245 on 2026-10-05 — about 12 blocks a day) 128 blocks are about 11 days and 384 about 32. It applies to every state made by `new_state`, a brand-new wallet included. A shield from the public account is not gated, so a user can buy blocks at one fee each | `store.rs:71`, `77`, `2241–2251`; `tx.rs:633–645` | `rw5_demo_on_an_idle_chain_the_restore_embargo_does_not_end` (passes) |
| RW5-5 | Low | G3 for the honest user; nothing for G1 | The override is honoured only if no configured node reported above the height being confirmed — a rule that exists to make `rw4_f1b` pass with the shared helper. (a) A new wallet with a TRUE statement and one honest node one block ahead in the first check is embargoed for 129 blocks and can never make the statement again. (b) Against the attack it is aimed at it does nothing: with the leading honest node silent in that one call the statement is honoured at ONE block of lag | `store.rs:2796`, `2225–2227` | `rw5_demo_the_override_is_lost_to_a_one_block_race_…` (passes) |
| RW5-6 | Info | — (RW4-10's claim) | `fresh_for_rescan_with` changes the minimum note value and the cap AFTER the revision identity is computed: three different states, one `revision_id`. (A state made by `new_state` has the all-zero identity whatever its limits.) The storage compare-and-swap is not affected | `store.rs:1466–1469` | `rw5_f2_…` **FAILS** |
| RW5-7 | Info | G2 by configuration (residual of RW4-2) | `https://192.0.2.7` and `https://[::ffff:192.0.2.7]` are one endpoint and two hosts: accepted together, two of three votes | `store.rs:338–350`, `423` | `rw5_f3_…` **FAILS** |
| RW5-8 | Info | — (assurance) | The property test: it fails on the unmodified code at seed 7032 × 1,000 (RW5-1); its adversary draws a fresh lie per page (no persistent strategy); its client deviates from the loop where the loop would stop; its honest lag is capped inside the embargo's assumption; of fifteen fresh mutations it catches five on 30 seeds — a lag bound of 64 instead of 256 is not among them, on 120 seeds either (section 5) | `settlement_properties.rs:892–1038`, `1109–1114`, `1728`, `107` | section 5 |
| RW5-9 | Info | G1 by a damaged or tampered state only | Reading is fail-open for the embargo: a format-5 state text WITHOUT `spend_embargo` reads as "no embargo" (`#[serde(default)]` = `NotRequired`), and so does any text whose `version` is 1 to 4. No call of the core writes such a text | `store.rs:1206–1207`, `935`, `1912` | — (by reading) |

---

## 1. Findings

### RW5-1 (Medium; G4, G3) — a listing node can make `scan` answer `state_invariant`

REVIEW_WALLET_4's High was a state that was written and could not be read. The fix is sound as
far as it goes: every changing call validates its result and refuses instead of returning it. But
"refuses" is `WalletError::StateInvariant`, documented as *"an implementation fault"*
(`error.rs:40–44`, `NOTES.md` §13), for which the loop has no rule (`NOTES.md:502` lists
`listing:`, `leaf_mismatch`, `rescan_required:`) and on which the property test's client panics
(`settlement_properties.rs:1102`). Two inputs a listing node controls lead there.

**(a) The viewing-key worker, one page.** Without `nk` the scan cannot see spends; while it
holds a note without a nullifier it remembers every nullifier it meets, with the height it was
listed at (`store.rs:3068–3075`). The first scan with the full key derives the missing
nullifiers and applies the remembered sightings: `mark_spent(…, seen.height, …)`
(`store.rs:3050–3052`). If the listing showed the spend BEFORE the transaction that created the
note, `spent_height < height`, which `validate` forbids (`store.rs:1979`). Honest listings never
do that. A liar does it by listing any stretch of the chain in another order; it need not know
which transaction spends what.

```
rw5-f1: a listing with a spend listed before the note it spends, read with the viewing key:
accepted; the next page with the full key: Err(state_invariant); again: Err(state_invariant);
from another node: Err(state_invariant); the worker can go on with the viewing key: true;
after rescan_state + an honest listing: Ok
```

From then on the state cannot be advanced with the full key by ANY node's pages, and because it
is marked view-only it builds nothing (`view_only:`). The locks, the pending list and the
confirmed data are intact, and `rescan_state` gets out of it — but nothing tells the client to
call it. A client written from the documents retries, or reports a bug.

**The property test finds this by itself.** On the unmodified branch:

| Run | Result |
|---|---|
| seeds 5001–5300 × 280 steps | passes, 373 s |
| seeds 7001–7100 × 1,000 steps | **fails at seed 7032**: "scan failed with the call would have left a wallet state that does not read back" (260 s) |
| seed 7032 alone, with a scratch trace in `returnable` (reverted) | `a stored note's heights are inconsistent` — the note at leaf 466, `height 6618`, `spent_height Some(2906)`; the state not view-only any more at that moment (the full key is filling in), 87 notes, nothing pending |

The Resolution's two extended configurations (700 × 280, 250 × 700) do not reach it; 100 × 1,000
on another base does. This is RW4-6 again in kind: the instrument is good, and the range it was
run on ends before its first failure.

**(b) The full key, a pending payment, a listing that repeats itself.** A state keeps at most
4,096 spent notes — except inputs of pending entries, which are never dropped
(`store.rs:2850`), and `validate` allows `4,096 + 2·(64 + 4,096)` = 12,416 spent notes
(`store.rs:1970–1971`). A lock is held by commitment, so every COPY of the note of a pending
entry is "an input of a pending entry". A listing that shows the creating transaction 16,383
times (four pages) and then the payment: every copy opens (it is the wallet's note), every copy
is stored, all are spent by one nullifier, none may be dropped, and the page is refused:

```
rw5-f1b: four pages that repeat one true transaction: [Ok(4096), Ok(4096), Ok(4096),
Err(state_invariant)]; the state holds 12288 notes (0 spent), 1 pending, and reads back: true
```

This is the default path: no worker, the documented rescan with a transaction pending. The
client is stuck on that page for as long as it lists from that node, and no rule makes it leave.

*Why Medium and not High.* Nothing is lost: the refused call leaves the state as it was, the
lock included, and the existing `rescan_state` followed by another node recovers both cases. It
is unbounded delay only because the documented loop has no way to that recovery.

*Direction (not done).* A page is the node's; whatever a page leads to must be a `listing:`
error or be absorbed, never `state_invariant`. For (a): a sighting older than the note is not
that note's spend on any chain — ignore it, or answer `rescan_required:`. For (b): refuse a
listed output whose commitment the state already holds unspent (`listing:`), or let
`drop_old_spent` keep one note per commitment. And give the loop a rule for `state_invariant:`
from `scan` regardless (condition 1 (d)): the guard exists for the cases nobody thought of.

### RW5-2 (Medium; G4, G3) — a listing node that never reaches its tip is never left

The loop (`NOTES.md:500–517`):

```
at_tip and (nothing confirmed, or confirmed_height < report.quorum_tip) → behind += 1; …
no match and none of the above                                         → wait and repeat: NOTHING else
```

`at_tip` is what the listing node says about itself (`next_height > tip_height`,
`store.rs:3197`). `scan` accepts a page with `next_height = from_height` (`store.rs:2931`: only
`<` is refused) and any `tip_height` above it. So:

```
rw5-loop (a): 40 rounds listing from a node whose pages make no progress: L is node 1, bad {},
confirmed None, scanned Some(2), 160 state revisions written, stopped: false
rw5-loop (b): 40 rounds listing from a node that serves the truth and then empty heights: L is
node 1, confirmed Some(20), scanned Some(176); the core says can_spend_now = true; the loop's
condition for a payment (confirmed = scanned) holds: false
```

(a) Two honest nodes answer every round. The wallet shows nothing and settles nothing; every
round writes four new revisions of the state. The next session starts with `bad` empty and,
unless the client randomises, with the same first node. (b) `listing_ahead` looks at the last
POOL-CHANGING height (`store.rs:2747`), so empty heights above the tip are invisible to it; the
state check matches at the true tip every round; and step 5's condition
`confirmed_height = scanned_height` is false for ever. It ends when anybody's pool transaction
is mined (the liar's empty heights are then refuted and it is banned) — which on this chain is
"when somebody else uses the pool".

An honest node never serves a page without progress that is not at its tip, so the core could
refuse one (`listing:`); the loop needs a rule either way (condition 1 (a)).

### RW5-3 (Medium; G4, G3) — the honest node is blamed for the liar's pages

`RESCAN(L): bad += L`. `L` is the node the client is listing from when the lie is DETECTED. The
loop also has `L := next node not in bad (NO rescan)` — after which the state holds pages of two
nodes. The test (three nodes, node 1 lies, nodes 2 and 3 answer truthfully in every round):

1. Node 1 serves a listing with a forged payment in front and claims a tip of 9 while the chain
   is at 20. Nothing the honest nodes report is comparable (their heights are above the
   wallet's scanned height); the listing is neither refuted nor ahead. Two rounds "behind" →
   `L := node 2`, no rescan.
2. Node 2's page is true and is applied to the forged state. The state check refutes the
   listing → `RESCAN(node 2)`: **node 2 is in `bad`**. Node 3: rescan, confirmed at the tip.
3. Node 3 is behind the quorum's tip for two rounds (the model allows that: "some temporarily
   lagging") → `L := next node not in bad` = node 1, the liar.
4. Node 1 adds a forged payment and claims that as its tip. Two rounds → `L := node 3`.
5. Node 3's true page numbers its leaves below the wallet's tree: `leaf_mismatch` →
   `RESCAN(node 3)`: **node 3 is in `bad`**. `L := node 1`.

```
rw5-loop: one liar of three, honest nodes at most three blocks apart: bad = nodes [2, 3] (both
honest), L = node 1 (the liar), stopped: false, confirmed None, unverified balance 66000000000
quanta (the chain holds 16000000000)
```

Sixty more rounds change nothing. "Every node in bad → stop and tell the user" does not fire:
the liar is not in `bad`. `rescan_required:` (the worker's log overflowed after 1,024
nullifiers — on a busy chain, with every node honest) is `RESCAN(L)` too and bans whichever
honest node the client lists from.

**This is where deviation B bites** (section B): the accepted-and-flagged page is harmless to
the state and misleading to the loop — the flag says "rescan, another node", and the node it
arrives under is the honest one.

The property test does not see RW5-2 or RW5-3 because its adversary picks one of thirteen lies
at random for every page (`settlement_properties.rs:910`), "the truth" among them, so a lying
node reaches the tip, or is refuted, within a few rounds; and because its client, when every
node is in `bad`, clears the set and goes on (`1109–1114`) where the loop says stop. The bound
it asserts (`4·nodes + 8` rounds) is a bound against that adversary.

### RW5-4 (Medium for the product; G3) — 128 to 384 blocks on a chain without a clock

Every state made by `new_state` — a restore, a second device, **and a new wallet** — builds no
spend until its confirmed height is `base + 128`, `base` up to 256 above the quorum's tip when
one node is silent in the establishing call. The chain makes a block when a transaction is
pending. `rw5_demo_on_an_idle_chain_…`: fifty rounds on a chain without a new block,
`embargo_blocks_left` stays 128; it is 1 at 127 blocks and gone at 128; 384 with one node
silent.

The operator's notes give mainnet heights 100 on 2026-09-23 and 245 on 2026-10-05: about 12
blocks a day. At that rate the embargo is about **11 days, or 32 with a silent node**; a lock
after a submit that was lost is 64 blocks, about 5 days; and the whole mainnet chain is shorter
than the 256-block lag bound. On a quiet day it is longer; nothing in the wallet shortens it.
(A `shield_v2` from the user's public account is not behind the gate — `own_shield_checks`,
`tx.rs:633–645`, has no `spend_gate` — so a determined user can make 128 blocks at one fee each.)

The consequence, plainly: no UI will ship "your new wallet can pay in eleven days". The
override becomes the default for new wallets — correctly — and under pressure for restored ones
too. The embargo then protects the careful user and nobody else, and the override's contract
(condition 3) is the real control.

*Is a time-based or heartbeat rule needed?* Yes — in CONSENSUS, not in the wallet. The earlier
copy's transaction is valid until block `C_b + 128` however much time passes, so an embargo
that ends after a wall-clock interval is unsound on exactly the idle chain where it would help.
What makes the bound finite is either blocks at a guaranteed cadence (heartbeat blocks) or an
expiry the node checks against the block timestamp. Until then: INHERENT, shown in blocks with
the observed rate (condition 5).

### RW5-5 (Low; G3) — the override's condition helps nobody

`waived = sole_copy_asserted && highest <= h` (`store.rs:2796`); the statement is refused once
a base exists (`2225–2227`).

```
rw5-override (a): a new wallet with a true statement, one honest node one block ahead in the
first state check: embargo, Some(129) blocks of confirmed height to go; the statement is
refused from now on
rw5-override (b): the statement made on a restored device, the leading honest node silent in
the first state check, the other ONE block behind: honoured; the payee holds 8000000000 quanta
for one payment of 4000000000
```

(a) is an everyday race (three nodes are not asked in the same instant) and on this chain costs
the honest user weeks; the way out is a new `new_state` — safe, since an embargoed state has
built nothing — which no document mentions. (b) is the user's false statement, and the user's
responsibility; but the rule was written against this shape and a liar defeats it by waiting
for a call in which the node at the tip is slow. The Resolution says as much. A rule that is
neither a protection nor reliable for the honest user should be one thing or the other: an
unconditional recorded statement, or no override at all. Until then: condition 4.

### RW5-6, RW5-7, RW5-9 (Info)

* **RW5-6.** `fresh_for_rescan_with` (`store.rs:1462–1470`) calls `fresh_for_rescan`, which
  computes the identity, and then sets the limits. `rw5_f2_…`: three different states, one
  `revision_id`. Nothing in the compare-and-swap discipline breaks (it compares with the
  identity that was LOADED); `expect_revision_id` cannot tell the three apart.
* **RW5-7.** `check_node_set` keys a production set by the host STRING. An IPv4 literal and its
  IPv4-mapped IPv6 form are two strings and one machine. Whoever enters both made a mistake;
  RW4-2 was about not letting a mistake of spelling become a quorum.
* **RW5-9.** `spend_embargo` has `#[serde(default)]` with `NotRequired` as the default variant;
  `recover_locks` maps any `version` 1–4 with a complete pending list to `NotRequired`. A state
  text that lost the field, or whose version byte is damaged, comes back without the embargo.
  The core never writes one, and a tampered blob is outside the model — but a default that
  fails OPEN on the one safety field deserves `AwaitingBase` for a format-5 text.

---

## A. The restore embargo and its override

### A.1 The arithmetic: 256 is the true bound, to the block

`base = min(Tm, Tq + 256)` (every node reported) or `Tq + 256`; no spend below `base + 128`.

`rw5_demo_the_restore_embargo_holds_up_to_exactly_256_blocks_…` runs the stale-quorum attack
end to end — the lost device builds with the longest expiry at `C_b`; a full lying minority
lists and reports the true chain as it was where ONE honest node stands, `lag` blocks behind
`C_b`; the restored device makes no statement, waits out the embargo with every node honest
and answering, pays "again" from the other note; the liar releases the first transaction:

| n | liars | lagging honest nodes needed | lag 256: until / expiry / payee | lag 257: until / expiry / payee |
|---|---|---|---|---|
| 3 | 1 | 1 | 424 / 424 / paid once | 424 / 425 / **paid twice** |
| 5 | 2 | 1 | 424 / 424 / paid once | 424 / 425 / **paid twice** |
| 7 | 3 | 1 | 424 / 424 / paid once | 424 / 425 / **paid twice** |

The same with the honest nodes at the tip silent in the establishing call (`base = Tq + 256`)
and answering (`base = min(Tm, Tq + 256)` — the liars sit at the lagging height with the one
honest node, so the quorum-th highest claim is that height either way). With the default expiry
(64) the numbers are 320 (safe) and 321 (paid twice).

* **The smallest lag that defeats it: 257 blocks (longest expiry), 321 (default)**, for n = 3,
  5 and 7 alike, and one lagging honest node is enough at each n when the lying minority is
  full. With fewer liars than `n − quorum`, `quorum − liars` honest nodes must all be that far
  behind. With an even n and `liars < 2·quorum − n` the two quorums share an honest node and no
  lag defeats it.
* **No strategy without honest lag was found.** A match at `h` needs a quorum of reports FOR
  `h`; the liars are fewer than a quorum; so an honest node reported `h`. A liar cannot lower
  `Tq` below `h` (the code takes `max(Tq, h)`), cannot make `all_reported` true without the
  honest nodes, and cannot make `base` smaller than `min(highest honest tip that answered,
  h + 256)`. Raising it is bounded by 256 (`rw4r_f1_the_embargo_base_is_bounded_…`).
* **How realistic is 257 blocks of lag?** More than it sounds, in one respect: an honest node
  that is syncing — a new node, a restart after weeks — answers `/api/shield-v2/stats` with the
  record of the last block it ACCEPTED (`node.rs:5751–5761`), for every height it passes, and
  nothing in the answer says "not at my tip". The window is short (the duration of the sync),
  but with RW5-2 a lying listing node can keep a restored device unconfirmed for as long as it
  likes and feed it the listing up to wherever the lagging node stands. And less than it
  sounds in another: 257 blocks are three weeks of this chain.

### A.2 Is the override reachable by default from the wasm surface?

Not by accident: `assert_sole_copy(state_json, i_am_sure_no_other_copy_has_a_pending_payment,
expected_revision)` refuses `false`, has no default, is refused after the base exists, and
`summary` shows `sole_copy_asserted`. It is one call. A careless UI does not call it by
mistake; a UI under RW5-4's pressure calls it by policy. The contract is condition 3 — and
`recover_locks` with an unreadable entry returns a state on which the same call is accepted
again, so the same rule applies there (`store.rs:1911–1916`).

### A.3 Does the shared test helper turn the embargo off for the suite?

Yes for the single-scenario tests, no for the property test:

* `tests/common::configure` (and `common::confirm`, which calls it for a state without nodes)
  now sets the nodes AND makes the user's statement. Measured by mutation, not by counting
  call sites — the wallet suite of 107 tests (106 single-scenario and unit tests, and the
  property test on 10 seeds), run twice:

  | Mutation | Tests that fail | Which |
  |---|---|---|
  | W0: the statement is never honoured (every state made by `new` is under the embargo) | **49 of 107** | `review_wallet_1` 3 of 14, `_2` 10 of 14, `_3` 13 of 17, `_4` 12 of 19, `_4_resolution` 8 of 11, `wallet_flow` 2 of 6, the property test; unit tests 0 of 22, `vectors` 0 of 3 |
  | N4: the embargo is not enforced by the gate | **6 of 107** | `rw4_demo_the_restore_embargo_…`, `rw4_f1_…`, `rw4_f1b_…`, `rw4r_f1_a_restored_state_builds_nothing_…`, `rw4r_f1_the_embargo_base_is_bounded_…`, `rw4r_i8_…` (the property test on 10 seeds does not notice; the Resolution reports it does at seed 22) |

  So: **49 tests can only do what they test because the helper switches the embargo off; 6
  single-scenario tests exercise the embargo's enforcement** (7 with the property test on a
  wider range); the other 52 never spend from a fresh state. Of the six, `rw4_f1` and
  `rw4_f1b` reach the embargo THROUGH the helper's statement and its voiding rule (RW5-5) — the
  scenario without the statement is the two `rw4r_f1_…` tests (54 + a handful of cases).
* The property test does not use the helper. Its first wallet makes the statement
  (`new_state(true)`, `settlement_properties.rs:658`), as does its second device; a restore
  does not (`new_state(false)`, `1739`). In the 300-seed run: 621 restores, 823 embargo bases
  fixed (95 of them more than 64 blocks below the tip), 1,475 builds refused by the embargo,
  and **162 times a restored state got past the embargo while a payment of the lost copy was
  still unaccounted for** — against 4,255 payments in all.
  The default path is exercised, on restores only; a migrated state has no embargo, and the
  test's migration step is skipped while an earlier copy's transaction is alive (`1771`).
* What that leaves untested, measured in section 5: the silent-node branch of the base (X1),
  the size of the lag bound (X2: 64 instead of 256) and the gate's boundary (X5) are NOT
  noticed by the property test on 120 seeds; each is pinned by one to three single-scenario
  tests only.
* A test helper that makes the statement is fine for tests. It is also the shape a client
  author will copy for "initialise the wallet state". Condition 3.

### A.4 Blocks on an idle chain

RW5-4. The embargo never ends without blocks; a time rule in the wallet is unsound; a heartbeat
or a timestamp expiry in consensus is what would bound it.

## B. "An honest page after a lying one is now accepted"

**Nothing is planted in the state** (`rw5_sound_an_accepted_page_after_a_lying_one_…`):

* notes from the liar's page and from the honest page above it are `unverified` and stay so:
  the confirmation compares the tree root, both running hashes and both counts, all of which
  contain the liar's leaves — the state check with every honest node REFUTES the mixture and
  the confirmed height stays where it was;
* the pending entry is byte for byte what it was (held by commitment and nullifier; `inputs`
  is derived); `resolve` settles nothing above the confirmed height; coin selection offers
  nothing unverified; the rescan against an honest node ends with the true balance and the lock;
* checkpoints above the fork are the wallet's own (wrong) states and can only fail to match;
* the truth served under lower leaf numbers is flagged AND confirms (positions are the
  wallet's own) — so the flag costs one rescan per lying node, no more.

**It cannot loop the CORE in rescans.** It does mislead the LOOP: the flag arrives on the
honest node's page and the loop bans the node that delivered it — RW5-3. Before this change the
same page was a `listing:` error with the same `RESCAN(L)`; the misattribution is the loop's,
and older than the deviation. Verdict on B: sound in the core, and a condition on the loop.

## C. The longest expiry stayed 128

It does not reopen RW4-1 in any configuration I could construct. REVIEW_WALLET_4 asked for 64 to
give the old rule ("128 above the first confirmed height") a margin; the new rule puts the
margin into the base instead, and `RESTORE_EMBARGO_BLOCKS` IS `MAX_EXPIRY_OFFSET`
(`store.rs:71`): the gate opens at confirmed height `base + 128`, which is the last block a
transaction built at `C_b ≤ base` with the longest expiry can be mined in — a block the
restored device has then read. `rw5_sound_the_longest_expiry_and_the_embargo_meet_without_a_gap`:
closed at `until − 1` with the transaction still minable; the transaction mined in its last
block; open at `until` with its input spent in the restored state. `mark_pending` (public)
applies the same bound and the same gate (`store.rs:2545–2549`). Mutation X16 (expiry up to
+192, embargo 128) is caught at once. What the longer expiry costs is in A.1: 64 blocks of the
lag margin (257 instead of 321).

Not covered by any embargo, as documented: transactions built by format-1 clients (no bound on
the expiry) and format-3 clients (expiry from the scanned height); none was released.

---

## 2. Also attacked

**1. `recover_locks`, "the state always reads back", `StateInvariant` for good.** Every clause
of `validate` was walked against what `scan`, `confirm_state`, `resolve`, `mark_pending`, the
hints, `set_nodes`, the override and `record_own_shield` can write. Reachable from outside: the
two of RW5-1, both through `scan`, both refusals of ONE call that leave a valid state. None was
found in `confirm_state` (the base satisfies `embargo_ok` also at saturating heights),
`resolve`, `mark_pending` (twin inputs are refused earlier, as a request error) or the
migrations. `to_json` refuses for good only above 256 MiB (how close a state with the default
cap of 65,536 scattered notes comes to that was not measured). Format 4 → 5 in place, poisoned entries included, and 1/2/3 → 5: the property test's
migrations (2,563 of them in the 300-seed run) and `rw4r_f5_…` cover them; an older text that
does not validate (more than 64 entries, three inputs) goes through `recover_locks`, which
reduces instead of refusing. `recover_locks` returns `StateInvariant` only if its own result
fails validation — not reached by REVIEW_WALLET_4's damages or by reading; no further fuzz of
it was run here. Mutation X12 (the guard removed altogether) passes the
property test: in its world the guard never fires on unmutated logic — except at seed 7032.

**2. Twin notes.** There are none on the chain: a commitment contains
`rho = H_rho(nf1, nf2, j)` and no two transactions share a nullifier (spec §2.4, lines
260–261); `opens` recomputes it from the LISTED nullifiers. Twins exist in a listing that shows
a transaction twice: `rw5_sound_twin_notes_…` — the copy is unverified for ever, in no
confirmed figure; one nullifier, so one spend marks both; a lock on one locks both (by
commitment and by nullifier); a transaction from both is refused; the rescan has one note.
Nothing lost, nothing double-counted in a confirmed balance. Their one bad effect is RW5-1 (b).

**3. `MixedOwnAddress`, view-only, node ids, `revision_id`, `build_own_shield`.**
`MixedOwnAddress` is checked in the transfer assembly and in `own_shield_checks`; an unshield
has no recipient address. The view-only mark is set by the first scan without `nk` and cleared
by any scan with it; `spend_gate` refuses first on it (but see RW5-1 (a): the clearing scan can
be made to fail). Node ids: `https` only outside loopback sets, one per host STRING (RW5-7);
**two operators behind one host name** (two paths or two ports of one host) cannot both be
configured — the path is dropped and the host must be unique — which errs on the safe side;
**one operator with three host names is three nodes and is outside the model**, as the
documents say. `revision_id`: every changing call ends in `bump` except
`fresh_for_rescan_with` (RW5-6); `set_nodes` with an unchanged set does not bump (nothing
changed). `build_own_shield` records before it proves, refuses a mixed address and a foreign
state, is not gated by the embargo (it spends nothing), and its record cannot open a commitment
it does not match (`opens`).

**4. The loop.** Not complete as an algorithm: RW5-2 (termination), RW5-3 (rotation and
blame), no rule for `state_invariant:`; `outdated_nodes` is display only (and such a node also
costs 256 blocks if it is "silent" in the establishing check); the embargo is the core's, but
"make the FIRST state check with every node answering" is a wish the loop gives no step for
(condition 4). **The property test's client is not exactly that loop**: it clears `bad` when
every node is in it instead of stopping (`1109–1114`); it offers a payment only `at_tip`
(`1728`) where the loop asks for "matched and confirmed = scanned"; it resets `ahead`/`behind`
on every change of node (the loop is silent); it treats the worker's errors as RESCAN (the loop
has no worker step). None of these is wrong in itself; the first one is why "ends within
`4·nodes + 8` rounds" holds in the test and not in the loop as written.

**5. The property test.** Section 5.

## 3. Checked and found sound

The embargo arithmetic, to the block, for n = 3, 5, 7, both branches of the base; the gate in
the builders and in `mark_pending`; the embargo across `fresh_for_rescan` and `recover_locks`
(a waived embargo goes back to "awaiting base"; an unreadable entry embargoes); the longest
expiry against the embargo at the boundary; no spend path around `spend_gate` in the 26 wasm
exports; an accepted page after a lying one plants nothing confirmable and changes no pending
entry; twin notes; locks by commitment AND nullifier through rescans on shifted listings;
`validate` clause by clause against every writer; `to_json` ⊆ `from_json` on 300 × 280 runs and
on 31 × 1,000 before the failure; `MixedOwnAddress` in both builders; one node per host and
https-only; the quorum rule untouched by this rework (REVIEW_WALLET_4 §2.1 stands); G1 and G2
invariants of the property test on 115,000 steps of fresh seeds.

## 4. Outside the model, plainly

A majority of the configured nodes lying, or one operator behind most host names; a second LIVE
device (no locks, no embargo once its own has ended); a tampered or damaged state blob (RW5-9
is where that fails open); honest nodes more than 256 blocks behind at a restore.

## 5. The property test: independence, more seeds, fifteen mutations

**Independence of the oracle.** As REVIEW_WALLET_4 found, and improved since: `RefChain` keeps
its own nullifier set, hashes, anchor window, expiry rule and books, reads bodies at byte
offsets, and now recomputes every output's commitment from the amount the REQUEST implies
(`Tx::checked`), cross-checked against the stage-1 `Pool`. It still makes transactions with the
wallet's own assembly and shares the stage-1 primitives. Three of its "invariants" are the
code's rule restated rather than a property of the model: the waiver condition (`1296`), `until
== base + 128` (`1299`) and `base ≤ height + 256` — a mutation of those constants is "caught"
by the restatement (X3, X4 below), not by a payment made twice.

**What its world does not contain:** an adversary with a strategy that lasts longer than one
page (RW5-2, RW5-3); honest nodes more than 200 blocks behind (`HONEST_LAG_MAX`, inside the
256 the embargo assumes — the assumption is never tested from the outside); a listing in
another ORDER or with repeated transactions (RW5-1 — reached by accident at seed 7032);
`recover_locks`; a rescan of a state under the embargo that matters (X6).

**More seeds** (unmodified code): 5001–5300 × 280: passes (373 s; 4,255 payments, 621 restores,
823 embargo bases of which 95 stale, 1,475 embargo refusals, 162 embargoes ended, 3,581 / 410 /
243 settled mined / expired / superseded, 75 leaf mismatches, at most 7 rounds to settle).
7001–7100 × 1,000: **fails at seed 7032** (RW5-1).

**Fifteen fresh mutations** (none is in either earlier table), each applied alone, then the
property test on seeds 1–30 × 280; the four embargo mutations it missed again on seeds 1–120;
every miss then against the rest of the wallet suite (88 tests: unit, `review_wallet_1` … `_4`,
`review_wallet_4_resolution`, `vectors`, `wallet_flow`). All reverted; `git status` clean.

| # | Aim | Mutation | Property test, seeds 1–30 | Seeds 1–120 | The rest of the suite |
|---|---|---|---|---|---|
| X1 | A | a node that did not answer is not counted: `base = min(Tm, Tq + 256)` always | **NOT caught** | **NOT caught** | 2 tests: both `rw4r_f1_…` |
| X2 | A | the lag bound is 64 instead of 256 | **NOT caught** | **NOT caught** | 3 tests: both `rw4r_f1_…`, `rw4r_i8_…` |
| X3 | A | the statement is honoured whatever the reports show | caught, seed 1: "the user's statement was honoured although a configured node is ahead" — the code's rule restated (line 1296), not a payment made twice | | |
| X4 | A, C | the embargo is 64 blocks, the longest expiry stays 128 | caught, seed 1: "the embargo base 6 is out of bounds" — `until == base + 128` restated (line 1299) | | |
| X5 | A, C | the gate opens one block early (`c + 1 ≥ until`) | **NOT caught** | **NOT caught** | 1 test: `rw4_f1b_…` |
| X6 | A | `fresh_for_rescan` drops the embargo | **NOT caught** | caught, seed 64, by a model invariant: "the core lets a restored state spend while an earlier transaction can still be mined (expiry 4839, true height 4797)" | |
| X7 | A, 1 | `recover_locks` never embargoes (unreadable entries included) | **NOT caught** (the test never calls `recover_locks`) | not run | not run (budget); by reading, `rw4r_f5_recover_locks_…` asserts `embargo` and `AwaitingBase` for an unreadable entry |
| X9 | B | `leaf_mismatch` is never reported | **NOT caught** | not run | not run; by reading, `rw4r_f5_a_page_numbered_below_…` asserts the flag (and `rw5_sound_an_accepted_page_…` does now) |
| X10 | B | a page numbered ABOVE the wallet's tree is accepted too | **NOT caught** | not run | not run; by reading, the same test asserts `listing:` for it |
| X12 | 1 | the read-back guard removed (`returnable` always `Ok`, `to_json` does not compare) | **NOT caught** | not run | not run; by reading, the unit test `a_state_that_does_not_read_back_…` |
| X13 | 1 | the derived positions are never recomputed | caught — by the core's own refusal: "an older format is migrated: State(\"a pending transaction is malformed\")" (`from_json` in the test's migration step) | | |
| X14 | 2 | a lock is held by commitment only, not by nullifier | **NOT caught** | not run | not run; I know of no test that needs the nullifier half for an entry that has its commitments (it is what holds an entry migrated from format 2 WITHOUT its notes after a rescan — a state the property test's migration avoids, lines 1801–1803) |
| X15 | 2 | a lock is held by nullifier only, not by commitment | caught, seed 10, by a model invariant: "after the worker scans with the viewing key: an input of a pending entry is not locked" | | |
| X16 | C | an expiry up to confirmed + 192 is accepted (builder and `mark_pending`); the embargo stays 128 | caught, seed 1, by the model's probe: "an expiry 129 blocks above the CONFIRMED height 376 was accepted" | | |
| X17 | 2 | a pending entry's nullifier in the listing does not mark its input spent by commitment | **NOT caught** | not run | not run; it matters only for a note without a stored nullifier |

**5 of 15 caught on 30 seeds, 6 on 120** (of the four re-run). By what: **3 by an invariant of
the model** (X6, X15, X16), **2 by the code's own rule restated in the test** (X3, X4), **1 by
the core's own refusal** (X13). Of the nine misses the suite was run for three (X1, X2, X5:
each caught, by one to three single-scenario tests); for six it was not run, for the CPU
budget on this host — the "by reading" entries are not measurements.

What the misses say, each looked at as a possible hole in the code and not only in the test:

* **X1, X2, X5 (the embargo's base and gate).** The code is right at all three (section A.1
  runs both branches of the base and the boundary to the block; `rw5_sound_the_longest_expiry_…`
  the gate). The property test cannot tell 256 from 64: its stale-quorum adversary needs a
  transaction of the lost copy that is still alive AND built more than 64 (128 with the
  default expiry) blocks above where the lagging node stands, which its random walk produces
  too rarely for 120 seeds. "The property test's world runs inside the margin" (the
  Resolution, `NOTES.md` §13) is true and is not evidence that the margin is what the code
  implements.
* **X9, X10 (deviation B).** With the flag gone the client still recovers — the mixture is
  refuted by the state check — and a page that skips leaves gives a state no quorum confirms.
  Both mutants are a longer way to the same rescan in the test's world; `leaf_mismatch` is
  advice, not a safety mechanism (section B).
* **X12 (the guard).** No call of the unmutated code produced a state that does not read back
  in 30 seeds, so removing the guard changes nothing there. At seed 7032 × 1,000 it would have
  (RW5-1): the guard is what turned a High of the RW4-5 kind into a refused call.
* **X14, X17 (twin rules).** Under the full key the nullifier half and the commitment half of
  the lock, and of "spent", coincide for every note the state holds; the difference is in
  states without nullifiers or without notes, which the test visits little.
* **X7.** Outside the test's world; pinned by one single-scenario test.

**Why "caught by the core's own refusal" is weaker evidence.** A mutation that the harness
notices only because a call answered `state_invariant` (or `from_json` refused) was caught by
the code under test checking itself: the same validation that the mutation could have broken
too, a check of SHAPE (does the state read back) and not of MEANING (is the balance true, is
the payment made once). It shows that the guard works; it does not show that the model would
have seen the fault had the guard not been there — and X12 shows the reverse case, the guard
removed and nothing noticed. The Resolution's A3, D1, E1 and M10 are of this kind.

## 6. Tests added (`tests/review_wallet_5.rs`)

| Test | Result |
|---|---|
| `rw5_f1_a_lying_listing_read_with_the_viewing_key_leaves_a_state_no_scan_with_the_full_key_can_advance` | **FAILS** (RW5-1 a) |
| `rw5_f1b_a_listing_that_repeats_the_note_of_a_pending_payment_makes_the_full_key_scan_answer_state_invariant` | **FAILS** (RW5-1 b) |
| `rw5_f2_two_rescans_with_different_limits_are_two_states_with_one_revision_identity` | **FAILS** (RW5-6) |
| `rw5_f3_an_ipv4_literal_and_its_ipv4_mapped_form_are_one_endpoint_and_two_votes` | **FAILS** (RW5-7) |
| `rw5_demo_the_restore_embargo_holds_up_to_exactly_256_blocks_of_honest_lag_for_three_five_and_seven_nodes` | passes (A.1) |
| `rw5_demo_the_override_is_lost_to_a_one_block_race_and_honoured_when_the_leading_node_is_silent` | passes (RW5-5) |
| `rw5_demo_on_an_idle_chain_the_restore_embargo_does_not_end` | passes (RW5-4) |
| `rw5_demo_a_listing_node_that_never_reaches_its_tip_is_never_left_by_the_documented_loop` | passes (RW5-2) |
| `rw5_demo_one_lying_listing_node_gets_both_honest_nodes_blamed_and_keeps_the_session` | passes (RW5-3) |
| `rw5_sound_an_accepted_page_after_a_lying_one_plants_nothing_that_can_be_confirmed` | passes (B) |
| `rw5_sound_twin_notes_exist_only_in_a_lying_listing_and_are_one_note_to_every_rule` | passes |
| `rw5_sound_the_longest_expiry_and_the_embargo_meet_without_a_gap` | passes (C) |

The four failures turn green on a fix without editing: `rw5_f1*` accept `Ok`, `listing:` or
`rescan_required:`; `rw5_f2` and `rw5_f3` assert the property. **They are in CI's selection**
(the wallet step runs with `--no-fail-fast`, so the other targets still run).

The two loop tests cannot turn green by a fix: the loop is prose, and the property test's
client is private to its file. They use a transcription of `NOTES.md` §6 steps 1–4
(`LoopClient`, 70 lines, in the test file) and assert the limit; a corrected loop needs them
restated (condition 1).

## 7. Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running. `PROP` = `cargo test -p quantum-vault-shield-v2-wallet --features
test-vectors … --test settlement_properties -- --nocapture`.

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --no-run` | built (the first build of the tree; not timed) |
| `PROP`, `PROP_SEED_BASE=5000 PROP_RUNS=300` (seeds 5001–5300 × 280) | 1 passed, 373 s |
| `PROP`, `PROP_SEED_BASE=7000 PROP_RUNS=100 PROP_STEPS=1000` (seeds 7001–7100 × 1,000) | **FAILED at seed 7032** after 260 s (31 seeds passed): `scan` → `state_invariant` |
| `PROP`, `PROP_SEED_BASE=7031 PROP_RUNS=1 PROP_STEPS=1000`, with a scratch trace in `returnable` (reverted with `git checkout`) | fails in 5 s: "a stored note's heights are inconsistent", leaf 466, height 6618, spent_height 2906 |
| `cargo test … --test review_wallet_5 --no-fail-fast -- --test-threads=1 --nocapture` | 12 tests: 8 passed, 4 failed on purpose, 7 s |
| `PROP` with `PROP_RUNS=30`, once per mutation X1 … X17 (15 runs) | section 5: 5 caught, 10 not (27–64 s each, the recompilation included) |
| `PROP` with `PROP_RUNS=120` for X1, X2, X5, X6 | X6 caught at seed 64; X1, X2, X5 pass (162–169 s each) |
| `cargo test … --lib --test review_wallet_1 --test review_wallet_2 --test review_wallet_3 --test review_wallet_4 --test review_wallet_4_resolution --test vectors --test wallet_flow --no-fail-fast -- --test-threads=1` for X1, X2, X5 | 106 tests each: 2, 3 and 1 failed (132–141 s each) |
| the same targets and `--test settlement_properties` with `PROP_RUNS=10`, for the census mutations W0 and N4 | 107 tests each: 49 failed (W0), 6 failed (N4) |
| `PROP_RUNS=20 cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --no-fail-fast -- --test-threads=1` (the final, unmodified tree) | **119 tests: 115 passed, 4 failed on purpose.** Unit 22, `review_wallet_1` 14, `_2` 14, `_3` 17, `_4` 19, `_4_resolution` 11, `review_wallet_5` 8 + **4 failed**, `settlement_properties` 1 (seeds 1–20), `vectors` 3, `wallet_flow` 6. The 107 tests of the Resolution's wallet crate all pass |

About 47 minutes of `cargo` under the limits in all — roughly 37 of them running tests and 10
recompiling the crate for the 17 mutations — against a budget of about 40. The suite runs for
the last six missed mutations were cut for that reason (the driver was stopped by its process
id, its children with it). The default 200-seed range of the property test was not re-run
(the Resolution reports it; 20 of its seeds were run in the final suite, 30 and 120 under
mutation).

Scratch edits (the trace in `returnable`, the fifteen mutations and the two census mutations) were reverted — the
mutation driver restores the three source files from copies after every run, and
`git status` showed only the new test file afterwards. `core/target/` was deleted.

## 8. Out of reach

* Anything as WebAssembly, GitHub Actions, any network node, the production configuration:
  nothing under `/srv/rougechain` or `~/.quantum-vault` was read, no service was touched. The
  block rate in RW5-4 is from the operator's notes as given to this review, not measured.
* Whether a syncing node really serves `/api/shield-v2/stats` while it replays (A.1): read in
  `node.rs`, not run.
* The wasm crate's tests and the daemon's interop tests were not re-run (no source of theirs
  is changed by this review).
* RW5-1 (b) through the wasm surface (the core call is the same); a 256 MiB state.
* A corrected loop: not written (the task: tests and a report only).
