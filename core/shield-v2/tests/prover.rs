//! The wallet prover's public behaviour (spec §5.6, open issue O-14), through the crate's public
//! API only. `test-prover` is required for the witness samples; the function under test is the
//! production `prove_spend(witness, public)`.

use quantum_vault_shield_v2::reference::{Kind, sample};
use quantum_vault_shield_v2::{MAX_PROOF_BYTES, ProveError, SpendWitness, prove_spend, verify_spend};

/// Two proofs of the same witness and the same public inputs differ, and both verify (spec
/// §2.9.1: a statement does not have one proof; §5.6: the blinding is fresh per proof).
#[test]
fn two_proofs_of_one_witness_differ_and_both_verify() {
    for (kind, seed) in [(Kind::Shield, 11u64), (Kind::Transfer1, 12)] {
        let js = sample(kind, seed);
        let (w, p) = (SpendWitness::from(&js), js.public());
        let a = prove_spend(&w, &p).expect("prove");
        let b = prove_spend(&w, &p).expect("prove");
        assert!(a.len() <= MAX_PROOF_BYTES && b.len() <= MAX_PROOF_BYTES);
        assert_ne!(a, b, "{kind:?}: the blinding must be fresh for every proof");
        verify_spend(&p, &a).expect("first verifies");
        verify_spend(&p, &b).expect("second verifies");
        // a proof is bound to its public inputs
        let mut q = p.clone();
        q.fee += 1;
        assert!(verify_spend(&q, &a).is_err());
    }
}

/// A witness that does not satisfy the statement gives an error, not a proof and not a panic.
#[test]
fn a_false_witness_gives_an_error() {
    let js = sample(Kind::Unshield2, 13);
    let (mut w, p) = (SpendWitness::from(&js), js.public());
    w.inputs[1].index ^= 1;
    assert!(matches!(prove_spend(&w, &p), Err(ProveError::Witness(_))));
}

/// Compile-time shape of the API (spec §5.6 item 2): the production prover is callable with a
/// witness and public inputs and nothing else.
#[test]
fn the_production_prover_has_no_seed_parameter() {
    let _f: fn(&SpendWitness, &quantum_vault_shield_v2::reference::PublicInputs) -> Result<Vec<u8>, ProveError> =
        prove_spend;
}

/// Source check of the same rule for the whole crate: every `pub fn` whose signature mentions a
/// seed is behind the test configuration — either its own `#[cfg(... "test-prover" ...)]`
/// attribute or a module that `lib.rs` compiles only with `test-prover`.
#[test]
fn no_public_function_takes_a_seed_outside_the_test_configuration() {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let lib = std::fs::read_to_string(format!("{src}/lib.rs")).unwrap();
    let mut seeded = Vec::new();
    for entry in std::fs::read_dir(src).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        let text = std::fs::read_to_string(&path).unwrap();
        // a module that exists only with `test-prover`
        let gated_module = lib.contains(&format!("#[cfg(feature = \"test-prover\")]\npub mod {name};"))
            && !lib.contains(&format!("\nmod {name};"));
        let lines: Vec<&str> = text.lines().collect();
        for (n, line) in lines.iter().enumerate() {
            let t = line.trim_start();
            if !t.starts_with("pub fn ") {
                continue;
            }
            // the signature: up to the opening brace
            let mut sig = String::new();
            for l in &lines[n..] {
                sig.push_str(l);
                if l.contains('{') || l.trim_end().ends_with(';') {
                    break;
                }
            }
            if !sig.to_lowercase().contains("seed") {
                continue;
            }
            // attributes directly above (skipping doc comments)
            let mut gated = gated_module;
            let mut k = n;
            while k > 0 {
                k -= 1;
                let a = lines[k].trim_start();
                if a.starts_with("#[cfg(") && (a.contains("test-prover") || a.contains("cfg(test)")) {
                    gated = true;
                }
                if !(a.starts_with("#[") || a.starts_with("///")) {
                    break;
                }
            }
            seeded.push((format!("{name}.rs:{}", n + 1), gated));
        }
    }
    assert!(
        seeded.iter().any(|(at, _)| at.starts_with("verifier.rs")),
        "the scan must find the test-only seeded prover, or it checks nothing: {seeded:?}"
    );
    for (at, gated) in &seeded {
        assert!(gated, "{at}: a public function takes a seed outside the test configuration");
    }
}

/// Measurement, not a test (`--ignored --nocapture`): wall time of single proofs in this process.
/// Peak memory is read from outside (`/usr/bin/time -v` on this test binary). See
/// `core/shield-v2-wallet/NOTES.md`.
#[test]
#[ignore = "measurement"]
fn measure_proving_time() {
    let js = sample(Kind::Transfer, 99);
    let (w, p) = (SpendWitness::from(&js), js.public());
    let runs: usize = std::env::var("SHIELD_V2_MEASURE_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    for i in 0..runs {
        let t = std::time::Instant::now();
        let proof = prove_spend(&w, &p).expect("prove");
        let prove_ms = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        verify_spend(&p, &proof).expect("verify");
        println!(
            "measure: run {i}: prove_spend {prove_ms:.0} ms (statement check, seed, trace, proof, self-verify), {} bytes; verify_spend {:.1} ms",
            proof.len(),
            t.elapsed().as_secs_f64() * 1e3
        );
    }
}
