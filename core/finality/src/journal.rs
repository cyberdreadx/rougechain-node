//! Durable anti-double-sign journal (Track A Step 2.3).
//!
//! `VoteBook` only deduplicates in memory. BFT safety needs a validator to NEVER sign two
//! different block hashes for one `(chain, validator, vote type, height, round)` — across
//! restarts, crashes, and even two processes started with the same key and data directory.
//!
//! Design: one immutable file per signing slot, created with an atomic, exclusive
//! `hard_link(tmp → slot)`. `link(2)` fails with `EEXIST` if the slot exists, atomically, on the
//! same filesystem, for any number of processes — no lock file, no single-process database.
//! The record is fully written and fsynced to the tmp file BEFORE the link, so a slot file is
//! always complete; the directory is fsynced after the link, so the slot survives power loss
//! before any signature exists. The signature itself is never stored: ML-DSA signing is
//! randomized and re-signing the SAME message is harmless, so "journal written, crashed before
//! signing" simply re-signs the same block hash after restart — and can never sign another.
//!
//! There is NO prune/delete API. Entries are ~200 bytes; a validator that signs 2 votes per
//! block needs ~400 bytes per block, forever. Safety is not traded for disk.
//!
//! Out of scope (cannot be solved locally): the same key on two machines with different disks.
use quantum_vault_crypto::pqc_sign;
use quantum_vault_types::{PQKeypair, VoteMessage};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAGIC: &str = "QVJ1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    Io(String),
    /// the slot is permanently locked to another block hash — signing is refused forever
    Equivocation { locked_block_hash: String, requested_block_hash: String },
    /// unreadable / checksum-failing / mismatching slot: refuse to sign (fail closed)
    Corrupt(String),
    BadRequest(&'static str),
    Sign(String),
}

/// The identity of an intended vote — exactly what the signed message commits to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoteIntent { pub chain_id: String, pub validator_pub_key: String, pub vote_type: String, pub height: u64, pub round: u32, pub block_hash: String }

