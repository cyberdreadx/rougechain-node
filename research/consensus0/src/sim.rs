//! The simulator: one seeded event queue driving N nodes (§9 "Model").
//!
//! * **Network**: per-message delay, drop, duplication (reordering follows from
//!   random delays), scripted partitions, and a stabilisation time (GST) after
//!   which delays are bounded and nothing is dropped.
//! * **Clocks**: a fixed per-node offset, to exercise the T2 bound.
//! * **Faults**: see [`Behaviour`]. Byzantine behaviour is produced by
//!   intercepting what an otherwise honest node sends, signing with the
//!   faulty node's own key only — no signature is ever forged.
//! * **Gossip** (§3.8): once a second, while anything is in flight, every node
//!   offers each reachable peer the messages that peer lacks, or the next
//!   committed block with its certificate. Which messages a peer lacks is read
//!   from the peer's state directly (an idealised "have" bitmap exchange).
//!
//! Determinism (P10): the only source of randomness is the ChaCha8 stream
//! seeded from [`SimConfig::seed`]; all collections iterate in a fixed order.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};

use crate::chain::{Account, Block, Genesis, Ledger, Params, Tx};
use crate::machine::{Message, Proposal, Step, Timeouts};
use crate::node::{BuildPolicy, Node, NodeEvent, NodeInput};
use crate::types::*;

/// Seeded random numbers with explicit, version-independent range sampling.
pub struct Rng(ChaCha8Rng);

impl Rng {
    /// A stream for `seed`.
    pub fn new(seed: u64) -> Rng {
        Rng(ChaCha8Rng::seed_from_u64(seed))
    }
    /// Next 64 bits.
    pub fn next(&mut self) -> u64 {
        self.0.next_u64()
    }
    /// Uniform in `0..n` (`0` when `n == 0`).
    pub fn below(&mut self, n: u64) -> u64 {
        ((u128::from(self.next()) * u128::from(n)) >> 64) as u64
    }
    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.below(hi - lo + 1)
    }
    /// True with probability `permille / 1000`.
    pub fn permille(&mut self, permille: u64) -> bool {
        self.below(1000) < permille
    }
}

/// What a validator does (§9 fault list).
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Behaviour {
    /// Follows the protocol.
    Honest,
    /// Stops for ever at `at`.
    Crash {
        /// Crash time.
        at: TimeMs,
    },
    /// Stops at `at`, restarts at `back`, with or without the §3.7 records.
    CrashRestart {
        /// Crash time.
        at: TimeMs,
        /// Restart time.
        back: TimeMs,
        /// Whether the persisted state survived. `false` must be shown unsafe.
        with_state: bool,
    },
    /// Proposes two different blocks in its rounds, each to part of the network.
    EquivocatingProposer,
    /// Signs two different votes per slot and shows each peer one of them.
    DoubleVoter,
    /// Colluding Byzantine validator: equivocates as proposer, and every member
    /// votes, towards each peer, for the block that peer was shown.
    Coalition,
    /// Always votes nil.
    NilVoter,
    /// As proposer, leaves out transactions and other validators' signatures.
    Withholder,
    /// Follows the protocol but everything it sends is late by `delay`.
    Staller {
        /// Extra delay on every message.
        delay: TimeMs,
    },
}

impl Behaviour {
    /// Can break safety (signs conflicting messages, or forgets what it signed).
    pub fn byzantine(&self) -> bool {
        matches!(
            self,
            Behaviour::EquivocatingProposer | Behaviour::DoubleVoter | Behaviour::Coalition | Behaviour::CrashRestart { with_state: false, .. }
        )
    }
    /// Counts against the one-third fault bound (anything but honest).
    pub fn faulty(&self) -> bool {
        !matches!(self, Behaviour::Honest)
    }
    /// Short name for reports.
    pub fn name(&self) -> &'static str {
        match self {
            Behaviour::Honest => "honest",
            Behaviour::Crash { .. } => "crash",
            Behaviour::CrashRestart { with_state: true, .. } => "restart",
            Behaviour::CrashRestart { with_state: false, .. } => "restart-nostate",
            Behaviour::EquivocatingProposer => "equivocate",
            Behaviour::DoubleVoter => "doublevote",
            Behaviour::Coalition => "coalition",
            Behaviour::NilVoter => "nil",
            Behaviour::Withholder => "withhold",
            Behaviour::Staller { .. } => "stall",
        }
    }
}

