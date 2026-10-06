//! REVIEW_WALLET_1 — independent adversarial review of the wallet core (see `REVIEW_WALLET_1.md`).
//!
//! Two kinds of test live here:
//!
//! * `rw1_fN_…` — **regression tests of the confirmed defects.** They failed on the reviewed
//!   commit (abab9a8) and pass since the fixes (see "Resolution" in the report). The tests of F-1
//!   and F-7 were demonstrations (`rw1_demo_…`) on the reviewed commit and are regression tests
//!   now: the same attacks, with the outcome the fix guarantees.
//! * `rw1_sound_…` — an attack that was tried and does not work.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like `wallet_flow.rs`.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, Note, MODULUS};
use quantum_vault_shield_v2::verify_spend;
use quantum_vault_shield_v2_wallet::body::public_inputs_of;
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::store::B32;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;

fn shield_req<'a>(chain: &Chain, key: &'a [u8], to: &'a ShieldedAddress, v_in: u64) -> ShieldRequest<'a> {
    ShieldRequest { ctx: chain.ctx(), from_pub_key: key, nonce: 1, v_in, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None }
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
// F-1 (Medium) — a node that knows a wallet's ADDRESS can list a payment that is on no chain
// ---------------------------------------------------------------------------------------------------

/// Whoever serves the listing and knows the wallet's public address (`pk`, `ek` — every payer has
/// it) can list a transaction that was never mined; the note is authenticated against a
/// commitment from the same listing. One node's listing cannot be authenticated without a light
/// client, which the chain does not have. What the wallet does about it since the fix:
///
/// * the forged note is stored `unverified`, counted in the unverified balance only, and not
///   selected by default coin selection;
/// * it stays unverified whatever the lying node itself reports about the root, however often;
/// * a second node that does not hold the forged transaction reports another root: no quorum;
/// * only an explicit `allow_unverified` of the caller spends it.
///
/// Nothing but the victim's address is used below — no key of the victim.
#[test]
fn rw1_f1_a_forged_incoming_note_stays_unverified_and_is_not_spent_by_default() {
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
    assert_eq!(report.received, vec![0], "the listing is self-consistent: the wallet cannot tell by itself");
    // … but it does not call it money
    let unverified_only = |w: &WalletState| {
        assert!(!w.notes()[0].confirmed, "the note is unverified");
        let b = w.balances();
        assert_eq!((b.confirmed, b.spendable, b.unverified), (0, 0, value as u128), "it is not in the confirmed balance");
        assert!(matches!(select_inputs(w, 5 * Q, Q), Err(WalletError::InsufficientFunds { have: 0, .. })), "default coin selection does not see it");
        assert!(plan_merge(w, Q).is_err());
    };
    unverified_only(&wallet);

    // the liar vouches for its own tree — once, twice, at every height: one node is no quorum
    let lying_root = wallet.anchor();
    assert!((5..=10).all(|h| wallet.root_at(h) == Some(lying_root)) && wallet.root_at(11).is_none());
    let lie = |height: u64| RootReport { node_id: "the-lying-node".into(), height, root: lying_root };
    let c = wallet.confirm_roots(&[lie(10)], DEFAULT_CONFIRM_QUORUM).unwrap();
    assert_eq!((c.matched_height, c.agreeing, c.newly_confirmed.len()), (None, 1, 0));
    wallet.confirm_roots(&[lie(10), lie(10), lie(5), lie(7)], DEFAULT_CONFIRM_QUORUM).unwrap();
    unverified_only(&wallet);
    // an honest second node has never seen the transaction: its tree is empty
    let honest = RootReport { node_id: "an-honest-node".into(), height: 10, root: WalletState::new(address.pk).anchor() };
    let c = wallet.confirm_roots(&[lie(10), honest.clone()], DEFAULT_CONFIRM_QUORUM).unwrap();
    assert_eq!((c.matched_height, c.agreeing, c.diverged), (None, 1, false));
    unverified_only(&wallet);
    // two honest nodes against the liar: the wallet learns that its listing is not the chain's
    let honest2 = RootReport { node_id: "another-honest-node".into(), ..honest.clone() };
    let c = wallet.confirm_roots(&[lie(10), honest.clone(), honest2], DEFAULT_CONFIRM_QUORUM).unwrap();
    assert!(c.diverged && c.matched_height.is_none());
    // a node that says two things about one height, heights not scanned, a zero quorum
    let c = wallet.confirm_roots(&[lie(10), RootReport { root: digest_bytes(9), ..lie(10) }, RootReport { node_id: "n2".into(), ..lie(10) }], 2).unwrap();
    assert_eq!((c.matched_height, c.agreeing), (None, 1), "an equivocating node counts for nothing");
    let c = wallet.confirm_roots(&[RootReport { node_id: "a".into(), height: 11, root: lying_root }, RootReport { node_id: "b".into(), height: 11, root: lying_root }], 2).unwrap();
    assert_eq!((c.matched_height, c.not_comparable), (None, 2), "a height the wallet has not scanned proves nothing");
    assert!(wallet.confirm_roots(&[lie(10)], 0).is_err());
    unverified_only(&wallet);

    // spending it is possible only by the caller's explicit decision (and fails on the real chain)
    let sel = select_inputs_with(&wallet, 5 * Q, Q, true).unwrap();
    assert_eq!(sel.positions, vec![0]);
    // the state round-trips with the status
    let again = WalletState::from_json(&wallet.to_json().unwrap()).unwrap();
    assert_eq!(again, wallet);
    unverified_only(&again);
}

/// The other side of F-1: on an honest listing the quorum check confirms exactly the notes at or
/// below the matched height, and nothing above it.
#[test]
fn rw1_f1_two_agreeing_nodes_confirm_notes_up_to_the_matched_height_only() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q]);
    let reports_then = chain.root_reports();
    fund(&mut chain, &alice.address(), &[3 * Q]);
    let mut a = synced(&chain, &alice);
    assert_eq!((a.confirmed_balance(), a.unverified_balance()), (0, 8 * Q as u128));
    // one node: nothing
    let c = a.confirm_roots(&reports_then[..1], DEFAULT_CONFIRM_QUORUM).unwrap();
    assert_eq!((c.matched_height, a.confirmed_balance()), (None, 0));
    // two nodes at the earlier height: the first note only
    let c = a.confirm_roots(&reports_then, DEFAULT_CONFIRM_QUORUM).unwrap();
    assert_eq!((c.matched_height, c.newly_confirmed.len()), (Some(chain.height - 1), 1));
    assert_eq!((a.confirmed_balance(), a.unverified_balance()), (5 * Q as u128, 3 * Q as u128));
    assert_eq!(select_inputs(&a, 3 * Q, Q).unwrap().total, 5 * Q, "selection uses the confirmed note, not the smaller unverified one");
    // the tip: everything; a caller that trusts its own node sets the quorum to 1
    let mut own = a.clone();
    assert_eq!(own.confirm_roots(&chain.root_reports()[..1], 1).unwrap().matched_height, Some(chain.height));
    confirm(&chain, &mut a);
    assert_eq!((a.confirmed_balance(), a.unverified_balance(), a.confirmed_height()), (8 * Q as u128, 0, Some(chain.height)));
    assert_eq!(own.balances(), a.balances());
}

