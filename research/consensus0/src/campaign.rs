//! Seed → scenario generation for the campaign, the measurement scenarios of
//! §9, and the aggregation of results.

use std::collections::BTreeMap;

use crate::chain::{Account, Tx, TxKind};
use crate::machine::Timeouts;
use crate::props::{self, CheckOpts, Property, Report};
use crate::sim::{self, base_config, transfer, Behaviour, NetConfig, Partition, Rng, RunRecord, SimConfig};
use crate::types::*;

/// Stake distributions (§9 "Validators").
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Profile {
    /// Today's set as given in the owner's brief (§1.1): 100,090,000 / 10,000 / 9,000 XRGE.
    Today,
    /// Equal stakes (the name is the design's "4 equal"; any validator count is accepted).
    Equal4,
    /// The decentralization plan's 5-operator target. That document was not available to this
    /// task; modelled as five operators at 24/22/20/18/16 %, each below one third and still so
    /// after any one exit. **Assumption, see RESULTS.md.**
    Plan5,
    /// The worked example of §3.3.
    FiftyThirtyTwenty,
    /// Random stakes between the consensus minimum and fifty times it.
    Random,
}

impl Profile {
    /// Parse a command-line name.
    pub fn parse(s: &str) -> Option<Profile> {
        Some(match s {
            "today" => Profile::Today,
            "equal4" | "equal" => Profile::Equal4,
            "plan5" => Profile::Plan5,
            "50-30-20" => Profile::FiftyThirtyTwenty,
            "random" => Profile::Random,
            _ => return None,
        })
    }
    /// Stakes in whole XRGE. Profiles with a fixed shape ignore `n`.
    pub fn stakes(self, n: usize, rng: &mut Rng) -> Vec<Weight> {
        match self {
            Profile::Today => vec![100_090_000, 10_000, 9_000],
            Profile::Equal4 => vec![1_000_000; n.max(1)],
            Profile::Plan5 => vec![2_400_000, 2_200_000, 2_000_000, 1_800_000, 1_600_000],
            Profile::FiftyThirtyTwenty => vec![5_000_000, 3_000_000, 2_000_000],
            Profile::Random => (0..n.max(1)).map(|_| u128::from(rng.range(100_000, 5_000_000))).collect(),
        }
    }
}

/// Fault classes a campaign may draw from.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum FaultKind {
    /// Crash for ever.
    Crash,
    /// Crash and restart with persisted state.
    Restart,
    /// Crash and restart WITHOUT persisted state (Byzantine by effect).
    RestartNoState,
    /// Equivocating proposer.
    Equivocate,
    /// Double-voting validator.
    DoubleVote,
    /// Colluding equivocating proposer and double voters.
    Coalition,
    /// Always-nil voter.
    Nil,
    /// Proposer withholding signatures and transactions.
    Withhold,
    /// Stalling validator.
    Stall,
    /// Network: loss, duplication, long delays and reordering before stabilisation.
    Chaos,
    /// Network: scripted partitions before stabilisation.
    Partition,
}

impl FaultKind {
    /// Every fault class.
    pub const ALL: [FaultKind; 11] = [
        FaultKind::Crash,
        FaultKind::Restart,
        FaultKind::RestartNoState,
        FaultKind::Equivocate,
        FaultKind::DoubleVote,
        FaultKind::Coalition,
        FaultKind::Nil,
        FaultKind::Withhold,
        FaultKind::Stall,
        FaultKind::Chaos,
        FaultKind::Partition,
    ];
    /// Parse a command-line name.
    pub fn parse(s: &str) -> Option<FaultKind> {
        Some(match s {
            "crash" => FaultKind::Crash,
            "restart" => FaultKind::Restart,
            "restart-nostate" => FaultKind::RestartNoState,
            "equivocate" => FaultKind::Equivocate,
            "doublevote" => FaultKind::DoubleVote,
            "coalition" => FaultKind::Coalition,
            "nil" => FaultKind::Nil,
            "withhold" => FaultKind::Withhold,
            "stall" => FaultKind::Stall,
            "chaos" => FaultKind::Chaos,
            "partition" => FaultKind::Partition,
            _ => return None,
        })
    }
    /// Parse a comma-separated list; `all` and `none` are accepted.
    pub fn parse_list(s: &str) -> Option<Vec<FaultKind>> {
        match s {
            "all" => Some(Self::ALL.to_vec()),
            "none" | "" => Some(Vec::new()),
            _ => s.split(',').map(Self::parse).collect(),
        }
    }
}

