//! Simulator-level tests: properties on seeded runs, replay, absent proposers,
//! measurements against the design's figures, and the bounded explorer.

use crate::campaign::{self, FaultKind, Options, Profile, Summary};
use crate::explore::{explore, ExploreConfig};
use crate::machine::{Step, Timeouts};
use crate::props::{check, fairness_error, CheckOpts, Property, ALL};
use crate::sim::{self, base_config, transfer, Behaviour, Rng};
use crate::types::*;

fn opts(validators: usize, profile: Profile) -> Options {
    Options { validators, profile, faults: FaultKind::ALL.to_vec(), fault_bound: None, long_every: 8, replay_every: 5 }
}

#[test]
fn honest_run_commits_every_transaction_and_replays_identically() {
    let mut cfg = base_config(1, &[1_000_000; 4], 80);
    for k in 0..5u64 {
        cfg.txs.push((cfg.start + 1_000 + k * 10_000, transfer(k + 1, cfg.params.base_fee)));
    }
    cfg.record_schedule = true;
    let rec = sim::run(&cfg);
    let rep = check(&rec, &CheckOpts::default());
    assert!(rep.ok(), "{:?}", rep.violations);
    assert_eq!(rep.commit_rounds, vec![0; 5]);
    for p in [Property::P1, Property::P2, Property::P4, Property::P5, Property::P6, Property::P7, Property::P8, Property::P9, Property::P10] {
        assert!(rep.applicable.contains(&p), "{p:?} must really have been checked");
    }
    assert!(rec.quiescent && rec.nodes.iter().all(|n| n.machine.step() == Step::NewHeight && n.ledger.height == 5));
    // P10 again, by hand: the same seed gives the same run; the recorded schedule gives the same hashes.
    let again = sim::run(&cfg);
    assert_eq!(again.hash_chain, rec.hash_chain);
    let (chain, finals) = sim::replay(&rec);
    assert_eq!(chain, rec.hash_chain);
    assert_eq!(finals, rec.nodes.iter().map(|n| n.state_hash()).collect::<Vec<_>>());
    // A different seed is a different schedule.
    cfg.seed = 2;
    assert_ne!(sim::run(&cfg).hash_chain, rec.hash_chain);
}

/// A small campaign in the test suite itself: all fault classes, below one third.
#[test]
fn mixed_fault_campaign_below_one_third_has_no_violation() {
    let mut total = Summary::default();
    for (o, seeds) in [(opts(4, Profile::Equal4), 0..120u64), (opts(7, Profile::Random), 0..40), (opts(5, Profile::Plan5), 0..40), (opts(3, Profile::Today), 0..40), (opts(3, Profile::FiftyThirtyTwenty), 0..40)] {
        for seed in seeds {
            let (rec, rep) = campaign::run_seed(seed, &o, &CheckOpts::default());
            assert!(rep.ok(), "{:?} seed {seed}: {:?}\nbehaviours {:?}", o.profile, rep.violations, rec.cfg.behaviours);
            assert!(rep.forked_heights.is_empty());
            total.add(&rec, &rep);
        }
    }
    for p in ALL {
        if p != Property::P3 {
            assert!(total.applicable.get(&p).copied().unwrap_or(0) > 0, "{p:?} never applicable");
        }
    }
    assert_eq!(total.total_violations(), 0);
    assert!(total.slashes > 0, "double voters were slashed along the way");
}

/// One, two and three consecutive absent proposers: the height commits in the
/// round of the first present proposer, after exactly the timeouts of the failed rounds.
#[test]
fn absent_proposers_cost_one_round_each() {
    let t = Timeouts::MODERATE;
    let delay = 200;
    let (normal, _, r) = campaign::finality_time(10, delay, 0, t).unwrap();
    assert_eq!(r, 0);
    assert!((3 * delay..=3 * delay + 200).contains(&normal), "normal case is three message delays: {normal}");
    for absent in 1..=3u32 {
        let (first, last, round) = campaign::finality_time(10, delay, absent as usize, t).unwrap();
        assert_eq!(round, absent);
        let waited: TimeMs = (0..absent).map(|r| t.propose(r) + t.vote(r)).sum();
        assert!(first >= waited && last <= waited + 12 * delay * TimeMs::from(absent + 1), "{absent} absent: {first}..{last} ms vs timeouts {waited}");
    }
}

