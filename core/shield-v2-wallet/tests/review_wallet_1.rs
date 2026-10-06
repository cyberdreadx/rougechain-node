//! REVIEW_WALLET_1 — independent adversarial review of the wallet core (see `REVIEW_WALLET_1.md`).
//!
//! Two kinds of test live here:
//!
//! * `rw1_fN_…` — **regression tests of confirmed defects. They FAIL on the reviewed commit
//!   (abab9a8) on purpose** and must pass once the defect is fixed. The finding number is the one
//!   in the report.
//! * `rw1_demo_…` / `rw1_sound_…` — pass on the reviewed commit. A `demo` shows a limit of the
//!   design (nothing in this crate can fix it alone; the report says who has to); a `sound` test
//!   is an attack that was tried and does not work.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like `wallet_flow.rs`.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, Note, MODULUS};
use quantum_vault_shield_v2::verify_spend;
use quantum_vault_shield_v2_wallet::body::public_inputs_of;
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;

fn shield_req<'a>(chain: &Chain, key: &'a [u8], to: &'a ShieldedAddress, v_in: u64) -> ShieldRequest<'a> {
    ShieldRequest { ctx: chain.ctx(), from_pub_key: key, nonce: 1, v_in, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to }
}

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let tx = deterministic::shield(&shield_req(chain, &key, to, v + Q), &format!("rw1-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
    s.scan(&chain.page(s.next_height()), &keys.scan_key()).unwrap();
    assert_eq!(s.anchor(), chain.state().tree_root);
    s
}

fn page_json(page: &ListingPage) -> serde_json::Value {
    serde_json::json!({
        "active": page.active, "tip_height": page.tip_height, "from_height": page.from_height, "next_height": page.next_height,
        "txs": page.txs.iter().map(|t| serde_json::json!({
            "height": t.height, "index": t.index, "tx_hash": t.tx_hash, "tx_type": t.tx_type, "nf1": t.nf1, "nf2": t.nf2,
            "outputs": t.outputs.iter().map(|o| serde_json::json!({ "cm_out": o.cm_out, "leaf": o.leaf, "kem_ct": o.kem_ct, "note_ct": o.note_ct })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

/// A canonical digest from a tag (every 4-byte word < p).
fn digest_bytes(tag: u8) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (i, w) in b.chunks_mut(4).enumerate() {
        w.copy_from_slice(&((tag as u32 * 0x0101_0101 + i as u32 * 7919) % MODULUS).to_le_bytes());
    }
    b
}

// ---------------------------------------------------------------------------------------------------
// F-1 (Medium) — a node that knows a wallet's ADDRESS can make it show money that does not exist
// ---------------------------------------------------------------------------------------------------

/// NOTES.md §6 item 4 says "A listing from a hostile node can hide notes but cannot forge them
/// (every note is authenticated against its commitment)". The commitment the note is checked
/// against comes from the same listing. Whoever serves the listing and knows the wallet's public
/// address (`pk`, `ek` — every payer has it) can list a transaction that was never mined: the
/// wallet accepts the note, counts it in its balance, selects it and builds a spend from it. The
/// root comparison the notes prescribe does not help: the liar reports the root of the tree it
/// made the wallet build.
///
/// Nothing but the address is used below — no key of the victim.
#[test]
fn rw1_demo_f1_a_lying_node_forges_an_incoming_note_from_the_public_address() {
    let alice = keys(PHRASE_1);
    let address = alice.address(); // public
    let pk = digest_from_bytes(&address.pk).unwrap();

    // the "node" invents a transaction: any two nullifiers, any value
    let (nf1, nf2) = (digest_bytes(1), digest_bytes(2));
    let nf = [digest_from_bytes(&nf1).unwrap(), digest_from_bytes(&nf2).unwrap()];
    let value = 1_000_000 * Q; // the whole pool cap
    let r = digest_bytes(3);
    let cm = digest_to_bytes(&Note { value, pk, rho: derive_rho(&nf, 0), r: digest_from_bytes(&r).unwrap() }.commitment());
    let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&address.ek, &cm, value, &r, [9u8; 32]).unwrap();
    let page = serde_json::json!({ "active": true, "tip_height": 10, "from_height": 3, "next_height": 11, "txs": [{
        "height": 5, "index": 0, "tx_hash": "00".repeat(32), "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(nf1), "nf2": hex::encode(nf2),
        "outputs": [
            { "cm_out": hex::encode(cm), "leaf": 0, "kem_ct": hex::encode(kem_ct), "note_ct": hex::encode(note_ct) },
            { "cm_out": hex::encode(digest_bytes(4)), "leaf": 1, "kem_ct": "00".repeat(1088), "note_ct": "00".repeat(56) },
        ],
    }] });

    let mut wallet = WalletState::new(address.pk);
    let report = wallet.scan(&ListingPage::from_json(&page.to_string()).unwrap(), &alice.scan_key()).unwrap();
    assert_eq!(report.received, vec![0], "the wallet took the invented note for its own");
    assert_eq!(wallet.balance(), value as u128, "and shows a balance that exists on no chain");
    // the liar's `latest_anchor` is simply the wallet's own root: the prescribed comparison passes
    let lying_latest_anchor = wallet.anchor();
    // … and the wallet plans and assembles a payment out of it without complaint
    let sel = select_inputs(&wallet, 5 * Q, Q).unwrap();
    let inputs: Vec<SpendInput> = sel.positions.iter().map(|&p| wallet.spend_input(p).unwrap()).collect();
    let ctx = TxContext { chain_id: CHAIN.into(), anchor: lying_latest_anchor, expiry_height: 100 };
    let bob = keys(PHRASE_2).address();
    deterministic::transfer(&TransferRequest { ctx, keys: &alice, inputs: &inputs, recipient: &bob, amount: 5 * Q, fee: Q }, "rw1-f1")
        .expect("the builder has no way to know the note is not on the chain");
}

// ---------------------------------------------------------------------------------------------------
// F-7 (Medium) — "release on rejection": a node that lies about a rejection gets the payee paid twice
// ---------------------------------------------------------------------------------------------------

/// NOTES.md §6 item 7 tells the UI to "mark inputs pending on submit, release on expiry or
/// rejection", and `unmark_pending` releases unconditionally: the state keeps neither the pending
/// transaction's nullifiers nor its `expiry_height`. A signer-less transaction that was handed to
/// a node stays valid until its expiry height / anchor window passes, whatever the node answered.
/// If the retry spends a DIFFERENT note, both transactions are valid together.
///
/// Scenario: Alice holds one 10 XRGE note and pays Bob 4. The node answers "rejected" and keeps
/// the transaction. Bob (who runs or bribes the node) sends Alice 5 XRGE. Alice's wallet releases
/// the 10 note, and the retry's coin selection now prefers the new 5 note (the smallest that
/// covers 4 + fee). The node mines both. Bob is paid twice.
#[test]
fn rw1_demo_f7_releasing_inputs_on_a_claimed_rejection_lets_both_payments_be_mined() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    fund(&mut chain, &bob.address(), &[6 * Q]);
    let mut a = synced(&chain, &alice);
    let pay = |a: &WalletState, chain: &Chain, label: &str| {
        let sel = select_inputs(a, 4 * Q, Q).unwrap();
        let inputs: Vec<SpendInput> = sel.positions.iter().map(|&p| a.spend_input(p).unwrap()).collect();
        let tx = deterministic::transfer(
            &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 4 * Q, fee: Q },
            label,
        )
        .unwrap();
        (sel.positions, tx)
    };
    // first attempt: submitted, inputs marked pending
    let (spent1, t1) = pay(&a, &chain, "rw1-f7-first");
    assert!(spent1.iter().all(|&p| a.mark_pending_spent(p)));
    // the node says "rejected" (it is not: it keeps t1); the UI releases the inputs as NOTES.md says
    assert!(spent1.iter().all(|&p| a.unmark_pending(p)), "nothing in the core objects: the state knows no pending transaction");
    // Bob sends Alice a 5 XRGE note
    let b = synced(&chain, &bob);
    let b_in = [b.spend_input(b.notes()[0].position).unwrap()];
    let gift = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &bob, inputs: &b_in, recipient: &alice.address(), amount: 5 * Q, fee: Q },
        "rw1-f7-gift",
    )
    .unwrap();
    chain.block(&[&gift.body]).unwrap();
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.balance(), 15 * Q as u128);
    // the retry: same payment, other note
    let (spent2, t2) = pay(&a, &chain, "rw1-f7-retry");
    assert_ne!(spent1, spent2, "coin selection moved to the new, smaller note");
    // the node mines the retry AND the transaction it claimed to have rejected
    chain.block(&[&t2.body]).expect("the retry is valid");
    chain.block(&[&t1.body]).expect("and so, still, is the first attempt: its anchor is in the window and its notes are unspent");
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.balance(), 5 * Q as u128, "Alice meant to end with 10 XRGE (15 - 4 - fee); she has 5");
    assert_eq!(synced(&chain, &bob).balance(), 8 * Q as u128, "Bob holds both payments");
}