/// Campaign options.
#[derive(Clone, Debug)]
pub struct Options {
    /// Number of validators (ignored by fixed-shape profiles).
    pub validators: usize,
    /// Stake profile.
    pub profile: Profile,
    /// Fault classes to draw from.
    pub faults: Vec<FaultKind>,
    /// Upper bound on faulty stake as a fraction `num/den` of `T`; the default is "strictly below one third".
    pub fault_bound: Option<(u128, u128)>,
    /// One seed in `long_every` simulates three days with staking operations and a short jail window (0 = never).
    pub long_every: u64,
    /// Record and replay the schedule of one seed in `replay_every` (0 = never).
    pub replay_every: u64,
}

const SECOND: TimeMs = 1_000;
const HOUR: TimeMs = 3_600 * SECOND;

/// Derive the scenario of `seed`.
pub fn scenario(seed: u64, opts: &Options) -> SimConfig {
    // A stream separate from the simulator's own (which is seeded with `seed` itself).
    let mut rng = Rng::new(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 0x00c0_ffee);
    let stakes = opts.profile.stakes(opts.validators, &mut rng);
    let n = stakes.len();
    let total: Weight = stakes.iter().sum();
    let mut cfg = base_config(seed, &stakes, 50);
    let start = cfg.start;
    let has = |k: FaultKind| opts.faults.contains(&k);

    // Network.
    let unstable = has(FaultKind::Chaos) || has(FaultKind::Partition);
    let gst_rel = if unstable { rng.range(10 * SECOND, 60 * SECOND) } else { 0 };
    let max_delay = rng.range(20, 400);
    cfg.net = NetConfig {
        min_delay: 5,
        max_delay,
        pre_gst_max_delay: if has(FaultKind::Chaos) { rng.range(max_delay, 9 * SECOND) } else { max_delay },
        drop_permille: if has(FaultKind::Chaos) { rng.range(0, 300) } else { 0 },
        dup_permille: if has(FaultKind::Chaos) { rng.range(0, 150) } else { 0 },
        gst: start + gst_rel,
        adversary_max_delay: rng.range(0, 4 * SECOND),
        partitions: Vec::new(),
        filters: Vec::new(),
    };
    if has(FaultKind::Partition) {
        for _ in 0..rng.range(1, 2) {
            let a = rng.range(0, gst_rel - 1);
            let b = rng.range(a + 1, gst_rel);
            cfg.net.partitions.push(Partition { start: start + a, end: start + b, side: (0..n).map(|_| rng.permille(500)).collect() });
        }
    }
    cfg.clock_offset_max = rng.range(0, 800);

    // Faulty validators: total weight within the bound (default: strictly below one third).
    let budget = match opts.fault_bound {
        Some((num, den)) => total * num / den.max(1),
        None => total - (total * 2 / 3 + 1),
    };
    let node_kinds: Vec<FaultKind> = opts.faults.iter().copied().filter(|k| !matches!(k, FaultKind::Chaos | FaultKind::Partition)).collect();
    let mut order: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        order.swap(i, rng.below(i as u64 + 1) as usize);
    }
    let mut used: Weight = 0;
    for i in order {
        if node_kinds.is_empty() || used + stakes[i] > budget || !rng.permille(600) {
            continue;
        }
        used += stakes[i];
        let at = start + rng.range(0, gst_rel + 20 * SECOND);
        cfg.behaviours[i] = match node_kinds[rng.below(node_kinds.len() as u64) as usize] {
            FaultKind::Crash => Behaviour::Crash { at },
            FaultKind::Restart => Behaviour::CrashRestart { at, back: at + rng.range(SECOND, 30 * SECOND), with_state: true },
            FaultKind::RestartNoState => Behaviour::CrashRestart { at, back: at + rng.range(SECOND, 30 * SECOND), with_state: false },
            FaultKind::Equivocate => Behaviour::EquivocatingProposer,
            FaultKind::DoubleVote => Behaviour::DoubleVoter,
            FaultKind::Coalition => Behaviour::Coalition,
            FaultKind::Nil => Behaviour::NilVoter,
            FaultKind::Withhold => Behaviour::Withholder,
            FaultKind::Stall => Behaviour::Staller { delay: rng.range(SECOND, 12 * SECOND) },
            FaultKind::Chaos | FaultKind::Partition => Behaviour::Honest,
        };
    }

    // Workload.
    let base_fee = cfg.params.base_fee;
    let mut id = seed.wrapping_mul(1_000) + 1;
    for _ in 0..rng.range(2, 6) {
        let fee = base_fee * u128::from(rng.range(1, 100));
        cfg.txs.push((start + rng.range(0, gst_rel + 15 * SECOND), transfer(id, fee)));
        id += 1;
    }
    cfg.end_time = start + gst_rel + 10 * 60 * SECOND;
    cfg.hard_end = cfg.end_time + 3 * HOUR;

    // Long runs: three days of heartbeats, epochs, staking operations, a short jail window.
    if opts.long_every > 0 && seed % opts.long_every == 0 {
        cfg.params.jail_window = 24;
        cfg.params.jail_missed = 12;
        cfg.end_time = start + 72 * HOUR + 30 * 60 * SECOND;
        cfg.hard_end = cfg.end_time + 3 * HOUR;
        let honest: Vec<usize> = (0..n).filter(|i| cfg.behaviours[*i] == Behaviour::Honest).collect();
        for k in 0..rng.range(1, 4) {
            let Some(&v) = honest.get(rng.below(honest.len().max(1) as u64) as usize) else { break };
            let from = Account::Key(KeyId(v as u32));
            let kind = if k % 2 == 0 { TxKind::Unbond { amount: u128::from(rng.range(1, 50_000)) * QUANTA_PER_XRGE } } else { TxKind::Stake { amount: u128::from(rng.range(1, 900)) * QUANTA_PER_XRGE } };
            cfg.txs.push((start + rng.range(HOUR, 40 * HOUR), Tx { id, from, fee: base_fee, kind }));
            id += 1;
        }
        for _ in 0..rng.range(1, 4) {
            cfg.txs.push((start + rng.range(HOUR, 70 * HOUR), transfer(id, base_fee * 10)));
            id += 1;
        }
    }
    cfg.record_schedule = opts.replay_every > 0 && seed % opts.replay_every == 0;
    cfg
}