// ---------------------------------------------------------------------------------------------------
// F-7 (Medium) — a false "rejected" plus a retry used to pay the payee twice
// ---------------------------------------------------------------------------------------------------

/// A signer-less transaction that was handed to a node stays valid until its expiry height,
/// whatever the node answered. The reviewed commit kept no record of it and released its inputs
/// on the UI's word; a node that lied about a rejection could then have the first attempt AND the
/// retry mined.
///
/// Since the fix the state holds the pending transaction (nullifiers, inputs, change, expiry),
/// and its inputs stay locked until the SCANNED CHAIN shows it mined or shows a height at or
/// above its expiry without it. The scenario of the review, replayed:
///
/// Alice holds one 10 XRGE note and pays Bob 4. The node answers "rejected" and keeps the
/// transaction. The retry is refused by the wallet — the "rejection" is a hint and nothing more.
/// Then both ends: the node mines the transaction after all (Alice has paid once: 5 left), or it
/// never does and the expiry height passes (the note is released: 10 again).
#[test]
fn rw1_f7_a_claimed_rejection_does_not_release_the_inputs_and_funds_are_intact_either_way() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let pay = |a: &WalletState, chain: &Chain, label: &str| {
        let sel = select_inputs(a, 4 * Q, Q)?;
        let inputs: Vec<SpendInput> = sel.positions.iter().map(|&p| a.spend_input(p)).collect::<Result<_, _>>()?;
        deterministic::transfer(
            &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 4 * Q, fee: Q, max_fee: None },
            label,
        )
    };
    // first attempt: recorded as pending BEFORE it is submitted
    let t1 = pay(&a, &chain, "rw1-f7-first").unwrap();
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height.unwrap();
    assert_eq!((record.inputs.clone(), record.input_total, record.change.as_ref().map(|c| c.value)), (vec![a.notes()[0].position], 10 * Q, Some(5 * Q)));
    a.mark_pending(record.clone()).unwrap();
    assert_eq!(a.pending().len(), 1);
    // the pending list is part of the persisted state
    a = WalletState::from_json(&a.to_json().unwrap()).unwrap();

    // the node says "rejected" (it is not: it keeps t1). The UI records the hint …
    assert!(a.note_rejection_hint(&record.nullifiers[0].0));
    assert!(a.pending()[0].rejected_hint && a.pending()[0].status == PendingStatus::Pending);
    // … and the retry is REFUSED by the wallet: the note is locked, whatever the node said
    assert!(matches!(pay(&a, &chain, "rw1-f7-retry"), Err(WalletError::InsufficientFunds { .. })), "coin selection does not offer a locked note");
    assert!(matches!(a.spend_input(a.notes()[0].position), Err(WalletError::NoteLocked)), "nor can it be handed to a builder directly");
    assert!(matches!(select_inputs_with(&a, 4 * Q, Q, true), Err(WalletError::InsufficientFunds { .. })));
    assert!(a.mark_pending(record.clone()).is_err(), "nor recorded twice");
    // nothing settles while the chain shows neither outcome
    let r = a.resolve(ReleasePolicy::Scanned);
    assert_eq!((r.mined.len(), r.expired.len(), r.still_pending), (0, 0, 1));
    assert_eq!(a.balances().locked, 10 * Q as u128);
    // more blocks, still below the expiry: still locked (the last valid height is `expiry` itself)
    let mut early = chain_clone_with(&alice, &bob, &[]);
    early.advance_to(expiry - 1);
    let mut a_early = a.clone();
    a_early.scan(&early.page(a_early.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a_early.resolve(ReleasePolicy::Scanned).still_pending, 1);
    assert!(a_early.is_locked(a_early.notes()[0].position));

    // ---- outcome 1: the node mines the "rejected" transaction, at the last valid height ----------
    let mut mined = chain_clone_with(&alice, &bob, &[]);
    mined.advance_to(expiry - 1);
    mined.block(&[&t1.body]).expect("valid at its expiry height: the rejection was a lie");
    let mut a1 = a.clone();
    let rep = a1.scan(&mined.page(a1.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(rep.pending_mined, 1);
    let r = a1.resolve(ReleasePolicy::Scanned);
    assert_eq!((r.mined.len(), r.expired.len(), r.still_pending), (1, 0, 0));
    assert_eq!(r.mined[0].mined_height, Some(expiry));
    assert_eq!(a1.balance(), 5 * Q as u128, "Alice paid once: 10 - 4 - fee");
    assert_eq!(synced(&mined, &bob).balance(), 4 * Q as u128, "and Bob was paid once");
    assert!(a1.notes().iter().any(|n| !n.spent && n.cm == record.change.as_ref().unwrap().cm), "the expected change arrived");

    // ---- outcome 2: it is never mined; the scan passes the expiry height -------------------------
    let mut dropped = chain_clone_with(&alice, &bob, &[]);
    dropped.advance_to(expiry);
    let mut a2 = a.clone();
    a2.scan(&dropped.page(a2.next_height()), &alice.scan_key()).unwrap();
    // under the stricter policy the release waits for the quorum's word on that height
    let mut strict = a2.clone();
    assert_eq!(strict.resolve(ReleasePolicy::Confirmed).still_pending, 1, "the confirmed height is still the old one");
    confirm(&dropped, &mut strict);
    assert_eq!(strict.resolve(ReleasePolicy::Confirmed).expired.len(), 1);
    let r = a2.resolve(ReleasePolicy::Scanned);
    assert_eq!((r.mined.len(), r.expired.len(), r.still_pending), (0, 1, 0));
    assert_eq!((a2.balance(), a2.balances().locked), (10 * Q as u128, 0), "nothing was spent and the note is free again");
    // and the transaction can no longer be mined: the node refuses a body whose expiry is below
    // the block's height (spec §3.6 check 7 — a stateless rule of the node, exercised in the
    // daemon's `shield_v2::tests` and interop tests; the stand-in chain here has only the pool rules)
    assert!(Body::decode(&t1.body).unwrap().expiry_height < dropped.height + 1);
    // the released note is spendable: the retry is now safe
    confirm(&dropped, &mut a2);
    assert!(select_inputs(&a2, 4 * Q, Q).is_ok());

    // ---- a rescan keeps the lock ---------------------------------------------------------------
    let mut rescanned = a.fresh_for_rescan();
    rescanned.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(rescanned.is_locked(rescanned.notes()[0].position), "a rebuilt state still knows the pending transaction");

    // ---- what mark_pending refuses ---------------------------------------------------------------
    let mut fresh = synced(&chain, &alice);
    let mut far = record.clone();
    far.expiry_height = Some(chain.height + 129);
    assert!(fresh.mark_pending(far).is_err(), "an expiry beyond the bound would lock the note for too long");
    let mut wrong = record.clone();
    wrong.nullifiers[0] = wrong.nullifiers[1];
    assert!(fresh.mark_pending(wrong).is_err());
    let mut wrong = record.clone();
    wrong.nullifiers = vec![B32(digest_bytes(7)), B32(digest_bytes(8))];
    assert!(fresh.mark_pending(wrong).is_err(), "nullifiers that do not spend the named note");
    let mut wrong = record.clone();
    wrong.inputs = vec![99];
    assert!(fresh.mark_pending(wrong).is_err());
    let mut wrong = record.clone();
    wrong.input_total += 1;
    assert!(fresh.mark_pending(wrong).is_err());
    let mut wrong = record.clone();
    wrong.expiry_height = None;
    assert!(fresh.mark_pending(wrong).is_err());
    assert!(fresh.pending().is_empty());
    fresh.mark_pending(record).unwrap();
}

/// The stand-in chain of the F-7 test rebuilt from scratch (the same deterministic funding), so
/// that each outcome runs on its own copy.
fn chain_clone_with(alice: &ShieldedKeys, _bob: &ShieldedKeys, extra: &[&[u8]]) -> Chain {
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    for body in extra {
        chain.block(&[body]).unwrap();
    }
    chain
}

/// A state in format 1 (the reviewed commit's) is migrated: notes become unverified, a note that
/// was marked spent locally becomes the locked input of a pending entry without an expiry (it is
/// never released on a node's word, and not by time either — its expiry is unknown), zero-value
/// notes are dropped and a `tx_hash` that is not a hash is cleared.
#[test]
fn rw1_f7_a_format_1_state_is_migrated_with_its_local_marks_kept_as_locks() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q]);
    let now = synced(&chain, &alice);
    let mut v: serde_json::Value = serde_json::from_str(&now.to_json().unwrap()).unwrap();
    // back to the old shape
    v["version"] = serde_json::json!(1);
    for k in ["pending", "checkpoints", "confirmed_height", "blind"] {
        v.as_object_mut().unwrap().remove(k);
    }
    for n in v["notes"].as_array_mut().unwrap() {
        n.as_object_mut().unwrap().remove("confirmed");
        n["tx_hash"] = serde_json::json!("tx-3-0");
    }
    v["notes"][0]["spent"] = serde_json::json!(true); // `mark_pending_spent` of format 1
    let mut zero = v["notes"][1].clone();
    zero["value"] = serde_json::json!("0");
    let used: Vec<u64> = now.notes().iter().map(|n| n.position).collect();
    zero["position"] = serde_json::json!((0..4u64).find(|p| !used.contains(p)).unwrap());
    v["notes"].as_array_mut().unwrap().push(zero);

    let mut migrated = WalletState::from_json(&v.to_string()).unwrap();
    assert_eq!(migrated.notes().len(), 2, "the zero-value note is dropped");
    assert!(migrated.notes().iter().all(|n| !n.confirmed && n.tx_hash.is_empty() && !n.spent));
    assert_eq!((migrated.balance(), migrated.confirmed_balance()), (8 * Q as u128, 0));
    let p = &migrated.pending()[0];
    assert_eq!((p.inputs.clone(), p.expiry_height, p.status), (vec![now.notes()[0].position], None, PendingStatus::Pending));
    assert_eq!(p.nullifiers, vec![now.notes()[0].nullifier.unwrap()]);
    assert!(migrated.is_locked(now.notes()[0].position));
    // never released by time: its expiry is not known
    chain.advance_to(chain.height + 300);
    migrated.scan(&chain.page(migrated.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(migrated.resolve(ReleasePolicy::Scanned).still_pending, 1);
    // the migrated state is format 2 from here on, and keeps working
    assert!(migrated.to_json().unwrap().contains("\"version\":2"));
    confirm(&chain, &mut migrated);
    assert_eq!(migrated.balances().spendable, 3 * Q as u128);
    assert_eq!(migrated.anchor(), chain.state().tree_root);
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
/// Failed on abab9a8 (such a pair was found and accepted). Since the fix the address carries an
/// 8-byte domain-tagged SHA-256 of its payload inside the encoded data, which the decoder checks
/// in addition to the bech32m checksum: every such pair is refused.
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
    // (the pairs still pass the bech32m checksum itself — it is the integrity value that refuses)
    assert_eq!(s.len(), 1_974);
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
/// Failed on abab9a8 (the balance stayed 5 XRGE after the note was spent). Since the fix the full
/// key fills in every missing nullifier before the page is applied.
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
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 4 * Q, fee: Q, max_fee: None },
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

/// F-3, the harder half: the note is SPENT while the state is still being scanned with the viewing
/// key. The state remembers every nullifier that appears while it holds a note without one, so
/// the full key applies the missed spend when it arrives — and if more appeared than the state
/// can remember, it refuses to continue rather than show a spent note as money.
#[test]
fn rw1_f3_spends_seen_without_nk_are_applied_when_the_full_key_arrives_or_a_rescan_is_demanded() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 2 * Q]);
    let full = synced(&chain, &alice);
    let five = full.unspent().find(|n| n.value == 5 * Q).unwrap().position;
    let inputs = [full.spend_input(five).unwrap()];
    let t = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 4 * Q, fee: Q, max_fee: None },
        "rw1-f3-blind",
    )
    .unwrap();
    chain.block(&[&t.body]).unwrap();
    let spent_at = chain.height;

    // the whole history, the spend included, scanned with the viewing key alone
    let mut shared = WalletState::new(alice.address().pk);
    shared.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    assert_eq!(shared.balance(), 7 * Q as u128, "without nk the spend cannot be seen yet");
    // (survives persistence)
    shared = WalletState::from_json(&shared.to_json().unwrap()).unwrap();
    // the full key arrives with the next (empty) page
    fund(&mut chain, &bob.address(), &[Q]);
    let rep = shared.scan(&chain.page(shared.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(rep.spent, vec![five], "the remembered spend is applied");
    assert_eq!(shared.note_at(five).unwrap().spent_height, Some(spent_at));
    assert_eq!(shared.balance(), 2 * Q as u128);
    assert!(shared.notes().iter().all(|n| n.nullifier.is_some()));
    // from here the state is exactly the one a full-key scan builds
    assert_eq!(shared, synced(&chain, &alice));

    // more nullifiers than the state can remember while blind: the full key is refused, the
    // state is untouched, and a rescan with the full key gives the truth
    let mut blind = WalletState::new(alice.address().pk);
    blind.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    let key = fake_account_key(9);
    for i in 0..520u64 {
        let tx = deterministic::shield(&shield_req(&chain, &key, &bob.address(), 2 * Q), &format!("rw1-f3-flood-{i}")).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
    blind.scan(&chain.page(blind.next_height()), &alice.incoming_viewing_key()).unwrap();
    let before = blind.clone();
    fund(&mut chain, &bob.address(), &[Q]);
    assert!(matches!(blind.scan(&chain.page(blind.next_height()), &alice.scan_key()), Err(WalletError::RescanRequired)));
    assert_eq!(blind, before);
    // the viewing key alone can go on
    blind.scan(&chain.page(blind.next_height()), &alice.incoming_viewing_key()).unwrap();
    assert_eq!(synced(&chain, &alice).balance(), 2 * Q as u128);
}

// ---------------------------------------------------------------------------------------------------
// F-4 (Low) — `tx_hash` from the listing was stored and returned unvalidated
// ---------------------------------------------------------------------------------------------------

/// Every other listing field is strict lowercase hexadecimal of a fixed length. `tx_hash` is an
/// arbitrary string of arbitrary length that the node chooses; it is copied into the persistent
/// state for each of the wallet's notes and handed back to the UI by `summary`. A hostile node
/// can plant markup for a UI that renders it, or megabytes per note.
///
/// Failed on abab9a8 (the string was stored verbatim). Since the fix `scan` requires exactly 64
/// lowercase hexadecimal characters and a known `tx_type` before anything is stored.
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
    assert!(matches!(outcome, Err(WalletError::Listing(_))));
    assert_eq!(s, WalletState::new(alice.address().pk), "the page is refused as a whole");
    // every other shape that is not a hash, and an unknown type; the error never quotes the value
    let honest = page_json(&chain.page(0));
    for bad in ["", "0", &"g".repeat(64), &"A".repeat(64), &"a".repeat(63), &"a".repeat(65), &format!("{}\u{0}", "a".repeat(63)), "marker-7f3a"] {
        let mut v = honest.clone();
        v["txs"][0]["tx_hash"] = serde_json::json!(bad);
        let e = s.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).unwrap_err();
        assert!(matches!(e, WalletError::Listing(_)) && !e.to_string().contains("marker"), "{bad:?}: {e}");
    }
    for bad in ["", "transfer", "<script>marker-7f3a</script>"] {
        let mut v = honest.clone();
        v["txs"][0]["tx_type"] = serde_json::json!(bad);
        let e = s.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).unwrap_err();
        assert!(matches!(e, WalletError::Listing(_)) && !e.to_string().contains("marker"), "{bad:?}: {e}");
    }
    // a page that does not say where the tip is, or claims to end above its own tip
    let mut v = honest.clone();
    v.as_object_mut().unwrap().remove("tip_height");
    assert!(ListingPage::from_json(&v.to_string()).is_err());
    let mut v = honest.clone();
    v["next_height"] = serde_json::json!(chain.height + 1_000_000);
    assert!(s.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).is_err());
    // the honest page is accepted and its hash is stored as given
    s.scan(&ListingPage::from_json(&honest.to_string()).unwrap(), &alice.scan_key()).unwrap();
    assert_eq!(s.notes()[0].tx_hash, honest["txs"][0]["tx_hash"].as_str().unwrap());
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
    let u = build_unshield(&UnshieldRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, to_account: [0x42; 32], v_out: 6 * Q, fee: Q, max_fee: None }).unwrap();
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
    // a built transaction carries no witness at all (I-1), and its output record does not print
    // the note's secrets (I-3)
    let printed = format!("{:?}", u.outputs);
    assert!(printed.contains("<secret>") && !printed.contains(&hex::encode(u.outputs[0].r)) && !printed.contains(&u.outputs[0].value.to_string()));
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
        "height": chain.height, "index": 9, "tx_hash": "ab".repeat(32), "tx_type": "shielded_transfer_v2",
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
    let mut good = synced(&chain, &alice);
    confirm(&chain, &mut good);
    // one note locked by a pending transaction, so that the pending list is mutated too
    let p_in = [good.spend_input(good.notes()[0].position).unwrap()];
    let p_tx = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &p_in, recipient: &bob.address(), amount: Q, fee: Q, max_fee: None },
        "rw1-tamper-pending",
    )
    .unwrap();
    good.mark_pending(p_tx.pending().unwrap()).unwrap();
    let reports = chain.root_reports();
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
                    let _ = select_inputs(&s, amount, fee);
                    if let Ok(sel) = select_inputs_with(&s, amount, fee, true) {
                        let inputs: Result<Vec<SpendInput>, _> = sel.positions.iter().map(|&p| s.spend_input(p)).collect();
                        if let Ok(inputs) = inputs {
                            let ctx = TxContext { chain_id: CHAIN.into(), anchor: s.anchor(), anchor_height: 50, expiry_height: 100 };
                            let _ = deterministic::transfer(
                                &TransferRequest { ctx, keys: &alice, inputs: &inputs, recipient: &bob.address(), amount, fee, max_fee: Some(u64::MAX) },
                                "rw1-tamper",
                            );
                        }
                    }
                }
            }
            let _ = (plan_merge(&s, Q), plan_merge_with(&s, Q, true), s.balances(), s.pending().len(), s.confirmed_height(), s.scanned_height());
            let positions: Vec<u64> = s.notes().iter().map(|n| n.position).collect();
            for p in positions.iter().copied().chain([0, 1, u64::MAX]) {
                let _ = (s.spend_input(p), s.is_locked(p), s.root_at(p));
            }
            let _ = s.clone().mark_pending(p_tx.pending().unwrap());
            let _ = s.clone().resolve(ReleasePolicy::Scanned);
            let _ = s.clone().resolve(ReleasePolicy::Confirmed);
            let _ = s.clone().confirm_roots(&reports, 1);
            let _ = s.fresh_for_rescan().to_json();
            let _ = s.clone().scan(&next_page, &alice.incoming_viewing_key());
            let _ = s.scan(&next_page, &alice.scan_key());
            let _ = (s.resolve(ReleasePolicy::Scanned), s.confirm_roots(&reports, 2), s.to_json());
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
        // (the fee ceiling is lifted here: this test is about amounts, `builder_refusals` covers the ceiling)
        deterministic::transfer(&TransferRequest { ctx: chain.ctx(), keys: &alice, inputs, recipient: to, amount, fee, max_fee: Some(u64::MAX) }, label)
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
        &TransferRequest { ctx: chain.ctx(), keys: &bob, inputs: &both, recipient: &bob.address(), amount: Q, fee: Q, max_fee: None },
        "g",
    );
    assert!(matches!(stolen, Err(WalletError::AnchorMismatch)), "another wallet's keys do not spend these notes");
    let mut inflated = both.clone();
    inflated[0].value += Q;
    assert!(matches!(req(Q, Q, &bob.address(), &inflated, "h"), Err(WalletError::AnchorMismatch)), "a note's value cannot be edited");
    // unshield: v_out and the account are the requested ones; the dummy output is worth nothing
    let u = deterministic::unshield(
        &UnshieldRequest { ctx: chain.ctx(), keys: &alice, inputs: &both, to_account: [0x42; 32], v_out: 6 * Q, fee: Q, max_fee: None },
        "u",
    )
    .unwrap();
    let body = Body::decode(&u.body).unwrap();
    assert_eq!((body.v_out, body.fee, body.account), (6 * Q, Q, [0x42; 32]));
    assert_eq!(u.outputs.iter().map(|o| o.value).sum::<u64>(), Q);
    // shield: the note is v_in − fee, the account is SHA-256 of the key, fee = v_in is refused
    let key = fake_account_key(3);
    let s = deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: 9 * Q, fee: 2 * Q, recipient: &bob.address(), max_fee: None }, "s").unwrap();
    let body = Body::decode(&s.body).unwrap();
    assert_eq!((body.v_in, body.fee), (9 * Q, 2 * Q));
    assert_eq!(s.outputs.iter().map(|o| o.value).sum::<u64>(), 7 * Q);
    assert!(deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: Q, fee: Q, recipient: &bob.address(), max_fee: None }, "s2").is_err());
    assert!(deterministic::shield(&ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 4, v_in: u64::MAX, fee: Q, recipient: &bob.address(), max_fee: None }, "s3").is_err());
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