/// A scripted partition: nodes with `side[i] == true` cannot talk to the others.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Partition {
    /// Start time.
    pub start: TimeMs,
    /// End time (healing).
    pub end: TimeMs,
    /// Which side each node is on.
    pub side: Vec<bool>,
}

/// Kind of consensus message, for [`Filter`].
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum MsgKind {
    /// A proposal.
    Proposal,
    /// A prevote.
    Prevote,
    /// A precommit.
    Precommit,
}

/// A scripted loss rule: while active, every matching message is dropped,
/// whoever relays it. `None` fields match anything. This is the fine-grained
/// form of a partition and is how a test scripts "this validator never sees
/// that vote before stabilisation".
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Filter {
    /// Active from.
    pub start: TimeMs,
    /// Active until.
    pub end: TimeMs,
    /// The node whose key signed the message.
    pub signer: Option<usize>,
    /// The recipient.
    pub to: Option<usize>,
    /// The message kind.
    pub kind: Option<MsgKind>,
    /// The round of the message.
    pub round: Option<Round>,
}

/// Network model.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NetConfig {
    /// Minimum one-way delay.
    pub min_delay: TimeMs,
    /// Maximum one-way delay after stabilisation.
    pub max_delay: TimeMs,
    /// Maximum one-way delay before stabilisation.
    pub pre_gst_max_delay: TimeMs,
    /// Drop probability before stabilisation, per mille.
    pub drop_permille: u64,
    /// Duplication probability before stabilisation, per mille.
    pub dup_permille: u64,
    /// Stabilisation time.
    pub gst: TimeMs,
    /// Extra delay an adversary may add to each message of a Byzantine sender (any time).
    pub adversary_max_delay: TimeMs,
    /// Scripted partitions.
    pub partitions: Vec<Partition>,
    /// Scripted per-message loss rules.
    pub filters: Vec<Filter>,
}

impl NetConfig {
    /// A network that is synchronous from the start with a fixed one-way delay.
    pub fn fixed(delay: TimeMs) -> NetConfig {
        NetConfig { min_delay: delay, max_delay: delay, pre_gst_max_delay: delay, drop_permille: 0, dup_permille: 0, gst: 0, adversary_max_delay: 0, partitions: Vec::new(), filters: Vec::new() }
    }
}

/// A complete scenario.
#[derive(Clone, Debug)]
pub struct SimConfig {
    /// Seed of the random stream.
    pub seed: u64,
    /// Genesis stake per node in whole XRGE; 0 = not a validator at genesis.
    pub stakes: Vec<Weight>,
    /// Behaviour per node.
    pub behaviours: Vec<Behaviour>,
    /// Network model.
    pub net: NetConfig,
    /// Maximum clock offset; each node gets a fixed offset in `0..=max`.
    pub clock_offset_max: TimeMs,
    /// Round timeouts.
    pub timeouts: Timeouts,
    /// Chain parameters.
    pub params: Params,
    /// Reserve balance at genesis, in quanta.
    pub reserve: Quanta,
    /// Liquid balance of every node's key account at genesis, in quanta.
    pub key_balance: Quanta,
    /// Transactions and their submission times (absolute).
    pub txs: Vec<(TimeMs, Tx)>,
    /// Absolute start time (also the genesis header time).
    pub start: TimeMs,
    /// After this time no new heartbeat is started; the run drains and stops.
    pub end_time: TimeMs,
    /// Absolute stop, reached only if the system never goes quiet.
    pub hard_end: TimeMs,
    /// Record every node input so the run can be replayed (P10).
    pub record_schedule: bool,
    /// Keep a human-readable trace.
    pub trace: bool,
}

