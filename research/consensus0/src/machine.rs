//! The consensus round state machine for one validator: design §3, following
//! Algorithm 1 of arXiv:1807.04938 ("the paper") with "2f+1" read as stake `≥ q`
//! and "f+1" as stake `≥ t1` (§3.5).
//!
//! Pure: no clock, no network, no disk, no threads, no randomness.
//! [`step`] maps `(state, input)` to `(state, outputs)`. The driver (the
//! simulator now, the node later) owns time, transport, storage and block
//! execution, and talks to the machine only through [`Input`] and [`Output`].
//!
//! # Contract with the driver
//! * Outputs are ordered. Every [`Output::Persist`] that precedes an
//!   [`Output::Broadcast`] in one output list must be durable (fsynced) before
//!   that message leaves the process (§3.7: "no lock file, no precommit").
//! * The machine delivers its own messages to itself; the driver must not rely
//!   on looping them back (doing so is harmless: duplicates are ignored).
//! * Block validity is the driver's: it executes the block and passes a
//!   [`Verdict`] with every proposal. The machine checks what consensus alone
//!   can check (signer, schedule, height, parent, `header.round`).
//! * After [`Output::Commit`] the machine is inert until
//!   [`Input::StartHeight`] for the next height.
//!
//! # Line references
//! Comments of the form `[A1:22]` name the line of Algorithm 1 a rule
//! implements. They were written from memory of the paper, not checked against
//! its text (no network access): every one is flagged in RESULTS.md for the
//! independent line-by-line review the exit criteria require.
//!
//! # Invariants (checked by the tests and the explorer)
//! * I1: at most one value is ever signed per `(type, height, round)` — the
//!   journal slot decides, also after a restart from persisted state.
//! * I2: `locked_round ≤ round`, `valid_round ≤ round`, `locked_round ≤ valid_round`.
//! * I3: a non-nil precommit in round `r` implies `locked == (r, that block)`.
//! * I4: `round` never decreases within a height.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::chain::Block;
use crate::mutation::{self, Mutation};
use crate::schedule::RoundProposers;
use crate::types::*;

/// Round timeouts, in milliseconds (§3.5, deviation D7): `min(base + r·delta, cap)`.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Timeouts {
    /// Propose timeout base.
    pub propose_base: TimeMs,
    /// Propose timeout growth per round.
    pub propose_delta: TimeMs,
    /// Prevote and precommit timeout base.
    pub vote_base: TimeMs,
    /// Prevote and precommit timeout growth per round.
    pub vote_delta: TimeMs,
    /// Cap on every round timeout.
    pub cap: TimeMs,
    /// Commit wait: time the next height waits for late precommits (§3.5, §3.6).
    pub commit_wait: TimeMs,
}

impl Timeouts {
    /// Decision 2: propose 6 s + 2 s per round, votes 2 s + 1 s, cap 120 s.
    pub const MODERATE: Timeouts = Timeouts { propose_base: 6_000, propose_delta: 2_000, vote_base: 2_000, vote_delta: 1_000, cap: 120_000, commit_wait: 500 };
    /// The "fast" row of §3.5.
    pub const FAST: Timeouts = Timeouts { propose_base: 3_000, propose_delta: 500, vote_base: 1_000, vote_delta: 500, cap: 60_000, commit_wait: 500 };
    /// The "slow" row of §3.5.
    pub const SLOW: Timeouts = Timeouts { propose_base: 20_000, propose_delta: 10_000, vote_base: 5_000, vote_delta: 5_000, cap: 300_000, commit_wait: 500 };

    fn grow(base: TimeMs, delta: TimeMs, cap: TimeMs, round: Round) -> TimeMs {
        base.saturating_add(delta.saturating_mul(TimeMs::from(round))).min(cap)
    }
    /// Propose timeout of `round`.
    pub fn propose(&self, round: Round) -> TimeMs {
        Self::grow(self.propose_base, self.propose_delta, self.cap, round)
    }
    /// Prevote / precommit timeout of `round`.
    pub fn vote(&self, round: Round) -> TimeMs {
        Self::grow(self.vote_base, self.vote_delta, self.cap, round)
    }
}

/// Static configuration of one machine.
#[derive(Clone, Debug)]
pub struct Config {
    /// Chain id, part of all signed bytes.
    pub chain_id: Arc<str>,
    /// The consensus key, or `None` for an observer that never signs.
    pub key: Option<SigningKey>,
    /// Round timeouts.
    pub timeouts: Timeouts,
    /// Heartbeat interval `T_HB` (§3.4).
    pub heartbeat_ms: TimeMs,
}

/// Everything the machine needs to work on one height. Produced by the driver
/// from the ledger after block `height − 1`.
#[derive(Clone, Debug)]
pub struct HeightCtx {
    /// The height to decide.
    pub height: Height,
    /// `E(height)`.
    pub set: Arc<ValidatorSet>,
    /// Proposers of this height by round (§3.3).
    pub proposers: RoundProposers,
    /// Hash of the committed block `height − 1`.
    pub parent: BlockId,
    /// Its header time.
    pub parent_time: TimeMs,
    /// The driver already holds an admissible transaction or evidence item (§3.4 rule 1).
    pub pending_work: bool,
}

/// A signed proposal (§3.2): the full block, the round, and `pol`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Proposal {
    /// Height.
    pub height: Height,
    /// Round of this proposal (not necessarily the round the block was built in).
    pub round: Round,
    /// The proposer's `valid_round`, or `None`.
    pub pol: Option<Round>,
    /// The block, byte-for-byte as first built.
    pub block: Arc<Block>,
    /// The proposer of `(height, round)`.
    pub proposer: KeyId,
    /// Signature over [`proposal_sign_bytes`].
    pub sig: Sig,
}

impl Proposal {
    /// Sign a proposal.
    pub fn sign(key: &SigningKey, chain_id: &str, height: Height, round: Round, pol: Option<Round>, block: Arc<Block>) -> Proposal {
        let sig = key.sign(&proposal_sign_bytes(chain_id, height, round, pol, &block.id()));
        Proposal { height, round, pol, block, proposer: key.id(), sig }
    }
    /// Verify the proposer's signature.
    pub fn verify(&self, chain_id: &str) -> bool {
        verify_sig(self.proposer, &proposal_sign_bytes(chain_id, self.height, self.round, self.pol, &self.block.id()), &self.sig)
    }
}

