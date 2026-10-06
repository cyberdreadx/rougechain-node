//! REVIEW_WALLET_3 (see `core/shield-v2-wallet/REVIEW_WALLET_3.md`), the JavaScript-facing surface.
//!
//! `rw3_f5_…` is the regression test of finding RW3-5 and **fails on the reviewed commit on
//! purpose** (`fix/shield-v2-wallet-settlement` @188d0ed). Nothing was fixed.

use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::{ShieldRequest, ShieldedKeys, TxContext, WalletState};
use quantum_vault_shield_v2_wasm::api;
use serde_json::{json, Value};

const Q: u64 = 1_000_000_000;
const SEED: [u8; 64] = [0x11; 64];
const OTHER: [u8; 64] = [0x22; 64];

fn parse(r: api::ApiResult) -> Value {
    serde_json::from_str(&r.expect("ok")).expect("the result is JSON")
}

fn rev(state: &str) -> f64 {
    parse(api::summary(state))["revision"].as_f64().unwrap()
}

fn report_for(state: &str, id: &str) -> Value {
    let s = parse(api::summary(state));
    json!({ "node_id": id, "height": s["scanned_height"], "tree_root": s["anchor"], "nullifier_acc": s["nullifier_acc"],
        "note_count": s["note_count"], "nullifier_count": s["nullifier_count"] })
}

/// A listing page with one shield per value to `seed`'s wallet, at heights 1, 2, ….
fn page_with_shields(seed: &[u8], values: &[u64]) -> String {
    let keys = ShieldedKeys::from_seed(seed).unwrap();
    let key: Vec<u8> = (0..1_952u32).map(|i| (i % 251) as u8).collect();
    let txs: Vec<Value> = values
        .iter()
        .enumerate()
        .map(|(i, value)| {
            let tx = deterministic::shield(
                &ShieldRequest {
                    ctx: TxContext { chain_id: "test".into(), anchor: WalletState::new([0; 32]).anchor(), anchor_height: 36, expiry_height: 100 },
                    from_pub_key: &key,
                    nonce: 1 + i as u64,
                    v_in: value + Q,
                    fee: Q,
                    recipient: &keys.address(),
                    max_fee: None,
                },
                &format!("rw3-wasm-{i}"),
            )
            .unwrap();
            let b = &tx.body;
            let out = |j: usize, kem: usize, note: usize| {
                json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": 2 * i + j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) })
            };
            json!({ "height": 1 + i, "index": 0, "tx_hash": format!("{:064x}", i + 1), "tx_type": "shield_v2",
                "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]), "outputs": [out(0, 258, 1346), out(1, 1402, 2490)] })
        })
        .collect();
    json!({ "active": true, "tip_height": values.len(), "from_height": 1, "next_height": values.len() + 1, "txs": txs }).to_string()
}

/// RW3-5 (Medium, G1). `build_transfer` / `build_unshield` return a complete, proven, submittable
/// transaction (`envelope_json`) and leave the state as it was: the lock is a SECOND call
/// (`mark_pending`) whose result the client must then persist, and only the documentation orders
/// the three steps. A signer-less transaction is valid the moment it exists. Any client that
/// submits before the marked state is durably stored — a crash, a killed service worker, an
/// `await` in the wrong order, a `stale_state:` on the `mark_pending` that is "retried later" —
/// has a live payment the wallet does not know: no pending entry, nothing locked, the same funds
/// offered again, and a second payment from the other note is built without complaint.
///
/// What the surface should offer: one call that builds AND records — returning `{ state,
/// revision, … }` with the inputs locked together with the transaction — so that no code path
/// holds a submittable transaction next to a state without its lock.
#[test]
fn rw3_f5_a_built_transaction_is_submittable_before_anything_is_locked() {
    let me = parse(api::shielded_address(&SEED));
    let them = parse(api::shielded_address(&OTHER));
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state0 = api::new_state(me["address"].as_str().unwrap(), "").unwrap();
    let scanned = parse(api::scan(&state0, &page_with_shields(&SEED, &[10 * Q, 6 * Q]), &key, rev(&state0)));
    let unverified = scanned["state"].to_string();
    let reports = json!([report_for(&unverified, "a"), report_for(&unverified, "b")]).to_string();
    let state = parse(api::confirm_state(&unverified, &reports, 0, rev(&unverified)))["state"].to_string();
    assert_eq!(parse(api::summary(&state))["spendable_balance"], "16000000000");

    // the user pays 4 XRGE: the 6 XRGE note is chosen
    let plan = parse(api::plan_payment(&state, "4000000000", "1000000000", false));
    assert_eq!(plan["status"], "ok");
    let params = json!({ "chain_id": "test", "anchor": scanned["anchor"], "inputs": plan["selection"]["positions"],
        "recipient": them["address"], "amount": "4000000000", "fee": "1000000000" });
    let built = parse(api::build_transfer(&SEED, &state, &params.to_string()));
    assert!(built["envelope_json"].as_str().is_some_and(|e| e.contains("shielded_transfer_v2")), "a complete transaction, ready to submit");

    // … and the only state the client holds knows nothing of it
    let after = parse(api::summary(&state));
    let again = parse(api::plan_payment(&state, "4000000000", "1000000000", false));
    let other = parse(api::plan_payment(&state, "8000000000", "1000000000", false));
    println!(
        "after build_transfer returned a submittable transaction: result has a state: {}; pending entries in the client's state: {}; spendable {}; \
         the same payment is planned again from the same note: {}; a payment from the other note is planned: {}",
        !built["state"].is_null(),
        after["pending"].as_array().unwrap().len(),
        after["spendable_balance"],
        again["selection"]["positions"] == plan["selection"]["positions"],
        other["status"] == "ok" && other["selection"]["positions"] != plan["selection"]["positions"],
    );
    assert_eq!(other["status"], "ok");
    assert_ne!(other["selection"]["positions"], plan["selection"]["positions"], "the second payment would not conflict with the first: both can be mined");

    assert!(
        !built["state"].is_null() && !built["revision"].is_null(),
        "the call that hands out a submittable transaction must return the state in which its inputs are locked"
    );
    let locked = parse(api::summary(&built["state"].to_string()));
    assert_eq!(locked["pending"].as_array().map(Vec::len), Some(1));
}
