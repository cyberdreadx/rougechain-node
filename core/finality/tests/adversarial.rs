//! FINALITY_V2 adversarial tests — real ML-DSA-65 keys throughout.
use quantum_vault_crypto::{pqc_keygen_from_seed, pqc_sign};
use quantum_vault_types::PQKeypair;
use quantum_vault_finality::*;
use quantum_vault_types::{FinalityProof, VoteMessage};

const CHAIN: &str = "rougechain-mainnet-1";
const H: u64 = 100;
fn hash(b: u8) -> String { format!("{:02x}", b).repeat(32) }
fn kp(n: u8) -> PQKeypair { pqc_keygen_from_seed(&[n; 32]) }
/// three validators 50 / 30 / 20 → total 100, quorum 67
fn vals() -> (Vec<PQKeypair>, ValidatorSetSnapshot) {
    let k = vec![kp(1), kp(2), kp(3)];
    let s = ValidatorSetSnapshot::new(H, vec![(k[0].public_key_hex.clone(), 50), (k[1].public_key_hex.clone(), 30), (k[2].public_key_hex.clone(), 20)]);
    (k, s)
}
fn vote(k: &PQKeypair, chain: &str, ty: &str, height: u64, round: u32, bh: &str) -> VoteMessage {
    let sig = pqc_sign(&k.secret_key_hex, &vote_signing_message(chain, ty, height, round, bh)).unwrap();
    VoteMessage { vote_type: ty.into(), height, round, block_hash: bh.into(), voter_pub_key: k.public_key_hex.clone(), signature: sig }
}
fn pc(k: &PQKeypair, bh: &str) -> VoteMessage { vote(k, CHAIN, PRECOMMIT, H, 0, bh) }
macro_rules! ctx { ($s:expr, $bh:expr) => { VoteContext { chain_id: CHAIN, height: H, stored_block_hash: $bh, validators: $s } }; }
fn proof_of(votes: Vec<VoteMessage>, bh: &str, voting: u128) -> FinalityProof {
    FinalityProof { height: H, block_hash: bh.into(), total_stake: 100, voting_stake: voting, quorum_threshold: 67, precommit_votes: votes, created_at: 0 }
}

#[test]
fn quorum_is_floor_two_thirds_plus_one_and_checked() {
    let q = |s: Vec<u128>| ValidatorSetSnapshot::new(1, s.into_iter().enumerate().map(|(i, x)| (format!("v{i}"), x))).quorum();
    assert_eq!((q(vec![100]), q(vec![50, 30, 20]), q(vec![1, 1, 1]), q(vec![3]), q(vec![110_000])), (Some(67), Some(67), Some(3), Some(3), Some(73_334)));
    assert_eq!(q(vec![]), None); assert_eq!(q(vec![0, 0]), None, "zero-stake entries are not validators");
    assert_eq!(q(vec![u128::MAX, 1]), None, "overflow fails closed"); assert_eq!(q(vec![u128::MAX / 2 + 1]), None);
}

#[test]
fn honest_votes_reach_quorum_and_the_proof_verifies_standalone() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh);
    let mut book = VoteBook::new(H);
    assert_eq!(book.submit(pc(&k[0], &bh), &c), Ok(true));
    assert!(book.build_proof(&c, 0).unwrap().is_none(), "50 < 67");
    assert_eq!(book.submit(pc(&k[2], &bh), &c), Ok(true));
    let p = book.build_proof(&c, 0).unwrap().expect("50 + 20 >= 67");
    let v = verify_finality_proof(&p, &c).unwrap();
    assert_eq!((v.voting_stake, v.total_stake, v.quorum, v.voters.len()), (70, 100, 67, 2));
}