/// A consensus message.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Message {
    /// A proposal.
    Proposal(Proposal),
    /// A prevote or precommit.
    Vote(Vote),
}

impl Message {
    /// Height the message belongs to.
    pub fn height(&self) -> Height {
        match self {
            Message::Proposal(p) => p.height,
            Message::Vote(v) => v.height,
        }
    }
}

/// The driver's judgement of a proposed block (§3.5 "valid proposal").
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Verdict {
    /// Every rule holds, including T2 against the local clock.
    Valid,
    /// Valid except T2: header time too far ahead of the local clock. A nil
    /// prevote in this round, not a rejection of the block for ever.
    TimeAhead,
    /// The block breaks a rule (execution, state root, T1, certificate, …).
    Invalid,
}

/// Timer kinds.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum TimerKind {
    /// `timeoutPropose`.
    Propose,
    /// `timeoutPrevote`.
    Prevote,
    /// `timeoutPrecommit`.
    Precommit,
    /// The commit wait before a new height may start by rules 1–2 of §3.4.
    CommitWait,
}

/// Inputs.
#[derive(Clone, Debug)]
pub enum Input {
    /// Begin work on a height (after the driver applied the previous block).
    StartHeight(HeightCtx),
    /// A proposal with the driver's verdict on its block.
    Proposal {
        /// The message.
        proposal: Proposal,
        /// Block validity as judged by the driver.
        verdict: Verdict,
    },
    /// A prevote or precommit (nil included).
    Vote(Vote),
    /// A timer set by [`Output::SetTimer`] expired.
    Timeout {
        /// Which timer.
        kind: TimerKind,
        /// Height it was set for.
        height: Height,
        /// Round it was set for.
        round: Round,
    },
    /// An admissible transaction or evidence item is pending (§3.4 rule 1).
    TxPending,
    /// The local clock reached `time(h−1) + T_HB` (§3.4 rule 2).
    HeartbeatDue {
        /// Height the heartbeat is for.
        height: Height,
    },
    /// The block requested by [`Output::NeedBlock`].
    BlockBuilt {
        /// Height.
        height: Height,
        /// Round.
        round: Round,
        /// The block, built by this validator with `header.round == round`.
        block: Arc<Block>,
    },
    /// A block with a commit certificate, received while catching up (§3.8).
    CatchUp {
        /// The block.
        block: Arc<Block>,
        /// A certificate for it.
        cert: CommitCert,
        /// Block validity as judged by the driver (T2 does not apply to committed blocks).
        verdict: Verdict,
    },
}

/// What must be durable before the following message is released (§3.7).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PersistRecord {
    /// A new height began: older per-height records may be discarded.
    Height {
        /// The height.
        height: Height,
    },
    /// Journal slot `(type, height, round) → block or nil`.
    VoteSlot {
        /// Vote type.
        kind: VoteType,
        /// Height.
        height: Height,
        /// Round.
        round: Round,
        /// Value signed.
        value: Option<BlockId>,
    },
    /// Journal slot `(height, round) → block`, plus the block.
    ProposalSlot {
        /// Height.
        height: Height,
        /// Round.
        round: Round,
        /// `pol` of the proposal.
        pol: Option<Round>,
        /// The proposed block.
        block: Arc<Block>,
    },
    /// The lock, with the full block.
    Lock {
        /// Height.
        height: Height,
        /// `locked_round`.
        round: Round,
        /// `locked_block`.
        block: Arc<Block>,
    },
    /// `height`, `round`, `valid_round`, `valid_block`.
    RoundState {
        /// Height.
        height: Height,
        /// Round entered.
        round: Round,
        /// `valid_round` and `valid_block`.
        valid: Option<(Round, Arc<Block>)>,
    },
}

/// Outputs.
#[derive(Clone, Debug)]
pub enum Output {
    /// Make this durable before releasing any later message of this list.
    Persist(PersistRecord),
    /// Send to every peer.
    Broadcast(Message),
    /// Start a timer; deliver [`Input::Timeout`] with the same fields after `ms`.
    SetTimer {
        /// Which timer.
        kind: TimerKind,
        /// Height.
        height: Height,
        /// Round.
        round: Round,
        /// Duration.
        ms: TimeMs,
    },
    /// Deliver [`Input::HeartbeatDue`] when the local clock reaches `time_ms`.
    WakeAtHeaderTime {
        /// Height the heartbeat is for.
        height: Height,
        /// `time(h−1) + T_HB`.
        time_ms: TimeMs,
    },
    /// This validator is the proposer and has no valid block: build one with
    /// `header.round == round` and answer with [`Input::BlockBuilt`], or do not
    /// answer if there is nothing to propose (§3.4).
    NeedBlock {
        /// Height.
        height: Height,
        /// Round.
        round: Round,
    },
    /// Decision: apply and append `block`; `cert` is the certificate seen so far.
    Commit {
        /// The committed block.
        block: Arc<Block>,
        /// Precommits held for it at the moment of commit.
        cert: CommitCert,
    },
    /// A duplicate vote was observed (§4.2): the driver should submit it.
    Evidence(Evidence),
}

/// Step within a height. `NewHeight` is the on-demand waiting state of §3.4 (deviation D2).
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Step {
    /// Waiting for a reason to start round 0.
    NewHeight,
    /// Waiting for a proposal.
    Propose,
    /// Prevoted; waiting for prevotes.
    Prevote,
    /// Precommitted; waiting for precommits.
    Precommit,
    /// Decided; waiting for [`Input::StartHeight`].
    Committed,
}

