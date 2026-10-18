//! Checkers for properties P1–P10 of design §9, evaluated on every run.
//!
//! Each checker states its precondition explicitly; a property whose
//! precondition does not hold for a run is reported as *not applicable*, never
//! as passed. The checkers recompute what they need from the genesis ledger and
//! the committed blocks; they do not trust the nodes' own bookkeeping.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::chain::{Account, Effects, Ledger};
use crate::machine::Step;
use crate::sim::{Behaviour, RunRecord};
use crate::types::*;

/// The ten properties.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Property {
    /// Agreement.
    P1,
    /// Validity.
    P2,
    /// Accountability.
    P3,
    /// Liveness.
    P4,
    /// No stuck locks.
    P5,
    /// Proposer fairness.
    P6,
    /// Reward conservation.
    P7,
    /// Slash conservation.
    P8,
    /// Jail safety.
    P9,
    /// Replay.
    P10,
}

/// All properties, in order.
pub const ALL: [Property; 10] = [Property::P1, Property::P2, Property::P3, Property::P4, Property::P5, Property::P6, Property::P7, Property::P8, Property::P9, Property::P10];

/// A property that did not hold.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Violation {
    /// Which property.
    pub property: Property,
    /// Height concerned, if any.
    pub height: Option<Height>,
    /// What was observed.
    pub detail: String,
}

/// Options.
#[derive(Copy, Clone, Debug)]
pub struct CheckOpts {
    /// Count a restart without persisted state as a Byzantine fault (it is one).
    /// The mutation self-test sets this to `false` to show that such a restart,
    /// if wrongly treated as harmless, breaks agreement.
    pub amnesia_is_fault: bool,
    /// P4: largest commit round allowed for a height that started after stabilisation.
    /// `None` uses `3·n + 10` (see RESULTS.md, rule R23).
    pub round_bound: Option<Round>,
}

impl Default for CheckOpts {
    fn default() -> Self {
        CheckOpts { amnesia_is_fault: true, round_bound: None }
    }
}

/// Result of checking one run.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Properties violated.
    pub violations: Vec<Violation>,
    /// Properties whose precondition held and that were therefore really checked.
    pub applicable: BTreeSet<Property>,
    /// Commit round of every height of the reference chain.
    pub commit_rounds: Vec<Round>,
    /// Heights at which two different blocks were committed.
    pub forked_heights: Vec<Height>,
    /// Weight of keys with duplicate-vote evidence at each forked height, and the required `2q − T`.
    pub fork_evidence: Vec<(Height, Weight, Weight)>,
    /// Largest `|count·W − N·w| / W` seen by the fairness check, as (numerator, W).
    pub fairness_worst: (u128, u128),
    /// Validators jailed for downtime.
    pub jailed: Vec<(Height, KeyId)>,
    /// Signers listed in certificates, and the number that could have been listed.
    pub cert_signers: (u64, u64),
}

impl Report {
    /// True if nothing was violated.
    pub fn ok(&self) -> bool {
        self.violations.is_empty()
    }
    fn fail(&mut self, property: Property, height: Option<Height>, detail: String) {
        self.violations.push(Violation { property, height, detail });
    }
}

fn byzantine(b: &Behaviour, opts: &CheckOpts) -> bool {
    match b {
        Behaviour::CrashRestart { with_state: false, .. } => opts.amnesia_is_fault,
        other => other.byzantine(),
    }
}

