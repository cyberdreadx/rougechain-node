//! The Resolution of REVIEW_WALLET_6 (`REVIEW_WALLET_6.md`, "Resolution"): what the three fixes
//! of the client loop add beyond turning `rw6_f1`, `rw6_f2` and `rw6_f3` green.
//!
//! * RW6-1 — `confirm_state` says WHERE a listing is refuted (`ConfirmReport::refuted`), a
//!   strict minority never refutes anything, and the loop bans the listing node only for
//!   heights it served itself;
//! * RW6-2 — every field of the listing's JSON shape, corrupted in every way, is a `listing:`
//!   error that leaves the state as it was (table-driven); a fault does not pin the node it
//!   happened on;
//! * RW6-3 — "the pool is not active": a majority idles the loop, a minority is left, a node
//!   that contradicts its own report is banned, and `ScanReport::pool_active` tells an inactive
//!   pool from an empty one;
//! * the noted items — every public path to a spend passes the gate; `LoopClient` can leave a
//!   request unanswered.
//!
//! Needs the `test-vectors` feature, like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::client_loop::{Decision, LoopClient, Served, Session, Stats, Stop, LOOP_CLIENT_PAGES, STRIKES};
use common::*;
use quantum_vault_shield_v2::reference::MODULUS;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;
use serde_json::{json, Value};

const IDS: [&str; 7] = ["node-1", "node-2", "node-3", "node-4", "node-5", "node-6", "node-7"];

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw6r-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn shield_body(chain: &Chain, to: &ShieldedAddress, value: u64, label: &str) -> Vec<u8> {
    let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(2), nonce: 1, v_in: value + Q, fee: Q, recipient: to, max_fee: None };
    deterministic::shield(&req, label).unwrap().body
}

fn parse(page: &Value) -> ListingPage {
    ListingPage::from_json(&page.to_string()).unwrap()
}

fn wallet(alice: &ShieldedKeys, n: usize, new: bool) -> WalletState {
    let mut s = WalletState::new(alice.address().pk);
    if new {
        configure_as_sole_copy(&mut s, &IDS[..n]);
    } else {
        configure(&mut s, &IDS[..n]);
    }
    s
}

/// The true report of node `i` for the chain as it is.
fn report(chain: &Chain, i: usize) -> StateReport {
    chain.report(IDS[i])
}

fn lie(mut r: StateReport) -> StateReport {
    r.nullifier_acc[5] ^= 1;
    r
}

/// The liar's listing of RW6-1: the truth, with the transactions of block `was` listed in
/// block `was + 1`, as a node whose tip is `was + 1`.
fn shifted(chain: &Chain, since: u64, was: u64) -> ListingPage {
    if since > was + 1 {
        return parse(&json!({ "active": true, "tip_height": was + 1, "from_height": since, "next_height": since, "txs": [] }));
    }
    let mut p = chain.page_value(since, was + 1);
    for tx in p["txs"].as_array_mut().unwrap().iter_mut().filter(|tx| tx["height"] == was) {
        tx["height"] = json!(was + 1);
    }
    parse(&p)
}

// ---------------------------------------------------------------------------------------------------
// RW6-2 — every field of the listing's JSON shape, corrupted in every way.
// ---------------------------------------------------------------------------------------------------

/// What `scan` must make of a corrupted page.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Expect {
    /// `listing:`, from `ListingPage::from_json` or from `scan`, and the state is unchanged.
    Refused,
    /// Not malformed — a well-formed lie (or no lie at all), which only the state check can
    /// tell from the truth; the reason is the documented one. `scan` applies it.
    Applied(&'static str),
}

type Corruption = (&'static str, &'static str, Box<dyn Fn(&mut Value)>, Expect);

/// The ways one value of a given kind can be wrong, each as (name, the wrong value).
fn wrong_numbers() -> Vec<(&'static str, Value)> {
    vec![
        ("null", Value::Null),
        ("a string", json!("12")),
        ("negative", json!(-1)),
        ("a fraction", json!(12.5)),
        ("2^64", json!(18_446_744_073_709_551_616.0)),
        ("an object", json!({ "n": 1 })),
        ("a list", json!([1])),
        ("a boolean", json!(true)),
    ]
}

/// Wrong values for a field that is `bytes` bytes of lowercase hexadecimal.
fn wrong_hex(good: &str) -> Vec<(&'static str, Value)> {
    let n = good.len();
    vec![
        ("null", Value::Null),
        ("a number", json!(7)),
        ("a list", json!([good])),
        ("an object", json!({ "hex": good })),
        ("empty", json!("")),
        ("one byte short", json!(&good[2..])),
        ("one character short", json!(&good[1..])),
        ("one byte long", json!(format!("{good}00"))),
        ("upper case", json!(format!("{}AB", &good[..n - 2]))),
        ("not hexadecimal", json!(format!("{}zz", &good[..n - 2]))),
        ("a 0x prefix", json!(format!("0x{}", &good[..n - 2]))),
        ("a space", json!(format!("{} ", &good[..n - 1]))),
    ]
}

/// 64 hexadecimal characters that are not a digest of spec §2.8: a word that is not below p.
fn not_canonical() -> Vec<(&'static str, Value)> {
    let mut one_word = [0u8; 32];
    one_word[8..12].copy_from_slice(&MODULUS.to_le_bytes()); // exactly p, in the third word
    let mut last_word = [0u8; 32];
    last_word[28..32].copy_from_slice(&u32::MAX.to_le_bytes());
    vec![("not canonical (ff…ff)", json!("ff".repeat(32))), ("not canonical (one word = p)", json!(hex::encode(one_word))), ("not canonical (the last word)", json!(hex::encode(last_word)))]
}

