//! The JavaScript-facing surface, exercised natively through `api` (the `#[wasm_bindgen]`
//! exports are one-line wrappers over these functions): the happy path end to end with real
//! proofs, and — the property that matters for WebAssembly, where a panic is a trap — that
//! malformed input of every kind comes back as an `Err`, never as a panic.

use quantum_vault_shield_v2::reference::PublicInputs;
use quantum_vault_shield_v2::verify_spend;
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

fn account_key() -> Vec<u8> {
    (0..1_952u32).map(|i| (i % 251) as u8).collect()
}

/// A listing page (the node's JSON shape) with one shield of `value + 1 XRGE` to `seed`'s wallet
/// at height 1, leaves 0 and 1.
fn page_with_one_shield(seed: &[u8], value: u64) -> String {
    let keys = ShieldedKeys::from_seed(seed).unwrap();
    let key = account_key();
    let tx = deterministic::shield(
        &ShieldRequest {
            ctx: TxContext { chain_id: "test".into(), anchor: WalletState::new([0; 32]).anchor(), anchor_height: 36, expiry_height: 100 },
            from_pub_key: &key,
            nonce: 1,
            v_in: value + Q,
            fee: Q,
            recipient: &keys.address(),
            max_fee: None,
        },
        "wasm-api",
    )
    .unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| {
        json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) })
    };
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "ab".repeat(32), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": [out(0, 258, 1346), out(1, 1402, 2490)],
    }] })
    .to_string()
}