#[test]
fn forged_vote_real_validator_pubkey_fake_signature_is_rejected() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh); let attacker = kp(9);
    // (a) garbage signature, (b) well-formed signature by ANOTHER key over the right message,
    // (c) the legacy trick: sign the legacy message with a node key and CLAIM the top validator
    let mut a = pc(&k[0], &bh); a.signature = "00".repeat(3309);
    let mut b = pc(&attacker, &bh); b.voter_pub_key = k[0].public_key_hex.clone();
    let legacy_sig = pqc_sign(&attacker.secret_key_hex, format!("ROUGECHAIN_VOTE:{}:{}:{}", H, 0, bh).as_bytes()).unwrap();
    let l = VoteMessage { vote_type: PRECOMMIT.into(), height: H, round: 0, block_hash: bh.clone(), voter_pub_key: k[0].public_key_hex.clone(), signature: legacy_sig };
    let mut own_legacy = l.clone(); own_legacy.signature = pqc_sign(&k[0].secret_key_hex, format!("ROUGECHAIN_VOTE:{}:{}:{}", H, 0, bh).as_bytes()).unwrap();
    let mut e = pc(&k[0], &bh); e.signature = "sig_error".into();
    for v in [a, b, l, own_legacy, e] {
        assert_eq!(validate_vote(&v, &c), Err(FinalityError::BadSignature));
        assert_eq!(VoteBook::new(H).submit(v.clone(), &c), Err(FinalityError::BadSignature));
        assert_eq!(verify_finality_proof(&proof_of(vec![v, pc(&k[1], &bh)], &bh, 80), &c), Err(FinalityError::BadSignature), "a proof with valid-looking stake numbers but an invalid signature");
    }
}

#[test]
fn valid_signature_for_the_wrong_block_hash_is_rejected() {
    let (k, s) = vals(); let (stored, other) = (hash(0xaa), hash(0xbb)); let c = ctx!(&s, &stored);
    let v = pc(&k[0], &other); // perfectly signed — for a block this node did not accept
    assert_eq!(validate_vote(&v, &c), Err(FinalityError::BlockHashMismatch));
    let mut upper = pc(&k[0], &stored); upper.block_hash = stored.to_uppercase();
    assert_eq!(validate_vote(&upper, &c), Err(FinalityError::MalformedBlockHash));
    let mut swapped = pc(&k[0], &other); swapped.block_hash = stored.clone(); // signature covers `other`
    assert_eq!(validate_vote(&swapped, &c), Err(FinalityError::BadSignature));
}

#[test]
fn mixed_hash_precommits_cannot_combine_into_a_quorum() {
    let (k, s) = vals(); let (a, b) = (hash(0xaa), hash(0xbb));
    // 50 stake precommits A, 30 + 20 precommit B. Legacy code summed all 100 and named A.
    let votes = vec![pc(&k[0], &a), pc(&k[1], &b), pc(&k[2], &b)];
    for stored in [&a, &b] {
        let c = ctx!(&s, stored);
        assert_eq!(verify_finality_proof(&proof_of(votes.clone(), stored, 100), &c), Err(FinalityError::BlockHashMismatch));
        let mut book = VoteBook::new(H); let mut ok = 0; for v in &votes { if book.submit(v.clone(), &c).is_ok() { ok += 1; } }
        assert!(book.build_proof(&c, 0).unwrap().is_none(), "{ok} same-hash votes are below quorum (50 or 50)");
    }
}

#[test]
fn duplicate_validator_cannot_add_stake_twice() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh);
    let mut book = VoteBook::new(H);
    assert_eq!(book.submit(pc(&k[0], &bh), &c), Ok(true));
    assert_eq!(book.submit(pc(&k[0], &bh), &c), Ok(false), "ML-DSA is randomized: a second, different, valid signature is still the same vote");
    assert!(book.build_proof(&c, 0).unwrap().is_none(), "still 50 < 67");
    assert_eq!(verify_finality_proof(&proof_of(vec![pc(&k[0], &bh), pc(&k[0], &bh)], &bh, 100), &c), Err(FinalityError::DuplicateVoterInProof));
    // a conflicting vote from the same validator is never admitted, so it can never count
    assert_eq!(book.submit(pc(&k[0], &hash(0xbb)), &c), Err(FinalityError::BlockHashMismatch));
    assert_eq!(book.len(), 1);
}

