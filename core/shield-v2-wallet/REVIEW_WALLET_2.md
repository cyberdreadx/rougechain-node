# REVIEW_WALLET_2 — second independent review: the fixes made after REVIEW_WALLET_1

Reviewed: `origin/main` @ `60d1e2b` (the merged wallet core), with the weight on what was ADDED
to answer `REVIEW_WALLET_1.md` — the diff `3f00ec0..65588e1` of `core/shield-v2-wallet`,
`core/shield-v2-wasm`, `core/shield-v2`, `core/daemon` and `.github/workflows/ci.yml` — against
`docs/SHIELDED_POOL_V2_SPEC.md` §5.3–§5.8 (amendments W-9 … W-13) and `NOTES.md`. The reviewer did
not write any of it. Date: 2026-10-06. **Nothing was fixed.** Every confirmed defect has a
regression test that fails on purpose until it is fixed.

## Verdict

**Not ready for a UI. Two High findings, both in the fix of F-7 — the fund-loss finding — and
both end in the double payment that fix was written to prevent.**

The lock itself is sound: a locked note is not selected, not accepted by a builder, survives a
JSON round-trip and a rescan, and the release height is exactly the first height at which the
node refuses the transaction (no off-by-one). What is not sound is how the wallet decides that a
pending transaction is **settled**:

* **RW2-1** — "mined" is taken from one node's listing under every policy, and the rescan the
  wallet is then told to do starts with the inputs unlocked while the transaction is still valid.
* **RW2-2** — "expired" under `ReleasePolicy::Confirmed` looks at nullifiers only; the root the
  quorum confirms commits commitments, not nullifiers. One lying listing node defeats the strict
  policy while the quorum is honest. The spec sentence that justifies the policy is wrong.

One Medium finding (**RW2-3**) needs no hostile node at all, only the same recovery phrase on two
devices — the normal situation here (site, extension, mobile). One Low finding in the root quorum
(**RW2-4**), further Low and Info items below.

All three settlement defects have one cause and one remedy: the pending record already holds the
commitment of the change note (`PendingChange.cm`, `store.rs:414–419`) and nothing ever reads it.
A transaction is mined exactly when its own outputs are in the tree, and the tree is what the
quorum vouches for.

Found sound: the address format (F-2), the hedged generator including the restart case that was
asked for explicitly (F-5), blind scanning (F-3), listing validation (F-4), error scrubbing
(F-6), the fee ceiling, the expiry bound, and the compile-time guard (section 3).

| # | Severity | Finding | Where | Test |
|---|---|---|---|---|
| RW2-1 | **High** | A listing that shows the pending transaction mined settles it on one node's word; after the prescribed rescan its inputs are unlocked while it is still valid → double payment | `store.rs:1207–1219` (mined), `943–963` (`resolve`, line 955), `643–647` (`fresh_for_rescan`) | `rw2_f1_…` **FAILS** |
| RW2-2 | **High** | `ReleasePolicy::Confirmed` declares a MINED transaction expired when the listing node swaps its nullifiers; the honest quorum confirms the root | `store.rs:943–963` (line 951), `1207–1208`; spec §5.5 lines 1169–1172; `NOTES.md:292–294` | `rw2_f2_…` **FAILS** |
| RW2-3 | Medium | Any transaction that spends ONE input of a pending transaction makes it "mined" and marks ALL its inputs spent (two devices, one phrase) | `store.rs:1207–1218`; spec §5.5 rule (a) | `rw2_f3_…` **FAILS** |
| RW2-4 | Low | `confirm_roots` confirms notes in the same call that reports `diverged`; the quorum is an absolute count whatever the number of nodes asked | `store.rs:1015–1032` | `rw2_f4_…` **FAILS** |
| RW2-5 | Low | `ReleasePolicy::Scanned` releases on one empty page that lies about the height; a state from `fresh_for_rescan` accepts a page starting at any later height | `store.rs:945`, `1077–1080`; wasm `api.rs:489–493` | `rw2_demo_scanned_…` (passes: documented limit) |
| RW2-6 | Low | The root report the notes prescribe (`tip_height`, `pool.latest_anchor`) is read non-atomically by the node; two nodes racing the same block give a false `diverged` | `daemon/src/node.rs:5699–5733`; `NOTES.md:254–256` | — (node side; reasoning) |
| RW2-7 | Low | Dust: 2,718 bytes of state per stored note, never pruned, re-found by every rescan; `to_json` can write a state `from_json` refuses | `store.rs:68`, `649`, `661` | `rw2_info_state_bytes_…` (measurement) |
| RW2-8 | Low | CI never runs the prover's own tests (the source scan for a public seed parameter among them); the daemon step makes real proofs in a debug build | `.github/workflows/ci.yml:53`, `57` | — |

Tests added: 13 Rust tests in two files (section 5). **4 fail on purpose.**

---

## 1. Findings

### RW2-1 (High) — "mined" on one node's word, then a rescan with the inputs unlocked

`scan` marks a pending entry `Mined`, and its inputs spent, as soon as one of its nullifiers is
in a listing (`store.rs:1207–1219`). Whoever the transaction was submitted to knows both
nullifiers. `resolve` hands a `Mined` entry back and removes it under **both** policies
(`store.rs:955`) — the policy is consulted for expiry only (line 951); `mined_height` is never
compared with `confirmed_height`. `fresh_for_rescan` copies the pending list as it is
(`store.rs:645`): an entry already marked `Mined` stays `Mined`, locks nothing, and is never set
back to `Pending` — although its doc comment says the list is kept precisely because
"dropping the pending list … would unlock notes whose transactions may still be mined".

*Scenario (the test, end to end on the stand-in chain).* Alice holds one 10 XRGE note and pays
Bob 4 (`t1`, `mark_pending` first, default expiry: 64 blocks). The node she uses keeps `t1` and
serves a listing in which `t1` is mined. Her wallet marks it mined. It then does everything
`NOTES.md` §6 items 4 and 7 prescribe: `confirm_roots` against two honest nodes (`diverged`),
`resolve_pending(require_confirmed = true)`, `rescan_state`, scan against an honest node. In
either order of the last calls the rebuilt state has the 10 note unspent, **unlocked**, and no
pending `t1`:

* `resolve` first → `t1` is returned under `mined` (at a height nobody confirmed) and removed;
* rescan first → the entry is carried over as `mined`; the next `resolve` removes it.

The wallet shows the payment gone and the funds back. 5 XRGE arrive; Alice pays Bob again; coin
selection takes the 5 note; the node releases `t1`, which is valid until its expiry. Both are
mined. Test output:

```
t1 is valid until height 67 and is not on the chain, yet: resolve(Confirmed) handed 1 entry back
as MINED at a height no quorum confirmed; [resolve(Confirmed) then rescan: t1 still pending and
its input locked = false; after Alice's retry and the node's release of t1 Bob holds 8 XRGE]
[rescan then resolve: … locked = false; … Bob holds 8 XRGE]
```

The attacker is the one of REVIEW_WALLET_1 F-7 (the single node the wallet submits to and scans
from); it lists instead of answering "rejected". A real reorganisation that drops the block of a
mined transaction has the same effect without any liar; `NOTES.md` §2 item 16 assumes that away,
but the lying listing does not need it.

*Direction (not done).* (i) Under `Confirmed`, an entry is settled as mined only when
`mined_height ≤ confirmed_height`; until then it stays in the list. (ii) `fresh_for_rescan`
resets every entry to `pending` (clearing `mined_height`): the rescan re-derives the status from
the chain it is scanned against. (iii) See RW2-2 for what "mined" should be decided by.

Test: `tests/review_wallet_2.rs::rw2_f1_a_listing_that_shows_the_pending_tx_mined_unlocks_its_inputs_after_the_prescribed_rescan` — **fails**.

### RW2-2 (High) — the strict policy releases a transaction that WAS mined

`ReleasePolicy::Confirmed` rests on this sentence (spec §5.5, lines 1169–1172; the same in
`store.rs:473–476` and `NOTES.md:292–294`): *"a matching root at a height at or above
`expiry_height` shows that the tree those nodes hold does not contain the transaction's
outputs."* A matching root shows that the wallet's tree **is** the nodes' tree. Whether that tree
contains the transaction's outputs is never checked: `resolve` asks only whether a nullifier was
seen (`store.rs:951`), and the nullifiers are not in the root. The listing node can change
`nf1` / `nf2` of any listed transaction to other canonical digests and leave the commitments
alone; the wallet's root is then the real root and an honest quorum confirms it at every height.

*Scenario (the test).* `t1` (Alice pays Bob 4 from her 10 note) is really mined. The listing node
serves the real block with `t1`'s nullifiers replaced. The wallet sees no spend, and does not
find its own 5 XRGE change either (`rho` is derived from the nullifiers, so the recipient check
fails). Two honest nodes confirm the wallet's root at the tip. At the expiry height
`resolve(Confirmed)` returns `t1` under **`expired`** and releases the 10 note:

```
resolve(Confirmed) declared a MINED transaction expired and released its input: the wallet shows
10 XRGE confirmed (5 on chain), Bob already holds 4, and the UI is told a retry is safe
```

A retry from the 10 note is refused by the chain (its nullifier is spent); a retry from any other
note pays Bob twice. Independently of pending transactions, the same lie hides any spend of the
wallet's notes from it while the balance stays "confirmed" — `confirm_roots` vouches for
commitments, and a `confirmed` note may be spent.

*Direction (not done).* Decide "mined" by the transaction's own outputs. Every transfer and
unshield has a change output (possibly of value zero), and its commitment is already in the
record. Mark the entry mined when that commitment is appended by `scan` (it is committed by the
root, so the quorum covers it); release by expiry only when it has NOT been appended through a
height ≥ `expiry_height` that the policy accepts. Then the spec sentence is true. Correct §5.5 and
`NOTES.md` §6 item 7. Storing both output commitments instead of one costs 32 bytes and removes
the dependence on the role.

Test: `tests/review_wallet_2.rs::rw2_f2_confirmed_release_declares_a_mined_tx_expired_when_the_listing_node_swaps_its_nullifiers` — **fails**.

### RW2-3 (Medium) — one spent input makes the whole pending transaction "mined"

Rule (a) of spec §5.5 — "one of the transaction's nullifiers appears in the listing — it was
mined" — is false when another transaction spends the same note, and the code then marks **every**
input of the pending entry spent (`store.rs:1212–1217`), also a note whose nullifier is on no
chain.

*Scenario (the test; no node lies).* Alice has a 3 and a 4 XRGE note and the same phrase on two
devices. Device A builds `t1` from both notes (5 to Bob) and records it. Device B, which cannot
know A's lock, pays 1 XRGE from the 3 note; that is mined first, and `t1` is invalid for ever.
Device A's scan: `t1` is `mined`, the 3 note and the **4 note** are spent.

```
device A calls t1 mined (1 entry under `mined`) although neither its second nullifier nor its
change commitment is on the chain; the 4 XRGE note is marked spent: true; A shows 1 XRGE, the
chain holds 5
```

The UI is told "paid Bob 5"; Bob received 1. The 4 XRGE are invisible on device A until a rescan
from an empty state, and nothing asks for one: the wallet's root is correct, `confirm_roots`
matches. The same happens after a crash between build and `mark_pending` followed by a second
build from one of the notes, and for a state restored from the phrase on a new install.

*Direction (not done).* A note is marked spent only when its own nullifier appears. A pending
entry one of whose nullifiers appears **without** its change commitment is a conflict: report it
as failed (a third list in `Resolution`), release its other inputs.

Test: `tests/review_wallet_2.rs::rw2_f3_another_transaction_spending_one_input_makes_the_pending_tx_mined_and_the_other_input_spent` — **fails**.

### RW2-4 (Low) — notes are confirmed in the call that reports `diverged`