/// **The table**: every field of the page — the five of the page, the seven of a transaction,
/// the four of an output — and for each one every way it can be wrong: missing, the wrong JSON
/// type, out of the range of its type, the wrong length, the wrong alphabet, a value that is
/// not canonical, a value that contradicts another field of the page or the wallet's state.
/// `first`: the height the wallet's state continues at; the page lists one transaction in
/// block `first` and one in `first + 1` and ends at `tip`.
fn corruptions(page: &Value, first: u64, tip: u64, leaves: u64, continues: bool) -> Vec<Corruption> {
    let mut t: Vec<Corruption> = Vec::new();
    let mut add = |field: &'static str, way: &'static str, f: Box<dyn Fn(&mut Value)>, e: Expect| t.push((field, way, f, e));
    let set = |path: Vec<Value>, v: Value| -> Box<dyn Fn(&mut Value)> {
        Box::new(move |p: &mut Value| {
            let mut at = p;
            for k in &path {
                at = match k {
                    Value::String(s) => &mut at[s.as_str()],
                    Value::Number(n) => &mut at[n.as_u64().unwrap() as usize],
                    _ => unreachable!(),
                };
            }
            *at = v.clone();
        })
    };
    let remove = |path: Vec<Value>, key: &'static str| -> Box<dyn Fn(&mut Value)> {
        Box::new(move |p: &mut Value| {
            let mut at = p;
            for k in &path {
                at = match k {
                    Value::String(s) => &mut at[s.as_str()],
                    Value::Number(n) => &mut at[n.as_u64().unwrap() as usize],
                    _ => unreachable!(),
                };
            }
            at.as_object_mut().unwrap().remove(key);
        })
    };
    let path = |keys: &[Value]| keys.to_vec();
    use Expect::*;

    // ---- the page -----------------------------------------------------------------------------------
    add("active", "missing", remove(vec![], "active"), Refused);
    for (way, v) in [("null", Value::Null), ("a string", json!("true")), ("a number", json!(1)), ("a list", json!([true]))] {
        add("active", way, set(path(&[json!("active")]), v), Refused);
    }
    add("active", "false", set(path(&[json!("active")]), json!(false)), Applied("\"the pool is not active\": nothing is read, the state is unchanged, pool_active is false (RW6-3)"));
    for f in ["tip_height", "from_height", "next_height"] {
        add(f, "missing", remove(vec![], f), Refused);
        for (way, v) in wrong_numbers() {
            add(f, way, set(path(&[json!(f)]), v), Refused);
        }
    }
    add("tip_height", "below the heights the page lists", set(path(&[json!("tip_height")]), json!(first - 1)), Refused);
    add("tip_height", "0", set(path(&[json!("tip_height")]), json!(0)), Refused);
    add("tip_height", "far above", set(path(&[json!("tip_height")]), json!(tip + 1_000_000)), Applied("one node's claim about its own tip: at_tip is false (and the loop calls the page short); the quorum's tip decides"));
    add("tip_height", "u64::MAX", set(path(&[json!("tip_height")]), json!(u64::MAX)), Applied("as above"));
    // (a state that holds something continues at its next height and nowhere else; an EMPTY
    // state takes a page that starts anywhere up to the first transaction — the jump to the
    // activation height — and what such a page skipped is found by the state check)
    let jump = if continues { Refused } else { Applied("an empty state is handed a listing that starts where the node says the pool starts") };
    add("from_height", "one below the first listed height", set(path(&[json!("from_height")]), json!(first - 1)), jump);
    add("from_height", "one above the first listed height", set(path(&[json!("from_height")]), json!(first + 1)), Refused);
    add("from_height", "0", set(path(&[json!("from_height")]), json!(0)), jump);
    add("from_height", "above next_height", set(path(&[json!("from_height")]), json!(tip + 2)), Refused);
    add("from_height", "u64::MAX", set(path(&[json!("from_height")]), json!(u64::MAX)), Refused);
    add("next_height", "below from_height", set(path(&[json!("next_height")]), json!(first - 1)), Refused);
    add("next_height", "at a listed transaction's height", set(path(&[json!("next_height")]), json!(first + 1)), Refused);
    add("next_height", "above the node's own tip", set(path(&[json!("next_height")]), json!(tip + 2)), Refused);
    add("next_height", "u64::MAX", set(path(&[json!("next_height")]), json!(u64::MAX)), Refused);
    add("next_height", "0", set(path(&[json!("next_height")]), json!(0)), Refused);
    add("next_height", "a page cut after the last listed transaction", set(path(&[json!("next_height")]), json!(first + 2)), Applied("a shorter page that lists everything up to where it ends (the loop calls it short and bans the node)"));
    add("txs", "missing", remove(vec![], "txs"), Refused);
    for (way, v) in [("null", Value::Null), ("a string", json!("[]")), ("a number", json!(0)), ("an object", json!({})), ("a list of numbers", json!([1, 2])), ("a list of null", json!([null])), ("a list of lists", json!([[]]))] {
        add("txs", way, set(path(&[json!("txs")]), v), Refused);
    }
    {
        let tx = page["txs"][0].clone();
        add("txs", "4,097 entries", Box::new(move |p: &mut Value| p["txs"] = Value::Array(vec![tx.clone(); 4_097])), Refused);
        let tx = page["txs"][0].clone();
        add("txs", "a transaction listed twice", Box::new(move |p: &mut Value| p["txs"].as_array_mut().unwrap().insert(0, tx.clone())), Refused);
    }
    add("txs", "empty", set(path(&[json!("txs")]), json!([])), Applied("hiding transactions is a well-formed lie: the state check refutes it"));
    add("(an unknown field)", "added", set(path(&[json!("served_by")]), json!("node-1")), Applied("fields the wallet does not know are ignored: a newer node may add one"));

    // ---- a transaction (the first and the second one) ------------------------------------------------
    for i in [0u64, 1] {
        let tx = |k: &str| path(&[json!("txs"), json!(i), json!(k)]);
        let at = || path(&[json!("txs"), json!(i)]);
        for f in ["height", "index"] {
            add(f, "missing", remove(at(), f), Refused);
            for (way, v) in wrong_numbers() {
                add(f, way, set(tx(f), v), Refused);
            }
        }
        add("height", "below the page", set(tx("height"), json!(first - 1)), Refused);
        add("height", "at next_height", set(tx("height"), json!(tip + 1)), Refused);
        add("height", "u64::MAX", set(tx("height"), json!(u64::MAX)), Refused);
        add("height", "0", set(tx("height"), json!(0)), Refused);
        add("index", "u64::MAX", set(tx("index"), json!(u64::MAX)), if i == 0 { Applied("the index is the order inside a block and nothing else") } else { Applied("as above") });
        for f in ["nf1", "nf2"] {
            let good = page["txs"][i as usize][f].as_str().unwrap().to_string();
            add(f, "missing", remove(at(), f), Refused);
            for (way, v) in wrong_hex(&good).into_iter().chain(not_canonical()) {
                add(f, way, set(tx(f), v), Refused);
            }
            add(f, "another canonical digest", set(tx(f), json!(hex::encode([3u8; 32]))), Applied("a replaced nullifier is a well-formed lie: the nullifier hash of the state check refutes it"));
        }
        {
            let other = page["txs"][i as usize]["nf1"].clone();
            add("nf2", "equal to nf1", set(tx("nf2"), other), Refused);
        }
        {
            let good = page["txs"][i as usize]["tx_hash"].as_str().unwrap().to_string();
            add("tx_hash", "missing", remove(at(), "tx_hash"), Refused);
            for (way, v) in wrong_hex(&good) {
                add("tx_hash", way, set(tx("tx_hash"), v), Refused);
            }
            add("tx_hash", "another hash", set(tx("tx_hash"), json!("ab".repeat(32))), Applied("a label: a listing cannot prove a transaction hash, and nothing is decided on it"));
        }
        add("tx_type", "missing", remove(at(), "tx_type"), Refused);
        for (way, v) in [("null", Value::Null), ("a number", json!(2)), ("a list", json!(["shield_v2"])), ("empty", json!("")), ("upper case", json!("SHIELD_V2")), ("a V1 type", json!("shield")), ("unknown", json!("shielded_swap_v2")), ("a trailing space", json!("shield_v2 "))] {
            add("tx_type", way, set(tx("tx_type"), v), Refused);
        }
        add("tx_type", "another V2 type", set(tx("tx_type"), json!("unshield_v2")), Applied("a label: the type of a transaction is not in what a wallet can check from a listing"));
        add("outputs", "missing", remove(at(), "outputs"), Refused);
        {
            let o = page["txs"][i as usize]["outputs"].clone();
            for (way, v) in [
                ("null", Value::Null),
                ("a string", json!("two")),
                ("an object", json!({ "0": o[0].clone(), "1": o[1].clone() })),
                ("empty", json!([])),
                ("one output", json!([o[0].clone()])),
                ("three outputs", json!([o[0].clone(), o[1].clone(), o[1].clone()])),
                ("a list of null", json!([null, null])),
                ("a list of numbers", json!([1, 2])),
            ] {
                add("outputs", way, set(tx("outputs"), v), Refused);
            }
        }
        // ---- an output ---------------------------------------------------------------------------------
        for j in [0u64, 1] {
            let out = |k: &str| path(&[json!("txs"), json!(i), json!("outputs"), json!(j), json!(k)]);
            let at = || path(&[json!("txs"), json!(i), json!("outputs"), json!(j)]);
            let good = |k: &str| page["txs"][i as usize]["outputs"][j as usize][k].as_str().unwrap().to_string();
            add("cm_out", "missing", remove(at(), "cm_out"), Refused);
            for (way, v) in wrong_hex(&good("cm_out")).into_iter().chain(not_canonical()) {
                add("cm_out", way, set(out("cm_out"), v), Refused);
            }
            add("cm_out", "another canonical digest", set(out("cm_out"), json!(hex::encode([5u8; 32]))), Applied("a replaced commitment is a well-formed lie: the tree root of the state check refutes it"));
            for f in ["kem_ct", "note_ct"] {
                add(f, "missing", remove(at(), f), Refused);
                for (way, v) in wrong_hex(&good(f)) {
                    add(f, way, set(out(f), v), Refused);
                }
                let zeros = "00".repeat(good(f).len() / 2);
                add(f, "other bytes of the right length", set(out(f), json!(zeros)), Applied("a blanked ciphertext is a well-formed lie: the ciphertext hash of the state check refutes it"));
            }
            add("leaf", "missing", remove(at(), "leaf"), Refused);
            for (way, v) in wrong_numbers() {
                add("leaf", way, set(out("leaf"), v), Refused);
            }
            add("leaf", "one too high", set(out("leaf"), json!(leaves + 2 * i + j + 1)), Refused);
            add("leaf", "u64::MAX", set(out("leaf"), json!(u64::MAX)), Refused);
            if (i, j) != (0, 0) {
                add("leaf", "one too low", set(out("leaf"), json!(leaves + 2 * i + j - 1)), Refused);
                add("leaf", "0", set(out("leaf"), json!(0)), Refused);
            }
        }
    }
    // the fields that contradict each other only together
    add("height", "the two transactions in the wrong order", Box::new(|p: &mut Value| p["txs"].as_array_mut().unwrap().swap(0, 1)), Refused);
    add("height", "the second transaction at the first one's height and index", Box::new(move |p: &mut Value| p["txs"][1]["height"] = json!(first)), Refused);
    add("height", "the first transaction one block late, in front of the second", Box::new(move |p: &mut Value| {
        p["txs"][0]["height"] = json!(first + 1);
        p["txs"][1]["index"] = json!(1);
    }), Applied("the height a listing gives a transaction is in no hash: the state check at that height refutes it — and says where (RW6-1)"));
    add("leaf", "every number two too high (a transaction was skipped)", Box::new(|p: &mut Value| {
        for t in p["txs"].as_array_mut().unwrap() {
            for j in 0..2 {
                t["outputs"][j]["leaf"] = json!(t["outputs"][j]["leaf"].as_u64().unwrap() + 2);
            }
        }
    }), Refused);
    if continues {
        add("leaf", "every number two too low", Box::new(|p: &mut Value| {
            for t in p["txs"].as_array_mut().unwrap() {
                for j in 0..2 {
                    t["outputs"][j]["leaf"] = json!(t["outputs"][j]["leaf"].as_u64().unwrap() - 2);
                }
            }
        }), Applied("leaf numbers are the node's claim: the page is applied at the wallet's own positions and reported (leaf_mismatch) — the loop bans the node and rescans"));
    }
    t
}