/// Today's distribution in the simulator: the large validator offline means no block at all.
#[test]
fn today_profile_halts_without_the_large_validator_and_runs_with_it() {
    let stakes = Profile::Today.stakes(3, &mut Rng::new(0));
    let mut cfg = base_config(5, &stakes, 100);
    cfg.txs.push((cfg.start + 1_000, transfer(1, cfg.params.base_fee)));
    cfg.end_time = cfg.start + 30 * 60_000;
    cfg.hard_end = cfg.end_time + 60_000;
    // Both small validators crashed: nothing changes for the chain.
    let mut small_down = cfg.clone();
    small_down.behaviours[1] = Behaviour::Crash { at: cfg.start };
    small_down.behaviours[2] = Behaviour::Crash { at: cfg.start };
    let rec = sim::run(&small_down);
    let rep = check(&rec, &CheckOpts::default());
    assert!(rep.ok() && rep.applicable.contains(&Property::P4), "{:?}", rep.violations);
    assert_eq!(rec.nodes[0].ledger.height, 1);
    // The large validator crashed: 30 minutes, zero blocks; liveness is not even claimed.
    let mut big_down = cfg.clone();
    big_down.behaviours[0] = Behaviour::Crash { at: cfg.start };
    let rec = sim::run(&big_down);
    let rep = check(&rec, &CheckOpts::default());
    assert!(rec.commits.iter().all(|c| c.is_empty()));
    assert!(!rep.applicable.contains(&Property::P4), "faulty stake is above one third: P4 does not apply");
    assert!(rep.ok(), "a halt is not a safety violation: {:?}", rep.violations);
}

/// P6 on the schedule alone, for many stake shapes.
#[test]
fn proposer_fairness_within_one_slot() {
    let mut rng = Rng::new(9);
    let mut worst = (0u128, 1u128);
    let mut shapes: Vec<Vec<Weight>> = vec![vec![50, 30, 20], vec![100_090_000, 10_000, 9_000], vec![1; 4], vec![24, 22, 20, 18, 16], vec![1, 1, 1, 1_000_000]];
    for _ in 0..60 {
        let n = rng.range(2, 32) as usize;
        shapes.push((0..n).map(|_| u128::from(rng.range(1, 5_000_000))).collect());
    }
    for ws in shapes {
        let set = ValidatorSet::new(ws.iter().enumerate().map(|(i, w)| (KeyId(i as u32), *w)).collect()).unwrap();
        let (err, w) = fairness_error(&set, 3_000);
        assert!(err <= w, "stakes {ws:?}: error {err} exceeds one slot ({w})");
        if err * worst.1 > worst.0 * w {
            worst = (err, w);
        }
    }
    println!("worst fairness error over all shapes: {:.4} of one slot", worst.0 as f64 / worst.1 as f64);
}

/// Measurements that the design tabulates in §2.2 and §3.4, reproduced by simulation.
#[test]
fn traffic_and_certificate_sizes_match_the_design_tables() {
    for (n, distinct, deliveries, sent, cert) in [(4usize, 30_157u64, 24u64, 80_544u64, 13_284u64), (10, 70_429, 180, 604_080, 33_139), (30, 204_669, 1_740, 5_839_440, 99_321)] {
        let t = campaign::traffic(n, 50).unwrap();
        assert_eq!((t.votes, t.proposals), (2 * n as u64, 1), "two votes per validator, one proposal");
        assert_eq!(t.distinct_bytes, distinct, "n={n}");
        assert_eq!(t.deliveries, deliveries, "n={n}");
        assert_eq!(t.delivery_bytes, sent, "n={n}");
        assert_eq!(t.cert_bytes, (cert, cert), "n={n}: every signer is listed");
    }
    // One idle day at the hourly heartbeat: 24 blocks, 24 complete certificates.
    let (blocks, bytes) = campaign::heartbeat_day(4, 50);
    assert_eq!((blocks, bytes), (24, 24 * 13_284));
}