#[test]
fn prevote_cannot_be_replayed_as_precommit() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh);
    let pv0 = vote(&k[0], CHAIN, PREVOTE, H, 0, &bh); let pv1 = vote(&k[1], CHAIN, PREVOTE, H, 0, &bh);
    assert!(validate_vote(&pv0, &c).is_ok());
    let relabel = |v: &VoteMessage| { let mut r = v.clone(); r.vote_type = PRECOMMIT.into(); r };
    assert_eq!(validate_vote(&relabel(&pv0), &c), Err(FinalityError::BadSignature), "vote type is inside the signed message");
    assert_eq!(verify_finality_proof(&proof_of(vec![relabel(&pv0), relabel(&pv1)], &bh, 80), &c), Err(FinalityError::BadSignature));
    assert_eq!(verify_finality_proof(&proof_of(vec![pv0.clone(), pv1.clone()], &bh, 80), &c), Err(FinalityError::NonPrecommitInProof));
    // prevotes never count toward finality
    let mut book = VoteBook::new(H); book.submit(pv0, &c).unwrap(); book.submit(pv1, &c).unwrap();
    assert!(book.build_proof(&c, 0).unwrap().is_none());
    for bad in ["", "commit", "PRECOMMIT", "precommit "] { let mut v = pc(&k[0], &bh); v.vote_type = bad.into(); assert_eq!(validate_vote(&v, &c), Err(FinalityError::BadVoteType)); }
}

#[test]
fn wrong_round_height_or_chain_is_rejected() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh);
    assert_eq!(validate_vote(&vote(&k[0], CHAIN, PRECOMMIT, H, 1, &bh), &c), Err(FinalityError::WrongRound { round: 1 }));
    let mut r = pc(&k[0], &bh); r.round = 1; assert_eq!(validate_vote(&r, &c), Err(FinalityError::WrongRound { round: 1 }));
    assert_eq!(validate_vote(&vote(&k[0], CHAIN, PRECOMMIT, H + 1, 0, &bh), &c), Err(FinalityError::WrongHeight { expected: H, got: H + 1 }));
    let mut h = pc(&k[0], &bh); h.height = H; h.signature = vote(&k[0], CHAIN, PRECOMMIT, H - 1, 0, &bh).signature; // replay of height H-1's signature
    assert_eq!(validate_vote(&h, &c), Err(FinalityError::BadSignature));
    assert_eq!(validate_vote(&vote(&k[0], "rougechain-testnet-1", PRECOMMIT, H, 0, &bh), &c), Err(FinalityError::BadSignature), "cross-chain replay");
    let stale = ValidatorSetSnapshot::new(H - 1, s.entries().clone());
    assert_eq!(validate_vote(&pc(&k[0], &bh), &VoteContext { chain_id: CHAIN, height: H, stored_block_hash: &bh, validators: &stale }), Err(FinalityError::SnapshotHeightMismatch { snapshot: H - 1, height: H }));
}

#[test]
fn unknown_jailed_or_zero_stake_voters_never_count() {
    let (k, _) = vals(); let bh = hash(0xaa); let outsider = kp(7);
    // k[1] is jailed (absent from the eligible snapshot); k[2] has zero stake
    let s = ValidatorSetSnapshot::new(H, vec![(k[0].public_key_hex.clone(), 50), (k[2].public_key_hex.clone(), 0)]);
    let c = ctx!(&s, &bh);
    for v in [pc(&outsider, &bh), pc(&k[1], &bh), pc(&k[2], &bh)] { assert_eq!(validate_vote(&v, &c), Err(FinalityError::UnknownOrIneligibleValidator)); }
    assert_eq!((s.total_stake(), s.quorum()), (Some(50), Some(34)));
    let empty = ValidatorSetSnapshot::new(H, vec![]);
    assert_eq!(verify_finality_proof(&proof_of(vec![], &bh, 0), &ctx!(&empty, &bh)), Err(FinalityError::EmptyValidatorSet));
}

