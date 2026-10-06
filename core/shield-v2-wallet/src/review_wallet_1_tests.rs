//! REVIEW_WALLET_1 — in-crate tests: they need the crate-private entropy trait to model a broken
//! operating-system generator, which no caller of the crate can inject. See `REVIEW_WALLET_1.md`.
//!
//! On the reviewed commit the two `rw1_demo_f5_…` tests showed what a generator that repeats did
//! to the parts of a transaction that the prover's hedge did not cover. They are regression tests
//! now (`rw1_f5_…`): the same injected generator, and the leak is gone.

use super::*;
use crate::body::{OFF_KEM, OFF_NOTE};
use crate::entropy::DeterministicEntropy;
use fips203::traits::{Decaps, SerDes};
use sha2::{Digest as _, Sha256};
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
            serde_json::json!({ "height": 1 + i, "index": 0, "tx_hash": hex::encode(Sha256::digest(b)), "tx_type": "shield_v2",
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
    let ctx0 = TxContext { chain_id: "rw1".into(), anchor: state.anchor(), anchor_height: 50, expiry_height: 100 };
    let bodies: Vec<Vec<u8>> = [5 * Q, 3 * Q]
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let req = ShieldRequest { ctx: ctx0.clone(), from_pub_key: &account, nonce: i as u64, v_in: v + Q, fee: Q, recipient: &keys.address(), max_fee: None };
            assemble_shield(&req, Source::Stream(&mut DeterministicEntropy::new(&format!("rw1-stuck-{i}")))).unwrap().body
        })
        .collect();
    state.scan(&listing(&bodies), &keys.scan_key()).unwrap();
    assert_eq!(state.balance(), 8 * Q as u128);
    let ctx = TxContext { chain_id: "rw1".into(), anchor: state.anchor(), anchor_height: 50, expiry_height: 100 };
    (state, ctx)
}

/// The two ML-KEM shared secrets of a transaction's outputs, as their recipient derives them.
fn shared_secrets(keys: &ShieldedKeys, body: &[u8]) -> [[u8; 32]; 2] {
    let dk = keys.scan_key().decaps_key().unwrap();
    core::array::from_fn(|j| {
        let ct: [u8; KEM_CT_BYTES] = body[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES].try_into().unwrap();
        dk.try_decaps(&fips203::ml_kem_768::CipherText::try_from_bytes(ct).unwrap()).unwrap().into_bytes()
    })
}

/// F-5 (Low). The prover hedges its blinding seed against a generator that repeats (spec §5.6
/// item 4, W-7). On the reviewed commit the builder hedged nothing: with such a generator a
/// payment to the wallet's own address (a self-merge, `plan_merge`) encapsulated twice to the
/// same `ek` with the same randomness — ONE AES-256-GCM key, the fixed zero nonce, two messages —
/// and anybody who read the chain learned `value_1 XOR value_2`; and `r` was the same for every
/// output the wallet ever made.
///
/// Since the fix every random value of a transaction is a labelled draw of one hedged generator
/// (`entropy.rs`). Under the SAME injected generator, stuck on one byte for ever: the two notes of
/// a self-payment get different ML-KEM secrets and different `r`, the ciphertexts no longer XOR
/// to the values, and nothing repeats from one transaction to the next.
#[test]
fn rw1_f5_a_repeating_generator_no_longer_reuses_the_note_key_or_r() {
    let keys = ShieldedKeys::from_seed(&[0x31; 64]).unwrap();
    let (state, ctx) = funded(&keys);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let own = keys.address();
    let (amount, fee) = (4 * Q, Q);
    let req = TransferRequest { ctx, keys: &keys, inputs: &inputs, recipient: &own, amount, fee, max_fee: None };
    let tx = assemble_transfer(&req, Source::Hedged(&mut Stuck(0x2a))).expect("a stuck generator is not detected — it is hedged");
    let b = &tx.body;
    let kem = |b: &[u8], j: usize| b[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES].to_vec();
    let ct = |b: &[u8], j: usize| b[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES].to_vec();
    // two encapsulations to the same key: different randomness, different secrets, different keys
    assert_ne!(kem(b, 0), kem(b, 1), "the two notes have their own encapsulation");
    let ss = shared_secrets(&keys, b);
    assert_ne!(ss[0], ss[1], "and so their own ML-KEM secret (one AES key per note)");
    assert_ne!(tx.outputs[0].r, tx.outputs[1].r, "and their own r");
    // what a chain observer computes from public bytes alone is no longer the values
    let xor: Vec<u8> = ct(b, 0)[..40].iter().zip(&ct(b, 1)[..40]).map(|(x, y)| x ^ y).collect();
    let change = 8 * Q - amount - fee;
    assert_ne!(u64::from_le_bytes(xor[..8].try_into().unwrap()), amount ^ change, "value_1 XOR value_2 is not public");
    assert!(xor[8..].iter().any(|&x| x != 0));
    // both notes still open for the wallet
    let mut after = state.clone();
    let outs = [0usize, 1]
        .map(|j| serde_json::json!({ "cm_out": hex::encode(&b[138 + 32 * j..170 + 32 * j]), "leaf": 4 + j, "kem_ct": hex::encode(kem(b, j)), "note_ct": hex::encode(ct(b, j)) }));
    let page = serde_json::json!({ "active": true, "tip_height": 3, "from_height": 3, "next_height": 4, "txs": [{
        "height": 3, "index": 0, "tx_hash": hex::encode(Sha256::digest(b)), "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(&b[74..106]), "nf2": hex::encode(&b[106..138]),
        "outputs": outs,
    }] });
    after.scan(&ListingPage::from_json(&page.to_string()).unwrap(), &keys.scan_key()).unwrap();
    assert_eq!(after.balance(), 7 * Q as u128);

    // the same request again under the same stuck generator: nothing repeats across transactions
    // (the counter), and a different request differs too (the transcript)
    let again = assemble_transfer(&req, Source::Hedged(&mut Stuck(0x2a))).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for t in [&tx, &again] {
        for j in 0..2 {
            assert!(seen.insert(t.outputs[j].r.to_vec()), "an r repeated");
            assert!(seen.insert(kem(&t.body, j)), "an encapsulation repeated");
        }
        for s in shared_secrets(&keys, &t.body) {
            assert!(seen.insert(s.to_vec()), "an ML-KEM secret repeated");
        }
    }
}

