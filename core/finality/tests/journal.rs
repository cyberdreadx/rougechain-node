//! Durable anti-double-sign journal — restart, crash, concurrency, multi-process, corruption.
use quantum_vault_crypto::{pqc_keygen_from_seed, pqc_verify};
use quantum_vault_finality::journal::*;
use quantum_vault_finality::{vote_signing_message, PRECOMMIT, PREVOTE};
use std::path::PathBuf;

const CHAIN: &str = "rougechain-mainnet-1";
fn h(b: u8) -> String { format!("{:02x}", b).repeat(32) }
fn tmp(tag: &str) -> PathBuf {
    static C: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let p = std::env::temp_dir().join(format!("qv-journal-{tag}-{}-{}-{}", std::process::id(), C.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&p).unwrap(); p
}
fn intent(pk: &str, ty: &str, height: u64, bh: &str) -> VoteIntent { VoteIntent { chain_id: CHAIN.into(), validator_pub_key: pk.into(), vote_type: ty.into(), height, round: 0, block_hash: bh.into() } }
fn slot_files(d: &PathBuf) -> Vec<PathBuf> { let mut v: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().map(|x| x == "vote").unwrap_or(false)).collect(); v.sort(); v }

#[test]
fn first_vote_locks_same_vote_is_idempotent_other_hash_is_refused_forever() {
    let d = tmp("basic"); let j = SigningJournal::open(&d).unwrap(); let k = pqc_keygen_from_seed(&[1; 32]);
    let v = j.sign_vote(&k, CHAIN, PRECOMMIT, 10, 0, &h(0xaa)).unwrap();
    assert!(pqc_verify(&k.public_key_hex, &vote_signing_message(CHAIN, PRECOMMIT, 10, 0, &h(0xaa)), &v.signature).unwrap());
    assert_eq!(j.commit(&intent(&k.public_key_hex, PRECOMMIT, 10, &h(0xaa))), Ok(Commit::AlreadyLocked));
    assert!(j.sign_vote(&k, CHAIN, PRECOMMIT, 10, 0, &h(0xaa)).is_ok(), "re-signing the SAME vote is allowed");
    for _ in 0..3 {
        assert_eq!(j.sign_vote(&k, CHAIN, PRECOMMIT, 10, 0, &h(0xbb)).unwrap_err(), JournalError::Equivocation { locked_block_hash: h(0xaa), requested_block_hash: h(0xbb) });
    }
    // slots are independent per vote type, height, chain and validator
    assert!(j.sign_vote(&k, CHAIN, PREVOTE, 10, 0, &h(0xbb)).is_ok(), "prevote slot is its own slot");
    assert!(j.sign_vote(&k, CHAIN, PRECOMMIT, 11, 0, &h(0xbb)).is_ok());
    assert!(j.sign_vote(&k, "rougechain-testnet-1", PRECOMMIT, 10, 0, &h(0xbb)).is_ok());
    assert!(j.sign_vote(&pqc_keygen_from_seed(&[2; 32]), CHAIN, PRECOMMIT, 10, 0, &h(0xbb)).is_ok());
    assert_eq!(j.locked(CHAIN, &k.public_key_hex, PRECOMMIT, 10, 0).unwrap(), Some(h(0xaa)));
    assert_eq!(j.locked(CHAIN, &k.public_key_hex, PRECOMMIT, 99, 0).unwrap(), None);
    assert_eq!(j.verify_all().unwrap(), 5);
    // malformed requests never reach the disk
    for bad in [intent(&k.public_key_hex, "commit", 1, &h(1)), intent(&k.public_key_hex, PRECOMMIT, 1, "xyz"), intent("", PRECOMMIT, 1, &h(1)), VoteIntent { round: 1, ..intent(&k.public_key_hex, PRECOMMIT, 1, &h(1)) }] {
        assert!(matches!(j.commit(&bad), Err(JournalError::BadRequest(_))));
    }
    assert_eq!(j.verify_all().unwrap(), 5);
}

