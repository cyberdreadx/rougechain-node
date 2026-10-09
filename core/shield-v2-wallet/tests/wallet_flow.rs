//! The wallet against the pool rules of spec §4: build → apply → scan, restore, selection, and
//! every refusal of the builders. Proofs are made only where a test is about a proof; everything
//! else uses the deterministic assembly (the pool logic and the scan need no proof).

mod common;

use common::*;
use quantum_vault_shield_v2::reference::PublicInputs;
use quantum_vault_shield_v2::verify_spend;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;

fn shield_req<'a>(chain: &Chain, key: &'a [u8], to: &'a ShieldedAddress, v_in: u64) -> ShieldRequest<'a> {
    ShieldRequest { ctx: chain.ctx(), from_pub_key: key, nonce: 1, v_in, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None }
}

/// Shields `values` (each + fee) to `to`, one block each, without proofs.
fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let tx = deterministic::shield(&shield_req(chain, &key, to, v + Q), &format!("fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
    let r = s.scan(&chain.page(s.next_height()), &keys.scan_key()).unwrap();
    assert!(r.at_tip);
    assert_eq!(s.anchor(), chain.state().tree_root, "the wallet's tree is the chain's tree");
    s
}

/// The whole life of a note with real proofs: shield → transfer (two inputs) → unshield, every
/// transaction accepted by the verifier and by the pool rules; balances, nullifiers and Merkle
/// roots follow; a restored wallet recovers the same; a note for someone else is ignored.
#[test]
fn shield_transfer_unshield_with_real_proofs() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    let key = fake_account_key(7);
    let check = |tx: &BuiltTx| {
        let pi = PublicInputs::from_bytes(&tx.public_inputs).unwrap();
        assert_eq!(pi.to_bytes()[..184], tx.body[42..226]);
        assert_eq!(pi.to_bytes()[184..], tx.binding);
        verify_spend(&pi, &tx.proof).expect("the built proof verifies");
        assert_eq!(tx.body.len(), BODY_BYTES);
        assert!(tx.proof.len() <= MAX_PROOF_BYTES);
        assert_eq!(tx.envelope.payload.shield_v2_body.as_deref(), Some(hex::encode(&tx.body).as_str()));
        assert_eq!(tx.envelope.fee.to_bits(), 0.0f64.to_bits());
        assert_eq!(tx.envelope.version, 1);
    };

    // two shields to Alice: 9 and 3 XRGE
    let s1 = build_shield(&shield_req(&chain, &key, &alice.address(), 10 * Q)).unwrap();
    check(&s1);
    assert_eq!(s1.envelope.tx_type, "shield_v2");
    assert_eq!(s1.envelope.from_pub_key, hex::encode(&key));
    assert_eq!(s1.envelope.sig, "");
    let signing = s1.signing_bytes.as_ref().expect("a shield returns the bytes to sign");
    assert!(std::str::from_utf8(signing).unwrap().contains(&hex::encode(&s1.proof)), "the signature covers the proof");
    assert!(std::str::from_utf8(signing).unwrap().contains(&hex::encode(&s1.body)), "and the body");
    assert_eq!(s1.signed_envelope("ab12").unwrap().sig, "ab12");
    assert!(s1.signed_envelope("AB12").is_err() && s1.signed_envelope("").is_err());
    chain.block(&[&s1.body]).unwrap();
    fund(&mut chain, &alice.address(), &[3 * Q]);

    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B]); // a NEW wallet: the user says so, and it spends at once
    assert_eq!(a.balance(), 12 * Q as u128);
    assert_eq!(a.notes().len(), 2);
    // one node's listing is not a confirmation: nothing is selected until two nodes agree on the root
    assert!(matches!(select_inputs(&a, 10 * Q, Q), Err(WalletError::InsufficientFunds { have: 0, .. })));
    assert_eq!((a.confirmed_balance(), a.unverified_balance()), (0, 12 * Q as u128));
    confirm(&chain, &mut a);
    assert_eq!((a.confirmed_balance(), a.unverified_balance()), (12 * Q as u128, 0));
    assert!(synced(&chain, &bob).notes().is_empty(), "a note encrypted to another address is ignored");

    // Alice pays Bob 10 with both notes; change 1
    let sel = select_inputs(&a, 10 * Q, Q).unwrap();
    assert_eq!((sel.positions.len(), sel.total, sel.change), (2, 12 * Q, Q));
    // build AND lock, one call (REVIEW_WALLET_3 RW3-5): the anchor is the confirmed root, the
    // expiry the confirmed height + 64, and the returned state already holds the pending entry
    let spend = SpendOptions { chain_id: CHAIN, inputs: &sel.positions, expiry_height: None, allow_unverified: false, max_fee: None };
    let stale = build_transfer(&a, a.revision() + 1, &alice, &TransferParams { spend: spend.clone(), recipient: &bob.address(), amount: 10 * Q, fee: Q });
    assert!(matches!(stale.map(|_| ()), Err(WalletError::StaleState)), "the state must be at the revision the caller read from its storage");
    let locked = build_transfer(&a, a.revision(), &alice, &TransferParams { spend, recipient: &bob.address(), amount: 10 * Q, fee: Q }).unwrap();
    let t = locked.tx;
    check(&t);
    assert_eq!(t.expiry_height, a.confirmed_height().unwrap() + DEFAULT_EXPIRY_OFFSET);
    assert_eq!((t.envelope.tx_type.as_str(), t.envelope.from_pub_key.as_str(), t.envelope.sig.as_str(), t.envelope.nonce), ("shielded_transfer_v2", "", "", 0));
    assert!(t.signing_bytes.is_none() && t.envelope.signed_payload.is_none());
    assert!(t.signed_envelope("ab").is_err());
    // the pending record: both nullifiers, both inputs, the change, the expiry
    let pending = t.pending().expect("a transfer has a pending record");
    assert_eq!((pending.inputs.clone(), pending.input_total, pending.expiry_height), (sel.positions.clone(), 12 * Q, t.expiry_height));
    assert_eq!(pending.outputs.iter().map(|c| c.0).collect::<Vec<_>>(), t.output_commitments().to_vec(), "and both output commitments");
    assert_eq!(pending.change.as_ref().map(|c| c.value), Some(Q));
    assert!(pending.change.as_ref().unwrap().r.is_some() && pending.own_payment.is_none(), "the change record opens its commitment by itself");
    assert!(s1.pending().is_none(), "a shield spends no note");
    // … and it is ALREADY in the state that came back with the transaction; the caller's own state is untouched
    assert!(a.pending().is_empty() && !a.is_locked(sel.positions[0]));
    let recorded = &locked.state.pending()[0];
    assert_eq!((&recorded.nullifiers, &recorded.outputs, &recorded.change, recorded.expiry_height), (&pending.nullifiers, &pending.outputs, &pending.change, pending.expiry_height));
    assert!(sel.positions.iter().all(|&p| locked.state.is_locked(p)) && locked.state.revision() == a.revision() + 1);
    assert!(a.mark_pending(pending.clone()).is_ok() && a.content_eq(&locked.state), "the same record, the same state");
    a = locked.state;
    assert_eq!(t.body[226..258], [0u8; 32]);
    let json: serde_json::Value = serde_json::from_str(&t.envelope_json().unwrap()).unwrap();
    assert_eq!(json["fee"].to_string(), "0.0");
    for (name, value) in json["payload"].as_object().unwrap() {
        assert_eq!(value.is_null(), !name.starts_with("shield_v2_"), "{name}: only the two V2 payload fields are set");
    }
    // the nullifiers the wallet stored are the ones the transaction publishes
    let mut stored: Vec<[u8; 32]> = a.notes().iter().map(|n| n.nullifier.unwrap().0).collect();
    let mut published = t.nullifiers().to_vec();
    stored.sort();
    published.sort();
    assert_eq!(stored, published);
    chain.block(&[&t.body]).unwrap();

    let r = a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!((r.spent.len(), r.received.len(), r.pending_seen_mined), (2, 1, 1));
    // seen in one node's listing: not settled, the change not confirmed
    assert_eq!(a.resolve().still_pending, 1);
    assert_eq!((a.balances().confirmed, a.balances().unverified), (0, Q as u128));
    confirm(&chain, &mut a);
    let settled = a.resolve();
    assert_eq!((settled.mined.len(), settled.superseded.len(), settled.expired.len(), settled.still_pending), (1, 0, 0, 0));
    assert_eq!(a.balances().confirmed, Q as u128, "the change is credited when the transaction settles as mined");
    assert_eq!(a.balance(), Q as u128);
    assert_eq!(a.anchor(), chain.state().tree_root);
    let mut b = synced(&chain, &bob);
    configure_as_sole_copy(&mut b, &[NODE_A, NODE_B]); // Bob's wallet is a new wallet too
    assert_eq!(b.balance(), 10 * Q as u128);
    // the sender's own record names the slot; the recipient found it by trying both
    let pay = t.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
    assert_eq!(b.notes()[0].cm.0, pay.cm);
    assert_eq!((b.notes()[0].value, b.notes()[0].r.0, b.notes()[0].output_index as usize), (pay.value, pay.r, pay.slot));

    // Bob unshields 6 to a public account; change 3
    let to = account_from_address(&address_from_account(&[0x42; 32])).unwrap();
    assert!(matches!(b.spend_input(b.notes()[0].position), Err(WalletError::NoteUnverified)), "an unverified note is not handed to a builder");
    confirm(&chain, &mut b);
    let positions = [b.notes()[0].position];
    let spend = SpendOptions { chain_id: CHAIN, inputs: &positions, expiry_height: None, allow_unverified: false, max_fee: None };
    let locked = build_unshield(&b, b.revision(), &bob, &UnshieldParams { spend, to_account: to, v_out: 6 * Q, fee: Q }).unwrap();
    let u = locked.tx;
    b = locked.state;
    check(&u);
    assert_eq!(u.envelope.tx_type, "unshield_v2");
    assert_eq!(u.body[226..258], [0x42; 32]);
    let before = chain.state().pool_total;
    chain.block(&[&u.body]).unwrap();
    assert_eq!(chain.state().pool_total, before - 7 * Q as u128);
    b.scan(&chain.page(b.next_height()), &bob.scan_key()).unwrap();
    assert_eq!(b.balance(), 3 * Q as u128);
    // replaying the same transaction: the pool refuses the spent nullifiers
    assert!(chain.block(&[&u.body]).is_err());

    // restore: keys + a full scan give exactly the incrementally built state
    let mut restored_a = synced(&chain, &alice);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut restored_a);
    confirm(&chain, &mut a);
    assert!(restored_a.content_eq(&a));
    let mut restored_b = synced(&chain, &bob);
    confirm(&chain, &mut restored_b);
    confirm(&chain, &mut b);
    assert_eq!(b.resolve().mined.len(), 1, "the unshield, which the builder recorded in the state it returned");
    assert!(restored_b.content_eq(&b));
}

