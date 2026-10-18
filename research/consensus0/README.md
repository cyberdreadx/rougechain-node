# consensus0 — CONSENSUS-0, stage 1

The consensus rules of the "Consensus R2" redesign (`docs/CONSENSUS_R2_DESIGN.md`) written once as a pure,
deterministic state machine, plus a seeded simulator that attacks it. This is the validation step the design
asks for in §9, before any node code is written. **No node code is touched; nothing here talks to a network,
a clock or a disk.** Results, findings and what is not covered are in [`RESULTS.md`](RESULTS.md).

Standalone Cargo package (not a member of `core/`'s workspace). Dependencies: `rand_chacha` and `rand_core`
(the seeded PRNG) and nothing else. `serde` was allowed but is not used: nothing is serialised.

## Layout

| Path | What it is |
|---|---|
| `src/types.rs` | Ids, modelled hash and signature, the real §3.2 signed bytes and ML-DSA-65 sizes, exact 256-bit `mul_div`, validator set (`q`, `t1`), commit certificate (§3.6), duplicate-vote evidence |
| `src/schedule.rs` | The integer stake-weighted proposer rotation of §3.3 |
| `src/chain.rs` | Ledger rules as pure functions: blocks, heartbeats, epochs, set changes, unbonding, evidence and slashing, jailing, rewards, activation boundary |
| `src/machine.rs` | **The state machine**: `step(state, input) -> (state, outputs)` for one validator |
| `src/node.rs` | Driver glue (machine + ledger + mempool): the part the real node replaces with real I/O |
| `src/sim.rs` | Seeded event queue, network model, clocks, fault behaviours |
| `src/props.rs` | Checkers for P1–P10 |
| `src/campaign.rs`, `src/bin/campaign.rs` | Seed → scenario, measurements, the campaign binary |
| `src/explore.rs`, `src/bin/exhaustive.rs` | Bounded exhaustive exploration of orderings |
| `src/mutation.rs` | Test-only switch for deliberately broken rules (constant `false` in every non-test build) |
| `src/tests/` | Scripted tests (D1–D7, P5, boundaries, today's stake), mutation self-tests, simulator tests |

## Build and test

On any machine that is **not** a validator:

```sh
cargo test                      # 65 tests
cargo build --release --bins
```

On the validator host every cargo command must be throttled, in the foreground, one at a time, and no other
`cargo`/`rustc` may be running (`ps -eo comm | grep -cE '^(cargo|rustc)$'` must print 0):

```sh
RUN="systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice -n 19"
$RUN cargo test --offline -j 1 -- --test-threads=1        # about 65 s of test time
$RUN cargo build --offline --release --bins -j 1
rm -rf target                                              # when finished
```

## Run

```sh
# A campaign: every seed is one schedule; P1–P10 are checked on each; exit status 1 on a violation,
# after printing the seed, the scenario and a trace of the offending height.
./target/release/campaign --seeds 0..4000 --validators 4 --stake-profile equal4 --faults all --max-seconds 60

#   --stake-profile  today | equal4 | plan5 | 50-30-20 | random
#   --faults         all | none | comma list of:
#                    crash restart restart-nostate equivocate doublevote coalition nil withhold stall chaos partition
#   --fault-bound N/D   allow faulty stake up to N/D of the total (default: strictly below one third)
#   --long-every K      one seed in K simulates three days (heartbeats, epochs, staking, jailing); 0 = never
#   --replay-every K    one seed in K records its schedule and replays it (P10); 0 = never
#   --keep-going        do not stop at the first violation
#   --amnesia-not-a-fault   treat "restart without persisted state" as honest (self-test: it must then break P1)

# The measurements of §9 (finality times, traffic, certificate sizes, heartbeat day).
./target/release/campaign --measure

# Bounded exhaustive exploration of delivery and timeout orderings for one height.
./target/release/exhaustive --validators 4 --rounds 2 --byzantine 0 --max-states 20000000 --max-seconds 3600
#   --byzantine 1     the last validator may send any message it can sign, to any subset
#   --order-seed K    permute the exploration order (same reachable set; reaches other corners when bounded)

# The small campaign that is allowed on the validator host (about 4.5 minutes of CPU, lowest priority).
./host_campaign.sh

# The large campaign of the exit criteria (10^6 schedules). NOT on a validator host.
JOBS=16 ./large_campaign.sh
```

Reproducing a failure: a run is a pure function of `(seed, options)`. Re-run the same command with
`--seeds S..S+1`; the binary prints the scenario and the trace.

## Using the machine from a driver

```text
inputs : StartHeight | Proposal{verdict} | Vote | Timeout | TxPending | HeartbeatDue | BlockBuilt | CatchUp
outputs: Persist(record) | Broadcast(msg) | SetTimer | WakeAtHeaderTime | NeedBlock | Commit | Evidence
```

The contract is in the module comment of `src/machine.rs`. The two points a driver must not get wrong:
every `Persist` that precedes a `Broadcast` in one output list must be fsynced before that message leaves
(§3.7); and a restart must go through `Machine::restore` with the persisted records — `Machine::new` after a
crash inside a height is the unsafe case that `tests/mutation_tests.rs` demonstrates.