/// The scenario family behind the self-test "restart WITHOUT persisted state
/// must be shown unsafe" (§9): four equal validators decide one height; one
/// non-proposer is cut off just as the precommits fly, and the other three —
/// the round-0 proposer among them — crash and restart around the same moment.
/// With `with_state = false` they come back with no journal and no lock; the
/// proposer then builds a second block for a slot it already used. With
/// `with_state = true` the same schedules must be safe.
pub fn amnesia_scenario(seed: u64, with_state: bool) -> SimConfig {
    let mut rng = Rng::new(seed ^ 0x00a3_e51a);
    let mut cfg = base_config(seed, &[1_000_000; 4], 0);
    let start = cfg.start;
    let submit = start + SECOND;
    let survivor = 1 + rng.below(3) as usize;
    let cut = submit + rng.range(150, 450);
    cfg.net = NetConfig {
        min_delay: 5,
        max_delay: 100,
        pre_gst_max_delay: 100,
        drop_permille: 0,
        dup_permille: 0,
        gst: start + 70 * SECOND,
        adversary_max_delay: 0,
        partitions: vec![Partition { start: cut, end: start + 60 * SECOND, side: (0..4).map(|i| i == survivor).collect() }],
        filters: Vec::new(),
    };
    for i in (0..4).filter(|i| *i != survivor) {
        let at = submit + rng.range(120, 420);
        cfg.behaviours[i] = Behaviour::CrashRestart { at, back: at + rng.range(100, 1_500), with_state };
    }
    cfg.txs.push((submit, transfer(1, cfg.params.base_fee)));
    cfg.end_time = start + 10 * 60 * SECOND;
    cfg.hard_end = cfg.end_time + HOUR;
    cfg
}

/// Aggregated campaign results.
#[derive(Clone, Debug, Default)]
pub struct Summary {
    /// Seeds run.
    pub seeds: u64,
    /// Node inputs processed (the unit of simulation work).
    pub inputs: u64,
    /// Heights committed on reference chains.
    pub heights: u64,
    /// Histogram: commit round → number of heights.
    pub rounds: BTreeMap<Round, u64>,
    /// Per property: runs in which its precondition held.
    pub applicable: BTreeMap<Property, u64>,
    /// Per property: violations.
    pub violations: BTreeMap<Property, u64>,
    /// First few violating seeds with their description.
    pub examples: Vec<(u64, String)>,
    /// Runs in which some height had two committed blocks.
    pub forks: u64,
    /// Count of each behaviour assigned.
    pub behaviours: BTreeMap<&'static str, u64>,
    /// Evidence-driven slashes and downtime jailings observed.
    pub slashes: u64,
    /// Downtime jailings observed.
    pub jailings: u64,
    /// Worst fairness error seen, as (numerator, W).
    pub fairness_worst: (u128, u128),
    /// Runs that did not go quiet before the hard stop.
    pub not_quiescent: u64,
}

