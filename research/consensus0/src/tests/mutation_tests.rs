//! Self-tests that prove the checkers can see failures.
//!
//! (a) restart WITHOUT persisted state is unsafe; (b) with at least one third
//! of the stake faulty a fork is reachable and evidence is produced; (c) each
//! deliberately broken rule is caught by the property named for it. Every
//! mutation test also runs the same scenario with the correct rules and
//! requires a clean report, so a checker that always fires would fail too.

use super::lab::*;
use crate::campaign::{self, amnesia_scenario, FaultKind, Options, Profile};
use crate::machine::{Message, Proposal, TimerKind};
use crate::mutation::{enable, Mutation};
use crate::node::NodeInput;
use crate::props::{check, fairness_error, CheckOpts, Property, Report};
use crate::sim::{self, base_config, transfer, Behaviour, Filter, MsgKind, NetConfig, Partition, SimConfig};
use crate::types::*;

const S: TimeMs = 1_000;

fn has(rep: &Report, p: Property) -> bool {
    rep.violations.iter().any(|v| v.property == p)
}

fn run(cfg: &SimConfig) -> Report {
    check(&sim::run(cfg), &CheckOpts::default())
}

// ------------------------------------------------------------------ (a) --

/// (a) Restart without the §3.7 records. Treated as the honest restart the
/// operator believes it is, it breaks agreement in some schedules; restarting
/// WITH the records is safe in every one of the same schedules.
#[test]
fn a_restart_without_persisted_state_breaks_agreement() {
    let lenient = CheckOpts { amnesia_is_fault: false, round_bound: None };
    let (mut forks, mut double_signers, mut first) = (0, 0, None);
    for seed in 0..600 {
        let rec = sim::run(&amnesia_scenario(seed, false));
        let rep = check(&rec, &lenient);
        if has(&rep, Property::P1) {
            forks += 1;
            first.get_or_insert(seed);
        }
        double_signers += usize::from(!duplicate_voters(rec.votes_seen.iter()).is_empty());
    }
    println!("amnesia: {forks} of 600 schedules fork (first seed {first:?}); in {double_signers} a validator that stayed up holds duplicate-vote evidence against a restarted one");
    assert!(forks > 0, "the checker must be able to see this failure");
    // Control: the same 600 schedules, restarting with persisted state. Nothing may break.
    for seed in 0..600 {
        let rec = sim::run(&amnesia_scenario(seed, true));
        let rep = check(&rec, &CheckOpts::default());
        assert!(rep.ok(), "seed {seed}: {:?}", rep.violations);
        assert!(duplicate_voters(rec.votes_seen.iter()).is_empty(), "seed {seed}: a journaled validator never signs twice");
        assert!(rep.applicable.contains(&Property::P1), "no validator counts as Byzantine here: agreement is claimed and holds");
    }
}

// ------------------------------------------------------------------ (b) --

/// (b) Colluding validators holding half the stake: a fork is reachable, the
/// agreement property is (rightly) not claimed, and whenever a fork happens
/// there is duplicate-vote evidence against at least `2q − T`.
#[test]
fn b_one_third_or_more_faulty_can_fork_and_same_round_forks_are_accountable() {
    let opts = Options { validators: 4, profile: Profile::Equal4, faults: vec![FaultKind::Coalition, FaultKind::Chaos, FaultKind::Partition], fault_bound: Some((1, 2)), long_every: 0, replay_every: 0 };
    let (mut forks, mut over_bound) = (0, 0);
    for seed in 0..120 {
        let mut cfg = campaign::scenario(seed, &opts);
        cfg.hard_end = cfg.end_time + 60 * S; // a halted run need not be simulated for hours
        let rec = sim::run(&cfg);
        let rep = check(&rec, &CheckOpts::default());
        let byz = rec.cfg.behaviours.iter().filter(|b| b.byzantine()).count();
        over_bound += usize::from(byz >= 2);
        if !rep.forked_heights.is_empty() {
            forks += 1;
            assert!(byz >= 2, "seed {seed}: a fork with Byzantine stake below one third");
            assert!(!rep.applicable.contains(&Property::P1), "P1 is not claimed above the bound");
            assert!(rep.applicable.contains(&Property::P3));
            assert!(!has(&rep, Property::P3), "seed {seed}: {:?}", rep.violations);
            for (_, have, need) in &rep.fork_evidence {
                assert!(have >= need && *need > 0);
            }
        } else {
            assert!(!has(&rep, Property::P1) && !has(&rep, Property::P2), "seed {seed}");
        }
    }
    println!("coalition at one half: {forks} forks in 120 schedules ({over_bound} with two colluders)");
    assert!(forks > 0, "a safety violation must be reachable above the bound");
}

