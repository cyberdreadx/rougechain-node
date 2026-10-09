//! Chain rules as pure functions over a ledger of integers: blocks and their
//! validation, on-demand heights and heartbeats (§3.4), epochs and validator-set
//! changes (§6.4, decisions 6 and 8), unbonding (§4.5), evidence and slashing
//! with tombstones (§4.2, §4.3), certificate-based downtime jailing (§4.4),
//! rewards with the per-time subsidy and the reserve (§5), and the activation
//! boundary (§8.2).
//!
//! [`Ledger::apply_block`] never mutates its receiver: it returns the next
//! ledger or an error, so "speculative execution always restores" (§3.5) holds
//! by construction.
//!
//! Order of effects inside one block (made explicit; RESULTS.md rule R12):
//! header and certificate checks → proposer-priority step → transactions →
//! evidence → rewards → downtime observation and jailing → unbonding release →
//! epoch processing → minimum-stake removals → new active set and re-weighting.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use crate::mutation::{self, Mutation};
use crate::schedule::{RoundProposers, Schedule};
use crate::types::*;

/// A ledger account.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Account {
    /// The account of a validator key (single-key model: stage D key separation is out of scope).
    Key(KeyId),
    /// An ordinary user.
    User(u32),
    /// `__treasury__`.
    Treasury,
    /// `__staking_rewards__`, the reserve (§5.3).
    Reserve,
}

/// Consensus parameters. [`Params::decided`] holds the owner's decisions of §10.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Params {
    /// Chain id, part of every signed message.
    pub chain_id: String,
    /// `F_B`: first height under the new rules (§8.2). Certificates for lower heights are V2.
    pub activation_height: Height,
    /// `T_HB`: heartbeat interval (decision 3: one hour).
    pub heartbeat_ms: TimeMs,
    /// Epoch length (§6.4: 24 hours).
    pub epoch_ms: TimeMs,
    /// `ACTIVATION_DELAY` for additions (§6.4: 24 hours).
    pub activation_delay_ms: TimeMs,
    /// `UNBONDING_PERIOD` (decision 5: 21 days of header time).
    pub unbonding_ms: TimeMs,
    /// `EVIDENCE_MAX_AGE`, equal to the unbonding period (§4.5).
    pub evidence_max_age_ms: TimeMs,
    /// Active-set cap (decision 6: 32).
    pub max_active: usize,
    /// Consensus minimum self-stake in quanta (decision 6: 100,000 XRGE).
    pub min_self_stake: Quanta,
    /// Grace for validators already in the set at activation (decision 6: 30 days).
    pub grace_ms: TimeMs,
    /// Downtime window `W` in certificates (decision 4: 200).
    pub jail_window: usize,
    /// Downtime threshold `M`: jail when absent from *more than* this many (decision 4: 100).
    pub jail_missed: usize,
    /// `m`: distinct proposers required (decision 4: 3).
    pub jail_min_proposers: usize,
    /// `JAIL_MS` (decision 4: one hour).
    pub jail_ms: TimeMs,
    /// Double-sign slash fraction numerator (decision 4: 100 %).
    pub slash_num: u128,
    /// Double-sign slash fraction denominator.
    pub slash_den: u128,
    /// Reserve subsidy `RATE` in quanta per second (§5.3; a budget decision, 0 is valid).
    pub subsidy_rate: Quanta,
    /// Base fee per transaction in quanta. Held constant in this model (the dynamic base fee of §1.1 is not part of R2).
    pub base_fee: Quanta,
    /// T2 drift bound: a header time more than this ahead of the local clock gets a nil prevote
    /// (§3.5). The value comes from LC1 §15.1, which was not read: **[confirm]**.
    pub drift_ms: TimeMs,
    /// Bound on evidence items per block (§4.2 "a bounded number").
    pub max_evidence_per_block: usize,
    /// Bound on transactions per block (the design found no limit in the code, §1.1; the model needs one).
    pub max_txs_per_block: usize,
}

const HOUR_MS: TimeMs = 3_600_000;
const DAY_MS: TimeMs = 24 * HOUR_MS;

impl Params {
    /// The values decided by the owner on 2026-10-06 (§10).
    pub fn decided(chain_id: &str) -> Params {
        Params {
            chain_id: chain_id.to_string(),
            activation_height: 1,
            heartbeat_ms: HOUR_MS,
            epoch_ms: DAY_MS,
            activation_delay_ms: DAY_MS,
            unbonding_ms: 21 * DAY_MS,
            evidence_max_age_ms: 21 * DAY_MS,
            max_active: 32,
            min_self_stake: 100_000 * QUANTA_PER_XRGE,
            grace_ms: 30 * DAY_MS,
            jail_window: 200,
            jail_missed: 100,
            jail_min_proposers: 3,
            jail_ms: HOUR_MS,
            slash_num: 1,
            slash_den: 1,
            subsidy_rate: 0,
            base_fee: 1_000_000, // 0.001 XRGE, the floor of §1.1
            drift_ms: 10_000,
            max_evidence_per_block: 8,
            max_txs_per_block: 64,
        }
    }
}

/// What a transaction does.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TxKind {
    /// Move liquid funds.
    Transfer {
        /// Recipient.
        to: Account,
        /// Amount in quanta.
        amount: Quanta,
    },
    /// Bond stake to the sender's validator (creating it if new). An addition: delayed (§6.4).
    Stake {
        /// Amount in quanta.
        amount: Quanta,
    },
    /// Unbond stake. A removal: weight drops at the next height; funds release after the unbonding period.
    Unbond {
        /// Amount in quanta.
        amount: Quanta,
    },
    /// Ask to return from jail (§4.4). An addition: delayed.
    Unjail,
    /// Interim admission approval of `candidate` by the sending validator (decision 8).
    Approve {
        /// The validator being approved.
        candidate: KeyId,
    },
}

