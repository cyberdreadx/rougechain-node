//! REVIEW_WALLET_1 — the JavaScript-facing surface (see
//! `core/shield-v2-wallet/REVIEW_WALLET_1.md`). Run natively through `api`, as `tests/api.rs`.
//!
//! * `rw1_fN_…` — regression tests of confirmed defects; they failed on the reviewed commit
//!   (abab9a8) and pass since the fix.
//! * `rw1_sound_…` — attacks that were tried and do not work; they pass.

use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::{ShieldRequest, ShieldedKeys, TxContext, WalletState};
use quantum_vault_shield_v2_wasm::api;
use serde_json::{json, Value};

const Q: u64 = 1_000_000_000;
const SEED: [u8; 64] = [0x11; 64];

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
        "rw1-wasm",
    )
    .unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| {
        json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) })
    };
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "cd".repeat(32), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": [out(0, 258, 1346), out(1, 1402, 2490)],
    }] })
    .to_string()
}

/// F-6 (Low). Error strings are meant to be shown and logged ("an `Error` whose message starts
/// with a stable code"). The JSON arguments are parsed with `serde_json` and its error text is
/// forwarded; for a value of the wrong type that text QUOTES the value. The classic JavaScript
/// mistake of encoding twice — `JSON.stringify(JSON.stringify(scanKey))` — therefore turns the
/// whole scan key (the viewing key `dk` and `nk`) into an error message, and a twice-encoded state
/// turns every note's value and `r` into one.
///
/// Failed on abab9a8 (the error message contained the viewing key). Since the fix no error of the
/// surface forwards a parser message: a code, a fixed sentence, a line and a column.
#[test]
fn rw1_f6_an_error_message_must_not_quote_secret_input() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let state = api::new_state(&address, "").unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let key = api::export_scan_key(&SEED, true).unwrap();
    let key_v: Value = serde_json::from_str(&key).unwrap();
    let (dk, nk) = (key_v["dk"].as_str().unwrap(), key_v["nk"].as_str().unwrap());

    // the scan key, encoded twice
    let twice = serde_json::to_string(&key).unwrap();
    let e = api::scan(&state, &page, &twice, rev(&state)).expect_err("a JSON string is not a scan key");
    let leaks_key = e.contains(&dk[..64]) || e.contains(nk);

    // the state (with a note in it), encoded twice
    let scanned = parse(api::scan(&state, &page, &key, rev(&state)));
    let r = parse(api::summary(&scanned["state"].to_string()))["notes"][0]["r"].as_str().unwrap().to_string();
    assert!(scanned["state"].to_string().contains(&r), "the note's r is in the state blob");
    let state_twice = serde_json::to_string(&scanned["state"].to_string()).unwrap();
    let e2 = api::summary(&state_twice).expect_err("a JSON string is not a state");
    let leaks_note = e2.contains(&r);

    assert!(
        !leaks_key && !leaks_note,
        "error messages quote their input: scan-key error is {} bytes and contains the viewing key: {leaks_key}; \
         state error is {} bytes and contains a note's r: {leaks_note}",
        e.len(),
        e2.len()
    );
}