/// The durable consensus state of §3.7, as rebuilt from [`PersistRecord`]s.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct PersistedState {
    /// Height of the records.
    pub height: Height,
    /// True once round 0 of `height` was entered (a height that is still waiting
    /// in "new height", §3.4, has nothing to resume).
    pub started: bool,
    /// Highest round entered.
    pub round: Round,
    /// `locked_round`, `locked_block`.
    pub locked: Option<(Round, Arc<Block>)>,
    /// `valid_round`, `valid_block`.
    pub valid: Option<(Round, Arc<Block>)>,
    /// Vote journal.
    pub votes: BTreeMap<(VoteType, Round), Option<BlockId>>,
    /// Proposal journal.
    pub proposals: BTreeMap<Round, (Option<Round>, Arc<Block>)>,
}

impl PersistedState {
    /// Fold one record in. Records of an older height are ignored; a newer height resets.
    pub fn apply(&mut self, rec: &PersistRecord) {
        let height = match rec {
            PersistRecord::Height { height }
            | PersistRecord::VoteSlot { height, .. }
            | PersistRecord::ProposalSlot { height, .. }
            | PersistRecord::Lock { height, .. }
            | PersistRecord::RoundState { height, .. } => *height,
        };
        if height < self.height {
            return;
        }
        if height > self.height {
            *self = PersistedState { height, ..PersistedState::default() };
        }
        match rec {
            PersistRecord::Height { .. } => {}
            PersistRecord::VoteSlot { kind, round, value, .. } => {
                // First write wins: a journal slot is immutable (`journal.rs:103-127`).
                self.votes.entry((*kind, *round)).or_insert(*value);
            }
            PersistRecord::ProposalSlot { round, pol, block, .. } => {
                self.proposals.entry(*round).or_insert((*pol, block.clone()));
            }
            PersistRecord::Lock { round, block, .. } => self.locked = Some((*round, block.clone())),
            PersistRecord::RoundState { round, valid, .. } => {
                self.started = true;
                self.round = self.round.max(*round);
                self.valid = valid.clone();
            }
        }
    }
}

/// Votes of one type in one round.
///
/// A validator counts **once per value** and once in `total`. An equivocator's
/// stake therefore counts towards each value it signed, exactly as in the
/// paper's message-log model ("2f+1 ⟨PREVOTE, h, r, id(v)⟩" counts senders of
/// *that* message). Counting only the first vote seen — what the current
/// verifier does (`core/finality/src/lib.rs:95-97`) — lets one equivocating
/// validator below one third leave honest validators with different views of
/// the same quorum for ever; see RESULTS.md, finding F1.
#[derive(Clone, Debug, Default)]
struct Tally {
    votes: BTreeMap<(KeyId, Option<BlockId>), Vote>,
    first: BTreeMap<KeyId, Vote>,
    by_value: BTreeMap<Option<BlockId>, Weight>,
    total: Weight,
}

impl Tally {
    fn weight_for(&self, value: &Option<BlockId>) -> Weight {
        self.by_value.get(value).copied().unwrap_or(0)
    }
    /// A non-nil value holding at least `q`.
    fn quorum_block(&self, q: Weight) -> Option<BlockId> {
        self.by_value.iter().find_map(|(v, w)| if *w >= q { *v } else { None })
    }
}

#[derive(Clone, Debug)]
struct ProposalRec {
    proposal: Proposal,
    time_ok: bool,
}

#[derive(Clone, Debug, Default)]
struct RoundBook {
    prevotes: Tally,
    precommits: Tally,
    /// Distinct validators that sent anything for this round, and their weight [A1:55].
    senders: BTreeSet<KeyId>,
    sender_weight: Weight,
    /// Valid proposals for this round by its scheduled proposer, in arrival order
    /// (more than one only if the proposer equivocated).
    proposals: Vec<ProposalRec>,
    /// Blocks proposed for this round that the driver judged invalid.
    invalid: BTreeSet<BlockId>,
    prevote_timer: bool,
    precommit_timer: bool,
    valid_rule_done: bool,
}

#[derive(Clone, Debug)]
struct LastCommit {
    height: Height,
    round: Round,
    block: BlockId,
    set: Arc<ValidatorSet>,
    sigs: BTreeMap<KeyId, Sig>,
}

/// One validator's consensus state (§3.1) plus its message log for the height.
#[derive(Clone, Debug)]
pub struct Machine {
    cfg: Config,
    height: Height,
    round: Round,
    step: Step,
    locked: Option<(Round, BlockId)>,
    valid: Option<(Round, BlockId)>,
    set: Arc<ValidatorSet>,
    proposers: RoundProposers,
    parent: BlockId,
    parent_time: TimeMs,
    rounds: BTreeMap<Round, RoundBook>,
    /// Blocks received in a correctly signed proposal and not judged invalid.
    blocks: BTreeMap<BlockId, Arc<Block>>,
    /// Distinct voters seen at this height, for §3.4 rule 4.
    height_voters: BTreeSet<KeyId>,
    height_voter_weight: Weight,
    /// In-memory mirror of the signing journal for this height (invariant I1).
    journal: BTreeMap<(VoteType, Round), Option<BlockId>>,
    my_proposals: BTreeMap<Round, Proposal>,
    pending_work: bool,
    heartbeat_due: bool,
    commit_wait_done: bool,
    awaiting_block: Option<Round>,
    last_commit: Option<LastCommit>,
}

/// The pure transition function of §9: `step(state, input) → (state, outputs)`.
pub fn step(mut state: Machine, input: Input) -> (Machine, Vec<Output>) {
    let out = state.handle(input);
    (state, out)
}

impl Machine {
    /// A machine waiting in "new height" (§3.4) for `ctx.height`.
    pub fn new(cfg: Config, ctx: HeightCtx) -> (Machine, Vec<Output>) {
        let mut m = Machine {
            cfg,
            height: ctx.height.saturating_sub(1),
            round: 0,
            step: Step::Committed,
            locked: None,
            valid: None,
            set: ctx.set.clone(),
            proposers: ctx.proposers.clone(),
            parent: ctx.parent,
            parent_time: ctx.parent_time,
            rounds: BTreeMap::new(),
            blocks: BTreeMap::new(),
            height_voters: BTreeSet::new(),
            height_voter_weight: 0,
            journal: BTreeMap::new(),
            my_proposals: BTreeMap::new(),
            pending_work: false,
            heartbeat_due: false,
            commit_wait_done: true,
            awaiting_block: None,
            last_commit: None,
        };
        let mut out = Vec::new();
        m.start_height(ctx, &mut out);
        m.evaluate(&mut out);
        (m, out)
    }