/// The same generator and a payment to SOMEBODY ELSE. On the reviewed commit `r` — exactly what
/// the payee is given — was also the `r` of the sender's change, so the payee could confirm
/// guesses of the change value (`pk` = the sender's address, `rho` public) against the other
/// commitment. Now the payee's `r` says nothing about the change, and a one-input transaction's
/// dummy nullifier does not repeat either (it used to make the node refuse the second one).
#[test]
fn rw1_f5_a_repeating_generator_no_longer_gives_the_payee_the_r_of_the_change_note() {
    let (alice, bob) = (ShieldedKeys::from_seed(&[0x31; 64]).unwrap(), ShieldedKeys::from_seed(&[0x32; 64]).unwrap());
    let (state, ctx) = funded(&alice);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let to = bob.address();
    let req = TransferRequest { ctx: ctx.clone(), keys: &alice, inputs: &inputs, recipient: &to, amount: 4 * Q, fee: Q, max_fee: None };
    let tx = assemble_transfer(&req, Source::Hedged(&mut Stuck(0x2a))).unwrap();
    let pay = tx.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
    let change = tx.outputs.iter().find(|o| o.role == OutputRole::Change).unwrap();
    assert_ne!(pay.r, change.r);
    // Bob: knows pay.r (delivered), Alice's pk (her address), the public nullifiers — and can no
    // longer confirm the change value with them
    let nf = [field::digest(&tx.body[74..106].try_into().unwrap(), "nf").unwrap(), field::digest(&tx.body[106..138].try_into().unwrap(), "nf").unwrap()];
    let guess = |value: u64, r: &[u8; 32]| {
        let cm = Note { value, pk: field::digest(&alice.address().pk, "pk").unwrap(), rho: derive_rho(&nf, change.slot), r: field::digest(r, "r").unwrap() }
            .commitment();
        field::bytes(&cm) == change.cm
    };
    assert!(!guess(3 * Q, &pay.r), "the payee's r does not open the sender's change");
    assert!(guess(3 * Q, &change.r), "(the sender's own record does)");

    // one input and a dummy: the dummy's nullifier, the dummy output's key and the slot order are
    // hedged draws too — two transactions under the stuck generator share no nullifier
    let one = [state.spend_input(state.notes()[0].position).unwrap()];
    let account: Vec<u8> = (0..1_952u32).map(|i| i as u8).collect();
    let mut nullifiers = std::collections::BTreeSet::new();
    let mut orders = std::collections::BTreeSet::new();
    for i in 0..24u64 {
        let u = assemble_unshield(
            &UnshieldRequest { ctx: ctx.clone(), keys: &alice, inputs: &one, to_account: [7; 32], v_out: Q, fee: Q, max_fee: None },
            Source::Hedged(&mut Stuck(0x2a)),
        )
        .unwrap();
        assert!(nullifiers.insert(u.body[106..138].to_vec()), "a dummy nullifier repeated");
        orders.insert(u.outputs[0].role == OutputRole::Change);
        let s = assemble_shield(
            &ShieldRequest { ctx: ctx.clone(), from_pub_key: &account, nonce: i, v_in: 3 * Q, fee: Q, recipient: &to, max_fee: None },
            Source::Hedged(&mut Stuck(0x2a)),
        )
        .unwrap();
        assert!(nullifiers.insert(s.body[74..106].to_vec()) && nullifiers.insert(s.body[106..138].to_vec()));
    }
    assert_eq!(orders.len(), 2, "the slot order still varies under a stuck generator");
    // and a generator that FAILS is still an error, never a silent fallback to the hedge's other inputs
    assert!(matches!(assemble_transfer(&req, Source::Hedged(&mut crate::entropy::FailingEntropy)), Err(WalletError::Entropy(_))));
}

/// What the generator's failure does NOT break, for the record: with working entropy two
/// assemblies of one request share no `r`, no ciphertext and no slot-order dependence.
#[test]
fn rw1_sound_working_entropy_never_repeats_r_or_encapsulations() {
    let keys = ShieldedKeys::from_seed(&[0x31; 64]).unwrap();
    let (state, ctx) = funded(&keys);
    let inputs: Vec<SpendInput> = state.notes().iter().map(|n| state.spend_input(n.position).unwrap()).collect();
    let own = keys.address();
    let req = TransferRequest { ctx, keys: &keys, inputs: &inputs, recipient: &own, amount: 4 * Q, fee: Q, max_fee: None };
    let mut seen_r = std::collections::BTreeSet::new();
    let mut seen_kem = std::collections::BTreeSet::new();
    for _ in 0..8 {
        let tx = assemble_transfer(&req, Source::Hedged(&mut OsEntropy)).unwrap();
        for j in 0..2 {
            assert!(seen_r.insert(tx.outputs[j].r));
            assert!(seen_kem.insert(tx.body[OFF_KEM[j]..OFF_KEM[j] + 64].to_vec()));
        }
    }
}