/// Spec §5.4: a wallet restored from its keys and the chain recovers every unspent note, the
/// balance, the spent flags and working Merkle paths — and nothing about what it sent.
///
/// REVIEW_WALLET_6 (noted): this test used to spend from the restored, never-confirmed state
/// through `spend_input_with(.., true)` and the raw assembly, which no gate looks at. Both
/// spends now go through the gated path a client has (`build_*` without the proof): the
/// restored state builds NOTHING until it is confirmed and its embargo has run out, and then
/// its note is spent with the path the restore recovered.
#[test]
fn restore_recovers_notes_and_balance_but_no_outgoing_history() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 2 * Q]);
    fund(&mut chain, &bob.address(), &[8 * Q]);
    fund(&mut chain, &alice.address(), &[4 * Q]);
    let mut a = synced(&chain, &alice);
    assert_eq!(a.balance(), 11 * Q as u128);
    // (a NEW wallet on a new phrase: the user's statement, so that it can pay at once)
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B]);
    confirm(&chain, &mut a);

    // Alice pays Bob 6 from the 5 and the 2 (unproven: the pool rules and the scan need no proof)
    let sel = select_inputs(&a, 6 * Q, Q).unwrap();
    assert_eq!(sel.total, 7 * Q);
    let t = pay(&mut a, &alice, &sel.positions, &bob.address(), 6 * Q, "restore-transfer");
    chain.block(&[&t.body]).unwrap();
    fund(&mut chain, &bob.address(), &[Q]);

    let mut restored = synced(&chain, &alice);
    // every note ever sent to Alice: three shields (the zero-value change is not stored)
    assert_eq!(restored.notes().len(), 3);
    let unspent: Vec<u64> = restored.unspent().filter(|n| n.value > 0).map(|n| n.value).collect();
    assert_eq!(unspent, vec![4 * Q]);
    assert_eq!(restored.balance(), 4 * Q as u128);
    assert_eq!(restored.notes().iter().filter(|n| n.spent).count(), 2);
    assert!(restored.notes().iter().filter(|n| n.spent).all(|n| n.spent_height == Some(chain.height - 1)));
    // the unspent note's path leads to the chain's root — and the restored state still builds
    // NOTHING: it has no confirmed height, and once it has one it is under the restore embargo
    // (an earlier copy of the wallet may have a payment in flight)
    let unshield = |s: &WalletState, allow_unverified: bool| {
        let positions = [unspent_position(s, 4 * Q)];
        let spend = SpendOptions { chain_id: CHAIN, inputs: &positions, expiry_height: None, allow_unverified, max_fee: None };
        deterministic::unshield_locked(s, s.revision(), &alice, &UnshieldParams { spend, to_account: [9; 32], v_out: Q, fee: Q }, "restore-unshield")
    };
    assert!(matches!(unshield(&restored, true).err(), Some(WalletError::StateUnconfirmed)), "nothing confirmed: nothing is built, whatever allow_unverified says");
    confirm(&chain, &mut restored); // the two nodes, WITHOUT the user's statement: a restore
    let until = restored.spend_embargo_until().expect("the first state check fixed the embargo base");
    assert_eq!(until, chain.height + RESTORE_EMBARGO_BLOCKS);
    for allow_unverified in [false, true] {
        assert!(matches!(unshield(&restored, allow_unverified).err(), Some(WalletError::RestoredRecently { until: Some(u) }) if u == until), "the embargo applies to the restored state");
    }
    assert!(matches!(restored.spend_gate(), Err(WalletError::RestoredRecently { .. })) && !restored.spend_status(Some(chain.height)).can_spend_now);
    // … one block before its end, too
    chain.advance_to(until - 1);
    restored.scan(&chain.page(restored.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut restored);
    assert!(matches!(unshield(&restored, false).err(), Some(WalletError::RestoredRecently { .. })));
    // the embargo has run out: the note is spent, with the path the restore recovered
    chain.advance_to(until);
    restored.scan(&chain.page(restored.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut restored);
    let (again, locked) = unshield(&restored, false).unwrap();
    chain.block(&[&again.body]).unwrap();
    assert!(locked.is_locked(unspent_position(&restored, 4 * Q)) && !restored.is_locked(unspent_position(&restored, 4 * Q)));
    // no outgoing history: the restored state holds no record of the payment to Bob — not its
    // value, not its r. (Its commitment is public chain data and may appear as a Merkle sibling.)
    let pay = t.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
    let json = restored.to_json().unwrap();
    assert!(!json.contains(&hex::encode(pay.r)));
    assert!(restored.notes().iter().all(|n| n.cm.0 != pay.cm && n.r.0 != pay.r));
    // state survives serialisation
    assert_eq!(WalletState::from_json(&json).unwrap(), restored);

    // the viewing key alone: the same notes and values, no nullifiers, nothing marked spent
    let mut view = WalletState::new(alice.address().pk);
    view.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    assert_eq!(view.notes().len(), 4);
    assert!(view.notes().iter().all(|n| n.nullifier.is_none() && !n.spent));
    // a state is bound to one wallet
    assert!(view.scan(&chain.page(view.next_height()), &bob.scan_key()).is_err());
}

fn unspent_position(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).unwrap().position
}