/// REVIEW_WALLET_6 RW6-2, the audit as a test. A page is the node's: **every way its content
/// can be invalid is a `listing:` error**, the one error for which the loop's rule is "ban the
/// node, rescan, go on" — and never `non_canonical:`, `request:`, `state:`, `internal:` or
/// `state_invariant:`, for which the only rule is "stop". The table (`corruptions`) takes each
/// field of the listing's JSON shape and corrupts it in each way; the page goes to the core as
/// a client hands it over — the text to `ListingPage::from_json`, the page to `scan` — with
/// the full key and with the viewing key, on a state that continues an earlier page and on an
/// empty one. Every row is either refused as `listing:` with the state unchanged, or is one of
/// the well-formed lies only the state check can tell from the truth (stated per row).
#[test]
fn rw6r_f2_every_field_of_a_page_corrupted_in_every_way_is_a_listing_error_and_changes_nothing() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(6);
    let first = chain.height + 1;
    fund(&mut chain, &alice.address(), &[4 * Q]); // block `first`: a note of the wallet
    let x = shield_body(&chain, &bob.address(), 3 * Q, "rw6r-f2-x");
    chain.block(&[&x]).unwrap(); // block `first + 1`: somebody else's transaction
    chain.advance_to(first + 5);
    let tip = chain.height;
    let (mut rows, mut refused, mut applied, mut fields) = (0, 0, 0, std::collections::BTreeSet::new());
    for continues in [true, false] {
        for view in [false, true] {
            let key = if view { alice.incoming_viewing_key() } else { alice.scan_key() };
            let mut base = wallet(&alice, 3, true);
            // the state continues an earlier page — or is empty and is handed the whole listing
            // (then `from_height` may jump forward, and only forward)
            let (since, leaves) = if continues {
                base.scan(&parse(&chain.page_value(0, first - 1)), &key).unwrap();
                (first, 4)
            } else {
                (first, 0)
            };
            let mut good = chain.page_value(since, tip);
            if !continues {
                // an empty state reads the listing from `first` on as a node whose pool was
                // activated there would serve it: the leaves are numbered from 0
                for t in good["txs"].as_array_mut().unwrap() {
                    for j in 0..2 {
                        t["outputs"][j]["leaf"] = json!(t["outputs"][j]["leaf"].as_u64().unwrap() - 4);
                    }
                }
            }
            assert_eq!(good["txs"].as_array().unwrap().len(), 2);
            {
                let mut s = base.clone();
                let r = s.scan(&parse(&good), &key).unwrap();
                assert!(r.at_tip && r.pool_active && r.txs == 2, "the page as the node serves it is applied");
            }
            for (field, way, corrupt, expect) in corruptions(&good, first, tip, leaves, continues) {
                let what = format!("{field}: {way} (the state {}, the {} key)", if continues { "continues" } else { "is empty" }, if view { "viewing" } else { "full" });
                let mut page = good.clone();
                corrupt(&mut page);
                assert!(page != good, "{what}: the corruption changed nothing");
                let mut s = base.clone();
                let before = s.clone();
                let result = ListingPage::from_json(&page.to_string()).and_then(|p| s.scan(&p, &key));
                rows += 1;
                fields.insert(field);
                // the invariant of the whole table: no page causes any other class of error
                assert!(matches!(result, Ok(_) | Err(WalletError::Listing(_))), "{what}: {} — an error the loop stops on", result.as_ref().err().map(|e| e.to_string()).unwrap_or_default());
                match (expect, &result) {
                    (Expect::Refused, Err(WalletError::Listing(_))) => {
                        refused += 1;
                        assert!(s == before, "{what}: a refused page changed the state");
                    }
                    (Expect::Applied(_), Ok(r)) => {
                        applied += 1;
                        WalletState::from_json(&s.to_json().unwrap()).unwrap_or_else(|e| panic!("{what}: the state does not read back: {e}"));
                        if field == "active" {
                            assert!(!r.pool_active && s == before, "{what}: 'not active' changes nothing");
                        }
                        if way == "every number two too low" {
                            assert!(r.leaf_mismatch, "{what}: reported");
                        }
                    }
                    (Expect::Refused, Ok(_)) => panic!("{what}: the page was applied"),
                    (Expect::Applied(why), Err(e)) => panic!("{what}: refused ({e}), expected to be applied: {why}"),
                    _ => unreachable!(),
                }
            }
        }
    }
    println!("rw6r-f2: {rows} corrupted pages over {} fields: {refused} refused as listing: with the state unchanged, {applied} well-formed lies applied, any other error: 0", fields.len());
    assert!(fields.len() >= 17 && refused > 1_000 && applied > 50, "{} fields, {refused} refused, {applied} applied", fields.len());
}

