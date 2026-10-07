//! REVIEW_WALLET_6C (see `core/shield-v2-wallet/REVIEW_WALLET_6C.md`) — the final confirmation
//! pass, on the JavaScript-facing surface. Nothing was fixed by the review.
//!
//! * `rw6c_fN_…` — a defect; fails on purpose and asserts the safe behaviour;
//! * `rw6c_sound_…` — attacked, holds.

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

/// An empty state of a new wallet configured with three nodes. Revision 2.
fn fresh_state(address: &str) -> String {
    let s = api::new_state(address, "", 0).unwrap();
    let s = parse(api::set_nodes(&s, NODES, 0.0))["state"].to_string();
    parse(api::assert_sole_copy(&s, true, 1.0))["state"].to_string()
}

/// A listing page with one shield to `seed`'s wallet at height 1, leaves 0 and 1.
fn page_with_one_shield(seed: &[u8], value: u64) -> Value {
    let keys = ShieldedKeys::from_seed(seed).unwrap();
    let key: Vec<u8> = (0..1_952u32).map(|i| (i % 251) as u8).collect();
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
        "wasm-rw6c",
    )
    .unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) });
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "ab".repeat(32), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": [out(0, 258, 1346), out(1, 1402, 2490)],
    }] })
}

fn report_for(state: &str, id: &str) -> Value {
    let s: Value = serde_json::from_str(&api::summary(state).expect("a state")).unwrap();
    json!({ "node_id": format!("https://{id}.example"), "height": s["scanned_height"], "tree_root": s["anchor"], "nullifier_acc": s["nullifier_acc"],
        "note_count": s["note_count"], "nullifier_count": s["nullifier_count"], "ciphertext_acc": s["ciphertext_acc"] })
}

/// What a JavaScript client's `JSON.stringify` writes for a value it got from `JSON.parse` of a
/// node's answer in which one string member is a lone surrogate (`"\ud800"`: valid JSON for
/// `JSON.parse`, written back as the same escape), or in which one member is nested 200 deep
/// (no limit of `JSON.parse` is near). `member`: the name of the member that carries it.
fn through_a_js_client(object: &Value, member: &str, what: &str) -> String {
    let mut o = object.clone();
    o[member] = json!("@@HERE@@");
    let token = match what {
        "a lone surrogate" => "\"\\ud800\"".to_string(),
        _ => format!("{}{}", "[".repeat(200), "]".repeat(200)),
    };
    o.to_string().replace("\"@@HERE@@\"", &token)
}