#[test]
fn address_scan_plan_build_end_to_end() {
    let c = parse(api::constants());
    assert_eq!(c["min_fee_quanta"], "1000000000");
    let me = parse(api::shielded_address(&SEED));
    let address = me["address"].as_str().unwrap();
    assert!(address.starts_with("rshield1"));
    assert_eq!(parse(api::parse_address(address)), me);
    let them = parse(api::shielded_address(&OTHER));

    // scan
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state0 = api::new_state(address).unwrap();
    let scanned = parse(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &key));
    // one node's listing: the note is there, unverified — not in the confirmed balance
    assert_eq!((scanned["unverified_balance"].as_str(), scanned["confirmed_balance"].as_str()), (Some("9000000000"), Some("0")));
    assert_eq!(scanned["report"]["received"].as_array().unwrap().len(), 1);
    let unverified = scanned["state"].to_string();
    assert_eq!(parse(api::plan_payment(&unverified, "5000000000", "1000000000", false))["status"], "insufficient_funds");
    assert_eq!(parse(api::plan_payment(&unverified, "5000000000", "1000000000", true))["status"], "ok");
    // the same page through scan_pages gives the same state
    let pages = format!("[{}]", page_with_one_shield(&SEED, 9 * Q));
    assert_eq!(parse(api::scan_pages(&state0, &pages, &key))["state"], scanned["state"]);
    // the root check: one node is not enough, two that agree are (quorum 0 = the default, 2)
    let report = |id: &str| json!({ "node_id": id, "height": 1, "root": scanned["anchor"] });
    let one = parse(api::confirm_roots(&unverified, &json!([report("a")]).to_string(), 0));
    assert_eq!((one["report"]["matched_height"].is_null(), one["report"]["agreeing"].as_u64()), (true, Some(1)));
    assert_eq!(parse(api::summary(&one["state"].to_string()))["confirmed_balance"], "0");
    let two = parse(api::confirm_roots(&unverified, &json!([report("a"), report("b")]).to_string(), 0));
    assert_eq!((two["report"]["matched_height"].as_u64(), two["report"]["newly_confirmed"].as_array().map(Vec::len)), (Some(1), Some(1)));
    let state = two["state"].to_string();
    let summary = parse(api::summary(&state));
    assert_eq!(summary["notes"].as_array().unwrap().len(), 1);
    assert_eq!(summary["notes"][0]["confirmed"], true);
    assert_eq!((summary["confirmed_balance"].as_str(), summary["unverified_balance"].as_str(), summary["spendable_balance"].as_str()), (Some("9000000000"), Some("0"), Some("9000000000")));
    assert_eq!(summary["anchor"], scanned["anchor"]);
    // the viewing key alone finds the note; another wallet's key is refused for this state
    let view = api::export_scan_key(&SEED, false).unwrap();
    assert_eq!(parse(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &view))["unverified_balance"], "9000000000");
    assert!(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &api::export_scan_key(&OTHER, true).unwrap()).is_err());
    // a note for someone else: nothing received
    let other_state = api::new_state(them["address"].as_str().unwrap()).unwrap();
    let r = parse(api::scan(&other_state, &page_with_one_shield(&SEED, 9 * Q), &api::export_scan_key(&OTHER, true).unwrap()));
    assert_eq!((r["unverified_balance"].as_str(), r["report"]["received"].as_array().map(Vec::len)), (Some("0"), Some(0)));

    // plan
    let plan = parse(api::plan_payment(&state, "5000000000", "1000000000", false));
    assert_eq!((plan["status"].as_str(), plan["selection"]["change"].as_str()), (Some("ok"), Some("3000000000")));
    assert_eq!(parse(api::plan_payment(&state, "9000000000", "1000000000", false))["status"], "insufficient_funds");
    assert!(api::plan_self_merge(&state, "1000000000", false).unwrap_err().starts_with("request:"));

    // build a transfer (a real proof)
    let params = json!({ "chain_id": "test", "anchor": scanned["anchor"], "expiry_height": 100, "inputs": plan["selection"]["positions"],
        "recipient": them["address"], "amount": "5000000000", "fee": "1000000000" });
    let built = parse(api::build_transfer(&SEED, &state, &params.to_string()));
    assert_eq!(built["tx_type"], "shielded_transfer_v2");
    assert_eq!((built["needs_account_signature"].as_bool(), built["signing_bytes"].is_null()), (Some(false), true));
    let (body, proof) = (hex::decode(built["body"].as_str().unwrap()).unwrap(), hex::decode(built["proof"].as_str().unwrap()).unwrap());
    assert_eq!(body.len(), 2_546);
    let public = PublicInputs::from_bytes(&hex::decode(built["public_inputs"].as_str().unwrap()).unwrap()).unwrap();
    verify_spend(&public, &proof).expect("the proof in the result verifies");
    let env: Value = serde_json::from_str(built["envelope_json"].as_str().unwrap()).unwrap();
    assert_eq!((env["from_pub_key"].as_str(), env["sig"].as_str(), env["nonce"].as_u64(), env["version"].as_u64()), (Some(""), Some(""), Some(0), Some(1)));
    assert!(built["envelope_json"].as_str().unwrap().contains(r#""fee":0.0"#));
    assert_eq!(env["payload"]["shield_v2_body"], built["body"]);
    let roles: Vec<&str> = built["outputs"].as_array().unwrap().iter().map(|o| o["role"].as_str().unwrap()).collect();
    assert!(roles.contains(&"payment") && roles.contains(&"change"));
    assert!(api::attach_signature(built["envelope_json"].as_str().unwrap(), "ab").unwrap_err().starts_with("request:"));
    // the default expiry is the scanned height + 64; the result carries the pending record
    assert_eq!(built["expiry_height"], 100);
    let mut defaulted = params.clone();
    defaulted.as_object_mut().unwrap().remove("expiry_height");
    let pending_record = built["pending"].to_string();
    assert_eq!(built["pending"]["inputs"], built["spent_positions"]);
    assert_eq!((built["pending"]["expiry_height"].as_u64(), built["pending"]["status"].as_str()), (Some(100), Some("pending")));
    // pending bookkeeping: recorded before submitting; the inputs are locked whatever a node says
    let pending = api::mark_pending(&state, &pending_record).unwrap();
    let sum = parse(api::summary(&pending));
    assert_eq!((sum["locked_balance"].as_str(), sum["spendable_balance"].as_str(), sum["confirmed_balance"].as_str()), (Some("9000000000"), Some("0"), Some("9000000000")));
    assert_eq!(parse(api::pending(&pending)).as_array().unwrap().len(), 1);
    assert_eq!(parse(api::plan_payment(&pending, "5000000000", "1000000000", true))["status"], "insufficient_funds");
    assert!(api::build_transfer(&SEED, &pending, &params.to_string()).unwrap_err().starts_with("note_locked:"));
    assert!(api::mark_pending(&pending, &pending_record).unwrap_err().starts_with("request:"), "already recorded");
    let hinted = parse(api::note_rejection(&pending, built["nullifiers"][0].as_str().unwrap()));
    assert_eq!(hinted["found"], true);
    let hinted = hinted["state"].to_string();
    assert_eq!(parse(api::pending(&hinted))[0]["rejected_hint"], true);
    let r = parse(api::resolve_pending(&hinted, false));
    assert_eq!((r["still_pending"].as_u64(), r["expired"].as_array().map(Vec::len), r["mined"].as_array().map(Vec::len)), (Some(1), Some(0), Some(0)));
    assert_eq!(parse(api::summary(&r["state"].to_string()))["spendable_balance"], "0", "a claimed rejection releases nothing");
    // the chain passes the expiry height without the transaction: released
    let empty = json!({ "active": true, "tip_height": 100, "from_height": 2, "next_height": 101, "txs": [] }).to_string();
    let later = parse(api::scan(&hinted, &empty, &key))["state"].to_string();
    assert_eq!(parse(api::resolve_pending(&later, true))["still_pending"], 1, "not under the confirmed-height policy: nobody vouched for height 100");
    let r = parse(api::resolve_pending(&later, false));
    assert_eq!((r["still_pending"].as_u64(), r["expired"].as_array().map(Vec::len)), (Some(0), Some(1)));
    assert_eq!(parse(api::summary(&r["state"].to_string()))["spendable_balance"], "9000000000");
    // a rescan state keeps the pending list
    assert_eq!(parse(api::pending(&api::rescan_state(&hinted).unwrap())).as_array().unwrap().len(), 1);
    assert!(api::mark_pending(&state, "{}").is_err());
    // the fee ceiling: 10 x the minimum unless max_fee says otherwise
    let mut p = params.clone();
    p["fee"] = json!("3000000000");
    p["max_fee"] = json!("2000000000");
    assert!(api::build_transfer(&SEED, &state, &p.to_string()).unwrap_err().starts_with("fee_above_maximum:"));
    // an expiry outside the bound, an anchor height that is not the state's
    let mut p = params.clone();
    p["expiry_height"] = json!(130);
    assert!(api::build_transfer(&SEED, &state, &p.to_string()).unwrap_err().starts_with("request:"));
    let mut p = params.clone();
    p["anchor_height"] = json!(7);
    assert!(api::build_transfer(&SEED, &state, &p.to_string()).unwrap_err().starts_with("request:"));
    let _ = defaulted;
    // the wrong seed for this state, a wrong anchor, a fee below the minimum
    assert!(api::build_transfer(&OTHER, &state, &params.to_string()).unwrap_err().starts_with("request:"));
    let mut p = params.clone();
    p["anchor"] = json!("00".repeat(32));
    assert!(api::build_transfer(&SEED, &state, &p.to_string()).unwrap_err().starts_with("anchor_mismatch:"));
    let mut p = params.clone();
    p["fee"] = json!("999999999");
    assert!(api::build_transfer(&SEED, &state, &p.to_string()).unwrap_err().starts_with("fee_below_minimum:"));
    let mut p = json!({ "chain_id": "test", "anchor": scanned["anchor"], "expiry_height": 100, "inputs": plan["selection"]["positions"], "to": "rouge1nope", "v_out": "1", "fee": "1000000000" });
    assert!(api::build_unshield(&SEED, &state, &p.to_string()).unwrap_err().starts_with("address:"));
    p["to"] = them["address"].clone();
    assert!(api::build_unshield(&SEED, &state, &p.to_string()).unwrap_err().starts_with("address:"), "a shielded address is not an account");

    // build a shield (a real proof) and attach the account signature
    let params = json!({ "chain_id": "test", "anchor": scanned["anchor"], "anchor_height": 1, "from_pub_key": hex::encode(account_key()),
        "nonce": 7, "v_in": "3000000000", "fee": "1000000000", "recipient": address });
    let built = parse(api::build_shield(&params.to_string()));
    assert_eq!((built["tx_type"].as_str(), built["needs_account_signature"].as_bool()), (Some("shield_v2"), Some(true)));
    assert_eq!((built["expiry_height"].as_u64(), built["pending"].is_null()), (Some(65), true), "the default expiry is anchor_height + 64; a shield locks no note");
    let mut no_height = params.clone();
    no_height.as_object_mut().unwrap().remove("anchor_height");
    assert!(api::build_shield(&no_height.to_string()).unwrap_err().starts_with("request:"));
    let signing = String::from_utf8(hex::decode(built["signing_bytes"].as_str().unwrap()).unwrap()).unwrap();
    assert!(signing.contains(built["proof"].as_str().unwrap()) && signing.contains(built["body"].as_str().unwrap()));
    let signed: Value = serde_json::from_str(&api::attach_signature(built["envelope_json"].as_str().unwrap(), "0a0b").unwrap()).unwrap();
    assert_eq!((signed["sig"].as_str(), signed["nonce"].as_u64()), (Some("0a0b"), Some(7)));
    assert_eq!(signed["payload"], serde_json::from_str::<Value>(built["envelope_json"].as_str().unwrap()).unwrap()["payload"]);
    assert!(api::attach_signature(built["envelope_json"].as_str().unwrap(), "0A0B").is_err());
}

/// Nothing a caller can pass makes an export panic (a trap in WebAssembly): every malformed
/// argument, in every position, is an `Err` with a code.
#[test]
fn malformed_input_is_an_error_never_a_panic() {
    let me = parse(api::shielded_address(&SEED));
    let address = me["address"].as_str().unwrap().to_string();
    let state = api::new_state(&address).unwrap();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let long = "f".repeat(100_000);
    let junk: Vec<&str> = vec![
        "", " ", "{", "}", "{}", "[]", "null", "0", "-1", "1e999", "\"\"", "\u{0}", "rshield1", "rouge1", "rshield1qqqqqq",
        "{\"a\":", "[[[[[[", &long, "\u{1f600}", "18446744073709551616", "0x10", "+1", "1.5",
    ];
    let coded = |r: api::ApiResult| {
        let e = r.expect_err("malformed input must be refused");
        let code = e.split(':').next().unwrap_or("");
        assert!(!code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "an error starts with its code: {e}");
    };
    for seed in [&[][..], &[0u8; 1], &[0u8; 63], &[0u8; 65], &[0u8; 4096]] {
        coded(api::shielded_address(seed));
        coded(api::export_scan_key(seed, true));
        coded(api::build_transfer(seed, &state, "{}"));
        coded(api::build_unshield(seed, &state, "{}"));
    }
    for j in &junk {
        coded(api::parse_address(j));
        coded(api::new_state(j));
        coded(api::scan(j, &page, &key));
        coded(api::scan(&state, j, &key));
        coded(api::scan(&state, &page, j));
        coded(api::summary(j));
        coded(api::plan_payment(j, "1", "1", true));
        if j.parse::<u64>().is_err() {
            coded(api::plan_payment(&state, j, "1", true));
            coded(api::plan_payment(&state, "1", j, true));
            coded(api::plan_self_merge(&state, j, true));
        }
        coded(api::plan_self_merge(j, "1", true));
        coded(api::scan_pages(j, "[]", &key));
        if !j.trim().is_empty() {
            coded(api::scan_pages(&state, &format!("[{j}]"), &key));
        }
        if *j != "[]" {
            coded(api::scan_pages(&state, j, &key));
        }
        coded(api::pending(j));
        coded(api::resolve_pending(j, false));
        coded(api::rescan_state(j));
        coded(api::note_rejection(j, &"00".repeat(32)));
        coded(api::note_rejection(&state, j));
        coded(api::confirm_roots(j, "[]", 0));
        if *j != "[]" {
            coded(api::confirm_roots(&state, j, 0));
        }
        coded(api::confirm_roots(&state, &json!([{ "node_id": "a", "height": 0, "root": j }]).to_string(), 0));
        coded(api::build_shield(j));
        coded(api::build_transfer(&SEED, j, "{}"));
        coded(api::build_transfer(&SEED, &state, j));
        coded(api::build_unshield(&SEED, &state, j));
        coded(api::attach_signature(j, "ab"));
        coded(api::mark_pending(j, "{}"));
        coded(api::mark_pending(&state, j));
    }
    // well-formed JSON with wrong contents
    let anchor = parse(api::summary(&state))["anchor"].clone();
    let base = json!({ "chain_id": "test", "anchor": anchor, "expiry_height": 5, "inputs": [0], "recipient": address, "amount": "1", "fee": "1000000000" });
    for (field, bad) in [
        ("anchor", json!("zz")), ("anchor", json!("ff".repeat(32))), ("anchor", json!(5)), ("chain_id", json!("")), ("expiry_height", json!(-1)),
        ("expiry_height", json!("5")), ("inputs", json!([])), ("inputs", json!([0, 1, 2])), ("inputs", json!([7])), ("inputs", json!("0")),
        ("recipient", json!("rshield1qqqq")), ("amount", json!(1)), ("amount", json!("-1")), ("fee", json!("1e9")),
        ("max_fee", json!(5)), ("max_fee", json!("x")), ("anchor_height", json!("1")), ("anchor_height", json!(-1)),
    ] {
        let mut p = base.clone();
        p[field] = bad;
        coded(api::build_transfer(&SEED, &state, &p.to_string()));
    }
    let shield = json!({ "chain_id": "test", "anchor": anchor, "anchor_height": 1, "expiry_height": 5, "from_pub_key": hex::encode(account_key()), "nonce": 1,
        "v_in": "3000000000", "fee": "1000000000", "recipient": address });
    for (field, bad) in [
        ("from_pub_key", json!("ab")), ("from_pub_key", json!("AB".repeat(1952))), ("from_pub_key", json!("zz".repeat(1952))),
        ("v_in", json!("1000000000")), ("v_in", json!("0")), ("fee", json!("0")), ("nonce", json!("1")), ("recipient", json!(address.to_uppercase() + "x")),
    ] {
        let mut p = shield.clone();
        p[field] = bad;
        coded(api::build_shield(&p.to_string()));
    }
    // a scan key with damaged parts; a state edited by hand
    let k: Value = serde_json::from_str(&key).unwrap();
    for (field, bad) in [("pk", json!("00")), ("nk", json!("ff".repeat(32))), ("dk", json!("00".repeat(2399))), ("dk", json!("ff".repeat(2400)))] {
        let mut x = k.clone();
        x[field] = bad;
        coded(api::scan(&state, &page, &x.to_string()));
    }
    let mut s: Value = serde_json::from_str(&state).unwrap();
    s["tree"]["frontier"] = json!([]);
    coded(api::scan(&s.to_string(), &page, &key));
    coded(api::summary(&s.to_string()));
}