/// F-6, the general property: whatever is passed, in whatever position, wrapped or damaged in
/// whatever way, **no error of the surface contains any part of an argument**. Every argument
/// below carries a marker (the stand-in for a key, a note secret, an address, a memo), as a bare
/// string, as a JSON string, twice encoded, as a value of the wrong type, as a key name, inside a
/// valid structure in place of each field, truncated, and with invalid UTF-8-looking escapes; the
/// marker must never come back in an error. A long run of malformed inputs from a deterministic
/// generator is added on top.
#[test]
fn rw1_f6_no_error_of_the_surface_ever_contains_a_marker_from_its_input() {
    const MARKER: &str = "S3CR3T-marker-7f3a9c";
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let state0 = api::new_state(&address, "").unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let key = api::export_scan_key(&SEED, true).unwrap();
    let scanned = parse(api::scan(&state0, &page, &key, rev(&state0)));
    let state = scanned["state"].to_string();
    let anchor = scanned["anchor"].clone();
    let transfer = json!({ "chain_id": "test", "anchor": anchor, "expiry_height": 50, "inputs": [parse(api::summary(&state))["notes"][0]["position"]],
        "allow_unverified": true, "recipient": address, "amount": "1000000000", "fee": "1000000000" });
    let unshield = json!({ "chain_id": "test", "anchor": anchor, "inputs": [0], "to": "rouge1qqqq", "v_out": "1", "fee": "1000000000" });
    let shield = json!({ "chain_id": "test", "anchor": anchor, "anchor_height": 1, "from_pub_key": "ab".repeat(1952), "nonce": 1,
        "v_in": "3000000000", "fee": "1000000000", "recipient": address });
    let pending = json!({ "tx_type": "shielded_transfer_v2", "nullifiers": ["00".repeat(32), "11".repeat(32)], "outputs": ["22".repeat(32), "33".repeat(32)],
        "inputs": [0], "input_cms": [], "input_total": "1", "change": { "cm": "22".repeat(32), "value": "1" }, "expiry_height": 5, "status": "pending",
        "seen_height": null, "rejected_hint": false, "legacy": false });
    let reports = json!([report_for(&state, "a")]);

    // every way of planting the marker in one valid JSON argument
    fn plant(v: &Value, marker: &str, out: &mut Vec<String>) {
        let text = v.to_string();
        out.push(marker.to_string());
        out.push(format!("\"{marker}\""));
        out.push(format!("{text}{marker}"));
        out.push(format!("{marker}{text}"));
        out.push(serde_json::to_string(&format!("{text}{marker}")).unwrap()); // encoded twice
        out.push(json!({ marker: v }).to_string());
        out.push(json!([marker, v]).to_string());
        out.push(text[..text.len() / 2].to_string() + marker);
        out.push(format!("{{\"{marker}\":"));
        out.push(format!("\"\\ud800{marker}\""));
        fn pointers(v: &Value, at: String, out: &mut Vec<String>) {
            match v {
                Value::Object(m) => m.iter().for_each(|(k, c)| pointers(c, format!("{at}/{k}"), out)),
                Value::Array(a) => a.iter().enumerate().for_each(|(i, c)| pointers(c, format!("{at}/{i}"), out)),
                _ => {}
            }
            if !at.is_empty() {
                out.push(at);
            }
        }
        let mut all = Vec::new();
        pointers(v, String::new(), &mut all);
        for p in all {
            for rep in [json!(marker), json!([marker]), json!({ marker: marker }), json!(format!("{}{marker}", "ab".repeat(32))), json!(format!("{marker}\u{0}"))] {
                let mut x = v.clone();
                *x.pointer_mut(&p).unwrap() = rep;
                out.push(x.to_string());
            }
            // the key renamed to the marker
            if let Some((parent, name)) = p.rsplit_once('/') {
                let mut x = v.clone();
                if let Some(Value::Object(m)) = x.pointer_mut(parent) {
                    if let Some(val) = m.remove(name) {
                        m.insert(marker.to_string(), val);
                        out.push(x.to_string());
                    }
                }
            }
        }
    }
    let variants = |v: &Value| {
        let mut out = Vec::new();
        plant(v, MARKER, &mut out);
        out
    };
    let mut errors = 0usize;
    let mut check = |what: &str, r: api::ApiResult| {
        if let Err(e) = r {
            errors += 1;
            assert!(!e.contains(MARKER) && !e.contains("S3CR3T") && !e.contains("7f3a9c"), "{what}: the error quotes its input: {e}");
            assert!(e.len() < 300, "{what}: an error of {} bytes", e.len());
        }
    };
    let state_v: Value = serde_json::from_str(&state).unwrap();
    let key_v: Value = serde_json::from_str(&key).unwrap();
    let page_v: Value = serde_json::from_str(&page).unwrap();
    for s in variants(&state_v) {
        check("scan/state", api::scan(&s, &page, &key, rev(&s)));
        check("summary", api::summary(&s));
        check("pending", api::pending(&s));
        check("plan_payment/state", api::plan_payment(&s, "1", "1000000000", true));
        check("plan_self_merge/state", api::plan_self_merge(&s, "1000000000", true));
        check("build_transfer/state", api::build_transfer(&SEED, &s, &json!({}).to_string()));
        check("build_unshield/state", api::build_unshield(&SEED, &s, &unshield.to_string()));
        check("mark_pending/state", api::mark_pending(&s, &pending.to_string(), rev(&s)));
        check("resolve_pending", api::resolve_pending(&s, rev(&s)));
        check("note_rejection/state", api::note_rejection(&s, &"00".repeat(32), rev(&s)));
        check("confirm_roots/state", api::confirm_state(&s, &reports.to_string(), 1, rev(&s)));
        check("rescan_state", api::rescan_state(&s, "", rev(&s)));
        check("scan_pages/state", api::scan_pages(&s, "[]", &key, rev(&s)));
    }
    for k in variants(&key_v) {
        check("scan/key", api::scan(&state0, &page, &k, rev(&state0)));
        check("scan_pages/key", api::scan_pages(&state0, &format!("[{page}]"), &k, rev(&state0)));
    }
    for p in variants(&page_v) {
        check("scan/page", api::scan(&state0, &p, &key, rev(&state0)));
        check("scan_pages/pages", api::scan_pages(&state0, &format!("[{p}]"), &key, rev(&state0)));
        check("scan_pages/pages", api::scan_pages(&state0, &p, &key, rev(&state0)));
    }
    // (an unshield to a bad address fails before any proof; the transfer variants that stay valid
    // would prove, so their inputs name a note that does not exist)
    let mut transfer_no_note = transfer.clone();
    transfer_no_note["inputs"] = json!([7]);
    for t in variants(&transfer_no_note) {
        check("build_transfer/params", api::build_transfer(&SEED, &state, &t));
    }
    for u in variants(&unshield) {
        check("build_unshield/params", api::build_unshield(&SEED, &state, &u));
    }
    let mut shield_bad = shield.clone();
    shield_bad["v_in"] = json!("1");
    for s in variants(&shield_bad) {
        check("build_shield", api::build_shield(&s));
    }
    for p in variants(&pending) {
        check("mark_pending/record", api::mark_pending(&state, &p, rev(&state)));
    }
    for r in variants(&reports) {
        check("confirm_roots/reports", api::confirm_state(&state, &r, 0, rev(&state)));
    }
    for a in variants(&json!(address)) {
        check("parse_address", api::parse_address(&a));
        check("new_state", api::new_state(&a, ""));
        check("note_rejection/nullifier", api::note_rejection(&state, &a, rev(&state)));
        check("plan_payment/amount", api::plan_payment(&state, &a, "1", true));
        check("plan_payment/fee", api::plan_payment(&state, "1", &a, true));
        check("plan_self_merge/fee", api::plan_self_merge(&state, &a, true));
        check("attach_signature/envelope", api::attach_signature(&a, "ab"));
        check("attach_signature/sig", api::attach_signature(&json!({ "tx_type": "shield_v2" }).to_string(), &a));
    }
    // the address itself, damaged around a marker (an address is not secret, but a pasted
    // clipboard may hold anything)
    for a in [format!("{address}{MARKER}"), format!("{MARKER}{address}"), format!("rshield1{MARKER}"), address.replace("rshield1", &format!("{MARKER}1"))] {
        check("parse_address", api::parse_address(&a));
        check("new_state", api::new_state(&a, ""));
        let mut t = transfer_no_note.clone();
        t["recipient"] = json!(a);
        check("build_transfer/recipient", api::build_transfer(&SEED, &state, &t.to_string()));
        let mut u = unshield.clone();
        u["to"] = json!(a);
        check("build_unshield/to", api::build_unshield(&SEED, &state, &u.to_string()));
    }
    // a seed that is not a seed
    for seed in [MARKER.as_bytes().to_vec(), [MARKER.as_bytes(), &[0u8; 64][..]].concat()] {
        check("shielded_address", api::shielded_address(&seed));
        check("export_scan_key", api::export_scan_key(&seed, true));
        check("build_transfer/seed", api::build_transfer(&seed, &state, &transfer.to_string()));
    }
    // random damage: bytes of valid arguments overwritten with pieces of the marker
    let mut x = 0x2545_f491_4f6c_dd1du64;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let small_state = state0.clone();
    for _ in 0..1_500 {
        let mut damage = |text: &str| {
            let mut b = text.as_bytes().to_vec();
            for _ in 0..1 + rnd() % 3 {
                let at = (rnd() % b.len() as u64) as usize;
                let piece = &MARKER.as_bytes()[..1 + (rnd() % MARKER.len() as u64) as usize];
                let end = (at + piece.len()).min(b.len());
                b.splice(at..end, piece.iter().copied());
            }
            String::from_utf8_lossy(&b).into_owned()
        };
        let (s, p, k) = (damage(&small_state), damage(&page), damage(&key));
        let (t, pd, rp) = (damage(&transfer_no_note.to_string()), damage(&pending.to_string()), damage(&reports.to_string()));
        check("fuzz scan/state", api::scan(&s, &page, &key, rev(&s)));
        check("fuzz scan/page", api::scan(&small_state, &p, &key, rev(&small_state)));
        check("fuzz scan/key", api::scan(&small_state, &page, &k, rev(&small_state)));
        check("fuzz summary", api::summary(&s));
        check("fuzz build_transfer", api::build_transfer(&SEED, &state, &t));
        check("fuzz mark_pending", api::mark_pending(&state, &pd, rev(&state)));
        check("fuzz confirm_roots", api::confirm_state(&state, &rp, 0, rev(&state)));
        check("fuzz parse_address", api::parse_address(&damage(&address)));
    }
    assert!(errors > 5_000, "the inputs exercised the error paths ({errors} errors)");
}

