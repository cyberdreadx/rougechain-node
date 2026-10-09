//! The Resolution of REVIEW_WALLET_6C (RW6C-1), on the JavaScript-facing surface: **no element of
//! an array can turn the call into the caller's error.** `confirm_state` and `scan_pages` only
//! SPLIT the array and read every element on its own (`quantum_vault_shield_v2_wallet::batch`):
//! a report that cannot be read is "no report from that node", a page that cannot be read is
//! that page's `listing:` — and the elements beside it are read as if it were not there.

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
    let tx = deterministic::shield(&ShieldRequest { ctx, from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &keys.address(), max_fee: None }, "wasm-rw6cr").unwrap();
    let b = &tx.body;
    let out = |j: usize, kem: usize, note: usize| json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j, "kem_ct": hex::encode(&b[kem..kem + 1088]), "note_ct": hex::encode(&b[note..note + 56]) });
    json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": "ab".repeat(32), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": [out(0, 258, 1346), out(1, 1402, 2490)],
    }] })
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// What a node can put where one member of its answer should be (the token, as it stands in the
/// JSON text a JavaScript client's `JSON.stringify` writes), and whether a JavaScript client
/// can have it as a parsed VALUE at all (`JSON.parse` reads it) — otherwise it reaches the
/// library only inside the raw body, as a string.
fn hostile_tokens() -> Vec<(&'static str, String, bool)> {
    let nest = |open: &str, close: &str, n: usize| format!("{}{}", open.repeat(n), close.repeat(n));
    vec![
        // the review's two
        ("a lone high surrogate", r#""\ud800""#.into(), true),
        ("a member nested 200 deep", nest("[", "]", 200), true),
        // … and more of the kind
        ("a lone low surrogate", r#""\udc00""#.into(), true),
        ("a surrogate pair the wrong way round", r#""\udc00\ud800""#.into(), true),
        ("a high surrogate and a letter", r#""\ud800A""#.into(), true),
        ("a high surrogate at the end of a long string", format!("\"{}\\udbff\"", "x".repeat(300)), true),
        ("nested exactly 129 deep", nest("[", "]", 129), true),
        ("objects nested 500 deep", format!("{}1{}", "{\"a\":".repeat(500), "}".repeat(500)), true),
        ("arrays and objects nested 3,000 deep", format!("{}{}", "[{\"k\":".repeat(1_500), "}]".repeat(1_500)).replacen("[{\"k\":}]", "[{\"k\":0}]", 1), true),
        ("a surrogate inside a deep member", format!("{}\"\\ud800\"{}", "[".repeat(40), "]".repeat(40)), true),
        ("a NUL escape", r#""\u0000""#.into(), true),
        ("a number of 400 digits", "9".repeat(400), true),
        ("a number with an exponent of 999", "1e999".into(), true),
        ("brackets and quotes inside a string", r#""]],[{\"}\\""#.into(), true),
        // … and what only a raw body can hold
        ("a body cut off", "{\"a\":[1,".into(), false),
        ("a lone surrogate in a member NAME, cut off", r#"{"\ud800":"#.into(), false),
        ("text that is not JSON", "<html>]</html>".into(), false),
        ("an unterminated string", "\"abc".into(), false),
        ("a byte-order mark", "\u{feff}{}".into(), false),
        ("nothing", String::new(), false),
        ("a control character", "\u{1}".into(), false),
        ("a bracket alone", "]".into(), false),
    ]
}

/// **`confirm_state`: one node's element, whatever it is and wherever it stands, is "no report
/// from that node" — and the reports beside it are read and counted.** The review's cases (a
/// lone surrogate, a member nested 200 deep — in a member of the report and in an extra one)
/// and twenty more shapes; as the value written back by `JSON.stringify`, as a string holding
/// the element's text, and as the labelled raw body (`{ node_id, stats: "<body>" }`); in every
/// position of a 3- and a 5-element array. Each time: the call succeeds, exactly one element is
/// counted in `malformed`, nobody dissents, and the honest reports confirm.
#[test]
fn rw6cr_f1_no_report_of_one_node_can_fail_the_state_check_of_the_others() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let scanned = parse(api::scan(&fresh_state(&address), &page_with_one_shield(&SEED, 9 * Q).to_string(), &key, 2.0));
    let (state, rev) = (scanned["state"].to_string(), scanned["revision"].as_f64().unwrap());
    let summary = parse(api::summary(&state));
    let report = |id: &str| json!({ "node_id": format!("https://{id}.example"), "height": 1, "tree_root": summary["anchor"], "nullifier_acc": summary["nullifier_acc"], "note_count": summary["note_count"], "nullifier_count": summary["nullifier_count"], "ciphertext_acc": summary["ciphertext_acc"] });
    // the three accepted forms of an honest report
    let as_object = |id: &str| report(id).to_string();
    let as_string = |id: &str| quoted(&report(id).to_string());
    let as_raw_body = |id: &str| {
        let mut r = report(id);
        r.as_object_mut().unwrap().remove("node_id");
        json!({ "node_id": format!("https://{id}.example"), "stats": json!({ "success": true, "active": true, "tip_height": 1, "report": r }).to_string() }).to_string()
    };
    for form in [&as_object as &dyn Fn(&str) -> String, &as_string, &as_raw_body] {
        let v = parse(api::confirm_state(&state, &format!("[{},{},{}]", form("a"), form("b"), form("c")), rev));
        assert_eq!((v["report"]["matched_height"].as_u64(), v["report"]["agreeing"].as_u64(), v["malformed"].as_u64()), (Some(1), Some(3), Some(0)));
    }
    // a node without a report (`report: null`: before the pool's first block) is no malformed one
    let v = parse(api::confirm_state(&state, &format!("[{},{},{}]", as_raw_body("a"), as_raw_body("b"), json!({ "node_id": "https://c.example", "stats": r#"{"success":true,"active":false,"report":null}"# })), rev));
    assert_eq!((v["report"]["matched_height"].as_u64(), v["malformed"].as_u64()), (Some(1), Some(0)));

    // node c's element, in every way it can be hostile
    let c = report("c");
    // (what, the element, whether it MAY be a readable report: the hostile token sits in a member
    // a report does not have, and when the token is JSON this library reads, the report is one)
    let mut elements: Vec<(String, String, bool)> = Vec::new();
    for (what, token, js_value) in hostile_tokens() {
        // inside a member of the report, and inside a member the report does not have
        for member in ["tree_root", "extra"] {
            let mut o = c.clone();
            o[member] = json!("@@HERE@@");
            let text = o.to_string().replace("\"@@HERE@@\"", &token);
            if js_value {
                elements.push((format!("{what} in `{member}`, the object written back"), text.clone(), member == "extra"));
            }
            elements.push((format!("{what} in `{member}`, as a string"), quoted(&text), member == "extra"));
            // … and in the node's raw stats body
            let body = format!(r#"{{"success":true,"active":true,"report":{}}}"#, { let mut r = c.clone(); r.as_object_mut().unwrap().remove("node_id"); r[member] = json!("@@HERE@@"); r.to_string().replace("\"@@HERE@@\"", &token) });
            elements.push((format!("{what} in `{member}` of the raw body"), json!({ "node_id": "https://c.example", "stats": body }).to_string(), member == "extra"));
        }
        // the token as the whole element / the whole body
        if js_value {
            elements.push((format!("{what}, as the element"), token.clone(), false));
        }
        elements.push((format!("{what}, as a string element"), quoted(&token), false));
        elements.push((format!("{what}, as the raw body"), json!({ "node_id": "https://c.example", "stats": token }).to_string(), false));
    }
    assert!(elements.len() >= 8 + 12 * 4, "{}", elements.len());
    let (mut calls, honest) = (0, [as_object("a"), as_raw_body("b"), as_string("a"), as_object("b"), as_raw_body("a")]);
    let mut read_as_reports = 0;
    for (what, element, may_be_a_report) in &elements {
        for len in [3usize, 5] {
            for position in 0..len {
                // the honest reports of nodes a and b in the other places, in their three forms
                let mut array: Vec<String> = honest[..len - 1].to_vec();
                array.insert(position, element.clone());
                let r = api::confirm_state(&state, &format!("[{}]", array.join(",")), rev);
                calls += 1;
                let v: Value = serde_json::from_str(&r.unwrap_or_else(|e| panic!("{what}, at {position} of {len}: {e}"))).unwrap();
                let got = (v["report"]["matched_height"].as_u64(), v["report"]["agreeing"].as_u64(), v["malformed"].as_u64(), v["report"]["dissenting"].as_array().map(Vec::len), v["report"]["listing_refuted"].as_bool());
                // the others are read and counted; this one is no report — or, when all that is
                // odd about it is a member a report does not have and this library reads it,
                // an ordinary report of node c (unknown members are ignored)
                let a_report = *may_be_a_report && got == (Some(1), Some(3), Some(0), Some(0), Some(false));
                assert!(a_report || got == (Some(1), Some(2), Some(1), Some(0), Some(false)), "{what}, at {position} of {len}: {got:?}");
                read_as_reports += a_report as usize;
            }
        }
    }
    // every element hostile at once: nothing confirmed, nothing refuted, no error
    let all: Vec<String> = elements.iter().map(|(_, e, _)| e.clone()).collect();
    let v = parse(api::confirm_state(&state, &format!("[{}]", all.join(",")), rev));
    assert_eq!((v["report"]["matched_height"].as_u64(), v["malformed"].as_u64(), v["report"]["nodes"].as_u64()), (None, Some((all.len() - read_as_reports / 8) as u64), Some(1)), "one node of three is no quorum");
    assert!(read_as_reports > 0 && read_as_reports / 8 < elements.len() / 4);
    // what IS the caller's: the array itself
    for outer in ["", "null", "{}", "7", "\"[]\"", "[", &format!("[{}", as_object("a")), &format!("[{}]]", as_object("a")), &format!("{}", as_object("a"))] {
        assert!(api::confirm_state(&state, outer, rev).unwrap_err().starts_with("request:"), "{outer:.30}");
    }
    println!("rw6cr-f1 (reports): {} hostile elements × 8 positions: {calls} calls, every one succeeded with the two honest reports confirming", elements.len());
}

/// **`scan_pages`: one page that cannot be read is that page's `listing:` — with its own index,
/// which the pages before it had to be read for — and it is read exactly as `scan` reads it.**
/// The same shapes, inside a member of a page and as the whole body; as the value written back
/// and as a string holding the raw body; in every position of a 3- and a 5-page batch. And a
/// page with a duplicate member is refused by both paths (the batch does not re-write its
/// elements any more).
#[test]
fn rw6cr_f1_no_page_can_turn_a_batch_into_the_callers_error_and_scan_pages_reads_as_scan_does() {
    let address = parse(api::shielded_address(&SEED))["address"].as_str().unwrap().to_string();
    let key = api::export_scan_key(&SEED, true).unwrap();
    let state = fresh_state(&address);
    // five true pages that follow each other (empty heights 0 … 4 of a node whose tip is 9)
    let page = |k: u64| json!({ "active": true, "tip_height": 9, "from_height": k, "next_height": k + 1, "txs": [] });
    // both forms of a true batch are applied, to the same state
    let objects: Vec<String> = (0..5).map(|k| page(k).to_string()).collect();
    let strings: Vec<String> = objects.iter().map(|p| quoted(p)).collect();
    let (a, b) = (parse(api::scan_pages(&state, &format!("[{}]", objects.join(",")), &key, 2.0)), parse(api::scan_pages(&state, &format!("[ {} ]", strings.join(" ,\n")), &key, 2.0)));
    assert_eq!((a["scanned_height"].clone(), a["revision_id"].clone(), a["report"].as_array().unwrap().len()), (json!(4), b["revision_id"].clone(), 5));
    assert_eq!(a["state"], b["state"]);

    let mut bodies: Vec<(String, String, bool)> = Vec::new(); // (what, the body, whether a JavaScript client can hold it as a value)
    for (what, token, js_value) in hostile_tokens() {
        for member in ["tip_height", "extra"] {
            bodies.push((format!("{what} in `{member}`"), "@@PAGE@@".to_string() + member + "\u{0}" + &token, js_value));
        }
        bodies.push((format!("{what}, as the body"), token.clone(), js_value));
    }
    let (mut calls, mut strikes, mut bans, mut applied) = (0, 0, 0, 0);
    for (what, body, js_value) in &bodies {
        for len in [3u64, 5] {
            for position in 0..len {
                // the page of this position, poisoned — or the token instead of it
                let body = match body.strip_prefix("@@PAGE@@") {
                    Some(rest) => {
                        let (member, token) = rest.split_once('\u{0}').unwrap();
                        let mut p = page(position);
                        p[member] = json!("@@HERE@@");
                        p.to_string().replace("\"@@HERE@@\"", token)
                    }
                    None => body.clone(),
                };
                // what `scan` says of that body on the state the pages before it leave
                let (before, revision) = if position == 0 {
                    (state.clone(), 2.0)
                } else {
                    let r = parse(api::scan_pages(&state, &format!("[{}]", objects[..position as usize].join(",")), &key, 2.0));
                    (r["state"].to_string(), r["revision"].as_f64().unwrap())
                };
                let single = api::scan(&before, &body, &key, revision);
                let mut forms = vec![quoted(&body)];
                if *js_value {
                    forms.push(body.clone());
                }
                for element in forms {
                    for others in [&objects, &strings] {
                        let mut array: Vec<String> = others[..len as usize].to_vec();
                        array[position as usize] = element.clone();
                        let batch = api::scan_pages(&state, &format!("[{}]", array.join(",")), &key, 2.0);
                        calls += 1;
                        match (&single, batch) {
                            // the page's own error, in the words `scan` has for it, with its index
                            (Err(single), Err(e)) => {
                                assert!(single.starts_with("listing:"), "{what}: scan: {single}");
                                assert_eq!(e, single.replacen("listing: ", &format!("listing: page {position}: "), 1), "{what}, at {position} of {len}");
                            }
                            // `scan` reads the page (the odd thing sits in a member a page does not
                            // have, which the reader skips unread): so does the batch, all of it
                            (Ok(_), Ok(v)) => assert_eq!(serde_json::from_str::<Value>(&v).unwrap()["scanned_height"], json!(len - 1), "{what}, at {position} of {len}"),
                            (single, batch) => panic!("{what}, at {position} of {len}: scan and scan_pages disagree: {:?} / {:?}", single.as_ref().map(|_| "applied"), batch.as_ref().map(|_| "applied")),
                        }
                    }
                }
                match &single {
                    Ok(_) => applied += 1,
                    Err(e) if e.contains("not a listing page") => strikes += 1,
                    Err(_) => bans += 1,
                }
            }
        }
    }
    // unreadable bodies are no answer; a readable page with a member of the wrong type is a
    // page that is refused; an odd member a page does not have is skipped — the same in both calls
    assert!(strikes > 100 && bans > 0 && applied > 0, "{strikes} no answer, {bans} refused as a page, {applied} applied");
    // a duplicate member: `scan` refuses it, and so does the batch (REVIEW_WALLET_6C, the Low)
    let twice = r#"{"active":true,"tip_height":9,"from_height":0,"next_height":1,"txs":[],"next_height":1}"#;
    let single = api::scan(&state, twice, &key, 2.0).unwrap_err();
    for element in [twice.to_string(), quoted(twice)] {
        let e = api::scan_pages(&state, &format!("[{element},{}]", objects[1]), &key, 2.0).unwrap_err();
        assert!(single.starts_with("listing:") && !single.contains("not a listing page") && e == single.replacen("listing: ", "listing: page 0: ", 1), "{e} / {single}");
    }
    // what IS the caller's: the array itself
    for outer in ["", "null", "{}", "\"[]\"", "[", &format!("[{}", objects[0]), &format!("[{}]x", objects[0]), &objects[0]] {
        assert!(api::scan_pages(&state, outer, &key, 2.0).unwrap_err().starts_with("request:"), "{outer:.30}");
    }
    println!("rw6cr-f1 (pages): {} hostile bodies × 8 positions × their forms: {calls} batches, each answered as scan answers the body ({strikes} positions no answer, {bans} refused as a page, {applied} applied)", bodies.len());
}