    /// Restart from the durable state of §3.7: reload, never re-enter a round
    /// below the stored one, re-send the journaled messages, resume.
    ///
    /// If `saved` belongs to another height it is ignored (nothing was signed
    /// for `ctx.height` yet). Starting a machine with [`Machine::new`] after a
    /// crash inside a height is the "restart WITHOUT persisted state" fault and
    /// is unsafe; the simulator shows it.
    pub fn restore(cfg: Config, ctx: HeightCtx, saved: &PersistedState) -> (Machine, Vec<Output>) {
        let (mut m, mut out) = Machine::new(cfg, ctx);
        // Nothing to resume if the records are for another height, or the height
        // had not started: the machine then waits in "new height" like a fresh one.
        if saved.height != m.height || !saved.started || m.step == Step::Committed {
            return (m, out);
        }
        out.clear();
        if let Some((r, b)) = &saved.locked {
            m.locked = Some((*r, b.id()));
            m.blocks.insert(b.id(), b.clone());
        }
        if let Some((r, b)) = &saved.valid {
            m.valid = Some((*r, b.id()));
            m.blocks.insert(b.id(), b.clone());
        }
        m.journal = saved.votes.clone();
        if let Some(key) = m.signer() {
            for (round, (pol, block)) in &saved.proposals {
                // Re-signing identical bytes is harmless (`journal.rs:12-14`).
                let p = Proposal::sign(&key, &m.cfg.chain_id, m.height, *round, *pol, block.clone());
                m.my_proposals.insert(*round, p.clone());
                // The proposal of the round being resumed is sent again by enter_round below.
                if *round != saved.round {
                    out.push(Output::Broadcast(Message::Proposal(p.clone())));
                }
                m.record_proposal(p, Verdict::Valid);
            }
            for ((kind, round), value) in saved.votes.clone() {
                let vote = Vote::sign(&key, &m.cfg.chain_id, kind, m.height, round, value);
                out.push(Output::Broadcast(Message::Vote(vote)));
                m.record_vote(vote, &mut out);
            }
        }
        m.commit_wait_done = true;
        m.enter_round(saved.round, &mut out);
        // Resume at the step the journal proves was reached in that round.
        if m.journal.contains_key(&(VoteType::Precommit, m.round)) {
            m.step = Step::Precommit;
        } else if m.journal.contains_key(&(VoteType::Prevote, m.round)) {
            m.step = Step::Prevote;
        }
        m.evaluate(&mut out);
        (m, out)
    }

    // ----- read-only access -------------------------------------------------

    /// Height being decided (or just decided, while [`Step::Committed`]).
    pub fn height(&self) -> Height {
        self.height
    }
    /// Current round.
    pub fn round(&self) -> Round {
        self.round
    }
    /// Current step.
    pub fn step(&self) -> Step {
        self.step
    }
    /// `(locked_round, locked_block)`.
    pub fn locked(&self) -> Option<(Round, BlockId)> {
        self.locked
    }
    /// `(valid_round, valid_block)`.
    pub fn valid(&self) -> Option<(Round, BlockId)> {
        self.valid
    }
    /// `E(height)`.
    pub fn set(&self) -> &Arc<ValidatorSet> {
        &self.set
    }
    /// Proposer of `round` at this height.
    pub fn proposer(&mut self, round: Round) -> Option<KeyId> {
        self.proposers.get(round)
    }
    /// True while waiting in "new height": no round of this height has started here.
    pub fn is_idle(&self) -> bool {
        matches!(self.step, Step::NewHeight)
    }
    /// The value this machine signed in a slot, if any (invariant I1).
    pub fn signed(&self, kind: VoteType, round: Round) -> Option<Option<BlockId>> {
        self.journal.get(&(kind, round)).copied()
    }

    /// The certificate for the last committed block listing **every** precommit
    /// held for the commit round (§3.6, deviation D6). `None` before the first commit.
    pub fn parent_certificate(&self) -> Option<CommitCert> {
        let lc = self.last_commit.as_ref()?;
        Some(CommitCert {
            domain: Domain::V3,
            height: lc.height,
            round: lc.round,
            block: lc.block,
            n_set: u16::try_from(lc.set.len()).ok()?,
            sigs: lc.sigs.iter().map(|(k, s)| (*k, *s)).collect(),
        })
    }

    /// Every message of the current height this machine holds (for gossip, §3.8).
    pub fn messages(&self) -> Vec<Message> {
        let mut out = Vec::new();
        for book in self.rounds.values() {
            out.extend(book.proposals.iter().map(|p| Message::Proposal(p.proposal.clone())));
            out.extend(book.prevotes.votes.values().map(|v| Message::Vote(*v)));
            out.extend(book.precommits.votes.values().map(|v| Message::Vote(*v)));
        }
        out
    }

    /// Would delivering `msg` be a no-op because it (or a vote in its slot) is already held?
    pub fn has(&self, msg: &Message) -> bool {
        match msg {
            Message::Vote(v) => {
                if let Some(lc) = &self.last_commit {
                    if v.height == lc.height && v.height != self.height {
                        return lc.sigs.contains_key(&v.voter) || v.kind != VoteType::Precommit || v.round != lc.round;
                    }
                }
                if v.height != self.height {
                    return true;
                }
                self.rounds.get(&v.round).is_some_and(|b| match v.kind {
                    VoteType::Prevote => b.prevotes.votes.contains_key(&(v.voter, v.block)),
                    VoteType::Precommit => b.precommits.votes.contains_key(&(v.voter, v.block)),
                })
            }
            Message::Proposal(p) => {
                p.height != self.height
                    || self.rounds.get(&p.round).is_some_and(|b| b.invalid.contains(&p.block.id()) || b.proposals.iter().any(|x| x.proposal.block.id() == p.block.id() && x.proposal.pol == p.pol))
            }
        }
    }

