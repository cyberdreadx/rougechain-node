//! REVIEW_WALLET_2 — in-crate tests of the hedged per-transaction generator (the fix of
//! REVIEW_WALLET_1 F-5) across a PROCESS RESTART. See `REVIEW_WALLET_2.md`, section "F-5".
//!
//! The hedge mixes a process-wide counter in. A restart sets it back to 0, so with a generator
//! that returns the same bytes after the restart (a restored VM snapshot, a broken polyfill) the
//! only thing that separates two transactions is the transcript. The question asked: a retry
//! after expiry with the same notes, recipient and amount — is that "the same context", and so
//! the same `r`, ML-KEM randomness and dummy secrets in two different transactions?
//!
//! A restart is modelled as what it is: the test binary runs itself as a child process, once per
//! transaction, so every child assembles its transaction with the counter at 0 and the same stuck
//! generator. Nothing in the crate is changed for it.

use super::*;
use crate::body::{OFF_KEM, OFF_NOTE};
use crate::entropy::DeterministicEntropy;
use crate::keys::KEM_CT_BYTES;
use crate::note_enc::NOTE_CT_BYTES;
use crate::store::{ListingPage, WalletState};
use sha2::{Digest as _, Sha256};

const Q: u64 = 1_000_000_000;
const CHILD_ENV: &str = "RW2_F5_CHILD";
const CHILD_TEST: &str = "tx::review_wallet_2_tests::rw2_child_assembles_one_transaction_under_a_stuck_generator";

/// A generator that "works" and returns the same byte for ever.
struct Stuck(u8);

impl Entropy for Stuck {
    fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
        b.fill(self.0);
        Ok(())
    }
}

fn account() -> Vec<u8> {
    (0..1_952u32).map(|i| i as u8).collect()
}