#[test]
fn restart_preserves_the_lock_and_a_crash_between_journal_and_signature_cannot_be_exploited() {
    let d = tmp("restart"); let k = pqc_keygen_from_seed(&[3; 32]);
    { // process 1: journal written … then it "crashes" before any signature is produced
        let j = SigningJournal::open(&d).unwrap();
        assert_eq!(j.commit(&intent(&k.public_key_hex, PRECOMMIT, 7, &h(0xaa))), Ok(Commit::Locked));
    }
    { // process 2 after restart, now looking at a DIFFERENT block at height 7 (e.g. after a resync)
        let j = SigningJournal::open(&d).unwrap();
        assert!(matches!(j.sign_vote(&k, CHAIN, PRECOMMIT, 7, 0, &h(0xbb)), Err(JournalError::Equivocation { .. })), "the unsigned-but-journaled intent still binds");
        assert!(j.sign_vote(&k, CHAIN, PRECOMMIT, 7, 0, &h(0xaa)).is_ok(), "and the original vote can still be (re)signed");
    }
    for _ in 0..3 { let j = SigningJournal::open(&d).unwrap(); assert!(j.sign_vote(&k, CHAIN, PRECOMMIT, 7, 0, &h(0xcc)).is_err()); }
    // no leftover temp files, exactly one slot
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
}

#[test]
fn concurrent_conflicting_signers_on_one_store_agree_on_exactly_one_block_hash() {
    let d = tmp("race"); let k = pqc_keygen_from_seed(&[4; 32]);
    for height in 1..=4u64 {
        let handles: Vec<_> = (0..24u8).map(|i| { let (d, k) = (d.clone(), k.clone());
            std::thread::spawn(move || { let j = SigningJournal::open(&d).unwrap(); // own instance per "process"
                let bh = h(0xa0 + (i % 3)); j.sign_vote(&k, CHAIN, PRECOMMIT, height, 0, &bh).ok().map(|v| v.block_hash) }) }).collect();
        let signed: Vec<String> = handles.into_iter().filter_map(|t| t.join().unwrap()).collect();
        assert!(!signed.is_empty());
        assert!(signed.iter().all(|x| *x == signed[0]), "height {height}: signatures exist for more than one hash: {signed:?}");
        assert_eq!(SigningJournal::open(&d).unwrap().locked(CHAIN, &k.public_key_hex, PRECOMMIT, height, 0).unwrap(), Some(signed[0].clone()));
    }
    assert_eq!(slot_files(&d).len(), 4);
}

/// Helper "process": does nothing unless invoked by the test below.
#[test]
fn child_signer() {
    let Ok(dir) = std::env::var("QV_JOURNAL_CHILD_DIR") else { return };
    let bh = std::env::var("QV_JOURNAL_CHILD_HASH").unwrap();
    let k = pqc_keygen_from_seed(&[5; 32]);
    let j = SigningJournal::open(&dir).unwrap();
    let mut out = String::new();
    for height in 1..=20u64 { if j.sign_vote(&k, CHAIN, PRECOMMIT, height, 0, &bh).is_ok() { out.push_str(&format!("{height},")); } }
    std::fs::write(PathBuf::from(&dir).join(format!("result-{}.txt", &bh[..2])), out).unwrap();
}
#[test]
fn two_real_os_processes_sharing_one_store_never_both_sign_conflicting_votes() {
    let d = tmp("procs"); let exe = std::env::current_exe().unwrap();
    let kids: Vec<_> = [h(0xaa), h(0xbb)].into_iter().map(|bh| std::process::Command::new(&exe).args(["--exact", "child_signer", "--test-threads=1"])
        .env("QV_JOURNAL_CHILD_DIR", &d).env("QV_JOURNAL_CHILD_HASH", bh).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap()).collect();
    for mut k in kids { assert!(k.wait().unwrap().success()); }
    let read = |p: &str| -> Vec<u64> { std::fs::read_to_string(d.join(p)).unwrap().split(',').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap()).collect() };
    let (a, b) = (read("result-aa.txt"), read("result-bb.txt"));
    for height in 1..=20u64 { assert!(a.contains(&height) ^ b.contains(&height), "height {height}: signed by {} processes", a.contains(&height) as u8 + b.contains(&height) as u8); }
    assert_eq!(SigningJournal::open(&d).unwrap().verify_all().unwrap(), 20);
}

