//! The Resolution of REVIEW_WALLET_6B, on the JavaScript-facing surface: every export that takes
//! data a NODE supplied classifies it as the node's — never as the caller's mistake, for which
//! the client loop stops (`NOTES.md` §6, the table of the exports).

use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::{ShieldRequest, ShieldedKeys, TxContext, WalletState};
use quantum_vault_shield_v2_wasm::api;
use serde_json::{json, Value};

const Q: u64 = 1_000_000_000;
const SEED: [u8; 64] = [0x11; 64];
const NODES: &str = r#"["https://a.example", "https://b.example", "https://c.example"]"#;

fn parse(r: api::ApiResult) -> Value {
    serde_json::from_str(&r.expect("ok")).expect("the result is JSON")
}

fn fresh_state(address: &str) -> String {
    let s = api::new_state(address, "", 0).unwrap();
    let s = parse(api::set_nodes(&s, NODES, 0.0))["state"].to_string();
    parse(api::assert_sole_copy(&s, true, 1.0))["state"].to_string()
}

fn page_with_one_shield(seed: &[u8], value: u64) -> Value {
    let keys = ShieldedKeys::from_seed(seed).unwrap();
    let key: Vec<u8> = (0..1_952u32).map(|i| (i % 251) as u8).collect();
    let ctx = TxContext { chain_id: "test".into(), anchor: WalletState::new([0; 32]).anchor(), anchor_height: 36, expiry_height: 100 };
    let tx = deterministic::shield(&ShieldRequest { ctx, from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &keys.address(), max_fee: None }, "wasm-rw6br").unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) });
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "ab".repeat(32), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": [out(0, 258, 1346), out(1, 1402, 2490)],
    }] })
}

