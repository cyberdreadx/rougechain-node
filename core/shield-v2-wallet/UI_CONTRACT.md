# UI_CONTRACT — what a client of the shielded pool V2 wallet core owes its user

Normative for every client that calls `quantum-vault-shield-v2-wallet` or
`quantum-vault-shield-v2-wasm` (the site, the extension, Qwalla). MUST, MUST NOT, SHOULD as in
RFC 2119. It holds the conditions of `REVIEW_WALLET_5.md` that no change of the core can meet:
four obligations of the client (1–4) and three limits that are inherent and must be TOLD to
the user (5–7). Each has the check a reviewer of a client performs.

The syncing algorithm is not here: it is `NOTES.md` §6 ("The client loop"), mirrored in spec
§5.5, and it is normative too. The reference implementation of it is
`tests/common/client_loop.rs`.

## For product owners, in four sentences

* **After a restore the wallet cannot pay for 128 to 384 BLOCKS** (128 when every configured
  node answers the first state check; up to 384 when one does not, or claims a higher tip).
* **A block count has no wall-clock bound on this chain**: it produces a block when there is a
  transaction, not on a clock. On an idle chain the embargo does not end. At the rate between
  2026-09-23 and 2026-10-05 (about 12 blocks a day — the operator's block heights as given to
  REVIEW_WALLET_5, not measured here) 128 blocks are about 11 days and 384 about 32.
* **Who may skip it**: a phrase GENERATED on this device in this installation may assert "sole
  copy" silently; an IMPORTED or RESTORED phrase only after the user confirmed it explicitly.
* **A shield is not gated by the embargo**: an embargoed wallet can still receive, and can
  still shield from its public account. It cannot transfer or unshield.

Whether 128–384 blocks is acceptable is an owner decision (see "Open decision" at the end);
nothing in this file or in the core shortens or lengthens it.

## Obligations of the client

### 1. The override (`assert_sole_copy`) is never a default

`assert_sole_copy(state, true, revision)` records the user's statement "no other copy of this
wallet has a payment in flight". Once recorded before the first confirmed state check it
STANDS: the core establishes the state without an embargo, whatever the nodes report. It is
exactly as strong as it is true, and if it is false the wallet can pay twice
(`rw5_demo_the_override_stands_…`, case b).

* The client MAY call it without asking the user **only** for a phrase that was generated on
  this device in this installation, on the state made for it at that moment.
* For a phrase that was imported, typed in, restored from a backup, or whose origin the
  installation does not know, the client MUST NOT call it unless the user was shown, and
  explicitly confirmed, this sentence (or a translation of it): *"No other device, old backup
  or lost device holds this wallet with a payment that has not been confirmed or expired. If
  that is wrong, a payment can be made twice."* The default action of that dialog MUST be
  "wait" (the embargo).
* After a device was LOST the default MUST be the embargo; the dialog MAY be reachable, never
  suggested.
* It MUST NOT be called from a helper that initialises a state, from a migration, from an
  error handler or from a retry. The same holds after `recover_locks` returned
  `embargo: true`.

**Check.** Code inspection: list every call site of `assert_sole_copy`. Each is reached from
(a) "create new phrase", in the same user action that generated the phrase, or (b) the
confirmation dialog above. None is reached from a function that also serves "import",
"restore" or "open existing wallet". A UI test restores a phrase and asserts that
`summary.sole_copy_asserted` is `false` and `summary.spend.reason` is `"embargo"` without any
user action. (The test helper of this crate is split for the same reason:
`tests/common::configure` does not make the statement; `configure_as_sole_copy` does, by name.)

### 2. The first state check of a state made by `new_state` is made with every node

While `summary.spend.embargo_until` is `null` and the statement of obligation 1 is not
recorded, the next successful `confirm_state` fixes the embargo base — and a configured node
that is missing from that call costs 256 blocks (`base = quorum tip + 256` instead of the tip).

* The client MUST make that call only with a report from EVERY configured node obtained in the
  same round, all for one height; otherwise it waits and asks again in the next round.