// ---------------------------------------------------------------------------------------------------
// F-2 (Low) — bech32m beyond its design length: two changed characters are accepted
// ---------------------------------------------------------------------------------------------------

/// The BIP-350 checksum is a BCH code of length 1,023 symbols. Beyond that length the generator
/// divides x^1023 + 1, so the SAME change applied to two characters exactly 1,023 places apart is
/// invisible to the checksum — at 1,960 characters about half of an address has such a partner.
/// The decoder then returns a different, fully valid shielded address (canonical `pk`, valid
/// ML-KEM key): a payment to it is unrecoverable, because the `ek` (or the `pk`) is no longer the
/// recipient's.
///
/// FAILS on abab9a8: such a pair is found and accepted.
#[test]
fn rw1_f2_two_changed_characters_1023_apart_must_not_decode_to_another_address() {
    const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let good = keys(PHRASE_1).address();
    let s = good.encode().into_bytes();
    let data0 = "rshield1".len();
    let val = |c: u8| CHARSET.iter().position(|&x| x == c).unwrap() as u8;
    let mut accepted = None;
    'search: for i in (data0 + 60)..(data0 + 900) {
        for e in 1u8..32 {
            let mut t = s.clone();
            t[i] = CHARSET[(val(t[i]) ^ e) as usize];
            t[i + 1023] = CHARSET[(val(t[i + 1023]) ^ e) as usize];
            if let Ok(other) = ShieldedAddress::decode(std::str::from_utf8(&t).unwrap()) {
                accepted = Some((i, e, other));
                break 'search;
            }
        }
    }
    if let Some((i, e, other)) = &accepted {
        assert_ne!(*other, good);
        panic!(
            "characters {i} and {} changed by the same value {e}: the checksum still matches and the string decodes to another valid address \
             (fingerprint {} instead of {})",
            i + 1023,
            other.fingerprint(),
            good.fingerprint()
        );
    }
}

