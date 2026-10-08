//! Hand-driven harnesses for scripted tests.
//!
//! [`Lab`] holds N nodes and lets a test decide exactly which message reaches
//! whom and which timer fires when. [`Chain`] drives a bare ledger block by
//! block, signing certificates with the modelled keys.

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::chain::{Block, BlockError, Effects, Ledger, Params, Tx};
use crate::machine::{Message, Step, TimerKind, Timeouts};
use crate::node::{Node, NodeEvent, NodeInput};
use crate::sim::{base_config, genesis_ledger, transfer};
use crate::types::*;

pub const HOUR: TimeMs = 3_600_000;
pub const DAY: TimeMs = 24 * HOUR;
pub const XRGE: Quanta = QUANTA_PER_XRGE;

pub fn key(i: usize) -> KeyId {
    KeyId(i as u32)
}
pub fn sk(i: usize) -> SigningKey {
    SigningKey::model(key(i))
}

/// Genesis ledger for `stakes` (whole XRGE), with `tweak` applied to the decided parameters.
pub fn ledger_with(stakes: &[Weight], tweak: impl FnOnce(&mut Params)) -> Ledger {
    let mut cfg = base_config(0, stakes, 0);
    cfg.key_balance = 10_000_000 * XRGE;
    tweak(&mut cfg.params);
    genesis_ledger(&cfg)
}

pub struct Lab {
    pub nodes: Vec<Node>,
    pub now: TimeMs,
    pub offsets: Vec<TimeMs>,
    /// Every message broadcast so far, with its sender.
    pub outbox: Vec<(usize, Message)>,
    delivered: BTreeSet<(usize, usize)>,
    pub timers: Vec<BTreeSet<(TimerKind, Height, Round)>>,
    pub commits: Vec<Vec<(Height, BlockId, Round)>>,
    pub evidence: Vec<Evidence>,
}

impl Lab {
    pub fn new(stakes: &[Weight]) -> Lab {
        Self::on(ledger_with(stakes, |_| {}), stakes.len())
    }

    /// `n` nodes on top of `ledger`; node `i` holds key `i`.
    pub fn on(ledger: Ledger, n: usize) -> Lab {
        Self::on_with_cert(ledger, n, None)
    }

    /// As [`Lab::on`], with the legacy certificate for the tip (activation boundary, §8.2).
    pub fn on_with_cert(ledger: Ledger, n: usize, legacy: Option<CommitCert>) -> Lab {
        let now = ledger.tip_time + 1_000;
        let mut lab = Lab { nodes: Vec::new(), now, offsets: vec![0; n], outbox: Vec::new(), delivered: BTreeSet::new(), timers: vec![BTreeSet::new(); n], commits: vec![Vec::new(); n], evidence: Vec::new() };
        for i in 0..n {
            let (node, events) = Node::new(sk(i), true, ledger.clone(), Timeouts::MODERATE, legacy.clone(), now);
            lab.nodes.push(node);
            lab.absorb(i, events);
        }
        lab
    }

    fn absorb(&mut self, i: usize, events: Vec<NodeEvent>) {
        for ev in events {
            match ev {
                NodeEvent::Send(m) => self.outbox.push((i, m)),
                NodeEvent::Timer { kind, height, round, .. } => {
                    self.timers[i].insert((kind, height, round));
                }
                NodeEvent::Wake { .. } => {}
                NodeEvent::Evidence(ev) => self.evidence.push(ev),
                NodeEvent::Committed { height, id, round } => self.commits[i].push((height, id, round)),
            }
        }
    }

    pub fn input(&mut self, i: usize, input: NodeInput) {
        let events = self.nodes[i].apply(self.now + self.offsets[i], input);
        self.absorb(i, events);
    }

    pub fn tx(&mut self, to: &[usize], tx: Tx) {
        for &i in to {
            self.input(i, NodeInput::Tx(tx.clone()));
        }
    }

    /// A unique transfer to every node.
    pub fn tx_all(&mut self, id: u64) {
        let all: Vec<usize> = (0..self.nodes.len()).collect();
        let fee = self.nodes[0].ledger.params.base_fee;
        self.tx(&all, transfer(id, fee));
    }