/// A transaction. Signatures on transactions are outside this model.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Tx {
    /// Unique id (stands for the transaction hash; uniqueness is enforced as today, §1.1).
    pub id: u64,
    /// Payer and, for validator operations, the validator (`Account::Key`).
    pub from: Account,
    /// Fee in quanta.
    pub fee: Quanta,
    /// The operation.
    pub kind: TxKind,
}

/// Block header fields the consensus rules read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Header {
    /// Height.
    pub height: Height,
    /// The round in which the block was first built (§3.2).
    pub round: Round,
    /// The builder: must be the scheduled proposer of `(height, round)`.
    pub builder: KeyId,
    /// Header time chosen by the builder (deviation D4).
    pub time_ms: TimeMs,
    /// Hash of the parent block.
    pub parent: BlockId,
}

/// A block. Immutable once built; `id` covers every field.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Block {
    /// Header.
    pub header: Header,
    /// Certificate for the parent (§3.6); `None` only directly above genesis.
    pub parent_cert: Option<CommitCert>,
    /// Transactions.
    pub txs: Vec<Tx>,
    /// Evidence items (§4.2).
    pub evidence: Vec<Evidence>,
    id: BlockId,
}

impl Block {
    /// Assemble a block and compute its id.
    pub fn new(header: Header, parent_cert: Option<CommitCert>, txs: Vec<Tx>, evidence: Vec<Evidence>) -> Block {
        let mut h = Hasher::new("block");
        h.u64(header.height).u64(u64::from(header.round)).u64(u64::from(header.builder.0)).u64(header.time_ms).id(&header.parent);
        h.u64(parent_cert.as_ref().map_or(0, |c| c.digest()));
        for tx in &txs {
            h.u64(tx.id).u128(tx.fee);
        }
        h.u64(txs.len() as u64);
        for ev in &evidence {
            h.u64(ev.a.sig.tag).u64(ev.b.sig.tag);
        }
        Block { header, parent_cert, txs, evidence, id: BlockId(h.finish()) }
    }
    /// The block hash.
    pub fn id(&self) -> BlockId {
        self.id
    }
    /// True for a heartbeat-style block: no transactions and no evidence.
    pub fn is_empty(&self) -> bool {
        self.txs.is_empty() && self.evidence.is_empty()
    }
}

/// Per-validator ledger record.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ValidatorRec {
    /// Bonded self-stake in quanta. Weight is `bond / 10^9` (whole XRGE).
    pub bond: Quanta,
    /// In the active set (subject to `jailed_until`).
    pub active: bool,
    /// Was in the set at activation: needs no admission approval (decision 8 applies to *new* validators).
    pub legacy: bool,
    /// Still under the 30-day grace for the minimum self-stake (decision 6). Cleared for
    /// everyone at the first epoch boundary after the grace ends.
    pub grace: bool,
    /// Header time at which admission approval reached quorum (decision 8).
    pub approved_at: Option<TimeMs>,
    /// `Some(t)`: jailed, may request unjail from header time `t`.
    pub jailed_until: Option<TimeMs>,
    /// Header time of the block that carried the `unjail` request.
    pub unjail_at: Option<TimeMs>,
    /// Permanently removed for a double-sign (§4.3).
    pub tombstoned: bool,
    /// Highest offence height already penalised (§4.2 rule 4, the floor rule).
    pub slash_floor: Option<Height>,
    /// Downtime window: `(assembler, signed)` for the last `W` certificates this validator was eligible for.
    pub window: VecDeque<(KeyId, bool)>,
}

impl ValidatorRec {
    /// Weight in whole XRGE.
    pub fn weight(&self) -> Weight {
        self.bond / QUANTA_PER_XRGE
    }
    fn in_set(&self) -> bool {
        self.active && self.jailed_until.is_none() && !self.tombstoned && self.weight() > 0
    }
}

/// A bond addition waiting for its epoch boundary (§6.4).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PendingBond {
    /// Validator.
    pub key: KeyId,
    /// Amount in quanta (already debited from the balance).
    pub amount: Quanta,
    /// Header time of the block that included the stake transaction.
    pub included_at: TimeMs,
}

/// Stake on its way out (§4.5). Slashable for offences at or before `created_height`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnbondingEntry {
    /// Validator.
    pub key: KeyId,
    /// Amount in quanta.
    pub amount: Quanta,
    /// Height of the block that created the entry.
    pub created_height: Height,
    /// Header time from which the amount is released.
    pub release_at: TimeMs,
}

/// One double-sign penalty.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SlashEvent {
    /// Offender.
    pub key: KeyId,
    /// Offence height.
    pub offence_height: Height,
    /// Bonded stake before the cut.
    pub bond_before: Quanta,
    /// Cut from the bond.
    pub cut_bond: Quanta,
    /// Cut from unbonding entries created at or after the offence height.
    pub cut_unbonding: Quanta,
}

/// Everything one block did, for the property checkers (P7–P9).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Effects {
    /// Block height.
    pub height: Height,
    /// Round-0 proposer of this height (P6).
    pub round0_proposer: Option<KeyId>,
    /// Fees collected.
    pub fees: Quanta,
    /// Fees burned.
    pub burn: Quanta,
    /// Subsidy drawn from the reserve.
    pub subsidy: Quanta,
    /// Reward credits (treasury, proposer, signers).
    pub credits: Vec<(Account, Quanta)>,
    /// Unearned share returned to the reserve.
    pub unearned: Quanta,
    /// Signers of the parent certificate.
    pub signers: Vec<KeyId>,
    /// Double-sign penalties applied.
    pub slashes: Vec<SlashEvent>,
    /// Validators jailed for downtime, with the distinct assemblers of the certificates they were absent from.
    pub jailed: Vec<(KeyId, Vec<KeyId>)>,
    /// Validators that left the active set for any reason.
    pub removed: Vec<KeyId>,
    /// Validators that entered the active set (only at an epoch boundary).
    pub activated: Vec<KeyId>,
    /// Unbonding amounts released.
    pub released: Vec<(KeyId, Quanta)>,
    /// True if this block crossed an epoch boundary.
    pub epoch_boundary: bool,
    /// Total supply after the block (must never change; P7/P8).
    pub supply_after: Quanta,
}

