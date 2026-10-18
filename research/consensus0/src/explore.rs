//! Bounded exhaustive exploration of one height (§9 exit criteria: "exhaustive
//! exploration of small cases (4 validators, 2 rounds)").
//!
//! The model is fully asynchronous: every message sits in a pool per recipient
//! and may be delivered at any later point, in any order; every timer that has
//! been set may fire at any later point. The explorer walks every interleaving
//! depth-first and deduplicates by a 64-bit hash of the complete global state
//! (all machines, undelivered messages, armed timers).
//!
//! Bounds and reductions, all of which preserve the reachable set of the
//! bounded model:
//! * a validator that enters round `max_rounds` is frozen (it takes no further
//!   step; what it already sent stays deliverable);
//! * deliveries to a validator that has decided or is frozen are dropped
//!   (no-ops), as are a validator's timers for rounds it has left (no-ops).
//!
//! With `byzantine = 1` the last validator has no machine: every message it
//! could sign for the explored rounds (nil and block votes of both types, two
//! different proposals in rounds where it is the proposer, re-proposals with a
//! proof-of-lock round) is placed in the pool and may be delivered to any
//! subset of the honest validators, which covers equivocation and withholding.
//!
//! Checked in every state: agreement among honest validators (P1), that a
//! decided block is one a scheduled proposer built (P2), and the machine
//! invariants I2. A state with no enabled transition in which some honest
//! validator is neither decided nor frozen is reported as stuck (P5).
//!
//! Hash collisions: states are identified by 64 bits, so with `S` states the
//! chance that some state was wrongly skipped is about `S² / 2^65`.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;
use std::time::Instant;

use crate::chain::{Block, Ledger};
use crate::machine::{Config, HeightCtx, Input, Machine, Message, Output, Proposal, Step, TimerKind, Timeouts, Verdict};
use crate::sim::{base_config, genesis_ledger, transfer};
use crate::types::*;

/// Exploration bounds.
#[derive(Clone, Debug)]
pub struct ExploreConfig {
    /// Validators, equal stake.
    pub validators: usize,
    /// Stake of each validator in whole XRGE.
    pub stake: Weight,
    /// Rounds explored: `0..max_rounds`.
    pub max_rounds: Round,
    /// How many of the validators are Byzantine (0 or 1; the last one).
    pub byzantine: usize,
    /// 0: explore transitions in their natural order. Otherwise the order at each state is a
    /// permutation derived from this seed and the state, which reaches distant corners of a space
    /// too large to finish (the set of reachable states is the same either way).
    pub order_seed: u64,
    /// Stop after this many distinct states.
    pub max_states: u64,
    /// Stop after this many wall-clock seconds.
    pub max_seconds: u64,
}