/// The explorer: complete on a small space, bounded on 4 x 2, and it does find a planted bug.
#[test]
fn bounded_exhaustive_exploration() {
    // Complete: three validators, one round. Every interleaving of deliveries and timeouts.
    let small = explore(&ExploreConfig { validators: 3, stake: 1_000_000, max_rounds: 1, byzantine: 0, order_seed: 0, max_states: 2_000_000, max_seconds: 120 });
    assert!(small.violation.is_none(), "{:?}", small.violation);
    assert!(small.complete, "the 3 x 1 space is small enough to finish ({} states)", small.states);
    assert!(small.decided_states > 0 && small.decided_blocks.len() == 1);
    println!("3 validators x 1 round: {} states, {} transitions, complete", small.states, small.transitions);
    // Bounded: the exit-criteria shape, 4 validators x 2 rounds, honest and with one Byzantine validator.
    for byzantine in [0, 1] {
        let r = explore(&ExploreConfig { validators: 4, stake: 1_000_000, max_rounds: 2, byzantine, order_seed: 0, max_states: 60_000, max_seconds: 60 });
        assert!(r.violation.is_none(), "{:?}", r.violation);
        assert!(r.states >= 60_000 && !r.complete);
    }
    // Self-test: with the quorum off by one, two validators of four decide alone and the explorer sees a fork.
    let _m = crate::mutation::enable(crate::mutation::Mutation::QuorumOffByOne);
    let mut broken = explore(&ExploreConfig { validators: 4, stake: 1, max_rounds: 2, byzantine: 0, order_seed: 0, max_states: 1, max_seconds: 60 });
    for order_seed in 1..=8 {
        broken = explore(&ExploreConfig { validators: 4, stake: 1, max_rounds: 2, byzantine: 0, order_seed, max_states: 150_000, max_seconds: 60 });
        if broken.violation.is_some() {
            println!("order seed {order_seed}");
            break;
        }
    }
    println!("explorer under the quorum mutation: {} states, violation: {}", broken.states, broken.violation.as_deref().map_or("none", |v| v.lines().next().unwrap_or("")));
    assert!(broken.violation.as_deref().is_some_and(|v| v.starts_with("P1")), "the explorer must see the planted fork");
}

/// The checkers for P2 and P10 can fire: tamper with a finished, clean run.
#[test]
fn tampered_records_are_caught_by_p2_and_p10() {
    let mut cfg = base_config(21, &[1_000_000; 4], 60);
    for k in 0..3u64 {
        cfg.txs.push((cfg.start + 1_000 + k * 5_000, transfer(k + 1, cfg.params.base_fee)));
    }
    cfg.record_schedule = true;
    let rec = sim::run(&cfg);
    assert!(check(&rec, &CheckOpts::default()).ok());
    // P2: a committed block that validation rejects (same header, its transactions removed).
    let mut bad = rec.clone();
    let original = bad.nodes[0].chain[1].block.clone();
    bad.nodes[0].chain[1].block = std::sync::Arc::new(crate::chain::Block::new(original.header.clone(), original.parent_cert.clone(), Vec::new(), Vec::new()));
    let rep = check(&bad, &CheckOpts::default());
    assert!(rep.violations.iter().any(|v| v.property == Property::P2), "{:?}", rep.violations);
    // P2: a block by a validator that was not the scheduled proposer.
    let mut bad = rec.clone();
    let mut header = original.header.clone();
    header.builder = KeyId((header.builder.0 + 1) % 4);
    bad.nodes[0].chain[1].block = std::sync::Arc::new(crate::chain::Block::new(header, original.parent_cert.clone(), original.txs.clone(), Vec::new()));
    let rep = check(&bad, &CheckOpts::default());
    assert!(rep.violations.iter().any(|v| v.property == Property::P2), "{:?}", rep.violations);
    // P10: a schedule that is not the one that produced the recorded hashes.
    let mut bad = rec.clone();
    let cut = bad.schedule.len() / 2;
    bad.schedule.remove(cut);
    let rep = check(&bad, &CheckOpts::default());
    assert!(rep.violations.iter().any(|v| v.property == Property::P10), "{:?}", rep.violations);
}
