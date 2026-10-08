//! Seeded campaign: run many scenarios, check P1–P10 on each, print a summary.
//! Exits non-zero on the first violation, after printing the seed and a trace.
//!
//! ```text
//! campaign --seeds 0..1000 --validators 10 --stake-profile random --faults all --max-seconds 300
//! campaign --measure
//! ```

use std::process::ExitCode;
use std::time::Instant;

use consensus0::campaign::{self, FaultKind, Options, Profile, Summary};
use consensus0::machine::Timeouts;
use consensus0::props::{CheckOpts, ALL};
use consensus0::sim;
use consensus0::types::{cert_len, VOTE_WIRE_BYTES};

struct Args {
    seeds: (u64, u64),
    opts: Options,
    max_seconds: u64,
    measure: bool,
    keep_going: bool,
    amnesia_is_fault: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: campaign --seeds A..B [--validators N] [--stake-profile today|equal4|plan5|50-30-20|random]\n\
         \x20                [--faults all|none|crash,restart,restart-nostate,equivocate,doublevote,coalition,nil,withhold,stall,chaos,partition]\n\
         \x20                [--max-seconds S] [--long-every K] [--replay-every K] [--fault-bound NUM/DEN]\n\
         \x20                [--keep-going] [--amnesia-not-a-fault]\n\
         \x20      campaign --measure"
    );
    std::process::exit(2)
}