/// Paging: the same chain read in two pages gives the same state as in one; a page that does not
/// continue the state, or that is malformed, is refused and changes nothing.
#[test]
fn scan_pages_must_continue_the_state() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[2 * Q]);
    let mut paged = synced(&chain, &alice);
    let first_next = paged.next_height();
    fund(&mut chain, &alice.address(), &[3 * Q, 4 * Q]);
    let before = paged.clone();

    // a page from too early (already-seen leaves) and from too late (skipped leaves)
    assert!(matches!(paged.scan(&chain.page(0), &alice.scan_key()), Err(WalletError::Listing(_))));
    assert!(matches!(paged.scan(&chain.page(first_next + 1), &alice.scan_key()), Err(WalletError::Listing(_))));
    assert_eq!(paged, before, "a refused page leaves the state untouched");
    // malformed entries
    let good = serde_json::json!({ "active": true, "tip_height": chain.height, "from_height": first_next, "next_height": chain.height + 1,
        "txs": serde_json::to_value(page_txs(&chain, first_next)).unwrap() });
    for (path, bad) in [
        ("nf1", serde_json::json!("zz")),
        ("nf1", serde_json::json!("FF".repeat(32))),
        ("nf2", serde_json::json!(good["txs"][0]["nf1"])),
        ("outputs", serde_json::json!([])),
        ("height", serde_json::json!(chain.height + 5)),
    ] {
        let mut v = good.clone();
        v["txs"][0][path] = bad;
        let page = ListingPage::from_json(&v.to_string()).unwrap();
        assert!(matches!(paged.scan(&page, &alice.scan_key()), Err(WalletError::Listing(_)) | Err(WalletError::NonCanonical(_))), "{path}");
        assert_eq!(paged, before);
    }
    for (field, bad) in [("cm_out", "00".repeat(31)), ("kem_ct", "00".repeat(1087)), ("note_ct", "0".repeat(111))] {
        let mut v = good.clone();
        v["txs"][0]["outputs"][1][field] = serde_json::json!(bad);
        assert!(paged.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).is_err(), "{field}");
    }
    let mut v = good.clone();
    v["txs"][0]["outputs"][0]["leaf"] = serde_json::Value::Null;
    assert!(paged.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).is_err());
    // transactions out of order
    let mut v = good.clone();
    v["txs"].as_array_mut().unwrap().swap(0, 1);
    assert!(paged.scan(&ListingPage::from_json(&v.to_string()).unwrap(), &alice.scan_key()).is_err());
    assert_eq!(paged, before);
    assert!(ListingPage::from_json("[]").is_err());

    // the right page
    paged.scan(&chain.page(first_next), &alice.scan_key()).unwrap();
    assert!(paged.content_eq(&synced(&chain, &alice)));
    assert_eq!(paged.balance(), 9 * Q as u128);
    // an inactive listing is a no-op
    let idle = ListingPage::from_json(r#"{"active":false,"tip_height":1,"from_height":0,"next_height":0,"txs":[]}"#).unwrap();
    let before = paged.clone();
    paged.scan(&idle, &alice.scan_key()).unwrap();
    assert_eq!(paged, before);
}

