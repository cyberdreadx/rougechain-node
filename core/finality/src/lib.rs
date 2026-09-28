//! FINALITY_V2 — the minimum safe finality rule required before any BridgeVaultV3 root can be
//! called authoritative. See `research/bridge-v3-phase2b/STEP2_2_FINALITY_AND_ACTIVATION.md`.
//!
//! Nothing here trusts a claim. A vote counts only if its ML-DSA-65 signature verifies against
//! the voter's OWN key over a message that commits to domain, chain id, vote type, height, round
//! and block hash; a proof counts only if quorum can be RECOMPUTED from its verified votes and an
//! authoritative validator-set snapshot. `voting_stake`, `total_stake` and `quorum_threshold`
//! carried inside a proof are claims that must match the recomputation — never inputs.
//!
//! The legacy vote message (`ROUGECHAIN_VOTE:<height>:<round>:<hash>`) has no domain, no chain
//! id and no vote type, and legacy nodes signed it with the node key while CLAIMING the
//! highest-staked validator's identity. Legacy votes and legacy proofs never verify here.
pub mod journal;
pub mod validator_replay;

use quantum_vault_crypto::pqc_verify;
use quantum_vault_types::{FinalityProof, VoteMessage};
use std::collections::{BTreeMap, BTreeSet};

pub const VOTE_DOMAIN_V2: &str = "ROUGECHAIN_FINALITY_VOTE_V2";
pub const PREVOTE: &str = "prevote";
pub const PRECOMMIT: &str = "precommit";
/// FINALITY_V2 has exactly one round. RougeChain has no round-change / locking protocol, so
/// accepting votes from several rounds would let one validator honestly precommit two different
/// blocks at one height. Any other round is rejected until a real multi-round protocol exists.
pub const ONLY_ROUND: u32 = 0;
/// Hard cap on proof size (votes), independent of the validator set, so a malformed proof
/// cannot make the verifier do unbounded signature work.
pub const MAX_PROOF_VOTES: usize = 1024;

/// The exact bytes a validator signs. Every field is length-unambiguous: fixed labels, decimal
/// integers, lowercase 64-hex hash, `|` separators that cannot occur inside any field.
pub fn vote_signing_message(chain_id: &str, vote_type: &str, height: u64, round: u32, block_hash: &str) -> Vec<u8> {
    format!("{VOTE_DOMAIN_V2}|chain={chain_id}|type={vote_type}|height={height}|round={round}|block={block_hash}").into_bytes()
}

/// Eligible validators (non-jailed, stake > 0) applicable to ONE height: the validator state
/// after block `height - 1`, i.e. the set everyone knew before block `height` existed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatorSetSnapshot { pub height: u64, stakes: BTreeMap<String, u128> }