/// `scan_pages`: the OUTER argument is the caller's (`request:`); every ELEMENT is a node's
/// answer (`listing: page <i>: …`, with the mark "not a listing page" for an element that is
/// no page at all); all or nothing; and one call is `scan` page by page.
#[test]
fn rw6br_f1_scan_pages_classifies_the_array_as_the_callers_and_every_element_as_the_nodes() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state = fresh_state(&address);
    let empty = json!({ "active": true, "tip_height": 1, "from_height": 0, "next_height": 1, "txs": [] });
    let good = page_with_one_shield(&SEED, 9 * Q);
    // one call ≡ page by page
    let one = parse(api::scan(&state, &empty.to_string(), &key, 2.0));
    let two = parse(api::scan(&one["state"].to_string(), &good.to_string(), &key, 3.0));
    let both = parse(api::scan_pages(&state, &format!("[{empty},{good}]"), &key, 2.0));
    assert_eq!((both["confirmed_balance"].clone(), both["scanned_height"].clone(), both["report"].as_array().unwrap().len()), (two["confirmed_balance"].clone(), json!(1), 2));
    assert_eq!(both["report"][1], two["report"]);
    assert_eq!(both["report"][1]["pool_active"], json!(true));
    // the outer argument: the caller's
    for outer in ["", "null", "{}", "7", r#""pages""#, "[", &good.to_string()] {
        let e = api::scan_pages(&state, outer, &key, 2.0).unwrap_err();
        assert!(e.starts_with("request:"), "{outer:.20}: {e}");
    }
    // an element: the node's — with its index, and nothing applied
    let elements: Vec<(&str, String, bool)> = vec![
        ("null", "null".into(), true),
        ("a number", "7".into(), true),
        ("a string", r#""page""#.into(), true),
        ("an array", "[]".into(), true),
        ("the node's error answer", r#"{"success":false,"error":"storage"}"#.into(), true),
        ("an empty object", "{}".into(), true),
        ("txs missing", { let mut p = good.clone(); p.as_object_mut().unwrap().remove("txs"); p.to_string() }, false),
        ("tip_height a string", { let mut p = good.clone(); p["tip_height"] = json!("1"); p.to_string() }, false),
        ("next_height 2^64", { let mut p = good.clone(); p["next_height"] = json!(18_446_744_073_709_551_616.0); p.to_string() }, false),
        ("an output missing", { let mut p = good.clone(); p["txs"][0]["outputs"] = json!([p["txs"][0]["outputs"][0].clone()]); p.to_string() }, false),
        ("nf1 not canonical", { let mut p = good.clone(); p["txs"][0]["nf1"] = json!("ff".repeat(32)); p.to_string() }, false),
    ];
    for (what, element, no_page) in &elements {
        let single = api::scan(&parse(api::scan(&state, &empty.to_string(), &key, 2.0))["state"].to_string(), element, &key, 3.0).unwrap_err();
        assert!(single.starts_with("listing:") && single.contains("not a listing page") == *no_page, "{what}: scan answers {single}");
        for (index, pages) in [(0, format!("[{element}]")), (1, format!("[{empty},{element}]")), (1, format!("[{empty},{element},{good}]"))] {
            let e = api::scan_pages(&state, &pages, &key, 2.0).unwrap_err();
            assert!(e.starts_with(&format!("listing: page {index}: ")), "{what} at {index}: {e}");
            assert_eq!(e.contains("not a listing page"), *no_page, "{what} at {index}: {e}");
            if index == 1 {
                // the same words as `scan` has for it, after the page number
                assert_eq!(e.replacen(&format!("page {index}: "), "", 1), single, "{what}");
            }
        }
    }
    // (an Err hands back no state: the caller keeps the one it has — all or nothing)
}

/// `confirm_state`: the array is the caller's; **every element is one node's answer, and a
/// malformed one is "no report from that node"** — counted in `malformed`, never an error, never
/// a vote. Whatever a node puts where its report should be, the call succeeds.
#[test]
fn rw6br_f1_a_malformed_report_is_no_report_and_never_an_error() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state = parse(api::scan(&fresh_state(&address), &page_with_one_shield(&SEED, 9 * Q).to_string(), &key, 2.0));
    let (state, revision) = (state["state"].to_string(), state["revision"].as_f64().unwrap());
    let summary = parse(api::summary(&state));
    let good = |node: &str| json!({ "node_id": node, "height": 1, "tree_root": summary["anchor"], "nullifier_acc": summary["nullifier_acc"], "note_count": summary["note_count"], "nullifier_count": summary["nullifier_count"], "ciphertext_acc": summary["ciphertext_acc"] });
    let a = good("https://a.example");
    let with = |edit: &dyn Fn(&mut Value)| {
        let mut r = good("https://b.example");
        edit(&mut r);
        r
    };
    let garbage: Vec<Value> = vec![
        Value::Null,
        json!(7),
        json!("report"),
        json!([]),
        json!({}),
        json!({ "success": false, "error": "storage" }),
        with(&|r| r["height"] = json!(-1)),
        with(&|r| r["height"] = json!("1")),
        with(&|r| r["height"] = json!(18_446_744_073_709_551_616.0)),
        with(&|r| r["tree_root"] = json!("zz")),
        with(&|r| r["tree_root"] = json!(7)),
        with(&|r| r["nullifier_acc"] = json!("AB".repeat(32))),
        with(&|r| r["note_count"] = json!(1.5)),
        with(&|r| r["nullifier_count"] = Value::Null),
        with(&|r| r["ciphertext_acc"] = json!("00")),
        with(&|r| { r.as_object_mut().unwrap().remove("height"); }),
        with(&|r| { r.as_object_mut().unwrap().remove("node_id"); }),
        with(&|r| r["node_id"] = json!(["https://b.example"])),
    ];
    // each alone, beside one good report: not an error, not a vote (one node of three is no quorum)
    for g in &garbage {
        let r = parse(api::confirm_state(&state, &json!([a, g]).to_string(), revision));
        assert_eq!((r["malformed"].clone(), r["report"]["matched_height"].clone(), r["report"]["nodes"].clone()), (json!(1), Value::Null, json!(1)), "{g}");
        assert!(!r["report"]["listing_refuted"].as_bool().unwrap() && r["report"]["dissenting"].as_array().unwrap().is_empty(), "{g}: a malformed report contradicts nobody");
    }
    // all of them at once, beside a quorum of good reports: the quorum confirms
    let mut all = garbage.clone();
    all.extend([a.clone(), good("https://c.example")]);
    let r = parse(api::confirm_state(&state, &Value::Array(all).to_string(), revision));
    assert_eq!((r["malformed"].clone(), r["report"]["matched_height"].clone()), (json!(garbage.len()), json!(1)));
    // the array itself is the caller's
    for outer in ["", "null", "{}", &a.to_string()] {
        assert!(api::confirm_state(&state, outer, revision).unwrap_err().starts_with("request:"), "{outer:.20}");
    }
}
