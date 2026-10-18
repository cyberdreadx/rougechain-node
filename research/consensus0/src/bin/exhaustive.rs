//! Bounded exhaustive exploration of message and timeout orderings for one height.
//!
//! ```text
//! exhaustive --validators 4 --rounds 2 --byzantine 0 --max-states 20000000 --max-seconds 600
//! ```
//! Exits non-zero if a violation is found. `complete = false` means a limit was
//! hit before the bounded space was exhausted.

use std::process::ExitCode;
use std::time::Instant;

use consensus0::explore::{explore, ExploreConfig};

fn usage() -> ! {
    eprintln!("usage: exhaustive [--validators N] [--rounds R] [--byzantine 0|1] [--order-seed K] [--max-states N] [--max-seconds S]");
    std::process::exit(2)
}

fn main() -> ExitCode {
    let mut cfg = ExploreConfig { validators: 4, stake: 1_000_000, max_rounds: 2, byzantine: 0, order_seed: 0, max_states: 5_000_000, max_seconds: 300 };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let v = argv.get(i + 1).and_then(|s| s.parse::<u64>().ok()).unwrap_or_else(|| usage());
        match argv[i].as_str() {
            "--validators" => cfg.validators = v as usize,
            "--rounds" => cfg.max_rounds = v as u32,
            "--byzantine" => cfg.byzantine = v as usize,
            "--order-seed" => cfg.order_seed = v,
            "--max-states" => cfg.max_states = v,
            "--max-seconds" => cfg.max_seconds = v,
            _ => usage(),
        }
        i += 2;
    }
    if cfg.validators == 0 || cfg.validators > 8 || cfg.byzantine > 1 || cfg.byzantine >= cfg.validators {
        usage();
    }
    let started = Instant::now();
    let res = explore(&cfg);
    let secs = started.elapsed().as_secs_f64();
    println!("exhaustive: {cfg:?}");
    println!("states explored      {}", res.states);
    println!("transitions          {}", res.transitions);
    println!("max depth            {}", res.max_depth);
    println!("fully decided states {}", res.decided_states);
    println!("round-bound states   {}", res.bound_states);
    println!("stuck states         {}", res.stuck_states);
    println!("distinct decisions   {}", res.decided_blocks.len());
    println!("bound reached        {}", if res.complete { "no - the bounded space was explored completely" } else { "YES - a limit stopped the search (or a violation did)" });
    println!("wall time            {secs:.1} s  ({:.0} states/s)", res.states as f64 / secs.max(1e-9));
    match res.violation {
        Some(v) => {
            println!("VIOLATION: {v}");
            ExitCode::FAILURE
        }
        None => {
            println!("violations           none");
            ExitCode::SUCCESS
        }
    }
}