    /// Late precommits of the last committed height held so far (for gossip).
    pub fn last_commit_votes(&self) -> Vec<Vote> {
        match &self.last_commit {
            None => Vec::new(),
            Some(lc) => lc
                .sigs
                .iter()
                .map(|(k, s)| Vote { kind: VoteType::Precommit, height: lc.height, round: lc.round, block: Some(lc.block), voter: *k, sig: *s })
                .collect(),
        }
    }

    /// Stable digest of the complete state (P10, explorer deduplication).
    pub fn state_hash(&self) -> u64 {
        let mut h = Hasher::new("machine");
        h.u64(self.height).u64(u64::from(self.round)).u64(self.step as u64);
        for slot in [&self.locked, &self.valid] {
            match slot {
                None => h.u64(u64::MAX),
                Some((r, id)) => h.u64(u64::from(*r)).id(id),
            };
        }
        h.u64(self.set.digest()).u64(self.proposers.digest()).id(&self.parent).u64(self.parent_time);
        for (r, b) in &self.rounds {
            h.u64(u64::from(*r));
            for t in [&b.prevotes, &b.precommits] {
                h.u64(t.votes.len() as u64);
                for v in t.votes.values() {
                    h.u64(u64::from(v.voter.0)).opt_id(v.block.as_ref()).u64(v.sig.tag);
                }
            }
            for p in &b.proposals {
                h.id(&p.proposal.block.id()).u64(p.proposal.pol.map_or(0, |x| u64::from(x) + 1)).u64(u64::from(p.time_ok));
            }
            for id in &b.invalid {
                h.id(id);
            }
            h.u64(u64::from(b.prevote_timer) | u64::from(b.precommit_timer) << 1 | u64::from(b.valid_rule_done) << 2);
            h.u64(b.senders.len() as u64).u128(b.sender_weight);
        }
        for id in self.blocks.keys() {
            h.id(id);
        }
        for ((k, r), v) in &self.journal {
            h.u64(*k as u64).u64(u64::from(*r)).opt_id(v.as_ref());
        }
        for r in self.my_proposals.keys() {
            h.u64(u64::from(*r));
        }
        h.u64(u64::from(self.pending_work) | u64::from(self.heartbeat_due) << 1 | u64::from(self.commit_wait_done) << 2);
        h.u64(self.awaiting_block.map_or(0, |r| u64::from(r) + 1));
        if let Some(lc) = &self.last_commit {
            h.u64(lc.height).u64(u64::from(lc.round)).id(&lc.block).u64(lc.sigs.len() as u64);
            for k in lc.sigs.keys() {
                h.u64(u64::from(k.0));
            }
        }
        h.finish64()
    }

    // ----- input handling ---------------------------------------------------

    /// Apply one input in place and return the outputs. [`step`] is the by-value form.
    pub fn handle(&mut self, input: Input) -> Vec<Output> {
        let mut out = Vec::new();
        match input {
            Input::StartHeight(ctx) => {
                // Only forward, and only once the current height is decided.
                if ctx.height == self.height + 1 && self.step == Step::Committed {
                    self.start_height(ctx, &mut out);
                    self.evaluate(&mut out);
                }
            }
            Input::Proposal { proposal, verdict } => {
                if self.check_proposal(&proposal) {
                    let verdict = self.structural_verdict(&proposal, verdict);
                    self.record_proposal(proposal, verdict);
                    self.evaluate(&mut out);
                }
            }
            Input::Vote(vote) => self.on_vote(vote, &mut out),
            Input::Timeout { kind, height, round } => self.on_timeout(kind, height, round, &mut out),
            Input::TxPending => {
                self.pending_work = true;
                self.evaluate(&mut out);
            }
            Input::HeartbeatDue { height } => {
                if height == self.height && self.step != Step::Committed {
                    self.heartbeat_due = true;
                    self.evaluate(&mut out);
                }
            }
            Input::BlockBuilt { height, round, block } => self.on_block_built(height, round, block, &mut out),
            Input::CatchUp { block, cert, verdict } => self.on_catch_up(block, cert, verdict, &mut out),
        }
        out
    }

    fn signer(&self) -> Option<SigningKey> {
        self.cfg.key.filter(|k| self.set.contains(k.id()))
    }

    fn start_height(&mut self, ctx: HeightCtx, out: &mut Vec<Output>) {
        // Keep collecting late precommits only for the block directly below.
        if self.last_commit.as_ref().is_some_and(|lc| lc.height + 1 != ctx.height) {
            self.last_commit = None;
        }
        self.height = ctx.height;
        self.round = 0;
        self.step = Step::NewHeight;
        self.locked = None;
        self.valid = None;
        self.set = ctx.set;
        self.proposers = ctx.proposers;
        self.parent = ctx.parent;
        self.parent_time = ctx.parent_time;
        self.rounds.clear();
        self.blocks.clear();
        self.height_voters.clear();
        self.height_voter_weight = 0;
        self.journal.clear();
        self.my_proposals.clear();
        self.pending_work = ctx.pending_work;
        self.heartbeat_due = false;
        self.awaiting_block = None;
        if self.signer().is_some() {
            out.push(Output::Persist(PersistRecord::Height { height: self.height }));
        }
        out.push(Output::WakeAtHeaderTime { height: self.height, time_ms: self.parent_time.saturating_add(self.cfg.heartbeat_ms) });
        // Commit wait (§3.5, §3.6): give late precommits of the parent time to
        // arrive so the certificate lists everyone. Skipped when every member of
        // the parent's set is already held or there is no parent commit (rule R7).
        let complete = self.last_commit.as_ref().is_none_or(|lc| lc.sigs.len() >= lc.set.len());
        self.commit_wait_done = complete || self.cfg.timeouts.commit_wait == 0;
        if !self.commit_wait_done {
            out.push(Output::SetTimer { kind: TimerKind::CommitWait, height: self.height, round: 0, ms: self.cfg.timeouts.commit_wait });
        }
    }

