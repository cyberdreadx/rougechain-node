# Generator for core/daemon/src/fork_tables.rs (Option-B fork, F=49). Usage: python3 gen_fork_tables.py <inputs-dir> <repo-root>
# <inputs-dir> must hold mainnet-blocks.jsonl (blocks 0..48), prod-maps-48.json (production balances/token/lp at 48),
# prod-validators-48.json (production validator store at 48) and rehearsal/post-migration-digest.json (production fees_burned bits at 48).
# canonical_state_48.json (this dir) is produced by the ignored daemon test fork_table_generation::generate_canonical_state_at_f_minus_1.
import json,sys,hashlib,struct
S,C=sys.argv[1],sys.argv[2]; F=49
blocks={json.loads(l)["header"]["height"]:json.loads(l) for l in open(f"{S}/mainnet-blocks.jsonl")}
prod=json.load(open(f"{S}/prod-maps-48.json")); can=json.load(open(f"{C}/core/bridge-exec/fork-decision/canonical_state_48.json"))
prod_vals={k:v for k,v in json.load(open(f"{S}/prod-validators-48.json"))}; can_vals={k:v for k,v in can["validators"]}
cps=[(h,blocks[h]["header"]["state_root"]) for h in range(18,F)]
prod_led=dict(prod["balances"]); can_led={k:v for k,v in can["balances"].items()}
delta=[(k,(can_led.get(k,0))-(prod_led.get(k,0))) for k in sorted(set(prod_led)|set(can_led)) if can_led.get(k,0)!=prod_led.get(k,0)]
tok=sorted((a,t,v) for (a,t),v in ((tuple(k),v) for k,v in prod["token_balances"])); tokc=sorted((a,t,v) for (a,t),v in ((tuple(k),v) for k,v in can["token_balances"]))
lp=sorted((a,t,v) for (a,t),v in ((tuple(k),v) for k,v in prod["lp_balances"])); lpc=sorted((a,t,v) for (a,t),v in ((tuple(k),v) for k,v in can["lp_balances"]))
assert tok==tokc and lp==lpc, "token/lp must be identical"
# validator consensus-relevant fields: stake, slash_count, jailed_until, missed_blocks, total_slashed  (informational: blocks_proposed, entropy_contributions, name)
CF=("stake","slash_count","jailed_until","missed_blocks","total_slashed")
def vrow(k,v): return (k,int(v["stake"]),int(v.get("slash_count",0)),int(v.get("jailed_until",0)),int(v.get("missed_blocks",0)),int(v.get("total_slashed",0)))
prod_v=sorted(vrow(k,v) for k,v in prod_vals.items()); can_v=sorted(vrow(k,v) for k,v in can_vals.items())
trans=[]
for k in sorted(set(prod_vals)|set(can_vals)):
    if k in can_vals: trans.append(("set",)+vrow(k,can_vals[k]))
    else: trans.append(("remove",k,0,0,0,0,0))
def ser_led(d): return "".join(f"{k}={v}\n" for k,v in sorted(d.items()))
ser_cp="".join(f"{h}={r}\n" for h,r in cps); ser_delta="".join(f"{k}={d}\n" for k,d in sorted(delta))
ser_toklp="".join(f"{a}|{t}={v}\n" for a,t,v in tok)+"".join(f"{a}|{t}={v}\n" for a,t,v in lp)
ser_v=lambda rows: "".join(f"{k}|stake={s}|slash_count={sc}|jailed_until={j}|missed_blocks={m}|total_slashed={ts}\n" for k,s,sc,j,m,ts in rows)
ser_tr="".join(f"{op}|{k}|stake={s}|slash_count={sc}|jailed_until={j}|missed_blocks={m}|total_slashed={ts}\n" for op,k,s,sc,j,m,ts in trans)
H=lambda s: hashlib.sha256(s.encode()).hexdigest()
hashes={"CHECKPOINT_TABLE_SHA256":H(ser_cp),"PRODUCTION_LEDGER_TABLE_SHA256":H(ser_led(prod_led)),"CANONICAL_LEDGER_TABLE_SHA256":H(ser_led(can_led)),"CANONICAL_DELTA_TABLE_SHA256":H(ser_delta),"TOKEN_LP_TABLE_SHA256":H(ser_toklp),
 "PRODUCTION_VALIDATOR_TABLE_SHA256":H(ser_v(prod_v)),"CANONICAL_VALIDATOR_TABLE_SHA256":H(ser_v(can_v)),"VALIDATOR_TRANSITION_TABLE_SHA256":H(ser_tr)}