/// RW6-2, the other half: the errors of `scan` that are NOT the page's keep their own class —
/// the caller's key (`request:`), the caller's state (`rescan_required:`) — and the loop's
/// rule for "anything else" does not pin the node the fault happened on: when it stops,
/// `listing` is the next node and the stored `listed_from` is unknown.
#[test]
fn rw6r_f2_what_is_not_the_pages_keeps_its_own_class_and_a_fault_does_not_pin_the_node() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    // the caller's key: another wallet's
    let mut s = wallet(&alice, 3, true);
    let before = s.clone();
    assert!(matches!(s.scan(&chain.page(0), &bob.scan_key()), Err(WalletError::Request(_))) && s == before);
    // the loop, handed that error: STOP(fault) — and the next session starts at the NEXT node
    let mut c = LoopClient::new(wallet(&alice, 3, true), 0);
    c.round(&bob.scan_key(), &mut |_, since| chain.page(since), &mut || (0..3).map(|i| report(&chain, i)).collect());
    assert!(matches!(c.session.stopped, Some(Stop::Fault(_))), "{:?}", c.session.stopped);
    assert_eq!((c.session.listing, c.session.origin, c.session.bad.len(), c.rescans), (1, None, 0, 0), "the fault moved the start of the next session on, banned nobody and rescanned nothing");
    assert!(c.s == before, "the state is kept as it is");
    // … whatever the error is, and around the banned nodes
    let mut session = Session::new(3, 2);
    session.bad.insert(0);
    assert!(matches!(session.after_scan_error(&WalletError::StateInvariant), Decision::Stop(Stop::Fault(_))));
    assert_eq!((session.listing, session.origin), (1, None));
    // the next session: `listed_from` unknown. What the stored state holds above its confirmed
    // height is nobody's: refuted, it is rescanned and NO node is banned for it.
    let forged = {
        let mut p = chain.page_value(0, 20);
        let extra = listing_entry(&shield_body(&chain, &alice.address(), 50 * Q, "rw6r-f2-forged"), 20, 0, chain.state().note_count);
        p["txs"].as_array_mut().unwrap().push(extra);
        parse(&p)
    };
    let mut stored = wallet(&alice, 3, true);
    stored.scan(&forged, &alice.scan_key()).unwrap(); // listed by some node, before the fault
    let mut c = LoopClient::new(stored, 1);
    c.session = Session::new_unattributed(3, 1);
    let round = |c: &mut LoopClient| c.round(&alice.scan_key(), &mut |_, since| chain.page(since), &mut || (0..3).map(|i| report(&chain, i)).collect());
    round(&mut c);
    assert_eq!((c.session.bad.len(), c.rescans, c.session.listing, c.left.len()), (0, 1, 1, 0), "refuted, and not in pages node 2 served: rescanned, nobody banned, the node stays");
    round(&mut c);
    assert_eq!((c.s.confirmed_height(), c.s.balances().confirmed, c.session.bad.len()), (Some(20), 16 * Q as u128, 0));
}

// ---------------------------------------------------------------------------------------------------
// RW6-1 — a refutation is attributable.
// ---------------------------------------------------------------------------------------------------