/// One commit by one node.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct CommitRec {
    /// Height.
    pub height: Height,
    /// Block.
    pub id: BlockId,
    /// Commit round.
    pub round: Round,
    /// Simulated time.
    pub time: TimeMs,
}

/// Consensus traffic of one height.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Default)]
pub struct Traffic {
    /// Distinct votes signed.
    pub votes: u64,
    /// Distinct proposals signed.
    pub proposals: u64,
    /// Vote deliveries attempted by their signers (one per peer).
    pub vote_deliveries: u64,
}

/// Counters.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Stats {
    /// Node inputs processed.
    pub inputs: u64,
    /// Messages handed to the network.
    pub sent: u64,
    /// Messages dropped (loss or partition).
    pub dropped: u64,
    /// Messages re-offered by gossip.
    pub gossip: u64,
    /// Per-height traffic by honest signers.
    pub traffic: BTreeMap<Height, Traffic>,
}

/// Everything a run produced, for the property checkers.
#[derive(Clone, Debug)]
pub struct RunRecord {
    /// The scenario.
    pub cfg: SimConfig,
    /// Keys, by node index.
    pub keys: Vec<KeyId>,
    /// The genesis ledger.
    pub genesis: Ledger,
    /// Commits per node, in order.
    pub commits: Vec<Vec<CommitRec>>,
    /// Votes that reached (or were signed by) a non-Byzantine node: the pool evidence can be built from.
    pub votes_seen: BTreeSet<Vote>,
    /// Final node states.
    pub nodes: Vec<Node>,
    /// Whether each node was running at the end.
    pub alive: Vec<bool>,
    /// Simulated time at which the run stopped.
    pub stopped_at: TimeMs,
    /// True if the run stopped because nothing was left to do.
    pub quiescent: bool,
    /// Counters.
    pub stats: Stats,
    /// Recorded schedule (if requested): node index, local time, input.
    pub schedule: Vec<(usize, TimeMs, NodeInput)>,
    /// Running hash of every node state after every input (if the schedule is recorded).
    pub hash_chain: u64,
    /// Trace lines (if requested).
    pub trace: Vec<String>,
}

enum Ev {
    Input { node: usize, from: Option<usize>, input: NodeInput },
    Crash { node: usize },
    Tick,
}

struct Split {
    a: BlockId,
    b: BlockId,
    side: Vec<bool>,
}

struct Sim<'a> {
    cfg: &'a SimConfig,
    rng: Rng,
    now: TimeMs,
    seq: u64,
    queue: BTreeMap<(TimeMs, u64), Ev>,
    nodes: Vec<Node>,
    keys: Vec<SigningKey>,
    alive: Vec<bool>,
    offsets: Vec<TimeMs>,
    tick_armed: bool,
    splits: BTreeMap<(Height, Round), Split>,
    rec: RunRecord,
}

const TICK_MS: TimeMs = 1_000;
const MAX_INPUTS: u64 = 20_000_000;

/// Build the genesis ledger of a scenario.
pub fn genesis_ledger(cfg: &SimConfig) -> Ledger {
    let n = cfg.stakes.len();
    let key = |i: usize| KeyId(i as u32);
    let mut balances: Vec<(Account, Quanta)> = (0..n).map(|i| (Account::Key(key(i)), cfg.key_balance)).collect();
    balances.extend((0..8).map(|u| (Account::User(u), 1_000_000 * QUANTA_PER_XRGE)));
    balances.push((Account::Reserve, cfg.reserve));
    let g = Genesis {
        tip_height: 0,
        tip: BlockId([0; 32]),
        tip_time: cfg.start,
        validators: (0..n).filter(|i| cfg.stakes[*i] > 0).map(|i| (key(i), cfg.stakes[i] * QUANTA_PER_XRGE)).collect(),
        balances,
    };
    // Stakes come from scenario generators that keep the total far below 2^100.
    Ledger::genesis(cfg.params.clone(), &g).unwrap_or_else(|e| panic!("scenario stakes do not form a validator set: {e:?}"))
}

