# Fork decision package — issue #66 (Option A vs Option B)

**Purpose:** exact, machine-derived numbers so the economic state transition can be chosen
consciously. **No option is selected here. Nothing is implemented, deployed, restarted or
merged.** Sources: read-only mainnet snapshot 2026-09-18 (tip 48), production `snapshot-db`
maps at 48, canonical replay maps at every height (validation harness on
`bridge-r1-integration-validation`, node key = genesis authority so the result equals the
candidate's authority-gated execution; identity-independent root at 18 = `99a37ecc…`), and the
committed block headers. Quanta = 1e-9 XRGE.

## DECISION: OPTION B SELECTED (2026-09-19). Implementation: `fork.rs`, `fork_tables.rs` (F = 49). See FORK_IMPLEMENTATION.md.

## 0. Frozen conclusion
`roots[18..48] ≠ f(genesis, blocks, canonical rules)`. Causes (established): retired
non-canonical balance-key layouts; split balance buckets; restart-rebuild fee mis-accounting
(sum-delta); the resulting phantom credits (exact figure below); historical accept/no-op
outcomes that depended on that old state; pre-genesis/restored operational artifacts;
node-identity-dependent mint gating (fixed prospectively). Historical blocks and roots are not
edited.

## 1. h5 / h10 historical withdrawals — classification
| | h5 | h10 |
|---|---|---|
| L1 burn | 250 XRGE, tx `xrge:46bc846f…`, 2026-08-17 04:48:48Z | 1 XRGE, tx `xrge:51305628…`, 2026-09-03 16:08:16Z |
| **Classification** | **Paid** | **Paid** |
| Base tx | `0x9527ac1ded2e7bf46bf96365f52889bfce154e3de3a09263afd42fcc95387a47` | `0xe2af0109d544d9eef6c1e864d121052858e96b545fa90f03730e7d2c620e7c68` |
| XRGE token | `0x147120faec9277ec02d957584cfcd92b56a24317` (daemon `XRGE_TOKEN_ADDRESS`) | same |
| Source / payer | XRGE bridge vault `0xb3f52f2c1bd5692494655cf59d8ee296d23bfab5` (tx.to == vault) | same vault |
| Recipient | `0xd047e9ade4d31022d741b57aaff5bb484a2c745a` | `0x1cf7f96f871de10f325dd0b80bbc75c1e9734c2e` |
| Amount | 250.000000000000000000 XRGE (250e18 wei) | 1.000000000000000000 XRGE |
| Receipt | status 0x1 | status 0x1 |
| Block / confirmations | Base 50076394, 2026-08-17 04:48:55Z (7 s after burn), 1,403,385 conf | Base 50831180, 2026-09-03 16:08:27Z (11 s after burn), 649,050 conf |
| Store record | none (pre-store/claim-path era) — informational only | none; `bridge_claimed.json` entry present |
Cross-check: the h10 recipient's complete XRGE-vault payout history is exactly one payout per
burn (h10, h12 from the current vault; h13, h17, h18 from legacy payer `0x7bb1…cd2d`) — no double
payment. Evidence files: `h5-onchain.json`, `h10-onchain.json` (public RPC only).

## 2. Ledgers at height 48
| | CURRENT PRODUCTION | CANONICAL REPLAY |
|---|---|---|
| native ledger total | **178,438.965087099 XRGE** (178438965087099 q) | **168,183.885987828 XRGE** (168183885987828 q) |
| committed / computed root at 48 | `f5af35d889618c9dbdab5e350eab84f8f36b291c57543a361977acdd82d793b1` (header) | `402ddd06…` is the hash-of-hashes; per-height computed root at 48 in `canon.jsonl` |
| token_balances / lp_balances / burned_tokens / pool reserves | identical to canonical | identical to production |
| `fees_burned` accumulator (not a balance; pinned as f64 bits and migrated with the ledger, §11) | 0.21323826751842256 | 0.11401217199999998 |
| accounts with a native-balance difference | 4 (+1 zero-value key) | — |

## 3. OPTION A — checkpoint history, preserve live balances
Transition at F applied to the canonical ledger to reach production's ledger (delta = production − canonical):
| account (canonical rouge1 address) | role | canonical (q) | production (q) | delta (q) | delta XRGE | category |
|---|---|---|---|---|---|---|
| `__treasury__` | treasury sentinel | 2148598808 | 1027656508750 | **+1025507909942** | +1025.507909942 | phantom fee distribution (restart-rebuild sum-delta bug) |
| `rouge168fd0mad4eynev767u896zx5ng2dnh7eztw9cj24tjn8f6e5t7fsgh8qxj` | proposer + genesis validator `8ccf7878…` (stake 100000) | 18066021023 | 8594150175817 | **+8576084154794** | +8576.084154794 | phantom fee distribution |
| `rouge19emhc0secrj0uadfvmp5xvun5jta9kpm0laff28x04ug4szf50nq5aer4c` | staked validator `21e0ed0a…` (10000 @h20) | 10000271367997 | 10652883715831 | **+652612347834** | +652.612347834 | phantom fee distribution |
| `rouge1qm85k7gmudsrz46crku2zh03j7lx4xyg4adhkhxau2vx25qe97aqvvc378` | `c97f59a2…` (h29 stake FAILED atomically under canonical rules: no debit, no validator entry) | 10000000000000 | 10000874686701 | **+874686701** | +0.874686701 | fee shares earned by unbacked (phantom) validator power h30–h48 |
| `rouge1jfdeh3famu8dk6mwhx29lp7ywyun5qc0ptagr9290mg9kur380aqnak7vg` | user (h21 sender) | 0 | absent | 0 | 0 | key-presence artifact only (no value) |
| **sum positive deltas** | | | | **+10255079099271** | **+10,255.079099271 XRGE** | |
| **sum negative deltas** | | | | 0 | 0 | |
| **net delta** | | | | **+10255079099271** | **+10,255.079099271 XRGE** | |
No split-bucket value differences exist at 48 (production's `038336b`/`38f6cdf` rebuilds already
merged them; the only trace is the zero-value key). Token, LP, burned and pool state need no
transition. **Supply:** Option A does NOT preserve the protocol supply identity — it explicitly
enshrines 10,255.079099271 XRGE that no mint/faucet/fee ever created (see §6); after F the
identity holds relative to that adjusted base.

## 4. OPTION B — adopt canonical deterministic re-execution state
Transition at F applied to production's live ledger (delta = canonical − production): the same
rows with signs reversed — `__treasury__` −1025.507909942; `rouge168fd…` −8576.084154794;
`rouge19emhc…` −652.612347834; `rouge1qm85…` −0.874686701; sum positive 0; sum negative
**−10,255.079099271 XRGE**; net **−10,255.079099271 XRGE** (total unchanged by the validator fix; the
phantom pool only re-splits once `c97f59a2…` holds no validator power). Nothing else changes in the
ledger (token/LP/burned/pool identical). **Validator state also transitions** (§11): `c97f59a2…`
(10,000 unbacked power) is removed; total stake 120,000 → 110,000; quorum 80,001 → 73,334.

### Transactions with differing outcomes — COMPLETE TABLE
Method: for 18..48 the historical outcome is inferred from the committed roots (unchanged root
across a balance-affecting tx ⇒ no-op) and the canonical outcome from the replay roots; for
1..17 (no committed roots) the final-balance agreement on every non-phantom account proves the
effects coincide.
| height | tx | type | historical/live outcome | canonical outcome | economic effect | affected accounts |
|---|---|---|---|---|---|---|
| 28 | `unshield` from `2a152293…` (1 XRGE) | unshield | NO-OP (root 27 == 28) | NO-OP | none | none |
| 29 | `stake` from `c97f59a2…` (10000 + 1 fee) | stake | ledger NO-OP (root 28 == 29; balance 10,000.87 < 10,001) **but validator store credited 10,000 of power** (validator-state atomicity bug) | FAILED atomically: no debit, no validator entry, receipt = failure | −10,000 validator power (never ledger-backed) | validator set only |
| every other height 1..48 | — | — | applied | applied | identical | — |
**Result: zero transactions change ledger outcome under Option B; exactly one (h29) changes validator-state
outcome.** The earlier working note that h24/h25 might differ is withdrawn — the outcome table shows they do
not. Option B changes balances only through removal of the phantom credits (incl. the 0.874686701 XRGE of
fee shares the phantom validator earned h30–h48).

## 5. Economic comparison (quantified)
| | Option A | Option B |
|---|---|---|
| visible balance changes at F | none (4 accounts keep +10,255.079099271 XRGE) | `__treasury__` −1025.507909942; genesis validator/proposer −8576.084154794; validator `21e0ed0a…` −652.612347834; `c97f59a2…` −0.874686701 |
| validator set at F | unchanged (120,000 incl. 10,000 unbacked) | `c97f59a2…` removed; 110,000 backed; quorum 73,334 |
| users affected | 0 end-users; 3 protocol/validator accounts unchanged | 0 end-users; treasury + 3 validator accounts reduced (all funds are phantom, never minted) |
| historical tx outcomes | preserved (they are identical anyway) | preserved (identical) |
| supply identity | violated by +10,255.079099271 XRGE, enshrined at F | restored exactly |
| what must be encoded in consensus | pinned roots 18..F−1 + the 5-row delta table (hash-frozen) | pinned/informational roots 18..F−1 + canonical rebuild rule at F |
| determinism after F | full | full |
| bridge-relevant | none (XRGE burns/mints identical) | none |

## 6. Supply / accounting reconciliation (native XRGE, whole history) — CORRECTED, exact in quanta
Every term maps to a persisted state component or an explicitly identified sink:
| term | state component | quanta |
|---|---|---|
| bridge_mint XRGE (h3–h44) | block contents | 55,123,564,000,000,000 |
| faucet (h1, h2) | block contents | 101,000,000,000 |
| **inflows** | | **55,123,665,000,000,000** |
| native ledger | `balances` map | 168,183,885,987,828 |
| stake debited from the ledger | h20 `stake` (validator store entry for `21e0ed0a…`). h29 `stake` FAILS atomically under the fixed rules (10,000.87 < 10,001): no debit, no validator entry. Canonical validator total = genesis 100,000 (never a ledger debit) + 10,000 = **110,000, all backed**; production's extra 10,000 for `c97f59a2…` is removed by VALIDATOR_TRANSITION | 10,000,000,000,000 |
| shielded supply | `shielded_supply` (snapshot-db) — **0**, not 1: every unshield reduced the supply by its full value | 0 |
| AMM XRGE reserve | `pool_store["XRGE-qUSDC"].reserve_a` = 54,945,220 XRGE (identical in both ledgers) | 54,945,220,000,000,000 |
| bridge_withdraw burns | `burned_tokens["XRGE"]` = 255 | 255,000,000,000 |
| base-fee burns | `fees_burned` (fee_db/snapshot) | 114,012,172 |
| **implicit sinks (value destroyed, in NO state bucket)** | see below | **6,000,000,000** |
| **sum** | | **55,123,665,000,000,000** ✓ exact |
Implicit sinks (pre-existing implementation behaviour, identical in production and canonical, unaffected by the fork):
- **unshield fee sink, 4 XRGE:** an `unshield` reduces `shielded_supply` by the full value but credits `value − 1` (the 1-XRGE fee is neither burned into `fees_burned` nor distributed): h28 (value 1 → credit 0, root unchanged), h32, h34, h36 (1 XRGE each).
- **AMM sinks, 2 XRGE:** h46 `remove_liquidity` released the whole 55,000,000 XRGE reserve (pool → 0) but credited 54,999,999; h48 `swap` released 54,780 from the reserve (55,000,000 → 54,945,220) but credited 54,779.
The earlier "5.000000000 XRGE AMM residual" statement was wrong (it assumed shielded = 1 and did not separate the sinks); it did NOT double-count the reserve. Production = the same identity **plus 10,255,079,099,271 quanta of phantom native balance** created by no inflow (and `fees_burned` 213,238,268 vs 114,012,172 for the same reason). After Option B: phantom = 0 and the identity above holds unchanged.

## 7. Fork mechanics (design only)
**Common:** a single `FORK_F` constant; no runtime flag can skip verification; checkpoint data
are `const` tables compiled into the binary and covered by a unit test that hashes them
(`CHECKPOINT_TABLE_SHA256`) so any edit changes the build fingerprint; the tables are generated
by a reproducible script from the committed fixture blocks and reviewed in the fork PR.
**Option A:** `import_block` for `18 ≤ h < F`: verify `header.state_root == CHECKPOINT_ROOT[h]`
(equality against the immutable constant) instead of recomputing; state is still applied
canonically (so the node's ledger tracks canonical execution). At `h == F` (a normal block): after
applying its txs, apply the constant `IRREGULAR_STATE_DELTA` (the §3 rows) then compute the root;
the producer must commit exactly that root; `h > F`: normal recompute-and-verify. Roots 18..F−1
are thus accepted only through explicit immutable checkpoint commitments.
**Option B:** for `18 ≤ h < F` the same checkpoint-equality rule (history is accepted as
recorded, not recomputed); at `F` the producer's live node must already hold the canonical
ledger: it reaches it by an explicit, operator-invoked, logged one-time `--migrate-canonical-ledger`
that (a) verifies the current ledger equals `PRODUCTION_LEDGER_AT_F−1` (frozen constant table),
(b) applies the constant `CANONICAL_DELTA` (§4 rows, sign-reversed §3), (c) writes the snapshot;
block F's root is computed over the migrated ledger and must equal `CANONICAL_ROOT_F` (constant);
`h > F` normal. No rebuild-on-restart is involved; refusal if (a) fails.

## 8. Fresh-node sync (both options)
genesis → import 1..17 (recompute+verify none, as today) → import 18..F−1 (apply canonically,
verify header root against `CHECKPOINT_ROOT[h]`) → at F apply the constant delta (A) or verify
`CANONICAL_ROOT_F` (B) → F+1.. normal. All inputs are public chain data + compiled constants;
no operator DB, no node identity (authority-set gating already shipped).

## 9. Restart safety (both options, after F)
Valid snapshot: load and continue (snapshot carries post-F ledger; version tag bumped at F).
Missing/corrupt snapshot: deterministic recovery = the fresh-node path above from genesis
(rebuild uses the same apply rule as import, fee accounting already unified), reaching the same
post-F state; the derived bridge store rebuilds idempotently from post-activation receipts. A new
validator syncs from public blocks + the compiled checkpoint constants only.

## 10. Recommended fork height constraints / earliest safe F
F must be (i) > current tip (48) with enough lead for all validators to run the fork binary,
(ii) a height at which the producer's ledger equals the frozen `PRODUCTION_LEDGER_AT_F−1` table —
every block mined between snapshot and F changes that table, so **freeze F immediately after the
decision and stop bridge/AMM activity until F** (bridge is paused; mints/withdraws would alter the
table); (iii) `BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT` and the R1 activation are set to F.
Earliest safe F = tip at decision time + 2 (one block to seal the frozen table, one to activate),
recomputing the §3/§4 rows against the live ledger at F−1 in the fork PR.

## 11. Validator state at F−1 (added 2026-09-18 — consensus-critical blocker found during Option-B work)
`apply_validator_block` applied stake/unstake from tx TYPES, independently of whether the ledger debit
succeeded. Live consequence at h29: the `stake` from `c97f59a2…` failed at the ledger (10,000.87 < 10,001)
yet the validator store credited 10,000 of power — unbacked stake that inflated the proposer-selection
weight and quorum (120,000 / 80,001) and earned 0.874686701 XRGE of fee shares over h30–h48. The fix
(position-aligned `ValidatorExecution` results, sequential in-block shadow, validator effects applied only
from results; see FORK_IMPLEMENTATION.md) is part of the fork binary; the canonical state at 48 was
regenerated under it, and the migration transitions validator state atomically with the ledger.
| | production @48 | canonical @48 |
|---|---|---|
| `8ccf7878…` | 100,000 (missed 0) | 100,000 (missed 0) |
| `21e0ed0a…` | 10,000 (missed 29) | 10,000 (missed 29) |
| `c97f59a2…` | 10,000 (missed 20) — never debited | **absent** |
| total stake / quorum (`total*2/3+1`) | 120,000 / 80,001 | **110,000 / 73,334** |
| unbonding queue | empty | empty |
Consensus-relevant fields pinned: stake, slash_count, jailed_until, missed_blocks, total_slashed.
Informational (excluded, untouched): blocks_proposed, entropy_contributions, name. Hashes:
PRODUCTION_VALIDATOR_TABLE_SHA256 `7d18ef13…`, CANONICAL_VALIDATOR_TABLE_SHA256 `817e4fe1…`,
VALIDATOR_TRANSITION_TABLE_SHA256 `3f920d77…`. Ledger effect of the regeneration: the same
10,255.079099271 XRGE phantom total, re-split (§3/§4 rows updated); canonical root at 48 `35136edd…`.
The §6 identity holds unchanged (stake term 10,000 = h20; sinks 6 XRGE). The persisted `fees_burned`
accumulator is migrated to its canonical value (0.21323826751842256 → 0.11401217199999998) so a migrated node
equals a fresh-sync node in every persisted component; `nonce_db` is not consensus state (never read by block
import; wiped by a pre-existing startup heuristic) and is excluded from parity.