/// Why a block is invalid.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum BlockError {
    /// Height is not tip + 1.
    WrongHeight,
    /// Parent hash is not the tip.
    WrongParent,
    /// T1: header time not after the parent's.
    TimeNotAfterParent,
    /// Builder is not the scheduled proposer of `(height, header.round)`.
    WrongProposer,
    /// No transactions or evidence and the heartbeat is not due (§3.4).
    EmptyNotDue,
    /// Parent certificate missing where one is required, or present above genesis.
    CertPresence,
    /// Parent certificate is for another block.
    CertMismatch,
    /// Certificate round is below the certified header's round (§3.6).
    CertRoundBelowHeader,
    /// Certificate failed verification.
    Cert(CertError),
    /// A transaction is invalid; the index and reason.
    Tx(usize, TxError),
    /// An evidence item is invalid (§4.2 "invalid evidence makes the block invalid").
    Evidence(usize, EvidenceError),
    /// Too many transactions or evidence items.
    TooLarge,
    /// Arithmetic that must be exact could not be computed.
    Arithmetic,
    /// The active set is empty or the schedule failed.
    Schedule,
}

/// Why a transaction is invalid.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TxError {
    /// Id already used.
    Duplicate,
    /// Fee below the base fee.
    FeeTooLow,
    /// Balance cannot cover amount plus fee.
    InsufficientFunds,
    /// Amount is zero.
    ZeroAmount,
    /// Validator operation not sent from a validator key account.
    NotAKeyAccount,
    /// No such validator.
    UnknownValidator,
    /// Key is tombstoned.
    Tombstoned,
    /// Unbond exceeds the bond.
    BondTooSmall,
    /// Not jailed, jail time not served, or unjail already requested.
    UnjailNotAllowed,
    /// Approver is not in the current active set, or approval is not needed / already given.
    ApproveNotAllowed,
}

/// Why evidence is invalid.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum EvidenceError {
    /// The two votes do not form a duplicate vote, or the pair is not in canonical order.
    NotConflicting,
    /// Offence height is not below the block, or its header time is unknown.
    HeightOutOfRange,
    /// Older than the evidence window (§4.2 rule 1).
    TooOld,
    /// Key was not eligible at the offence height (rule 2).
    NotEligible,
    /// A signature does not verify (rule 3).
    BadSignature,
    /// Key already penalised for an offence at or below this height (rule 4).
    AlreadyPenalised,
    /// Same item twice in one block.
    Repeated,
}

/// The committed state. All fields are integers or collections of integers.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Ledger {
    /// Parameters.
    pub params: Params,
    /// Height of the tip.
    pub height: Height,
    /// Hash of the tip.
    pub tip: BlockId,
    /// Header time of the tip.
    pub tip_time: TimeMs,
    /// Header round of the tip (for the `cert.round ≥ header.round` rule).
    pub tip_round: Round,
    /// Header time at activation: the grace period counts from here.
    pub activation_time: TimeMs,
    /// Liquid balances.
    pub balances: BTreeMap<Account, Quanta>,
    /// Validators.
    pub validators: BTreeMap<KeyId, ValidatorRec>,
    /// Bond additions waiting for an epoch boundary.
    pub pending: Vec<PendingBond>,
    /// Unbonding queue.
    pub unbonding: Vec<UnbondingEntry>,
    /// Admission approvals collected so far, per candidate.
    pub approvals: BTreeMap<KeyId, BTreeSet<KeyId>>,
    /// Proposer priorities (§3.3).
    pub schedule: Schedule,
    /// `E(height + 1)`: the set that votes on the next block.
    pub active_set: Arc<ValidatorSet>,
    /// `E(h)` for recent heights (evidence eligibility, parent-certificate checks).
    pub sets: BTreeMap<Height, Arc<ValidatorSet>>,
    /// Header times of recent heights (evidence window).
    pub times: BTreeMap<Height, TimeMs>,
    /// Recent downtime jailings `(height, weight)` for the concentration cap (§4.4 rule 3).
    pub jail_log: VecDeque<(Height, Weight)>,
    /// Transaction ids already used.
    pub seen_tx: BTreeSet<u64>,
    /// Fees burned so far.
    pub burned_fees: Quanta,
    /// Slashed stake burned so far (§4.3 "explicit state counter").
    pub burned_slash: Quanta,
}

/// Initial state for a simulation.
#[derive(Clone, Debug)]
pub struct Genesis {
    /// Height of the last block under the old rules (`F_B − 1`); 0 for a fresh chain.
    pub tip_height: Height,
    /// Its hash.
    pub tip: BlockId,
    /// Its header time.
    pub tip_time: TimeMs,
    /// Validators already in the set, with bonded quanta.
    pub validators: Vec<(KeyId, Quanta)>,
    /// Liquid balances.
    pub balances: Vec<(Account, Quanta)>,
}