/// What the 30-bit checksum does still give at this length, measured: every single changed
/// character is caught (all 1,952 positions × 31 values would be the proof; a spread is tried),
/// truncation and extension are caught by the length rule, mixed case is refused.
#[test]
fn rw1_sound_single_character_errors_truncation_and_mixed_case_are_refused() {
    const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let good = keys(PHRASE_1).address();
    let s = good.encode();
    let b = s.as_bytes();
    for i in (8..b.len()).step_by(7) {
        for e in [1usize, 13, 31] {
            let mut t = b.to_vec();
            let v = CHARSET.iter().position(|&x| x == t[i]).unwrap();
            t[i] = CHARSET[v ^ e];
            assert!(ShieldedAddress::decode(std::str::from_utf8(&t).unwrap()).is_err(), "position {i}");
        }
    }
    for cut in [1usize, 2, 6, 7, 100, 1023] {
        assert!(ShieldedAddress::decode(&s[..s.len() - cut]).is_err());
        assert!(ShieldedAddress::decode(&s[cut.min(8)..]).is_err());
    }
    assert!(ShieldedAddress::decode(&format!("{s}q")).is_err());
    assert!(ShieldedAddress::decode(&format!("{s}{}", &s[8..])).is_err());
    let mut mixed = s.clone().into_bytes();
    mixed[20] = mixed[20].to_ascii_uppercase();
    mixed[21] = b'Q';
    assert!(ShieldedAddress::decode(std::str::from_utf8(&mixed).unwrap()).is_err());
    assert_eq!(ShieldedAddress::decode(&s.to_ascii_uppercase()).unwrap(), good);
    // an account address parser does not take a shielded address, an empty or absurd string
    for junk in ["", "1", "rouge1", "rshield1", &"1".repeat(5000), &"q".repeat(5000), "rshield1\u{0}"] {
        assert!(ShieldedAddress::decode(junk).is_err());
        assert!(account_from_address(junk).is_err());
    }
}

// ---------------------------------------------------------------------------------------------------
// F-3 (Low) — a state scanned partly with the viewing key never learns its notes were spent
// ---------------------------------------------------------------------------------------------------

