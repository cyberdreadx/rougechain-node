//! Driver glue: one [`Machine`], one [`Ledger`], a mempool and the durable
//! record of §3.7. This is the part the real node replaces with real I/O; it is
//! deliberately small and has no rules of its own beyond:
//!
//! * a proposer builds a block only if it has admissible content or its own
//!   clock says the heartbeat is due (§3.4);
//! * the parent certificate is the machine's (every precommit held), or the
//!   legacy V2 certificate at the activation boundary (§8.2);
//! * messages for the next height are buffered until that height starts, and
//!   precommits for the height just committed are passed through (§3.6).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use crate::chain::{Block, Effects, Ledger, Tx};
use crate::machine::{Config, HeightCtx, Input, Machine, Message, Output, PersistedState, TimerKind, Timeouts, Verdict};
use crate::types::*;

/// Proposer misbehaviour that needs no forged signature (fault model of §9).
#[derive(Copy, Clone, PartialEq, Eq, Debug, Default)]
pub struct BuildPolicy {
    /// Leave every transaction out (censorship; proposes only heartbeats).
    pub omit_txs: bool,
    /// Trim the parent certificate to a bare quorum (omits the other signers).
    pub trim_cert: bool,
}

/// A committed block with the certificate seen at commit time.
#[derive(Clone, Debug)]
pub struct Committed {
    /// The block.
    pub block: Arc<Block>,
    /// Certificate held when the node committed (the canonical one is in the next block).
    pub cert: CommitCert,
    /// What applying it did.
    pub effects: Effects,
}

/// Something to feed a node.
#[derive(Clone, Debug)]
pub enum NodeInput {
    /// A consensus message from the network.
    Message(Message),
    /// A timer expired.
    Timeout {
        /// Which timer.
        kind: TimerKind,
        /// Height.
        height: Height,
        /// Round.
        round: Round,
    },
    /// A transaction arrived.
    Tx(Tx),
    /// The heartbeat alarm for `height` fired.
    Wake {
        /// Height.
        height: Height,
    },
    /// A committed block and its certificate from a peer (§3.8).
    CatchUp {
        /// The block.
        block: Arc<Block>,
        /// A certificate for it.
        cert: CommitCert,
    },
    /// A duplicate-vote evidence item gossiped by a peer (§4.2 "anyone may submit it").
    Evidence(Evidence),
    /// The process restarted; `with_state` says whether the §3.7 records survived.
    Restart {
        /// True: restore from the persisted state. False: the unsafe case.
        with_state: bool,
    },
}

/// Something a node asks its environment to do.
#[derive(Clone, Debug)]
pub enum NodeEvent {
    /// Broadcast to all peers.
    Send(Message),
    /// Set a timer.
    Timer {
        /// Which timer.
        kind: TimerKind,
        /// Height.
        height: Height,
        /// Round.
        round: Round,
        /// Duration.
        ms: TimeMs,
    },
    /// Set the heartbeat alarm: local clock ≥ `time_ms`.
    Wake {
        /// Height.
        height: Height,
        /// Header-time threshold.
        time_ms: TimeMs,
    },
    /// This node found duplicate-vote evidence: gossip it like a transaction.
    Evidence(Evidence),
    /// A block was committed.
    Committed {
        /// Height.
        height: Height,
        /// Block.
        id: BlockId,
        /// Commit round.
        round: Round,
    },
}

type Applied = Option<Arc<(Ledger, Effects)>>;

/// One validator (or observer) process.
#[derive(Clone, Debug)]
pub struct Node {
    /// Its key.
    pub key: KeyId,
    cfg: Config,
    /// The consensus state machine.
    pub machine: Machine,
    /// Committed state.
    pub ledger: Ledger,
    /// Pending transactions.
    pub mempool: Vec<Tx>,
    /// Evidence found and not yet on chain.
    pub evidence_pool: Vec<Evidence>,
    /// The durable record of §3.7.
    pub persisted: PersistedState,
    /// Proposer policy.
    pub policy: BuildPolicy,
    /// Blocks committed by this node, in order.
    pub chain: Vec<Committed>,
    /// Certificate for the tip at activation, produced under the old rules (§8.2).
    pub legacy_cert: Option<CommitCert>,
    /// Execution results of proposed blocks for the current height (`None` = invalid).
    applied: BTreeMap<BlockId, Applied>,
    /// Messages for the next height, held until it starts.
    future: Vec<Message>,
}

const FUTURE_BUFFER_MAX: usize = 4096;