impl Summary {
    /// Fold one run in.
    pub fn add(&mut self, rec: &RunRecord, rep: &Report) {
        self.seeds += 1;
        self.inputs += rec.stats.inputs;
        self.heights += rep.commit_rounds.len() as u64;
        for r in &rep.commit_rounds {
            *self.rounds.entry(*r).or_insert(0) += 1;
        }
        for p in &rep.applicable {
            *self.applicable.entry(*p).or_insert(0) += 1;
        }
        for v in &rep.violations {
            *self.violations.entry(v.property).or_insert(0) += 1;
            if self.examples.len() < 10 {
                self.examples.push((rec.cfg.seed, format!("{:?} h={:?}: {}", v.property, v.height, v.detail)));
            }
        }
        self.forks += u64::from(!rep.forked_heights.is_empty());
        for b in &rec.cfg.behaviours {
            *self.behaviours.entry(b.name()).or_insert(0) += 1;
        }
        let reference = rec.nodes.iter().map(|n| &n.chain).max_by_key(|c| c.len());
        self.slashes += reference.map_or(0, |c| c.iter().map(|b| b.effects.slashes.len() as u64).sum());
        self.jailings += rep.jailed.len() as u64;
        if rep.fairness_worst.0 * self.fairness_worst.1.max(1) > self.fairness_worst.0 * rep.fairness_worst.1.max(1) {
            self.fairness_worst = rep.fairness_worst;
        }
        self.not_quiescent += u64::from(!rec.quiescent);
    }
    /// Total violations.
    pub fn total_violations(&self) -> u64 {
        self.violations.values().sum()
    }
}

/// Run one seed and check it.
pub fn run_seed(seed: u64, opts: &Options, check: &CheckOpts) -> (RunRecord, Report) {
    let cfg = scenario(seed, opts);
    let rec = sim::run(&cfg);
    let rep = props::check(&rec, check);
    (rec, rep)
}

/// Time to finality (§9 "Measurements"): `n` equal validators, a fixed one-way
/// delay, and the scheduled proposers of the first `absent` rounds crashed.
/// Returns milliseconds from submission to the first and to the last commit
/// among running validators, and the commit round; `None` if nothing committed.
pub fn finality_time(n: usize, delay: TimeMs, absent: usize, timeouts: Timeouts) -> Option<(TimeMs, TimeMs, Round)> {
    let stakes = vec![1_000_000u128; n];
    let mut cfg = base_config(1, &stakes, delay);
    cfg.timeouts = timeouts;
    let genesis = sim::genesis_ledger(&cfg);
    let mut proposers = genesis.next_proposers();
    for r in 0..absent {
        let p = proposers.get(r as Round)?;
        cfg.behaviours[p.0 as usize] = Behaviour::Crash { at: cfg.start };
    }
    let submit = cfg.start + 1_000;
    cfg.txs.push((submit, transfer(1, cfg.params.base_fee)));
    cfg.net = NetConfig::fixed(delay);
    cfg.end_time = cfg.start + 30 * 60 * SECOND;
    let rec = sim::run(&cfg);
    let times: Vec<(TimeMs, Round)> = rec.commits.iter().filter_map(|c| c.first()).map(|c| (c.time, c.round)).collect();
    let first = times.iter().map(|t| t.0).min()?;
    let last = times.iter().map(|t| t.0).max()?;
    Some((first - submit, last - submit, times[0].1))
}

/// Consensus traffic for `n` equal honest validators at a fixed delay over a
/// few transaction-carrying heights: per height, the distinct votes and
/// proposals signed and the size of the certificate that the next block carried.
pub struct TrafficSample {
    /// Validators.
    pub n: usize,
    /// Distinct votes per block (median).
    pub votes: u64,
    /// Distinct proposals per block (median).
    pub proposals: u64,
    /// Bytes of distinct votes plus the proposal signature (§2.2 row "distinct … bytes per block").
    pub distinct_bytes: u64,
    /// Vote deliveries per block, network-wide.
    pub deliveries: u64,
    /// Vote bytes sent network-wide per block.
    pub delivery_bytes: u64,
    /// Smallest and largest on-chain certificate, in bytes.
    pub cert_bytes: (u64, u64),
    /// Signers in the smallest and largest certificate.
    pub cert_signers: (usize, usize),
}