* After **W = 5** rounds it MAY proceed without the missing node. It MUST show the user that
  it is waiting ("waiting for node X, round 3 of 5"), and what proceeding costs ("256 blocks
  more").
* This is step 2a of the loop (`NOTES.md` §6) and `Session::first_check_may_run` of the
  reference.

**Check.** Two client tests: (a) three nodes, one of them one block ahead when asked — the
client does not call `confirm_state` in that round and does in a later one in which all three
answer for one height: `embargo_until` = that height + 128; (b) one node silent for good — the
client waits exactly W rounds, shows the wait, then proceeds: `embargo_until` = height + 384.

### 3. Every bound is shown in blocks, with the chain's present rate — never as time alone

The bounds are: the embargo (128–384 blocks), the life of a spend (64 by default, at most
128), the lock after a submit that was lost (until the spend's expiry: 64 or up to 128
blocks), the usable window (`64 − confirmed_lag`).

* The client MUST show each as a number of blocks (`embargo_blocks_left`,
  `usable_window_blocks`, "expires in N blocks").
* If it shows a duration it MUST show it NEXT TO the block count, derived from the rate it
  observed over a stated period, and MUST say that an idle chain produces no blocks: *"128
  blocks — at the rate of the last 7 days about 11 days; an idle chain makes no blocks."* It
  MUST NOT show a countdown clock, and MUST NOT promise a date.
* It MUST NOT replace any bound by a timer of its own (see limit 6).
* A lost or unanswered submit is answered by submitting the SAME stored envelope again — the
  envelope is stored with the state — never by building again and never by waiting.

**Check.** Screens for: a restored wallet, a pending payment, a payment whose submit failed.
Each shows blocks; any duration is labelled as an estimate with its observation period. Grep
the client for `setTimeout`/timers that gate a payment, a retry or the end of an embargo: none.

### 4. Storage, and the node set

* **Durable write before submit.** `build_transfer` / `build_unshield` return
  `{ state, envelope }`; the client MUST store both, durably, in ONE storage transaction,
  BEFORE it submits the envelope. Not written ⇒ discard the result, do not submit.
* **Compare-and-swap on the LOADED `revision_id`.** Every write of a state is conditional on
  the stored `revision_id` still being the one this writer loaded; otherwise the result is
  discarded and the state reloaded (`stale_state:`). The counter `revision` is not an identity.
* **The state is opaque.** It is stored as the text the core returned, never edited, never
  re-serialised, never assembled from parts, and it is authenticated at rest (it also holds
  note secrets: encrypted at rest like a key). A text the core refuses (`state:`) is answered
  with `recover_locks`, NEVER with `new_state`.
* **`listed_from` is stored with the state** (the node every unconfirmed page of it came from;
  `NOTES.md` §6).
* **The node set**: an odd number of at least 3 nodes run by DIFFERENT operators; every one on
  a build whose `/api/shield-v2/stats` report carries `ciphertext_acc` (a node named in
  `confirm_state.outdated_nodes` has no vote: show "node X must be updated"). The core refuses
  two nodes on one host; it cannot know that two host names are one operator (limit 7).

**Check.** A fault-injection test kills the client between the storage write and the submit,
and between the build and the write: after a restart the first case re-submits the stored
envelope, the second has neither a lock nor a transaction in flight. A two-tab test builds in
both tabs from one stored state: one write wins, the other tab gets `stale_state:` and submits
nothing. Inspection of the shipped configuration: the operators of the configured nodes.

## Limits that are inherent — to be stated to the user, not fixed

### 5. The embargo is a margin of 256 blocks of honest lag, not a proof

The embargo is sufficient if and only if the nodes whose answers form the first quorum after
a restore are at most 256 blocks behind the height at which the lost copy last built. With 3,
5 or 7 configured nodes, a full lying minority and ONE honest node 257 blocks behind (321 for
a payment with the default expiry), a restored device that makes no statement and waits out
the whole embargo pays twice (`rw5_demo_the_restore_embargo_holds_up_to_exactly_256_blocks_…`).
An honest node that is syncing answers for every height it passes and nothing in the answer
says so. There is no light client: nothing in the wallet can do better.

**What to tell the user**, on the restore screen: *"Payments made from another copy of this
wallet may still be in flight and are not shown here."* **Check.** That sentence (or its
translation) is on the restore screen and on first use of a phrase on a new device; the
documentation of the product does not call the embargo a guarantee.

### 6. Every bound is a number of blocks on a chain without a block time

The embargo (128–384), a lock after a lost submit (64), the life of a spend (64 / 128). A
clock in the wallet cannot replace any of them: the earlier transaction stays valid in BLOCKS
however much time passes, so a wallet that ends an embargo after a wall-clock interval is
unsound on exactly the idle chain where the interval would help. What would bound them in
time is a consensus change — blocks at a guaranteed cadence ("heartbeat" blocks) or an expiry
checked against the block timestamp.

**Check.** As obligation 3; and no client setting, flag or remote configuration ends an
embargo or a lock by time.

### 7. What a majority of the configured nodes says is believed

* If more than a minority of the configured nodes lie together, everything "confirmed" is
  theirs.
* One operator behind several host names is several nodes to the wallet.
* A second LIVE device on the same phrase has no locks of the first: the same payment made on
  both from different notes is paid twice. (A second device made from the phrase starts under
  the embargo like a restore; once that has ended it is a live device.)

**What to tell the user.** In the node settings: who operates each configured node. On adding
a device: that the two devices do not see each other's pending payments. **Check.** Both texts
exist; the product does not describe a balance as "verified by the network" or the pool's
privacy as audited, proven or guaranteed (spec §6).

## Open decision (the owner's, not the core's)

The embargo of 128–384 blocks is, at the present block rate, 11 to 32 days, and without an
upper bound on an idle chain. The options:

1. **Keep it.** New wallets are unaffected (obligation 1); restores wait, or the user confirms
   the statement. No code change.
2. **Make the longest expiry smaller**, so that the embargo shrinks with it: the embargo IS the
   longest expiry a builder accepts (`MAX_EXPIRY_OFFSET`, 128). With 64 the embargo is 64–320
   blocks and a spend can never live longer than 64 blocks; with 32, 32–288. The 256 blocks a
   silent node adds are the lag margin of limit 5, a separate number: lowering it shortens the
   worst case and weakens the margin. A wallet-only change (two constants), no consensus rule.
3. **Wait for consensus heartbeat blocks** (or an expiry by block timestamp): only that turns
   any of these block counts into a duration. A consensus change, outside this crate.