impl Node {
    /// Start a node on top of `ledger`.
    pub fn new(key: SigningKey, sign: bool, ledger: Ledger, timeouts: Timeouts, legacy_cert: Option<CommitCert>, now: TimeMs) -> (Node, Vec<NodeEvent>) {
        let cfg = Config { chain_id: Arc::from(ledger.params.chain_id.as_str()), key: sign.then_some(key), timeouts, heartbeat_ms: ledger.params.heartbeat_ms };
        let ctx = Self::ctx_of(&ledger, false);
        let (machine, out) = Machine::new(cfg.clone(), ctx);
        let mut node = Node {
            key: key.id(),
            cfg,
            machine,
            ledger,
            mempool: Vec::new(),
            evidence_pool: Vec::new(),
            persisted: PersistedState::default(),
            policy: BuildPolicy::default(),
            chain: Vec::new(),
            legacy_cert,
            applied: BTreeMap::new(),
            future: Vec::new(),
        };
        let events = node.drive(now, out, VecDeque::new());
        (node, events)
    }

    fn ctx_of(ledger: &Ledger, pending_work: bool) -> HeightCtx {
        HeightCtx {
            height: ledger.height + 1,
            set: ledger.active_set.clone(),
            proposers: ledger.next_proposers(),
            parent: ledger.tip,
            parent_time: ledger.tip_time,
            pending_work,
        }
    }

    fn header_time(&self, now: TimeMs) -> TimeMs {
        now.max(self.ledger.tip_time.saturating_add(1))
    }

    /// §3.4 rule 1: an admissible pending transaction or evidence item.
    pub fn has_work(&self, now: TimeMs) -> bool {
        let t = self.header_time(now);
        (!self.mempool.is_empty() && !self.ledger.admissible_txs(&self.mempool, t).is_empty())
            || (!self.evidence_pool.is_empty() && !self.ledger.admissible_evidence(&self.evidence_pool, t).is_empty())
    }

    /// Execute a proposed block (cached per height) and judge it (§3.5).
    fn verdict(&mut self, now: TimeMs, block: &Arc<Block>) -> Verdict {
        if block.header.height != self.ledger.height + 1 {
            return Verdict::Invalid;
        }
        let ledger = &self.ledger;
        let applied = self.applied.entry(block.id()).or_insert_with(|| ledger.apply_block(block).ok().map(Arc::new));
        match applied {
            None => Verdict::Invalid,
            Some(_) if self.ledger.time_within_drift(block, now) => Verdict::Valid,
            Some(_) => Verdict::TimeAhead,
        }
    }

    fn parent_cert(&self) -> Option<CommitCert> {
        if self.ledger.height == 0 {
            return None;
        }
        let cert = self.machine.parent_certificate().filter(|c| c.height == self.ledger.height && c.block == self.ledger.tip);
        let cert = cert.or_else(|| self.chain.last().map(|c| c.cert.clone()).filter(|c| c.block == self.ledger.tip)).or_else(|| self.legacy_cert.clone())?;
        if !self.policy.trim_cert {
            return Some(cert);
        }
        // Withholding proposer: keep its own signature and the heaviest others up to a bare quorum.
        let set = self.ledger.sets.get(&self.ledger.height)?;
        let mut sigs = cert.sigs.clone();
        sigs.sort_by_key(|(k, _)| (*k != self.key, std::cmp::Reverse(set.weight(*k)), *k));
        let (mut kept, mut stake) = (Vec::new(), 0u128);
        for (k, s) in sigs {
            if stake >= set.quorum() {
                break;
            }
            stake += set.weight(k);
            kept.push((k, s));
        }
        kept.sort();
        Some(CommitCert { sigs: kept, ..cert })
    }

    /// Build the block for `round`, or `None` when there is nothing to propose (§3.4).
    fn build(&self, now: TimeMs, round: Round) -> Option<Arc<Block>> {
        let t = self.header_time(now);
        let txs = if self.policy.omit_txs { Vec::new() } else { self.ledger.admissible_txs(&self.mempool, t) };
        let evidence = self.ledger.admissible_evidence(&self.evidence_pool, t);
        if txs.is_empty() && evidence.is_empty() && !self.ledger.heartbeat_due(t) {
            return None;
        }
        Some(Arc::new(self.ledger.build_block(self.key, round, now, self.parent_cert(), txs, evidence)))
    }

    /// Feed one input at local time `now`.
    pub fn apply(&mut self, now: TimeMs, input: NodeInput) -> Vec<NodeEvent> {
        let mut queue = VecDeque::new();
        let mut initial = Vec::new();
        match input {
            NodeInput::Message(msg) => queue.push_back(msg),
            NodeInput::Timeout { kind, height, round } => initial = self.machine.handle(Input::Timeout { kind, height, round }),
            NodeInput::Tx(tx) => {
                if self.ledger.seen_tx.contains(&tx.id) || self.mempool.iter().any(|t| t.id == tx.id) {
                    return Vec::new();
                }
                self.mempool.push(tx);
                if self.has_work(now) {
                    initial = self.machine.handle(Input::TxPending);
                }
            }
            NodeInput::Evidence(ev) => {
                if self.evidence_pool.contains(&ev) {
                    return Vec::new();
                }
                self.evidence_pool.push(ev);
                if self.has_work(now) {
                    initial = self.machine.handle(Input::TxPending);
                }
            }
            NodeInput::Wake { height } => {
                // The alarm is advisory; the rule is the clock comparison itself.
                if self.ledger.heartbeat_due(now) {
                    initial = self.machine.handle(Input::HeartbeatDue { height });
                }
            }
            NodeInput::CatchUp { block, cert } => {
                let verdict = self.verdict(now, &block);
                initial = self.machine.handle(Input::CatchUp { block, cert, verdict });
            }
            NodeInput::Restart { with_state } => {
                let ctx = Self::ctx_of(&self.ledger, self.has_work(now));
                self.future.clear();
                self.applied.clear();
                let (machine, out) = if with_state {
                    Machine::restore(self.cfg.clone(), ctx, &self.persisted)
                } else {
                    self.persisted = PersistedState::default();
                    Machine::new(self.cfg.clone(), ctx)
                };
                self.machine = machine;
                initial = out;
            }
        }
        self.drive(now, initial, queue)
    }