impl Ledger {
    /// Build the state at the activation boundary. Validators listed in the
    /// genesis are `legacy`: active, deemed approved, and under the grace rule.
    pub fn genesis(mut params: Params, g: &Genesis) -> Result<Ledger, SetError> {
        params.activation_height = g.tip_height + 1;
        let mut validators = BTreeMap::new();
        for (key, bond) in &g.validators {
            validators.insert(*key, ValidatorRec { bond: *bond, active: true, legacy: true, grace: true, ..ValidatorRec::default() });
        }
        let set = Arc::new(ValidatorSet::new(validators.iter().filter(|(_, r)| r.in_set()).map(|(k, r)| (*k, r.weight())).collect())?);
        let mut sets = BTreeMap::new();
        // The same set certified the tip under the old rules (§8.2).
        sets.insert(g.tip_height, set.clone());
        sets.insert(g.tip_height + 1, set.clone());
        let mut times = BTreeMap::new();
        times.insert(g.tip_height, g.tip_time);
        Ok(Ledger {
            params,
            height: g.tip_height,
            tip: g.tip,
            tip_time: g.tip_time,
            tip_round: 0,
            activation_time: g.tip_time,
            balances: g.balances.iter().copied().collect(),
            validators,
            pending: Vec::new(),
            unbonding: Vec::new(),
            approvals: BTreeMap::new(),
            schedule: Schedule::new(&set),
            active_set: set,
            sets,
            times,
            jail_log: VecDeque::new(),
            seen_tx: BTreeSet::new(),
            burned_fees: 0,
            burned_slash: 0,
        })
    }

    /// Liquid balance of an account.
    pub fn balance(&self, a: Account) -> Quanta {
        self.balances.get(&a).copied().unwrap_or(0)
    }

    /// Everything that exists: liquid + bonded + pending + unbonding + burned.
    /// Constant across every valid block (P7, P8).
    pub fn total_supply(&self) -> Quanta {
        let mut s: Quanta = self.burned_fees + self.burned_slash;
        s += self.balances.values().sum::<Quanta>();
        s += self.validators.values().map(|v| v.bond).sum::<Quanta>();
        s += self.pending.iter().map(|p| p.amount).sum::<Quanta>();
        s += self.unbonding.iter().map(|u| u.amount).sum::<Quanta>();
        s
    }

    /// Proposers of the next height, round by round (§3.3).
    pub fn next_proposers(&self) -> RoundProposers {
        RoundProposers::new(&self.schedule)
    }

    /// Signing domain of certificates and votes for `height` (§8.2).
    pub fn domain_of(&self, height: Height) -> Domain {
        if height < self.params.activation_height {
            Domain::V2
        } else {
            Domain::V3
        }
    }

    /// Is a heartbeat block due at header time `time` (§3.4 rule 2)?
    pub fn heartbeat_due(&self, time: TimeMs) -> bool {
        time >= self.tip_time.saturating_add(self.params.heartbeat_ms)
    }

    /// T2 (§3.5): the header time is not more than the drift bound ahead of the local clock.
    pub fn time_within_drift(&self, block: &Block, local_now: TimeMs) -> bool {
        block.header.time_ms <= local_now.saturating_add(self.params.drift_ms)
    }

    fn credit(&mut self, a: Account, amount: Quanta) -> Result<(), BlockError> {
        let b = self.balances.entry(a).or_insert(0);
        *b = b.checked_add(amount).ok_or(BlockError::Arithmetic)?;
        Ok(())
    }

    fn debit(&mut self, a: Account, amount: Quanta) -> Result<(), TxError> {
        let b = self.balances.entry(a).or_insert(0);
        *b = b.checked_sub(amount).ok_or(TxError::InsufficientFunds)?;
        Ok(())
    }

    /// Apply one transaction at block `height`, header time `time`. Returns the fee collected.
    fn apply_tx(&mut self, tx: &Tx, height: Height, time: TimeMs) -> Result<Quanta, TxError> {
        if self.seen_tx.contains(&tx.id) {
            return Err(TxError::Duplicate);
        }
        if tx.fee < self.params.base_fee {
            return Err(TxError::FeeTooLow);
        }
        let validator_key = |from: Account| match from {
            Account::Key(k) => Ok(k),
            _ => Err(TxError::NotAKeyAccount),
        };
        match &tx.kind {
            TxKind::Transfer { to, amount } => {
                if *amount == 0 {
                    return Err(TxError::ZeroAmount);
                }
                let total = amount.checked_add(tx.fee).ok_or(TxError::InsufficientFunds)?;
                self.debit(tx.from, total)?;
                self.credit(*to, *amount).map_err(|_| TxError::InsufficientFunds)?;
            }
            TxKind::Stake { amount } => {
                let key = validator_key(tx.from)?;
                if *amount == 0 {
                    return Err(TxError::ZeroAmount);
                }
                if self.validators.get(&key).is_some_and(|v| v.tombstoned) {
                    return Err(TxError::Tombstoned);
                }
                let total = amount.checked_add(tx.fee).ok_or(TxError::InsufficientFunds)?;
                self.debit(tx.from, total)?;
                self.validators.entry(key).or_default();
                self.pending.push(PendingBond { key, amount: *amount, included_at: time });
            }
            TxKind::Unbond { amount } => {
                let key = validator_key(tx.from)?;
                if *amount == 0 {
                    return Err(TxError::ZeroAmount);
                }
                let bond = self.validators.get(&key).ok_or(TxError::UnknownValidator)?.bond;
                if bond < *amount {
                    return Err(TxError::BondTooSmall);
                }
                self.debit(tx.from, tx.fee)?;
                if let Some(rec) = self.validators.get_mut(&key) {
                    rec.bond = bond - *amount;
                }
                self.unbonding.push(UnbondingEntry {
                    key,
                    amount: *amount,
                    created_height: height,
                    release_at: time.saturating_add(self.params.unbonding_ms),
                });
            }
            TxKind::Unjail => {
                let key = validator_key(tx.from)?;
                let rec = self.validators.get(&key).ok_or(TxError::UnknownValidator)?;
                let served = rec.jailed_until.is_some_and(|until| time >= until);
                if rec.tombstoned || !served || rec.unjail_at.is_some() {
                    return Err(TxError::UnjailNotAllowed);
                }
                self.debit(tx.from, tx.fee)?;
                if let Some(rec) = self.validators.get_mut(&key) {
                    rec.unjail_at = Some(time);
                }
            }
            TxKind::Approve { candidate } => {
                let approver = validator_key(tx.from)?;
                let set = self.active_set.clone();
                let cand = self.validators.get(candidate).ok_or(TxError::UnknownValidator)?;
                if !set.contains(approver) || cand.legacy || cand.approved_at.is_some() || cand.tombstoned {
                    return Err(TxError::ApproveNotAllowed);
                }
                if self.approvals.get(candidate).is_some_and(|a| a.contains(&approver)) {
                    return Err(TxError::ApproveNotAllowed);
                }
                self.debit(tx.from, tx.fee)?;
                let approvers = self.approvals.entry(*candidate).or_default();
                approvers.insert(approver);
                // Decision 8: approval by ≥ q of *current* stake. Approvers that
                // have since left the set weigh nothing (rule R17).
                let weight: Weight = approvers.iter().map(|k| set.weight(*k)).sum();
                if weight >= set.quorum() {
                    self.approvals.remove(candidate);
                    if let Some(rec) = self.validators.get_mut(candidate) {
                        rec.approved_at = Some(time);
                    }
                }
            }
        }
        self.seen_tx.insert(tx.id);
        Ok(tx.fee)
    }