/// **RW6C-1.** "`confirm_state` … every ELEMENT of `reports`: … anything — `null`, not an
/// object, a missing member, a member of the wrong type … : **no report from that node**.
/// Counted in `malformed`; never an error" (`NOTES.md` §6, the exports that take a node's data).
/// And `scan_pages`: every element "exactly as `scan`, with the element's index".
///
/// Both read the ARRAY with one `serde_json::from_str`, and two things a node can put INSIDE an
/// element make that call fail although a JavaScript client parsed the node's answer, took the
/// object and wrote the array with `JSON.stringify`, exactly as `UI_CONTRACT.md` obligation 9
/// tells it to (a JSON object, under 4 KiB): a string that is a lone surrogate escape, and a
/// member nested deeper than serde_json's limit of 128. The answer is `request: state reports:
/// malformed JSON` / `request: pages: malformed JSON` — the CALLER's class, for which the loop
/// stops and reports a bug.
///
/// For `confirm_state` the element is one node's stats report, and EVERY configured node is
/// asked every round: one lying node of three — whichever node is listed from — makes every
/// state check of every session fail. Nothing is ever confirmed.
#[test]
fn rw6c_f1_one_nodes_report_or_page_makes_the_whole_array_a_request_error() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state0 = fresh_state(&address);
    let page = page_with_one_shield(&SEED, 9 * Q);
    let scanned = parse(api::scan(&state0, &page.to_string(), &key, 2.0));
    let (state, rev) = (scanned["state"].to_string(), scanned["revision"].as_f64().unwrap());
    let (a, b, c) = (report_for(&state, "a"), report_for(&state, "b"), report_for(&state, "c"));
    // the control: two honest reports and a third that is malformed in a way the table names
    let control = parse(api::confirm_state(&state, &json!([a, b, { "node_id": "https://c.example", "height": "x" }]).to_string(), rev));
    assert_eq!((control["report"]["matched_height"].as_u64(), control["malformed"].as_u64()), (Some(1), Some(1)));
    let mut wrong = Vec::new();
    for what in ["a lone surrogate", "a member nested 200 deep"] {
        // node c's report, as a JavaScript client hands it on; nodes a and b are honest
        for member in ["tree_root", "extra"] {
            let poisoned = through_a_js_client(&c, member, what);
            assert!(poisoned.len() < 4096, "under the 4 KiB of obligation 9");
            let r = api::confirm_state(&state, &format!("[{a},{b},{poisoned}]"), rev);
            match r {
                Ok(v) => {
                    let v: Value = serde_json::from_str(&v).unwrap();
                    assert_eq!(v["report"]["matched_height"].as_u64(), Some(1), "{what} in {member}: the two honest reports confirm");
                }
                Err(e) => wrong.push(format!("confirm_state, {what} in `{member}` of ONE node's report: {}", e.chars().take(70).collect::<String>())),
            }
        }
        // the listing node's page in a batch
        for member in ["tx_hash_of_nothing", "extra"] {
            let poisoned = through_a_js_client(&page, member, what);
            let single = api::scan(&state0, &poisoned, &key, 2.0);
            assert!(single.as_ref().is_ok() || single.as_ref().unwrap_err().starts_with("listing:"), "scan: {single:?}");
            if let Err(e) = api::scan_pages(&state0, &format!("[{poisoned}]"), &key, 2.0) {
                if !e.starts_with("listing:") {
                    wrong.push(format!("scan_pages, {what} in `{member}` of a page: {}", e.chars().take(70).collect::<String>()));
                }
            }
        }
    }
    println!("rw6c-f1: {wrong:#?}");
    assert!(wrong.is_empty(), "what ONE node sent makes the call answer the caller's class:\n  {}", wrong.join("\n  "));
}