/// `scan` takes the key per call and the state does not remember which kind scanned it. A note
/// found while scanning with the viewing key alone (`nk = None`, the "background worker /
/// auditor" key of `export_scan_key(seed, false)`) is stored with `nullifier: None`, and nothing
/// ever fills it in: when the owner later scans the same state with the full key and the note is
/// spent on chain, the note stays unspent. The wallet shows a balance it does not have and keeps
/// selecting a spent note (the node then refuses the transaction).
///
/// FAILS on abab9a8: the balance stays 5 XRGE after the note was spent.
#[test]
fn rw1_f3_a_note_found_with_the_viewing_key_must_be_seen_spent_by_the_full_key() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q]);

    // page 1: scanned by a background worker that holds the viewing key only
    let mut shared = WalletState::new(alice.address().pk);
    shared.scan(&chain.page(shared.next_height()), &alice.incoming_viewing_key()).unwrap();
    assert_eq!(shared.balance(), 5 * Q as u128);

    // the owner spends the note (from a fully scanned state) …
    let full = synced(&chain, &alice);
    let inputs = [full.spend_input(full.notes()[0].position).unwrap()];
    let t = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 4 * Q, fee: Q },
        "rw1-f3",
    )
    .unwrap();
    chain.block(&[&t.body]).unwrap();

    // … and the shared state is continued with the FULL key
    shared.scan(&chain.page(shared.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(shared.anchor(), chain.state().tree_root, "the tree is right");
    assert_eq!(
        shared.balance(),
        0,
        "the 5 XRGE note was spent on chain, but the state scanned it without nk and never marks it spent"
    );
}

// ---------------------------------------------------------------------------------------------------
// F-4 (Low) — `tx_hash` from the listing is stored and returned unvalidated
// ---------------------------------------------------------------------------------------------------

/// Every other listing field is strict lowercase hexadecimal of a fixed length. `tx_hash` is an
/// arbitrary string of arbitrary length that the node chooses; it is copied into the persistent
/// state for each of the wallet's notes and handed back to the UI by `summary`. A hostile node
/// can plant markup for a UI that renders it, or megabytes per note.
///
/// FAILS on abab9a8: the string is stored verbatim.
#[test]
fn rw1_f4_a_listed_tx_hash_that_is_not_a_hash_must_not_reach_the_stored_state() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[2 * Q]);
    let mut v = page_json(&chain.page(0));
    let planted = format!("<img src=x onerror=alert(1)>{}", "A".repeat(100_000));
    v["txs"][0]["tx_hash"] = serde_json::json!(planted);
    let mut s = WalletState::new(alice.address().pk);
    let outcome = s.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key());
    let stored = s.to_json().unwrap();
    assert!(
        outcome.is_err() || !stored.contains("onerror"),
        "a {}-byte non-hexadecimal tx_hash from the node was stored in the wallet state ({} bytes of state)",
        planted.len(),
        stored.len()
    );
}

// ---------------------------------------------------------------------------------------------------
// Attacks that do not work
// ---------------------------------------------------------------------------------------------------

/// Spec §3.4 / §5.5: a relay or a node must not be able to change anything of a signer-less
/// transaction. One real proof (an unshield: it uses `account`, `v_out` and `fee`), then EVERY
/// byte of the 2,546-byte body is changed in turn: the body no longer parses, or the proof no
/// longer verifies for it. Covers the chain tag, the expiry, the anchor, both nullifiers, both
/// commitments, the three amounts, the recipient account, and all four ciphertexts.
#[test]
fn rw1_sound_every_byte_of_the_body_is_bound_by_the_proof() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[9 * Q]);
    let a = synced(&chain, &alice);
    let inputs = [a.spend_input(a.notes()[0].position).unwrap()];
    let u = build_unshield(&UnshieldRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, to_account: [0x42; 32], v_out: 6 * Q, fee: Q }).unwrap();
    verify_spend(&public_inputs_of(&u.body).unwrap(), &u.proof).expect("the untouched transaction verifies");
    assert_eq!(u.body.len(), BODY_BYTES);
    let mut unbound = Vec::new();
    for i in 0..BODY_BYTES {
        let mut b = u.body.clone();
        b[i] ^= 1 << (i % 8);
        let still_valid = Body::decode(&b).is_ok() && public_inputs_of(&b).is_ok_and(|pi| verify_spend(&pi, &u.proof).is_ok());
        if still_valid {
            unbound.push(i);
        }
    }
    assert!(unbound.is_empty(), "body bytes a relay could change without invalidating the proof: {unbound:?}");
    // the fields a relay would want most, changed to a meaningful value rather than one bit
    let swap = |from: usize, with: &[u8]| {
        let mut b = u.body.clone();
        b[from..from + with.len()].copy_from_slice(with);
        public_inputs_of(&b).is_ok_and(|pi| verify_spend(&pi, &u.proof).is_ok())
    };
    assert!(!swap(226, &[0x66; 32]), "the unshield's recipient account");
    assert!(!swap(218, &(2 * Q).to_le_bytes()), "the fee");
    assert!(!swap(210, &(7 * Q).to_le_bytes()), "v_out");
    assert!(!swap(34, &u64::MAX.to_le_bytes()), "the expiry height");
    let (k1, k2) = (u.body[258..1346].to_vec(), u.body[1402..2490].to_vec());
    assert!(!swap(258, &k2) && !swap(1402, &k1), "the ciphertexts cannot even be swapped between the slots");
    // the envelope around it is the signer-less shape and nothing else
    let e = &u.envelope;
    assert_eq!((e.version, e.from_pub_key.as_str(), e.sig.as_str(), e.nonce, e.fee.to_bits()), (1, "", "", 0, 0.0f64.to_bits()));
    assert!(e.signed_payload.is_none());
    // the witness of a built transaction is not printable
    assert_eq!(format!("{:?}", u.witness), "SpendWitness(<secret>)");
}

