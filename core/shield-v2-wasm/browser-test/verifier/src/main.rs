//! Native verification of the transactions the WebAssembly package built in a browser.
//!
//! The stateless rule is the NODE's own code: `core/daemon/src/shield_v2.rs` is compiled into
//! this binary verbatim (`#[path]`), with a stand-in for the one thing it reads from the rest of
//! the daemon — the activation height (`crate::upgrades::current().shield_v2`), set here to the
//! activation height of the test vectors. Nothing else of the daemon is built.
//!
//! For every envelope it runs, in the node's order:
//!   1. `serde_json` → `quantum_vault_types::TxV1` (the node's transaction type);
//!   2. `shield_v2_tx_rule(tx, height, chain_id)` — checks 1–12 (and the signed-payload half of 14)
//!      of spec §3.6;
//!   3. `verify_proof` (→ `quantum_vault_shield_v2::verify_spend`) — check 20, timed;
//!   4. `Pool::validate_block` against the pool state the vector chain
//!      (`core/shield-v2/vectors/wallet/transactions.json`) reaches — checks 15–18 — after
//!      replaying that chain and comparing every state with `state_root.json`.
//!
//! Usage: shield-v2-browser-verifier <vectors/wallet dir> <envelopes.json>
//!   envelopes.json: [{ "label", "envelope_json", "public_inputs" }]
//! Prints one JSON object on stdout.

#![allow(dead_code, unused_imports)]

use std::sync::OnceLock;
use std::time::Instant;

use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolState};
use serde_json::{json, Value};

static ACTIVATION: OnceLock<Option<u64>> = OnceLock::new();

/// Stand-in for `core/daemon/src/upgrades.rs`: the only daemon module `shield_v2.rs` reads.
mod upgrades {
    pub struct Schedule {
        pub shield_v2: Option<u64>,
    }
    pub fn current() -> &'static Schedule {
        static S: std::sync::OnceLock<Schedule> = std::sync::OnceLock::new();
        S.get_or_init(|| Schedule { shield_v2: *super::ACTIVATION.get().expect("activation set in main") })
    }
}

#[path = "../../../../daemon/src/shield_v2.rs"]
mod shield_v2;

