//! REVIEW_WALLET_3 (see `core/shield-v2-wallet/REVIEW_WALLET_3.md`), the JavaScript-facing surface.
//!
//! `rw3_f5_…` is the regression test of finding RW3-5. It failed on the reviewed commit
//! (`fix/shield-v2-wallet-settlement` @188d0ed) on purpose and passes since
//! `fix/shield-v2-wallet-settlement-2`: building and locking are one call.

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
    json!({ "node_id": format!("https://{id}.example"), "height": s["scanned_height"], "tree_root": s["anchor"], "nullifier_acc": s["nullifier_acc"],
        "note_count": s["note_count"], "nullifier_count": s["nullifier_count"], "ciphertext_acc": s["ciphertext_acc"] })
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

/// RW3-5 (Medium, G1). `build_transfer` / `build_unshield` used to return a complete, proven,
/// submittable transaction (`envelope_json`) and leave the state as it was: the lock was a SECOND
/// call (`mark_pending`) whose result the client then had to persist, and only the documentation
/// ordered the three steps. A signer-less transaction is valid the moment it exists.
///
/// Since the fix the surface has ONE call that builds AND records: the result is
/// `{ state, revision, envelope_json, … }`, and in that state the inputs are locked and the
/// pending entry is there. `mark_pending` is not exported any more: no code path holds a
/// submittable transaction next to a state without its lock. The client's rule is one sentence:
/// persist the returned state, then submit.
#[test]
fn rw3_f5_a_built_transaction_is_submittable_before_anything_is_locked() {
    let me = parse(api::shielded_address(&SEED));
    let them = parse(api::shielded_address(&OTHER));
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state0 = api::new_state(me["address"].as_str().unwrap(), "", 0).unwrap();
    let state0 = parse(api::set_nodes(&state0, r#"["https://a.example", "https://b.example", "https://c.example"]"#, rev(&state0)))["state"].to_string();
    let scanned = parse(api::scan(&state0, &page_with_shields(&SEED, &[10 * Q, 6 * Q]), &key, rev(&state0)));
    let unverified = scanned["state"].to_string();
    // two of the three configured nodes agree; the third says something else and is named
    let mut liar = report_for(&unverified, "c");
    liar["nullifier_acc"] = json!("00".repeat(32));
    let reports = json!([report_for(&unverified, "a"), report_for(&unverified, "b"), liar]).to_string();
    let confirmed = parse(api::confirm_state(&unverified, &reports, rev(&unverified)));
    assert_eq!((confirmed["report"]["matched_height"].as_u64(), confirmed["report"]["quorum"].as_u64(), confirmed["report"]["diverged"].as_bool()), (Some(2), Some(2), Some(false)));
    assert_eq!(confirmed["report"]["dissenting"], json!([{ "node_id": "https://c.example", "height": 2 }]));
    let state = confirmed["state"].to_string();
    assert_eq!(parse(api::summary(&state))["spendable_balance"], "16000000000");

    // the user pays 4 XRGE: the 6 XRGE note is chosen
    let plan = parse(api::plan_payment(&state, "4000000000", "1000000000", false));
    assert_eq!(plan["status"], "ok");
    let params = json!({ "chain_id": "test", "inputs": plan["selection"]["positions"], "recipient": them["address"], "amount": "4000000000", "fee": "1000000000" });
    let built = parse(api::build_transfer(&SEED, &state, &params.to_string(), rev(&state)));
    assert!(built["envelope_json"].as_str().is_some_and(|e| e.contains("shielded_transfer_v2")), "a complete transaction, ready to submit");
    assert_eq!(built["expiry_height"], 2 + 64, "the expiry is the CONFIRMED height + 64: no height is taken from the caller");

    assert!(
        !built["state"].is_null() && !built["revision"].is_null(),
        "the call that hands out a submittable transaction must return the state in which its inputs are locked"
    );
    // … and the state that came with it knows everything
    let locked_state = built["state"].to_string();
    let after = parse(api::summary(&locked_state));
    let again = parse(api::plan_payment(&locked_state, "4000000000", "1000000000", false));
    println!(
        "after build_transfer returned a submittable transaction: result has a state: {}; pending entries in that state: {}; spendable {}; locked {}; \
         the same payment is planned again from the same note: {}",
        !built["state"].is_null(),
        after["pending"].as_array().unwrap().len(),
        after["spendable_balance"],
        after["locked_balance"],
        again["selection"]["positions"] == plan["selection"]["positions"],
    );
    assert_eq!((after["pending"].as_array().map(Vec::len), after["locked_balance"].as_str(), after["spendable_balance"].as_str()), (Some(1), Some("6000000000"), Some("10000000000")));
    assert_eq!(after["revision"].as_f64(), Some(rev(&state) + 1.0));
    assert_ne!(again["selection"]["positions"], plan["selection"]["positions"], "the locked note is not offered again");
    assert!(api::build_transfer(&SEED, &locked_state, &params.to_string(), rev(&locked_state)).unwrap_err().starts_with("note_locked:"));
    // the old copy of the state is refused once the locked one is the stored one
    assert!(api::build_transfer(&SEED, &state, &params.to_string(), rev(&locked_state)).unwrap_err().starts_with("stale_state:"));
    // the unshield is the same shape
    let unshield = json!({ "chain_id": "test", "inputs": again["selection"]["positions"], "to": "rouge1qqqq", "v_out": "1", "fee": "1000000000" });
    assert!(api::build_unshield(&SEED, &locked_state, &unshield.to_string(), rev(&locked_state)).unwrap_err().starts_with("address:"));
}