    /// Checks on a proposal that decide whether it is *counted at all*: right
    /// height, signed by the scheduled proposer of its round (§3.5 "valid proposal", first clause).
    fn check_proposal(&mut self, p: &Proposal) -> bool {
        if p.height != self.height || self.step == Step::Committed {
            return false;
        }
        self.proposers.get(p.round) == Some(p.proposer) && p.verify(&self.cfg.chain_id)
    }

    /// Consensus-level block checks; any failure downgrades the verdict to `Invalid`.
    fn structural_verdict(&mut self, p: &Proposal, verdict: Verdict) -> Verdict {
        let hd = &p.block.header;
        let ok = hd.height == self.height
            && hd.parent == self.parent
            // header.round ≤ r, and the header's proposer is the scheduled proposer of (h, header.round).
            && hd.round <= p.round
            && self.proposers.get(hd.round) == Some(hd.builder)
            // A proof-of-lock round must be an earlier round [A1:28 "vr < round_p"].
            && p.pol.is_none_or(|vr| vr < p.round);
        if ok {
            verdict
        } else {
            Verdict::Invalid
        }
    }

    fn note_sender(&mut self, round: Round, key: KeyId) {
        let w = self.set.weight(key);
        let book = self.rounds.entry(round).or_default();
        if book.senders.insert(key) {
            book.sender_weight += w;
        }
    }

    fn record_proposal(&mut self, p: Proposal, verdict: Verdict) {
        self.note_sender(p.round, p.proposer);
        let id = p.block.id();
        let book = self.rounds.entry(p.round).or_default();
        if verdict == Verdict::Invalid {
            book.invalid.insert(id);
            return;
        }
        if book.proposals.iter().any(|x| x.proposal.block.id() == id && x.proposal.pol == p.pol) {
            return;
        }
        self.blocks.insert(id, p.block.clone());
        book.proposals.push(ProposalRec { proposal: p, time_ok: verdict == Verdict::Valid });
    }

    /// Store a vote whose signature and membership were already checked (or
    /// that this machine just signed). Emits evidence on a duplicate vote.
    fn record_vote(&mut self, vote: Vote, out: &mut Vec<Output>) {
        let w = self.set.weight(vote.voter);
        self.note_sender(vote.round, vote.voter);
        if self.height_voters.insert(vote.voter) {
            self.height_voter_weight += w;
        }
        // A further value from the same validator is counted only if it is nil or a
        // block this node holds a proposal for; that bounds what an equivocator can
        // make a node store (rule R10). Gossip offers the vote again once the block is known.
        let known = vote.block.is_none_or(|id| self.blocks.contains_key(&id));
        let book = self.rounds.entry(vote.round).or_default();
        let tally = match vote.kind {
            VoteType::Prevote => &mut book.prevotes,
            VoteType::Precommit => &mut book.precommits,
        };
        if tally.votes.contains_key(&(vote.voter, vote.block)) {
            return;
        }
        match tally.first.get(&vote.voter) {
            Some(prev) => {
                // A duplicate vote: evidence (§4.2), and still a vote for its own value.
                if let Some(ev) = Evidence::from_votes(prev, &vote) {
                    out.push(Output::Evidence(ev));
                }
                if known {
                    tally.votes.insert((vote.voter, vote.block), vote);
                    *tally.by_value.entry(vote.block).or_insert(0) += w;
                }
            }
            None => {
                tally.first.insert(vote.voter, vote);
                tally.votes.insert((vote.voter, vote.block), vote);
                *tally.by_value.entry(vote.block).or_insert(0) += w;
                tally.total += w;
            }
        }
    }

    fn on_vote(&mut self, vote: Vote, out: &mut Vec<Output>) {
        // Late precommits for the committed block below (§3.6, deviation D6).
        if let Some(lc) = &mut self.last_commit {
            if vote.height == lc.height
                && vote.kind == VoteType::Precommit
                && vote.round == lc.round
                && vote.block == Some(lc.block)
                && lc.set.contains(vote.voter)
                && !lc.sigs.contains_key(&vote.voter)
                && vote.verify(Domain::V3, &self.cfg.chain_id)
            {
                lc.sigs.insert(vote.voter, vote.sig);
                // Every member of the parent's set is now held: nothing left to wait for (rule R7).
                if lc.sigs.len() >= lc.set.len() && lc.height + 1 == self.height && !self.commit_wait_done {
                    self.commit_wait_done = true;
                    self.evaluate(out);
                }
            }
        }
        if vote.height != self.height || !self.set.contains(vote.voter) || !vote.verify(Domain::V3, &self.cfg.chain_id) {
            return;
        }
        self.record_vote(vote, out);
        if self.step != Step::Committed {
            self.evaluate(out);
        }
    }

    fn on_timeout(&mut self, kind: TimerKind, height: Height, round: Round, out: &mut Vec<Output>) {
        if height != self.height || matches!(self.step, Step::Committed) {
            return;
        }
        match kind {
            TimerKind::CommitWait => self.commit_wait_done = true,
            // [A1:57] OnTimeoutPropose: if still in this round at step propose, prevote nil.
            TimerKind::Propose => {
                if round == self.round && self.step == Step::Propose {
                    self.cast(VoteType::Prevote, None, out);
                    self.step = Step::Prevote;
                }
            }
            // [A1:61] OnTimeoutPrevote: if still in this round at step prevote, precommit nil.
            TimerKind::Prevote => {
                if round == self.round && self.step == Step::Prevote {
                    self.cast(VoteType::Precommit, None, out);
                    self.step = Step::Precommit;
                }
            }
            // [A1:65] OnTimeoutPrecommit: if still in this round, start the next one.
            TimerKind::Precommit => {
                if round == self.round && self.step != Step::NewHeight {
                    self.enter_round(round.saturating_add(1), out);
                }
            }
        }
        self.evaluate(out);
    }