/// `confirm_state` says WHERE the state is refuted and on which side of the confirmed height:
///
/// * a report for a height below the confirmed height that MATCHES the state there is simply
///   consistent;
/// * one dissenter there is a minority: nothing;
/// * a majority there: `confirmed_refuted`, a `Refutation { confirmed: true, from_height: 0 }` —
///   and NOT `listing_refuted_above_confirmed`: nobody's pages are named;
/// * a majority at a height above the confirmed height: `listing_refuted_above_confirmed`, and
///   the range of the listing in doubt starts one above the confirmed height.
#[test]
fn rw6r_f1_confirm_state_says_where_a_listing_is_refuted_and_on_which_side_of_the_confirmed_height() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let at_20 = chain.report(IDS[0]);
    let x = shield_body(&chain, &bob.address(), 3 * Q, "rw6r-f1-x");
    chain.block(&[&x]).unwrap(); // block 21
    let at_21 = chain.report(IDS[0]);
    chain.advance_to(22);
    let at_22 = chain.report(IDS[0]);
    let by = |r: &StateReport, i: usize| StateReport { node_id: node(IDS[i]), ..r.clone() };
    for n in [3usize, 4, 5] {
        let quorum = n / 2 + 1;
        // the liar's listing: block 21's transaction in block 22. The state at 22 is the chain's.
        let mut s = wallet(&alice, n, true);
        s.scan(&shifted(&chain, 0, 21), &alice.scan_key()).unwrap();
        let c = s.confirm_state(&(0..quorum).map(|i| by(&at_22, i)).collect::<Vec<_>>()).unwrap();
        assert_eq!((c.matched_height, c.listing_refuted, c.refuted.len()), (Some(22), false, 0), "n = {n}");
        // below the confirmed height: a report that matches (height 20: nothing was shifted
        // there) is consistent, whoever makes it and however many do
        let c = s.confirm_state(&(0..n).map(|i| by(&at_20, i)).collect::<Vec<_>>()).unwrap();
        assert!(c.dissenting.is_empty() && !c.listing_refuted && !c.confirmed_refuted && c.refuted.is_empty(), "n = {n}: {c:?}");
        // the height that WAS shifted: the largest lying minority, with any lie, is noise
        let minority = n - quorum;
        let c = s.confirm_state(&(0..minority).flat_map(|i| [by(&at_21, i), lie(by(&at_21, i)), by(&at_20, i)]).collect::<Vec<_>>()).unwrap();
        assert!(!c.listing_refuted && !c.confirmed_refuted && !c.listing_refuted_above_confirmed && c.refuted.is_empty(), "n = {n}: a minority below the confirmed height: {c:?}");
        assert_eq!(c.dissenting.len(), minority, "n = {n}: they are named, and that is all");
        // one more — an honest node standing at 21 says, truthfully, what the chain is there
        let c = s.confirm_state(&(0..=minority).map(|i| by(&at_21, i)).collect::<Vec<_>>()).unwrap();
        assert!(c.listing_refuted && c.confirmed_refuted && !c.listing_refuted_above_confirmed, "n = {n}: {c:?}");
        assert_eq!(c.refuted, vec![Refutation { from_height: 0, height: 21, confirmed: true, dissenting: minority + 1, agreeing: 0 }], "n = {n}");
        assert_eq!(s.confirmed_height(), Some(22), "n = {n}: what was confirmed stays until the rescanned state replaces it");
        // above the confirmed height: a forged block 23
        let mut ahead = s.clone();
        let mut p = chain.page_value(23, 22);
        p["tip_height"] = json!(23);
        p["next_height"] = json!(24);
        p["txs"] = json!([listing_entry(&shield_body(&chain, &alice.address(), 50 * Q, "rw6r-f1-forged"), 23, 0, chain.state().note_count)]);
        ahead.scan(&parse(&p), &alice.scan_key()).unwrap();
        let mut at_23 = at_22.clone();
        at_23.height = 23; // the chain made an empty block
        let c = ahead.confirm_state(&(0..=minority).map(|i| by(&at_23, i)).collect::<Vec<_>>()).unwrap();
        assert!(c.listing_refuted && c.listing_refuted_above_confirmed && !c.confirmed_refuted, "n = {n}: {c:?}");
        assert_eq!(c.refuted, vec![Refutation { from_height: 23, height: 23, confirmed: false, dissenting: minority + 1, agreeing: 0 }], "n = {n}: the listing in doubt is what lies above the confirmed height");
        // … and both at once are both reported, each with its side
        let both: Vec<StateReport> = (0..=minority).flat_map(|i| [by(&at_21, i), by(&at_23, i)]).collect();
        let c = ahead.confirm_state(&both).unwrap();
        assert_eq!(c.refuted.iter().map(|r| (r.height, r.confirmed, r.from_height)).collect::<Vec<_>>(), vec![(21, true, 0), (23, false, 23)], "n = {n}");
    }
}

/// **A strict minority never produces `listing_refuted`** — for 2 to 7 nodes, any strict
/// minority of them, at heights below, at and above the confirmed height, each node reporting
/// several heights and several different states per height, in one call. And the smallest
/// number that is not a strict minority-that-leaves-a-quorum does.
#[test]
fn rw6r_f1_a_strict_minority_never_refutes_a_listing() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut history = vec![(chain.height, chain.report(IDS[0]))];
    for h in 5..=12 {
        if h % 2 == 0 {
            fund(&mut chain, &alice.address(), &[Q + h]);
        } else {
            chain.advance_to(h);
        }
        history.push((chain.height, chain.report(IDS[0])));
    }
    let by = |r: &StateReport, i: usize| StateReport { node_id: node(IDS[i]), ..r.clone() };
    for n in 2..=7usize {
        let quorum = (n / 2 + 1).max(2);
        let mut s = wallet(&alice, n, true);
        // scanned to 12, confirmed at 9: heights on both sides of the confirmed height
        s.scan(&chain.page(0), &alice.scan_key()).unwrap();
        let at_9 = &history.iter().find(|(h, _)| *h == 9).unwrap().1;
        assert_eq!(s.confirm_state(&(0..quorum).map(|i| by(at_9, i)).collect::<Vec<_>>()).unwrap().matched_height, Some(9));
        for dissenters in 0..=n - quorum {
            // every one of them contradicts EVERY height, twice, and reports nonsense heights too
            let mut reports = Vec::new();
            for i in 0..dissenters {
                for (h, r) in &history {
                    reports.push(lie(by(r, i)));
                    reports.push(lie(lie(by(r, i))));
                    reports.push(StateReport { height: *h, tree_root: [9; 32], ..by(r, i) });
                }
                reports.push(StateReport { height: 1_000_000, ..by(at_9, i) });
            }
            assert!(2 * dissenters < n, "a strict minority");
            let c = s.clone().confirm_state(&reports).unwrap();
            assert!(!c.listing_refuted && !c.listing_refuted_above_confirmed && !c.confirmed_refuted && c.refuted.is_empty(), "n = {n}, {dissenters} dissenters: {c:?}");
            // … and with the honest nodes agreeing beside them
            reports.extend((dissenters..n).map(|i| by(&history.last().unwrap().1, i)));
            let c = s.clone().confirm_state(&reports).unwrap();
            assert!(!c.listing_refuted && c.refuted.is_empty() && c.matched_height == Some(12), "n = {n}, {dissenters} dissenters and the rest agreeing: {c:?}");
        }
        // one more than the largest minority that leaves a quorum: at least half of the nodes
        let enough = n - quorum + 1;
        let c = s.clone().confirm_state(&(0..enough).map(|i| lie(by(&history.last().unwrap().1, i))).collect::<Vec<_>>()).unwrap();
        assert!(c.listing_refuted && c.listing_refuted_above_confirmed && 2 * enough >= n, "n = {n}: {enough} dissenters: {c:?}");
    }
}