/// A hostile or buggy node serving the listing. Each manipulation is either refused (and leaves
/// the state untouched) or yields a tree whose root is not the chain's — which a wallet can only
/// notice by asking an honest source for `latest_anchor` (see F-1).
#[test]
fn rw1_sound_listing_manipulations_are_refused_or_change_the_root() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &bob.address(), &[7 * Q]);
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q]);
    let honest = page_json(&chain.page(0));
    let fresh = || WalletState::new(alice.address().pk);
    let scan = |v: &serde_json::Value| {
        let mut s = fresh();
        let r = s.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key());
        if r.is_err() {
            assert_eq!(s, fresh(), "a refused page leaves the state untouched");
        }
        r.map(|_| s)
    };
    let truth = scan(&honest).unwrap();
    assert_eq!((truth.balance(), truth.anchor()), (8 * Q as u128, chain.state().tree_root));

    // duplicated, reordered, skipped
    let mut v = honest.clone();
    let dup = v["txs"][1].clone();
    v["txs"].as_array_mut().unwrap().insert(1, dup);
    assert!(scan(&v).is_err(), "a duplicated transaction");
    let mut v = honest.clone();
    v["txs"].as_array_mut().unwrap().swap(1, 2);
    assert!(scan(&v).is_err(), "reordered transactions");
    let mut v = honest.clone();
    v["txs"].as_array_mut().unwrap().remove(0);
    assert!(scan(&v).is_err(), "a skipped transaction (the next leaf is not the expected one)");
    let mut v = honest.clone();
    v["txs"][1]["outputs"].as_array_mut().unwrap().swap(0, 1);
    assert!(scan(&v).is_err(), "the two outputs of a transaction swapped");
    let mut v = honest.clone();
    v["txs"][2]["outputs"][0]["leaf"] = serde_json::json!(u64::MAX);
    assert!(scan(&v).is_err(), "an absurd leaf position");
    let mut v = honest.clone();
    v["next_height"] = serde_json::json!(0);
    assert!(scan(&v).is_err(), "next_height below from_height");

    // a skipped transaction with the leaves renumbered: accepted, but the root is not the chain's
    let mut v = honest.clone();
    v["txs"].as_array_mut().unwrap().remove(0);
    for (i, t) in v["txs"].as_array_mut().unwrap().iter_mut().enumerate() {
        for j in 0..2 {
            t["outputs"][j]["leaf"] = serde_json::json!(2 * i + j);
        }
    }
    let s = scan(&v).unwrap();
    assert_ne!(s.anchor(), chain.state().tree_root, "a renumbered listing gives another root");

    // a forged commitment on somebody else's output: accepted, another root; on the wallet's own
    // output: the note is not recognised (hidden), another root
    for (t, what) in [(0usize, "a foreign output"), (1, "the wallet's own output")] {
        for j in 0..2 {
            let mut v = honest.clone();
            v["txs"][t]["outputs"][j]["cm_out"] = serde_json::json!(hex::encode(digest_bytes(0x30 + j as u8)));
            let s = scan(&v).unwrap();
            assert_ne!(s.anchor(), chain.state().tree_root, "{what}: the root moves");
            assert!(s.balance() <= truth.balance(), "{what}: a forged commitment never adds value");
        }
    }
    // wrong nullifiers on the wallet's note's transaction: rho no longer matches, the note is hidden
    let mut v = honest.clone();
    v["txs"][1]["nf1"] = serde_json::json!(hex::encode(digest_bytes(0x40)));
    let s = scan(&v).unwrap();
    assert_eq!(s.balance(), 3 * Q as u128, "hidden, not altered");
    // a substituted ciphertext (either part), and a whole ciphertext pair moved under another
    // commitment (the aad): the note is hidden, never altered or credited twice
    let (slot1, slot2) = (truth.notes()[0].output_index as usize, truth.notes()[1].output_index as usize);
    for field in ["kem_ct", "note_ct"] {
        let mut v = honest.clone();
        let other = honest["txs"][2]["outputs"][slot2][field].clone();
        v["txs"][1]["outputs"][slot1][field] = other;
        assert_eq!(scan(&v).unwrap().balance(), 3 * Q as u128, "{field} replaced");
    }
    let mut v = honest.clone();
    for field in ["kem_ct", "note_ct"] {
        let other = honest["txs"][2]["outputs"][slot2][field].clone();
        v["txs"][1]["outputs"][slot1][field] = other;
    }
    assert_eq!(scan(&v).unwrap().balance(), 3 * Q as u128, "a valid ciphertext pair under another commitment");
    // a "spend" the node invents: it cannot name the nullifier of an unspent note (it needs nk),
    // and random nullifiers mark nothing
    let mut v = honest.clone();
    v["txs"].as_array_mut().unwrap().push(serde_json::json!({
        "height": chain.height, "index": 9, "tx_hash": "x", "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(digest_bytes(0x50)), "nf2": hex::encode(digest_bytes(0x51)),
        "outputs": [
            { "cm_out": hex::encode(digest_bytes(0x52)), "leaf": 6, "kem_ct": "11".repeat(1088), "note_ct": "22".repeat(56) },
            { "cm_out": hex::encode(digest_bytes(0x53)), "leaf": 7, "kem_ct": "33".repeat(1088), "note_ct": "44".repeat(56) },
        ],
    }));
    let s = scan(&v).unwrap();
    assert_eq!(s.balance(), truth.balance());
    assert!(s.notes().iter().all(|n| !n.spent));

    // a note whose ciphertext opens but whose content does not match the commitment (a hostile
    // SENDER): value + 1 under the right key and aad — silently not the wallet's
    let own = truth.notes()[0].clone();
    let (kem, ct, _) = encrypt_note_with_kem_randomness(&alice.address().ek, &own.cm.0, own.value + 1, &own.r.0, [5u8; 32]).unwrap();
    let mut v = honest.clone();
    let slot = own.output_index as usize;
    v["txs"][1]["outputs"][slot]["kem_ct"] = serde_json::json!(hex::encode(kem));
    v["txs"][1]["outputs"][slot]["note_ct"] = serde_json::json!(hex::encode(ct));
    let s = scan(&v).unwrap();
    assert_eq!(s.balance(), 3 * Q as u128, "a note that decrypts to the wrong value is not credited");
    assert_eq!(s.anchor(), chain.state().tree_root);
    // … and with a non-canonical r
    let mut bad_r = own.r.0;
    bad_r[..4].copy_from_slice(&MODULUS.to_le_bytes());
    let (kem, ct, _) = encrypt_note_with_kem_randomness(&alice.address().ek, &own.cm.0, own.value, &bad_r, [6u8; 32]).unwrap();
    v["txs"][1]["outputs"][slot]["kem_ct"] = serde_json::json!(hex::encode(kem));
    v["txs"][1]["outputs"][slot]["note_ct"] = serde_json::json!(hex::encode(ct));
    assert_eq!(scan(&v).unwrap().balance(), 3 * Q as u128);
}