/// (b, continued) — design defect F3. P3 as written ("whenever two blocks are
/// committed at one height, evidence exists against keys holding at least
/// 2q − T") does not hold when the faulty validators vote in DIFFERENT rounds:
/// they sign one value per slot, so there is no duplicate vote at all. §4.1
/// itself says breaking a lock across rounds is not provable from two signatures.
#[test]
fn b_cross_round_fork_leaves_no_duplicate_vote_evidence() {
    let mut lab = Lab::new(&[1_000_000; 4]);
    let chain = lab.chain_id();
    let ledger = lab.nodes[0].ledger.clone();
    let fee = ledger.params.base_fee;
    let mut faulty_votes = Vec::new();
    // Validators 2 and 3 are faulty; each call signs ONE prevote and ONE precommit per validator for a round.
    let mut vote_both = |lab: &mut Lab, to: usize, round: Round, block: BlockId| {
        for kind in [VoteType::Prevote, VoteType::Precommit] {
            for b in [2, 3] {
                let v = Vote::sign(&sk(b), &chain, kind, 1, round, Some(block));
                faulty_votes.push(v);
                lab.input(to, NodeInput::Message(Message::Vote(v)));
            }
        }
    };
    // Round 0: honest validator 0 proposes X. The faulty pair prevote and precommit X, towards it only.
    lab.tx(&[0], transfer(1, fee));
    let x = lab.proposed(1, 0).unwrap().id();
    vote_both(&mut lab, 0, 0, x);
    assert_eq!(lab.committed(0, 1), Some(x));
    // Round 2 belongs to faulty validator 2. It builds its own block Y and proposes it once.
    let y = std::sync::Arc::new(ledger.build_block(key(2), 2, ledger.tip_time + 5_000, None, vec![transfer(2, fee)], vec![]));
    lab.input(1, NodeInput::Message(Message::Proposal(Proposal::sign(&sk(2), &chain, 1, 2, None, y.clone()))));
    // Their round-2 votes pull honest validator 1 into round 2 (stake ≥ t1), where it is free to prevote Y.
    vote_both(&mut lab, 1, 2, y.id());
    assert_eq!(lab.votes_of(1, VoteType::Prevote, 1, 2).first().map(|v| v.block), Some(Some(y.id())));
    assert_eq!(lab.committed(1, 1), Some(y.id()), "two honest validators, two blocks, one height");
    assert_ne!(x, y.id());
    // Every slot of the faulty validators holds exactly one value: there is nothing to slash.
    let honest = lab.outbox.iter().filter_map(|(_, m)| if let Message::Vote(v) = m { Some(*v) } else { None });
    let pool: Vec<Vote> = faulty_votes.iter().copied().chain(honest).collect();
    assert!(duplicate_voters(pool.iter()).is_empty(), "no duplicate vote exists anywhere");
    let set = ledger.active_set.clone();
    assert_eq!(2 * set.quorum() - set.total(), 1_333_334, "P3 as written requires evidence against this much stake");
    let _ = TimerKind::Propose;
}

// ------------------------------------------------------------------ (c) --

/// The scenario for the lock rule: validators 0, 2, 3 precommit X in round 0 and
/// validator 2 alone sees all three precommits and commits, then drops off.
/// Validator 1 saw nothing of round 0 and proposes Y in round 1.
fn lock_scenario() -> SimConfig {
    let mut cfg = base_config(11, &[1_000_000; 4], 50);
    let t0 = cfg.start;
    let heal = t0 + 60 * S;
    let f = |signer, to, kind| Filter { start: t0, end: heal, signer, to: Some(to), kind: Some(kind), round: Some(0) };
    cfg.net = NetConfig {
        gst: heal,
        partitions: vec![Partition { start: t0 + 1_400, end: heal, side: vec![false, false, true, false] }],
        filters: vec![
            f(None, 1, MsgKind::Proposal),
            f(Some(2), 1, MsgKind::Prevote),
            f(Some(2), 0, MsgKind::Precommit),
            f(Some(2), 3, MsgKind::Precommit),
            f(Some(2), 1, MsgKind::Precommit),
        ],
        ..NetConfig::fixed(50)
    };
    cfg.txs.push((t0 + S, transfer(1, cfg.params.base_fee)));
    cfg.end_time = t0 + 5 * 60 * S;
    cfg
}

#[test]
fn c_no_lock_on_precommit_is_caught_by_p1() {
    let clean = run(&lock_scenario());
    assert!(clean.ok() && clean.applicable.contains(&Property::P1), "{:?}", clean.violations);
    assert_eq!(clean.commit_rounds, vec![0], "with locks the height ends on the block of round 0");
    let _m = enable(Mutation::NoLockOnPrecommit);
    let broken = run(&lock_scenario());
    assert!(has(&broken, Property::P1), "{:?}", broken.violations);
    assert_eq!(broken.forked_heights, vec![1]);
}