q=lambda s:'"'+s+'"'
out=["//! AUTO-GENERATED fork data for CANONICAL_LEDGER_FORK_HEIGHT = 49 (Option B). DO NOT EDIT BY HAND.",
"//! Sources: immutable mainnet fixture blocks 0..48; production ledger + validator store at 48;",
"//! canonical replay at 48 under the fixed (sequential, ledger-backed) stake/unstake rules.",
"//! Every table is hash-pinned; `fork_tables_tests` recomputes the hashes.","","pub const FORK_HEIGHT: u64 = 49;",
"pub const CHECKPOINT_ROOTS: &[(u64, &str)] = &["]+[f"    ({h}, {q(r)})," for h,r in cps]+["];",
"pub const PRODUCTION_LEDGER_AT_F_MINUS_1: &[(&str, u128)] = &["]+[f"    ({q(k)}, {v})," for k,v in sorted(prod_led.items())]+["];",
"pub const CANONICAL_LEDGER_AT_F_MINUS_1: &[(&str, u128)] = &["]+[f"    ({q(k)}, {v})," for k,v in sorted(can_led.items())]+["];",
"/// canonical - production (quanta), applied atomically at migration",
"pub const CANONICAL_DELTA: &[(&str, i128)] = &["]+[f"    ({q(k)}, {d})," for k,d in sorted(delta)]+["];",
"pub const TOKEN_BALANCES_AT_F_MINUS_1: &[(&str, &str, u128)] = &["]+[f"    ({q(a)}, {q(t)}, {v})," for a,t,v in tok]+["];",
"pub const LP_BALANCES_AT_F_MINUS_1: &[(&str, &str, u128)] = &["]+[f"    ({q(a)}, {q(t)}, {v})," for a,t,v in lp]+["];",
"/// Validator rows: (pubkey, stake, slash_count, jailed_until, missed_blocks, total_slashed) — the",
"/// CONSENSUS-RELEVANT fields (proposer/quorum/slashing). `blocks_proposed`, `entropy_contributions`",
"/// and `name` are informational and are recomputed/left untouched.",
"pub const PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1: &[(&str, u128, u32, u64, u64, u128)] = &["]+[f"    ({q(k)}, {s}, {sc}, {j}, {m}, {ts})," for k,s,sc,j,m,ts in prod_v]+["];",
"pub const CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1: &[(&str, u128, u32, u64, u64, u128)] = &["]+[f"    ({q(k)}, {s}, {sc}, {j}, {m}, {ts})," for k,s,sc,j,m,ts in can_v]+["];",
"/// (\"set\" ⇒ overwrite consensus fields with the row; \"remove\" ⇒ delete the validator entry)",
"pub const VALIDATOR_TRANSITION: &[(&str, &str, u128, u32, u64, u64, u128)] = &["]+[f"    ({q(op)}, {q(k)}, {s}, {sc}, {j}, {m}, {ts})," for op,k,s,sc,j,m,ts in trans]+["];"]
for k,v in hashes.items(): out.append(f"pub const {k}: &str = {q(v)};")
out.append(f"pub const CANONICAL_DELTA_SUM_QUANTA: i128 = {sum(d for _,d in delta)};")
out.append(f"pub const CANONICAL_TOTAL_BACKED_STAKE: u128 = {sum(s for _,s,*_ in can_v)};")
out.append(f"pub const PRODUCTION_TOTAL_VALIDATOR_STAKE: u128 = {sum(s for _,s,*_ in prod_v)};")

prod_fb=json.load(open(f"{S}/rehearsal/post-migration-digest.json"))["fees_burned_bits"]  # production accumulator at 48 (clone of the live data dir, read before any block 49)
can_fb=struct.unpack('<Q',struct.pack('<d',float(can["fees_burned"])))[0]
assert struct.unpack('<d',struct.pack('<Q',prod_fb))[0]==0.21323826751842256 and can["fees_burned"]==0.11401217199999998
out.append(f"/// `total_fees_burned` accumulator (f64 bits) — persisted, not in the state root; migrated with the ledger")
out.append(f"pub const PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1: u64 = {prod_fb};")
out.append(f"pub const CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1: u64 = {can_fb};")
out.append("")
open(f"{C}/core/daemon/src/fork_tables.rs","w").write("\n".join(out))
json.dump({"fork_height":F,"checkpoints":cps,"production_ledger":sorted(prod_led.items()),"canonical_ledger":sorted(can_led.items()),"canonical_delta":sorted(delta),
 "production_validators":prod_v,"canonical_validators":can_v,"validator_transition":trans,"hashes":hashes,
 "sums":{"delta_net":sum(d for _,d in delta),"canonical_total_backed_stake":sum(s for _,s,*_ in can_v),"production_total_stake":sum(s for _,s,*_ in prod_v)},
 "fees_burned_bits":{"production":prod_fb,"canonical":can_fb},"canonical_root_48":can["state_root"],"production_root_48":blocks[48]["header"]["state_root"]},open(f"{C}/core/bridge-exec/fork-decision/fork_tables_F49.json","w"),indent=1)
print(json.dumps(hashes,indent=1)); print("delta:",[(k[:14],d) for k,d in sorted(delta)],"net",sum(d for _,d in delta)); print("validators prod:",[(k[:8],s,m) for k,s,_,_,m,_ in prod_v]," canon:",[(k[:8],s,m) for k,s,_,_,m,_ in can_v]); print("transition:",[(op,k[:8],s) for op,k,s,*_ in trans])