/// The loop's side of RW6-1. The liar of `rw6_f1` is STILL the listing node when the
/// contradiction of a confirmed height arrives (two honest nodes standing at the height it
/// shifted): the state is rescanned and nobody is banned in that round — a contradicted
/// confirmation names nobody's pages. In the next round the liar lists the same way into the
/// rescanned state, the reports are still in `R`, and now the refuted heights are heights the
/// liar itself served since the state was last empty: it is banned, and the honest node that
/// follows confirms the tip. No honest node is banned at any time.
#[test]
fn rw6r_f1_the_node_that_shifted_is_banned_once_the_refuted_heights_are_its_own() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let x = shield_body(&chain, &bob.address(), 3 * Q, "rw6r-f1-loop");
    chain.block(&[&x]).unwrap(); // block 21
    let at_21 = chain.report(IDS[0]);
    chain.advance_to(22);
    let by = |r: &StateReport, i: usize| StateReport { node_id: node(IDS[i]), ..r.clone() };
    let key = alice.scan_key();
    let mut c = LoopClient::new(wallet(&alice, 3, true), 0);
    let page = |node: usize, since: u64| if node == 0 { shifted(&chain, since, 21) } else { chain.page(since) };
    // round 1: confirmed at 22 by the liar and one honest node; the other honest node is at 21
    c.round(&key, &mut |n, s| page(n, s), &mut || vec![report(&chain, 0), report(&chain, 1), by(&at_21, 2)]);
    assert_eq!((c.s.confirmed_height(), c.session.bad.len(), c.rescans), (Some(22), 0, 0));
    assert_eq!(c.session.served, vec![Served { node: 0, from: 3, to: 22 }], "the pages the liar served are recorded as its own");
    // round 2: both honest nodes report 21 (truthfully): the confirmed part is contradicted
    c.round(&key, &mut |n, s| page(n, s), &mut || vec![report(&chain, 0), by(&at_21, 1), by(&at_21, 2)]);
    assert_eq!((c.session.bad.len(), c.rescans, c.session.listing, c.left.len()), (0, 1, 0, 0), "a contradicted confirmation: rescanned, nobody blamed, the listing node stays");
    assert!(c.s.scanned_height().is_none() && c.session.served.is_empty() && c.session.from_empty);
    // round 3: the liar lists the same way; the honest reports for 21 are still in R
    c.round(&key, &mut |n, s| page(n, s), &mut || (0..3).map(|i| report(&chain, i)).collect());
    assert_eq!((c.session.bad.iter().copied().collect::<Vec<_>>(), c.session.listing, c.left.clone()), (vec![0], 1, vec![(3, 0, true, "listing_refuted")]), "the refuted heights are the liar's own pages now");
    // round 4: the honest node
    c.round(&key, &mut |n, s| page(n, s), &mut || (0..3).map(|i| report(&chain, i)).collect());
    assert_eq!((c.s.confirmed_height(), c.s.scanned_height(), c.s.balances().confirmed, c.session.bad.len(), c.session.stopped.clone()), (Some(22), Some(22), 16 * Q as u128, 1, None));
}

/// `Session::listed_by_listing_node`: whose the heights of a state are.
#[test]
fn rw6r_f1_which_node_served_which_heights() {
    let page = |from: u64, next: u64| parse(&json!({ "active": true, "tip_height": 1_000, "from_height": from, "next_height": next, "txs": [] }));
    let ok = |next: u64| Ok(ScanReport { next_height: next, pool_active: true, ..Default::default() });
    // a session that starts on the stored listed_from: what the stored state holds is that node's
    let mut s = Session::new(3, 0);
    assert!(s.listed_by_listing_node(0, 50), "nothing listed in this session: the stored listed_from's word");
    s.after_scan(&page(51, 115), &ok(115));
    s.after_scan(&page(115, 179), &ok(179));
    assert_eq!(s.served, vec![Served { node: 0, from: 51, to: 178 }]);
    assert!(s.listed_by_listing_node(40, 178) && s.listed_by_listing_node(100, 120));
    // the node is left without a rescan (everything confirmed): the next node's pages are its
    // own, the earlier heights are not
    s.listing = 1;
    s.after_scan(&page(179, 243), &ok(243));
    assert!(s.listed_by_listing_node(179, 242) && s.listed_by_listing_node(200, 200));
    assert!(!s.listed_by_listing_node(178, 242) && !s.listed_by_listing_node(0, 10) && !s.listed_by_listing_node(100, 200));
    // a rescan: everything from the first page on — the jump to the activation height too
    s.after_rescan();
    assert!(!s.listed_by_listing_node(0, 0), "an empty state holds nobody's heights");
    s.after_scan(&page(3, 67), &ok(67));
    assert!(s.listed_by_listing_node(0, 66) && !s.listed_by_listing_node(0, 67));
    // a state that was emptied without the session being told (a page that does not continue
    // what is recorded): the record starts again
    s.after_scan(&page(3, 40), &ok(40));
    assert_eq!(s.served, vec![Served { node: 1, from: 0, to: 39 }]);
    // `listed_from` unknown: nothing the session did not list itself is anybody's
    let mut u = Session::new_unattributed(3, 2);
    assert!(!u.listed_by_listing_node(0, 50));
    u.after_scan(&page(51, 115), &ok(115));
    assert!(u.listed_by_listing_node(51, 114) && !u.listed_by_listing_node(50, 114));
}

// ---------------------------------------------------------------------------------------------------
// RW6-3 — "the pool is not active".
// ---------------------------------------------------------------------------------------------------

fn inactive(since: u64, tip: u64) -> ListingPage {
    parse(&json!({ "active": false, "tip_height": tip, "from_height": since, "next_height": since, "txs": [] }))
}

/// The core's side: an inactive page is told from an empty pool. `scan` reads nothing and
/// changes nothing (`pool_active: false`, no scanned height); an ACTIVE pool without a
/// transaction is scanned like any other (`pool_active: true`, a scanned height). Whatever
/// else an inactive page says is not looked at.
#[test]
fn rw6r_f3_an_inactive_pool_is_not_an_empty_pool() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    chain.advance_to(10);
    let mut s = wallet(&alice, 3, false);
    let before = s.clone();
    let r = s.scan(&inactive(0, 500), &alice.scan_key()).unwrap();
    assert!(!r.pool_active && !r.at_tip && r.next_height == 0 && s == before && s.scanned_height().is_none());
    let r = s.scan(&parse(&json!({ "active": false, "tip_height": 0, "from_height": 77, "next_height": 5, "txs": [] })), &alice.incoming_viewing_key()).unwrap();
    assert!(!r.pool_active && s == before && s.view_only_since().is_none(), "nothing of an inactive page is read");
    let r = s.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(r.pool_active && r.at_tip && r.txs == 0 && s.scanned_height() == Some(10), "an active pool without a transaction");
    // … and the wasm surface's report carries the field (it is the serialised ScanReport)
    assert_eq!(serde_json::to_value(&r).unwrap()["pool_active"], json!(true));
}