fn page_txs(chain: &Chain, since: u64) -> Vec<serde_json::Value> {
    // rebuild the JSON the stand-in lists (ListingPage itself is not serialisable on purpose)
    let page = chain.page(since);
    page.txs
        .iter()
        .map(|t| {
            serde_json::json!({ "height": t.height, "index": t.index, "tx_hash": t.tx_hash, "tx_type": t.tx_type, "nf1": t.nf1, "nf2": t.nf2,
                "outputs": t.outputs.iter().map(|o| serde_json::json!({ "cm_out": o.cm_out, "leaf": o.leaf, "kem_ct": o.kem_ct, "note_ct": o.note_ct })).collect::<Vec<_>>() })
        })
        .collect()
}

/// Coin selection: one note when one suffices (the smallest), else the tightest pair, else an
/// explicit "merge first"; and the merge plan itself, applied, makes the payment possible.
#[test]
fn selection_and_merge() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q, 2 * Q, 8 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut a);
    let value_of = |s: &WalletState, p: u64| s.note_at(p).unwrap().value;

    // one note: the smallest that covers amount + fee
    let s = select_inputs(&a, Q, Q).unwrap();
    assert_eq!((s.positions.len(), s.total, s.change), (1, 2 * Q, 0));
    let s = select_inputs(&a, 6 * Q, Q).unwrap();
    assert_eq!((s.positions.len(), s.total, s.change), (1, 8 * Q, Q));
    // two notes: the pair with the smallest sufficient total (need 10: 8+2, not 8+5 or 8+3)
    let s = select_inputs(&a, 9 * Q, Q).unwrap();
    assert_eq!((s.positions.len(), s.total, s.change), (2, 10 * Q, 0));
    let mut vals: Vec<u64> = s.positions.iter().map(|&p| value_of(&a, p)).collect();
    vals.sort();
    assert_eq!(vals, vec![2 * Q, 8 * Q]);
    // need 14 with fee 1: the best pair is 8+5 = 13 — three notes are needed
    match select_inputs(&a, 13 * Q, Q) {
        Err(WalletError::NeedsMerge { merges }) => assert_eq!(merges, 1),
        other => panic!("{other:?}"),
    }
    // 8+5+3+2 = 18; a payment of 15 needs all four notes: two merges (2 fees) + the payment's fee
    match select_inputs(&a, 15 * Q, Q) {
        Err(WalletError::NeedsMerge { merges }) => assert_eq!(merges, 2),
        other => panic!("{other:?}"),
    }
    // 16 + 1 + 2 merge fees = 19 > 18
    match select_inputs(&a, 16 * Q, Q) {
        Err(WalletError::InsufficientFunds { have, need }) => assert_eq!((have, need), (18 * Q as u128, 17 * Q as u128)),
        other => panic!("{other:?}"),
    }

    // the merge: the two largest notes into one (13 − 1 = 12), then the payment of 13 works
    let plan = plan_merge(&a, Q).unwrap();
    assert_eq!((plan.amount, plan.positions.len()), (12 * Q, 2));
    let inputs: Vec<SpendInput> = plan.positions.iter().map(|&p| a.spend_input(p).unwrap()).collect();
    let own = alice.address();
    let merge = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &own, amount: plan.amount, fee: plan.fee, max_fee: None },
        "merge",
    )
    .unwrap();
    // pending: the two notes are locked — not selected, not handed to a builder, not recorded twice
    a.mark_pending(merge.pending().unwrap()).unwrap();
    assert!(plan.positions.iter().all(|&p| a.is_locked(p)));
    assert!(matches!(select_inputs(&a, 13 * Q, Q), Err(WalletError::InsufficientFunds { .. })));
    assert!(matches!(a.spend_input(plan.positions[0]), Err(WalletError::NoteLocked)));
    assert!(a.mark_pending(merge.pending().unwrap()).is_err());
    assert!(matches!(plan_merge(&a, Q), Ok(p) if p.positions.iter().all(|x| !plan.positions.contains(x))), "a merge plan uses the other notes");
    assert_eq!(a.resolve().still_pending, 1, "nothing to settle yet");
    chain.block(&[&merge.body]).unwrap();
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.resolve().still_pending, 1, "listed by one node: not settled");
    assert_eq!(a.balance(), 17 * Q as u128);
    // the merged note is unverified until the state is confirmed again
    assert!(matches!(select_inputs(&a, 13 * Q, Q), Err(WalletError::InsufficientFunds { .. })));
    assert_eq!(select_inputs_with(&a, 13 * Q, Q, true).unwrap().total, 14 * Q);
    confirm(&chain, &mut a);
    assert_eq!(a.resolve().mined.len(), 1);
    // the notes are now 12, 3 and 2: 12 + 2 covers 13 + 1 exactly
    let s = select_inputs(&a, 13 * Q, Q).unwrap();
    assert_eq!((s.positions.len(), s.total, s.change), (2, 14 * Q, 0));
    let inputs: Vec<SpendInput> = s.positions.iter().map(|&p| a.spend_input(p).unwrap()).collect();
    let pay = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: 13 * Q, fee: Q, max_fee: None },
        "pay",
    )
    .unwrap();
    chain.block(&[&pay.body]).unwrap();
    assert_eq!(synced(&chain, &bob).balance(), 13 * Q as u128);
    // 3 XRGE left (the zero-value change notes of the merge and of the payment are not stored)
    assert_eq!(synced(&chain, &alice).balance(), 3 * Q as u128);

    // nothing to merge
    assert!(plan_merge(&WalletState::new(alice.address().pk), Q).is_err());
}