/// Measure consensus traffic (see [`TrafficSample`]).
pub fn traffic(n: usize, delay: TimeMs) -> Option<TrafficSample> {
    let stakes = vec![1_000_000u128; n];
    let mut cfg = base_config(7, &stakes, delay);
    for k in 0..6u64 {
        cfg.txs.push((cfg.start + 1_000 + k * 20_000, transfer(k + 1, cfg.params.base_fee)));
    }
    cfg.end_time = cfg.start + 10 * 60 * SECOND;
    let rec = sim::run(&cfg);
    let chain = &rec.nodes.first()?.chain;
    let mut votes: Vec<u64> = rec.stats.traffic.values().map(|t| t.votes).collect();
    let mut props: Vec<u64> = rec.stats.traffic.values().map(|t| t.proposals).collect();
    let mut deliveries: Vec<u64> = rec.stats.traffic.values().map(|t| t.vote_deliveries).collect();
    votes.sort();
    props.sort();
    deliveries.sort();
    let certs: Vec<(u64, usize)> = chain.iter().filter_map(|c| c.block.parent_cert.as_ref()).map(|c| (c.encoded_len(), c.sigs.len())).collect();
    let v = *votes.get(votes.len() / 2)?;
    let p = *props.get(props.len() / 2)?;
    let d = *deliveries.get(deliveries.len() / 2)?;
    Some(TrafficSample {
        n,
        votes: v,
        proposals: p,
        distinct_bytes: v * VOTE_WIRE_BYTES + p * SIG_BYTES,
        deliveries: d,
        delivery_bytes: d * VOTE_WIRE_BYTES,
        cert_bytes: (certs.iter().map(|c| c.0).min()?, certs.iter().map(|c| c.0).max()?),
        cert_signers: (certs.iter().map(|c| c.1).min()?, certs.iter().map(|c| c.1).max()?),
    })
}

/// One idle day at the hourly heartbeat: number of blocks and total on-chain certificate bytes.
pub fn heartbeat_day(n: usize, delay: TimeMs) -> (u64, u64) {
    let stakes = vec![1_000_000u128; n];
    let mut cfg = base_config(3, &stakes, delay);
    cfg.end_time = cfg.start + 25 * HOUR + 30 * 60 * SECOND;
    cfg.hard_end = cfg.end_time + HOUR;
    let rec = sim::run(&cfg);
    let day_end = cfg.start + 24 * HOUR + 60 * SECOND;
    let chain = &rec.nodes[0].chain;
    let in_day: Vec<_> = chain.iter().filter(|c| c.block.header.time_ms <= day_end).collect();
    let bytes: u64 = chain.iter().filter(|c| c.block.header.time_ms <= day_end + HOUR).filter_map(|c| c.block.parent_cert.as_ref()).take(in_day.len()).map(|c| c.encoded_len()).sum();
    (in_day.len() as u64, bytes)
}

/// Certificate completeness under sustained load (deviation D6): `n` equal honest
/// validators, one-way delays uniform in `5..=max_delay` ms, a transaction every
/// 300 ms for 60 s so that each height starts as soon as the commit wait allows.
/// Returns `(blocks, signers listed, signers that could have been listed, fewest in one certificate)`.
pub fn inclusion(n: usize, max_delay: TimeMs, commit_wait: TimeMs) -> (u64, u64, u64, usize) {
    let stakes = vec![1_000_000u128; n];
    let mut cfg = base_config(11, &stakes, max_delay);
    cfg.net.min_delay = 5;
    cfg.timeouts.commit_wait = commit_wait;
    for k in 0..200u64 {
        cfg.txs.push((cfg.start + 1_000 + k * 300, transfer(k + 1, cfg.params.base_fee)));
    }
    cfg.end_time = cfg.start + 10 * 60 * SECOND;
    let rec = sim::run(&cfg);
    let certs: Vec<usize> = rec.nodes[0].chain.iter().filter_map(|c| c.block.parent_cert.as_ref()).map(|c| c.sigs.len()).collect();
    (certs.len() as u64, certs.iter().sum::<usize>() as u64, (certs.len() * n) as u64, certs.iter().copied().min().unwrap_or(0))
}
