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

/// The revision of a state (what a client keeps next to the stored state); 0 for anything that
/// is not a state.
fn rev(state: &str) -> f64 {
    api::summary(state).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["revision"].as_f64()).unwrap_or(0.0)
}

/// What a node that holds exactly this state's view of the pool reports (`report` of
/// `/api/shield-v2/stats`), under the id the caller gives it.
fn report_for(state: &str, id: &str) -> Value {
    let s: Value = serde_json::from_str(&api::summary(state).expect("a state")).unwrap();
    json!({ "node_id": id, "height": s["scanned_height"], "tree_root": s["anchor"], "nullifier_acc": s["nullifier_acc"],
        "note_count": s["note_count"], "nullifier_count": s["nullifier_count"] })
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
    let state0 = api::new_state(address, "").unwrap();
    let scanned = parse(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &key, rev(&state0)));
    // one node's listing: the note is there, unverified — not in the confirmed balance
    assert_eq!((scanned["unverified_balance"].as_str(), scanned["confirmed_balance"].as_str()), (Some("9000000000"), Some("0")));
    assert_eq!(scanned["report"]["received"].as_array().unwrap().len(), 1);
    let unverified = scanned["state"].to_string();
    assert_eq!(parse(api::plan_payment(&unverified, "5000000000", "1000000000", false))["status"], "insufficient_funds");
    assert_eq!(parse(api::plan_payment(&unverified, "5000000000", "1000000000", true))["status"], "ok");
    // the same page through scan_pages gives the same state
    let pages = format!("[{}]", page_with_one_shield(&SEED, 9 * Q));
    assert_eq!(parse(api::scan_pages(&state0, &pages, &key, rev(&state0)))["state"], scanned["state"]);
    // every changing call returns the revision of the state it returns
    assert_eq!((rev(&state0), scanned["revision"].as_u64(), rev(&unverified)), (0.0, Some(1), 1.0));
    // an unverified note is not handed to a builder unless the caller says so
    let early = json!({ "chain_id": "test", "anchor": scanned["anchor"], "inputs": [parse(api::summary(&unverified))["notes"][0]["position"]], "recipient": them["address"], "amount": "5000000000", "fee": "1000000000" });
    assert!(api::build_transfer(&SEED, &unverified, &early.to_string()).unwrap_err().starts_with("note_unverified:"));
    // the state check: one node is not enough, two that agree are (quorum 0 = the default, 2)
    let report = |id: &str| report_for(&unverified, id);
    assert_eq!(report("a")["nullifier_count"], 2, "the report carries the nullifier half of the state");
    // the tree root alone is not the state: another nullifier hash is a conflict, not a match
    let mut half = [report("a"), report("b")];
    half.iter_mut().for_each(|r| r["nullifier_acc"] = json!("00".repeat(32)));
    let c = parse(api::confirm_state(&unverified, &json!(half).to_string(), 0, rev(&unverified)));
    assert_eq!((c["report"]["diverged"].as_bool(), c["report"]["matched_height"].is_null()), (Some(true), true));
    // a report in the former shape (a root and nothing else) is refused
    assert!(api::confirm_roots(&unverified, &json!([{ "node_id": "a", "height": 1, "root": scanned["anchor"] }]).to_string(), 0, rev(&unverified)).unwrap_err().starts_with("request:"));
    let one = parse(api::confirm_state(&unverified, &json!([report("a")]).to_string(), 0, rev(&unverified)));
    assert_eq!((one["report"]["matched_height"].is_null(), one["report"]["agreeing"].as_u64()), (true, Some(1)));
    assert_eq!(parse(api::summary(&one["state"].to_string()))["confirmed_balance"], "0");
    let two = parse(api::confirm_state(&unverified, &json!([report("a"), report("b")]).to_string(), 0, rev(&unverified)));
    assert_eq!((two["report"]["matched_height"].as_u64(), two["report"]["newly_confirmed"].as_array().map(Vec::len)), (Some(1), Some(1)));
    let state = two["state"].to_string();
    let summary = parse(api::summary(&state));
    assert_eq!(summary["notes"].as_array().unwrap().len(), 1);
    assert_eq!(summary["notes"][0]["confirmed"], true);
    assert_eq!((summary["confirmed_balance"].as_str(), summary["unverified_balance"].as_str(), summary["spendable_balance"].as_str()), (Some("9000000000"), Some("0"), Some("9000000000")));
    assert_eq!(summary["anchor"], scanned["anchor"]);
    // the viewing key alone finds the note; another wallet's key is refused for this state
    let view = api::export_scan_key(&SEED, false).unwrap();
    assert_eq!(parse(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &view, rev(&state0)))["unverified_balance"], "9000000000");
    assert!(api::scan(&state0, &page_with_one_shield(&SEED, 9 * Q), &api::export_scan_key(&OTHER, true).unwrap(), rev(&state0)).is_err());
    // a note for someone else: nothing received
    let other_state = api::new_state(them["address"].as_str().unwrap(), "").unwrap();
    let r = parse(api::scan(&other_state, &page_with_one_shield(&SEED, 9 * Q), &api::export_scan_key(&OTHER, true).unwrap(), rev(&other_state)));
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
    assert_eq!(built["pending"]["outputs"].as_array().map(Vec::len), Some(2), "the record carries both output commitments");
    let marked = parse(api::mark_pending(&state, &pending_record, rev(&state)));
    assert_eq!(marked["revision"].as_f64(), Some(rev(&state) + 1.0));
    let pending = marked["state"].to_string();
    // a writer that holds an older copy than the stored one is refused, not merged over
    assert!(api::mark_pending(&state, &pending_record, rev(&pending)).unwrap_err().starts_with("stale_state:"));
    assert!(api::resolve_pending(&pending, rev(&state)).unwrap_err().starts_with("stale_state:"));
    for bad in [-1.0, 0.5, f64::NAN, f64::INFINITY, 1e300] {
        assert!(api::mark_pending(&state, &pending_record, bad).unwrap_err().starts_with("request:"));
    }
    let sum = parse(api::summary(&pending));
    assert_eq!((sum["locked_balance"].as_str(), sum["spendable_balance"].as_str(), sum["confirmed_balance"].as_str()), (Some("9000000000"), Some("0"), Some("9000000000")));
    assert_eq!(parse(api::pending(&pending)).as_array().unwrap().len(), 1);
    assert_eq!(parse(api::plan_payment(&pending, "5000000000", "1000000000", true))["status"], "insufficient_funds");
    assert!(api::build_transfer(&SEED, &pending, &params.to_string()).unwrap_err().starts_with("note_locked:"));
    assert!(api::mark_pending(&pending, &pending_record, rev(&pending)).unwrap_err().starts_with("request:"), "already recorded");
    let hinted = parse(api::note_rejection(&pending, built["nullifiers"][0].as_str().unwrap(), rev(&pending)));
    assert_eq!(hinted["found"], true);
    let hinted = hinted["state"].to_string();
    assert_eq!(parse(api::pending(&hinted))[0]["rejected_hint"], true);
    let r = parse(api::resolve_pending(&hinted, rev(&hinted)));
    assert_eq!((r["still_pending"].as_u64(), r["expired"].as_array().map(Vec::len), r["mined"].as_array().map(Vec::len), r["superseded"].as_array().map(Vec::len)), (Some(1), Some(0), Some(0), Some(0)));
    assert_eq!(parse(api::summary(&r["state"].to_string()))["spendable_balance"], "0", "a claimed rejection releases nothing");
    // the chain passes the expiry height without the transaction: released
    let empty = json!({ "active": true, "tip_height": 100, "from_height": 2, "next_height": 101, "txs": [] }).to_string();
    let later = parse(api::scan(&hinted, &empty, &key, rev(&hinted)))["state"].to_string();
    assert_eq!(parse(api::resolve_pending(&later, rev(&later)))["still_pending"], 1, "scanned is not confirmed: nobody vouched for height 100");
    // one node vouching for it — under one name or said twice — is not a quorum
    let alone = parse(api::confirm_state(&later, &json!([report_for(&later, "a"), report_for(&later, "a")]).to_string(), 0, rev(&later)));
    assert!(alone["report"]["matched_height"].is_null());
    // two nodes confirm height 100: now, and only now, it is released
    let confirmed = parse(api::confirm_state(&later, &json!([report_for(&later, "a"), report_for(&later, "b")]).to_string(), 0, rev(&later)));
    assert_eq!(confirmed["report"]["matched_height"], 100);
    let confirmed = confirmed["state"].to_string();
    let r = parse(api::resolve_pending(&confirmed, rev(&confirmed)));
    assert_eq!((r["still_pending"].as_u64(), r["expired"].as_array().map(Vec::len)), (Some(0), Some(1)));
    assert_eq!(parse(api::summary(&r["state"].to_string()))["spendable_balance"], "9000000000");
    // a rescan state keeps the pending list, continues the revision, and can change the dust limit
    let rescan = parse(api::rescan_state(&hinted, "", rev(&hinted)));
    assert_eq!((parse(api::pending(&rescan["state"].to_string())).as_array().unwrap().len(), rescan["revision"].as_f64()), (1, Some(rev(&hinted) + 1.0)));
    let rescan = parse(api::rescan_state(&hinted, "1", rev(&hinted)))["state"].to_string();
    assert_eq!(parse(api::summary(&rescan))["min_note_value"], "1");
    assert_eq!(parse(api::summary(&api::new_state(address, "").unwrap()))["min_note_value"], "1000000000");
    assert!(api::new_state(address, "0").unwrap_err().starts_with("request:"));
    assert!(api::mark_pending(&state, "{}", rev(&state)).is_err());
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
    let state = api::new_state(&address, "").unwrap();
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
        coded(api::new_state(j, ""));
        coded(api::scan(j, &page, &key, rev(j)));
        coded(api::scan(&state, j, &key, rev(&state)));
        coded(api::scan(&state, &page, j, rev(&state)));
        coded(api::summary(j));
        coded(api::plan_payment(j, "1", "1", true));
        if j.parse::<u64>().is_err() {
            coded(api::plan_payment(&state, j, "1", true));
            coded(api::plan_payment(&state, "1", j, true));
            coded(api::plan_self_merge(&state, j, true));
        }
        coded(api::plan_self_merge(j, "1", true));
        coded(api::scan_pages(j, "[]", &key, rev(j)));
        if !j.trim().is_empty() {
            coded(api::scan_pages(&state, &format!("[{j}]"), &key, rev(&state)));
        }
        if *j != "[]" {
            coded(api::scan_pages(&state, j, &key, rev(&state)));
        }
        coded(api::pending(j));
        coded(api::resolve_pending(j, rev(j)));
        coded(api::rescan_state(j, "", rev(j)));
        coded(api::note_rejection(j, &"00".repeat(32), rev(j)));
        coded(api::note_rejection(&state, j, rev(&state)));
        coded(api::confirm_state(j, "[]", 0, rev(j)));
        if *j != "[]" {
            coded(api::confirm_state(&state, j, 0, rev(&state)));
        }
        coded(api::confirm_state(&state, &json!([{ "node_id": "a", "height": 0, "tree_root": j, "nullifier_acc": "00".repeat(32), "note_count": 0, "nullifier_count": 0 }]).to_string(), 0, rev(&state)));
        coded(api::confirm_state(&state, &json!([{ "node_id": "a", "height": 0, "tree_root": "00".repeat(32), "nullifier_acc": j, "note_count": 0, "nullifier_count": 0 }]).to_string(), 0, rev(&state)));
        coded(api::confirm_roots(&state, &json!([{ "node_id": "a", "height": 0, "root": j }]).to_string(), 0, rev(&state)));
        if !matches!(*j, "" | "1") {
            coded(api::new_state(&address, j));
        }
        coded(api::build_shield(j));
        coded(api::build_transfer(&SEED, j, "{}"));
        coded(api::build_transfer(&SEED, &state, j));
        coded(api::build_unshield(&SEED, &state, j));
        coded(api::attach_signature(j, "ab"));
        coded(api::mark_pending(j, "{}", rev(j)));
        coded(api::mark_pending(&state, j, rev(&state)));
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
        coded(api::scan(&state, &page, &x.to_string(), rev(&state)));
    }
    let mut s: Value = serde_json::from_str(&state).unwrap();
    s["tree"]["frontier"] = json!([]);
    coded(api::scan(&s.to_string(), &page, &key, rev(&s.to_string())));
    coded(api::summary(&s.to_string()));
}