/// Every refusal of the builders happens before any proving, with its own error.
#[test]
fn builder_refusals() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[5 * Q, 3 * Q]);
    let a = synced(&chain, &alice);
    let key = fake_account_key(1);
    let addr = alice.address();
    let inputs: Vec<SpendInput> = a.unspent().map(|n| a.spend_input_with(n.position, true).unwrap()).collect();
    let min = SHIELD_V2_MIN_FEE_QUANTA;

    // shield
    let mut req = shield_req(&chain, &key, &addr, 10 * Q);
    req.fee = min - 1;
    assert!(matches!(build_shield(&req), Err(WalletError::FeeBelowMinimum { .. })));
    let mut req = shield_req(&chain, &key, &addr, min);
    req.fee = min;
    assert!(matches!(build_shield(&req), Err(WalletError::Request(_))), "v_in = fee shields nothing");
    assert!(matches!(build_shield(&shield_req(&chain, &key[..1951], &addr, 10 * Q)), Err(WalletError::Request(_))));
    assert!(matches!(build_shield(&shield_req(&chain, &key, &addr, u64::MAX)), Err(WalletError::Request(_))), "above the pool cap");
    let mut req = shield_req(&chain, &key, &addr, 10 * Q);
    req.ctx.anchor = [0xff; 32];
    assert!(matches!(build_shield(&req), Err(WalletError::NonCanonical(_))));
    // the operating system's generator fails: an error, nothing built
    assert!(matches!(
        deterministic::shield_with_failing_entropy(&shield_req(&chain, &key, &addr, 10 * Q)),
        Err(WalletError::Entropy(_))
    ));
    // the fee ceiling (I-4): 10 x the minimum unless the caller sets another
    let mut req = shield_req(&chain, &key, &addr, 100 * Q);
    req.fee = DEFAULT_MAX_FEE_QUANTA + 1;
    assert!(matches!(build_shield(&req), Err(WalletError::FeeAboveMaximum { .. })));
    req.max_fee = Some(2 * Q);
    req.fee = 2 * Q + 1;
    assert!(matches!(build_shield(&req), Err(WalletError::FeeAboveMaximum { .. })));
    req.max_fee = Some(20 * Q);
    req.fee = 20 * Q;
    assert!(deterministic::shield(&req, "fee-ceiling-raised").is_ok());
    // the expiry bound (F-7): above the anchor's height, at most 128 blocks after it
    for (expiry, ok) in [(chain.height, false), (chain.height + 1, true), (chain.height + 64, true), (chain.height + 128, true), (chain.height + 129, false), (u64::MAX, false)] {
        let mut req = shield_req(&chain, &key, &addr, 10 * Q);
        req.ctx.expiry_height = expiry;
        assert_eq!(deterministic::shield(&req, "expiry").is_ok(), ok, "expiry {expiry}");
        if !ok {
            assert!(matches!(build_shield(&req), Err(WalletError::Request(_))));
        }
    }
    assert_eq!(TxContext::new(CHAIN, chain.ctx().anchor, 40).expiry_height, 40 + DEFAULT_EXPIRY_OFFSET);

    // transfer
    let t = |inputs: &[SpendInput], amount: u64, fee: u64, ctx: TxContext| {
        deterministic::transfer(&TransferRequest { ctx, keys: &alice, inputs, recipient: &bob.address(), amount, fee, max_fee: None }, "refused").map(|_| ())
    };
    assert!(matches!(t(&inputs, Q, min - 1, chain.ctx()), Err(WalletError::FeeBelowMinimum { .. })));
    assert!(matches!(t(&inputs, Q, 11 * min, chain.ctx()), Err(WalletError::FeeAboveMaximum { .. })));
    assert!(matches!(deterministic::transfer_with_failing_entropy(&TransferRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, recipient: &bob.address(), amount: Q, fee: min, max_fee: None }), Err(WalletError::Entropy(_))));
    assert!(matches!(t(&inputs, 0, min, chain.ctx()), Err(WalletError::Request(_))));
    assert!(matches!(t(&inputs, 8 * Q, min, chain.ctx()), Err(WalletError::InsufficientFunds { .. })));
    assert!(matches!(t(&[], Q, min, chain.ctx()), Err(WalletError::InsufficientFunds { .. })));
    let three = [inputs[0].clone(), inputs[1].clone(), inputs[0].clone()];
    assert!(matches!(t(&three, Q, min, chain.ctx()), Err(WalletError::Request(_))));
    let twice = [inputs[0].clone(), inputs[0].clone()];
    assert!(matches!(t(&twice, Q, min, chain.ctx()), Err(WalletError::Request(_))), "one note in both slots");
    // an anchor the wallet's paths do not lead to (a stale or foreign root)
    let mut ctx = chain.ctx();
    ctx.anchor = WalletState::new([0; 32]).anchor();
    assert!(matches!(t(&inputs, Q, min, ctx), Err(WalletError::AnchorMismatch)));
    // another wallet's key cannot spend Alice's notes: its pk gives another commitment
    assert!(matches!(
        deterministic::transfer(&TransferRequest { ctx: chain.ctx(), keys: &bob, inputs: &inputs, recipient: &addr, amount: Q, fee: min, max_fee: None }, "refused").map(|_| ()),
        Err(WalletError::AnchorMismatch)
    ));
    // a damaged path
    let mut bad = inputs.clone();
    bad[0].path.pop();
    assert!(matches!(t(&bad, Q, min, chain.ctx()), Err(WalletError::State(_))));
    let mut bad = inputs.clone();
    bad[0].path[3] = [0xff; 32];
    assert!(matches!(t(&bad, Q, min, chain.ctx()), Err(WalletError::NonCanonical(_))));

    // unshield
    let u = |v_out: u64, fee: u64| {
        deterministic::unshield(&UnshieldRequest { ctx: chain.ctx(), keys: &alice, inputs: &inputs, to_account: [1; 32], v_out, fee, max_fee: None }, "refused").map(|_| ())
    };
    assert!(matches!(u(0, min), Err(WalletError::Request(_))));
    assert!(matches!(u(Q, 0), Err(WalletError::FeeBelowMinimum { .. })));
    assert!(matches!(u(8 * Q, min), Err(WalletError::InsufficientFunds { .. })));
}

