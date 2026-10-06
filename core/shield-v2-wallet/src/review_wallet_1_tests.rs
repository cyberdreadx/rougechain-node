//! REVIEW_WALLET_1 — in-crate tests: they need the crate-private entropy trait to model a broken
//! operating-system generator, which no caller of the crate can inject. See `REVIEW_WALLET_1.md`.
//!
//! `rw1_demo_…` tests pass on the reviewed commit: they show what a generator that repeats does to
//! the parts of a transaction that are NOT covered by the prover's hedge (spec §5.6 item 4).

use super::*;
use crate::body::{OFF_KEM, OFF_NOTE};
use crate::entropy::DeterministicEntropy;
use crate::keys::KEM_CT_BYTES;
use crate::note_enc::NOTE_CT_BYTES;
use crate::store::{ListingPage, WalletState};

const Q: u64 = 1_000_000_000;

/// A generator that "works" and returns the same byte for ever (not zero: the all-zero check of
/// `OsEntropy` and of the prover would not notice it either).
struct Stuck(u8);

impl Entropy for Stuck {
    fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
        b.fill(self.0);
        Ok(())
    }
}

fn listing(bodies: &[Vec<u8>]) -> ListingPage {
    let txs: Vec<serde_json::Value> = bodies
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let out = |j: usize| {
                serde_json::json!({
                    "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": 2 * i + j,
                    "kem_ct": hex::encode(&b[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES]),
                    "note_ct": hex::encode(&b[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES]),
                })
            };
            serde_json::json!({ "height": 1 + i, "index": 0, "tx_hash": "", "tx_type": "shield_v2",
                "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]), "outputs": [out(0), out(1)] })
        })
        .collect();
    let page = serde_json::json!({ "active": true, "tip_height": bodies.len(), "from_height": 1, "next_height": bodies.len() + 1, "txs": txs });
    ListingPage::from_json(&page.to_string()).unwrap()
}

/// A wallet with two notes (5 and 3 XRGE), made with working randomness.
fn funded(keys: &ShieldedKeys) -> (WalletState, TxContext) {
    let account: Vec<u8> = (0..1_952u32).map(|i| i as u8).collect();
    let mut state = WalletState::new(keys.address().pk);
    let ctx0 = TxContext { chain_id: "rw1".into(), anchor: state.anchor(), expiry_height: 100 };
    let bodies: Vec<Vec<u8>> = [5 * Q, 3 * Q]
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let req = ShieldRequest { ctx: ctx0.clone(), from_pub_key: &account, nonce: i as u64, v_in: v + Q, fee: Q, recipient: &keys.address() };
            assemble_shield(&req, &mut DeterministicEntropy::new(&format!("rw1-stuck-{i}"))).unwrap().body
        })
        .collect();
    state.scan(&listing(&bodies), &keys.scan_key()).unwrap();
    assert_eq!(state.balance(), 8 * Q as u128);
    let ctx = TxContext { chain_id: "rw1".into(), anchor: state.anchor(), expiry_height: 100 };
    (state, ctx)
}

/// F-5 (Low). The prover hedges its blinding seed against a generator that repeats (spec §5.6
/// item 4, W-7). The builder hedges nothing: with the same generator, the commitment randomness
/// `r` of every output and the ML-KEM encapsulation randomness of every output repeat.
///
/// For a payment to the wallet's own address (a self-merge, `plan_merge`) both outputs go to the
/// same `ek`, so both encapsulations are identical, both notes are encrypted under ONE AES-256-GCM
/// key with the SAME (zero) nonce — spec §3.4's "the key is used for one message" no longer holds —
/// and anybody who reads the chain learns `value_1 XOR value_2` from the two ciphertexts.
#[test]
fn rw1_demo_f5_a_repeating_generator_reuses_the_note_key_inside_one_transaction() {
    let keys = ShieldedKeys::from_seed(&[0x31; 64]).unwrap();
    let (state, ctx) = funded(&keys);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let own = keys.address();
    let (amount, fee) = (4 * Q, Q);
    let req = TransferRequest { ctx, keys: &keys, inputs: &inputs, recipient: &own, amount, fee };
    let tx = assemble_transfer(&req, &mut Stuck(0x2a)).expect("a stuck generator is not detected");
    let b = &tx.body;
    let kem = |j: usize| &b[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES];
    let ct = |j: usize| &b[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES];
    assert_eq!(kem(0), kem(1), "one encapsulation for two notes: the same key, and the nonce is fixed");
    // what a chain observer computes from public bytes alone
    let xor: Vec<u8> = ct(0)[..40].iter().zip(&ct(1)[..40]).map(|(x, y)| x ^ y).collect();
    let leaked = u64::from_le_bytes(xor[..8].try_into().unwrap());
    let change = 8 * Q - amount - fee;
    assert_eq!(leaked, amount ^ change, "value_1 XOR value_2 is public");
    assert!(xor[8..].iter().all(|&x| x == 0), "and so is the fact that both notes have the same r");
    // r repeats across the outputs (and across every transaction this generator ever feeds)
    assert_eq!(tx.outputs[0].r, tx.outputs[1].r);
    let again = assemble_transfer(&req, &mut Stuck(0x2a)).unwrap();
    assert_eq!(again.outputs[0].r, tx.outputs[0].r, "the recipient of any one note of this wallet knows the r of all its notes");
}

