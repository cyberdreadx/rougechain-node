//! REVIEW_WALLET_1 — the JavaScript-facing surface (see
//! `core/shield-v2-wallet/REVIEW_WALLET_1.md`). Run natively through `api`, as `tests/api.rs`.
//!
//! * `rw1_fN_…` — regression tests of confirmed defects; they FAIL on the reviewed commit
//!   (abab9a8) on purpose.
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

fn account_key() -> Vec<u8> {
    (0..1_952u32).map(|i| (i % 251) as u8).collect()
}

fn page_with_one_shield(seed: &[u8], value: u64) -> String {
    let keys = ShieldedKeys::from_seed(seed).unwrap();
    let key = account_key();
    let tx = deterministic::shield(
        &ShieldRequest {
            ctx: TxContext { chain_id: "test".into(), anchor: WalletState::new([0; 32]).anchor(), expiry_height: 100 },
            from_pub_key: &key,
            nonce: 1,
            v_in: value + Q,
            fee: Q,
            recipient: &keys.address(),
        },
        "rw1-wasm",
    )
    .unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| {
        json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) })
    };
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "h", "tx_type": "shield_v2",
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
/// FAILS on abab9a8: the error message contains the viewing key.
#[test]
fn rw1_f6_an_error_message_must_not_quote_secret_input() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let state = api::new_state(&address).unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let key = api::export_scan_key(&SEED, true).unwrap();
    let key_v: Value = serde_json::from_str(&key).unwrap();
    let (dk, nk) = (key_v["dk"].as_str().unwrap(), key_v["nk"].as_str().unwrap());

    // the scan key, encoded twice
    let twice = serde_json::to_string(&key).unwrap();
    let e = api::scan(&state, &page, &twice).expect_err("a JSON string is not a scan key");
    let leaks_key = e.contains(&dk[..64]) || e.contains(nk);

    // the state (with a note in it), encoded twice
    let scanned = parse(api::scan(&state, &page, &key));
    let r = scanned["state"]["notes"][0]["r"].as_str().unwrap().to_string();
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
    let state = api::new_state(&address).unwrap();
    let key = api::export_scan_key(&SEED, true).unwrap();
    // the viewing key alone carries no nk
    let ivk = api::export_scan_key(&SEED, false).unwrap();
    assert!(!ivk.contains(&hex::encode(nk)) && !ivk.contains(&hex::encode(sk)));
    assert!(!key.contains(&hex::encode(sk)) && !key.contains(&hex::encode(SEED)));

    let scanned_text = api::scan(&state, &page_with_one_shield(&SEED, 5 * Q), &key).unwrap();
    clean("scan", &scanned_text);
    let scanned: Value = serde_json::from_str(&scanned_text).unwrap();
    let st = scanned["state"].to_string();
    clean("summary", &api::summary(&st).unwrap());
    clean("plan_payment", &api::plan_payment(&st, "1000000000", "1000000000").unwrap());

    let params = json!({ "chain_id": "test", "anchor": scanned["anchor"], "expiry_height": 50, "inputs": [scanned["state"]["notes"][0]["position"]],
        "recipient": address, "amount": "2000000000", "fee": "1000000000" });
    let built = api::build_transfer(&SEED, &st, &params.to_string()).unwrap();
    clean("build_transfer", &built);
    let b: Value = serde_json::from_str(&built).unwrap();
    assert_eq!(b["needs_account_signature"], json!(false));
    // the envelope is the signer-less shape; nothing but the two V2 payload fields is set
    let env: Value = serde_json::from_str(b["envelope_json"].as_str().unwrap()).unwrap();
    assert_eq!((env["from_pub_key"].as_str(), env["sig"].as_str(), env["nonce"].as_u64(), env["version"].as_u64()), (Some(""), Some(""), Some(0), Some(1)));
    assert!(env.get("signed_payload").is_none_or(Value::is_null));
    // every error of the spending calls: no secret either (wrong state, wrong anchor, bad params)
    let other = api::new_state(&parse(api::shielded_address(&[0x22; 64]))["address"].as_str().unwrap().to_string()).unwrap();
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
    let state = api::new_state(&address).unwrap();
    let page = page_with_one_shield(&SEED, 2 * Q);
    let mine: Value = serde_json::from_str(&api::export_scan_key(&SEED, true).unwrap()).unwrap();
    let theirs: Value = serde_json::from_str(&api::export_scan_key(&[0x22; 64], true).unwrap()).unwrap();
    // another wallet's key on this state: refused (pk differs)
    assert!(api::scan(&state, &page, &theirs.to_string()).is_err());
    // this wallet's pk with another wallet's viewing key: nothing opens
    let mut mixed = mine.clone();
    mixed["dk"] = theirs["dk"].clone();
    let r = parse(api::scan(&state, &page, &mixed.to_string()));
    assert_eq!(r["balance"], json!("0"));
    // the right keys: the note is there
    assert_eq!(parse(api::scan(&state, &page, &mine.to_string()))["balance"], json!((2 * Q).to_string()));
}