impl ValidatorSetSnapshot {
    /// Zero-stake entries are dropped: they are not validators.
    pub fn new(height: u64, stakes: impl IntoIterator<Item = (String, u128)>) -> Self {
        Self { height, stakes: stakes.into_iter().filter(|(_, s)| *s > 0).collect() }
    }
    pub fn stake_of(&self, pub_key: &str) -> Option<u128> { self.stakes.get(pub_key).copied() }
    pub fn entries(&self) -> &BTreeMap<String, u128> { &self.stakes }
    pub fn total_stake(&self) -> Option<u128> { self.stakes.values().try_fold(0u128, |a, s| a.checked_add(*s)) }
    /// floor(2 * total / 3) + 1, checked. `None` for an empty set or on overflow.
    pub fn quorum(&self) -> Option<u128> {
        let total = self.total_stake()?;
        if total == 0 { return None; }
        total.checked_mul(2)?.checked_div(3)?.checked_add(1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalityError {
    BadVoteType, WrongRound { round: u32 }, WrongHeight { expected: u64, got: u64 }, MalformedBlockHash,
    /// the vote is not for the block this node accepted and stored at that height
    BlockHashMismatch, SnapshotHeightMismatch { snapshot: u64, height: u64 },
    UnknownOrIneligibleValidator, BadSignature, EmptyValidatorSet, StakeOverflow,
    // proof-level
    ProofHeightMismatch, ProofBlockHashMismatch, TooManyVotes, NonPrecommitInProof, DuplicateVoterInProof,
    BelowQuorum { voting_stake: u128, quorum: u128 },
    /// the aggregate numbers written in the proof do not equal the recomputed ones
    AggregateClaimMismatch { field: &'static str },
}

fn is_hash(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

/// What a vote is validated AGAINST — all supplied by the verifier, none taken from the vote.
pub struct VoteContext<'a> {
    pub chain_id: &'a str,
    pub height: u64,
    /// hash of the block this node ACCEPTED AND STORED at `height`
    pub stored_block_hash: &'a str,
    pub validators: &'a ValidatorSetSnapshot,
}

/// Validate one vote. Returns the voter's stake.
pub fn validate_vote(vote: &VoteMessage, ctx: &VoteContext) -> Result<u128, FinalityError> {
    if vote.vote_type != PREVOTE && vote.vote_type != PRECOMMIT { return Err(FinalityError::BadVoteType); }
    if vote.round != ONLY_ROUND { return Err(FinalityError::WrongRound { round: vote.round }); }
    if vote.height != ctx.height { return Err(FinalityError::WrongHeight { expected: ctx.height, got: vote.height }); }
    if ctx.validators.height != ctx.height { return Err(FinalityError::SnapshotHeightMismatch { snapshot: ctx.validators.height, height: ctx.height }); }
    if !is_hash(&vote.block_hash) || !is_hash(ctx.stored_block_hash) { return Err(FinalityError::MalformedBlockHash); }
    if vote.block_hash != ctx.stored_block_hash { return Err(FinalityError::BlockHashMismatch); }
    let stake = ctx.validators.stake_of(&vote.voter_pub_key).ok_or(FinalityError::UnknownOrIneligibleValidator)?;
    let msg = vote_signing_message(ctx.chain_id, &vote.vote_type, vote.height, vote.round, &vote.block_hash);
    match pqc_verify(&vote.voter_pub_key, &msg, &vote.signature) { Ok(true) => Ok(stake), _ => Err(FinalityError::BadSignature) }
}

/// Validated votes for ONE height. Each (validator, vote type) holds at most one vote; a
/// resubmission never adds stake. Because `validate_vote` only admits the stored block hash,
/// a conflicting vote can never be admitted — it is rejected, and reported, never counted.
pub struct VoteBook { height: u64, votes: BTreeMap<(String, String), VoteMessage> }

impl VoteBook {
    pub fn new(height: u64) -> Self { Self { height, votes: BTreeMap::new() } }
    pub fn height(&self) -> u64 { self.height }
    /// `Ok(true)` = newly recorded, `Ok(false)` = duplicate (ignored).
    pub fn submit(&mut self, vote: VoteMessage, ctx: &VoteContext) -> Result<bool, FinalityError> {
        if ctx.height != self.height { return Err(FinalityError::WrongHeight { expected: self.height, got: ctx.height }); }
        validate_vote(&vote, ctx)?;
        let key = (vote.voter_pub_key.clone(), vote.vote_type.clone());
        if self.votes.contains_key(&key) { return Ok(false); }
        self.votes.insert(key, vote);
        Ok(true)
    }
    pub fn precommits(&self) -> Vec<VoteMessage> { self.votes.iter().filter(|((_, t), _)| t == PRECOMMIT).map(|(_, v)| v.clone()).collect() }
    pub fn len(&self) -> usize { self.votes.len() }
    pub fn is_empty(&self) -> bool { self.votes.is_empty() }
    /// Build a proof iff the recorded precommits reach quorum. The result is always re-verified.
    pub fn build_proof(&self, ctx: &VoteContext, created_at: u64) -> Result<Option<FinalityProof>, FinalityError> {
        let precommits = self.precommits(); // BTreeMap order ⇒ deterministic vote order
        let quorum = ctx.validators.quorum().ok_or(FinalityError::EmptyValidatorSet)?;
        let total = ctx.validators.total_stake().ok_or(FinalityError::StakeOverflow)?;
        let voting = precommits.iter().try_fold(0u128, |a, v| a.checked_add(ctx.validators.stake_of(&v.voter_pub_key)?)).ok_or(FinalityError::StakeOverflow)?;
        if voting < quorum { return Ok(None); }
        let proof = FinalityProof { height: ctx.height, block_hash: ctx.stored_block_hash.to_string(), total_stake: total, voting_stake: voting, quorum_threshold: quorum, precommit_votes: precommits, created_at };
        verify_finality_proof(&proof, ctx)?;
        Ok(Some(proof))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedFinality { pub height: u64, pub block_hash: String, pub voting_stake: u128, pub total_stake: u128, pub quorum: u128, pub voters: BTreeSet<String> }

/// Standalone verification: recompute everything from the votes and the snapshot.
pub fn verify_finality_proof(proof: &FinalityProof, ctx: &VoteContext) -> Result<VerifiedFinality, FinalityError> {
    if proof.height != ctx.height { return Err(FinalityError::ProofHeightMismatch); }
    if !is_hash(&proof.block_hash) { return Err(FinalityError::MalformedBlockHash); }
    if proof.block_hash != ctx.stored_block_hash { return Err(FinalityError::ProofBlockHashMismatch); }
    // cheap bounds BEFORE any signature work: never more votes than validators
    if proof.precommit_votes.len() > MAX_PROOF_VOTES || proof.precommit_votes.len() > ctx.validators.entries().len() { return Err(FinalityError::TooManyVotes); }
    let total = ctx.validators.total_stake().ok_or(FinalityError::StakeOverflow)?;
    let quorum = ctx.validators.quorum().ok_or(FinalityError::EmptyValidatorSet)?;
    let mut voters = BTreeSet::new();
    let mut voting: u128 = 0;
    for v in &proof.precommit_votes {
        if v.vote_type != PRECOMMIT { return Err(FinalityError::NonPrecommitInProof); }
        let stake = validate_vote(v, ctx)?; // same height, round, stored hash, eligible, signature
        if !voters.insert(v.voter_pub_key.clone()) { return Err(FinalityError::DuplicateVoterInProof); }
        voting = voting.checked_add(stake).ok_or(FinalityError::StakeOverflow)?;
    }
    if voting < quorum { return Err(FinalityError::BelowQuorum { voting_stake: voting, quorum }); }
    if proof.voting_stake != voting { return Err(FinalityError::AggregateClaimMismatch { field: "voting_stake" }); }
    if proof.total_stake != total { return Err(FinalityError::AggregateClaimMismatch { field: "total_stake" }); }
    if proof.quorum_threshold != quorum { return Err(FinalityError::AggregateClaimMismatch { field: "quorum_threshold" }); }
    Ok(VerifiedFinality { height: proof.height, block_hash: proof.block_hash.clone(), voting_stake: voting, total_stake: total, quorum, voters })
}

// ── canonical snapshot bytes (derived-state persistence; deterministic) ──────────────────────
impl ValidatorSetSnapshot {
    /// `QVS1 | height u64 BE | n u32 BE | n × (key_len u32 BE | key utf8 | stake u128 BE)`, keys ascending.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut o = b"QVS1".to_vec();
        o.extend_from_slice(&self.height.to_be_bytes());
        o.extend_from_slice(&(self.stakes.len() as u32).to_be_bytes());
        for (k, s) in &self.stakes { o.extend_from_slice(&(k.len() as u32).to_be_bytes()); o.extend_from_slice(k.as_bytes()); o.extend_from_slice(&s.to_be_bytes()); }
        o
    }
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        let take = |b: &mut &[u8], n: usize| -> Option<Vec<u8>> { if b.len() < n { return None; } let (h, t) = b.split_at(n); *b = t; Some(h.to_vec()) };
        let mut r = b;
        if take(&mut r, 4)? != b"QVS1" { return None; }
        let height = u64::from_be_bytes(take(&mut r, 8)?.try_into().ok()?);
        let n = u32::from_be_bytes(take(&mut r, 4)?.try_into().ok()?) as usize;
        let mut stakes = BTreeMap::new(); let mut last: Option<String> = None;
        for _ in 0..n {
            let kl = u32::from_be_bytes(take(&mut r, 4)?.try_into().ok()?) as usize;
            let k = String::from_utf8(take(&mut r, kl)?).ok()?;
            let s = u128::from_be_bytes(take(&mut r, 16)?.try_into().ok()?);
            if s == 0 || last.as_ref().map(|l| *l >= k).unwrap_or(false) { return None; } // canonical: ascending, no zero stake
            last = Some(k.clone()); stakes.insert(k, s);
        }
        if !r.is_empty() { return None; }
        Some(Self { height, stakes })
    }
}
