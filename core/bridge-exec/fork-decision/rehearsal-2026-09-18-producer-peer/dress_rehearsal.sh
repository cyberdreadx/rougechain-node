#!/usr/bin/env bash
# Option-B fork DRESS REHEARSAL — ISOLATED. Never touches ~/.quantum-vault/mainnet, /srv/rougechain,
# ports 4100/5100, systemd units, or the production relayer. Everything lives under $R.
set -uo pipefail
S=/tmp/claude-1006/-home-cyberdreadx/2c6473bd-cc4d-415d-b0f1-29e0f30b42b2/scratchpad
BIN=/home/cyberdreadx/quantum-vault-r1-candidate/core/target/debug/quantum-vault-daemon
CLI=/home/cyberdreadx/quantum-vault-r1-candidate/core/target/debug/rougechain
GEN=$S/genesis-mainnet.json
R=$S/rehearsal; rm -rf $R; mkdir -p $R
COMMON="--genesis $GEN --chain-id rougechain-mainnet-1"
log(){ echo "[rehearsal $(date -u +%H:%M:%S)] $*"; }
stop_node(){ if [ -f "$1" ]; then kill "$(cat "$1")" 2>/dev/null; sleep 2; kill -9 "$(cat "$1")" 2>/dev/null; rm -f "$1"; fi; }
trap 'stop_node $R/nodeA.pid; stop_node $R/nodeB.pid' EXIT

# 1. Isolated clone of the LIVE production data dir (read-only semantics: we only ever read the source).
rsync -a --exclude 'messenger-db' --exclude 'mail-db' --exclude 'push-token-db' ~/.quantum-vault/mainnet/ $R/clone/ && chmod -R u+w $R/clone
log "clone taken"

