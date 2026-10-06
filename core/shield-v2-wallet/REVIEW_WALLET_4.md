# REVIEW_WALLET_4 — fourth independent review: quorum from the configured set, expiry from the confirmed height, build-and-lock, own outputs from the record, the node-local ciphertext hash

Reviewed: `fix/shield-v2-wallet-settlement-2` @ `e229cde` — the rework `dd02c86..e229cde` of
`core/shield-v2-wallet` (`store.rs`, `tx.rs`, `select.rs` in full), `core/shield-v2-wasm/src/api.rs`,
the node side it relies on (`core/storage/src/shield_v2_store.rs`, `core/daemon/src/shield_v2.rs`,
`core/daemon/src/node.rs`: `shield_v2_stats`, `shield_v2_mark_accepted`,
`shield_v2_rebuild_ciphertext_acc`, the start-up path, `recover_from_history`),
`tests/settlement_properties.rs` in full, against spec §4.3, §5.4, §5.5 (W-14 … W-17) and
`NOTES.md` §5–§7, §11, §12. The reviewer wrote none of it. Date: 2026-10-06. Branch
`review/shield-v2-wallet-4`. **Nothing was fixed.** Every confirmed defect has a regression test
that fails on purpose (`tests/review_wallet_4.rs`).

Threat model and guarantees: as in REVIEW_WALLET_3 (a strict minority of the CONFIGURED nodes
lying arbitrarily and withholding transactions; hostile senders and payees; several devices on
one phrase; restores; migrations; crashes that lose the last returned state; an honest strict
majority of which some may be unreachable). G1 no double payment by the wallet's own behaviour;
G2 confirmed balance ≤ true balance at the confirmed height; G3 every pending transaction
settles and every owned unspent note becomes spendable in bounded time, nothing lost from view;
G4 a lying or unreachable minority causes bounded delay only.

## Verdict

**NOT READY: one High and two Medium defects in the core must be fixed first — a single lying
listing page can leave a wallet state that no call can ever load again, with a live payment's
lock inside it (RW4-5); a payee can hand over an address that makes the wallet "pay itself" a
note it loses at its next rescan (RW4-4); and the embargo after a restore, as the specification
words it, ends while an earlier transaction can still be mined (RW4-1) — and the property test
that is offered as the evidence for G1–G4 fails on the shipped code as soon as it is run on
other seeds than the sixty it ships with (RW4-6).**

What was reworked after review 3 is, in itself, sound: I could not make the new quorum rule
confirm anything a strict minority wanted or stop anything it disliked; the expiry is bounded by
the confirmed height everywhere; no exported function yields a submittable spend without the
locked state; own outputs credited from the pending record exist on the chain, once, at their
value; the node-local ciphertext hash has no honest-divergence path that I could find and does
not touch the state root or recovery (section 3). The API shape (`set_nodes`, `confirm_state`
without a quorum argument, `build_*` → `{ state, tx }`) can be coded against. What is not ready
is the state it leaves behind in three corner cases, and the evidence.

Conditions for a "READY" are in section 8, separated into core, UI and inherent limits.