/// Check every property on a finished run.
pub fn check(rec: &RunRecord, opts: &CheckOpts) -> Report {
    let mut rep = Report::default();
    let n = rec.nodes.len();
    let cfg = &rec.cfg;
    let correct: Vec<usize> = (0..n).filter(|i| !byzantine(&cfg.behaviours[*i], opts)).collect();
    let byz_keys: Vec<KeyId> = (0..n).filter(|i| byzantine(&cfg.behaviours[*i], opts)).map(|i| rec.keys[i]).collect();
    let faulty_keys: Vec<KeyId> = (0..n).filter(|i| cfg.behaviours[*i].faulty()).map(|i| rec.keys[i]).collect();
    let chain_id = cfg.params.chain_id.as_str();

    // Reference chain: the longest chain held by a correct node.
    let Some(&reference) = correct.iter().max_by_key(|i| (rec.nodes[**i].chain.len(), std::cmp::Reverse(**i))) else {
        return rep;
    };

    // ---- Replay the reference chain from genesis (P2, P6, P7, P8, P9) ----
    let mut ledger = rec.genesis.clone();
    let supply = ledger.total_supply();
    let mut sets: BTreeMap<Height, Arc<ValidatorSet>> = BTreeMap::new();
    let mut effects: Vec<Effects> = Vec::new();
    let mut replay_ok = true;
    let genesis_set = ledger.active_set.clone();
    let mut counts: BTreeMap<KeyId, u128> = BTreeMap::new();
    let mut fixed_set = true;
    let mut slashed_total: Quanta = 0;
    let mut tombstoned: BTreeSet<KeyId> = BTreeSet::new();
    rep.applicable.extend([Property::P2, Property::P7, Property::P8, Property::P9]);
    for c in &rec.nodes[reference].chain {
        let h = c.block.header.height;
        let set = ledger.active_set.clone();
        sets.insert(h, set.clone());
        // P2: scheduled proposer and full block validation, from genesis, by an independent ledger.
        let (next, fx) = match ledger.apply_block(&c.block) {
            Ok(x) => x,
            Err(e) => {
                rep.fail(Property::P2, Some(h), format!("committed block {:?} is invalid: {e:?}", c.block.id()));
                replay_ok = false;
                break;
            }
        };
        if fx != c.effects {
            rep.fail(Property::P10, Some(h), "replayed effects differ from the node's".to_string());
        }
        // P2: the certificate the node committed on.
        if c.cert.round < c.block.header.round || c.cert.block != c.block.id() || c.cert.verify(Domain::V3, chain_id, &set).is_err() {
            rep.fail(Property::P2, Some(h), format!("commit certificate invalid: {:?}", c.cert.verify(Domain::V3, chain_id, &set)));
        }
        rep.commit_rounds.push(c.cert.round);

        // P6: with a fixed set, round-0 slots follow stake to within one slot at every prefix.
        fixed_set &= *set == *genesis_set;
        if fixed_set {
            if let Some(p) = fx.round0_proposer {
                *counts.entry(p).or_insert(0) += 1;
            }
            let slots = (h - rec.genesis.height) as u128;
            let total = set.total();
            for (key, w) in set.members() {
                let got = counts.get(key).copied().unwrap_or(0) * total;
                let want = slots * w;
                let err = got.abs_diff(want);
                if err * rep.fairness_worst.1.max(1) > rep.fairness_worst.0 * total {
                    rep.fairness_worst = (err, total);
                }
                if err > total {
                    rep.fail(Property::P6, Some(h), format!("{key:?} has {} round-0 slots of {slots}, stake share {w}/{total}", got / total));
                }
            }
            rep.applicable.insert(Property::P6);
        }

        // P7: credits + burn + unearned = fees + subsidy, exactly; supply never changes;
        // nobody outside the signers and the builder is paid.
        let credits: Quanta = fx.credits.iter().map(|c| c.1).sum();
        if credits + fx.burn + fx.unearned != fx.fees + fx.subsidy {
            rep.fail(Property::P7, Some(h), format!("credits {credits} + burn {} + unearned {} != fees {} + subsidy {}", fx.burn, fx.unearned, fx.fees, fx.subsidy));
        }
        if fx.supply_after != supply {
            rep.fail(Property::P7, Some(h), format!("total supply changed: {} -> {}", supply, fx.supply_after));
        }
        for (acct, amount) in &fx.credits {
            if let Account::Key(k) = acct {
                if *amount > 0 && *k != c.block.header.builder && !fx.signers.contains(k) {
                    rep.fail(Property::P7, Some(h), format!("{k:?} was paid {amount} without signing or proposing"));
                }
            }
        }
        rep.cert_signers.0 += fx.signers.len() as u64;
        if c.block.parent_cert.is_some() {
            rep.cert_signers.1 += ledger.sets.get(&ledger.height).map_or(0, |s| s.len() as u64);
        }

        // P8: each unit of stake is cut at most once; what is cut is burned.
        for s in &fx.slashes {
            if s.cut_bond > s.bond_before {
                rep.fail(Property::P8, Some(h), format!("{:?} cut {} from a bond of {}", s.key, s.cut_bond, s.bond_before));
            }
            if !tombstoned.insert(s.key) && (s.cut_bond > 0 || s.bond_before > 0) {
                rep.fail(Property::P8, Some(h), format!("{:?} slashed a second time with stake still bonded", s.key));
            }
            slashed_total += s.cut_bond + s.cut_unbonding;
        }
        if next.burned_slash != slashed_total {
            rep.fail(Property::P8, Some(h), format!("burn counter {} != sum of cuts {slashed_total}", next.burned_slash));
        }

        // P9: a jailing needs m distinct proposers behind the omissions, and never
        // leaves a key at or above one third.
        for (key, blamed) in &fx.jailed {
            rep.jailed.push((h, *key));
            if blamed.len() < cfg.params.jail_min_proposers {
                rep.fail(Property::P9, Some(h), format!("{key:?} jailed on omissions by only {} proposer(s): {blamed:?}", blamed.len()));
            }
            let total = next.active_set.total();
            if let Some((k, w)) = next.active_set.members().iter().find(|(_, w)| w * 3 >= total) {
                rep.fail(Property::P9, Some(h), format!("jailing {key:?} leaves {k:?} with {w} of {total}"));
            }
            let idx = rec.keys.iter().position(|k| k == key);
            let dishonest_proposers = cfg.behaviours.iter().filter(|b| matches!(b, Behaviour::Withholder | Behaviour::Coalition | Behaviour::EquivocatingProposer)).count();
            if idx.is_some_and(|i| cfg.behaviours[i] == Behaviour::Honest) && dishonest_proposers < cfg.params.jail_min_proposers && cfg.net.max_delay < cfg.timeouts.commit_wait {
                rep.fail(Property::P9, Some(h), format!("honest, online {key:?} was jailed"));
            }
        }
        effects.push(fx);
        ledger = next;
    }
    sets.insert(ledger.height + 1, ledger.active_set.clone());

    // ---- P1 / P3: agreement, or accountability when the fault bound is exceeded ----
    let mut by_height: BTreeMap<Height, BTreeSet<BlockId>> = BTreeMap::new();
    for &i in &correct {
        for c in &rec.commits[i] {
            by_height.entry(c.height).or_default().insert(c.id);
        }
    }
    let weight_in = |keys: &[KeyId], set: &ValidatorSet| -> Weight { keys.iter().map(|k| set.weight(*k)).sum() };
    let below_third = |keys: &[KeyId]| sets.values().all(|s| weight_in(keys, s) * 3 < s.total() || s.is_empty());
    let safe = below_third(&byz_keys);
    if safe {
        rep.applicable.insert(Property::P1);
    }
    let evidence = duplicate_voters(rec.votes_seen.iter());
    for (h, ids) in by_height.iter().filter(|(_, ids)| ids.len() > 1) {
        rep.forked_heights.push(*h);
        if safe {
            rep.fail(Property::P1, Some(*h), format!("{} different blocks committed with Byzantine stake below one third: {ids:?}", ids.len()));
        }
        // P3: evidence against keys holding at least 2q − T.
        rep.applicable.insert(Property::P3);
        if let Some(set) = sets.get(h) {
            let accused: Vec<KeyId> = evidence.keys().filter(|(eh, _)| eh == h).map(|(_, k)| *k).collect();
            let have = weight_in(&accused, set);
            let need = (2 * set.quorum()).saturating_sub(set.total());
            rep.fork_evidence.push((*h, have, need));
            if have < need {
                rep.fail(Property::P3, Some(*h), format!("fork with duplicate-vote evidence against only {have} of the required {need} stake (accused: {accused:?})"));
            }
        }
    }

    // ---- P4 / P5: liveness and no stuck locks, after stabilisation ----
    let live = replay_ok && rep.forked_heights.is_empty() && below_third(&faulty_keys) && cfg.net.gst < cfg.end_time && cfg.net.partitions.iter().all(|p| p.end <= cfg.net.gst) && cfg.net.filters.iter().all(|f| f.end <= cfg.net.gst);
    if live {
        rep.applicable.extend([Property::P4, Property::P5]);
        let top = ledger.height;
        for &i in &correct {
            if !rec.alive[i] {
                continue;
            }
            let node = &rec.nodes[i];
            let m = &node.machine;
            // P5: a lock that outlives the run is a stuck lock (the Release 2b defect).
            if m.locked().is_some() && m.step() != Step::Committed {
                rep.fail(Property::P5, Some(m.height()), format!("node {i} still locked on {:?} in round {} at the end of the run", m.locked(), m.round()));
            }
            if node.ledger.height != top {
                rep.fail(Property::P4, Some(node.ledger.height + 1), format!("node {i} is at height {} while the chain is at {top}", node.ledger.height));
            }
            // P4: every pending transaction that is still admissible must have been committed.
            let now = rec.stopped_at;
            let stuck = node.ledger.admissible_txs(&node.mempool, now.max(node.ledger.tip_time + 1));
            if !stuck.is_empty() || (!rec.quiescent && m.step() != Step::NewHeight) {
                rep.fail(
                    Property::P4,
                    Some(m.height()),
                    format!("node {i}: {} admissible transaction(s) uncommitted, step {:?} round {} when the run ended (quiescent={})", stuck.len(), m.step(), m.round(), rec.quiescent),
                );
            }
        }
        // P4: bounded rounds for heights that began after stabilisation.
        let bound = opts.round_bound.unwrap_or(3 * n as Round + 10);
        let commits = &rec.commits[reference];
        for w in commits.windows(2) {
            if w[0].time >= cfg.net.gst && w[1].round > bound {
                rep.fail(Property::P4, Some(w[1].height), format!("committed in round {} (> {bound}) after stabilisation", w[1].round));
            }
        }
    }

    // ---- P7 (second half): a validator that was never online earns nothing ----
    for i in 0..n {
        if matches!(cfg.behaviours[i], Behaviour::Crash { at } if at <= cfg.start) {
            let key = Account::Key(rec.keys[i]);
            let (before, after) = (rec.genesis.balance(key), ledger.balance(key));
            let released: Quanta = effects.iter().flat_map(|f| f.released.iter()).filter(|r| r.0 == rec.keys[i]).map(|r| r.1).sum();
            if after > before + released {
                rep.fail(Property::P7, None, format!("offline validator {i} balance rose from {before} to {after}"));
            }
        }
    }

    // ---- P1 (prefix form): every correct node's chain is a prefix of the reference ----
    for &i in &correct {
        let other = &rec.nodes[i].chain;
        let diverged = other.iter().zip(&rec.nodes[reference].chain).any(|(a, b)| a.block.id() != b.block.id());
        if diverged && safe && rep.forked_heights.is_empty() {
            rep.fail(Property::P1, None, format!("node {i} chain is not a prefix of node {reference}'s"));
        }
    }

    // ---- P10: replaying the recorded schedule gives identical states and hashes ----
    if cfg.record_schedule {
        rep.applicable.insert(Property::P10);
        let (chain, finals) = crate::sim::replay(rec);
        let expect: Vec<u64> = rec.nodes.iter().map(|n| n.state_hash()).collect();
        if chain != rec.hash_chain || finals != expect {
            rep.fail(Property::P10, None, format!("replay diverged: hash chain {chain:016x} vs {:016x}", rec.hash_chain));
        }
    }
    rep
}

/// P6 on the schedule alone: run `slots` steps on a fixed set and return the
/// worst fairness error as a multiple of one slot, `(numerator, W)`; the
/// property holds iff `numerator ≤ W`.
pub fn fairness_error(set: &ValidatorSet, slots: u64) -> (u128, u128) {
    let mut s = crate::schedule::Schedule::new(set);
    let mut counts: BTreeMap<KeyId, u128> = BTreeMap::new();
    let total = set.total();
    let mut worst = 0u128;
    for slot in 1..=u128::from(slots) {
        let Ok(p) = s.step() else { break };
        *counts.entry(p).or_insert(0) += 1;
        for (key, w) in set.members() {
            worst = worst.max((counts.get(key).copied().unwrap_or(0) * total).abs_diff(slot * w));
        }
    }
    (worst, total)
}

/// The ledger after replaying the reference chain of a run (for tests and measurements).
pub fn final_ledger(rec: &RunRecord) -> Ledger {
    rec.nodes.iter().enumerate().filter(|(i, _)| rec.is_correct(*i)).map(|(_, n)| &n.ledger).max_by_key(|l| l.height).cloned().unwrap_or_else(|| rec.genesis.clone())
}