fn state_json(s: &PoolState) -> Value {
    json!({
        "tree_root": hex::encode(s.tree_root),
        "nullifier_acc": hex::encode(s.nullifier_acc),
        "note_count": s.note_count,
        "nullifier_count": s.nullifier_count,
        "pool_total": s.pool_total.to_string(),
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: {} <vectors/wallet dir> <envelopes.json>", args[0]);
        std::process::exit(2);
    }
    let read = |p: String| -> Value { serde_json::from_str(&std::fs::read_to_string(&p).expect("read")).expect("json") };
    let txs = read(format!("{}/transactions.json", args[1]));
    let roots = read(format!("{}/state_root.json", args[1]));
    let envelopes = read(args[2].clone());

    let activation = txs["activation_height"].as_u64().expect("activation_height");
    ACTIVATION.set(Some(activation)).ok();
    let chain_id = txs["chain_id"].as_str().expect("chain_id").to_string();
    let chain = shield_v2::chain_tag(&chain_id);
    assert_eq!(hex::encode(chain), txs["chain"].as_str().unwrap(), "chain tag of the vectors");

    // ---- replay the vector chain through the node's body parser and the pool rules ----------
    let mut pool = Pool::open_or_init(MemoryPoolStore::new(), activation).expect("pool");
    let mut replay = Vec::new();
    let mut replay_ok = state_json(&pool.state().unwrap()) == pick(&roots["states"][0]["state"]);
    for (i, t) in txs["transactions"].as_array().unwrap().iter().enumerate() {
        let height = t["height"].as_u64().unwrap();
        let ty = t["tx_type"].as_str().unwrap();
        let bytes = hex::decode(t["body"].as_str().unwrap()).unwrap();
        let body = shield_v2::parse_body(&bytes, ty, height, &chain).expect("vector body parses");
        let parsed = shield_v2::ShieldV2Tx { body, body_bytes: bytes, proof: Vec::new() };
        let prepared = pool.validate_block(height, &[parsed.pool_tx()]).expect("vector block valid");
        pool.commit(prepared).expect("commit");
        let got = state_json(&pool.state().unwrap());
        let want = pick(&roots["states"][i + 1]["state"]);
        let ok = got == want;
        replay_ok &= ok;
        replay.push(json!({ "height": height, "tx_type": ty, "matches_state_root_json": ok }));
    }
    let next_height = pool.next_height().unwrap();

    // ---- the envelopes the browser built ------------------------------------------------------
    let cache = shield_v2::VerifyCache::default();
    let mut out = Vec::new();
    for (n, e) in envelopes.as_array().unwrap().iter().enumerate() {
        let label = e["label"].as_str().unwrap_or("?").to_string();
        let text = e["envelope_json"].as_str().unwrap_or("");
        let mut r = json!({ "label": label, "height": next_height });
        let tx: quantum_vault_types::TxV1 = match serde_json::from_str(text) {
            Ok(t) => t,
            Err(err) => {
                r["envelope"] = json!(format!("does not parse as TxV1: {err}"));
                out.push(r);
                continue;
            }
        };
        r["envelope"] = json!("ok");
        r["tx_type"] = json!(tx.tx_type.clone());
        let parsed = match shield_v2::shield_v2_tx_rule(&tx, next_height, &chain_id) {
            Ok(Some(p)) => {
                r["stateless_rule"] = json!("ok");
                p
            }
            Ok(None) => {
                r["stateless_rule"] = json!("not a V2 transaction");
                out.push(r);
                continue;
            }
            Err(err) => {
                r["stateless_rule"] = json!(err);
                out.push(r);
                continue;
            }
        };
        let public_hex = hex::encode(parsed.public_inputs().to_bytes());
        r["public_inputs_match"] = json!(e["public_inputs"].as_str() == Some(public_hex.as_str()));
        r["proof_bytes"] = json!(parsed.proof.len());
        // the node's path (cache keyed by the transaction; a fresh key per envelope) …
        let t0 = Instant::now();
        let node_path = shield_v2::verify_proof(&cache, &format!("browser-{n}"), &parsed);
        r["verify_proof_ms"] = json!(t0.elapsed().as_secs_f64() * 1e3);
        r["verify_proof"] = json!(match node_path { Ok(()) => "ok".to_string(), Err(e) => e });
        // … and `verify_spend` itself, timed three more times
        let mut ms = Vec::new();
        for _ in 0..3 {
            let t0 = Instant::now();
            let ok = quantum_vault_shield_v2::verify_spend(&parsed.public_inputs(), &parsed.proof).is_ok();
            ms.push(t0.elapsed().as_secs_f64() * 1e3);
            assert!(ok == (r["verify_proof"] == "ok"));
        }
        r["verify_spend_ms"] = json!(ms);
        r["pool_rules"] = json!(match pool.validate_block(next_height, &[parsed.pool_tx()]) {
            Ok(_) => "ok".to_string(),
            Err(e) => format!("{e:?}"),
        });
        out.push(r);
    }
    let result = json!({
        "verifier": "core/daemon/src/shield_v2.rs (verbatim) + quantum-vault-shield-v2 default features",
        "prover_compiled": quantum_vault_shield_v2::PROVER_COMPILED,
        "chain_id": chain_id,
        "activation_height": activation,
        "replay": replay,
        "replay_ok": replay_ok,
        "envelopes": out,
    });
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}

/// The fields of a `state_root.json` state that `state_json` reports.
fn pick(s: &Value) -> Value {
    json!({
        "tree_root": s["tree_root"], "nullifier_acc": s["nullifier_acc"], "note_count": s["note_count"],
        "nullifier_count": s["nullifier_count"], "pool_total": s["pool_total"],
    })
}