| # | Severity | Violates | Finding | Where | Test |
|---|---|---|---|---|---|
| RW4-5 | **High** | G4, G3 (and G1 through the restore it forces) | When a rescan re-finds ONE input of a two-input pending entry at the leaf position the entry still records for the OTHER input, and the scan call ends before the other is found, the entry names one position twice. `scan` returns `Ok`, `to_json` writes it, and `from_json` — and every later `scan`, also after `fresh_for_rescan` — refuses the state for ever ("a pending transaction is malformed"). Through the wasm surface every call fails, `rescan_state` and `summary` included. One lying listing node does it with one page (forged entries in front, a cut between the two notes). What is left is `new_state`: a restore, without the lock | `store.rs:2255–2258` (`p.inputs[i] = leaf`), `1389` (`inputs_ok`), `2295–2300` (`scan` returns without validating), `1161–1177` (`fresh_for_rescan` carries it) | `rw4_f5_…` **FAILS**; property test, seed 203 |
| RW4-1 | Medium | G1 (residual of RW3-10 that the documents claim closed) | The embargo after a restore — "no payment until 128 blocks above the FIRST height confirmed after the restore" — is sufficient only if that first height is at or above the confirmed height the earlier copy built at. With an odd number of nodes two quorums can overlap in one node, the liar: honest node 1 + liar confirmed the build; honest node 2 (behind) + liar replaying a true old state give the restored device a lower first height. Default expiry: 65 blocks of honest lag suffice; maximum expiry (128, accepted by the builders): ONE block. The property test's client waits 128 **+ 2** (its `HONEST_LAG`), not what the specification says. Nothing in the core enforces any embargo | spec §5.5 "Locks are per device" (b); `NOTES.md` §6 item 7 (b); `settlement_properties.rs:969`; `tx.rs:63`, `774–776` (128 accepted) | `rw4_f1_…`, `rw4_f1b_…` **FAIL**; `rw4_sound_without_lag_…`, `rw4_demo_the_restore_embargo_…` pass |
| RW4-4 | Medium | G3 (permanent loss) | "Payment to self" is decided by `recipient.pk == own.pk` alone. An address with the payer's `pk` and the PAYEE's encryption key is accepted; the output is credited from the pending record (correctly: the note is the wallet's). Its ciphertext is for the payee's key, so once the entry is settled the stored note is the only copy of `(value, r)`: the next rescan or restore cannot find it. The amount is gone for good; no counter says so; the payee holds nothing | `tx.rs:659`; `store.rs:2136–2140`, `2229–2233` | `rw4_f4_…` **FAILS** |
| RW4-6 | Low | — (assurance) | `settlement_properties` passes on seeds 1–60 and **fails on the unmodified code at seed 71** (default steps) and at seed 58 with 700 steps: its lock invariant treats a lock migrated from format 1 as holding every attempt that ever shared its nullifier, also a dead one — a false positive of the model. With that one line corrected it fails at seed 203 for a real reason (RW4-5). CI runs the sixty seeds | `settlement_properties.rs:1322`, `1528` | section 5; the commands of section 7 |
| RW4-3 | Low | G2 | A state scanned with the viewing key alone (`export_scan_key(seed, false)`, the documented background-worker mode) reports notes that another device has spent — at a height the quorum has confirmed — as `confirmed` and `spendable`, and plans payments from them, until a page is applied with the full key. Nothing in `balances()` / `summary` says that the state is blind | `store.rs:1612–1632`, `2162–2186` | `rw4_f3_…` **FAILS** |
| RW4-2 | Low | G2 by configuration | `canonical_node_id` keeps its promise ("two spellings of one endpoint are one node") for host names, not for IP literals: `[::1]`, `[0:0:0:0:0:0:0:1]`, `[::0001]`, `[0::1]` are four nodes; `127.0.0.1`, `127.1`, `2130706433`, `0x7f.0.0.1`, `127.0.0.01` are five. One liar entered in three spellings beside two honest nodes confirms its own forgery | `store.rs:299–321` | `rw4_f2_…` **FAILS** |
| RW4-7 | Info | G1/G2 outside the model | `http://` origins are accepted as node ids. Whoever sits on the wallet's network path answers for EVERY `http` node at once — a majority by construction. `http://h` and `https://h` are two nodes (one machine, two votes) | `store.rs:288–294` | — (UI condition) |
| RW4-8 | Info | G3 (liveness, no attacker in the wallet) | Every bound is in BLOCKS, and this chain makes a block only when a transaction is pending (`daemon/src/main.rs:2507`), as fast as its miner interval (the daemon's default `block_time_ms` is 400; the production value was not read). Quiet chain: a lock after a failed submit (64 blocks) and the embargo (128) have no wall-clock bound. Busy chain: a spend must be mined within `64 − (tip − C)` blocks of the confirmed height it was built on, proving time included — 64 blocks are about 26 s at the default interval, and the anchor window caps any expiry at 128 blocks (≈ 51 s) | spec §4.3 item 5 (O-8), §5.5; `tx.rs:50`, `63` | `rw4_sound_usable_window_…`, `rw4_sound_a_spend_built_on_a_stale_…` (pass) |
| RW4-9 | Info | G3 (liveness) | A node reports the state of its CURRENT tip only, and only reports for one height form a quorum. Honest nodes that are not at the same height at the moment they are asked confirm nothing; with a lagging honest node the liar is the swing vote (it can delay, not forge) | `node.rs:5733–5762`; `store.rs:1898–1928` | `rw4_demo_availability_…` |
| RW4-10 | Info | G1 by client error | `revision` is a counter, not an identity: two tabs that build from revision r both hold "r + 1" with different locks, and `expect_revision` accepts either against the other's stored revision. Only a storage-side compare-and-swap against the revision the tab LOADED protects the lock | `store.rs:1450–1456`; `api.rs:99–106` | `rw4_demo_two_different_states_…` |
| RW4-11 | Info | G3 | The wallet's own `shield_v2` below `min_note_value` is a stranger's dust to it (no record, spends no note): counted, not stored | `tx.rs:570–596`; `store.rs:2234–2238` | `rw4_demo_a_shield_to_ones_own_address_…` |
| RW4-12 | Info | G3 (deployment) | A node on a build before `dec53b4` reports no `ciphertext_acc`; the wasm surface drops its report as `malformed`. Until every configured node runs the new build (and has rebuilt its side record at start-up), fewer votes are available than nodes are configured | `api.rs:680–696`; `node.rs:1106–1118` | — |

Tests added: 19 in `tests/review_wallet_4.rs`. **6 fail on purpose**, 13 pass.

---

## 1. Findings

### RW4-5 (High; G4, G3) — one page from a lying node, and the state can never be read again

`scan`, when it stores a note whose commitment is an input of a pending entry, writes the note's
new leaf position into the entry (`store.rs:2255–2258`):

```rust
for p in self.pending.iter_mut() {
    if let Some(i) = p.input_cms.iter().position(|c| c.0 == out.cm) {
        p.inputs[i] = leaf;
    }
}
```

The other input keeps the position it had in the listing the entry was built on. `validate`
requires `inputs[0] != inputs[1]` (`store.rs:1389`). Honest listings never move a leaf, so on an
honest rescan each note comes back where it was. On a listing with forged transactions in front
(every real leaf `2k` further — lie no. 12 of the property test) the lower note of the pair can
land exactly on the stale position of the higher one. If the scan call ends before the higher
note is re-found — a page boundary, a truncated page, or its ciphertext blanked so that it is not
found at all — the state `scan` returns holds an entry with `inputs: [p, p]`.

`scan` validates the state it is GIVEN (`store.rs:2056`), not the state it returns. `to_json`
does not validate. So the state is written, and from then on:

```
two-input payment pending (inputs at leaves [5, 1]); one page from a lying node with every leaf
shifted by 4 and cut after block 3: scan ok; the entry now names leaves [5, 5]; from_json of the
state scan returned: Err("wallet state: a pending transaction is malformed"); the next honest
page: Err("wallet state: a pending transaction is malformed"); fresh_for_rescan + an honest
listing from the start: Err("wallet state: a pending transaction is malformed"); the transaction
is still valid until block 70
```

(`rw4_f5_…`, deterministic; confirmed inputs, default expiry, no `allow_unverified`.) In the wasm
surface every call that takes a state starts with `from_json` (`api.rs:141–143`): `scan`,
`confirm_state`, `resolve_pending`, `rescan_state`, `summary`, `pending` all fail with `state:`.
The documented answer to a `state:` error does not exist; what a client can do is `new_state`.
That is a restore from the phrase: the lock is gone while the transaction it stood for is out
there, withheld or not (RW3-10, and RW4-1 for what the embargo is worth).

*Who can do it.* One listing node, once, at a moment when the wallet reads a listing from the
start with a two-input transaction pending: after `listing_refuted` or a `listing:` error (the
client is told to rescan "against another node" — which, with two liars of five, is the second
liar), after a migration from format 1, 2 or 3 (every migrated state is empty and rescans), after
`rescan_state` to raise the cap or lower the minimum. The node does not need to know which notes
the inputs are — a sender that colludes with it knows the leaves of the notes it sent, and
chance is enough: the property test's random adversary hit it at seed 203 (of 700) and again in
the longer runs. There it was the mirror image: a payment built with `allow_unverified` on a
lying listing recorded the LIAR's positions (`[32, 30]`), and the honest rescan that followed
found one note at leaf 32 while the entry still named 32 for the other. So an honest listing is
not safe either once a position in an entry came from a lying one.

*Why it is High.* G4 promises that a lying minority causes delay only. Here it destroys the
state — notes, checkpoints, the pending list — permanently and silently (the call that did it
returned `Ok`), and the only recovery drops the one thing the three earlier reviews were about:
the lock on a live transaction.

*Direction (not done).* The stale position has no use once the lock is held by commitment: do
not require distinct `inputs` where `input_cms` is present (or clear the positions in
`fresh_for_rescan` and treat them as "not found yet"); and make `scan` — every call that
returns a state — validate what it returns, so that a state the core will not read is never
handed out. A recovery path for a stored state that fails validation (at least: extract its
pending entries into a fresh state) would turn any future bug of this kind into a delay.

### RW4-1 (Medium; G1) — the embargo after a restore is measured from the wrong height

Spec §5.5 (W-17) and `NOTES.md` §6 item 7: a restored device must "**not offer a payment until a
height at least 128 blocks above the first height it confirmed after the restore is confirmed** —
every transaction any earlier copy built has then been mined or can never be".

The earlier copy's transaction expires at most at `C_build + 128`. The sentence is therefore true
iff `C_first ≥ C_build`. Both are heights at which a quorum reported; an honest node's height
only grows; so it holds whenever the two quorums share an HONEST node. Two strict majorities of
`n` share at least `2q − n` nodes: **2 for even n, 1 for odd n.** With n = 3, 5, 7 — the sizes
anyone will configure — that one node can be the liar:

* device 1: listing to the tip `T`; honest node 1 and the liar (truthfully) report `T` → `C_build = T`;
* the restored device: honest node 2 is behind, at `T − d` (restarted, re-syncing, partitioned);
  the listing comes from the liar and ends at `T − d`; node 2 reports `T − d`; the liar replays the
  TRUE state of `T − d` → `C_first = T − d`. The call shows no dissent, nothing refuted, nothing
  ahead, and `quorum_tip = T − d`: none of the four documented rules asks the client to do anything.

The embargo then ends at confirmed height `T − d + 128`, the earlier transaction lives until
`T + 64` (default) or `T + 128` (the maximum `SpendOptions::expiry_height` accepts):

```
rw4-f1:  device 1 built at confirmed height 110, expiry 174; the restored device first confirmed
         height 40 (honest node 2 was 70 blocks behind), so its documented embargo ended at
         confirmed height 168; t1 still minable then: true; t1 mined in the same block as the
         second payment: true; the payee holds 8000000000 quanta
rw4-f1b: device 1 built at confirmed height 41, expiry 169; … (honest node 2 was 1 blocks
         behind) … embargo ended at confirmed height 168; … the payee holds 8000000000 quanta
```

`rw4_sound_without_lag_…` is the control (no lag: sufficient, also for the maximum expiry).

Two more facts belong here:

* **The property test does not test the documented rule.** Its client sets
  `Embargo::Until(h + EXPIRY_BOUND + HONEST_LAG)` (`settlement_properties.rs:969`) — 130 blocks,
  in a world where honest nodes are never more than 2 behind. The Resolution's sentence "the
  property test's client follows that rule and the test asserts that it is sufficient" is about
  another rule than the one in the specification. (With the constant set to the documented 128
  the sixty shipped seeds still pass: the test cannot tell the two apart.)
* **It is enforced nowhere.** `WalletState::new` + `set_nodes` + one confirmed height builds a
  spend (`rw4_demo_the_restore_embargo_is_documentation_only`). Three clients each have to
  implement it, and there is nothing in the state that says "restored at height h".

*Direction (not done).* (a) Cap what a transfer or unshield may ask for at the default 64 (there
is no reason for a client to ask for more, and spec §5.8 wants one offset): the documented
embargo then has 64 blocks of margin instead of none. (b) Measure the embargo from the highest
height the wallet has grounds to believe — at least the highest `quorum_tip` seen so far, and the
highest height ANY configured node reported at the first confirmation, capped (a liar must not
be able to push it out without bound) — and say in the specification that it is a margin against
lag, not a proof. (c) Put it in the core: a state created by `new_state` records its first
confirmed height, and `build_*` refuses (`restored_recently:`) below that + the bound unless the
caller passes an explicit override. One implementation instead of three.

### RW4-4 (Medium; G3) — a payee's address with the payer's own `pk`

`assemble_transfer` sets `payment_to_self = req.recipient.pk == own.pk` (`tx.rs:659`). A shielded
address is `(pk, ek)`. A payee who knows the payer's address — every earlier payee does — can
hand over `(payer's pk, payee's ek)`: it decodes, its fingerprint is nobody's the payer knows, and
the builder records the payment output as the wallet's own (`own_payment`, with `r`).

Up to the settlement everything is correct, and G2 holds: the note is on the chain, it IS the
wallet's (its `pk`), the record opens it, it is credited once. The "payee" can decrypt it and
cannot spend it. But its ciphertext was made for the payee's key. `resolve` removes the entry;
the stored note is now the only copy of `(value, r)`:

```
paid 4 XRGE to an address with the payer's own pk and the payee's encryption key: settled as
mined, confirmed 9000000000 quanta; after a rescan against honest nodes: confirmed 5000000000 +
unverified 0 quanta, below_minimum { 0 }, over_capacity { 0 }; the payee holds 0
```

A rescan is routine (it is the documented answer to three different signals), and a restore is
what the phrase is for. The amount of the payment is unspendable for ever after either (short of
an old copy of the state); the interface said "paid"; the payee was not. The attacker gains nothing but the damage — and a
payer who then pays again.

*Direction.* A payment is "to self" iff the WHOLE address is the wallet's (`pk` and `ek`);
refuse a recipient whose `pk` is the wallet's and whose `ek` is not.

### RW4-6 (Low; assurance) — the property test passes on its sixty seeds

`RUNS = 60`, `STEPS = 280` (`settlement_properties.rs:1528`). On the unmodified branch:

| Run | Result |
|---|---|
| seeds 1–60 × 280 steps (as shipped) | passes, 24.8 s |
| seeds 1–700 × 280 steps | **fails at seed 71**: "a note a pending transaction spends is not locked (at leaf 31)" |
| seeds 1–250 × 700 steps | **fails at seed 58**: the same assertion |

Seed 71, traced: a two-input attempt from notes 13 and 31 had been settled as expired (truly:
expiry 2882, chain at 2982). A later attempt spends notes 13 and 50. A migration through format
1 turns it into two `legacy` locks, one per note, each knowing one nullifier. The invariant at
line 1322 counts a legacy lock as "holding" every attempt that shares its nullifier — also the
dead one — and then demands that note 31 be locked. The wallet is right; the model is wrong.
With that line corrected (`self.chain.can_still_be_mined(&a.tx) &&` for a legacy entry):

| Run (model line corrected, core unmodified) | Result |
|---|---|
| seeds 1–700 × 280 steps | **fails at seed 203**: "scan failed with wallet state: a pending transaction is malformed" — RW4-5 |
| seeds 1–250 × 700 steps | fails at seed 203 as well |

and with RW4-5 worked around in a scratch copy of `validate` (distinct positions not required
where the lock is held by commitment):

| Run (both, scratch only) | Result |
|---|---|
| seeds 1–700 × 280 steps | passes, 300 s: 5,453 payments, 849 restores, 3,420 / 1,107 / 631 settled mined / expired / superseded, at most 7 rounds to settle |
| seeds 1–250 × 700 steps | passes, 497 s |

So the test does find a High defect — 143 seeds beyond where it stops. Neither scratch change is
committed. What this says: the test is a strong instrument; the range it ships with ends eleven
seeds before its own first failure; and "26 of 26 mutations caught" was measured on a range in
which the unmutated code's failure does not occur. A range this narrow should not be the
evidence for a guarantee.

### RW4-3 (Low; G2) — a viewing-key state shows spent notes as money

`rw4_f3_…`: a state scanned with `incoming_viewing_key()`; another device on the phrase spends
the 10 XRGE note; the worker's state follows and all three nodes confirm it at the tip:

```
viewing-key state, confirmed at the tip 5: confirmed 16000000000 / spendable 16000000000 quanta;
the chain holds 6000000000; a payment of 8 XRGE is planned from the spent note: true
```

The scan remembers the nullifier (F-3) and applies it when a page — an empty one will do — is
scanned with the full key. Until then `balances()`, `summary` and `select_inputs` are wrong by
exactly the spent notes, on confirmed data. A payment built from such a state is dead on arrival
(the nullifier is spent) and expires cleanly; no funds move. *Direction:* report it — a
`blind_notes` count in `summary`, and `confirmed` / `spendable` that exclude notes without a
nullifier (or a separate "received, spends unknown" figure).

### RW4-2 (Low; G2 by configuration) — IP literals

```
one IPv6 endpoint in four spellings: Some(4) node(s); one IPv4 endpoint in five spellings:
Some(5) node(s); one IPv4-mapped endpoint in two spellings: Some(2) node(s)
five ids = two honest nodes + one liar in three spellings: configured 5, quorum 3, agreeing 3,
confirmed balance 60000000000 (the chain holds 10000000000)
```

Host names are handled (case, default port, path, one trailing dot, userinfo and non-ASCII
refused, percent-encoding refused, `:80` on https kept as a different origin — all tried, all
right). A bracketed IPv6 literal is lower-cased and nothing else; a dotted or numeric host is a
"name". Every URL parser a client will fetch with maps those spellings to one address.
*Direction:* parse literals (`std::net::Ipv6Addr` / `Ipv4Addr`, and refuse the numeric, hex,
octal and short IPv4 forms) and write the canonical text; or refuse IP literals outright.

### RW4-7 … RW4-12 (Info)

* **RW4-7, `http`.** The model's adversary is a minority of NODES. A network attacker is not in
  it, and for `http://` ids it is every node at once. A client should refuse `http` except for
  loopback, and refuse two ids with one host (`http://h`, `https://h`, `https://h:8443` are one
  operator with three votes).
* **RW4-8, blocks are not time.** Measured (`rw4_sound_usable_window_…`): with the tip `d` blocks
  above the confirmed height the transaction is accepted in the next block iff `d ≤ 63` (default
  expiry) or `d ≤ 127` (maximum; the anchor `R(C)` leaves the window at the same block). The
  chain produces a block per pending transaction batch, at most one per miner interval (400 ms by
  default; the production value was not read). On a quiet chain 64 blocks take as long as other
  people's transactions take to fill them — there is no upper bound: a client that lost a submit
  must be able to **re-submit the same envelope** (always safe — it is the same transaction)
  instead of waiting for the expiry, so it has to keep the envelope next to the state. On a busy chain — or one that somebody keeps busy at one cheap transaction per
  block — 64 blocks are under half a minute, proving included (3 s native on this host, 6.7 s in
  WebAssembly in the research measurement, unknown on a phone): spends built with the default
  expiry can be dead on arrival, repeatedly. The wallet's behaviour is then clean
  (`rw4_sound_a_spend_built_on_a_stale_…`: refused by the node, settled `expired` at the next
  state check, one payment after the retry), but nothing gets paid. The window is a consensus
  figure (O-8); it should be revisited with the block interval in hand.
* **RW4-9, reports of the tip only.** `confirm_state` needs `quorum` reports for ONE height.
  Honest nodes one block apart, each asked once, confirm nothing; the client has to ask again
  and accumulate (which `confirm_state` supports: a node may report several heights). A
  `report?height=h` for the last few accepted blocks on the node would remove the dependency on
  timing, and with it the liar's swing vote in RW4-1.
* **RW4-10, RW4-11, RW4-12:** as in the table; each is a client obligation in section 8.

---

## 2. The eight areas

### 2.1 The quorum rule

* **The configured set cannot be changed by anything a node says.** `set_nodes` is the only
  writer; `confirm_state` reads `self.nodes`; a report under an unconfigured or non-canonical id
  is counted in `not_configured` and nowhere else; `from_json` refuses a stored set that is not
  canonical, sorted and distinct. A crafted state blob can of course contain any set — the state
  must be authenticated at rest (`NOTES.md` §6 item 3).
* **Canonicalisation**, tried (`rw4_sound_canonical_node_id_…`: 6 spellings of one origin, 27
  refusals): userinfo (`a@h`, `h\@evil`) refused; IDN refused unless written as `xn--`;
  percent-encoding refused (upper and lower case); `HTTPS://NODE.EXAMPLE./` and
  `https://node.example:443/a/b?x=1#f` → one id; `:443` on https and `:80` on http dropped,
  `:80` on https kept (a different origin, as it should be); `:0443` → dropped; `host..`, an
  empty port, white space, an unclosed or zoned IPv6 literal refused. **Not handled: IP
  literals (RW4-2). `http` and `https` of one host, and two ports of one host, are different
  nodes (RW4-7).**
* **n = 2**: quorum 2. One unreachable node: nothing is confirmed, nothing can be built; one
  contradicting node sets `listing_refuted` although the listing may be the chain's
  (`n − quorum = 0`). Two nodes tolerate no fault of any kind. **n = 4**: quorum 3; one liar and
  one unreachable node: nothing is confirmed (two honest answers). Four nodes tolerate exactly
  what three do. `rw4_demo_availability_…`. Recommend odd n ≥ 3 and say so in the documents —
  and note that RW4-1's overlap argument is the one place where EVEN n is the stronger choice.
* **A minority cannot trigger `listing_refuted` or `listing_ahead`, or move `quorum_tip`,** while
  every honest node answers for the tip: n = 2 … 9, the largest strict minority, eight behaviours
  (`rw4_sound_a_strict_minority_…`, 64 calls). `dissenting > n − quorum` cannot be reached by
  `n − quorum` liars; the quorum-th highest claim is at least the lowest honest claim and at most
  the highest. With honest nodes missing or behind, `quorum_tip` drops to the lagging height and
  an honest listing at the tip is "ahead" until they catch up — delay, bounded by the honest
  nodes, and the reason the client must not rescan on the first `listing_ahead`.
* **Evicted checkpoints.** 300 pool-changing heights without a state check: reports for a height
  whose state was dropped (true or forged) are `not_comparable` — no match, no dissent, no
  refutation; a confirmed height whose state was dropped refuses a build (`state_unconfirmed`)
  until the tip is confirmed (`rw4_sound_reports_for_heights_whose_state_was_evicted_…`).
  Nothing confirms on a height the wallet cannot compare.

### 2.2 Expiry from the confirmed height

* A minority cannot raise `C` (2.1) — and with it cannot lengthen an expiry: `spend_base`
  returns `confirmed_height` and nothing else; `mark_pending` re-checks; `SpendOptions` carries
  no height. A caller can ask for at most `C + 128`.
* Holding `C` down: a lying listing node can serve a short listing; honest reports for the tip
  are then not comparable and `C` stays. The fourth documented rule (list elsewhere when
  `C < quorum_tip`) ends that when the honest nodes are at the tip. A spend built meanwhile is
  dead on arrival if the tip is 64 or more ahead; it is refused by the node, stays locked on the
  stale state, is not released by a scanned height, and settles `expired` at the first state
  check at the tip — no lock leaks, the retry pays once (`rw4_sound_a_spend_built_on_a_stale_…`).
* Anchors: the anchor is `R(C)`, accepted through block `C + 128` (spec §4.3 item 5), so it never
  leaves the window before the expiry does. The usable window and what a fast chain does to it:
  RW4-8.

### 2.3 Build-and-lock: the crash matrix

| Event | What happens | Verdict |
|---|---|---|
| crash before the returned state is persisted | the transaction existed only in memory; nothing was submitted; no lock | fine — **iff** the client really submits only after the write is durable |
| crash after the persist, before the submit | inputs locked until `C ≥ expiry` (≤ 64 blocks by default); `abandon_unsubmitted` releases nothing | bounded in blocks (RW4-8); the client cannot re-submit unless it kept the envelope |
| the persist "succeeded" and was not durable (a relaxed-durability IndexedDB commit lost in a power cut; evicted storage) | the device is a restored device without knowing it: no lock, no embargo | **UI obligation**: strict durability for this write; nothing in the core can see it |
| two tabs, stale revisions | both results carry revision r + 1 (RW4-10); `expect_revision` cannot tell them apart; the storage CAS against the LOADED revision can | UI obligation |
| submitted, then the state is lost | RW3-10 / RW4-1: the embargo is documentation, and as documented it is short | **defect (RW4-1)** |
| a second submit of the same envelope | the same transaction: harmless | recommend it as the retry |

No exported function returns a proven transfer or unshield without the state: checked the 21
wasm exports and every `pub` item of the crate. `UnprovenTx::prove` is public but an `UnprovenTx`
of a spend can only be obtained through the `test-vectors` feature (`tx::deterministic`), which
the wasm crate enables as a DEV-dependency only (resolver 2: not in a normal build).
`WalletState::mark_pending` being public gives a caller a way to lock, not a way to build.
`BuiltTx` / `LockedTx` fields are public: a Rust client can drop `state` and send `tx` — no type
can prevent that.

### 2.4 Own outputs from the pending record

* The record never credits a note that is not on the confirmed chain: the commitment is looked
  up in the listing, recomputed from `(value, r)` with `rho` from the LISTED transaction's
  nullifiers, and confirmed with the height like any note. A listing that blanks the
  ciphertexts, or lists the transaction twice, is not confirmed
  (`rw4_sound_own_outputs_from_the_record_…`). Without the recomputation (mutation D1) the
  record would be credited — unverified, never confirmable — under the `rho` of a listing whose
  nullifiers were replaced; `rw2_f2_…` and `rw3_f2_…` pin that.
* The restore rule ("an output for this wallet in a transaction that spends this wallet's note")
  cannot be ridden by a sender: it needs one of the wallet's nullifiers, which needs `nk`. Dust
  and cap-filling notes from a stranger in the same BLOCK as the wallet's own transaction stay
  out, with and without a pending record (`rw4_sound_a_hostile_sender_cannot_ride_…`).
* **What it does break: RW4-4** — the one case in which the record is the only way to the note.

### 2.5 `ciphertext_acc`

Read for a way in which two honest nodes can report different values, or a value for the wrong
height. Found none:

* one write path: every block from activation goes through `shield_v2_prepare_block`
  (`node.rs:5070`, import and producer alike), which builds the store WITH the block's
  ciphertexts; the side record is in the same `apply_batch` as the pool record
  (`shield_v2_store.rs:212–255`); the three other `Pool::open_or_init` sites never append leaves;
* the record is bound to the leaf count it covers (`current_ciphertext_acc`): a commit that
  appended leaves without ciphertexts leaves it behind and the node reports `null`, never a
  stale value;
* rollback: `snapshot` / `restore` carry both node-local records; `clear` removes them, and the
  re-import of `recover_from_history` derives the hash again block by block from zero;
* the start-up rebuild walks the stored blocks from activation in block, transaction and output
  order — the order of the incremental path — and checks every commitment against the stored
  leaf; any mismatch (a missing block included) writes nothing;
* the pre-activation strip runs below activation only; the rebuild starts at activation;
* consensus: neither key is read by `state_root_section`, `shield_v2_store_in_sync` or
  `recover_from_history`; on a network without a scheduled activation nothing is written (the
  store must stay empty there, `node.rs:4604`: `mark_accepted` returns before writing without a
  pool record, and the rebuild is not called);
* the daemon test covers a node whose side record is unreadable (garbage, which takes the same
  branch as absent) across two more pool blocks and an empty one: block hash, state root and pool
  record identical. Re-run here: 11 of 11 `node::shield_v2_daemon_tests` and 4 of 4
  `node::shield_v2_wallet_interop_tests` pass (section 7).

What it costs: an honest node whose record is missing has no vote until it is RESTARTED (the
rebuild runs at start-up only), and a node on an older build has none at all (RW4-12). Both are
silent on the node; the wallet sees `malformed`.

### 2.6 State format 4, migrations, pruning, the cap

* `to_json` ⊆ `from_json` for everything the property test produced on 700 + 250 runs — except
  RW4-5.
* 1 → 4, 2 → 4, 3 → 4: every lock kept, statuses reset, no node configured, expiry as
  documented. A legacy lock without a nullifier (a format-1 note that had none) can only expire;
  format 1 was never released.
* Pruning: `prune` drops only notes whose spend is confirmed 256 blocks deep; `drop_old_spent`
  drops by listing order but never an input of a pending entry, and a state built on a lying
  listing is thrown away as a whole. A pruned note is never needed for a path (a spent note has
  none) or for settlement (entries carry their own nullifiers and commitments).
* The cap is exact (`rw3_f4b_…` pins it; the property test does not — mutation D3).
* `min_note_value` versus own outputs: change and payment-to-self are covered; the wallet's own
  shield is not (RW4-11).

### 2.7 The property test

Section 5.

### 2.8 The client loop, as documented — and as it has to be

The documents (`NOTES.md` §6 items 3, 4, 7; spec §5.4, §5.5) give rules, not an algorithm, and
leave open: how often "ask again" is; which reports to hand in; what a `state:` error means; in
which order nodes are tried; what the embargo is measured from. The loop below is what I checked
the core against. `S` is the stored state with its revision, `N` the configured nodes, `L` the
node listed from, `bad` the nodes whose listing was refuted in this session.

```
round():
  1. page from L at S.next_height → scan → persist (compare-and-swap on the LOADED revision);
     repeat until at_tip or a page budget. On `listing:` → RESCAN(L).
  2. ask EVERY node of N for /stats at the same time; take `report`; drop a report that is
     null, malformed or without ciphertext_acc; label each with the CONFIGURED origin.
     Keep the reports of the last few rounds too (one per node and height; at most 1,024).
  3. confirm_state(S, reports) → persist.
       listing_refuted                      → RESCAN(L)
       listing_ahead                        → ahead += 1; if ahead ≥ 3 rounds with FRESH
                                              reports and quorum_tip did not reach the
                                              listing's last pool block → RESCAN(L); else wait
       matched, C < quorum_tip, at_tip      → L := next node not in `bad` (no rescan)
       no match, not refuted                → wait and repeat (nodes at different heights,
                                              or fewer than a quorum reachable): NOTHING else
  4. resolve_pending → persist → tell the user mined / superseded / expired.
  5. a payment is offered only if: this round matched at the scanned tip (C = scanned height),
     no embargo is running, and the payment is new or its last attempt came back superseded /
     expired in step 4.
       build_*(S, loaded revision) → persist {state, envelope} DURABLY → submit the envelope.
       A failed or unanswered submit: submit THE SAME envelope again (to any node), never build
       again before step 4 has settled the entry.

RESCAN(L):  bad += L; S := rescan_state(S) → persist; L := next node not in `bad`
            (if every node is in `bad`: stop and tell the user — more than a minority lies,
            or RW4-5 has happened)

after new_state on a phrase that may have been used before (restore, second device):
  embargo until C ≥ H + 128, H = max(first confirmed height, highest height any configured
  node has reported so far — bounded), and until then show "payments from another copy of
  this wallet may still be in flight". (The documents say: first confirmed height. RW4-1.)
```

Is it sufficient? For G2 and for the settlement rules: yes — that is what the property test's
client does, and with the two scratch corrections it settles within 7 rounds on 950 runs. For
G1 it is sufficient on one device with durable writes; across a restore it is RW4-1. For G3/G4
it is sufficient except RW4-5, which no client rule can avoid (the client cannot know which
page will collide).

---

## 3. Checked and found sound

The quorum is a property of the state and of nothing handed to a call; a strict minority cannot
confirm, un-confirm, refute, or move `quorum_tip` (n = 2 … 9); reports under unconfigured ids,
duplicate reports and equivocation; reports for evicted or unscanned heights; `C` never above a
height an honest node holds; the expiry bound from `C` in the builder and again in
`mark_pending`; anchor = `R(C)` inside the window for the whole validity; a dead-on-arrival
spend expires cleanly; no exported path to a spend without its lock; the lock is by commitment
and survives rescans and migrations (where the state survives: RW4-5); `abandon_unsubmitted`
and `note_rejection` release nothing; own outputs from the record: existence, value, once; the
restore rule for own change cannot be used by a sender; several transactions per block are one
checkpoint and read back (`rw4_sound_several_transactions_in_one_block_…`); pruning; the cap as
a parameter; migrations keep every lock; the node-local hash: one write path, same batch,
rollback, rebuild order, absent from every consensus read; the accepted-report record.

## 4. Outside the model, plainly

* A majority of the configured nodes lying, or one operator behind most of them: everything
  "confirmed" is theirs. Unchanged, stated in the documents.
* A network attacker against `http` nodes (RW4-7).
* A proposer that makes honest nodes accept different blocks at one height; a reorganisation
  below the confirmed height.
* A tampered state blob.

## 5. The property test, and sixteen mutations

**Is the oracle independent?** Largely. `RefChain` has its own nullifier set, running hashes
(tags written out), anchor window, expiry rule and books; it reads bodies at byte offsets; it
never scans or decrypts; it is cross-checked against the stage-1 `Pool` after every block. It
shares with the code under test: (a) the Poseidon tree (`SparseTree`) and the nullifier / `rho`
derivations of the stage-1 crate — the chain's primitives, acceptable; (b) **the wallet's own
assembly to MAKE transactions, and the `OutputRecord` it returns as the source of the books'
values** — so the books say whatever the builder says it put into the outputs, and no proof is
made: value conservation is outside the oracle (mutation F1).

**What its world does not contain** (each checked against the list in the task):

* honest nodes more than 2 blocks behind (`HONEST_LAG`) — RW4-1 is invisible; and its client
  waits 130 blocks, not the documented 128;
* more than one transaction per block (mutation E1); more than ~100 pool-changing heights per
  run, so no evicted checkpoint (A4) and nothing near `MAX_SPENT_RETAINED`;
* a scan with the viewing key (RW4-3); a hostile PAYEE (RW4-4 — its hostile party only sends);
  a shield made by the wallet itself (RW4-11); two configured nodes;
* a client that asks for an expiry outside the bound (B2), tries to spend a locked note (C1), or
  compares revisions (C2);
* any seed above 60 (RW4-6).

**Mutations.** Each applied alone to `store.rs` / `tx.rs` / `select.rs`, then
`cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --test settlement_properties`
(the shipped sixty seeds); where the property test did not notice, the whole wallet suite
(`--no-fail-fast`, the six on-purpose failures of this review aside). All reverted. None is in
the Resolution's table.

| # | Area | Mutation | Property test (the shipped 60 seeds) | The rest of the wallet suite |
|---|---|---|---|---|
| A1 | 1 | `listing_refuted` already at `dissenting ≥ n − quorum`: a full lying minority "refutes" a true listing | **caught**: "not settled after 10 rounds with an honest majority reachable" (seed 36) | |
| A2 | 1 | `listing_ahead` when the listing's last pool block is AT the quorum's tip (`≥`) | **caught**: "not settled after 18 rounds …" (seed 1) | |
| A3 | 1 | a report for a height above the scanned height is compared with the wallet's latest state | **caught**: the next scan refuses its own state, "the confirmed height is above the scanned height" (seed 1) | |
| A4 | 1, 6 | a report for a height older than the kept history is compared with the OLDEST kept state | **NOT caught** | caught only by the new `rw4_sound_reports_for_heights_whose_state_was_evicted_…`; before this review by no test |
| B1 | 2 | `resolve` settles a sighting only strictly BELOW the confirmed height (`<`) | **NOT caught** | 14 tests (`rw2_f1_…`, `rw2_f3_…`, `rw3_f2_…`, …) |
| B2 | 2 | an expiry up to the confirmed height + 1,128 is accepted (builder and `mark_pending`) | **NOT caught** | `builder_refusals`, `rw3_f7b_…`, `rw1_f7_…` |
| B3 | 2 | `spend_base` does not require the confirmed root | **caught**: "the anchor is the chain's root at the confirmed height" (seed 1) | |
| C1 | 3 | neither `spend_input_with` nor `mark_pending` checks the lock (only coin selection avoids locked notes) | **NOT caught** | `rw3_f5_…`, `rw2_f1_…`, `rw2_i3_…`, `rw1_f7_…`, `selection_and_merge` |
| C2 | 3 | `mark_pending` does not raise the revision | **NOT caught** | `rw2_i3_…`, `rw3_f5_…`, `shield_transfer_unshield_with_real_proofs`, `rw1_sound_every_byte_…`, `rw4_demo_two_different_states_…` |
| D1 | 4 | an own output is taken from the pending record WITHOUT recomputing its commitment | **NOT caught** | `rw2_f2_swapped_nullifiers_…`, `rw3_f2_a_blanked_change_…` |
| D2 | 4 | every output for the wallet counts as its own (dust minimum and cap never apply) | **caught**: "the confirmed balance is not the true balance at the tip" (seed 1) | |
| D3 | 6 | the cap admits one note more (`>` for `≥`) | **NOT caught** | `rw3_f4b_…` |
| E1 | 6 | a second transaction at one height pushes a second checkpoint | **caught**: "to_json writes what from_json reads" — the state history is not in order | |
| F1 | 3 (`tx.rs`) | the change is computed without the fee | **NOT caught** | 29 tests (`vectors`, `wallet_flow`, `builder_refusals`, …) |
| F2 | `select.rs` | coin selection offers locked notes | **caught** — by a panic of the harness ("a selected payment could not be built: the note is an input of a pending transaction"), not by an invariant | |
| L1 | 4, 6 | a note's own nullifier in the listing does not mark it spent (only a pending entry does) | **caught**: "confirmed balance 30000000000 exceeds the true balance 27148646665 at height 568" (seed 1) | |

**8 of 16 caught by the property test; all 16 by the suite as it now stands; 15 of 16 by the
suite as it stood before this review.** Each miss, looked at as a possible hole in the code
rather than in the test:

* **A4** — no run of the property test scans more than about a hundred pool-changing heights, so
  no checkpoint is ever evicted; and no other test did it either. The real code is right
  (`rw4_sound_reports_…` passes on it). This was the one place where a wrong line would have
  shipped untested.
* **B1** — a sighting exactly AT the confirmed height is almost never the deciding case in the
  test's world: `drive_to_settlement` moves the chain past every expiry before the wallet looks,
  and the "mined in the last valid block" adversary is not followed by an immediate state check.
  The real code is right at the boundary (`≤`; the single-scenario tests pin it).
* **B2** — the test's client never asks for an expiry outside the bound, so the REFUSAL is never
  exercised; its invariant only sees expiries the builder produced.
* **C1** — the client builds only what coin selection offered. That the builder itself refuses a
  locked note is checked by `rw3_f5_…`, not by the model.
* **C2** — the test never compares revisions (it clones states). See RW4-10 for how thin the
  revision check is even when it works.
* **D1** — nothing in the test looks at an UNVERIFIED note that should not be there; the note
  the mutation credits (the change of a transaction whose listed nullifiers were replaced) can
  never be confirmed. Harmless to G2, and pinned by two single-scenario tests.
* **D3** — the test asserts that the cap does not refuse too early, not that it refuses in time.
* **F1** — the oracle's books are the builder's own `OutputRecord`s and no proof is made: a
  transaction that does not balance is "mined". The real prover would refuse it
  (`wallet_flow` with real proofs fails under F1).

None of the eight spots hides a defect in the unmutated code that I could find. The defects of
this review were found elsewhere: RW4-5 by running the test past seed 60, RW4-1 / RW4-4 / RW4-3 /
RW4-2 by reading, each in a part of the model's world listed above as missing.

## 6. Tests added (`tests/review_wallet_4.rs`)

| Test | Result |
|---|---|
| `rw4_f5_one_shifted_listing_page_makes_a_state_with_a_two_input_payment_pending_unloadable_for_good` | **FAILS** (RW4-5) |
| `rw4_f1_the_documented_restore_embargo_ends_while_an_earlier_default_expiry_transaction_is_still_minable` | **FAILS** (RW4-1) |
| `rw4_f1b_with_the_maximum_expiry_one_block_of_honest_lag_defeats_the_documented_embargo` | **FAILS** (RW4-1) |
| `rw4_f4_a_payee_address_with_the_payers_pk_strands_the_payment_at_the_next_rescan` | **FAILS** (RW4-4) |
| `rw4_f3_a_viewing_key_state_reports_a_spent_note_as_confirmed_and_spendable` | **FAILS** (RW4-3) |
| `rw4_f2_ip_literal_spellings_of_one_endpoint_are_counted_as_several_nodes` | **FAILS** (RW4-2) |
| `rw4_sound_without_lag_the_documented_embargo_is_sufficient` | passes |
| `rw4_demo_the_restore_embargo_is_documentation_only` | passes |
| `rw4_sound_a_spend_built_on_a_stale_confirmed_height_is_dead_on_arrival_and_expires_cleanly` | passes |
| `rw4_sound_usable_window_of_a_spend_when_the_confirmed_height_lags_the_tip` | passes |
| `rw4_demo_availability_of_two_and_four_configured_nodes` | passes |
| `rw4_sound_canonical_node_id_for_host_names_and_what_it_refuses` | passes |
| `rw4_sound_a_strict_minority_cannot_trigger_refuted_or_ahead_or_move_the_quorum_tip` | passes |
| `rw4_sound_several_transactions_in_one_block_are_one_checkpoint` | passes |
| `rw4_sound_reports_for_heights_whose_state_was_evicted_confirm_nothing_and_refute_nothing` | passes |
| `rw4_sound_own_outputs_from_the_record_are_credited_once_and_only_on_confirmed_data` | passes |
| `rw4_sound_a_hostile_sender_cannot_ride_the_own_output_rule_past_the_dust_minimum_or_the_cap` | passes |
| `rw4_demo_a_shield_to_ones_own_address_below_the_minimum_note_value_is_not_stored` | passes |
| `rw4_demo_two_different_states_carry_the_same_revision` | passes |

**The six failures are in CI's selection** (`.github/workflows/ci.yml:99`, the wallet step). That
step has no `--no-fail-fast`: while `review_wallet_4` fails, the targets after it in the
alphabet — `settlement_properties`, `vectors`, `wallet_flow` — do not run in CI. A fix turns each
of the six green without editing it: `rw4_f1*` and `rw4_f4` accept a core that refuses the
build. (`rw4_sound_without_lag_…` and `rw4_demo_the_restore_embargo_…` state today's behaviour
and will have to follow a fix that puts an embargo into the core.)

A note for whoever writes the next tests: `tests/common::Chain::block` applies the pool rules
only — NOT the node's expiry check (spec §3.6 check 7). A test that "mines after the expiry" with
it succeeds. `review_wallet_4.rs` has a `mine` helper that applies the check; the property
test's `RefChain` has its own.

## 7. Commands run

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running. (The tool moves a command to the background after ten minutes;
the long ones were waited for before the next was started.)

`PROP` = `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --test settlement_properties -- --nocapture`.

| Command | Result |
|---|---|
| `PROP`, unmodified (seeds 1–60 × 280 steps) | 1 passed, 24.8 s |
| `PROP`, `RUNS = 700` (scratch edit of the two constants only) | **fails, seed 71** (30 s) |
| `PROP`, `RUNS = 250`, `STEPS = 700` | **fails, seed 58** (121 s) |
| `PROP`, the client's embargo set to the documented 128 (without `+ HONEST_LAG`) | 1 passed (the sixty seeds do not tell the two apart) |
| `PROP`, seed 71 alone with trace output | the false positive of RW4-6 |
| `PROP`, the legacy-lock line of the model corrected, `RUNS = 700` | **fails, seed 203** (85 s): RW4-5 |
| the same, `RUNS = 250`, `STEPS = 700` | **fails, seed 203** (408 s) |
| `PROP`, seed 203 alone with trace output | the entry with `inputs: [32, 32]` |
| `PROP`, model line corrected AND RW4-5 worked around in `validate`, `RUNS = 700` | 1 passed, 300 s |
| the same, `RUNS = 250`, `STEPS = 700` | 1 passed, 497 s |
| `PROP`, once per mutation (16 runs) | section 5: 8 caught, 8 not |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors … --no-fail-fast -- --test-threads=1`, once per missed mutation (8 runs) | section 5: every one caught by another test |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1` (final tree) | **102 tests: 96 passed, 6 failed on purpose.** Wallet 95: unit 21, `review_wallet_1` 14, `review_wallet_2` 14, `review_wallet_3` 17, `review_wallet_4` 13 + **6 failed**, `settlement_properties` 1, `vectors` 3, `wallet_flow` 6. wasm 7: `api` 2, `review_wallet_1` 4, `review_wallet_3` 1. The 83 tests of the Resolution all pass |
| `cargo test … --test review_wallet_4 --no-fail-fast -- --test-threads=1` (final file) | 19 tests: 13 passed, 6 failed on purpose |
| `cargo tree -p quantum-vault-shield-v2-wasm -e normal,features -i quantum-vault-shield-v2-wallet` | `quantum-vault-shield-v2-wallet feature "default"` only: `test-vectors` is not in a normal build of the wasm crate |
| `cargo tree -p quantum-vault-daemon -e normal,build,features` | neither the wallet nor the wasm crate is in the daemon's normal or build graph |
| `cargo test -p quantum-vault-daemon … -- node::shield_v2_daemon_tests --test-threads=1` | 11 passed, 287 filtered out (`rw3_f2_the_ciphertext_hash_is_node_local_…`, `rw3_f6_…`, `state_root_is_byte_identical_before_activation`, `rollback_restores_the_pool_store_exactly` among them); the release build took 12 minutes |
| `cargo test -p quantum-vault-daemon … -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed, 294 filtered out (the wallet's ciphertext hash against the node's on every sync) |

The extended runs took about 24 minutes of test time in all, not the ten that were budgeted:
the first two configurations failed and each correction needed both runs again. Every scratch
edit (the two constants, the trace output, the model line, the workaround in `validate`, the
sixteen mutations) was reverted with `git checkout`; the tree that is committed differs from
`e229cde` by `tests/review_wallet_4.rs` and this file only.

`core/target/` was deleted afterwards.

## 8. Conditions for a "READY"

**Core (defects; each has a failing test that must pass):**

1. RW4-5: no call returns a state that `from_json` refuses; a rescan with a two-input entry
   pending survives any listing. `rw4_f5_…` passes; `settlement_properties` passes on seeds
   1–700 × 280 steps and 1–250 × 700 steps with its legacy-lock invariant corrected (RW4-6), and
   the seed range in CI is widened or randomised with the seed printed.
2. RW4-4: a recipient with the wallet's `pk` and another `ek` is refused. `rw4_f4_…` passes.
3. RW4-1: the embargo is (a) restated so that the two tests `rw4_f1_…`, `rw4_f1b_…` pass —
   maximum expiry of a spend 64, base height not the first confirmed height alone — and (b)
   enforced by the core or covered by a test in each client; the property test's client uses the
   rule as written and its world has honest nodes more than 64 blocks behind.
4. RW4-3: `summary` says when a state holds notes without a nullifier, and `rw4_f3_…` passes.
5. RW4-2: `rw4_f2_…` passes (canonical IP literals, or refusal).

**UI / client layer (obligations; each checkable by a test or a code inspection of the client):**

6. Node ids: `https` only (loopback excepted), one id per host, an odd number ≥ 3 of different
   operators; shown to the user; changed only by an explicit act.
7. The loop of section 2.8, including: reports labelled with the configured origin; all nodes
   asked in every round; no rescan on the first `listing_ahead`; a refuted node is not listed
   from again in the session; nothing is released, retried or re-built on any signal but
   `resolve_pending`.
8. The write of the state `build_*` returned is DURABLE before the submit (IndexedDB:
   `durability: "strict"`; a native store: fsync), in one storage transaction with a
   compare-and-swap on the revision that was LOADED; a state that could not be written is
   discarded, never worked on. The state is stored as the opaque string the core returned, and
   authenticated at rest.
9. The envelope is stored with the state; "retry" before a settlement is a re-submit of the same
   envelope.
10. Never a balance or a payment from a state that was last scanned with the viewing key alone:
    apply a page with the full key first.
11. No shield whose note (`v_in − fee`) is below the state's `min_note_value`; no recipient
    address equal to the wallet's own `pk` (until condition 2 is in the core).
12. Bounds shown in blocks, not minutes; the embargo and its reason shown after `new_state` on
    an existing phrase.
13. Deployment: every configured node answers `/api/shield-v2/stats` with a non-null
    `report.ciphertext_acc` (a build with `dec53b4`, restarted once).

**Inherent without a light client (stated, not fixable here):** a majority of the configured
nodes is believed in everything; a second device or a restored one has no locks, and any embargo
is a margin, not a proof (two quorums of an odd set may share only a liar); confirmation needs a
quorum of honest nodes at ONE height at the moment they are asked; every bound is a number of
blocks on a chain that has no block time.

## 9. Out of reach

* GitHub Actions; anything as WebAssembly (`wasm-bindgen-cli` is not installed); any network
  node, the production configuration (block interval, which nodes run which build) — nothing
  under `/srv/rougechain` or `~/.quantum-vault` was read, no service was touched.
* The start-up rebuild of the side record was read and its function is exercised by the daemon
  test; a node was not restarted on an old data directory. The other daemon modules
  (`shield_v2_review_node_1_tests`, `shield_v2::tests`, `strict_historical_replay_tests`) and
  `quantum-vault-storage` were not re-run.
* RW4-5 was not attempted through the wasm surface (the failing call is `from_json`, which every
  export that takes a state calls first — `api.rs:141`).
* The property test was run, traced and mutated; its two scratch corrections are not committed
  (the task: tests and a report only).
* `core/shield-v2` (the circuit, the prover) and the noble cross-check were not re-run; no source
  of theirs is changed by the branch.
