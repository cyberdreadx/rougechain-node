#!/usr/bin/env bash
# The large seeded campaign of the design's exit criteria (§9: about 10^6 schedules).
#
#   DO NOT RUN THIS ON A VALIDATOR HOST.
#
# Usage:   JOBS=16 ./large_campaign.sh          (one single-threaded process per job)
#          DRY_RUN=1 ./large_campaign.sh        (print the job list and exit)
#          SCALE=100 ./large_campaign.sh        (1/100 of the seeds, for a trial)
# Output:  logs/v<validators>-<profile>-<first seed>.log, one per job; exit status 1 on any violation.
set -u
cd "$(dirname "$0")"
JOBS=${JOBS:-$(nproc)}
SCALE=${SCALE:-1}
CHUNK=${CHUNK:-2000}

plan() { # validators profile seeds   (sum: 1,000,000)
cat <<'PLAN'
4 equal4 300000
3 today 50000
3 50-30-20 50000
5 plan5 100000
7 random 150000
10 equal4 125000
10 random 125000
30 equal4 50000
30 random 50000
PLAN
}

job_list() {
  plan | while read -r v p n; do
    n=$((n / SCALE)); a=0
    while [ "$a" -lt "$n" ]; do
      b=$((a + CHUNK)); [ "$b" -gt "$n" ] && b=$n
      echo "$v $p $a $b"
      a=$b
    done
  done
}

if [ "${DRY_RUN:-0}" = 1 ]; then job_list; exit 0; fi

cargo build --release --bins || exit 1
mkdir -p logs
job_list | xargs -P "$JOBS" -L 1 sh -c '
  ./target/release/campaign --validators "$0" --stake-profile "$1" --seeds "$2..$3" \
      --faults all --long-every 16 --replay-every 10 --max-seconds 8640000 \
      > "logs/v$0-$1-$2.log" 2>&1 || echo "FAILED: logs/v$0-$1-$2.log"'

echo "seeds run:  $(grep -h "^seeds run" logs/*.log | awk "{s+=\$3} END {print s}")"
echo "heights:    $(grep -h "^heights committed" logs/*.log | awk "{s+=\$3} END {print s}")"
if grep -l "VIOLATION" logs/*.log; then echo "VIOLATIONS FOUND (files above)"; exit 1; fi
echo "no violation"