fn make_nodes(cfg: &SimConfig, genesis: &Ledger, offsets: &[TimeMs]) -> (Vec<Node>, Vec<Vec<NodeEvent>>) {
    let mut nodes = Vec::new();
    let mut initial = Vec::new();
    for i in 0..cfg.stakes.len() {
        let key = SigningKey::model(KeyId(i as u32));
        let (mut node, events) = Node::new(key, true, genesis.clone(), cfg.timeouts, None, cfg.start + offsets[i]);
        if cfg.behaviours[i] == Behaviour::Withholder {
            node.policy = BuildPolicy { omit_txs: true, trim_cert: true };
        }
        nodes.push(node);
        initial.push(events);
    }
    (nodes, initial)
}

fn clock_offsets(cfg: &SimConfig, rng: &mut Rng) -> Vec<TimeMs> {
    (0..cfg.stakes.len()).map(|_| rng.range(0, cfg.clock_offset_max)).collect()
}

/// Run a scenario to completion.
pub fn run(cfg: &SimConfig) -> RunRecord {
    let n = cfg.stakes.len();
    assert_eq!(cfg.behaviours.len(), n, "one behaviour per node");
    let mut rng = Rng::new(cfg.seed);
    let offsets = clock_offsets(cfg, &mut rng);
    let genesis = genesis_ledger(cfg);
    let (nodes, initial) = make_nodes(cfg, &genesis, &offsets);
    let keys: Vec<SigningKey> = (0..n).map(|i| SigningKey::model(KeyId(i as u32))).collect();
    let rec = RunRecord {
        cfg: cfg.clone(),
        keys: keys.iter().map(|k| k.id()).collect(),
        genesis,
        commits: vec![Vec::new(); n],
        votes_seen: BTreeSet::new(),
        nodes: Vec::new(),
        alive: Vec::new(),
        stopped_at: cfg.start,
        quiescent: false,
        stats: Stats::default(),
        schedule: Vec::new(),
        hash_chain: 0,
        trace: Vec::new(),
    };
    let mut sim = Sim { cfg, rng, now: cfg.start, seq: 0, queue: BTreeMap::new(), nodes, keys, alive: vec![true; n], offsets, tick_armed: false, splits: BTreeMap::new(), rec };
    for (i, events) in initial.into_iter().enumerate() {
        sim.absorb(i, events);
    }
    for (i, b) in cfg.behaviours.iter().enumerate() {
        match *b {
            Behaviour::Crash { at } => sim.push(at, Ev::Crash { node: i }),
            Behaviour::CrashRestart { at, back, with_state } => {
                sim.push(at, Ev::Crash { node: i });
                sim.push(back.max(at + 1), Ev::Input { node: i, from: None, input: NodeInput::Restart { with_state } });
            }
            _ => {}
        }
    }
    for (t, tx) in &cfg.txs {
        for i in 0..n {
            let jitter = sim.rng.range(0, cfg.net.max_delay);
            sim.push(*t + jitter, Ev::Input { node: i, from: None, input: NodeInput::Tx(tx.clone()) });
        }
    }
    sim.run_loop();
    let Sim { nodes, alive, mut rec, now, .. } = sim;
    rec.nodes = nodes;
    rec.alive = alive;
    rec.stopped_at = now;
    rec
}

/// Replay a recorded schedule against fresh nodes and return the hash chain (P10).
/// No random numbers are drawn except the clock offsets, which are part of the configuration.
pub fn replay(rec: &RunRecord) -> (u64, Vec<u64>) {
    let cfg = &rec.cfg;
    let mut rng = Rng::new(cfg.seed);
    let offsets = clock_offsets(cfg, &mut rng);
    let (mut nodes, _) = make_nodes(cfg, &rec.genesis, &offsets);
    let mut chain = 0u64;
    for (node, local, input) in &rec.schedule {
        let _ = nodes[*node].apply(*local, input.clone());
        chain = fold(chain, *node, nodes[*node].state_hash());
    }
    (chain, nodes.iter().map(|n| n.state_hash()).collect())
}