/// What the surface hands back never contains the spending key, `nk` (outside `export_scan_key`),
/// the viewing key or the seed: the state blob, the scan result, the summary, the plans, and a
/// built transfer with a real proof.
#[test]
fn rw1_sound_no_key_material_in_states_results_or_built_transactions() {
    let keys = ShieldedKeys::from_seed(&SEED).unwrap();
    let (sk, nk, _pk, _ek, dk) = keys.expose_for_vectors();
    let secrets = [hex::encode(sk), hex::encode(nk), hex::encode(&dk[..64]), hex::encode(&dk[1088..1152]), hex::encode(&dk[2368..]), hex::encode(SEED)];
    let clean = |what: &str, text: &str| {
        for (i, s) in secrets.iter().enumerate() {
            assert!(!text.contains(s.as_str()), "{what} contains secret #{i}");
        }
    };
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    clean("shielded_address", &api::shielded_address(&SEED).unwrap());
    let state = api::new_state(&address, "").unwrap();
    let key = api::export_scan_key(&SEED, true).unwrap();
    // the viewing key alone carries no nk
    let ivk = api::export_scan_key(&SEED, false).unwrap();
    assert!(!ivk.contains(&hex::encode(nk)) && !ivk.contains(&hex::encode(sk)));
    assert!(!key.contains(&hex::encode(sk)) && !key.contains(&hex::encode(SEED)));

    let scanned_text = api::scan(&state, &page_with_one_shield(&SEED, 5 * Q), &key, rev(&state)).unwrap();
    clean("scan", &scanned_text);
    let scanned: Value = serde_json::from_str(&scanned_text).unwrap();
    let st = scanned["state"].to_string();
    clean("summary", &api::summary(&st).unwrap());
    clean("plan_payment", &api::plan_payment(&st, "1000000000", "1000000000", true).unwrap());

    let params = json!({ "chain_id": "test", "anchor": scanned["anchor"], "expiry_height": 50, "inputs": [parse(api::summary(&st))["notes"][0]["position"]],
        "allow_unverified": true, "recipient": address, "amount": "2000000000", "fee": "1000000000" });
    let built = api::build_transfer(&SEED, &st, &params.to_string()).unwrap();
    clean("build_transfer", &built);
    // the pending calls, the root check and the rescan state carry no key either
    let b0: Value = serde_json::from_str(&built).unwrap();
    let marked = api::mark_pending(&st, &b0["pending"].to_string(), rev(&st)).unwrap();
    clean("mark_pending", &marked);
    let marked = parse(Ok(marked))["state"].to_string();
    clean("pending", &api::pending(&marked).unwrap());
    clean("resolve_pending", &api::resolve_pending(&marked, rev(&marked)).unwrap());
    clean("note_rejection", &api::note_rejection(&marked, b0["nullifiers"][1].as_str().unwrap(), rev(&marked)).unwrap());
    clean("confirm_roots", &api::confirm_state(&marked, &json!([report_for(&marked, "n")]).to_string(), 1, rev(&marked)).unwrap());
    clean("rescan_state", &api::rescan_state(&marked, "", rev(&marked)).unwrap());
    let b: Value = serde_json::from_str(&built).unwrap();
    assert_eq!(b["needs_account_signature"], json!(false));
    // the envelope is the signer-less shape; nothing but the two V2 payload fields is set
    let env: Value = serde_json::from_str(b["envelope_json"].as_str().unwrap()).unwrap();
    assert_eq!((env["from_pub_key"].as_str(), env["sig"].as_str(), env["nonce"].as_u64(), env["version"].as_u64()), (Some(""), Some(""), Some(0), Some(1)));
    assert!(env.get("signed_payload").is_none_or(Value::is_null));
    // every error of the spending calls: no secret either (wrong state, wrong anchor, bad params)
    let other = api::new_state(&parse(api::shielded_address(&[0x22; 64]))["address"].as_str().unwrap().to_string(), "").unwrap();
    for (s, p) in [(&other, params.to_string()), (&st, "{}".to_string()), (&st, json!({ "chain_id": "test", "anchor": "00".repeat(32), "expiry_height": 5,
        "inputs": [0], "recipient": address, "amount": "1", "fee": "1000000000" }).to_string())] {
        let e = api::build_transfer(&SEED, s, &p).expect_err("refused");
        clean("a build_transfer error", &e);
    }
}

/// A scan key whose parts do not belong together, and keys of the wrong wallet, are refused or
/// find nothing — they never credit a note.
#[test]
fn rw1_sound_foreign_or_mixed_scan_keys_credit_nothing() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let state = api::new_state(&address, "").unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let mine: Value = serde_json::from_str(&api::export_scan_key(&SEED, true).unwrap()).unwrap();
    let theirs: Value = serde_json::from_str(&api::export_scan_key(&[0x22; 64], true).unwrap()).unwrap();
    // another wallet's key on this state: refused (pk differs)
    assert!(api::scan(&state, &page, &theirs.to_string(), rev(&state)).is_err());
    // this wallet's pk with another wallet's viewing key: nothing opens
    let mut mixed = mine.clone();
    mixed["dk"] = theirs["dk"].clone();
    let r = parse(api::scan(&state, &page, &mixed.to_string(), rev(&state)));
    assert_eq!((&r["unverified_balance"], &r["confirmed_balance"]), (&json!("0"), &json!("0")));
    // the right keys: the note is there
    assert_eq!(parse(api::scan(&state, &page, &mine.to_string(), rev(&state)))["unverified_balance"], json!((2 * Q).to_string()));
}