/// A tampered or damaged wallet-state blob must be refused or handled — never a panic (a trap in
/// WebAssembly). 4,000 single mutations of a real state, each followed by every read path, a
/// scan, coin selection and a transfer assembly.
#[test]
fn rw1_sound_a_tampered_state_blob_never_panics() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q, 2 * Q]);
    let good = synced(&chain, &alice);
    fund(&mut chain, &alice.address(), &[Q]);
    let next_page = chain.page(good.next_height());
    let base: serde_json::Value = serde_json::from_str(&good.to_json().unwrap()).unwrap();

    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    // every JSON pointer of the state
    fn pointers(v: &serde_json::Value, at: String, out: &mut Vec<String>) {
        out.push(at.clone());
        match v {
            serde_json::Value::Object(m) => m.iter().for_each(|(k, c)| pointers(c, format!("{at}/{k}"), out)),
            serde_json::Value::Array(a) => a.iter().enumerate().for_each(|(i, c)| pointers(c, format!("{at}/{i}"), out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    pointers(&base, String::new(), &mut all);
    all.retain(|p| !p.is_empty());
    let replacements = |r: u64| -> serde_json::Value {
        match r % 14 {
            0 => serde_json::json!(0),
            1 => serde_json::json!(u64::MAX),
            2 => serde_json::json!(1u64 << 32),
            3 => serde_json::json!((1u64 << 32) - 1),
            4 => serde_json::json!(u64::MAX.to_string()),
            5 => serde_json::json!("ff".repeat(32)),
            6 => serde_json::json!("00".repeat(32)),
            7 => serde_json::json!([]),
            8 => serde_json::json!({}),
            9 => serde_json::Value::Null,
            10 => serde_json::json!(true),
            11 => serde_json::json!(""),
            12 => serde_json::json!(-1),
            _ => serde_json::json!(vec!["00".repeat(32); 32]),
        }
    };
    let (mut parsed, mut refused, mut panics) = (0usize, 0usize, Vec::new());
    for round in 0..4_000 {
        let mut v = base.clone();
        let p = &all[(rnd() % all.len() as u64) as usize];
        let rep = replacements(rnd());
        match rnd() % 5 {
            // swap two subtrees
            0 => {
                let q = &all[(rnd() % all.len() as u64) as usize];
                let (a, b) = (v.pointer(p).cloned(), v.pointer(q).cloned());
                if let (Some(a), Some(b)) = (a, b) {
                    if let Some(t) = v.pointer_mut(p) {
                        *t = b;
                    }
                    if let Some(t) = v.pointer_mut(q) {
                        *t = a;
                    }
                }
            }
            _ => {
                if let Some(t) = v.pointer_mut(p) {
                    *t = rep.clone();
                }
            }
        }
        let text = v.to_string();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Ok(mut s) = WalletState::from_json(&text) else { return false };
            let _ = (s.balance(), s.anchor(), s.next_height(), s.tree().note_count(), s.tree().tracked());
            let _ = s.to_json();
            for amount in [1, Q, 4 * Q, 9 * Q, u64::MAX / 2, u64::MAX] {
                for fee in [Q, u64::MAX] {
                    if let Ok(sel) = select_inputs(&s, amount, fee) {
                        let inputs: Result<Vec<SpendInput>, _> = sel.positions.iter().map(|&p| s.spend_input(p)).collect();
                        if let Ok(inputs) = inputs {
                            let ctx = TxContext { chain_id: CHAIN.into(), anchor: s.anchor(), expiry_height: 100 };
                            let _ = deterministic::transfer(
                                &TransferRequest { ctx, keys: &alice, inputs: &inputs, recipient: &bob.address(), amount, fee },
                                "rw1-tamper",
                            );
                        }
                    }
                }
            }
            let _ = plan_merge(&s, Q);
            let positions: Vec<u64> = s.notes().iter().map(|n| n.position).collect();
            for p in positions.iter().copied().chain([0, 1, u64::MAX]) {
                let _ = s.spend_input(p);
                let _ = s.mark_pending_spent(p);
                let _ = s.unmark_pending(p);
            }
            let _ = s.scan(&next_page, &alice.scan_key());
            let _ = s.scan(&next_page, &alice.incoming_viewing_key());
            true
        }));
        match outcome {
            Ok(true) => parsed += 1,
            Ok(false) => refused += 1,
            Err(_) => panics.push((round, p.clone(), rep)),
        }
    }
    assert!(panics.is_empty(), "panics on a tampered state: {:?}", &panics[..panics.len().min(5)]);
    assert!(parsed > 100 && refused > 100, "the mutations exercised both outcomes ({parsed} parsed, {refused} refused)");
}