/// What the exploration found.
#[derive(Clone, Debug, Default)]
pub struct ExploreResult {
    /// Distinct states visited.
    pub states: u64,
    /// Transitions taken (including those leading to known states).
    pub transitions: u64,
    /// States in which every honest validator has decided.
    pub decided_states: u64,
    /// States with no enabled transition that are not fully decided but have a frozen validator (round bound reached).
    pub bound_states: u64,
    /// Stuck states: nothing enabled, somebody neither decided nor frozen.
    pub stuck_states: u64,
    /// True if the whole bounded space was explored (neither limit was hit).
    pub complete: bool,
    /// Deepest path.
    pub max_depth: usize,
    /// First violation found, with the path that leads to it.
    pub violation: Option<String>,
    /// Distinct blocks decided anywhere.
    pub decided_blocks: BTreeSet<BlockId>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum MsgKey {
    Vote(Vote),
    Proposal(Round, Option<Round>, BlockId, KeyId),
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Transition {
    Deliver(u32, u8),
    Fire(u8, TimerKind, Round),
}

#[derive(Clone)]
struct State {
    machines: Vec<Machine>,
    hashes: Vec<u64>,
    decided: Vec<Option<BlockId>>,
    frozen: Vec<bool>,
    pending: BTreeSet<(u32, u8)>,
    timers: BTreeSet<(u8, TimerKind, Round)>,
}

struct Explorer {
    cfg: ExploreConfig,
    ledger: Ledger,
    chain_id: Arc<str>,
    honest: usize,
    msgs: Vec<Message>,
    index: BTreeMap<MsgKey, u32>,
    known_blocks: BTreeSet<BlockId>,
    built: BTreeMap<(KeyId, Round, u8), Arc<Block>>,
}

impl Explorer {
    fn intern(&mut self, msg: Message) -> (u32, bool) {
        let key = match &msg {
            Message::Vote(v) => MsgKey::Vote(*v),
            Message::Proposal(p) => MsgKey::Proposal(p.round, p.pol, p.block.id(), p.proposer),
        };
        if let Some(i) = self.index.get(&key) {
            return (*i, false);
        }
        let i = self.msgs.len() as u32;
        self.msgs.push(msg);
        self.index.insert(key, i);
        (i, true)
    }

    /// The block validator `key` builds in `round` (variant 0 is the honest one). Deterministic.
    fn block(&mut self, key: KeyId, round: Round, variant: u8) -> Arc<Block> {
        if let Some(b) = self.built.get(&(key, round, variant)) {
            return b.clone();
        }
        let tx = transfer(1 + u64::from(round) * 10 + u64::from(variant) * 100, self.ledger.params.base_fee);
        let now = self.ledger.tip_time + 1 + TimeMs::from(round);
        let b = Arc::new(self.ledger.build_block(key, round, now, None, vec![tx], Vec::new()));
        self.built.insert((key, round, variant), b.clone());
        b
    }

    /// Everything the Byzantine validator could sign about `block` in the explored rounds.
    fn byzantine_messages_for(&mut self, st: &mut State, block: Option<Arc<Block>>) {
        if self.cfg.byzantine == 0 {
            return;
        }
        let byz = SigningKey::model(KeyId(self.honest as u32));
        let height = self.ledger.height + 1;
        let mut proposers = self.ledger.next_proposers();
        let mut out = Vec::new();
        for r in 0..self.cfg.max_rounds {
            for kind in [VoteType::Prevote, VoteType::Precommit] {
                out.push(Message::Vote(Vote::sign(&byz, &self.chain_id, kind, height, r, block.as_ref().map(|b| b.id()))));
            }
            if let (Some(b), true) = (&block, proposers.get(r) == Some(byz.id())) {
                // Re-proposals with every earlier proof-of-lock round, and without one if it built the block.
                for vr in 0..r {
                    out.push(Message::Proposal(Proposal::sign(&byz, &self.chain_id, height, r, Some(vr), b.clone())));
                }
                if b.header.builder == byz.id() && b.header.round == r {
                    out.push(Message::Proposal(Proposal::sign(&byz, &self.chain_id, height, r, None, b.clone())));
                }
            }
        }
        for m in out {
            let (idx, fresh) = self.intern(m);
            if fresh {
                for j in 0..self.honest {
                    if st.decided[j].is_none() && !st.frozen[j] {
                        st.pending.insert((idx, j as u8));
                    }
                }
            }
        }
    }

    fn note_block(&mut self, st: &mut State, block: &Arc<Block>) {
        if self.known_blocks.insert(block.id()) || self.cfg.byzantine > 0 {
            self.byzantine_messages_for(st, Some(block.clone()));
        }
    }

    fn absorb(&mut self, st: &mut State, i: usize, outputs: Vec<Output>) {
        let mut queue: std::collections::VecDeque<Output> = outputs.into();
        while let Some(o) = queue.pop_front() {
            match o {
                Output::Broadcast(m) => {
                    if let Message::Proposal(p) = &m {
                        let b = p.block.clone();
                        self.note_block(st, &b);
                    }
                    let (idx, _) = self.intern(m);
                    for j in 0..self.honest {
                        if j != i && st.decided[j].is_none() && !st.frozen[j] {
                            st.pending.insert((idx, j as u8));
                        }
                    }
                }
                Output::SetTimer { kind, round, .. } => {
                    if kind != TimerKind::CommitWait {
                        st.timers.insert((i as u8, kind, round));
                    }
                }
                Output::NeedBlock { height, round } => {
                    if round < self.cfg.max_rounds {
                        let block = self.block(KeyId(i as u32), round, 0);
                        queue.extend(st.machines[i].handle(Input::BlockBuilt { height, round, block }));
                    }
                }
                Output::Commit { block, .. } => st.decided[i] = Some(block.id()),
                Output::Persist(_) | Output::WakeAtHeaderTime { .. } | Output::Evidence(_) => {}
            }
        }
        let m = &st.machines[i];
        if m.round() >= self.cfg.max_rounds && st.decided[i].is_none() {
            st.frozen[i] = true;
        }
        let (round, done) = (m.round(), st.decided[i].is_some() || st.frozen[i]);
        st.timers.retain(|(n, _, r)| *n as usize != i || (!done && *r >= round));
        if done {
            st.pending.retain(|(_, to)| *to as usize != i);
        }
        st.hashes[i] = st.machines[i].state_hash();
    }

    fn initial(&mut self) -> State {
        let n = self.honest;
        let cfg = Config { chain_id: self.chain_id.clone(), key: None, timeouts: Timeouts::MODERATE, heartbeat_ms: self.ledger.params.heartbeat_ms };
        let mut st = State { machines: Vec::new(), hashes: vec![0; n], decided: vec![None; n], frozen: vec![false; n], pending: BTreeSet::new(), timers: BTreeSet::new() };
        let mut outs = Vec::new();
        for i in 0..n {
            let ctx = HeightCtx {
                height: self.ledger.height + 1,
                set: self.ledger.active_set.clone(),
                proposers: self.ledger.next_proposers(),
                parent: self.ledger.tip,
                parent_time: self.ledger.tip_time,
                pending_work: true,
            };
            let (m, out) = Machine::new(Config { key: Some(SigningKey::model(KeyId(i as u32))), ..cfg.clone() }, ctx);
            st.machines.push(m);
            outs.push(out);
        }
        // Byzantine: nil votes, and its own two blocks in rounds where it proposes.
        self.byzantine_messages_for(&mut st, None);
        if self.cfg.byzantine > 0 {
            let byz = KeyId(self.honest as u32);
            let mut proposers = self.ledger.next_proposers();
            for r in 0..self.cfg.max_rounds {
                if proposers.get(r) == Some(byz) {
                    for variant in [0u8, 1] {
                        let b = self.block(byz, r, variant);
                        self.note_block(&mut st, &b);
                    }
                }
            }
        }
        for (i, out) in outs.into_iter().enumerate() {
            self.absorb(&mut st, i, out);
        }
        st
    }

    fn enabled(&self, st: &State) -> Vec<Transition> {
        let mut v: Vec<Transition> = st.pending.iter().map(|(m, to)| Transition::Deliver(*m, *to)).collect();
        v.extend(st.timers.iter().map(|(n, k, r)| Transition::Fire(*n, *k, *r)));
        if self.cfg.order_seed != 0 {
            let mut rng = crate::sim::Rng::new(self.cfg.order_seed ^ Self::hash(st));
            for i in (1..v.len()).rev() {
                v.swap(i, rng.below(i as u64 + 1) as usize);
            }
        }
        v
    }

    fn apply(&mut self, st: &State, t: Transition) -> State {
        let mut next = st.clone();
        match t {
            Transition::Deliver(m, to) => {
                next.pending.remove(&(m, to));
                let input = match self.msgs[m as usize].clone() {
                    Message::Vote(v) => Input::Vote(v),
                    Message::Proposal(proposal) => Input::Proposal { proposal, verdict: Verdict::Valid },
                };
                let out = next.machines[to as usize].handle(input);
                self.absorb(&mut next, to as usize, out);
            }
            Transition::Fire(node, kind, round) => {
                next.timers.remove(&(node, kind, round));
                let height = self.ledger.height + 1;
                let out = next.machines[node as usize].handle(Input::Timeout { kind, height, round });
                self.absorb(&mut next, node as usize, out);
            }
        }
        next
    }

    fn hash(st: &State) -> u64 {
        let mut h = Hasher::new("global");
        for x in &st.hashes {
            h.u64(*x);
        }
        for (m, to) in &st.pending {
            h.u64(u64::from(*m) << 8 | u64::from(*to));
        }
        h.u64(u64::MAX);
        for (n, k, r) in &st.timers {
            h.u64(u64::from(*n) << 40 | (*k as u64) << 32 | u64::from(*r));
        }
        h.finish64()
    }

    fn check(&self, st: &State) -> Option<String> {
        let decided: BTreeSet<BlockId> = st.decided.iter().flatten().copied().collect();
        if decided.len() > 1 {
            return Some(format!("P1 agreement: honest validators decided {decided:?}"));
        }
        if let Some(id) = decided.iter().find(|id| !self.known_blocks.contains(id)) {
            return Some(format!("P2 validity: decided {id:?} which no proposer built"));
        }
        for (i, m) in st.machines.iter().enumerate() {
            let (l, v, r) = (m.locked(), m.valid(), m.round());
            let bad = l.is_some_and(|(lr, _)| lr > r) || v.is_some_and(|(vr, _)| vr > r) || matches!((l, v), (Some((lr, _)), Some((vr, _))) if lr > vr) || (l.is_some() && v.is_none());
            if bad && m.step() != Step::Committed {
                return Some(format!("I2: validator {i} round {r} locked {l:?} valid {v:?}"));
            }
        }
        None
    }

    fn describe(&self, path: &[Transition]) -> String {
        let mut s = String::new();
        for t in path {
            match t {
                Transition::Deliver(m, to) => {
                    let what = match &self.msgs[*m as usize] {
                        Message::Vote(v) => format!("{:?} r{} {} by v{}", v.kind, v.round, v.block.map_or("nil".into(), |b| b.short()), v.voter.0),
                        Message::Proposal(p) => format!("Proposal r{} pol={:?} {} by v{}", p.round, p.pol, p.block.id().short(), p.proposer.0),
                    };
                    s.push_str(&format!("  deliver to v{to}: {what}\n"));
                }
                Transition::Fire(n, k, r) => s.push_str(&format!("  timeout at v{n}: {k:?} r{r}\n")),
            }
        }
        s
    }
}

/// Explore every interleaving within the bounds.
pub fn explore(cfg: &ExploreConfig) -> ExploreResult {
    let n = cfg.validators;
    let sim_cfg = base_config(0, &vec![cfg.stake.max(1); n], 0);
    let ledger = genesis_ledger(&sim_cfg);
    let chain_id: Arc<str> = Arc::from(ledger.params.chain_id.as_str());
    let mut ex = Explorer { cfg: cfg.clone(), ledger, chain_id, honest: n - cfg.byzantine.min(n), msgs: Vec::new(), index: BTreeMap::new(), known_blocks: BTreeSet::new(), built: BTreeMap::new() };
    let mut res = ExploreResult { complete: true, ..ExploreResult::default() };
    let started = Instant::now();
    let root = ex.initial();
    let mut visited: HashSet<u64> = HashSet::new();
    visited.insert(Explorer::hash(&root));
    res.states = 1;
    let root_enabled = ex.enabled(&root);
    let mut stack: Vec<(State, Vec<Transition>, usize)> = vec![(root, root_enabled, 0)];
    let mut path: Vec<Transition> = Vec::new();
    while let Some((state, enabled, cursor)) = stack.last_mut() {
        if *cursor >= enabled.len() {
            stack.pop();
            path.pop();
            continue;
        }
        let t = enabled[*cursor];
        *cursor += 1;
        let next = ex.apply(state, t);
        res.transitions += 1;
        if !visited.insert(Explorer::hash(&next)) {
            continue;
        }
        res.states += 1;
        path.push(t);
        res.max_depth = res.max_depth.max(path.len());
        if let Some(v) = ex.check(&next) {
            res.violation = Some(format!("{v}\npath ({} steps):\n{}", path.len(), ex.describe(&path)));
            res.complete = false;
            return res;
        }
        res.decided_blocks.extend(next.decided.iter().flatten().copied());
        let next_enabled = ex.enabled(&next);
        if next_enabled.is_empty() {
            if next.decided.iter().all(|d| d.is_some()) {
                res.decided_states += 1;
            } else if next.frozen.iter().any(|f| *f) {
                res.bound_states += 1;
            } else {
                res.stuck_states += 1;
                if res.violation.is_none() {
                    res.violation = Some(format!("P5 stuck: nothing enabled, not decided, nobody at the round bound\npath ({} steps):\n{}", path.len(), ex.describe(&path)));
                    res.complete = false;
                    return res;
                }
            }
            path.pop();
            continue;
        }
        if res.states >= cfg.max_states || (res.states % 4096 == 0 && started.elapsed().as_secs() >= cfg.max_seconds) {
            res.complete = false;
            return res;
        }
        stack.push((next, next_enabled, 0));
    }
    res
}