/// The loop's rules, as `NOTES.md` §6 states them:
///
/// (a) a strict majority of the configured nodes say "not active" → the loop idles
///     (`Stop::PoolInactive`): no ban, no rescan, the state untouched; `recheck_pool` asks
///     again. With the stats answers of step 2 that is the FIRST round, whoever is listed from
///     — also a liar that serves a forged listing of its own and vouches for it;
/// (b) a minority say so while a majority is active → they are left, not banned, and the tip
///     is confirmed from an active node;
/// (c) a node that says "not active" after its own state report showed a pool that holds notes
///     contradicts itself → banned.
#[test]
fn rw6r_f3_a_majority_inactive_idles_a_minority_is_left_and_a_self_contradiction_is_banned() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let key = alice.scan_key();
    // ---- (a) three and five nodes, the honest majority inactive; the liars (first in the
    // order) serve a forged listing and vouch for whatever the wallet holds
    for n in [3usize, 5] {
        let liars = n - (n / 2 + 1);
        for start in 0..n {
            let fresh = wallet(&alice, n, false);
            let mut c = LoopClient::new(fresh.clone(), start);
            let answers = |s: &WalletState| Stats {
                reports: (0..liars).filter_map(|i| s.scanned_height().and_then(|h| s.state_at(h)).map(|v| StateReport { node_id: node(IDS[i]), height: s.scanned_height().unwrap(), tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count, ciphertext_acc: v.ciphertext_acc })).collect(),
                active: (0..n).map(|i| (i, i < liars)).collect(),
            };
            let round = |c: &mut LoopClient| {
                let s = c.s.clone();
                c.round_with(&key, &mut |node, since| Some(if node < liars { chain.page(since) } else { inactive(since, 500) }), &mut || answers(&s));
            };
            round(&mut c);
            assert_eq!((c.session.stopped.clone(), c.session.bad.len(), c.rescans, c.session.round), (Some(Stop::PoolInactive), 0, 0, 1), "n = {n}, start {start}: idle in the first round; left {:?}", c.left);
            assert!(c.s.confirmed_height().is_none() && c.s.balances().confirmed == 0 && !c.s.spend_status(None).can_spend_now, "n = {n}: nothing is confirmed on a network without the pool");
            for _ in 0..5 {
                round(&mut c); // idle: nothing is asked
            }
            assert_eq!(c.session.round, 1);
            // the long interval: the loop asks again, and idles again
            c.session.recheck_pool();
            assert!(c.session.stopped.is_none() && c.session.inactive.is_empty());
            round(&mut c);
            assert_eq!((c.session.stopped.clone(), c.session.bad.len(), c.session.round), (Some(Stop::PoolInactive), 0, 2), "n = {n}, start {start}");
            // without the stats answers (a client that only lists): the honest nodes are asked
            // one after the other, and a quorum of them is the same majority
            if start >= liars {
                let mut c = LoopClient::new(fresh.clone(), start);
                for _ in 0..n {
                    c.round(&key, &mut |_, since| inactive(since, 500), &mut || Vec::new());
                }
                assert_eq!((c.session.stopped.clone(), c.session.bad.len(), c.rescans, c.session.round as usize), (Some(Stop::PoolInactive), 0, 0, n / 2 + 1), "n = {n}: by the listing answers alone");
                assert!(c.s == fresh, "n = {n}: the state is untouched");
            }
        }
    }
    // ---- (b) a minority inactive (outdated nodes, or liars), first in the order; the majority active
    for n in [3usize, 5] {
        let outdated = n - (n / 2 + 1);
        let mut c = LoopClient::new(wallet(&alice, n, true), 0);
        for _ in 0..outdated + 2 {
            c.round_with(&key, &mut |node, since| Some(if node < outdated { inactive(since, 20) } else { chain.page(since) }), &mut || Stats { reports: (outdated..n).map(|i| report(&chain, i)).collect(), active: (0..n).map(|i| (i, i >= outdated)).collect() });
        }
        assert_eq!((c.session.bad.len(), c.session.stopped.clone(), c.rescans), (0, None, 0), "n = {n}: left, not banned; no rescan (nothing had been read)");
        assert_eq!(c.left, (0..outdated).map(|i| (i as u64 + 1, i, false, "the pool is not active on this node")).collect::<Vec<_>>(), "n = {n}: each of them costs one round");
        assert_eq!((c.session.listing, c.s.confirmed_height(), c.s.balances().confirmed), (outdated, Some(20), 16 * Q as u128), "n = {n}");
    }
    // ---- (c) the node reported a pool that holds notes, then says "not active"
    let mut c = LoopClient::new(wallet(&alice, 3, true), 0);
    c.round(&key, &mut |_, since| chain.page(since), &mut || (0..3).map(|i| report(&chain, i)).collect());
    assert_eq!((c.s.confirmed_height(), c.session.pool_seen.len()), (Some(20), 3));
    c.round(&key, &mut |node, since| if node == 0 { inactive(since, 20) } else { chain.page(since) }, &mut || (0..3).map(|i| report(&chain, i)).collect());
    assert_eq!((c.session.bad.iter().copied().collect::<Vec<_>>(), c.left.clone(), c.session.listing), (vec![0], vec![(2, 0, true, "not active, against its own state report")], 1));
    // a report of an EMPTY pool (a node whose activation height is set and not reached holds a
    // pool record without a note) is not such a report
    let mut s = Session::new(3, 0);
    let empty = StateReport { note_count: 0, nullifier_count: 0, ..report(&chain, 0) };
    s.note_reports(&wallet(&alice, 3, true), &[empty]);
    assert!(s.pool_seen.is_empty());
    let w = wallet(&alice, 3, true);
    assert_eq!(s.after_scan(&inactive(0, 2), &Ok(ScanReport::default())), Decision::Go, "step 1 decides nothing about it");
    let empty = StateReport { note_count: 0, nullifier_count: 0, ..report(&chain, 0) };
    assert_eq!(s.first_check_may_run(&w, &[empty]), Decision::Leave { ban: false, why: "the pool is not active on this node" });
}

// ---------------------------------------------------------------------------------------------------
// The noted items.
// ---------------------------------------------------------------------------------------------------

/// `LoopClient` can leave a listing request unanswered (`round_with`), and its `P` is the
/// constant the documents name.
#[test]
fn rw6r_noted_the_reference_client_can_leave_a_request_unanswered() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let mut c = LoopClient::new(wallet(&alice, 3, true), 0);
    assert_eq!((c.pages_per_round, LOOP_CLIENT_PAGES), (4, 4));
    for round in 1..=STRIKES as u64 {
        assert_eq!((c.session.listing, c.session.strikes as u64), (0, round - 1));
        c.round_with(&alice.scan_key(), &mut |node, since| (node != 0).then(|| chain.page(since)), &mut || Stats { reports: (1..3).map(|i| report(&chain, i)).collect(), active: Vec::new() });
    }
    assert_eq!((c.session.listing, c.left.clone(), c.session.bad.len()), (1, vec![(STRIKES as u64, 0, false, "no answer")], 0), "K rounds without an answer: left, not banned");
    c.round_with(&alice.scan_key(), &mut |node, since| (node != 0).then(|| chain.page(since)), &mut || Stats { reports: (1..3).map(|i| report(&chain, i)).collect(), active: Vec::new() });
    assert_eq!(c.s.confirmed_height(), Some(20));
}

