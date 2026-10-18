#!/usr/bin/env bash
# The small campaign that is allowed on the validator host: about ten minutes of
# CPU at the lowest priority, one process at a time. The large campaign of the
# design (10^6 schedules) must run on another machine: see RESULTS.md §8.
set -u
cd "$(dirname "$0")"
RUN="systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0 -p CPUWeight=10 nice -n 19"
BIN=./target/release/campaign
status=0
run() { # validators profile seeds max-seconds
  $RUN $BIN --validators "$1" --stake-profile "$2" --seeds "$3" --faults all --long-every 16 --replay-every 10 --max-seconds "$4" || status=1
  echo "------------------------------------------------------------------"
}
run 4  equal4    0..4000  60
run 3  today     0..1500  40
run 3  50-30-20  0..1500  40
run 5  plan5     0..1500  40
run 7  random    0..1500  60
run 10 equal4    0..2500  90
run 10 random    0..2500  90
run 30 equal4    0..140   200
run 30 random    0..140   200
exit $status