    /// Verify one evidence item for inclusion in block `height` at header time `time` (§4.2 rules 1–4).
    fn check_evidence(&self, ev: &Evidence, height: Height, time: TimeMs) -> Result<(), EvidenceError> {
        if Evidence::from_votes(&ev.a, &ev.b) != Some(*ev) {
            return Err(EvidenceError::NotConflicting);
        }
        let off = ev.height();
        if off >= height {
            return Err(EvidenceError::HeightOutOfRange);
        }
        // Rule 1.
        let off_time = *self.times.get(&off).ok_or(EvidenceError::HeightOutOfRange)?;
        if time.saturating_sub(off_time) > self.params.evidence_max_age_ms {
            return Err(EvidenceError::TooOld);
        }
        // Rule 2.
        let set = self.sets.get(&off).ok_or(EvidenceError::HeightOutOfRange)?;
        if !set.contains(ev.offender()) {
            return Err(EvidenceError::NotEligible);
        }
        // Rule 3: V3 bytes, or V2 bytes for a pre-fork height (round 0 only there).
        let domain = self.domain_of(off);
        if domain == Domain::V2 && ev.a.round != 0 {
            return Err(EvidenceError::BadSignature);
        }
        if !ev.a.verify(domain, &self.params.chain_id) || !ev.b.verify(domain, &self.params.chain_id) {
            return Err(EvidenceError::BadSignature);
        }
        // Rule 4: the floor rule.
        if let Some(rec) = self.validators.get(&ev.offender()) {
            if rec.slash_floor.is_some_and(|floor| off <= floor) {
                return Err(EvidenceError::AlreadyPenalised);
            }
        }
        Ok(())
    }

    /// Slash and tombstone (§4.3). The cut is burned.
    fn slash(&mut self, key: KeyId, offence_height: Height, time: TimeMs) -> Result<SlashEvent, BlockError> {
        let (num, den) = (self.params.slash_num, self.params.slash_den);
        let cut = |x: Quanta| mul_div_floor(x, num, den).filter(|c| *c <= x).ok_or(BlockError::Arithmetic);
        let rec = self.validators.entry(key).or_default();
        let bond_before = rec.bond;
        let cut_bond = cut(bond_before)?;
        let remainder = bond_before - cut_bond;
        rec.bond = 0;
        rec.active = false;
        rec.tombstoned = true;
        rec.slash_floor = Some(rec.slash_floor.map_or(offence_height, |f| f.max(offence_height)));
        rec.window.clear();
        let mut cut_unbonding: Quanta = 0;
        for entry in self.unbonding.iter_mut().filter(|e| e.key == key && e.created_height >= offence_height) {
            let c = cut(entry.amount)?;
            entry.amount -= c;
            cut_unbonding += c;
        }
        self.unbonding.retain(|e| e.amount > 0);
        // What is left of the bond may be withdrawn "after unbonding" (§4.3): rule R15.
        if remainder > 0 {
            self.unbonding.push(UnbondingEntry {
                key,
                amount: remainder,
                created_height: self.height + 1,
                release_at: time.saturating_add(self.params.unbonding_ms),
            });
        }
        // Stake that was never bonded cannot have signed: pending additions are refunded (rule R16).
        let refund: Quanta = self.pending.iter().filter(|p| p.key == key).map(|p| p.amount).sum();
        self.pending.retain(|p| p.key != key);
        self.credit(Account::Key(key), refund)?;
        self.approvals.remove(&key);
        self.burned_slash = self.burned_slash.checked_add(cut_bond + cut_unbonding).ok_or(BlockError::Arithmetic)?;
        Ok(SlashEvent { key, offence_height, bond_before, cut_bond, cut_unbonding })
    }