/// **Every public path to a submittable spend passes `spend_gate`** — the list, and each entry
/// run against the two states the gate exists for: a state under the restore embargo (confirmed,
/// base fixed, not yet at `until`) and a state the worker left view-only. In a wallet build
/// (without the `test-vectors` feature) the paths are `build_transfer` and `build_unshield`;
/// `mark_pending` records a spend and is gated the same way. `deterministic::transfer_locked` /
/// `unshield_locked` are those builders without the proof (test builds only).
///
/// What is NOT a path: `WalletState::spend_input` / `spend_input_with` return a note's secrets
/// and its Merkle path — data that `notes()` and `tree().path()` also return — and no public
/// function of a wallet build takes a `SpendInput`, a `TransferRequest` or an
/// `UnshieldRequest` (the census below reads the source for that). The raw assembly behind the
/// `test-vectors` feature (`deterministic::transfer`, `::unshield`) takes them and looks at no
/// state: it exists for vectors and tests and is never part of a wallet build.
#[test]
fn rw6r_noted_every_public_path_to_a_spend_passes_the_gate() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    // a spendable state, to take a well-formed record from
    let mut open = wallet(&alice, 2, true);
    open.scan(&chain.page(0), &alice.scan_key()).unwrap();
    open.confirm_state(&[report(&chain, 0), report(&chain, 1)]).unwrap();
    assert!(open.spend_gate().is_ok());
    let position = open.unspent().find(|n| n.value == 10 * Q).unwrap().position;
    let spend = || SpendOptions { chain_id: CHAIN, inputs: std::slice::from_ref(&position), expiry_height: None, allow_unverified: true, max_fee: None };
    let record = deterministic::transfer_locked(&open, open.revision(), &alice, &TransferParams { spend: spend(), recipient: &bob.address(), amount: Q, fee: Q }, "rw6r-gate").unwrap().0.pending().unwrap();
    // (1) under the embargo: a restore, confirmed, the base fixed
    let mut embargoed = wallet(&alice, 2, false);
    embargoed.scan(&chain.page(0), &alice.scan_key()).unwrap();
    embargoed.confirm_state(&[report(&chain, 0), report(&chain, 1)]).unwrap();
    // (2) view-only: the same state after one page with the viewing key
    let mut view_only = open.clone();
    view_only.scan(&chain.page(view_only.next_height()), &alice.incoming_viewing_key()).unwrap();
    for (name, state) in [("under the embargo", &embargoed), ("view-only", &view_only)] {
        let gate = |e: &WalletError| matches!((name, e), ("under the embargo", WalletError::RestoredRecently { until: Some(148) }) | ("view-only", WalletError::ViewOnly));
        assert!(state.spend_gate().as_ref().err().is_some_and(gate), "{name}: the gate itself");
        let transfer = TransferParams { spend: spend(), recipient: &bob.address(), amount: Q, fee: Q };
        let unshield = UnshieldParams { spend: spend(), to_account: [9; 32], v_out: Q, fee: Q };
        let answers: Vec<(&str, Option<WalletError>)> = vec![
            ("build_transfer", build_transfer(state, state.revision(), &alice, &transfer).err()),
            ("build_unshield", build_unshield(state, state.revision(), &alice, &unshield).err()),
            ("WalletState::mark_pending", state.clone().mark_pending(record.clone()).err()),
            ("WalletState::spend_base", state.spend_base(true).err()),
            ("deterministic::transfer_locked", deterministic::transfer_locked(state, state.revision(), &alice, &transfer, "rw6r-gate-t").err()),
            ("deterministic::unshield_locked", deterministic::unshield_locked(state, state.revision(), &alice, &unshield, "rw6r-gate-u").err()),
        ];
        for (path, answer) in answers {
            assert!(answer.as_ref().is_some_and(gate), "{name}: {path} answered {:?}", answer.map(|e| e.to_string()));
        }
        assert!(state.pending().is_empty());
    }

    // ---- the census, from the source: what a wallet build exports that touches a spend --------------
    let tx_rs = include_str!("../src/tx.rs");
    let (wallet_build, test_only) = tx_rs.split_once("pub mod deterministic {").expect("the test-vectors module");
    assert!(wallet_build.trim_end().ends_with("#[cfg(any(test, feature = \"test-vectors\"))]"), "the raw assembly is compiled with the test-vectors feature only");
    let public_fns = |src: &str| -> Vec<(String, String)> {
        src.lines()
            .filter_map(|l| l.trim_start().strip_prefix("pub fn "))
            .map(|l| (l.split(['(', '<']).next().unwrap().to_string(), l.to_string()))
            .collect()
    };
    let takes_raw_input = |sig: &str| ["SpendInput", "TransferRequest", "UnshieldRequest", "InputWitness", "SpendWitness"].iter().any(|t| sig.split("->").next().unwrap().contains(t));
    let exported = public_fns(wallet_build);
    // no public function of a wallet build takes a note's secrets or an assembly request
    for (name, sig) in &exported {
        assert!(!takes_raw_input(sig), "tx.rs: pub fn {name} takes an ungated input: {sig}");
    }
    // the public functions of tx.rs that take a state, exactly: the two gated builders and the
    // shield that records its own note (a shield spends no note: `UI_CONTRACT.md`)
    let with_state: Vec<&str> = exported.iter().filter(|(_, sig)| sig.contains("&WalletState")).map(|(n, _)| n.as_str()).collect();
    assert_eq!(with_state, ["build_own_shield", "build_transfer", "build_unshield"]);
    for builder in ["build_transfer", "build_unshield"] {
        let body = wallet_build.split_once(&format!("pub fn {builder}(")).unwrap().1.split_once("\n}\n").unwrap().0;
        assert!(body.contains("spend_inputs(state, expected_revision, keys, &p.spend)?") && body.contains("locked(state, &unproven)?"), "{builder} goes through spend_inputs (spend_base → spend_gate) and mark_pending (spend_gate)");
    }
    let spend_inputs = wallet_build.split_once("fn spend_inputs(").unwrap().1.split_once("\n}\n").unwrap().0;
    assert!(spend_inputs.contains("state.spend_base(o.allow_unverified)?"));
    // … and the raw assembly exists behind the feature only
    let raw: Vec<String> = public_fns(test_only).into_iter().filter(|(_, sig)| takes_raw_input(sig)).map(|(n, _)| n).collect();
    assert_eq!(raw, ["transfer", "unshield", "transfer_with_os_entropy", "transfer_with_failing_entropy"], "the ungated assembly: test-vectors only, by name");
    let store_rs = include_str!("../src/store.rs");
    let body_of = |name: &str| store_rs.split_once(&format!("fn {name}(")).unwrap().1.split_once("\n    }\n").unwrap().0;
    assert!(body_of("spend_base").contains("self.spend_gate()?") && body_of("mark_pending_inner").contains("self.spend_gate()?"));
    // the only public functions of the crate that RETURN a `SpendInput` (data, see above)
    let returns_input: Vec<String> = public_fns(store_rs).into_iter().chain(public_fns(include_str!("../src/select.rs"))).filter(|(_, sig)| sig.split("->").nth(1).is_some_and(|r| r.contains("SpendInput"))).map(|(n, _)| n).collect();
    assert_eq!(returns_input, ["spend_input", "spend_input_with"]);
}