fn fold(chain: u64, node: usize, state: u64) -> u64 {
    let mut h = Hasher::new("chain");
    h.u64(chain).u64(node as u64).u64(state);
    h.finish64()
}

impl Sim<'_> {
    fn push(&mut self, at: TimeMs, ev: Ev) {
        self.seq += 1;
        self.queue.insert((at.max(self.now), self.seq), ev);
    }

    fn trace(&mut self, line: impl FnOnce() -> String) {
        if self.cfg.trace {
            let t = self.now - self.cfg.start;
            self.rec.trace.push(format!("{:>9.3}s {}", t as f64 / 1000.0, line()));
        }
    }

    fn partitioned(&self, a: usize, b: usize) -> bool {
        self.cfg.net.partitions.iter().any(|p| self.now >= p.start && self.now < p.end && p.side[a] != p.side[b])
    }

    fn filtered(&self, to: usize, msg: &Message) -> bool {
        let (signer, kind, round) = match msg {
            Message::Proposal(p) => (p.proposer, MsgKind::Proposal, p.round),
            Message::Vote(v) => (v.voter, if v.kind == VoteType::Prevote { MsgKind::Prevote } else { MsgKind::Precommit }, v.round),
        };
        self.cfg.net.filters.iter().any(|f| {
            self.now >= f.start
                && self.now < f.end
                && f.signer.is_none_or(|s| KeyId(s as u32) == signer)
                && f.to.is_none_or(|t| t == to)
                && f.kind.is_none_or(|k| k == kind)
                && f.round.is_none_or(|r| r == round)
        })
    }

    fn run_loop(&mut self) {
        while let Some(((t, _), ev)) = self.queue.pop_first() {
            if t > self.cfg.hard_end || self.rec.stats.inputs > MAX_INPUTS {
                self.now = t.min(self.cfg.hard_end);
                return;
            }
            self.now = t;
            match ev {
                Ev::Crash { node } => {
                    self.alive[node] = false;
                    self.trace(|| format!("n{node} CRASH"));
                }
                Ev::Tick => self.tick(),
                Ev::Input { node, from, input } => {
                    let restart = matches!(input, NodeInput::Restart { .. });
                    if restart {
                        self.alive[node] = true;
                        self.trace(|| format!("n{node} RESTART {input:?}"));
                    }
                    if !self.alive[node] {
                        continue;
                    }
                    // Draining: no heartbeat whose due time is at or after end_time is started.
                    // The cut-off is on the header-time threshold, which is the same for every
                    // node, so clock offsets cannot make one node start a height alone.
                    if matches!(input, NodeInput::Wake { .. }) && self.nodes[node].ledger.tip_time + self.cfg.params.heartbeat_ms >= self.cfg.end_time {
                        continue;
                    }
                    if let (NodeInput::Message(Message::Vote(v)), Some(f)) = (&input, from) {
                        if self.cfg.behaviours[f].byzantine() && !self.cfg.behaviours[node].byzantine() {
                            self.rec.votes_seen.insert(*v);
                        }
                    }
                    self.feed(node, input);
                }
            }
        }
        self.rec.quiescent = true;
    }

    fn feed(&mut self, node: usize, input: NodeInput) {
        let local = self.now + self.offsets[node];
        self.rec.stats.inputs += 1;
        if self.cfg.record_schedule {
            self.rec.schedule.push((node, local, input.clone()));
        }
        let events = self.nodes[node].apply(local, input);
        if self.cfg.record_schedule {
            self.rec.hash_chain = fold(self.rec.hash_chain, node, self.nodes[node].state_hash());
        }
        self.absorb(node, events);
        if !self.tick_armed {
            self.tick_armed = true;
            self.push(self.now + TICK_MS, Ev::Tick);
        }
    }

    fn absorb(&mut self, node: usize, events: Vec<NodeEvent>) {
        for ev in events {
            match ev {
                NodeEvent::Send(msg) => self.broadcast(node, msg),
                NodeEvent::Timer { kind, height, round, ms } => {
                    self.push(self.now + ms, Ev::Input { node, from: None, input: NodeInput::Timeout { kind, height, round } });
                }
                NodeEvent::Wake { height, time_ms } => {
                    let at = time_ms.saturating_sub(self.offsets[node]);
                    self.push(at, Ev::Input { node, from: None, input: NodeInput::Wake { height } });
                }
                NodeEvent::Evidence(ev) => {
                    // Evidence is gossiped like a transaction (rule R11). A Byzantine node does not forward.
                    if self.cfg.behaviours[node].byzantine() {
                        continue;
                    }
                    for j in (0..self.nodes.len()).filter(|j| *j != node) {
                        let d = self.rng.range(self.cfg.net.min_delay, self.cfg.net.max_delay);
                        self.push(self.now + d, Ev::Input { node: j, from: None, input: NodeInput::Evidence(ev) });
                    }
                }
                NodeEvent::Committed { height, id, round } => {
                    self.rec.commits[node].push(CommitRec { height, id, round, time: self.now });
                    self.trace(|| format!("n{node} COMMIT h{height} r{round} {id:?}"));
                }
            }
        }
    }

    /// Hand one message from `from` to the network for `to`.
    fn net_send(&mut self, from: usize, to: usize, msg: Message, extra: TimeMs) {
        let net = &self.cfg.net;
        self.rec.stats.sent += 1;
        if self.partitioned(from, to) || self.filtered(to, &msg) {
            self.rec.stats.dropped += 1;
            return;
        }
        let pre = self.now < net.gst;
        if pre && self.rng.permille(net.drop_permille) {
            self.rec.stats.dropped += 1;
            return;
        }
        let copies = if pre && self.rng.permille(net.dup_permille) { 2 } else { 1 };
        for _ in 0..copies {
            let hi = if pre { net.pre_gst_max_delay } else { net.max_delay };
            let delay = self.rng.range(net.min_delay, hi.max(net.min_delay)) + extra;
            self.push(self.now + delay, Ev::Input { node: to, from: Some(from), input: NodeInput::Message(msg.clone()) });
        }
    }

    /// A node broadcasts; faulty behaviours rewrite what each peer receives.
    fn broadcast(&mut self, from: usize, msg: Message) {
        let n = self.nodes.len();
        let behaviour = self.cfg.behaviours[from];
        let key = self.keys[from];
        let chain_id = self.cfg.params.chain_id.clone();
        let mut extra: TimeMs = 0;
        // per_peer[j] = what peer j receives (None: nothing).
        let mut per_peer: Vec<Option<Message>> = vec![Some(msg.clone()); n];
        match (&msg, behaviour) {
            (_, Behaviour::Staller { delay }) => extra = delay,
            (Message::Vote(v), Behaviour::NilVoter) if v.block.is_some() => {
                let nil = Message::Vote(Vote::sign(&key, &chain_id, v.kind, v.height, v.round, None));
                per_peer = vec![Some(nil); n];
            }
            (Message::Vote(v), Behaviour::DoubleVoter) => {
                // The other value: nil against a block, or a block proposed in that round against nil.
                let other = match v.block {
                    Some(_) => Some(None),
                    None => self.nodes[from].machine.messages().into_iter().find_map(|m| match m {
                        Message::Proposal(p) if p.round == v.round => Some(Some(p.block.id())),
                        _ => None,
                    }),
                };
                if let Some(value) = other {
                    let alt = Message::Vote(Vote::sign(&key, &chain_id, v.kind, v.height, v.round, value));
                    for slot in per_peer.iter_mut() {
                        if self.rng.permille(500) {
                            *slot = Some(alt.clone());
                        }
                    }
                }
            }
            (Message::Vote(v), Behaviour::Coalition) => {
                if let Some(split) = self.splits.get(&(v.height, v.round)) {
                    for (j, slot) in per_peer.iter_mut().enumerate() {
                        let id = if split.side[j] { split.b } else { split.a };
                        *slot = Some(Message::Vote(Vote::sign(&key, &chain_id, v.kind, v.height, v.round, Some(id))));
                    }
                }
            }
            (Message::Proposal(p), Behaviour::EquivocatingProposer | Behaviour::Coalition) if p.proposer == key.id() && p.pol.is_none() && p.block.header.round == p.round => {
                // A second block for the same slot. One time in four (plain equivocator only) it is
                // an invalid one — empty while no heartbeat is due — to exercise P2.
                let b = &p.block;
                let invalid = behaviour == Behaviour::EquivocatingProposer && self.rng.permille(250);
                let mut header = b.header.clone();
                header.time_ms += 1;
                let alt = if invalid { Block::new(header, b.parent_cert.clone(), Vec::new(), Vec::new()) } else { Block::new(header, b.parent_cert.clone(), b.txs.clone(), b.evidence.clone()) };
                let alt = Arc::new(alt);
                let side: Vec<bool> = (0..n).map(|_| self.rng.permille(500)).collect();
                let alt_msg = Message::Proposal(Proposal::sign(&key, &chain_id, p.height, p.round, None, alt.clone()));
                for (j, slot) in per_peer.iter_mut().enumerate() {
                    if side[j] {
                        *slot = Some(alt_msg.clone());
                    }
                }
                if behaviour == Behaviour::Coalition {
                    self.splits.insert((p.height, p.round), Split { a: b.id(), b: alt.id(), side });
                }
            }
            _ => {}
        }
        if !behaviour.byzantine() {
            let t = self.rec.stats.traffic.entry(msg.height()).or_default();
            match &msg {
                Message::Vote(v) => {
                    t.votes += 1;
                    t.vote_deliveries += n as u64 - 1;
                    self.rec.votes_seen.insert(*v);
                }
                Message::Proposal(_) => t.proposals += 1,
            }
        }
        if self.cfg.trace {
            let line = match &msg {
                Message::Vote(v) => format!("n{from} {:?} h{} r{} {}", v.kind, v.height, v.round, v.block.map_or("nil".to_string(), |b| b.short())),
                Message::Proposal(p) => format!("n{from} PROPOSE h{} r{} pol={:?} {:?} ({} tx)", p.height, p.round, p.pol, p.block.id(), p.block.txs.len()),
            };
            self.trace(|| line);
        }
        let adversarial = behaviour.byzantine() && !matches!(behaviour, Behaviour::CrashRestart { .. });
        for (j, slot) in per_peer.into_iter().enumerate() {
            let Some(m) = slot else { continue };
            if j == from {
                continue;
            }
            let adv = if adversarial { self.rng.range(0, self.cfg.net.adversary_max_delay) } else { 0 };
            self.net_send(from, j, m, extra + adv);
        }
    }

    /// Gossip round (§3.8): offer peers what they lack.
    fn tick(&mut self) {
        let n = self.nodes.len();
        let mut busy = false;
        let top = (0..n).filter(|i| self.alive[*i]).map(|i| self.nodes[i].ledger.height).max().unwrap_or(0);
        for i in 0..n {
            if !self.alive[i] {
                continue;
            }
            let hi = self.nodes[i].ledger.height;
            let idle = self.nodes[i].machine.is_idle();
            busy |= !idle || hi != top || !self.nodes[i].evidence_pool.is_empty();
            // Byzantine nodes do not help others catch up.
            let b = self.cfg.behaviours[i];
            if b.byzantine() && !matches!(b, Behaviour::CrashRestart { .. }) {
                continue;
            }
            let held = if idle { Vec::new() } else { self.nodes[i].machine.messages() };
            for j in 0..n {
                if i == j || !self.alive[j] {
                    continue;
                }
                let hj = self.nodes[j].ledger.height;
                if hj < hi {
                    // Up to 16 blocks per round, kept in order by increasing delay.
                    let idx = (hj - self.rec.genesis.height) as usize;
                    let lost = self.partitioned(i, j) || (self.now < self.cfg.net.gst && self.rng.permille(self.cfg.net.drop_permille));
                    let d = self.rng.range(self.cfg.net.min_delay, self.cfg.net.max_delay);
                    let batch: Vec<NodeInput> = self.nodes[i].chain.iter().skip(idx).take(16).map(|c| NodeInput::CatchUp { block: c.block.clone(), cert: c.cert.clone() }).collect();
                    for (k, input) in batch.into_iter().enumerate() {
                        self.rec.stats.gossip += 1;
                        if !lost {
                            self.push(self.now + d + k as u64, Ev::Input { node: j, from: Some(i), input });
                        }
                    }
                } else if hj == hi {
                    // Evidence is gossiped like transactions (rule R11).
                    let missing: Vec<Evidence> = self.nodes[i].evidence_pool.iter().filter(|e| !self.nodes[j].evidence_pool.contains(e)).copied().collect();
                    for ev in missing {
                        let d = self.rng.range(self.cfg.net.min_delay, self.cfg.net.max_delay);
                        self.push(self.now + d, Ev::Input { node: j, from: None, input: NodeInput::Evidence(ev) });
                    }
                    for m in &held {
                        if !self.nodes[j].machine.has(m) {
                            self.rec.stats.gossip += 1;
                            self.net_send(i, j, m.clone(), 0);
                        }
                    }
                }
            }
        }
        if busy {
            self.push(self.now + TICK_MS, Ev::Tick);
        } else {
            self.tick_armed = false;
        }
    }
}