    /// Deliver, once each, the logged messages from `from` to `to` that satisfy `pick`. Returns how many.
    pub fn deliver(&mut self, from: &[usize], to: &[usize], pick: impl Fn(&Message) -> bool) -> usize {
        let mut count = 0;
        let mut idx = 0;
        while idx < self.outbox.len() {
            let (sender, msg) = self.outbox[idx].clone();
            if from.contains(&sender) && pick(&msg) {
                for &j in to {
                    if j != sender && self.delivered.insert((idx, j)) {
                        self.input(j, NodeInput::Message(msg.clone()));
                        count += 1;
                    }
                }
            }
            idx += 1;
        }
        count
    }

    /// Deliver everything among `group` until nothing new is produced.
    pub fn settle(&mut self, group: &[usize]) {
        while self.deliver(group, group, |_| true) > 0 {}
    }

    pub fn settle_all(&mut self) {
        let all: Vec<usize> = (0..self.nodes.len()).collect();
        self.settle(&all);
    }

    /// Fire node `i`'s timer of `kind` for its current height and round, if armed.
    pub fn fire(&mut self, i: usize, kind: TimerKind) -> bool {
        let m = &self.nodes[i].machine;
        let slot = (kind, m.height(), m.round());
        if !self.timers[i].remove(&slot) {
            return false;
        }
        self.input(i, NodeInput::Timeout { kind, height: slot.1, round: slot.2 });
        true
    }

    pub fn fire_all(&mut self, group: &[usize], kind: TimerKind) {
        for &i in group {
            self.fire(i, kind);
        }
    }

    /// Let time pass. Any commit wait that elapses fires.
    pub fn advance(&mut self, ms: TimeMs) {
        self.now += ms;
        if ms >= Timeouts::MODERATE.commit_wait {
            for i in 0..self.nodes.len() {
                self.fire(i, TimerKind::CommitWait);
            }
        }
    }

    /// Wake every node for a heartbeat (after `advance`).
    pub fn wake(&mut self, group: &[usize]) {
        for &i in group {
            let height = self.nodes[i].machine.height();
            self.input(i, NodeInput::Wake { height });
        }
    }

    pub fn step(&self, i: usize) -> Step {
        self.nodes[i].machine.step()
    }
    pub fn round(&self, i: usize) -> Round {
        self.nodes[i].machine.round()
    }
    pub fn locked(&self, i: usize) -> Option<(Round, BlockId)> {
        self.nodes[i].machine.locked()
    }
    pub fn committed(&self, i: usize, height: Height) -> Option<BlockId> {
        self.commits[i].iter().find(|c| c.0 == height).map(|c| c.1)
    }
    pub fn chain_id(&self) -> String {
        self.nodes[0].ledger.params.chain_id.clone()
    }

    /// The votes node `i` broadcast of `kind` in `(height, round)`.
    pub fn votes_of(&self, i: usize, kind: VoteType, height: Height, round: Round) -> Vec<Vote> {
        self.outbox.iter().filter(|(s, _)| *s == i).filter_map(|(_, m)| match m {
            Message::Vote(v) if v.kind == kind && v.height == height && v.round == round => Some(*v),
            _ => None,
        }).collect()
    }

    /// The block proposed in `(height, round)`, if any was broadcast.
    pub fn proposed(&self, height: Height, round: Round) -> Option<Arc<Block>> {
        self.outbox.iter().find_map(|(_, m)| match m {
            Message::Proposal(p) if p.height == height && p.round == round => Some(p.block.clone()),
            _ => None,
        })
    }

    /// Run one ordinary height to commit with everybody connected.
    pub fn commit_height(&mut self, tx_id: u64) {
        self.tx_all(tx_id);
        self.settle_all();
    }
}

pub fn is_proposal(m: &Message) -> bool {
    matches!(m, Message::Proposal(_))
}
pub fn is_vote(kind: VoteType, round: Round) -> impl Fn(&Message) -> bool {
    move |m| matches!(m, Message::Vote(v) if v.kind == kind && v.round == round)
}
pub fn in_round(round: Round) -> impl Fn(&Message) -> bool {
    move |m| match m {
        Message::Vote(v) => v.round == round,
        Message::Proposal(p) => p.round == round,
    }
}