`confirm_roots` counts agreeing and disagreeing nodes per height independently
(`store.rs:1015–1023`) and confirms on `agreeing ≥ quorum` even when another root has a quorum
too — at the same height or at a lower one. The quorum is an absolute number (default 2), not a
share of the nodes asked. With four nodes asked, two names of one operator confirm a forged note
against two honest nodes that say otherwise; the report carries `diverged: true` and the forged
1,000,000 XRGE are `confirmed` and spendable in the returned state. It also happens when the
honest nodes simply answer one block earlier than the liar.

That one operator under two names passes is a stated limit (`NOTES.md` §6 item 4). That
contradicting evidence in the same call is ignored is not stated and not necessary.

*Direction.* Confirm nothing in a call in which any comparable height has `quorum` nodes on
another root; let the caller ask for a majority of the nodes it asked.

Test: `tests/review_wallet_2.rs::rw2_f4_confirm_roots_confirms_a_forged_note_in_the_call_that_reports_diverged` — **fails**.

### RW2-5 (Low) — `Scanned` is "release on rejection" by another name

Documented ("one node's listing decides"), shown so that nobody builds on the other reading: the
node that answers "rejected" follows with one empty page `{from_height: next, next_height:
expiry + 1, tip_height: expiry, txs: []}`. It passes every check (the page is compared with the
node's own `tip_height` only), `resolve(Scanned)` releases at once, and on the real chain `t1` is
valid for another 64 blocks. On a state from `fresh_for_rescan` the page need not even continue
the state: an empty tree accepts a page that starts anywhere above `next_height`
(`store.rs:1077–1080`, meant for the jump to the activation height).

The wasm export `resolve_pending(state, require_confirmed)` has no default. `false` is this
policy, and the F-7 "Resolution" describes the fix in its terms ("until … a scanned height at or
above `expiry_height`"). With RW2-1 and RW2-2 open, neither policy is safe against the node the
wallet scans from. Once they are fixed, `Scanned` should be removed from the wasm surface or
renamed so that its meaning cannot be missed, and the fresh-state jump limited to a height the
caller names (the activation height).

Test: `rw2_demo_scanned_policy_releases_on_one_empty_page_that_lies_about_the_height` (passes).

### RW2-6 (Low) — the prescribed root report can be a false `diverged`

`NOTES.md` §6 item 4 says to pass `(tip_height, pool.latest_anchor)` from `/api/shield-v2/stats`.
`shield_v2_stats` reads the tip from the chain store and then the pool from the pool store
(`node.rs:5701`, `5713`), not atomically. A block applied between the two reads gives
`(T, R(T+1))`. Two nodes apply the same block at about the same time; if block T+1 holds a V2
transaction, both report a root that is not the wallet's `root_at(T)` → `diverged`, and the wallet
is told to rebuild from nothing — when the pool is busy, which is when it costs most. The stats
answer already contains `pool.next_height`: the height to report is `pool.next_height − 1`.
Correct the notes and the wasm doc comment (`api.rs:505–507`).

### RW2-7 (Low) — dust flooding: cost to attacker and to victim

Measured: **2,718 bytes of state JSON per stored non-zero note** (`rw2_info_…`; 32 path digests
plus the note). Notes of 1 quantum are stored, tracked (32 comparisons per appended leaf each)
and never pruned; a rescan finds them again; removing them costs the victim one fee per two
notes, more than they are worth. The sender pays one fee (1 XRGE) per transaction and can
address both outputs to the victim.

| Victim state | Notes | Cost to the sender |
|---|---|---|
| 27 MB — parsed and re-serialised by every wasm call that changes state | 10,000 | 5,000 – 10,000 XRGE |
| 256 MiB — `from_json` refuses it (`store.rs:661`) | ≈ 98,700 | ≈ 49,000 – 99,000 XRGE |

At the second line the wallet is bricked rather than slowed: `to_json` (`store.rs:649`) has no
limit and writes a state that `from_json` will not read. Direction: do not track a path for a
note below a dust threshold the caller sets (keep value and position, rebuild the path on demand
by a rescan), and make `to_json` and `from_json` agree.

### RW2-8 (Low) — the CI workflow

Read with resolver 2 in mind; `cargo tree` confirms the feature sets (section 5).

| Step | Feature set of `quantum-vault-shield-v2` | Verdict |
|---|---|---|
| `cargo build` (default members) | `default` only; dev-dependencies are not built | does what it says; the guard holds |
| `cargo test -p …` (ten node crates) | none of them depends on the crate | fine |
| `cargo test -p quantum-vault-daemon` | `default` + `prover` + `test-prover`, through the dev-dependencies; the daemon is compiled as a test harness only (`cfg(test)`), the plain binary is not built (no integration test target, no example) | passes the guard as intended. **Debug profile**: this step makes real proofs (wallet interop and the test prover) without optimisation; the workflow's own comment on the next step says the proof code takes hours in a debug build. Not run here — duration unknown, may not finish |
| `cargo test --release -p quantum-vault-shield-v2` | `default` only | the three test targets with `required-features = ["test-prover"]` and the `prover::` unit tests are **skipped silently**: the prover's own tests — including the scan of the source for a public function that takes a seed (`tests/prover.rs`) — never run in CI |
| `cargo test --release -p …-wallet --features test-vectors -p …-wasm` | `default` + `prover` | run here in exactly this form: works. `--features` applies to the selected package that defines it; the daemon is not in the graph |

Direction: add `--features test-prover` to the shield-v2 step (the daemon is not in that
invocation), and `--release` to the daemon step.

### Info

| # | Item | Where |
|---|---|---|
| I-1 | "The anchor window bounds a transaction's life to 128 blocks regardless" (REVIEW_WALLET_1 §3) is not true: the window is a list of root VALUES, and a block without V2 transactions repeats the root (spec §4.3 rule 4, `pool.rs:604`). In an idle pool an anchor stays valid indefinitely; only `expiry_height` bounds a transaction. The builders' bound is therefore the only bound — and the native builders take `anchor_height` on the caller's word (`mark_pending` re-checks against the scanned height; the wasm surface forces the scanned height) | `tx.rs:82–90` |
| I-2 | A lock migrated from format 1 without an expiry is permanent, also through `fresh_for_rescan`; with no nullifier (a note found with the viewing key) nothing can ever release it. The only way out is `WalletState::new`. Correct as a safe default — the expiry is unknown and I-1 rules out a time bound — and format 1 was never used by a client; say so where a UI will find it | `store.rs:685–698` |
| I-3 | The stateless surface has no guard against a lost update: two contexts that load the same state and persist in turn drop each other's `mark_pending`. A dropped lock is the precondition of F-7. The UI needs one writer per state (or the state a sequence number the surface checks) | wasm `api.rs:463–468` |
| I-4 | `build_transfer` / `build_unshield` take leaf positions and do not look at `confirmed`: the `allow_unverified` decision exists in `plan_payment` only. Harmless on chain (an unverified forged note has an anchor no node knows) | wasm `api.rs:382–387`; `store.rs:841–851` |
| I-5 | Locks are held by leaf position, not by nullifier. Positions mean the same notes only on the same chain; after a rescan onto a different chain a lock sits on another note | `store.rs:861` |
| I-6 | A shield's hedge has no secret. Under a generator stuck on a value an observer knows, a shield's body is a function of public values and the recipient's address (two processes produce identical bytes — test), so anyone who holds an address can test whether a shield went to it. Stated as a limit in `NOTES.md` §9; made concrete here | `tx.rs:537–542` |
| I-7 | The blind log (F-3) fills with 1,024 nullifiers of ANYBODY's transactions — 512 pool transactions after the first note found with the viewing key — after which the full key always needs a rescan from an empty state. A cost, not an error | `store.rs:63`, `1188–1195` |
| I-8 | `ProveError::Prover(String)` and `SelfVerify(String)` forward the proof library's own text into the wasm error. No path was found by which that text holds witness data; it is the one error text this crate does not write itself | `error.rs:46`; `prover.rs:147`, `154` |
| I-9 | The guard fails closed for every build that also builds test targets with the plain binary: `cargo build/check/clippy --all-targets`, an editor's default check. Safe, and worth one line in `docs/running-a-node/upgrade-schedule.md` next to the `--workspace` remark | `daemon/src/shield_v2.rs:54–58` |
| I-10 | The node's listing skips a height whose block is missing from its store as if it were empty (`if let Some(block)`); the wallet notices only at the next leaf mismatch | `daemon/src/node.rs:5758` |
| I-11 | From "Not done": the 8-byte fingerprint (2^32 work if a UI shows half of it), the same address on every network, and no replacement of a pending transaction are acceptable to leave. "No reorganisation handling beyond refuse and rescan" is not: RW2-1 is that path | `NOTES.md` §7 |

---

## 2. The questions that were asked, answered

**Pending transactions.**
(a) *The same note in two live transactions:* not through the core once `mark_pending` was
called — selection, `spend_input` and a second `mark_pending` all refuse, also after a JSON
round-trip, a rescan and a migration. Without `mark_pending` (not called, a crash before it, a
second device) nothing is locked; two transactions from the same note conflict on its nullifier
and only one is mined, but see RW2-3 for what the wallet then believes.
(b) *Released while it can still be mined:* yes — RW2-1 (both policies), RW2-2 (`Confirmed`),
RW2-5 (`Scanned`). The comparison itself is exact: the node refuses iff `expiry_height < H`
(`daemon/src/shield_v2.rs:320`; `shield_v2::tests` asserts "valid at the expiry height itself";
the interop test asserts the same for a wallet-built transfer, `node.rs:15981–15982`), and the
wallet releases iff the height it has scanned THROUGH is `≥ expiry_height`. Block `expiry` has
then been read; block `expiry + 1` cannot hold the transaction. The node's listing reports
`next_height` as the first height not fully listed, at a block boundary. No off-by-one
(`rw2_sound_the_release_height_…`).
(c) *Permanently locked:* only the migrated format-1 lock (I-2). A lock made by `mark_pending`
always has an expiry at most 128 blocks above the scanned height.
(d) *`Confirmed` defeated by lies about height or roots:* not by a lie about the height — it
waits for the quorum's height. By a lie about nullifiers: RW2-2. By two names of one node: by
construction.
(e) *The expected-change bookkeeping:* there is none. `PendingChange` is written by the builder,
validated by nobody and read by nothing; change is credited only when the scan decrypts it, so
no change is credited that was not listed. It is exactly the datum whose use would close
RW2-1/2/3.

**Root quorum.** A "distinct node" is a caller-supplied string. Replayed or stale reports can
only confirm notes at or below a height whose root the wallet itself holds; they cannot
un-confirm and cannot confirm a later note. Heights outside the 256-checkpoint history or above
the scan are `not_comparable`. `confirmed` does not survive `fresh_for_rescan` or a migration.
Default coin selection never returns an unverified or a locked note. The four balances do not
double-count (`locked` is a part of `confirmed + unverified`; `spendable` is confirmed and
unlocked). Defects: RW2-4, RW2-6; and a `confirmed` note is not thereby unspent (RW2-2).

**Address format.** 1,225 bytes are exactly 1,960 characters: no padding bits. The decoder
accepts the encoder's output, its all-upper-case form and surrounding white space, and each
re-encodes to the canonical string; mixed case, inner white space and a wrapped line are refused.
Every single-character change tried (1,674 of them) is refused. The stated guarantee is accurate:
single-character damage always, anything else that passes the checksum with probability 2^-64
unless searched for. Version byte and domain tag are inside the hash. The vectors test
regenerates `keys.json` and compares (passes).

**Hedged randomness.** One generator per transaction; every draw goes through it (the builders
call the operating system once, in `Hedged::new`; `encrypt_note` and `encrypt_to_nobody` take
their randomness as arguments). `info = label ‖ slot ‖ draw number`: the draw number alone makes
every `info` of a transaction unique. The spending key enters only as HMAC message under the OS
bytes; outputs are HKDF-Expand of the result — what a payee receives (`r`, and the ML-KEM `m` it
can recover) is two PRF outputs under a key it does not have. **The restart case:** every value
that enters the body is in the transcript, so with the counter back at 0 and the generator
repeating, the same request gives the same 2,546 bytes (the same transaction: nothing to learn),
and a retry after expiry — which necessarily has another `expiry_height` — shares no `r`, no
encapsulation, no ciphertext, no commitment and no dummy nullifier with the first attempt; only
the real input's nullifier, which is inherent. The counter does not survive a restart and does
not need to. Tested with real child processes
(`rw2_sound_f5_after_a_restart_…`). Residual: I-6.

**The rest of item 5.** Blind scan: exact in both directions, bounded (I-7). Listing: every
string validated before the state is touched; page, transaction and report caps hold;
`scan_pages` is all-or-nothing. Errors: fixed sentences; `Debug` of every type holding `r` or a
key is redacted or absent (`WalletError`'s derived `Debug` prints the two amounts of
`InsufficientFunds`; `Display` does not). `max_fee`: applied before any work; default 10 XRGE.
Expiry bound: enforced by the builder and again by `mark_pending`. Zero-value notes: not stored,
not tracked. State size: RW2-7.

## 3. The compile-time guard

`PROVER_COMPILED` is `cfg!(feature = "prover")` evaluated in the verifier crate; the assertion
is in a module of the daemon that every build compiles, skipped under `cfg(test)` only. One build
has one copy of the crate (the daemon has it as a normal dependency only), so no selection gives
the daemon a prover-less view of a prover build.

| Procedure (where it is written) | Daemon's feature set | Outcome |
|---|---|---|
| `cargo build --release [--locked] -p quantum-vault-daemon` (installer, `auto-deploy.sh`, all of `docs/running-a-node/`, release notes) | `default` | builds, no prover |
| `cargo build --release -p quantum-vault-daemon -p quantum-vault-cli` (`Dockerfile`) | `default` | builds, no prover |
| `cargo build --release` in `core/` (`deploy-srv421059.sh`, `QUICK_START_VPS.sh`, `core/README.md`) | `default` (default members) | builds, no prover |
| `--workspace`, or `-p` daemon together with a wallet crate | `prover` | **compile error** (intended) |
| `--all-targets` (build, check, clippy) | `prover` via dev-dependencies | **compile error** (I-9) |
| `cargo test -p quantum-vault-daemon`, `cargo test --workspace` (`core/README.md:280`) | `prover` | test harness only; no node binary is produced |

No package selection, feature flag, profile or target was found that produces a node binary with
the prover. Verified by `cargo tree`, not by compiling the daemon (section 6).

## 4. Checked and found sound (list)

Lock persistence through JSON and rescan; refusal of a second `mark_pending`; `mark_pending`
validation (nullifier, total, expiry bound, distinct inputs); the release height against the
node's rule; `Confirmed` against a height lie; balances; default selection; checkpoint history
bounds and ordering; migration (notes unverified, zero-value dropped, hash cleared, lock kept);
address canonical form, single-character detection, version handling, vectors; hedge domain
separation, key non-leakage by construction, restart behaviour; blind log; listing caps; error
texts; fee ceiling; expiry bound; the guard against every documented build procedure; the wallet
CI step in its exact combined form.

## 5. Tests added

| File | Tests | Result on 60d1e2b |
|---|---|---|
| `core/shield-v2-wallet/tests/review_wallet_2.rs` | 8 | 4 pass, **4 fail on purpose** (`rw2_f1`, `rw2_f2`, `rw2_f3`, `rw2_f4`) |
| `core/shield-v2-wallet/src/review_wallet_2_tests.rs` (included from `tx.rs` under `cfg(test)`) | 3 | 3 pass (one is the child half of the restart test and does nothing by itself) |

The only change to non-test source is six lines at the end of `core/shield-v2-wallet/src/tx.rs`
that include the in-crate test module under `#[cfg(test)]`. The restart test runs the test binary
as a child process per transaction; it changes nothing in the crate.

**`cargo test` on the wallet crate, and the last CI step, now exit non-zero** because of the four
regression tests. That is intended; each says "FAILS on 60d1e2b" in its comment.

Commands, each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p
CPUWeight=10 nice -n 19 cargo … --release --locked --offline -j 1`, in the foreground, one at a
time (`cargo tree` has neither `--release` nor `-j`):

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm --no-run` | builds (2 m 58 s) |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` (the CI step's form) | 57 tests: **53 passed, 4 failed**, 0 ignored — wallet unit 20/20, `review_wallet_1` 14/14, `review_wallet_2` 4 passed + 4 failed, `vectors` 3/3, `wallet_flow` 6/6; wasm `api` 2/2, wasm `review_wallet_1` 4/4 |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --test review_wallet_2 --no-fail-fast -- --test-threads=1 --nocapture` (after the last edit to a test message) | 4 passed, 4 failed; the messages quoted above |
| `cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2` | `default` only |
| the same with `-e normal,build,dev,features` | `default`, `prover`, `test-prover` |
| `cargo tree -e normal,build,features -i quantum-vault-shield-v2` (default members) | `default` only |
| the same with `--workspace` | `default`, `prover` |
| the same with `-p quantum-vault-daemon -p quantum-vault-cli` | `default` only |
| `cargo tree -p …-wallet --features test-vectors -p …-wasm -e normal,build,dev,features` | the daemon is not in the graph |

## 6. Out of reach

* **The daemon was not compiled or tested here** (its release build is long on this host, and
  nothing in it was changed): the node's expiry rule, the listing and the stats handler were
  read, not run; the guard was checked with `cargo tree` and by reading, not by provoking the
  compile error; the duration of the daemon CI step in a debug build is unknown.
* The shield-v2 crate's own suites (with and without `test-prover`) were not re-run.
* Nothing was run as WebAssembly (no `wasm-bindgen-cli` here); the wasm surface was tested
  natively, as before. No new wasm test was added: the defects are in the core, and the wasm
  exports forward to it (`resolve_pending`, `confirm_roots`, `rescan_state`).
* The GitHub workflow was read and one step run locally in its exact form; it was not run on
  GitHub.
* Timing side channels and the zero-knowledge of the proof library: outside this review, as in
  the first.

---

## Resolution (2026-10-06)

Written by the author of the fixes, not by the reviewer. Everything above is the review as it was
delivered and describes `60d1e2b`; where it says a test "fails", "passes: documented limit" or
names a line of `store.rs`, that is the state it found. Branch `fix/shield-v2-wallet-settlement`
(local, from `review/shield-v2-wallet-2` @ `5a6e7c4`). **The redesign below has not been reviewed
by a second person.** Nothing was deployed, pushed or run against a network node.

The settlement of pending transactions was redesigned, not patched. The principle: *the wallet
believes nothing about a transaction's fate that it cannot tie to data a quorum of nodes vouches
for.*

### Settlement rules as implemented (`WalletState::resolve`; spec §5.5, W-15)

`C` is the confirmed height: the highest height at which `confirm_state` found a quorum of
distinct nodes reporting exactly the wallet's tree root, nullifier hash, note count and nullifier
count, with no conflicting report in the call.

| Outcome | Condition | Effect on the inputs |
|---|---|---|
| `mined` | a listed transaction at a height ≤ `C` has BOTH nullifiers and BOTH output commitments of the entry | spent; the change is a confirmed note |
| `superseded` | a different listed transaction at a height ≤ `C` has one of its nullifiers | only those whose own nullifier appeared are spent; the others are released |
| `expired` | `C ≥ expiry_height` and none of its nullifiers appeared up to `C` | all released |
| stays pending | anything else — seen above `C`, a "rejected" answer, a scanned height nobody confirmed, no `C` | locked |

### Findings

| Finding | Resolution | Commit | Test now |
|---|---|---|---|
| RW2-1 (High) | `scan` no longer settles anything: it records `seen_mined` / `seen_superseded` with the height. `resolve` settles only at a height ≤ the confirmed height and never drops an entry seen above it. `fresh_for_rescan` carries every entry over as `pending` and locked (locks are held by note commitment, so they apply as soon as the rescan finds the note). `ReleasePolicy` is removed | `3c59c05` (core), `b11d073` (wasm) | `rw2_f1_a_listing_that_shows_the_pending_tx_mined_never_unlocks_and_bob_is_paid_exactly_once`: both recovery orders × both ends (never released → `expired` after the confirmed expiry, funds intact, one retry; released at the last valid height → `mined`, no retry offered); Bob holds 4 XRGE in all four |
| RW2-2 (High) | The wallet rebuilds the pool's running nullifier hash from the listing (the pool's own `nullifier_acc_step`) and keeps it per height; `confirm_state` requires root AND hash AND both counts. "Mined" is decided by the entry's own two nullifiers together with its own two output commitments. The wrong spec sentence is withdrawn | `769da1b`, `3c59c05`; spec `3e0ddae` | `rw2_f2_swapped_nullifiers_are_not_confirmed_and_a_mined_tx_is_never_called_expired`, `rw2_f2_a_hidden_spend_cannot_be_confirmed`; against a real node: `node::shield_v2_wallet_interop_tests` (hash equality after every block; a report with the right root and another hash is a conflict) |
| RW2-3 (Medium) | A note is marked spent only when its own nullifier appears (for a pending input: the entry's nullifier of that input slot). An entry one of whose nullifiers appears in another transaction is `superseded`; its other input is released | `3c59c05` | `rw2_f3_another_transaction_spending_one_input_supersedes_the_pending_tx_and_frees_the_other_input`, `rw2_f3_the_same_two_inputs_on_two_devices_are_told_apart_by_the_outputs` |
| RW2-4 (Low) | Any report that differs from the wallet's state at a comparable height (or one node reporting two things) ⇒ nothing is confirmed by that call, at any height, and `diverged` is returned with `conflicts`. The quorum is `max(asked, strict majority of the distinct node ids in the call)`, default 2. Documented: the caller chooses the nodes; a node id is the configured endpoint, never a string a node returned | `3c59c05`, `b11d073`; spec `3e0ddae` | `rw2_f4_a_conflict_confirms_nothing_and_the_quorum_is_a_majority_of_the_nodes_asked` |
| RW2-5 (Low) | `ReleasePolicy::Scanned` no longer exists, in the core or in the wasm surface (`resolve_pending(state, expected_revision)` has no flag); it was not kept under `cfg(test)` — no test needs it. The fresh-state jump is unchanged and is harmless now: a page that skips history gives a state no honest node confirms | `3c59c05`, `b11d073` | `rw2_f5_one_empty_page_that_lies_about_the_height_releases_nothing` (was `rw2_demo_…`) |
| RW2-6 (Low) | `/api/shield-v2/stats` returns `report: { height, tree_root, nullifier_acc, note_count, nullifier_count }` from ONE read of the pool record; `height` is the record's `next_height − 1`. Existing fields unchanged. API only | `f71cd8e` | `node::shield_v2_daemon_tests` (the report against the pool), interop tests (wallets confirm from it) |
| RW2-7 (Low) | Notes are stored as one array of ten values (no recomputable flags); Merkle paths share one node map; spent notes are pruned 256 blocks below the confirmed height into a tally; incoming notes below `min_note_value` (default: the minimum fee) or beyond 65,536 stored notes are counted, not stored; `to_json` checks the size `from_json` accepts and cannot reach it | `3c59c05`, `b11d073` | `rw2_f7_dust_is_counted_not_stored_and_a_stored_note_costs_a_quarter_of_what_it_did`, `rw2_f7_pruning_spent_notes_keeps_every_balance_exact`, `store::tests::tracker_*` |
| RW2-8 (Low) | CI: the shield-v2 step runs with `--features test-prover` (plus a default-feature run); the daemon's four proof-making modules run in `--release` by name filter and are skipped by name in the debug step. **The choice:** split, not "whole daemon in release" — 272 of 296 daemon tests never touch a proof | `11787e9` | not run on GitHub; see "CI" below |

Figures for RW2-7 (measured by the test, 241 notes of exactly the minimum note value, one per
transaction): **598 bytes of state JSON per stored note** (3.1 shared tree nodes each; was 2,718
bytes). A note below the minimum costs the state two counters. With the default minimum a stored
note costs its sender at least 1 XRGE of value, which the victim receives, plus half a fee:
**1 MB of victim state = 1,672 notes = 836 XRGE in fees + 1,672 XRGE handed to the victim**
(before: 368 one-quantum notes for 184 XRGE in fees). The cap of 65,536 stored notes is ≈ 39 MB.

### Info items

| # | Status | What was done, or why not | Commit |
|---|---|---|---|
| I-1 | fixed (documentation) | Spec §4.3 item 8 annotated and §5.5 rewritten: the anchor window does not bound a transaction's life, `expiry_height` does; the false clause in REVIEW_WALLET_1 §3 is annotated in place; the doc comment of `MAX_EXPIRY_OFFSET` says it. The native builders still take `anchor_height` on the caller's word — `mark_pending` re-checks against the scanned height, as before | `3e0ddae`, `3c59c05` |
| I-2 | fixed | A migrated lock without an expiry gets `expiry_height` = the old state's scanned height + 128 and settles by the confirmed rules. Residual, stated: format 1 did not bound the expiry it accepted; no client was released on it | `3c59c05` |
| I-3 | fixed in the core, half of it left to the client | The state has a `revision`; every changing wasm call takes `expected_revision` and returns `revision`; a stale copy is refused with `stale_state:`. The compare-and-swap at the moment of storing is the client's storage transaction and is documented, not built. Two devices cannot share locks: that is `superseded` | `3c59c05`, `b11d073` |
| I-4 | fixed | `spend_input` refuses an unconfirmed note (`NoteUnverified`); `spend_input_with(.., true)` and the wasm parameter `allow_unverified: true` are the explicit decision | `3c59c05`, `b11d073` |
| I-5 | fixed | Locks are held by the input note's commitment (`input_cms`) and follow the note to whatever position a rescan finds it at. Exception, stated: a format-2 state that was itself in the middle of a rescan is migrated with position locks, as it held them | `3c59c05` |
| I-6 | left, documented | A shield has no spending key to hedge with; `NOTES.md` §9 states the limit. Changing it would change what a shield's randomness is derived from (spec §5.6) — out of scope here | — |
| I-7 | left | A cost, not an error; the bound and the `rescan_required` answer are unchanged | — |
| I-8 | left | The proof library's own error text; no path found by which it holds witness data. Not changed: that enum is shared with the node-side crate | — |
| I-9 | documented | One line next to the `--workspace` remark in `docs/running-a-node/upgrade-schedule.md` | `3e0ddae` |
| I-10 | left, now detected | The node's listing still skips a height whose block is missing (node code, outside "API-only changes where stated"). A wallet no longer has to wait for the next leaf mismatch: the skipped transactions make its state one no honest node confirms (`diverged`) | — |
| I-11 | fixed for the part that was not acceptable | "Refuse and rescan" is safe now (RW2-1). The 8-byte fingerprint, the same address on every network and no replacement of a pending transaction are left, as the review allows | `3c59c05` |

### State format 3

`revision`; `min_note_value`; the tree as `tracked` + one shared `nodes` map; `nullifier_acc` and
`nullifier_count`; notes as ten-value arrays; pending entries with `outputs`, `input_cms`,
`status` (`pending` / `seen_mined` / `seen_superseded`), `seen_height`, `legacy`; checkpoints with
root, nullifier hash and both counts; three tallies (`below_minimum`, `over_capacity`, `pruned`).
Full table: `NOTES.md` §11.

**Migration.** Formats 1 and 2 have no nullifier hash and it cannot be computed afterwards, so
both migrate to an EMPTY format-3 state that keeps the locks, to be scanned from the activation
height. From 2: every pending entry stays, as pending and locked — also one called `mined`; it
settles as mined on its nullifier pair plus its change commitment. From 1: every locally marked
note becomes a `legacy` lock with the synthetic expiry above. Tests:
`rw1_f7_a_format_1_state_is_migrated_with_its_local_marks_kept_as_locks` (1 → 3),
`rw2_a_format_2_state_is_migrated_with_every_pending_entry_locked` (2 → 3), and both inside the
property test.

### Tests added or converted

* `tests/review_wallet_2.rs`: 14 tests, all passing — the four `rw2_f*` that failed on purpose
  are converted to the safe outcome end to end; `rw2_demo_…` became `rw2_f5_…`; added
  `rw2_f2_a_hidden_spend…`, `rw2_f3_the_same_two_inputs…`, `rw2_f7_pruning…`, `rw2_i3_…` (revision
  conflict), `rw2_i4_i5_…`, `rw2_a_format_2_state_is_migrated…`.
* `tests/settlement_properties.rs` (new): 40 runs of 260 random steps over {honest page, five
  kinds of lying page, state checks with honest / lying / conflicting reports, `mark_pending`
  with the transaction mined, withheld or released late, `resolve`, `fresh_for_rescan`, JSON
  round-trip, migration from 1 or 2, a second device spending}, against the true chain. Invariants
  after every step: no note is an input of two transactions that are unsettled or mined; the
  confirmed balance never exceeds the true balance at the confirmed height; every settlement is
  the truth. One run of it: 563 lying pages accepted, 622 diverged checks, 490 payments (253
  withheld, 38 released late), 315 second-device payments, 173 migrations, settled 158 mined /
  204 expired / 141 superseded. Three deliberate mutations of the core (settle on the scanned
  height; confirm on the root alone; call any nullifier match mined) were each caught by it and
  by the `rw2_f*` tests, then reverted.
* `tests/review_wallet_1.rs`: all 14 still pass, adapted to confirmed settlement, state reports
  and format 3. One assertion there (`rw1_sound_every_byte_…`) failed whenever the dummy output
  drew slot 0 — it searched the `Debug` text for the value "0" — and is fixed.
* Daemon: `shield_v2_stats` report checked against the pool; the interop harness reads the report
  through the stats handler and compares the wallet's nullifier hash with the node's
  `nullifier_acc` after every block.

### Commands run after the fixes

Each as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice
-n 19 cargo … --release --locked --offline -j 1`, in the foreground, one at a time (`cargo tree`
has neither `--release` nor `-j`):

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` (the CI step's form) | **65 passed, 0 failed, 0 ignored**: wallet 59 (unit 21; `review_wallet_1` 14; `review_wallet_2` 14; `settlement_properties` 1; `vectors` 3; `wallet_flow` 6), wasm 6 (`api` 2; `review_wallet_1` 4) |
| `cargo build -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown` | builds; 2,525,521 bytes |
| `cargo test -p quantum-vault-shield-v2 -- --test-threads=1` | 35 passed, 0 failed, 0 ignored |
| `cargo test -p quantum-vault-shield-v2 --features test-prover …`, in five invocations that together are the whole suite — one invocation does not fit the 10-minute limit of a foreground command on this host: `--lib --test prover --test forgery --test negative` (stopped by that limit inside `negative`, after the unit tests and `forgery` had passed); `--test negative -- n0`; `--test negative -- n1`; `--test prover`; `--test pool --test review2_wrapper --test review_node_1 --test review_verifier --test vectors` | 71 passed, 0 failed, 1 ignored (the timing measurement, as before): lib 6, `forgery` 10, `negative` 9 + 8, `prover` 4 (+1 ignored), `pool` 17, `review2_wrapper` 5, `review_node_1` 3, `review_verifier` 3, `vectors` 6 |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_daemon_tests --test-threads=1` | 9 passed |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_review_node_1_tests --test-threads=1` | 5 passed |
| `cargo test -p quantum-vault-daemon -- shield_v2::tests --test-threads=1` | 6 passed |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_wallet_interop_tests node::shield_v2_daemon_tests node::shield_v2_review_node_1_tests shield_v2::tests --test-threads=1` (the new CI step's form) | 24 passed, 272 filtered out |
| `cargo test -p quantum-vault-daemon -- --skip node::shield_v2_wallet_interop_tests --skip node::shield_v2_daemon_tests --skip node::shield_v2_review_node_1_tests --skip shield_v2::tests --list` | 272 tests listed (the debug CI step's selection; not run) |
| `cargo build -p quantum-vault-daemon` | builds (the node, default features) |
| `cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2` | `default` only |
| the same with `-e normal,build,dev,features` | `default`, `prover`, `test-prover` |
| `cargo tree -e normal,build,features -i quantum-vault-shield-v2` (default members) | `default` only |
| `cargo tree -p quantum-vault-shield-v2 --features test-prover -e normal,build,dev,features` | the daemon is not in the graph |
| `cargo tree -p …-wallet --features test-vectors -p …-wasm -e normal,build,dev,features` | the daemon is not in the graph |
| `NOBLE_ROOT=… node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 |

The daemon and shield-v2 runs were made before the documentation commits; no Rust source changed
after them. The wallet and wasm suites were run last.

### CI (RW2-8), by reasoning — GitHub Actions was not run

| Step | Packages / features | What it now does |
|---|---|---|
| Build (default members) | shield-v2 `default`; dev-dependencies not built | unchanged; the guard holds |
| Test (node crates) | none depends on shield-v2 | unchanged |
| Test (daemon, without the proof-making modules) | `-p quantum-vault-daemon`, debug; shield-v2 = `default` + `prover` + `test-prover` through dev-dependencies; test harness only, no node binary | 272 tests; the four modules skipped by name make no proof here |
| Test (daemon, shielded pool V2 modules) | the same package and features, `--release` | 24 tests by name filter; run here in this form |
| Test (shield-v2, `--features test-prover`) | `-p quantum-vault-shield-v2` only; the feature is this package's; the daemon is not selected | the prover unit tests and `prover`, `forgery`, `negative` now run, the source scan for a public seed parameter among them (`no_public_function_takes_a_seed_outside_the_test_configuration`: passes) |
| Test (shield-v2, default features) | `-p quantum-vault-shield-v2`, `default` | the verifier as the node links it; what the step ran before |
| Test (wallet core) | unchanged form | run here in this form |

Cost on a runner, not measured: the test-prover suite took about 20 minutes here under
`nice -n 19 -j 1`, the default-feature run about 8.

### What remains trust in nodes

* **Everything "confirmed" is the word of the nodes the client asked.** A strict majority of them
  lying together is believed: a forged incoming note becomes confirmed, a transaction can be
  settled as expired while it can still be mined, or as mined when it was not. One operator behind
  most of the configured endpoints is such a majority. There is no light-client proof anywhere.
* **The confirmed balance is exact as of the confirmed height, not of the tip.** A spend above it
  that the listing node hides is unknown until a later height is confirmed — and with that node's
  listing none will be (`diverged`).
* **Liveness is the node's to take.** A node that withholds a transaction, or a client that cannot
  reach an agreeing quorum at one height, keeps notes locked: there is no fallback to one node.
  With the default expiry the lock lasts until a height 64 blocks after the build is confirmed.
* **The pending record is the client's.** `mark_pending` checks it against the state (inputs,
  nullifiers per input, total, expiry bound, change among the outputs) but not against the
  transaction body, which it never sees: a client that records another transaction's outputs
  would see its own payment as `superseded`.
* **A second payment from other notes** while the first is pending is the user's; the core
  refuses only to call the first one dead before it is.

### Not done

* No second review of this redesign.
* GitHub Actions not run; nothing run as WebAssembly (no `wasm-bindgen-cli` here) — the wasm
  surface was tested natively and the `wasm32` release artifact was built.
* The debug-profile daemon CI step was not run (its selection was listed).
* I-6, I-7, I-8 and I-10 are left as the table says. No client (site, extension, Qwalla) was
  touched; the storage-side compare-and-swap of I-3 is theirs to build.
* Not pushed; no pull request.