#[test]
fn corrupt_or_foreign_journal_entries_fail_closed() {
    let k = pqc_keygen_from_seed(&[6; 32]);
    let corruptions: Vec<(&str, fn(&PathBuf))> = vec![
        ("truncated", |p| { let b = std::fs::read(p).unwrap(); std::fs::write(p, &b[..b.len() / 2]).unwrap(); }),
        ("empty", |p| std::fs::write(p, b"").unwrap()),
        ("bit flip in the hash", |p| { let mut s = std::fs::read_to_string(p).unwrap(); s = s.replacen("block=aa", "block=bb", 1); std::fs::write(p, s).unwrap(); }),
        ("not utf8", |p| std::fs::write(p, [0xff, 0xfe, 0x00]).unwrap()),
    ];
    for (name, corrupt) in corruptions {
        let d = tmp("corrupt"); let j = SigningJournal::open(&d).unwrap();
        j.sign_vote(&k, CHAIN, PRECOMMIT, 5, 0, &h(0xaa)).unwrap();
        corrupt(&slot_files(&d)[0]);
        for bh in [h(0xaa), h(0xbb)] { assert!(matches!(j.sign_vote(&k, CHAIN, PRECOMMIT, 5, 0, &bh), Err(JournalError::Corrupt(_))), "{name}: refuses to sign ANYTHING for that slot"); }
        assert!(matches!(j.verify_all(), Err(JournalError::Corrupt(_))), "{name}");
        assert!(matches!(j.locked(CHAIN, &k.public_key_hex, PRECOMMIT, 5, 0), Err(JournalError::Corrupt(_))));
        assert!(j.sign_vote(&k, CHAIN, PRECOMMIT, 6, 0, &h(0xaa)).is_ok(), "{name}: other slots are unaffected");
    }
    // a VALID record copied over another slot's file is detected (it belongs to another slot)
    let d = tmp("foreign"); let j = SigningJournal::open(&d).unwrap();
    j.sign_vote(&k, CHAIN, PRECOMMIT, 5, 0, &h(0xaa)).unwrap(); j.sign_vote(&k, CHAIN, PRECOMMIT, 6, 0, &h(0xbb)).unwrap();
    let f = slot_files(&d); std::fs::copy(&f[1], &f[0]).unwrap();
    assert!(matches!(j.sign_vote(&k, CHAIN, PRECOMMIT, 5, 0, &h(0xbb)), Err(JournalError::Corrupt(_))));
    assert!(matches!(j.verify_all(), Err(JournalError::Corrupt(_))));
}

#[test]
fn journal_is_never_pruned_old_heights_stay_locked_after_many_new_votes() {
    let d = tmp("noprune"); let j = SigningJournal::open(&d).unwrap(); let k = pqc_keygen_from_seed(&[7; 32]);
    j.commit(&intent(&k.public_key_hex, PRECOMMIT, 1, &h(0xaa))).unwrap();
    for height in 2..=600u64 { j.commit(&intent(&k.public_key_hex, PRECOMMIT, height, &h(0xcc))).unwrap(); }
    drop(j); let j = SigningJournal::open(&d).unwrap();
    assert!(matches!(j.commit(&intent(&k.public_key_hex, PRECOMMIT, 1, &h(0xbb))), Err(JournalError::Equivocation { .. })));
    assert_eq!(j.verify_all().unwrap(), 600);
}
