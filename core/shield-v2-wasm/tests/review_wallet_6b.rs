//! REVIEW_WALLET_6B (see `core/shield-v2-wallet/REVIEW_WALLET_6B.md`) — the one finding that
//! needs the JavaScript-facing surface. Nothing was fixed by the review.
//!
//! `rw6b_f1_…` fails on purpose and asserts the safe behaviour.

use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::{ShieldRequest, ShieldedKeys, TxContext, WalletState};
use quantum_vault_shield_v2_wasm::api;
use serde_json::{json, Value};

const Q: u64 = 1_000_000_000;
const SEED: [u8; 64] = [0x11; 64];
const NODES: &str = r#"["https://a.example", "https://b.example"]"#;

fn parse(r: api::ApiResult) -> Value {
    serde_json::from_str(&r.expect("ok")).expect("the result is JSON")
}

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
        "wasm-rw6b",
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

/// **RW6B-1.** "Every way the content of a page can be invalid is `listing:` and no other error"
/// (`NOTES.md` §6, the error table; `WalletError::Listing`). True of `scan`. Not of
/// **`scan_pages`**, the export a client uses to apply the P pages of a round in one call: a
/// page of the array that is not the JSON shape of a page — a missing field, a value of the
/// wrong type, a number out of range — is answered with `request: pages: …`
/// (`core/shield-v2-wasm/src/api.rs`, `scan_pages`: `serde_json::from_str(..).map_err(bad_json)`),
/// the class of the CALLER's mistakes, for which the loop's rule is STOP(fault): report a bug,
/// do nothing more in this session. The same page through `scan` is `listing:` (ban the node,
/// go on). One lying node ends the session of every client that reads its pages in a batch,
/// whenever it is the listing node.
#[test]
fn rw6b_f1_scan_pages_answers_request_not_listing_for_a_page_that_is_not_a_page() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state = fresh_state(&address);
    let good = page_with_one_shield(&SEED, 9 * Q);
    // the control: both calls read the true page
    assert!(api::scan(&state, &good.to_string(), &key, 2.0).is_ok() && api::scan_pages(&state, &format!("[{good}]"), &key, 2.0).is_ok());
    let corrupt: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("txs missing", Box::new(|p| { p.as_object_mut().unwrap().remove("txs"); })),
        ("tip_height missing", Box::new(|p| { p.as_object_mut().unwrap().remove("tip_height"); })),
        ("next_height negative", Box::new(|p| p["next_height"] = json!(-1))),
        ("nf1 a number", Box::new(|p| p["txs"][0]["nf1"] = json!(7))),
        ("outputs missing", Box::new(|p| { p["txs"][0].as_object_mut().unwrap().remove("outputs"); })),
        ("leaf a string", Box::new(|p| p["txs"][0]["outputs"][0]["leaf"] = json!("0"))),
        ("the page null", Box::new(|p| *p = Value::Null)),
        // … and one that IS the shape of a page: `scan_pages` answers `listing:` for it, as `scan` does
        ("nf1 not canonical (the control)", Box::new(|p| p["txs"][0]["nf1"] = json!("ff".repeat(32)))),
    ];
    let mut wrong_class = Vec::new();
    for (what, edit) in &corrupt {
        let mut bad = good.clone();
        edit(&mut bad);
        let single = api::scan(&state, &bad.to_string(), &key, 2.0).unwrap_err();
        assert!(single.starts_with("listing:"), "{what}: scan answers {single}");
        // the page alone, and after a true empty page of the same node
        for pages in [format!("[{bad}]"), format!("[{},{bad}]", json!({ "active": true, "tip_height": 1, "from_height": 0, "next_height": 1, "txs": [] }))] {
            let batch = api::scan_pages(&state, &pages, &key, 2.0).unwrap_err();
            if !batch.starts_with("listing:") {
                wrong_class.push(format!("{what}: {}", batch.chars().take(60).collect::<String>()));
            }
        }
    }
    println!("rw6b-f1: pages for which scan answers listing: and scan_pages another class: {wrong_class:#?}");
    assert!(wrong_class.is_empty(), "scan_pages answers an error the loop stops on, for the content of a page:\n  {}", wrong_class.join("\n  "));
}