impl VoteIntent {
    fn validate(&self) -> Result<(), JournalError> {
        if self.vote_type != crate::PREVOTE && self.vote_type != crate::PRECOMMIT { return Err(JournalError::BadRequest("vote type")); }
        if self.round != crate::ONLY_ROUND { return Err(JournalError::BadRequest("round")); }
        if self.block_hash.len() != 64 || !self.block_hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(JournalError::BadRequest("block hash")); }
        if self.chain_id.is_empty() || self.chain_id.contains(['\n', '|']) { return Err(JournalError::BadRequest("chain id")); }
        if self.validator_pub_key.is_empty() || !self.validator_pub_key.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(JournalError::BadRequest("validator key")); }
        Ok(())
    }
    /// slot = everything EXCEPT the block hash
    fn slot_id(&self) -> String {
        let mut h = Sha256::new();
        h.update(format!("{MAGIC}|{}|{}|{}|{}|{}", self.chain_id, self.validator_pub_key, self.vote_type, self.height, self.round));
        hex::encode(h.finalize())
    }
    fn slot_name(&self) -> String { format!("{:020}-{}-{}.vote", self.height, self.vote_type, &self.slot_id()[..32]) }
    fn record(&self) -> String {
        let body = format!("{MAGIC}\nchain={}\nvalidator={}\ntype={}\nheight={}\nround={}\nblock={}\n", self.chain_id, self.validator_pub_key, self.vote_type, self.height, self.round, self.block_hash);
        let sum = hex::encode(Sha256::digest(body.as_bytes()));
        format!("{body}sha256={sum}\n")
    }
    fn parse(text: &str) -> Option<VoteIntent> {
        let (body, tail) = text.split_at(text.rfind("sha256=")?);
        let sum = tail.strip_prefix("sha256=")?.strip_suffix('\n')?;
        if hex::encode(Sha256::digest(body.as_bytes())) != sum { return None; }
        let mut l = body.lines();
        if l.next()? != MAGIC { return None; }
        let mut f = |k: &str| -> Option<String> { l.next()?.strip_prefix(k)?.strip_prefix('=').map(|s| s.to_string()) };
        let i = VoteIntent { chain_id: f("chain")?, validator_pub_key: f("validator")?, vote_type: f("type")?, height: f("height")?.parse().ok()?, round: f("round")?.parse().ok()?, block_hash: f("block")? };
        if l.next().is_some() { return None; }
        Some(i)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Commit { /// first time this slot was used — now durably locked to this block hash
    Locked, /// the identical intent was already journaled (restart / retry)
    AlreadyLocked }

pub struct SigningJournal { dir: PathBuf }

impl SigningJournal {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, JournalError> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(|e| JournalError::Io(e.to_string()))?;
        Ok(Self { dir })
    }
    pub fn dir(&self) -> &Path { &self.dir }

    fn read_slot(&self, path: &Path, want: &VoteIntent) -> Result<VoteIntent, JournalError> {
        let mut text = String::new();
        File::open(path).and_then(|mut f| f.read_to_string(&mut text)).map_err(|e| JournalError::Corrupt(format!("{}: {e}", path.display())))?;
        let got = VoteIntent::parse(&text).ok_or_else(|| JournalError::Corrupt(format!("{}: bad record or checksum", path.display())))?;
        // the slot must really be THIS slot (guards against a renamed/copied file)
        if got.slot_id() != want.slot_id() { return Err(JournalError::Corrupt(format!("{}: record belongs to another slot", path.display()))); }
        Ok(got)
    }

    /// Durably lock the slot to `intent.block_hash`. MUST succeed before any signature exists.
    pub fn commit(&self, intent: &VoteIntent) -> Result<Commit, JournalError> {
        intent.validate()?;
        let slot = self.dir.join(intent.slot_name());
        let check_existing = |this: &Self| -> Result<Commit, JournalError> {
            let got = this.read_slot(&slot, intent)?;
            if got.block_hash == intent.block_hash { Ok(Commit::AlreadyLocked) }
            else { Err(JournalError::Equivocation { locked_block_hash: got.block_hash, requested_block_hash: intent.block_hash.clone() }) }
        };
        if slot.exists() { return check_existing(self); }
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = self.dir.join(format!(".tmp-{}-{}-{}", std::process::id(), CTR.fetch_add(1, std::sync::atomic::Ordering::SeqCst), &intent.slot_id()[..16]));
        let io = |e: std::io::Error| JournalError::Io(e.to_string());
        {
            let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io)?;
            f.write_all(intent.record().as_bytes()).map_err(io)?;
            f.sync_all().map_err(io)?; // complete + durable BEFORE it can become the slot
        }
        let linked = fs::hard_link(&tmp, &slot); // atomic; EEXIST if any process won the race
        let _ = fs::remove_file(&tmp);
        match linked {
            Ok(()) => { File::open(&self.dir).and_then(|d| d.sync_all()).map_err(io)?; Ok(Commit::Locked) }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check_existing(self),
            Err(e) => Err(io(e)),
        }
    }

    /// The ONLY way a FINALITY_V2 vote may be signed: journal first, sign second.
    pub fn sign_vote(&self, keys: &PQKeypair, chain_id: &str, vote_type: &str, height: u64, round: u32, block_hash: &str) -> Result<VoteMessage, JournalError> {
        let intent = VoteIntent { chain_id: chain_id.into(), validator_pub_key: keys.public_key_hex.clone(), vote_type: vote_type.into(), height, round, block_hash: block_hash.into() };
        self.commit(&intent)?;
        let msg = crate::vote_signing_message(chain_id, vote_type, height, round, block_hash);
        let signature = pqc_sign(&keys.secret_key_hex, &msg).map_err(JournalError::Sign)?;
        Ok(VoteMessage { vote_type: vote_type.into(), height, round, block_hash: block_hash.into(), voter_pub_key: keys.public_key_hex.clone(), signature })
    }

    /// What (if anything) this validator is locked to for a slot. Read-only.
    pub fn locked(&self, chain_id: &str, validator_pub_key: &str, vote_type: &str, height: u64, round: u32) -> Result<Option<String>, JournalError> {
        let probe = VoteIntent { chain_id: chain_id.into(), validator_pub_key: validator_pub_key.into(), vote_type: vote_type.into(), height, round, block_hash: "0".repeat(64) };
        let slot = self.dir.join(probe.slot_name());
        if !slot.exists() { return Ok(None); }
        Ok(Some(self.read_slot(&slot, &probe)?.block_hash))
    }

    /// Read-only integrity scan of every slot. Any unreadable slot ⇒ `Err` (fail closed).
    pub fn verify_all(&self) -> Result<usize, JournalError> {
        let mut n = 0;
        for e in fs::read_dir(&self.dir).map_err(|e| JournalError::Io(e.to_string()))? {
            let p = e.map_err(|e| JournalError::Io(e.to_string()))?.path();
            if p.extension().and_then(|x| x.to_str()) != Some("vote") { continue; }
            let mut text = String::new();
            File::open(&p).and_then(|mut f| f.read_to_string(&mut text)).map_err(|e| JournalError::Corrupt(format!("{}: {e}", p.display())))?;
            let i = VoteIntent::parse(&text).ok_or_else(|| JournalError::Corrupt(format!("{}: bad record or checksum", p.display())))?;
            if p.file_name().and_then(|x| x.to_str()) != Some(i.slot_name().as_str()) { return Err(JournalError::Corrupt(format!("{}: name does not match record", p.display()))); }
            n += 1;
        }
        Ok(n)
    }
}