    /// Rewards for a block (§5.1). `signers` signed the parent certificate; `prev` is `E(h−1)`.
    fn pay_rewards(&mut self, fx: &mut Effects, builder: KeyId, fees: Quanta, fee_txs: u128, dt_ms: TimeMs, signers: &[KeyId], prev: &ValidatorSet) -> Result<(), BlockError> {
        let md = |a: u128, b: u128, d: u128| mul_div_floor(a, b, d).ok_or(BlockError::Arithmetic);
        let burn = fees.min(self.params.base_fee.checked_mul(fee_txs).ok_or(BlockError::Arithmetic)? / 2);
        // §5.3: subsidy = min(reserve, RATE · Δt / 1000), with Δt capped at T_HB.
        let dt = u128::from(dt_ms.min(self.params.heartbeat_ms));
        let subsidy = self.balance(Account::Reserve).min(md(self.params.subsidy_rate, dt, 1000)?);
        let pool = fees - burn + subsidy;
        let treasury = md(pool, 10, 100)?;
        let prop_base = md(pool, 5, 100)?;
        let incl_pool = md(pool, 15, 100)?;
        let vote_pool = md(pool, 70, 100)?;
        let total = prev.total();
        let w_s: Weight = signers.iter().map(|k| prev.weight(*k)).sum();
        let prop_incl = if total == 0 { 0 } else { md(incl_pool, w_s, total)? };
        let mut paid = treasury + prop_base + prop_incl;
        self.debit(Account::Reserve, subsidy).map_err(|_| BlockError::Arithmetic)?;
        self.credit(Account::Treasury, treasury)?;
        fx.credits.push((Account::Treasury, treasury));
        self.credit(Account::Key(builder), prop_base + prop_incl)?;
        fx.credits.push((Account::Key(builder), prop_base + prop_incl));
        for key in signers {
            // Denominator is T, not W_S: omitting a signer never raises anyone's share (§5.2).
            let share = md(vote_pool, prev.weight(*key), total)?;
            self.credit(Account::Key(*key), share)?;
            fx.credits.push((Account::Key(*key), share));
            paid += share;
        }
        let unearned = if mutation::active(Mutation::RewardRoundingLeak) {
            // Broken variant: the unearned share by formula, not as the residual. Rounding dust vanishes.
            if total == 0 {
                0
            } else {
                md(incl_pool, total - w_s, total)? + md(vote_pool, total - w_s, total)?
            }
        } else {
            pool - paid
        };
        self.credit(Account::Reserve, unearned)?;
        self.burned_fees = self.burned_fees.checked_add(burn).ok_or(BlockError::Arithmetic)?;
        fx.fees = fees;
        fx.burn = burn;
        fx.subsidy = subsidy;
        fx.unearned = unearned;
        Ok(())
    }

    /// Record who signed the parent certificate and jail for downtime (§4.4).
    fn observe_downtime(&mut self, fx: &mut Effects, height: Height, time: TimeMs, assembler: KeyId, signers: &[KeyId], prev: &ValidatorSet) {
        let p = &self.params;
        let (window, missed_max, min_prop, jail_ms) = (p.jail_window, p.jail_missed, p.jail_min_proposers, p.jail_ms);
        let mut candidates: Vec<(KeyId, Vec<KeyId>)> = Vec::new();
        for (key, _) in prev.members() {
            let Some(rec) = self.validators.get_mut(key) else { continue };
            if !rec.in_set() {
                continue;
            }
            rec.window.push_back((assembler, signers.binary_search(key).is_ok()));
            while rec.window.len() > window {
                rec.window.pop_front();
            }
            // Rule 1: absent from more than M of the last W.
            let missed = rec.window.iter().filter(|(_, signed)| !signed).count();
            if missed <= missed_max {
                continue;
            }
            // Rule 2. Made explicit (RESULTS.md rule R19, design defect F2):
            // the certificates the validator is ABSENT FROM must come from at
            // least m distinct assemblers. The literal text counts the
            // assemblers of the whole window, which lets one proposer jail a rival.
            let literal = mutation::active(Mutation::JailWindowProposersLiteral);
            let assemblers: BTreeSet<KeyId> = rec.window.iter().filter(|(_, signed)| literal || !signed).map(|(a, _)| *a).collect();
            if assemblers.len() < min_prop && !mutation::active(Mutation::JailWithoutProposerRule) {
                continue;
            }
            let blamed: BTreeSet<KeyId> = rec.window.iter().filter(|(_, signed)| !signed).map(|(a, _)| *a).collect();
            candidates.push((*key, blamed.into_iter().collect()));
        }
        // Rule 3, evaluated one candidate at a time in key order against the set as it shrinks.
        while self.jail_log.front().is_some_and(|(h, _)| h.saturating_add(window as u64) <= height) {
            self.jail_log.pop_front();
        }
        for (key, blamed) in candidates {
            let members: Vec<(KeyId, Weight)> = self.validators.iter().filter(|(_, r)| r.in_set()).map(|(k, r)| (*k, r.weight())).collect();
            let total: Weight = members.iter().map(|m| m.1).sum();
            let w = members.iter().find(|m| m.0 == key).map_or(0, |m| m.1);
            let remaining = total - w;
            // (a) no remaining key at one third or more of the remaining stake;
            let concentrates = members.iter().any(|(k, wk)| *k != key && wk * 3 >= remaining);
            // (b) stake jailed inside the window stays at or below one third of T.
            let jailed_recently: Weight = self.jail_log.iter().map(|(_, jw)| *jw).sum();
            let over_cap = (jailed_recently + w) * 3 > total;
            if concentrates || over_cap {
                continue;
            }
            if let Some(rec) = self.validators.get_mut(&key) {
                rec.jailed_until = Some(time.saturating_add(jail_ms));
                rec.unjail_at = None;
                rec.window.clear();
            }
            self.jail_log.push_back((height, w));
            fx.jailed.push((key, blamed));
        }
    }