impl RunRecord {
    /// True if node `i` never behaves in a way that can break safety.
    pub fn is_correct(&self, i: usize) -> bool {
        !self.cfg.behaviours[i].byzantine()
    }
    /// Steps of all nodes at the end (diagnostics).
    pub fn final_steps(&self) -> Vec<(Height, Round, Step)> {
        self.nodes.iter().map(|n| (n.machine.height(), n.machine.round(), n.machine.step())).collect()
    }
}

/// Default parameters for scenarios: the decided values, with a small subsidy so rewards are exercised.
pub fn default_params() -> Params {
    let mut p = Params::decided("rouge-sim");
    p.subsidy_rate = 3 * QUANTA_PER_XRGE / 100; // 0.03 XRGE per second [model value; RATE is the owner's budget decision]
    p
}

/// A plain scenario: honest validators, fixed delay, no transactions.
pub fn base_config(seed: u64, stakes: &[Weight], delay: TimeMs) -> SimConfig {
    const START: TimeMs = 20_000 * 86_400_000; // an arbitrary date, aligned to an epoch boundary
    SimConfig {
        seed,
        stakes: stakes.to_vec(),
        behaviours: vec![Behaviour::Honest; stakes.len()],
        net: NetConfig::fixed(delay),
        clock_offset_max: 0,
        timeouts: Timeouts::MODERATE,
        params: default_params(),
        reserve: 1_000_000 * QUANTA_PER_XRGE,
        key_balance: 1_000 * QUANTA_PER_XRGE,
        txs: Vec::new(),
        start: START,
        end_time: START + 600_000,
        hard_end: START + 4 * 3_600_000,
        record_schedule: false,
        trace: false,
    }
}

/// A transfer between two user accounts with a unique id.
pub fn transfer(id: u64, fee: Quanta) -> Tx {
    Tx { id, from: Account::User((id % 8) as u32), fee, kind: crate::chain::TxKind::Transfer { to: Account::User(((id + 1) % 8) as u32), amount: QUANTA_PER_XRGE } }
}