/// The builders from the user's side: what leaves the wallet is what was asked for, the change
/// comes back to the wallet's own key, and nothing overflows.
#[test]
fn rw1_sound_value_conservation_change_and_edge_amounts() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q]);
    let a = synced(&chain, &alice);
    let both: Vec<SpendInput> = a.notes().iter().map(|n| a.spend_input(n.position).unwrap()).collect();
    let req = |amount: u64, fee: u64, to: &ShieldedAddress, inputs: &[SpendInput], label: &str| {
        deterministic::transfer(&TransferRequest { ctx: chain.ctx(), keys: &alice, inputs, recipient: to, amount, fee }, label)
    };
    // amounts around the total, and overflowing sums
    assert!(matches!(req(8 * Q, Q, &bob.address(), &both, "a"), Err(WalletError::InsufficientFunds { .. })));
    assert!(matches!(req(u64::MAX, u64::MAX, &bob.address(), &both, "b"), Err(WalletError::InsufficientFunds { .. })));
    assert!(matches!(req(u64::MAX, Q, &bob.address(), &both, "c"), Err(WalletError::InsufficientFunds { .. })));
    assert!(req(0, Q, &bob.address(), &both, "d").is_err() && req(Q, Q - 1, &bob.address(), &both, "e").is_err());
    // every valid split: the body's fee is the requested one, payment + change + fee = inputs,
    // the payment opens for the recipient only and the change for the sender only
    for (amount, fee) in [(Q, Q), (7 * Q, Q), (1, Q), (Q, 7 * Q - 1), (1, 8 * Q - 1), (6 * Q, 2 * Q)] {
        let t = req(amount, fee, &bob.address(), &both, &format!("split-{amount}-{fee}")).unwrap();
        let body = Body::decode(&t.body).unwrap();
        assert_eq!((body.fee, body.v_in, body.v_out, body.account), (fee, 0, 0, [0u8; 32]));
        let pay = t.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
        let change = t.outputs.iter().find(|o| o.role == OutputRole::Change).unwrap();
        assert_eq!((pay.value, change.value), (amount, 8 * Q - amount - fee));
        let mut c2 = Chain::new();
        fund(&mut c2, &alice.address(), &[5 * Q, 3 * Q]);
        c2.block(&[&t.body]).unwrap();
        let (sa, sb) = (synced(&c2, &alice), synced(&c2, &bob));
        assert_eq!(sa.balance(), change.value as u128, "the change is the sender's");
        assert_eq!(sb.balance(), amount as u128, "the payment is the recipient's");
        assert_eq!(sb.notes().len(), 1);
    }
    // paying oneself: both outputs come back, nothing is lost but the fee
    let t = req(4 * Q, Q, &alice.address(), &both, "self").unwrap();
    let mut c2 = Chain::new();
    fund(&mut c2, &alice.address(), &[5 * Q, 3 * Q]);
    c2.block(&[&t.body]).unwrap();
    assert_eq!(synced(&c2, &alice).balance(), 7 * Q as u128);
    // the same note twice, a note of another wallet, a stale anchor
    let twice = [both[0].clone(), both[0].clone()];
    assert!(req(Q, Q, &bob.address(), &twice, "f").is_err());
    let stolen = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &bob, inputs: &both, recipient: &bob.address(), amount: Q, fee: Q },
        "g",
    );
    assert!(matches!(stolen, Err(WalletError::AnchorMismatch)), "another wallet's keys do not spend these notes");
    let mut inflated = both.clone();
    inflated[0].value += Q;
    assert!(matches!(req(Q, Q, &bob.address(), &inflated, "h"), Err(WalletError::AnchorMismatch)), "a note's value cannot be edited");
    // unshield: v_out and the account are the requested ones; the dummy output is worth nothing
    let u = deterministic::unshield(
        &UnshieldRequest { ctx: chain.ctx(), keys: &alice, inputs: &both, to_account: [0x42; 32], v_out: 6 * Q, fee: Q },
        "u",
    )
    .unwrap();
    let body = Body::decode(&u.body).unwrap();
    assert_eq!((body.v_out, body.fee, body.account), (6 * Q, Q, [0x42; 32]));
    assert_eq!(u.outputs.iter().map(|o| o.value).sum::<u64>(), Q);
    // shield: the note is v_in − fee, the account is SHA-256 of the key, fee = v_in is refused
    let key = fake_account_key(3);
    let s = deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: 9 * Q, fee: 2 * Q, recipient: &bob.address() }, "s").unwrap();
    let body = Body::decode(&s.body).unwrap();
    assert_eq!((body.v_in, body.fee), (9 * Q, 2 * Q));
    assert_eq!(s.outputs.iter().map(|o| o.value).sum::<u64>(), 7 * Q);
    assert!(deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: Q, fee: Q, recipient: &bob.address() }, "s2").is_err());
    assert!(deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: u64::MAX, fee: Q, recipient: &bob.address() }, "s3").is_err());
}

/// The scan key (`dk`, `pk`, `nk`) is not the spending key and does not lead to it: it is not
/// among the bytes of `sk`, and a wallet built from other secrets with the same viewing data
/// cannot assemble a spend (the commitment under its own `pk` is not in the tree).
#[test]
fn rw1_sound_the_scan_key_does_not_contain_the_spending_key() {
    let alice = keys(PHRASE_1);
    let (sk, nk, pk, ek, dk) = alice.expose_for_vectors();
    let scan = alice.scan_key();
    assert_eq!((scan.pk, scan.nk, scan.dk_bytes()), (pk, Some(nk), &dk[..]));
    assert!(alice.incoming_viewing_key().nk.is_none());
    let contains = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).any(|w| w == needle);
    assert!(!contains(&dk, &sk) && !contains(&dk, &nk) && !contains(&ek, &sk));
    assert!(sk != nk && sk != pk && nk != pk);
    // the ML-KEM decapsulation key embeds ek (FIPS 203): a viewing-key holder knows the address
    assert!(contains(&dk, &ek));
}