    /// Epoch boundary (§6.4): additions take effect, then the cap is applied.
    fn process_epoch(&mut self, fx: &mut Effects, time: TimeMs) -> Result<(), BlockError> {
        let delay = self.params.activation_delay_ms;
        let matured = |since: TimeMs| time.saturating_sub(since) >= delay;
        // Bond additions included at least ACTIVATION_DELAY ago.
        let mut still_pending = Vec::new();
        for p in std::mem::take(&mut self.pending) {
            if matured(p.included_at) {
                let rec = self.validators.entry(p.key).or_default();
                rec.bond = rec.bond.checked_add(p.amount).ok_or(BlockError::Arithmetic)?;
            } else {
                still_pending.push(p);
            }
        }
        self.pending = still_pending;
        // Unjail requests included at least ACTIVATION_DELAY ago.
        for rec in self.validators.values_mut() {
            if rec.jailed_until.is_some() && rec.unjail_at.is_some_and(matured) {
                rec.jailed_until = None;
                rec.unjail_at = None;
                rec.window.clear();
            }
        }
        // Grace (decision 6): after it, a validator below the minimum leaves at this boundary.
        if time.saturating_sub(self.activation_time) >= self.params.grace_ms {
            for rec in self.validators.values_mut() {
                rec.grace = false;
            }
        }
        let min = self.params.min_self_stake;
        let qualifies = |rec: &ValidatorRec| {
            let stake_ok = rec.bond >= min || rec.grace;
            let admitted = rec.legacy || rec.approved_at.is_some_and(matured);
            stake_ok && admitted && !rec.tombstoned && rec.jailed_until.is_none() && rec.weight() > 0
        };
        // Cap: the greatest weights, ties to the lowest key (§6.4).
        let mut ranked: Vec<(Weight, KeyId)> = self.validators.iter().filter(|(_, r)| qualifies(r)).map(|(k, r)| (r.weight(), *k)).collect();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        ranked.truncate(self.params.max_active);
        let chosen: BTreeSet<KeyId> = ranked.into_iter().map(|(_, k)| k).collect();
        for (key, rec) in self.validators.iter_mut() {
            let want = chosen.contains(key);
            // A jailed validator keeps its `active` flag; it is out of E through `jailed_until`.
            if rec.jailed_until.is_some() {
                continue;
            }
            if want && !rec.active {
                rec.active = true;
                rec.window.clear();
                fx.activated.push(*key);
            } else if !want && rec.active {
                rec.active = false;
                fx.removed.push(*key);
            }
        }
        Ok(())
    }

    /// Validate and apply `block`, returning the next ledger and what happened.
    /// T2 (clock drift) is *not* checked here: it is a local, prevote-only rule
    /// ([`Ledger::time_within_drift`]).
    pub fn apply_block(&self, block: &Block) -> Result<(Ledger, Effects), BlockError> {
        let mut next = self.clone();
        let fx = next.apply_in_place(block)?;
        Ok((next, fx))
    }

    fn apply_in_place(&mut self, block: &Block) -> Result<Effects, BlockError> {
        let hd = &block.header;
        let height = self.height.checked_add(1).ok_or(BlockError::Arithmetic)?;
        if hd.height != height {
            return Err(BlockError::WrongHeight);
        }
        if hd.parent != self.tip {
            return Err(BlockError::WrongParent);
        }
        // T1 (LC1 §15.1 as cited in §3.5): strictly after the parent.
        if hd.time_ms <= self.tip_time {
            return Err(BlockError::TimeNotAfterParent);
        }
        // Header proposer is the scheduled proposer of (height, header.round) (§3.2).
        if self.next_proposers().get(hd.round) != Some(hd.builder) {
            return Err(BlockError::WrongProposer);
        }
        if block.txs.len() > self.params.max_txs_per_block || block.evidence.len() > self.params.max_evidence_per_block {
            return Err(BlockError::TooLarge);
        }
        // Heartbeat rule (§3.4): zero content only when time ≥ parent.time + T_HB.
        if block.is_empty() && !self.heartbeat_due(hd.time_ms) {
            return Err(BlockError::EmptyNotDue);
        }
        // Parent certificate, verified under the rules of the height it certifies (§8.2).
        let prev_set = self.sets.get(&self.height).cloned().unwrap_or_default();
        let mut signers: Vec<KeyId> = Vec::new();
        match (&block.parent_cert, self.height) {
            (None, 0) => {}
            (Some(_), 0) | (None, _) => return Err(BlockError::CertPresence),
            (Some(cert), _) => {
                if cert.height != self.height || cert.block != self.tip {
                    return Err(BlockError::CertMismatch);
                }
                if cert.round < self.tip_round {
                    return Err(BlockError::CertRoundBelowHeader);
                }
                cert.verify(self.domain_of(self.height), &self.params.chain_id, &prev_set).map_err(BlockError::Cert)?;
                signers = cert.signers().collect();
            }
        }
        let mut fx = Effects { height, signers: signers.clone(), ..Effects::default() };

        // Stored priorities advance by exactly one step per height, whatever round committed (§3.3).
        fx.round0_proposer = Some(self.schedule.step().map_err(|_| BlockError::Schedule)?);

        // Transactions.
        let mut fees: Quanta = 0;
        let mut fee_txs: u128 = 0;
        for (i, tx) in block.txs.iter().enumerate() {
            let fee = self.apply_tx(tx, height, hd.time_ms).map_err(|e| BlockError::Tx(i, e))?;
            fees = fees.checked_add(fee).ok_or(BlockError::Arithmetic)?;
            fee_txs += u128::from(fee > 0);
        }

        // Evidence, before unbonding release so that an entry maturing in this
        // very block is still slashable (rule R14).
        let mut seen: BTreeSet<(KeyId, Height)> = BTreeSet::new();
        for (i, ev) in block.evidence.iter().enumerate() {
            if !seen.insert((ev.offender(), ev.height())) {
                return Err(BlockError::Evidence(i, EvidenceError::Repeated));
            }
            self.check_evidence(ev, height, hd.time_ms).map_err(|e| BlockError::Evidence(i, e))?;
            let event = self.slash(ev.offender(), ev.height(), hd.time_ms)?;
            fx.removed.push(event.key);
            fx.slashes.push(event);
        }

        // Rewards: signers of h−1 only, by their weight in E(h−1) (§5.1).
        self.pay_rewards(&mut fx, hd.builder, fees, fee_txs, hd.time_ms - self.tip_time, &signers, &prev_set)?;

        // Downtime (§4.4). Only certificates produced under the new rules list
        // every signer, so a V2 certificate is not counted (rule R21).
        if block.parent_cert.is_some() && self.domain_of(self.height) == Domain::V3 {
            self.observe_downtime(&mut fx, height, hd.time_ms, hd.builder, &signers, &prev_set);
        }

        // Unbonding release (§4.5).
        let mut keep = Vec::new();
        for entry in std::mem::take(&mut self.unbonding) {
            if hd.time_ms >= entry.release_at {
                self.credit(Account::Key(entry.key), entry.amount)?;
                fx.released.push((entry.key, entry.amount));
            } else {
                keep.push(entry);
            }
        }
        self.unbonding = keep;

        // Epoch: the first block whose header time crosses a 24-hour boundary (§6.4).
        if self.params.epoch_ms > 0 && hd.time_ms / self.params.epoch_ms > self.tip_time / self.params.epoch_ms {
            fx.epoch_boundary = true;
            self.process_epoch(&mut fx, hd.time_ms)?;
        }

        // Minimum self-stake is a removal: immediate (§6.4). Validators still under
        // the grace are exempt; the grace flag is cleared in process_epoch, which is
        // what makes them leave "at the next epoch boundary" (decision 6).
        let min = self.params.min_self_stake;
        for (key, rec) in self.validators.iter_mut() {
            if rec.active && ((!rec.grace && rec.bond < min) || rec.weight() == 0) {
                rec.active = false;
                fx.removed.push(*key);
            }
        }

        // New active set and re-weighting (§3.3 "before the next step").
        let members: Vec<(KeyId, Weight)> = self.validators.iter().filter(|(_, r)| r.in_set()).map(|(k, r)| (*k, r.weight())).collect();
        let set = Arc::new(ValidatorSet::new(members).map_err(|_| BlockError::Schedule)?);
        self.schedule.reweight(&set).map_err(|_| BlockError::Schedule)?;
        self.active_set = set.clone();
        self.sets.insert(height + 1, set);
        self.times.insert(height, hd.time_ms);
        // History older than the evidence window is not needed.
        let horizon = hd.time_ms.saturating_sub(self.params.evidence_max_age_ms);
        while let Some((&h, &t)) = self.times.iter().next() {
            if t < horizon && h + 2 < height {
                self.times.remove(&h);
                self.sets.remove(&h);
            } else {
                break;
            }
        }
        self.height = height;
        self.tip = block.id();
        self.tip_time = hd.time_ms;
        self.tip_round = hd.round;
        fx.supply_after = self.total_supply();
        Ok(fx)
    }