/// A ledger driven block by block.
pub struct Chain {
    pub ledger: Ledger,
    /// Certificate round to use for the tip (the tip's header round by default).
    pub effects: Vec<Effects>,
    next_tx: u64,
}

impl Chain {
    pub fn new(stakes: &[Weight], tweak: impl FnOnce(&mut Params)) -> Chain {
        Chain { ledger: ledger_with(stakes, tweak), effects: Vec::new(), next_tx: 1 }
    }

    pub fn fee(&self) -> Quanta {
        self.ledger.params.base_fee
    }

    pub fn tx(&mut self, from: crate::chain::Account, kind: crate::chain::TxKind) -> Tx {
        self.next_tx += 1;
        Tx { id: 1_000_000 + self.next_tx, from, fee: self.ledger.params.base_fee, kind }
    }

    /// A certificate for the tip signed by `signers` (default: all of `E(tip)`), in the tip's domain.
    pub fn cert(&self, signers: Option<&[KeyId]>) -> Option<CommitCert> {
        if self.ledger.height == 0 {
            return None;
        }
        let set = self.ledger.sets.get(&self.ledger.height)?;
        let domain = self.ledger.domain_of(self.ledger.height);
        let round = self.ledger.tip_round;
        let mut sigs: Vec<(KeyId, Sig)> = set
            .members()
            .iter()
            .filter(|(k, _)| signers.is_none_or(|s| s.contains(k)))
            .map(|(k, _)| (*k, Vote::sign_in(domain, &SigningKey::model(*k), &self.ledger.params.chain_id, VoteType::Precommit, self.ledger.height, round, Some(self.ledger.tip)).sig))
            .collect();
        sigs.sort();
        Some(CommitCert { domain, height: self.ledger.height, round, block: self.ledger.tip, n_set: set.len() as u16, sigs })
    }

    /// Build the next block `dt` after the tip, in `round`, by its scheduled proposer.
    pub fn build(&self, dt: TimeMs, round: Round, txs: Vec<Tx>, evidence: Vec<Evidence>, signers: Option<&[KeyId]>) -> Block {
        let builder = self.ledger.next_proposers().get(round).expect("a proposer");
        self.ledger.build_block(builder, round, self.ledger.tip_time + dt, self.cert(signers), txs, evidence)
    }

    pub fn apply(&mut self, block: &Block) -> Result<Effects, BlockError> {
        let (next, fx) = self.ledger.apply_block(block)?;
        self.ledger = next;
        self.effects.push(fx.clone());
        Ok(fx)
    }

    /// Build and apply; all of `E(tip)` sign unless `signers` says otherwise.
    pub fn next(&mut self, dt: TimeMs, txs: Vec<Tx>, evidence: Vec<Evidence>, signers: Option<&[KeyId]>) -> Result<Effects, BlockError> {
        let block = self.build(dt, 0, txs, evidence, signers);
        self.apply(&block)
    }

    /// A heartbeat block one hour after the tip.
    pub fn heartbeat(&mut self) -> Effects {
        self.next(HOUR, Vec::new(), Vec::new(), None).expect("heartbeat block")
    }

    /// Heartbeats until at least `ms` of header time have passed.
    pub fn run_for(&mut self, ms: TimeMs) {
        let until = self.ledger.tip_time + ms;
        while self.ledger.tip_time < until {
            self.heartbeat();
        }
    }

    /// Duplicate-vote evidence by `k` at `height`, round 0, signed in that height's domain.
    pub fn double_sign(&self, k: KeyId, height: Height) -> Evidence {
        let domain = self.ledger.domain_of(height);
        let s = SigningKey::model(k);
        let a = Vote::sign_in(domain, &s, &self.ledger.params.chain_id, VoteType::Precommit, height, 0, Some(BlockId([7; 32])));
        let b = Vote::sign_in(domain, &s, &self.ledger.params.chain_id, VoteType::Precommit, height, 0, None);
        Evidence::from_votes(&a, &b).expect("conflicting votes")
    }

    pub fn weight(&self, k: KeyId) -> Weight {
        self.ledger.active_set.weight(k)
    }
}