# 2. Pre-migration evidence: the fork binary must REFUSE to run on the legacy ledger.
$BIN --print-state-digest $COMMON --data-dir $R/clone > $R/pre-digest.json 2> $R/pre.err; echo "pre-migration start exit=$? : $(grep -oE 'LEGACY production ledger[^"]*|refusing[^"]*' $R/pre.err | head -1)"

# 3. Explicit operator migration on the clone.
$BIN --migrate-canonical-ledger $COMMON --data-dir $R/clone > $R/post-migration-digest.json 2> $R/migrate.err; echo "migration exit=$? : $(grep -oE 'migration outcome: [a-z-]+' $R/migrate.err)"
python3 -c "import json;d=json.load(open('$R/post-migration-digest.json'));print('post-migration', {k:d[k] for k in ('tip','state_root','canonical_marker')})"
# double migration must be recognized, not re-applied
$BIN --migrate-canonical-ledger $COMMON --data-dir $R/clone > /dev/null 2> $R/migrate2.err; echo "second migration exit=$? : $(grep -oE 'migration outcome: [a-z-]+' $R/migrate2.err)"

# 4. Produce fork block F on the migrated clone (isolated miner on private ports) with one real signed tx.
( $BIN --mine $COMMON --data-dir $R/clone --host 127.0.0.1 --port 4199 --api-port 5199 --block-time-ms 1000 > $R/nodeA.log 2>&1 & echo $! > $R/nodeA.pid )
for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:5199/api/stats >/dev/null 2>&1 && break; sleep 1; done
NODEPUB=$(python3 -c "import json;print(json.load(open('$R/clone/node-keys.json'))['public_key_hex'])")
TO=$(python3 -c "
import json
for l in open('$S/mainnet-blocks.jsonl'):
    b=json.loads(l)
    if b['header']['height']==21: print(b['txs'][0]['from_pub_key'])")
$CLI --rpc http://127.0.0.1:5199 --node-keys $R/clone/node-keys.json transfer $TO 1 --fee 1 > $R/cli-transfer.out 2>&1; echo "cli transfer exit=$?: $(tail -c 300 $R/cli-transfer.out | tr '\n' ' ')"
wait_h(){ for i in $(seq 1 60); do H=$(curl -s --max-time 2 http://127.0.0.1:$1/api/stats | python3 -c "import json,sys;print(json.load(sys.stdin).get('network_height'))" 2>/dev/null); [ "$H" = "$2" ] && break; sleep 1; done; echo "$H"; }
echo "clone tip after block F (local miner, transfer): $(wait_h 5199 49)"
# 4b. Separate isolated test blocks with stake-related txs through the LOCAL MINER path:
#     block 50 = stake 1 XRGE from the producer key; block 51 = unstake 1 XRGE (pending unbonding queue entry).
$CLI --rpc http://127.0.0.1:5199 --node-keys $R/clone/node-keys.json stake 1 > $R/cli-stake.out 2>&1; echo "cli stake exit=$?: $(tail -c 200 $R/cli-stake.out | tr '\n' ' ')"
echo "clone tip after stake block: $(wait_h 5199 50)"
$CLI --rpc http://127.0.0.1:5199 --node-keys $R/clone/node-keys.json unstake 1 > $R/cli-unstake.out 2>&1; echo "cli unstake exit=$?: $(tail -c 200 $R/cli-unstake.out | tr '\n' ' ')"
echo "clone tip after unstake block: $(wait_h 5199 51)"; curl -s http://127.0.0.1:5199/api/stats > $R/tip-after-F.json

# 5. Fresh node B: random identity, empty dir, genesis, syncs over REAL P2P from node A.
mkdir -p $R/fresh
( QV_PEERS=http://127.0.0.1:5199 $BIN $COMMON --data-dir $R/fresh --host 127.0.0.1 --port 4198 --api-port 5198 > $R/nodeB.log 2>&1 & echo $! > $R/nodeB.pid )
for i in $(seq 1 120); do HB=$(curl -s --max-time 2 http://127.0.0.1:5198/api/stats | python3 -c "import json,sys;print(json.load(sys.stdin).get('network_height'))" 2>/dev/null); [ "$HB" = "51" ] && break; sleep 2; done
echo "fresh node tip (PEER PATH, verified import only — reset_chain no longer exists): ${HB:-unreachable}"; grep -c "Imported block" $R/nodeB.log | sed 's/^/fresh node imported blocks: /'; grep -ci "reset" $R/nodeB.log | sed 's/^/fresh node log lines mentioning reset: /'
stop_node $R/nodeB.pid; stop_node $R/nodeA.pid; sleep 2

# 6. Digests: clone (restart with snapshot), clone (snapshot loss), clone (corrupt snapshot), fresh node.
$BIN --print-state-digest $COMMON --data-dir $R/clone > $R/digest-A-snapshot.json 2> $R/dA1.err; echo "A snapshot-restart exit=$?"
cp -a $R/clone $R/clone-nosnap && rm -rf $R/clone-nosnap/snapshot-db
$BIN --print-state-digest $COMMON --data-dir $R/clone-nosnap > $R/digest-A-recovered.json 2> $R/dA2.err; echo "A no-snapshot recovery exit=$? ($(grep -c 'recover' $R/dA2.err) recover lines)"
# (corrupt-snapshot recovery is exercised by the unit test post_fork_restart_snapshot_loss_and_corruption_all_reach_identical_state)
$BIN --print-state-digest $COMMON --data-dir $R/fresh > $R/digest-B-fresh.json 2> $R/dB.err; echo "B fresh-sync digest exit=$?"
python3 - "$R" <<'PY'
import json,sys,os
R=sys.argv[1]
def load(p):
    try: return json.load(open(p))
    except Exception as e: return {"error":str(e)}
keys=["tip","tip_hash","state_root","balances","token_balances","lp_balances","burned_tokens","stakes","shielded_supply_bits","base_fee_quanta","validators","total_stake","quorum","unbonding","fees_burned_bits"]  # nonce_db excluded: never read by block import; cleared by the pre-existing startup heuristic (finding)
A=load(f"{R}/digest-A-snapshot.json"); A2=load(f"{R}/digest-A-recovered.json"); B=load(f"{R}/digest-B-fresh.json"); PM=load(f"{R}/post-migration-digest.json")
def proj(d): return {k:d.get(k) for k in keys}
print("post-migration fees_burned_bits:", PM.get("fees_burned_bits"), "(canonical 4592879863468523341 expected)"); print("post-migration validators:", PM.get("validators"), "total_stake", PM.get("total_stake"), "quorum", PM.get("quorum"), "unbonding", PM.get("unbonding"))
print("A(snapshot)  :", proj(A)); print("A(recovered) :", proj(A2)); print("B(fresh sync):", proj(B))
for k in keys:
    if not (proj(A)[k]==proj(A2)[k]==proj(B)[k]): print("  DIFF on", k, ":", proj(A)[k], proj(A2)[k], proj(B)[k])
print("informational (excluded): A", A.get("validators_informational"), "| B", B.get("validators_informational"))
print("A==A2:", proj(A)==proj(A2), " A==B:", proj(A)==proj(B))
ok = proj(A)==proj(A2)==proj(B) and A.get("tip")==51 and A.get("total_stake")==110000 and A.get("quorum")==73334 and len(A.get("unbonding") or [])==1 and (A.get("unbonding")[0][2]==51+500)
print("unbonding (delegator, amount_bits, release_height):", A.get("unbonding"))
print("REHEARSAL RESULT:", "PASS" if ok else "FAIL")
PY