/// The same generator and a payment to SOMEBODY ELSE: the two encapsulations go to different
/// keys, so the note keys differ — but `r` still repeats, and `r` is exactly what the payee is
/// given. The payee can then test guesses of the sender's change (`pk` = the sender's address,
/// which a payee often knows; `rho` is public) against the other commitment.
#[test]
fn rw1_demo_f5_a_repeating_generator_gives_the_payee_the_r_of_the_change_note() {
    let (alice, bob) = (ShieldedKeys::from_seed(&[0x31; 64]).unwrap(), ShieldedKeys::from_seed(&[0x32; 64]).unwrap());
    let (state, ctx) = funded(&alice);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let to = bob.address();
    let req = TransferRequest { ctx, keys: &alice, inputs: &inputs, recipient: &to, amount: 4 * Q, fee: Q };
    let tx = assemble_transfer(&req, &mut Stuck(0x2a)).unwrap();
    let pay = tx.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
    let change = tx.outputs.iter().find(|o| o.role == OutputRole::Change).unwrap();
    assert_ne!(&tx.body[OFF_KEM[0]..OFF_KEM[0] + KEM_CT_BYTES], &tx.body[OFF_KEM[1]..OFF_KEM[1] + KEM_CT_BYTES]);
    assert_eq!(pay.r, change.r);
    // Bob: knows pay.r (delivered), Alice's pk (her address), the public nullifiers → confirms a
    // guess of the change value against the public commitment
    let nf = [field::digest(&tx.body[74..106].try_into().unwrap(), "nf").unwrap(), field::digest(&tx.body[106..138].try_into().unwrap(), "nf").unwrap()];
    let guess = |value: u64| {
        let cm = Note { value, pk: field::digest(&alice.address().pk, "pk").unwrap(), rho: derive_rho(&nf, change.slot), r: field::digest(&pay.r, "r").unwrap() }
            .commitment();
        field::bytes(&cm) == change.cm
    };
    assert!(guess(3 * Q), "the payee confirmed the sender's change (and so her balance after the payment)");
    assert!(!guess(3 * Q + 1));
}

/// What the generator's failure does NOT break, for the record: with working entropy two
/// assemblies of one request share no `r`, no ciphertext and no slot-order dependence.
#[test]
fn rw1_sound_working_entropy_never_repeats_r_or_encapsulations() {
    let keys = ShieldedKeys::from_seed(&[0x31; 64]).unwrap();
    let (state, ctx) = funded(&keys);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let own = keys.address();
    let req = TransferRequest { ctx, keys: &keys, inputs: &inputs, recipient: &own, amount: 4 * Q, fee: Q };
    let mut seen_r = std::collections::BTreeSet::new();
    let mut seen_kem = std::collections::BTreeSet::new();
    for _ in 0..8 {
        let tx = assemble_transfer(&req, &mut OsEntropy).unwrap();
        for j in 0..2 {
            assert!(seen_r.insert(tx.outputs[j].r));
            assert!(seen_kem.insert(tx.body[OFF_KEM[j]..OFF_KEM[j] + 64].to_vec()));
        }
    }
}