    fn on_block_built(&mut self, height: Height, round: Round, block: Arc<Block>, out: &mut Vec<Output>) {
        let Some(key) = self.signer() else { return };
        let hd = &block.header;
        let expected = height == self.height
            && round == self.round
            && self.step == Step::Propose
            && self.awaiting_block == Some(round)
            && self.valid.is_none()
            && !self.my_proposals.contains_key(&round)
            && hd.height == height
            && hd.round == round
            && hd.builder == key.id()
            && hd.parent == self.parent;
        if !expected {
            return;
        }
        self.awaiting_block = None;
        self.propose(&key, round, None, block, out);
        self.evaluate(out);
    }

    fn on_catch_up(&mut self, block: Arc<Block>, cert: CommitCert, verdict: Verdict, out: &mut Vec<Output>) {
        // §3.8: block h is accepted with a certificate for it. T2 is a prevote
        // rule and does not apply to a block that already has a certificate.
        let ok = self.step != Step::Committed
            && verdict != Verdict::Invalid
            && block.header.height == self.height
            && block.header.parent == self.parent
            && cert.height == self.height
            && cert.block == block.id()
            && cert.round >= block.header.round
            && cert.verify(Domain::V3, &self.cfg.chain_id, &self.set).is_ok();
        if !ok {
            return;
        }
        self.decide(block, cert.round, cert.sigs.iter().copied().collect(), out);
    }

    fn decide(&mut self, block: Arc<Block>, round: Round, sigs: BTreeMap<KeyId, Sig>, out: &mut Vec<Output>) {
        let lc = LastCommit { height: self.height, round, block: block.id(), set: self.set.clone(), sigs };
        self.last_commit = Some(lc);
        self.step = Step::Committed;
        if let Some(cert) = self.parent_certificate() {
            out.push(Output::Commit { block, cert });
        }
    }

    // ----- signing ----------------------------------------------------------

    /// Sign and broadcast a vote for the current round. The journal slot
    /// decides the value: if this `(type, round)` was already signed, the
    /// journaled value is sent again and `value` is ignored (invariant I1).
    fn cast(&mut self, kind: VoteType, value: Option<BlockId>, out: &mut Vec<Output>) {
        let Some(key) = self.signer() else { return };
        let round = self.round;
        let value = match self.journal.get(&(kind, round)) {
            Some(journaled) => *journaled,
            None => {
                self.journal.insert((kind, round), value);
                out.push(Output::Persist(PersistRecord::VoteSlot { kind, height: self.height, round, value }));
                value
            }
        };
        let vote = Vote::sign(&key, &self.cfg.chain_id, kind, self.height, round, value);
        out.push(Output::Broadcast(Message::Vote(vote)));
        self.record_vote(vote, out);
    }

    fn propose(&mut self, key: &SigningKey, round: Round, pol: Option<Round>, block: Arc<Block>, out: &mut Vec<Output>) {
        let p = Proposal::sign(key, &self.cfg.chain_id, self.height, round, pol, block.clone());
        self.my_proposals.insert(round, p.clone());
        out.push(Output::Persist(PersistRecord::ProposalSlot { height: self.height, round, pol, block }));
        out.push(Output::Broadcast(Message::Proposal(p.clone())));
        self.record_proposal(p, Verdict::Valid);
    }

    fn persist_round_state(&self, out: &mut Vec<Output>) {
        if self.signer().is_none() {
            return;
        }
        let valid = self.valid.and_then(|(r, id)| self.blocks.get(&id).map(|b| (r, b.clone())));
        out.push(Output::Persist(PersistRecord::RoundState { height: self.height, round: self.round, valid }));
    }

    // ----- the rules ----------------------------------------------------------

    /// [A1:11] StartRound.
    fn enter_round(&mut self, round: Round, out: &mut Vec<Output>) {
        self.round = round;
        self.step = Step::Propose;
        self.awaiting_block = None;
        self.rounds.entry(round).or_default();
        self.persist_round_state(out);
        // The propose timeout runs for the proposer too: unlike in the paper, a
        // proposer here may have nothing to propose (§3.4), and must still move on (rule R6).
        out.push(Output::SetTimer { kind: TimerKind::Propose, height: self.height, round, ms: self.cfg.timeouts.propose(round) });
        let Some(key) = self.signer() else { return };
        if self.proposers.get(round) != Some(key.id()) {
            return;
        }
        // One proposal per (height, round): after a restart the journaled one is sent again.
        if let Some(p) = self.my_proposals.get(&round).cloned() {
            out.push(Output::Broadcast(Message::Proposal(p.clone())));
            self.record_proposal(p, Verdict::Valid);
            return;
        }
        // [A1:15-16] propose valid_block if there is one, with pol = valid_round.
        if let Some((vr, id)) = self.valid {
            if let Some(block) = self.blocks.get(&id).cloned() {
                self.propose(&key, round, Some(vr), block, out);
            }
            return;
        }
        // [A1:18] getValue(): ask the driver for a block with header.round = round.
        self.awaiting_block = Some(round);
        out.push(Output::NeedBlock { height: self.height, round });
    }

    /// §3.4: may round 0 of this height start?
    fn may_start(&self) -> bool {
        // Rules 1 and 2 wait for the commit wait; rules 3 and 4 do not, because
        // someone else has already started (rule R7).
        let own_reason = self.commit_wait_done && (self.pending_work || self.heartbeat_due);
        let proposal_seen = self.rounds.values().any(|b| !b.proposals.is_empty());
        let others_voting = self.height_voter_weight >= self.set.one_third();
        own_reason || proposal_seen || others_voting
    }