/// Spec §5.6 / §5.7: every transaction draws fresh dummy secrets, fresh `r` and fresh
/// encapsulations — two builds of the same request share no nullifier, commitment or ciphertext.
#[test]
fn every_build_draws_fresh_randomness() {
    use quantum_vault_shield_v2_wallet::body::Body;
    let alice = keys(PHRASE_1);
    let chain = Chain::new();
    let key = fake_account_key(1);
    let addr = alice.address();
    // the production assembly (operating-system entropy), without the proof
    let build = || Body::decode(&deterministic::shield_with_os_entropy(&shield_req(&chain, &key, &addr, 10 * Q)).unwrap().body).unwrap();
    let (a, b) = (build(), build());
    // (and the labelled test stream is reproducible, which is what the vectors rely on)
    let det = |l: &str| deterministic::shield(&shield_req(&chain, &key, &addr, 10 * Q), l).unwrap().body;
    assert_eq!(det("x"), det("x"));
    assert_ne!(det("x"), det("y"));
    for x in a.nf {
        assert!(!b.nf.contains(&x));
    }
    for x in a.cm_out {
        assert!(!b.cm_out.contains(&x));
    }
    assert_ne!(a.kem_ct[0].to_vec(), b.kem_ct[0].to_vec());
    assert_ne!(a.note_ct, b.note_ct);
}
