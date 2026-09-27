//! Pure replay rules that the node-level parity test cannot reach cheaply (slash tx, record
//! deletion, jail expiry, contiguity, fail-closed outcomes).
use quantum_vault_finality::validator_replay::*;
use quantum_vault_types::{BlockHeaderV1, BlockV1, TxPayload, TxV1};

fn tx(ty: &str, from: &str, amount: Option<u64>, target: Option<&str>) -> TxV1 {
    TxV1 { version: 1, tx_type: ty.into(), from_pub_key: from.into(), nonce: 0, payload: TxPayload { amount, target_pub_key: target.map(|s| s.to_string()), ..Default::default() }, fee: 0.0, sig: String::new(), signed_payload: None }
}
fn block(h: u64, proposer: &str, txs: Vec<TxV1>) -> BlockV1 {
    BlockV1 { version: 1, header: BlockHeaderV1 { version: 1, chain_id: "t".into(), height: h, time: 0, prev_hash: String::new(), tx_hash: String::new(), proposer_pub_key: proposer.into(), state_root: None }, txs, proposer_sig: String::new(), hash: String::new() }
}
fn base() -> ValidatorReplay { ValidatorReplay::new(0, vec![("a".to_string(), VState { stake: 1000, ..Default::default() }), ("b".to_string(), VState { stake: 100, ..Default::default() })]) }
const OK: &dyn Fn(u64, usize, &TxV1) -> Option<bool> = &|_, _, _| Some(true);

#[test]
fn slash_tx_cuts_a_tenth_jails_for_twenty_blocks_and_eligibility_returns_exactly_at_expiry() {
    let mut r = base();
    r.apply_block(&block(1, "a", vec![tx("slash", "a", None, Some("b"))]), OK).unwrap();
    assert_eq!(r.state()["b"], VState { stake: 90, slash_count: 1, jailed_until: 21, missed_blocks: 0 });
    assert_eq!(r.snapshot_for_next().stake_of("b"), None, "jailed ⇒ not in the set for height 2");
    for h in 2..=20 { r.apply_block(&block(h, "a", vec![]), OK).unwrap(); assert_eq!(r.snapshot_for_next().stake_of("b"), None, "set for {}", h + 1); }
    r.apply_block(&block(21, "a", vec![]), OK).unwrap();
    assert_eq!(r.snapshot_for_next().stake_of("b"), Some(90), "jailed_until (21) <= tip (21) ⇒ eligible for height 22");
    assert_eq!(r.state()["b"].missed_blocks, 1, "missed-block counting resumes only once the jail has expired");
}

#[test]
fn zeroed_clean_record_is_deleted_but_a_slashed_one_is_kept() {
    let mut r = base();
    r.apply_block(&block(1, "a", vec![tx("unstake", "b", Some(100), None)]), OK).unwrap();
    assert!(!r.state().contains_key("b"), "stake 0, never slashed, not jailed ⇒ record deleted (as the node does)");
    r.apply_block(&block(2, "a", vec![tx("slash", "a", None, Some("ghost"))]), OK).unwrap();
    assert_eq!(r.state()["ghost"], VState { stake: 0, slash_count: 1, jailed_until: 22, missed_blocks: 0 }, "slashing an unknown key creates a kept zero-stake record");
    assert_eq!(r.snapshot_for_next().entries().len(), 1);
    r.apply_block(&block(3, "a", vec![tx("unstake", "a", Some(5000), None)]), OK).unwrap();
    assert!(!r.state().contains_key("a"), "saturating unstake");
    assert_eq!(r.snapshot_for_next().quorum(), None, "empty set ⇒ no quorum ⇒ nothing can finalize");
}

#[test]
fn unknown_outcome_non_contiguous_blocks_and_missing_history_fail_closed() {
    let mut r = base();
    assert_eq!(r.apply_block(&block(1, "a", vec![tx("stake", "c", Some(5), None)]), &|_, _, _| None), Err(ReplayError::OutcomeUnavailable { height: 1, tx_index: 0 }));
    let mut r = base();
    assert_eq!(r.apply_block(&block(2, "a", vec![]), OK), Err(ReplayError::NonContiguous { expected: 1, got: 2 }));
    assert!(matches!(r.derive_for(5, &|_h| Ok(None), OK), Err(ReplayError::HistoryUnavailable(_))));
    let mut r = ValidatorReplay::new(48, vec![]);
    assert_eq!(r.derive_for(48, &|_h| Ok(None), OK), Err(ReplayError::TargetBelowBase { base: 48, target: 48 }), "heights at/below the pinned base are not derivable");
    assert!(r.derive_for(49, &|_h| Ok(None), OK).is_ok(), "the set for base+1 is the base itself");
    // a FAILED stake changes nothing
    let mut r = base(); r.apply_block(&block(1, "a", vec![tx("stake", "c", Some(5), None)]), &|_, _, _| Some(false)).unwrap();
    assert!(!r.state().contains_key("c"));
}