    /// Run every enabled rule until none fires. Terminates: each iteration
    /// either returns or strictly advances `(step, round)` or sets a once-only flag.
    fn evaluate(&mut self, out: &mut Vec<Output>) {
        loop {
            if self.step == Step::Committed {
                return;
            }
            // [A1:49] commit from any round, also while still waiting in NewHeight (§3.8).
            if self.try_commit(out) {
                return;
            }
            if self.step == Step::NewHeight {
                if !self.may_start() {
                    return;
                }
                self.enter_round(0, out);
                continue;
            }
            // [A1:55] votes from stake ≥ t1 in a later round: start that round.
            if let Some(r) = self.skip_target() {
                self.enter_round(r, out);
                continue;
            }
            if self.step == Step::Propose && self.try_prevote(out) {
                continue;
            }
            if self.try_lock(out) {
                continue;
            }
            let q = self.set.quorum();
            let round = self.round;
            let (prevote_nil, prevote_total, precommit_total, pt, ct) = {
                let b = self.rounds.entry(round).or_default();
                (b.prevotes.weight_for(&None), b.prevotes.total, b.precommits.total, b.prevote_timer, b.precommit_timer)
            };
            // [A1:44] prevotes ≥ q for nil while step = prevote: precommit nil.
            if self.step == Step::Prevote && prevote_nil >= q {
                self.cast(VoteType::Precommit, None, out);
                self.step = Step::Precommit;
                continue;
            }
            // [A1:34] prevotes ≥ q for anything, first time, while step = prevote: start the prevote timeout.
            if self.step == Step::Prevote && prevote_total >= q && !pt {
                self.rounds.entry(round).or_default().prevote_timer = true;
                out.push(Output::SetTimer { kind: TimerKind::Prevote, height: self.height, round, ms: self.cfg.timeouts.vote(round) });
            }
            // [A1:47] precommits ≥ q for anything, first time: start the precommit timeout.
            if precommit_total >= q && !ct {
                self.rounds.entry(round).or_default().precommit_timer = true;
                out.push(Output::SetTimer { kind: TimerKind::Precommit, height: self.height, round, ms: self.cfg.timeouts.vote(round) });
            }
            return;
        }
    }

    /// [A1:49] precommits ≥ q for a block in any round, and the block is known.
    ///
    /// Made explicit (rule R1): "known" means received in a correctly signed
    /// proposal of *any* round of this height and not judged invalid. The paper
    /// asks for the proposal of the commit round itself; the two differ only
    /// when a re-proposed block's later proposal message was missed, and §3.8
    /// already lets block + certificate commit on their own.
    fn try_commit(&mut self, out: &mut Vec<Output>) -> bool {
        let q = self.set.quorum();
        let found = self.rounds.iter().find_map(|(r, b)| b.precommits.quorum_block(q).filter(|id| self.blocks.contains_key(id)).map(|id| (*r, id)));
        let Some((round, id)) = found else { return false };
        let Some(block) = self.blocks.get(&id).cloned() else { return false };
        let sigs: BTreeMap<KeyId, Sig> = self
            .rounds
            .get(&round)
            .map(|b| b.precommits.votes.values().filter(|v| v.block == Some(id)).map(|v| (v.voter, v.sig)).collect())
            .unwrap_or_default();
        self.decide(block, round, sigs, out);
        true
    }

    /// [A1:55] the highest later round in which distinct senders hold ≥ t1 (rule R2: highest).
    fn skip_target(&self) -> Option<Round> {
        let t1 = self.set.one_third();
        self.rounds.range(self.round.saturating_add(1)..).filter(|(_, b)| b.sender_weight >= t1).map(|(r, _)| *r).next_back()
    }

    /// [A1:22] and [A1:28]: act on a proposal while step = propose.
    fn try_prevote(&mut self, out: &mut Vec<Output>) -> bool {
        let q = self.set.quorum();
        let round = self.round;
        let mut decision: Option<Option<BlockId>> = None;
        if let Some(book) = self.rounds.get(&round) {
            for rec in &book.proposals {
                let id = rec.proposal.block.id();
                match rec.proposal.pol {
                    // [A1:22] pol = none: prevote the block if valid and (unlocked or locked on it).
                    None => {
                        let free = self.locked.is_none_or(|(_, l)| l == id);
                        decision = Some(if rec.time_ok && free { Some(id) } else { None });
                    }
                    // [A1:28] pol = vr < r with prevotes ≥ q for the block in round vr:
                    // prevote it if valid and (locked_round ≤ vr or locked on it).
                    // This is the only way a lock is released.
                    Some(vr) => {
                        let polka = self.rounds.get(&vr).is_some_and(|b| b.prevotes.weight_for(&Some(id)) >= q);
                        if !polka {
                            continue;
                        }
                        let free = self.locked.is_none_or(|(lr, l)| lr <= vr || l == id);
                        decision = Some(if rec.time_ok && free { Some(id) } else { None });
                    }
                }
                break;
            }
            // An invalid block from the scheduled proposer: prevote nil at once [A1:22-26 "else"] (rule R8).
            if decision.is_none() && book.proposals.is_empty() && !book.invalid.is_empty() {
                decision = Some(None);
            }
        }
        match decision {
            None => false,
            Some(value) => {
                self.cast(VoteType::Prevote, value, out);
                self.step = Step::Prevote;
                true
            }
        }
    }

    /// [A1:36] proposal of this round and prevotes ≥ q for it, first time, step ≥ prevote.
    fn try_lock(&mut self, out: &mut Vec<Output>) -> bool {
        if self.step < Step::Prevote {
            return false;
        }
        let q = self.set.quorum();
        let round = self.round;
        let Some(book) = self.rounds.get(&round) else { return false };
        if book.valid_rule_done {
            return false;
        }
        let Some(id) = book.proposals.iter().map(|p| p.proposal.block.id()).find(|id| book.prevotes.weight_for(&Some(*id)) >= q) else {
            return false;
        };
        let Some(block) = self.blocks.get(&id).cloned() else { return false };
        self.rounds.entry(round).or_default().valid_rule_done = true;
        // [A1:42-43] in any case valid_block, valid_round ← this. Persisted before
        // the precommit below is released, so a restart re-proposes it (§3.7).
        self.valid = Some((round, id));
        self.persist_round_state(out);
        if self.step == Step::Prevote {
            // [A1:38-41] lock, then precommit. The lock is persisted first (§3.7).
            if !mutation::active(Mutation::NoLockOnPrecommit) {
                self.locked = Some((round, id));
                if self.signer().is_some() {
                    out.push(Output::Persist(PersistRecord::Lock { height: self.height, round, block }));
                }
            }
            self.cast(VoteType::Precommit, Some(id), out);
            self.step = Step::Precommit;
        }
        true
    }
}