/// Twelve more batches and twelve more reports that are malformed in ways the tests of the
/// Resolution do not contain. `scan_pages`: `listing: page <i>: …` with the index of the first
/// refused element, or `request:` for an argument that is not an array; never anything else.
/// `confirm_state`: the report is not counted (`malformed`), the two honest reports confirm.
#[test]
fn rw6c_sound_more_malformed_batches_and_reports() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state0 = fresh_state(&address);
    let good = page_with_one_shield(&SEED, 9 * Q);
    let empty = |from: u64, next: u64, tip: u64| json!({ "active": true, "tip_height": tip, "from_height": from, "next_height": next, "txs": [] });
    let mut bad_nf = good.clone();
    bad_nf["txs"][0]["nf1"] = json!("ff".repeat(32));
    let mut two_txs = good.clone();
    let t = two_txs["txs"][0].clone();
    two_txs["txs"].as_array_mut().unwrap().push(t);
    // (the batch, the class, the index of the refused page)
    let batches: Vec<(&str, String, &str, Option<usize>)> = vec![
        ("a number after a page", format!("[{good},5]"), "listing", Some(1)),
        ("a string after a page", format!("[{good},\"page\"]"), "listing", Some(1)),
        ("an array after a page", format!("[{good},[]]"), "listing", Some(1)),
        ("the node's error answer after a page", format!("[{good},{}]", json!({ "success": false, "error": "x" })), "listing", Some(1)),
        ("the same page twice", format!("[{good},{good}]"), "listing", Some(1)),
        ("a page that does not continue the one before", format!("[{good},{}]", empty(5, 6, 5)), "listing", Some(1)),
        ("three pages, the last with a digest that is not canonical", format!("[{},{},{bad_nf}]", empty(0, 1, 1), empty(1, 1, 1)), "listing", Some(2)),
        ("a page with only `active`", format!("[{}]", json!({ "active": true })), "listing", Some(0)),
        ("a page that lists a transaction twice", format!("[{two_txs}]"), "listing", Some(0)),
        ("a batch in a batch", format!("[[{good}]]"), "listing", Some(0)),
        ("an object, not an array", good.to_string(), "request", None),
        ("an array that does not end", format!("[{good},"), "request", None),
    ];
    for (what, pages, class, index) in &batches {
        let e = api::scan_pages(&state0, pages, &key, 2.0).expect_err(what);
        assert!(e.starts_with(&format!("{class}:")), "{what}: {e}");
        if let Some(i) = index {
            assert!(e.starts_with(&format!("listing: page {i}: ")), "{what}: the index: {}", &e[..e.len().min(90)]);
        }
    }
    // an empty batch is no page and no error; and "not a listing page" keeps its mark in a batch
    assert!(api::scan_pages(&state0, "[]", &key, 2.0).is_ok());
    let e = api::scan_pages(&state0, &format!("[{good},{}]", json!({ "success": false })), &key, 2.0).unwrap_err();
    assert!(e.contains("not a listing page"), "{e}");

    let scanned = parse(api::scan(&state0, &good.to_string(), &key, 2.0));
    let (state, rev) = (scanned["state"].to_string(), scanned["revision"].as_f64().unwrap());
    let (a, b, c) = (report_for(&state, "a"), report_for(&state, "b"), report_for(&state, "c"));
    let with = |edit: &dyn Fn(&mut Value)| {
        let mut r = c.clone();
        edit(&mut r);
        r
    };
    let reports: Vec<(&str, Value)> = vec![
        ("height negative", with(&|r| r["height"] = json!(-1))),
        ("height a fraction", with(&|r| r["height"] = json!(1.5))),
        ("height 2^64", serde_json::from_str(&c.to_string().replace("\"height\":1", "\"height\":18446744073709551616")).unwrap()),
        ("note_count as text", with(&|r| r["note_count"] = json!("2"))),
        ("tree_root upper case", with(&|r| { let t = r["tree_root"].as_str().unwrap().to_uppercase(); r["tree_root"] = json!(t); })),
        ("tree_root one character short", with(&|r| { let t = r["tree_root"].as_str().unwrap()[1..].to_string(); r["tree_root"] = json!(t); })),
        ("nullifier_acc an array", with(&|r| r["nullifier_acc"] = json!(vec![0u8; 32]))),
        ("ciphertext_acc a number", with(&|r| r["ciphertext_acc"] = json!(7))),
        ("node_id missing", with(&|r| { r.as_object_mut().unwrap().remove("node_id"); })),
        ("node_id a number", with(&|r| r["node_id"] = json!(3))),
        ("the report in an array", json!([c])),
        ("the report one level down", json!({ "report": c })),
    ];
    for (what, bad) in &reports {
        let v = parse(api::confirm_state(&state, &json!([a, b, bad]).to_string(), rev));
        assert_eq!((v["report"]["matched_height"].as_u64(), v["malformed"].as_u64(), v["report"]["dissenting"].as_array().map(Vec::len)), (Some(1), Some(1), Some(0)), "{what}");
    }
    // all twelve at once, and under the id of an honest node too: still no vote, no dissent
    let mut all: Vec<Value> = vec![a.clone(), b.clone()];
    all.extend(reports.iter().map(|(_, r)| r.clone()));
    let v = parse(api::confirm_state(&state, &Value::Array(all).to_string(), rev));
    assert_eq!((v["report"]["matched_height"].as_u64(), v["malformed"].as_u64()), (Some(1), Some(12)));
}