#[test]
fn tampered_aggregate_fields_are_claims_not_inputs() {
    let (k, s) = vals(); let bh = hash(0xaa); let c = ctx!(&s, &bh);
    let good = proof_of(vec![pc(&k[0], &bh), pc(&k[1], &bh)], &bh, 80);
    assert!(verify_finality_proof(&good, &c).is_ok());
    let t = |f: fn(&mut FinalityProof)| { let mut p = good.clone(); f(&mut p); verify_finality_proof(&p, &c) };
    assert_eq!(t(|p| p.voting_stake = 100), Err(FinalityError::AggregateClaimMismatch { field: "voting_stake" }));
    assert_eq!(t(|p| p.total_stake = 80), Err(FinalityError::AggregateClaimMismatch { field: "total_stake" }));
    assert_eq!(t(|p| p.quorum_threshold = 1), Err(FinalityError::AggregateClaimMismatch { field: "quorum_threshold" }));
    // inflated numbers cannot rescue a below-quorum proof: 50 real stake, claims say 100/100/1
    let mut weak = proof_of(vec![pc(&k[0], &bh)], &bh, 100); weak.quorum_threshold = 1;
    assert_eq!(verify_finality_proof(&weak, &c), Err(FinalityError::BelowQuorum { voting_stake: 50, quorum: 67 }));
    // the legacy-shaped proof the Step 2.1 adapter used to accept: numbers only, no votes
    assert_eq!(verify_finality_proof(&proof_of(vec![], &bh, 100), &c), Err(FinalityError::BelowQuorum { voting_stake: 0, quorum: 67 }));
}

#[test]
fn proof_referencing_another_block_or_height_is_rejected() {
    let (k, s) = vals(); let (stored, other) = (hash(0xaa), hash(0xbb));
    // a fully valid proof … for a block this node never accepted
    let foreign = proof_of(vec![pc(&k[0], &other), pc(&k[1], &other)], &other, 80);
    assert!(verify_finality_proof(&foreign, &ctx!(&s, &other)).is_ok());
    assert_eq!(verify_finality_proof(&foreign, &ctx!(&s, &stored)), Err(FinalityError::ProofBlockHashMismatch));
    let mut relabelled = foreign.clone(); relabelled.block_hash = stored.clone();
    assert_eq!(verify_finality_proof(&relabelled, &ctx!(&s, &stored)), Err(FinalityError::BlockHashMismatch));
    let mut wrong_h = proof_of(vec![pc(&k[0], &stored), pc(&k[1], &stored)], &stored, 80); wrong_h.height = H + 1;
    assert_eq!(verify_finality_proof(&wrong_h, &ctx!(&s, &stored)), Err(FinalityError::ProofHeightMismatch));
    let mut huge = proof_of(vec![], &stored, 80); huge.precommit_votes = vec![pc(&k[0], &stored); MAX_PROOF_VOTES + 1];
    assert_eq!(verify_finality_proof(&huge, &ctx!(&s, &stored)), Err(FinalityError::TooManyVotes));
    let mut bad = proof_of(vec![], &stored, 80); bad.block_hash = "xyz".into();
    assert_eq!(verify_finality_proof(&bad, &ctx!(&s, &stored)), Err(FinalityError::MalformedBlockHash));
}

#[test]
fn signing_message_is_frozen() {
    assert_eq!(String::from_utf8(vote_signing_message(CHAIN, PRECOMMIT, 100, 0, &hash(0xaa))).unwrap(),
        format!("ROUGECHAIN_FINALITY_VOTE_V2|chain=rougechain-mainnet-1|type=precommit|height=100|round=0|block={}", "aa".repeat(32)));
}