fn parse() -> Args {
    let mut a = Args {
        seeds: (0, 100),
        opts: Options { validators: 4, profile: Profile::Equal4, faults: FaultKind::ALL.to_vec(), fault_bound: None, long_every: 16, replay_every: 10 },
        max_seconds: 600,
        measure: false,
        keep_going: false,
        amnesia_is_fault: true,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    let value = |i: &mut usize| -> String {
        *i += 1;
        argv.get(*i).cloned().unwrap_or_else(|| usage())
    };
    while i < argv.len() {
        match argv[i].as_str() {
            "--seeds" => {
                let v = value(&mut i);
                let (lo, hi) = v.split_once("..").unwrap_or_else(|| usage());
                a.seeds = (lo.parse().unwrap_or_else(|_| usage()), hi.parse().unwrap_or_else(|_| usage()));
            }
            "--validators" => a.opts.validators = value(&mut i).parse().unwrap_or_else(|_| usage()),
            "--stake-profile" => a.opts.profile = Profile::parse(&value(&mut i)).unwrap_or_else(|| usage()),
            "--faults" => a.opts.faults = FaultKind::parse_list(&value(&mut i)).unwrap_or_else(|| usage()),
            "--max-seconds" => a.max_seconds = value(&mut i).parse().unwrap_or_else(|_| usage()),
            "--long-every" => a.opts.long_every = value(&mut i).parse().unwrap_or_else(|_| usage()),
            "--replay-every" => a.opts.replay_every = value(&mut i).parse().unwrap_or_else(|_| usage()),
            "--fault-bound" => {
                let v = value(&mut i);
                let (n, d) = v.split_once('/').unwrap_or_else(|| usage());
                a.opts.fault_bound = Some((n.parse().unwrap_or_else(|_| usage()), d.parse().unwrap_or_else(|_| usage())));
            }
            "--measure" => a.measure = true,
            "--keep-going" => a.keep_going = true,
            "--amnesia-not-a-fault" => a.amnesia_is_fault = false,
            _ => usage(),
        }
        i += 1;
    }
    if a.opts.validators == 0 || a.opts.validators > 64 {
        usage();
    }
    a
}

fn print_summary(s: &Summary, elapsed: f64) {
    println!("seeds run            {}", s.seeds);
    println!("heights committed    {}", s.heights);
    println!("node inputs          {}  ({:.0} inputs/s, {:.2} schedules/s)", s.inputs, s.inputs as f64 / elapsed.max(1e-9), s.seeds as f64 / elapsed.max(1e-9));
    println!("wall time            {elapsed:.1} s");
    println!("behaviours assigned  {:?}", s.behaviours);
    println!("forks / slashes / jailings / not-quiescent   {} / {} / {} / {}", s.forks, s.slashes, s.jailings, s.not_quiescent);
    let total: u64 = s.rounds.values().sum();
    print!("commit round histogram:");
    for (r, c) in &s.rounds {
        print!("  r{r}={c} ({:.2}%)", 100.0 * *c as f64 / total.max(1) as f64);
    }
    println!();
    println!("fairness worst error {:.4} slots", s.fairness_worst.0 as f64 / s.fairness_worst.1.max(1) as f64);
    println!("property  applicable-runs  violations");
    for p in ALL {
        println!("  {:<4}    {:>10}     {:>6}", format!("{p:?}"), s.applicable.get(&p).copied().unwrap_or(0), s.violations.get(&p).copied().unwrap_or(0));
    }
    for (seed, text) in &s.examples {
        println!("  violation in seed {seed}: {text}");
    }
}

fn measure() {
    println!("== time to finality, moderate timeouts (10 equal validators; ms from submission; first / last commit; commit round) ==");
    println!("{:>8} {:>22} {:>22} {:>22} {:>22}", "delay", "normal", "1 absent proposer", "2 absent", "3 absent");
    for delay in [50u64, 200, 1_000, 3_000] {
        print!("{:>6}ms", delay);
        for absent in 0..=3 {
            match campaign::finality_time(10, delay, absent, Timeouts::MODERATE) {
                Some((first, last, round)) => print!(" {:>8} /{:>8} r{round}", first, last),
                None => print!(" {:>22}", "no commit"),
            }
        }
        println!();
    }
    for (name, t) in [("fast", Timeouts::FAST), ("slow", Timeouts::SLOW)] {
        print!("{name:>8}");
        for absent in 0..=3 {
            match campaign::finality_time(10, 200, absent, t) {
                Some((first, last, round)) => print!(" {:>8} /{:>8} r{round}", first, last),
                None => print!(" {:>22}", "no commit"),
            }
        }
        println!("   (200 ms delay)");
    }
    println!();
    println!("== consensus traffic per block (equal honest validators, 50 ms delay) ==");
    println!("{:>3} {:>6} {:>5} {:>14} {:>11} {:>15} {:>22} {:>14}", "n", "votes", "props", "distinct bytes", "deliveries", "delivery bytes", "cert bytes min..max", "cert all-sign");
    for n in [4usize, 10, 30] {
        if let Some(t) = campaign::traffic(n, 50) {
            println!(
                "{:>3} {:>6} {:>5} {:>14} {:>11} {:>15} {:>10}..{:<10} {:>14}   signers {}..{}",
                t.n,
                t.votes,
                t.proposals,
                t.distinct_bytes,
                t.deliveries,
                t.delivery_bytes,
                t.cert_bytes.0,
                t.cert_bytes.1,
                cert_len(n as u64, n as u64),
                t.cert_signers.0,
                t.cert_signers.1
            );
        }
    }
    println!("bytes per vote on the wire: {VOTE_WIRE_BYTES}");
    println!();
    println!("== certificate completeness under sustained load (10 validators, delays uniform in 5..max ms) ==");
    println!("{:>9} {:>12} {:>8} {:>18} {:>10}", "max delay", "commit wait", "blocks", "signers listed", "fewest");
    for (delay, wait) in [(50u64, 500u64), (200, 500), (400, 500), (1_000, 500), (3_000, 500), (1_000, 0), (1_000, 2_000)] {
        let (blocks, listed, possible, fewest) = campaign::inclusion(10, delay, wait);
        println!("{delay:>7}ms {wait:>10}ms {blocks:>8} {:>10} /{:>6} {fewest:>7}/10   ({:.1} %)", listed, possible, 100.0 * listed as f64 / possible.max(1) as f64);
    }
    println!();
    println!("== one idle day at the hourly heartbeat ==");
    for n in [4usize, 10, 30] {
        let (blocks, bytes) = campaign::heartbeat_day(n, 50);
        println!("n={n:<3} heartbeat blocks {blocks:>3}   certificate bytes {bytes:>10}  ({:.2} MB; 24 x all-signer certificate = {})", bytes as f64 / 1e6, 24 * cert_len(n as u64, n as u64));
    }
}

fn main() -> ExitCode {
    let args = parse();
    if args.measure {
        measure();
        return ExitCode::SUCCESS;
    }
    let check = CheckOpts { amnesia_is_fault: args.amnesia_is_fault, round_bound: None };
    let started = Instant::now();
    let mut summary = Summary::default();
    println!("campaign: seeds {}..{} validators {} profile {:?} faults {:?} bound {:?}", args.seeds.0, args.seeds.1, args.opts.validators, args.opts.profile, args.opts.faults, args.opts.fault_bound);
    let mut failed = false;
    for seed in args.seeds.0..args.seeds.1 {
        if started.elapsed().as_secs() >= args.max_seconds {
            println!("time budget reached after seed {}", seed.saturating_sub(1));
            break;
        }
        let (rec, rep) = campaign::run_seed(seed, &args.opts, &check);
        summary.add(&rec, &rep);
        if !rep.ok() {
            failed = true;
            println!("\nVIOLATION in seed {seed}");
            for v in &rep.violations {
                println!("  {:?} height {:?}: {}", v.property, v.height, v.detail);
            }
            println!("  stakes {:?}", rec.cfg.stakes);
            println!("  behaviours {:?}", rec.cfg.behaviours);
            println!("  network {:?}", rec.cfg.net);
            // Deterministic re-run with tracing; print the lines about the offending height.
            let mut cfg = rec.cfg.clone();
            cfg.trace = true;
            let traced = sim::run(&cfg);
            let needle = rep.violations.first().and_then(|v| v.height).map(|h| format!(" h{h} "));
            let lines: Vec<&String> = traced.trace.iter().filter(|l| needle.as_ref().is_none_or(|n| l.contains(n.as_str()) || l.contains("CRASH") || l.contains("RESTART"))).collect();
            println!("  trace ({} lines, last 200 shown):", lines.len());
            for l in lines.iter().rev().take(200).rev() {
                println!("    {l}");
            }
            if !args.keep_going {
                break;
            }
        }
    }
    println!();
    print_summary(&summary, started.elapsed().as_secs_f64());
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