/// A wallet with one 5 XRGE note, made with the deterministic test stream (which does not touch
/// the hedge's counter).
fn funded(keys: &ShieldedKeys) -> WalletState {
    let mut state = WalletState::new(keys.address().pk);
    let ctx0 = TxContext { chain_id: "rw2".into(), anchor: state.anchor(), anchor_height: 50, expiry_height: 100 };
    let req = ShieldRequest { ctx: ctx0, from_pub_key: &account(), nonce: 0, v_in: 6 * Q, fee: Q, recipient: &keys.address(), max_fee: None };
    let b = assemble_shield(&req, Source::Stream(&mut DeterministicEntropy::new("rw2-f5-fund"))).unwrap().body;
    let out = |j: usize| {
        serde_json::json!({
            "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": j,
            "kem_ct": hex::encode(&b[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES]),
            "note_ct": hex::encode(&b[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES]),
        })
    };
    let page = serde_json::json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [{
        "height": 1, "index": 0, "tx_hash": hex::encode(Sha256::digest(&b)), "tx_type": "shield_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]), "outputs": [out(0), out(1)] }] });
    state.scan(&ListingPage::from_json(&page.to_string()).unwrap(), &keys.scan_key()).unwrap();
    assert_eq!(state.balance(), 5 * Q as u128);
    state
}

/// What a child prints: the body and the two `r` (the sender's secret record), by role.
fn line(tx: &UnprovenTx) -> String {
    let r_of = |role: OutputRole| tx.outputs.iter().find(|o| o.role == role).map(|o| hex::encode(o.r)).unwrap_or_default();
    format!("RW2|{}|{}|{}|{}", hex::encode(&tx.body), r_of(OutputRole::Payment), r_of(OutputRole::Change), r_of(OutputRole::Dummy))
}

/// NOT a test of its own: the child half of the tests below. Without the environment variable
/// (an ordinary test run) it does nothing.
#[test]
fn rw2_child_assembles_one_transaction_under_a_stuck_generator() {
    let Ok(scenario) = std::env::var(CHILD_ENV) else { return };
    let (alice, bob) = (ShieldedKeys::from_seed(&[0x31; 64]).unwrap(), ShieldedKeys::from_seed(&[0x32; 64]).unwrap());
    let state = funded(&alice);
    let ctx = |expiry: u64| TxContext { chain_id: "rw2".into(), anchor: state.anchor(), anchor_height: 50, expiry_height: expiry };
    let one = [state.spend_input_with(state.notes()[0].position, true).unwrap()];
    let to = bob.address();
    let transfer = |expiry: u64, amount: u64| {
        assemble_transfer(
            &TransferRequest { ctx: ctx(expiry), keys: &alice, inputs: &one, recipient: &to, amount, fee: Q, max_fee: None },
            Source::Hedged(&mut Stuck(0x2a)),
        )
        .unwrap()
    };
    let tx = match scenario.as_str() {
        // the payment, and the very same request again in a new process
        "pay" => transfer(100, 2 * Q),
        // the retry after expiry: the same note, recipient, amount and fee — a later expiry height
        "retry" => transfer(164, 2 * Q),
        // the same note and recipient, another amount, the same expiry
        "other-amount" => transfer(100, 3 * Q),
        // a shield has no spending key in the hedge
        "shield" => assemble_shield(
            &ShieldRequest { ctx: ctx(100), from_pub_key: &account(), nonce: 7, v_in: 3 * Q, fee: Q, recipient: &to, max_fee: None },
            Source::Hedged(&mut Stuck(0x2a)),
        )
        .unwrap(),
        _ => return,
    };
    println!("{}", line(&tx));
}

struct Made {
    body: Vec<u8>,
    r: Vec<String>,
}

impl Made {
    fn nf(&self, i: usize) -> &[u8] {
        &self.body[74 + 32 * i..106 + 32 * i]
    }
    fn cm(&self, j: usize) -> &[u8] {
        &self.body[138 + 32 * j..170 + 32 * j]
    }
    fn kem(&self, j: usize) -> &[u8] {
        &self.body[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES]
    }
    fn note(&self, j: usize) -> &[u8] {
        &self.body[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES]
    }
}

/// One transaction assembled by a fresh process (counter 0) under the stuck generator.
fn in_a_new_process(scenario: &str) -> Made {
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new(exe)
        .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, scenario)
        .output()
        .expect("the test binary runs itself");
    assert!(out.status.success(), "the child failed");
    let text = String::from_utf8_lossy(&out.stdout);
    let l = text.lines().find_map(|l| l.find("RW2|").map(|i| &l[i..])).expect("the child printed its transaction");
    let f: Vec<&str> = l.split('|').collect();
    Made { body: hex::decode(f[1]).unwrap(), r: f[2..].iter().filter(|r| !r.is_empty()).map(|r| r.to_string()).collect() }
}

/// F-5 across a restart, the case asked for explicitly.
///
/// * The SAME request in two processes gives the SAME 2,546 bytes: every value that enters the
///   body is in the hedge's transcript, so "the same context" is "the same transaction" — a
///   second copy of one transaction tells an observer and the payee nothing.
/// * The retry after expiry (same note, recipient, amount, fee; a later expiry height — which a
///   retry after expiry necessarily has) is a different context: no `r`, no encapsulation, no
///   note ciphertext, no commitment and no dummy nullifier is shared. What IS shared is the real
///   input's nullifier, which is inherent (it is what makes the two conflict) and tells an
///   observer that both spend one note.
/// * The same holds when only the amount differs.
///
/// Sound: passes.
#[test]
fn rw2_sound_f5_after_a_restart_the_same_request_is_the_same_transaction_and_a_retry_shares_nothing() {
    let (pay, again, retry, other) = (in_a_new_process("pay"), in_a_new_process("pay"), in_a_new_process("retry"), in_a_new_process("other-amount"));
    assert_eq!(pay.body, again.body, "counter 0, the same stuck generator, the same request: the same transaction, byte for byte");
    assert_eq!(pay.r, again.r);

    for (name, t) in [("the retry after expiry", &retry), ("another amount", &other)] {
        assert_eq!(pay.nf(0), t.nf(0), "{name}: the real input's nullifier is the note's (inherent)");
        assert_ne!(pay.nf(1), t.nf(1), "{name}: the dummy input's nullifier repeated");
        let mut seen = std::collections::BTreeSet::new();
        for m in [&pay, t] {
            for j in 0..2 {
                assert!(seen.insert(m.cm(j).to_vec()), "{name}: a commitment repeated");
                assert!(seen.insert(m.kem(j).to_vec()), "{name}: an ML-KEM encapsulation (so its randomness) repeated");
                assert!(seen.insert(m.note(j).to_vec()), "{name}: a note ciphertext repeated");
            }
            for r in &m.r {
                assert!(seen.insert(r.as_bytes().to_vec()), "{name}: an r repeated");
            }
        }
    }
}

/// The limit the notes state, made concrete (Info): a shield's hedge has no secret in it. Under a
/// generator stuck on a value an observer knows, the whole body of a shield is a function of
/// public values and the recipient's ADDRESS — two processes produce the same bytes — so anybody
/// who holds an address (every payer does) can rebuild the body for it and learn whether a shield
/// on chain went to that address. With a working generator a shield's recipient is hidden even
/// from those who know the address. Passes: it asserts what the code does.
#[test]
fn rw2_info_f5_a_shield_under_a_known_stuck_generator_is_a_function_of_public_values_and_the_address() {
    let (a, b) = (in_a_new_process("shield"), in_a_new_process("shield"));
    assert_eq!(a.body, b.body);
}
