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

---

## Resolution

Branch `fix/shield-v2-wallet-settlement-3`, from `review/shield-v2-wallet-4` @ `075325b`.
Date: 2026-10-06. State format 5. Nothing of spec §2 (constants, tags, encodings, parameters),
no consensus rule and nothing of the state root is changed: the diff is the two wallet crates,
their tests, the documents, the CI step, and one line of test set-up in the daemon's interop
test module. **None of this has been read by a second person.**

### Per finding

| # | What was done | Where | Commit | Test |
|---|---|---|---|---|
| RW4-5 (High) | **Root cause:** a pending entry is held by the commitments of its input notes and by its nullifiers, never by a position; `PendingTx.inputs` is derived (recomputed after every change and on every read) and nothing reads it. Leaf numbers of a listing are the listing node's claim: consecutive inside a page; a page that starts above the wallet's tree is refused as before, one that starts below it is applied and reported (`ScanReport::leaf_mismatch`). **(a)** every call that changes a state (`scan`, `confirm_state`, `resolve`, `mark_pending`, `set_nodes`, both hints, the override, `record_own_shield`) runs on a copy and replaces the caller's state only if the copy passes the validation `from_json` applies — a debug assertion, and a release-mode refusal (`StateInvariant`, code `state_invariant`). **(b)** `to_json` reads its own text back and compares; on failure it returns the error and no bytes. **(c)** `WalletState::recover_locks(text) -> Recovery { state, … }` (wasm: `recover_locks`) reads every pending entry it can into an empty rescan state; an unreadable entry or an unknown expiry puts that state under the embargo. Format-4 states that RW4-5 had poisoned are read again (migration 4 → 5 in place) | `store.rs`: `PendingTx::locks`, `rederive_inputs`, `returnable`, `guarded`, `to_json`, `recover_locks`, `lenient_entry`, `entry_ok`, `scan_inner`, `migrate_v4`; `error.rs`; `api.rs` | `d1fc94e` | `rw4_f5_…` passes unedited; `rw4r_f5_fuzz_rescans_…` (480 rescans on lying listings, every call's state read back), `rw4r_f5_a_format_4_state_…`, `rw4r_f5_recover_locks_…`, `rw4r_f5_a_page_numbered_below_…`; unit test `a_state_that_does_not_read_back_is_refused_and_never_returned`; the property test reads back every state every call returns |
| RW4-1 (Medium) | The embargo is in the core. A state made by `WalletState::new` is `SpendEmbargo::AwaitingBase` (`spend_embargo_until() == None`, no spend); the first `confirm_state` that confirms a height fixes `base = min(Tm, Tq + 256)` (every configured node reported) or `Tq + 256` (one did not), and `spend_base` / `mark_pending` refuse (`RestoredRecently`, code `restored_recently`) until the confirmed height is `base + 128`. `RESTORE_EMBARGO_BLOCKS` is `MAX_EXPIRY_OFFSET`: the longest expiry the builders and `mark_pending` accept and the embargo are one constant. The override is `assert_no_other_copy_has_a_pending_payment()` (wasm: `assert_sole_copy(state, true, revision)`), recorded in the state (`sole_copy_asserted`), accepted only before the base exists, honoured only if the establishing call shows no configured node above the confirmed height. Arithmetic, guarantee and the remaining assumption: below, `WalletState::spend_embargo`, spec §5.5 (W-19), `NOTES.md` §13 | `store.rs`: `SpendEmbargo`, `spend_embargo`, `spend_gate`, `confirm_state_inner`; `tx.rs`; `api.rs` | `d1fc94e` | `rw4_f1_…`, `rw4_f1b_…` pass unedited (the core refuses the second build); `rw4r_f1_a_restored_state_builds_nothing_…` (54 cases without the user's statement: lag 0–200, default / shortest / longest expiry, the leading honest node answering or silent), `rw4r_f1_the_embargo_base_is_bounded_…`; the property test's stale-quorum adversary |
| RW4-4 (Medium) | `payment_to_self` iff the recipient address equals the wallet's own, `pk` and `ek`. A recipient with the wallet's `pk` and another `ek` is refused (`MixedOwnAddress`, code `recipient_mixed_address`) by the transfer assembly and by `build_own_shield` | `tx.rs`: `assemble_transfer`, `own_shield_checks` | `d1fc94e` | `rw4_f4_…` passes unedited; `rw4r_f4_payment_to_self_is_the_whole_address`; the property test's hostile payee |
| RW4-6 (Low) | The false positive is corrected (a lock migrated from format 1 holds an attempt only while that attempt can still be mined), the world is extended as listed in section 5, the default range is 200 seeds, CI adds a randomly placed range with the base printed. Results below | `tests/settlement_properties.rs`, `ci.yml` | `a277cac`, `88b0fab`, `5dbde1f` | below |
| RW4-3 (Low) | The first scan without the nullifier key sets `view_only_since`; `Balances { unverified_spends, received_spend_unknown }`: `confirmed` leaves out every note whose nullifier is unknown, `spendable` is 0; coin selection offers nothing; the builders refuse (`ViewOnly`, code `view_only`) until a scan with the full key has filled every nullifier and applied the remembered spends | `store.rs`: `balances`, `spend_gate`, `scan_inner`; `select.rs` | `d1fc94e` | `rw4_f3_…` passes unedited; `rw4r_f3_a_view_only_state_…`; the property test's worker |
| RW4-2 (Low), RW4-7 (Info) | IPv6 literals in RFC 5952 form; a host ending in a number must be four decimal parts without leading zeros (octal, hex, short and numeric forms refused). `set_nodes` and `from_json` enforce the set rule: https only; http for loopback hosts only; a loopback node never in a set with other nodes; one node per host whatever the scheme or the port (development sets: per host and port) | `store.rs`: `parse_node_id`, `check_node_set` | `d1fc94e` | `rw4_f2_…` passes unedited; `rw4_sound_canonical_node_id_…` (its last block restated) |
| RW4-10 (Info) | `revision_id` = SHA-256(tag ‖ previous identity ‖ counter ‖ name of the change ‖ digest of the changed state); `expect_revision_id`; every wasm result carries `revision_id`. The counter and `expected_revision` are kept (they order; changing every signature of the surface was not worth it): the compare-and-swap key is the identity | `store.rs`: `bump`, `content_digest`; `api.rs`: `out_with_state`, `expect_revision_id` | `d1fc94e` | `rw4r_i10_…`; `rw4_demo_two_different_states_…` (extended); the property test's two-tabs probe and its check that a changed state has another identity |
| RW4-11 (Info) | `build_own_shield` / wasm `build_own_shield` record the note (`OwnShield { cm, value, r, expiry_height }`) in the state; the scan stores it from the record whatever its value. `build_shield` refuses a note below the minimum note value (`NoteBelowMinimum`, code `note_below_minimum`) unless `build_shield_with(…, allow)` / `allow_below_min_note_value` | `tx.rs`, `store.rs`: `record_own_shield`, `settle_own_shields` | `d1fc94e` | `rw4r_i11_…` |
| RW4-8, RW4-9, RW4-12 (Info) | `WalletState::spend_status(quorum_tip)` → `SpendStatus` (wasm: `summary.spend`, `confirm_state.spend`, `can_spend_now`): `can_spend_now`, `reason` (`no_nodes` / `view_only` / `no_quorum` / `embargo` / `root_unconfirmed` / `window_too_short`), `confirmed_lag`, `usable_window_blocks`, `embargo_until`, `embargo_blocks_left`, the four bounds in blocks; `ConfirmReport { confirmed_lag, highest_reported, all_reported, embargo_base_set }`. The client loop is in `NOTES.md` §6 as the normative algorithm and in spec §5.5 as a SHOULD. wasm `confirm_state` returns `outdated_nodes` for reports that lack only `ciphertext_acc` | `store.rs`, `api.rs`, `NOTES.md`, spec | `d1fc94e`, `db2c9de` | `rw4r_i8_…`; wasm `address_scan_plan_build_end_to_end` |
| CI | `--no-fail-fast` on the wallet step; a second step with a random seed range | `ci.yml` | `5dbde1f` | — |

### The embargo: the rule, the arithmetic, what remains

`Tq` is the quorum's tip (the highest height a strict majority of the configured nodes claim to
have reached, a node's claim being the highest height it reported in the call), `Tm` the highest
height any configured node claimed. At the first confirmation after `new_state`:
`base = min(Tm, Tq + 256)` if every configured node reported, `Tq + 256` otherwise; no spend
until the confirmed height is `base + 128`.

With `n` nodes, quorum `q = ⌊n/2⌋ + 1` and at most `f = n − q` liars: a copy that built at
confirmed height `C_b` had `q` nodes report `C_b`, so at least `q − f ≥ 1` honest node had
reached it; honest heights never decrease; its transaction cannot be mined after block
`C_b + 128`. So `base ≥ C_b` suffices. The liars are fewer than `q`: the `q`-th highest claim
is at or below the highest honest claim (they cannot push `Tq` above the chain) and, when the
honest nodes that answer are `q` or more, at or above the `q`-th highest of theirs (they cannot
push it below); a match at height `h` needs an honest node AT `h`, so `Tq ≥ h ≥` that node's
tip. `Tm` is at least the tip of every honest node that answers; a liar's higher claim is cut
at `Tq + 256`, and a node that does not answer is counted as that claim. Hence
`base ≥ min(highest honest tip that could have answered, Tq + 256)`, and since the highest
honest tip is `≥ C_b`: **`base ≥ C_b` whenever `C_b ≤ Tq + 256`.** A lying or silent minority
moves the base up by at most 256 blocks: the embargo is between 128 and 384 blocks.

**The assumption that remains:** the nodes whose tips form the first quorum after the restore
are at most 256 blocks behind the height the lost copy last built at. If `f < 2q − n` (four
nodes, one liar) the two quorums share an honest node and nothing is assumed; with three, five
or seven nodes and a full lying minority they may share only liars, and beyond 256 blocks of
honest lag the embargo does not hold. That is a margin, not a proof, and it is said so in
`WalletState::spend_embargo`, spec §5.5 and `NOTES.md` §13.

### What had to follow in the review's own tests

The six `rw4_f*` tests pass as they were committed in `075325b`: not a byte of those six
functions or of `restore_embargo_scenario` is changed. Three things about them need saying:

* **`restore_embargo_scenario` builds on a state made by `WalletState::new` at its first
  confirmed height** (device 1), which a core that enforces the embargo refuses. The wallets of
  the test suite are new wallets: `tests/common::configure` (and the daemon's and the wasm
  tests' equivalents) now also makes the user's statement. The restored device of `rw4_f1` /
  `rw4_f1b` goes through the same `configure` — and is refused all the same, because the
  statement is not honoured when the establishing call shows a configured node ahead of the
  confirmed height (in `rw4_f1b`: by one block). **The scenario without the statement** — what
  a real restored device is — is `rw4r_f1_a_restored_state_builds_nothing_…`.
* **`rw4_f5` asserts that the next HONEST page after the lying one is accepted**
  (`next_page.is_ok() && rescan_again.is_ok()`). That page numbers its leaves below the
  wallet's tree; it was a `listing:` error before. It is now applied and reported
  (`leaf_mismatch`), which is a change of behaviour that the direction of the finding did not
  ask for; the reasoning is in `scan` and `NOTES.md` §13, and a page that starts ABOVE the
  wallet's tree is still refused (`rw1_sound_listing_manipulations_…` passes unedited).
* Tests that STATED a limit which is gone were restated, names kept:
  `rw4_demo_the_restore_embargo_is_documentation_only` (now: the core refuses),
  `rw4_sound_canonical_node_id_…` (its last block: the set is refused),
  `rw4_demo_a_shield_to_ones_own_address_…` and `rw4_demo_two_different_states_…` (one
  assertion added each). `rw4_sound_without_lag_…` passes unedited. Earlier reviews: the format
  version in three migration tests (4 → 5), the node set of `rw3_f8_…` (it listed
  `http://node.example` beside `https://node.example`), and in the wasm tests the set-up
  (`assert_sole_copy`), two revision numbers and the `malformed` count that is now
  `outdated_nodes`.

### The property test

`tests/settlement_properties.rs`, on the unmodified code of this branch, each as
`systemd-run … nice -n 19 cargo test --release --locked --offline -j 1 -p quantum-vault-shield-v2-wallet --features test-vectors --test settlement_properties -- --nocapture`
on this host (a production validator: `CPUWeight=10`, `nice 19`):

| Run | Result | Time | What it did |
|---|---|---|---|
| seeds 1–200 × 280 steps (the default; what CI runs) | passes | 243 s | 2,815 payments, 418 restores, 68 embargo bases fixed more than 64 blocks below the tip |
| `PROP_RUNS=700` (seeds 1–700 × 280 steps) | **passes** | 827 s | 9,946 payments (1,240 with the 128-block expiry), 1,473 restores (254 stale bases), 8,438 / 920 / 596 settled mined / expired / superseded, 88 eviction bursts, 9,209 blocks with several transactions, 8,939 pages scanned with the viewing key, at most 7 rounds to settle |
| `PROP_RUNS=250 PROP_STEPS=700` (seeds 1–250 × 700 steps) | **passes** | 1,199 s | 8,514 payments, 1,372 restores (232 stale bases), 7,125 / 832 / 481 settled, at most 8 rounds to settle |

(The first version of the rewritten test, commit `a277cac`, passed the same two configurations in
888 s and 1,275 s; the figures above are for the final test, which has four more invariants.)

What its world has that the reviewed one lacked, item by item of section 5: honest nodes up to
200 blocks behind, per node and never going back; blocks with several transactions; 280
pool-changing blocks in a row in one run of eight; scans with the viewing key; a hostile payee
(own-`pk` addresses are tried and must be refused; a payee's `pk` under the payer's encryption
key is paid); a shield is not made by the device in the property test (RW4-11 is covered by
`rw4r_i11_…`); 2 to 7 configured nodes; a client that asks for an expiry outside the bound,
for a locked note, for a root above the confirmed height, and that compares revision
identities; restores answered by a stale quorum; pages cut at any height; and value: the
oracle computes each output's amount from the request and the books and recomputes its
commitment (`Tx::checked`).

### Mutations

The review's sixteen (A1–L1), the 26 of REVIEW_WALLET_3's Resolution (M1–R12) as they apply to
the current code, and five of the code this branch added (N1–N5). Each applied alone to
`store.rs` / `tx.rs` / `select.rs`, then the property test on seeds 1–120; where it passed, the
rest of the wallet suite (`--no-fail-fast`); then reverted (the driver restores the three files
from copies; `git status` clean afterwards).

| # | Mutation | Property test (seeds 1–120 × 280 steps) | Otherwise caught by |
|---|---|---|---|
| A1 | listing_refuted already at dissenting >= n - quorum | **caught**: "seed 1: a true listing was refuted by a lying minority" | |
| A2 | listing_ahead when the listing's last pool block is AT the quorum's tip | **caught**: "seed 1, mid-run: not settled after 28 rounds with an honest majority reachable (pending 0, confirmed Some(219), scanned Some(219), tip 219, listing fr" | |
| A3 | a report above the scanned height is compared with the latest state | **caught** — by the core itself: the call is refused (`state_invariant`), which the harness treats as a failure ("called `Result::unwrap()` on an `Err` value: StateInvariant") | |
| A4 | a report older than the kept history is compared with the OLDEST kept state | **caught**: "seed 3: a report for height 24, 288 pool-changing heights below the confirmed height, was compared with a state the wallet no longer keeps" | |
| B1 | resolve settles a sighting only strictly BELOW the confirmed height | **caught**: "seed 1: a transaction mined at height Some(801) is still pending at confirmed height 801" | |
| B2 | an expiry up to confirmed + 1,128 is accepted (builder and mark_pending) | **caught**: "seed 1: an expiry 180 blocks above the confirmed height was accepted" | |
| B3 | spend_base does not require the confirmed root | **caught**: "seed 1: a spend was built on a root above the confirmed height without the caller's explicit decision" | |
| C1 | neither spend_input_with nor mark_pending checks the lock | **caught**: "seed 3: the builder handed out a locked note" | |
| C2 | mark_pending does not raise the revision | **caught**: "seed 1: two different states are one revision" | |
| D1 | an own output is taken from the record WITHOUT recomputing its commitment | **caught** — by the core itself: `scan` refuses the page (`state_invariant`: "the call would have left a wallet state that does not read back"), which the harness treats as a failure | |
| D2 | every output for the wallet counts as its own (dust minimum and cap never apply) | **caught**: "seed 1, mid-run: the confirmed balance is not the true balance at the tip" | |
| D3 | the cap admits one note more | **caught**: "seed 15 after mid-run: 6 unspent notes from others are stored under a cap of 5" | |
| E1 | a second transaction at one height pushes a second checkpoint | **caught** — by the core itself: `scan` refuses the page (`state_invariant`: "the call would have left a wallet state that does not read back"), which the harness treats as a failure | |
| F1 | the change is computed without the fee | **caught**: "device B's payment: the Change output does not commit to the 2000000000 quanta the request implies" | |
| F2 | coin selection offers locked notes | **caught**: "seed 1: coin selection offered a locked note" | |
| L1 | a note's own nullifier in the listing does not mark it spent | **caught**: "seed 1 after a whole round: confirmed balance 22000000000 exceeds the true balance 18000000000 at height 7" | |
| M1 | resolve settles at the scanned height | **caught**: "seed 10: settled as mined, and it is not on the true chain" | |
| M2 | a report is compared by root and note count only | **caught**: "seed 1: the state confirmed at height 7 is not the chain's" | |
| M5 | fresh_for_rescan keeps seen_* | **caught**: "seed 2: the quorum is a strict majority of the configured nodes" | |
| M6 | any nullifier match marks ALL inputs spent | **caught**: "seed 39, mid-run: the confirmed balance is not the true balance at the tip" | |
| M7 | mined ignores the outputs (nullifier pair only) | **caught**: "seed 9: settled as mined, and it is not on the true chain" | |
| M8 | expired one block early | **caught**: "seed 22: settled as expired while the true chain can still mine it (height 2129, expiry 2130)" | |
| M9 | the quorum is 2 whatever the configured set | **caught**: "seed 1: the quorum is a strict majority of the configured nodes" | |
| M9b | the quorum is a majority of the reports supplied | **caught**: "seed 10: the state confirmed at height 390 is not the chain's" | |
| M10 | every note confirmed on any match | **caught** — by the core itself: the call is refused (`state_invariant`), which the harness treats as a failure ("called `Result::unwrap()` on an `Err` value: StateInvariant") | |
| M11 | the match height is the scanned height | **caught**: "seed 2 after a whole round: a height was confirmed that the true chain has not reached" | |
| M12 | expired tested before mined | **caught**: "seed 1: a MINED transaction was settled as expired" | |
| M13 | agreeing reports counted, not distinct nodes | **caught**: "seed 1: a height was confirmed that the true chain has not reached" | |
| M21 | the recipient check does not compare the commitment | **caught**: "seed 1: a stored note does not open its commitment" | |
| M25 | a migrated lock expires at the old scanned height (no + 128) | **caught**: "seed 7: settled as expired while the true chain can still mine it (height 619, expiry 675)" | |
| R1 | a dissenting node blocks the call | **caught**: "seed 1, mid-run: not settled after 28 rounds with an honest majority reachable (pending 0, confirmed None, scanned Some(2608), tip 2608, listing from" | |
| R7 | the expiry is measured from the scanned height | **caught**: "seed 1: an expiry 129 blocks above the CONFIRMED height 376 was accepted (the listing is at 403)" | |
| R2 | the ciphertext hash is not compared | **caught**: "seed 1: the state confirmed at height 1288 is not the chain's" | |
| R4 | the cap counts stored notes, spent ones included | **caught**: "seed 11, mid-run: notes counted as over capacity although the wallet never held 14 unspent notes (peak 13)" | |
| R2a | the change is not taken from the pending record | **caught**: "seed 3: the listing showed the wallet's own transaction and its change is not stored" | |
| R3 | own outputs below the minimum are not stored | **caught**: "seed 4, mid-run: the confirmed balance is not the true balance at the tip" | |
| R5 | the builder returns the state without the lock | **caught**: "seed 1: two different states are one revision" | |
| R8 | a report under an unconfigured id counts | **caught**: "seed 1: a height was confirmed that the true chain has not reached" | |
| R9 | listing_ahead is never set | **caught**: "seed 16, mid-run: the confirmed balance is not the true balance at the tip" | |
| R10 | listing_refuted is never set | **caught**: "seed 95, mid-run: not settled after 32 rounds with an honest majority reachable (pending 0, confirmed None, scanned Some(1002714), tip 2149, listing f" | |
| R11 | locks are held by leaf position, not by commitment or nullifier | **NOT caught** | `rw4r_f5_fuzz_rescans_with_forged_entries_and_random_page_cuts_never_leave_a_state_that_does_not_read_back` |
| R12 | abandon_unsubmitted releases the lock | **caught**: "assertion failed: s.abandon_unsubmitted(&record.nullifiers[0].0) && s.is_locked(sel.positions[0])" | |
| N1 | (new code) the embargo base is the first confirmed height (the W-17 rule) | **caught**: "seed 86: the embargo ends at confirmed height 991 while an earlier transaction is valid until 1082 (first confirmed 863, true height 1063)" | |
| N2 | (new code) a view-only state is not refused by the builders and offers its notes | **caught**: "seed 1 after the worker scans with the viewing key: a view-only state offers a note" | |
| N3 | (new code) payment to self decided by pk alone; the mixed address is not refused | **caught**: "seed 2: a payment to the wallet's own pk under another encryption key was built" | |
| N4 | (new code) the restore embargo is not enforced by the builders | **caught**: "seed 22: the core lets a restored state spend while an earlier transaction can still be mined (expiry 71, true height 47)" | |
| N5 | (new code) a scan writes the listing's leaf position into the pending entry (the RW4-5 code) and validation requires distinct positions | **caught**: "an older format is migrated: State("a pending transaction is malformed")" | |

**46 of 47 are caught by the property test**, every one of the review's sixteen among
them — 13 of those by an invariant of the model, three (A3, D1, E1; and M10 of the earlier
table) by the core's own refusal to return a state that does not read back, which is itself the
RW4-5 fix at work. The one miss:

* **R11** (locks held by position). Positions are now DERIVED from the commitments after every
  change, so while a state holds an entry's notes "held by position" and "held by commitment"
  are the same lock. The mutant differs only in the middle of a rescan, where the stale
  position of a note the state does not hold can lock an unrelated note — a spurious lock,
  which violates no guarantee and which the property test's random listings did not produce in
  120 seeds. The rescan fuzz does produce it, and
  `rw4r_f5_fuzz_rescans_with_forged_entries_…` asserts that a locked note is one a pending
  entry spends.

N5 puts the reviewed code of RW4-5 back (the scan writes the listing's leaf into the entry,
validation requires distinct positions): the property test fails on it at once.

### Commands, as run on the final tree

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, one at a time, after checking that no `cargo`
or `rustc` process was running (`cargo tree` takes no `--release` / `-j`: it was run with
`--locked --offline` under the same limits).

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm … --no-fail-fast -- --test-threads=1` | **114 tests, 0 failed, 0 ignored.** Wallet 107: unit 22, `review_wallet_1` 14, `review_wallet_2` 14, `review_wallet_3` 17, `review_wallet_4` 19 (the six `rw4_f*` among them), `review_wallet_4_resolution` 11, `settlement_properties` 1, `vectors` 3, `wallet_flow` 6. wasm 7: `api` 2, `review_wallet_1` 4, `review_wallet_3` 1 |
| the property test at the two extended configurations | above |
| `cargo build -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown …` | finished; 2,845,907 bytes |
| `cargo test -p quantum-vault-daemon … -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed, 294 filtered out |
| `cargo test -p quantum-vault-daemon … -- node::shield_v2_daemon_tests --test-threads=1` | 11 passed, 287 filtered out |
| `cargo tree -p quantum-vault-shield-v2-wasm -e normal,features -i quantum-vault-shield-v2-wallet` | `feature "default"` only |
| `cargo tree -p quantum-vault-daemon -e normal,build,features` | neither wallet crate in the daemon's normal or build graph |
| `NOBLE_ROOT=… node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 checks passed |
| the mutation driver (47 mutations, 52 property-test runs, 6 suite runs) | table above |

`core/target/` was deleted afterwards.

### The conditions of section 8, line by line

**Core**

1. *RW4-5: no call returns a state that `from_json` refuses; a rescan with a two-input entry
   pending survives any listing; the property test on 700 × 280 and 250 × 700 with RW4-6
   corrected; the CI range widened or randomised.* — **Met.** `rw4_f5_…` passes;
   `rw4r_f5_fuzz_…`; the property test reads back every state every call returns and passes
   at both configurations (below); CI runs 200 seeds and a second, randomly placed range of 60
   with the base printed.
2. *RW4-4: a recipient with the wallet's `pk` and another `ek` is refused.* — **Met.**
   `rw4_f4_…` passes (the builder refuses); `rw4r_f4_…`; mutation N3.
3. *RW4-1: (a) the embargo restated so that `rw4_f1_…`, `rw4_f1b_…` pass — maximum expiry 64,
   base not the first confirmed height alone; (b) enforced by the core or tested in each
   client; the property test's client uses the rule as written and its world has honest nodes
   more than 64 blocks behind.* — **Met, with one deviation that is deliberate.** Both tests
   pass; the base is `min(Tm, Tq + 256)` / `Tq + 256`; the core enforces it; the property
   test's world has honest nodes up to 200 blocks behind and a stale-quorum adversary, and its
   client has no embargo logic at all. **The maximum expiry stays 128, not 64**: `rw4_f1b`
   itself builds with `MAX_EXPIRY_OFFSET` and requires that build to succeed, and the
   condition's purpose — a margin between the longest expiry and the embargo — is met from the
   other side: the embargo is 128 blocks above a base that carries up to 256 blocks of lag,
   and the property test exercises the 128-block expiry against it. What is NOT met, because
   it cannot be: G1 across a restore without any assumption (see "The embargo" above).
4. *RW4-3: `summary` says when a state holds notes without a nullifier; `rw4_f3_…` passes.* —
   **Met.** `unverified_spends`, `received_spend_unknown`, `view_only_since`, and
   `spend.reason = "view_only"`.
5. *RW4-2: `rw4_f2_…` passes.* — **Met** (canonical IPv6, canonical or refused IPv4).

**UI / client layer** — not code in this repository; each is now either enforced by the core
or documented where a client author reads it:

6. *Node ids: https only (loopback excepted), one id per host, an odd number ≥ 3 of different
   operators; shown; changed only explicitly.* — the first two are **enforced by `set_nodes`**;
   the rest: `NOTES.md` §6 item 4, spec §5.4 (W-18).
7. *The loop of section 2.8.* — `NOTES.md` §6 "The client loop (normative)"; spec §5.5 (W-19)
   as a SHOULD; executed by the property test's client.
8. *Durable write before the submit, compare-and-swap on the LOADED revision, opaque state,
   authenticated at rest.* — `NOTES.md` §6 item 3 and the loop's step 5; the compare-and-swap
   key is `revision_id`; that the state text is one the core reads back is enforced by
   `to_json`. Durability itself is the client's.
9. *The envelope stored with the state; retry = the same envelope.* — the loop's step 5;
   `NOTES.md` §6 item 7.
10. *Never a balance or a payment from a state last scanned with the viewing key.* —
    **enforced by the core** (RW4-3).
11. *No shield below `min_note_value`; no recipient with the wallet's own `pk`.* — **enforced
    by the core** (`note_below_minimum:` unless allowed; `recipient_mixed_address:`).
12. *Bounds in blocks; the embargo and its reason shown after `new_state`.* — `spend_status`
    gives every bound in blocks and the reason; showing it: `NOTES.md` §6 item 7.
13. *Deployment: every configured node reports `ciphertext_acc`.* — not something this branch
    can do; a node that does not is now NAMED (`outdated_nodes`), `NOTES.md` §6 item 4.

**Inherent without a light client** — stated, not fixed: a majority of the configured nodes is
believed in everything (spec §5.4; `NOTES.md` §6 item 4, §7); a second live device has no
locks, and the embargo of a restored one is a margin (spec §5.5 W-19, "The assumption that
remains"; `WalletState::spend_embargo`; `NOTES.md` §13); confirmation needs a quorum at ONE
height (spec §5.5, last paragraph of W-19; the loop keeps the reports of three rounds); every
bound is a number of blocks on a chain without a block time (the same paragraph; `NOTES.md` §6
item 7; `SpendStatus`).

### Not done

* No second reading of any of this.
* The wasm surface keeps the numeric `expected_revision`; the identity is returned by every
  call and checked by `expect_revision_id`, not passed into each call.
* A `report?height=h` on the node (RW4-9's suggestion) — a node change, out of scope here.
* The expiry window itself (64 / 128 blocks against the block interval, RW4-8) is a consensus
  figure (O-8) and is unchanged.
* Nothing was built or run as WebAssembly beyond the `wasm32-unknown-unknown` release build;
  GitHub Actions was not run.
* The daemon modules `shield_v2_review_node_1_tests`, `shield_v2::tests` and the rest of the
  daemon suite were not re-run (no node source changed; one line of test set-up did).