    /// Process machine outputs and queued messages until both are exhausted.
    fn drive(&mut self, now: TimeMs, initial: Vec<Output>, mut queue: VecDeque<Message>) -> Vec<NodeEvent> {
        let mut events = Vec::new();
        let mut outputs: VecDeque<Output> = initial.into();
        loop {
            while let Some(output) = outputs.pop_front() {
                match output {
                    // §3.7: recorded before the Send that follows it in this list is handed out.
                    Output::Persist(rec) => self.persisted.apply(&rec),
                    Output::Broadcast(msg) => events.push(NodeEvent::Send(msg)),
                    Output::SetTimer { kind, height, round, ms } => events.push(NodeEvent::Timer { kind, height, round, ms }),
                    Output::WakeAtHeaderTime { height, time_ms } => events.push(NodeEvent::Wake { height, time_ms }),
                    Output::NeedBlock { height, round } => {
                        if let Some(block) = self.build(now, round) {
                            outputs.extend(self.machine.handle(Input::BlockBuilt { height, round, block }));
                        }
                    }
                    Output::Evidence(ev) => {
                        if !self.evidence_pool.contains(&ev) {
                            self.evidence_pool.push(ev);
                            events.push(NodeEvent::Evidence(ev));
                            if self.has_work(now) {
                                outputs.extend(self.machine.handle(Input::TxPending));
                            }
                        }
                    }
                    Output::Commit { block, cert } => {
                        let applied = match self.applied.get(&block.id()) {
                            Some(a) => a.clone(),
                            None => self.ledger.apply_block(&block).ok().map(Arc::new),
                        };
                        // The machine commits only blocks the driver judged valid, so this cannot be None.
                        let Some(applied) = applied else { continue };
                        let (ledger, effects) = (*applied).clone();
                        self.ledger = ledger;
                        events.push(NodeEvent::Committed { height: block.header.height, id: block.id(), round: cert.round });
                        self.chain.push(Committed { block, cert, effects });
                        self.applied.clear();
                        let seen = &self.ledger.seen_tx;
                        self.mempool.retain(|t| !seen.contains(&t.id));
                        // Keep evidence that is admissible now or concerns a height not yet committed.
                        let (ledger, t) = (&self.ledger, self.header_time(now));
                        self.evidence_pool.retain(|e| e.height() > ledger.height || ledger.evidence_admissible(e, t));
                        let ctx = Self::ctx_of(&self.ledger, self.has_work(now));
                        let next_height = ctx.height;
                        outputs.extend(self.machine.handle(Input::StartHeight(ctx)));
                        let (now_due, later): (Vec<Message>, Vec<Message>) = std::mem::take(&mut self.future).into_iter().partition(|m| m.height() == next_height);
                        self.future = later;
                        queue.extend(now_due);
                    }
                }
            }
            let Some(msg) = queue.pop_front() else { break };
            let h = self.machine.height();
            if msg.height() > h || (msg.height() == h && self.ledger.height == h) {
                // Ahead of us (or we have committed h and h+1 has not started): hold it.
                if msg.height() <= h + 1 && self.future.len() < FUTURE_BUFFER_MAX {
                    self.future.push(msg);
                }
                continue;
            }
            let input = match msg {
                Message::Vote(v) => Input::Vote(v),
                Message::Proposal(proposal) => {
                    if proposal.height != h {
                        continue;
                    }
                    let verdict = self.verdict(now, &proposal.block);
                    Input::Proposal { proposal, verdict }
                }
            };
            outputs.extend(self.machine.handle(input));
        }
        events
    }

    /// Digest of everything that determines this node's future behaviour (P10).
    pub fn state_hash(&self) -> u64 {
        let mut h = Hasher::new("node");
        h.u64(self.machine.state_hash()).u64(self.ledger.state_hash());
        h.u64(self.mempool.len() as u64).u64(self.evidence_pool.len() as u64).u64(self.chain.len() as u64).u64(self.future.len() as u64);
        h.finish64()
    }
}