    /// Transactions from `candidates` that are valid in order on top of this ledger.
    pub fn admissible_txs(&self, candidates: &[Tx], time: TimeMs) -> Vec<Tx> {
        let mut scratch = self.clone();
        let mut out = Vec::new();
        for tx in candidates {
            if out.len() >= self.params.max_txs_per_block {
                break;
            }
            if scratch.apply_tx(tx, self.height + 1, time).is_ok() {
                out.push(tx.clone());
            }
        }
        out
    }

    /// Could the next block, at header time `time`, carry this evidence item?
    pub fn evidence_admissible(&self, ev: &Evidence, time: TimeMs) -> bool {
        self.check_evidence(ev, self.height + 1, time).is_ok()
    }

    /// Evidence from `candidates` that the next block may carry.
    pub fn admissible_evidence(&self, candidates: &[Evidence], time: TimeMs) -> Vec<Evidence> {
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for ev in candidates {
            if out.len() >= self.params.max_evidence_per_block {
                break;
            }
            if self.check_evidence(ev, self.height + 1, time).is_ok() && seen.insert(ev.offender()) {
                out.push(*ev);
            }
        }
        out
    }

    /// Build the next block as `builder` in `round`. The header time is the
    /// builder's clock, pushed just past the parent's if the clock is behind (T1; rule R9).
    pub fn build_block(&self, builder: KeyId, round: Round, local_now: TimeMs, parent_cert: Option<CommitCert>, txs: Vec<Tx>, evidence: Vec<Evidence>) -> Block {
        let time_ms = local_now.max(self.tip_time.saturating_add(1));
        Block::new(Header { height: self.height + 1, round, builder, time_ms, parent: self.tip }, parent_cert, txs, evidence)
    }

    /// Stable digest of the whole state (P10).
    pub fn state_hash(&self) -> u64 {
        let mut h = Hasher::new("ledger");
        h.u64(self.height).id(&self.tip).u64(self.tip_time).u64(u64::from(self.tip_round));
        for (a, b) in &self.balances {
            let (tag, n) = match a {
                Account::Key(k) => (0u64, u64::from(k.0)),
                Account::User(u) => (1, u64::from(*u)),
                Account::Treasury => (2, 0),
                Account::Reserve => (3, 0),
            };
            h.u64(tag).u64(n).u128(*b);
        }
        for (k, r) in &self.validators {
            h.u64(u64::from(k.0)).u128(r.bond);
            h.u64(u64::from(r.active) | u64::from(r.legacy) << 1 | u64::from(r.tombstoned) << 2 | u64::from(r.grace) << 3);
            h.u64(r.approved_at.map_or(0, |t| t + 1)).u64(r.jailed_until.map_or(0, |t| t + 1)).u64(r.unjail_at.map_or(0, |t| t + 1));
            h.u64(r.slash_floor.map_or(0, |t| t + 1));
            for (a, s) in &r.window {
                h.u64(u64::from(a.0) << 1 | u64::from(*s));
            }
        }
        for p in &self.pending {
            h.u64(u64::from(p.key.0)).u128(p.amount).u64(p.included_at);
        }
        for u in &self.unbonding {
            h.u64(u64::from(u.key.0)).u128(u.amount).u64(u.created_height).u64(u.release_at);
        }
        for (c, a) in &self.approvals {
            h.u64(u64::from(c.0));
            for k in a {
                h.u64(u64::from(k.0));
            }
        }
        h.u64(self.schedule.digest()).u64(self.active_set.digest());
        h.u128(self.burned_fees).u128(self.burned_slash).u64(self.seen_tx.len() as u64);
        h.finish64()
    }
}