/// Two halves of four validators with one XRGE each: `⌊2T/3⌋ = 2` lets each half decide alone.
fn split_scenario() -> SimConfig {
    let mut cfg = base_config(12, &[1, 1, 1, 1], 50);
    let t0 = cfg.start;
    cfg.net = NetConfig { gst: t0 + 90 * S, partitions: vec![Partition { start: t0, end: t0 + 90 * S, side: vec![false, false, true, true] }], ..NetConfig::fixed(50) };
    cfg.txs.push((t0 + S, transfer(1, cfg.params.base_fee)));
    cfg.end_time = t0 + 6 * 60 * S;
    cfg
}

#[test]
fn c_quorum_off_by_one_is_caught_by_p1() {
    let clean = run(&split_scenario());
    assert!(clean.ok() && clean.applicable.contains(&Property::P1) && clean.applicable.contains(&Property::P4), "{:?}", clean.violations);
    let _m = enable(Mutation::QuorumOffByOne);
    let broken = run(&split_scenario());
    assert!(has(&broken, Property::P1), "{:?}", broken.violations);
}

#[test]
fn c_unweighted_proposer_schedule_is_caught_by_p6() {
    let scenario = || {
        let mut cfg = base_config(13, &[5_000_000, 3_000_000, 2_000_000], 50);
        cfg.end_time = cfg.start + 48 * HOUR + 30 * 60 * S;
        cfg.hard_end = cfg.end_time + HOUR;
        cfg
    };
    let set = ValidatorSet::new(vec![(key(0), 50), (key(1), 30), (key(2), 20)]).unwrap();
    let clean = run(&scenario());
    assert!(clean.ok() && clean.applicable.contains(&Property::P6), "{:?}", clean.violations);
    assert!(clean.commit_rounds.len() >= 48);
    let (err, w) = fairness_error(&set, 1_000);
    assert!(err <= w);
    let _m = enable(Mutation::ScheduleNotStakeWeighted);
    let broken = run(&scenario());
    assert!(has(&broken, Property::P6), "{:?}", broken.violations);
    let (err, w) = fairness_error(&set, 1_000);
    assert!(err > w);
}

/// One proposer (25 % of the stake) leaves two validators out of every certificate it assembles.
fn omission_scenario() -> SimConfig {
    let mut cfg = base_config(14, &[2_500_000, 1_500_000, 1_500_000, 1_500_000, 1_500_000, 1_500_000], 50);
    cfg.behaviours[0] = Behaviour::Withholder;
    cfg.params.jail_window = 20;
    cfg.params.jail_missed = 3;
    cfg.end_time = cfg.start + 72 * HOUR + 30 * 60 * S;
    cfg.hard_end = cfg.end_time + HOUR;
    cfg
}

#[test]
fn c_jailing_without_the_three_proposer_rule_is_caught_by_p9() {
    let rec = sim::run(&omission_scenario());
    let clean = check(&rec, &CheckOpts::default());
    assert!(clean.ok(), "{:?}", clean.violations);
    assert!(clean.jailed.is_empty(), "omissions by one proposer jail nobody");
    assert!(clean.cert_signers.0 < clean.cert_signers.1, "the withholder really did omit signers");
    for m in [Mutation::JailWithoutProposerRule, Mutation::JailWindowProposersLiteral] {
        let _m = enable(m);
        let broken = run(&omission_scenario());
        assert!(has(&broken, Property::P9), "{m:?}: {:?}", broken.violations);
        assert!(!broken.jailed.is_empty());
    }
}

#[test]
fn c_reward_rounding_leak_is_caught_by_p7() {
    let scenario = || {
        let mut cfg = base_config(15, &[3_333_333, 2_222_222, 1_111_111, 777_777], 50);
        for k in 0..5u64 {
            cfg.txs.push((cfg.start + S + k * 30 * S, transfer(k + 1, cfg.params.base_fee * (7 + u128::from(k)))));
        }
        cfg
    };
    let clean = run(&scenario());
    assert!(clean.ok() && clean.applicable.contains(&Property::P7), "{:?}", clean.violations);
    let _m = enable(Mutation::RewardRoundingLeak);
    let broken = run(&scenario());
    assert!(has(&broken, Property::P7), "{:?}", broken.violations);
}

/// The mutation switch itself: off unless a guard is alive on this thread.
#[test]
fn mutations_are_off_by_default_and_scoped() {
    use crate::mutation::active;
    assert!(!active(Mutation::QuorumOffByOne));
    {
        let _g = enable(Mutation::QuorumOffByOne);
        assert!(active(Mutation::QuorumOffByOne) && !active(Mutation::NoLockOnPrecommit));
        assert_eq!(ValidatorSet::new(vec![(key(0), 1), (key(1), 1), (key(2), 1), (key(3), 1)]).unwrap().quorum(), 2);
    }
    assert!(!active(Mutation::QuorumOffByOne));
    assert_eq!(ValidatorSet::new(vec![(key(0), 1), (key(1), 1), (key(2), 1), (key(3), 1)]).unwrap().quorum(), 3);
}
