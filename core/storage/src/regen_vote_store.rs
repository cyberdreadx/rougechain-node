//! RougeChain Regenerate — community votes (interim, node-hosted governance).
//!
//! Proposals to fund Regenerate projects are voted on by XRGE holders with signed
//! requests. This is NOT consensus state: it lives in its own sled DB next to the
//! messenger/social stores and never touches blocks. On-chain governance replaces it
//! later; until then every vote is stored with its signature so anyone can recount.
//!
//! Fairness rules (all fixed per proposal at creation, so they can't be changed mid-vote):
//! * **Snapshot** — each eligible wallet's XRGE balance is recorded when the proposal
//!   opens. Weight comes from the snapshot, so moving coins mid-vote can't double-count.
//! * **Exclusions** — team / treasury / exchange wallets are left out of the snapshot.
//! * **Cap** — no wallet weighs more than `cap_bps` of the eligible total.
//! * **Passing** — turnout (yes + no + abstain weight) must reach `turnout_bps` of the
//!   eligible total, and yes must beat no.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// u128 quanta travel as decimal strings so JavaScript never loses precision.
mod u128_str {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<u128>().map_err(serde::de::Error::custom)
    }
}

pub const QUANTA_PER_XRGE: u128 = 1_000_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegenProposal {
    pub id: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub territory: Option<String>,
    /// rouge1 address that receives the grant if the proposal passes.
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default)]
    pub requested_xrge: Option<f64>,
    /// Canonical rouge1 address of the creator.
    pub creator: String,
    pub created_at_ms: i64,
    pub starts_at_ms: i64,
    pub ends_at_ms: i64,
    pub snapshot_height: u64,
    #[serde(with = "u128_str")]
    pub eligible_total_quanta: u128,
    #[serde(with = "u128_str")]
    pub cap_quanta: u128,
    #[serde(with = "u128_str")]
    pub turnout_quanta: u128,
    pub cap_bps: u32,
    pub turnout_bps: u32,
    /// Wallets excluded from this proposal's snapshot (canonical rouge1).
    pub excluded: Vec<String>,
    pub eligible_voters: u64,
    #[serde(default)]
    pub payout_tx_id: Option<String>,
    #[serde(default)]
    pub payout_xrge: Option<f64>,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub cancel_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Yes,
    No,
    Abstain,
}

impl Choice {
    pub fn parse(s: &str) -> Option<Choice> {
        match s.trim().to_ascii_lowercase().as_str() {
            "yes" | "for" => Some(Choice::Yes),
            "no" | "against" => Some(Choice::No),
            "abstain" => Some(Choice::Abstain),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegenVote {
    pub proposal_id: String,
    /// Canonical rouge1 address of the voter.
    pub voter: String,
    /// Signing public key that signed the vote (hex).
    pub public_key: String,
    pub choice: Choice,
    #[serde(with = "u128_str")]
    pub weight_quanta: u128,
    pub cast_at_ms: i64,
    /// Exact signed payload JSON and its ML-DSA-65 signature, for independent recount.
    pub signed_payload: String,
    pub signature: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    #[serde(with = "u128_str")]
    pub yes: u128,
    #[serde(with = "u128_str")]
    pub no: u128,
    #[serde(with = "u128_str")]
    pub abstain: u128,
    #[serde(with = "u128_str")]
    pub turnout: u128,
    pub voters: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Passed,
    Failed,
    Paid,
    Cancelled,
}

/// Snapshot of voting weights: eligible wallet -> capped weight (quanta).
pub struct Snapshot {
    pub weights: BTreeMap<String, u128>,
    pub eligible_total: u128,
    pub cap: u128,
    pub turnout_needed: u128,
}

/// Build the weight snapshot from raw balances. Only `is_wallet(addr)` entries count
/// (protocol sentinels such as `__treasury__` or the burn address are skipped), minus
/// the excluded set; each weight is capped at `cap_bps` of the eligible total.
pub fn build_snapshot<'a, I, F>(
    balances: I,
    excluded: &HashSet<String>,
    cap_bps: u32,
    turnout_bps: u32,
    is_wallet: F,
) -> Snapshot
where
    I: IntoIterator<Item = (&'a String, &'a u128)>,
    F: Fn(&str) -> bool,
{
    let mut raw: BTreeMap<String, u128> = BTreeMap::new();
    for (addr, bal) in balances {
        if *bal == 0 || excluded.contains(addr) || !is_wallet(addr) {
            continue;
        }
        raw.insert(addr.clone(), *bal);
    }
    let eligible_total: u128 = raw.values().sum();
    let cap = eligible_total.saturating_mul(cap_bps as u128) / 10_000;
    let turnout_needed = eligible_total.saturating_mul(turnout_bps as u128) / 10_000;
    let weights = raw.into_iter().map(|(a, b)| (a, b.min(cap))).filter(|(_, w)| *w > 0).collect();
    Snapshot { weights, eligible_total, cap, turnout_needed }
}

pub fn tally(votes: &[RegenVote]) -> Tally {
    let mut t = Tally::default();
    for v in votes {
        match v.choice {
            Choice::Yes => t.yes += v.weight_quanta,
            Choice::No => t.no += v.weight_quanta,
            Choice::Abstain => t.abstain += v.weight_quanta,
        }
        t.turnout += v.weight_quanta;
        t.voters += 1;
    }
    t
}

/// Outcome at `now_ms`. Before the end the proposal is Open; afterwards it passes only
/// if turnout reached the threshold and yes > no.
pub fn status(p: &RegenProposal, t: &Tally, now_ms: i64) -> Status {
    if p.cancelled {
        return Status::Cancelled;
    }
    if now_ms < p.ends_at_ms {
        return Status::Open;
    }
    let passed = t.turnout >= p.turnout_quanta && t.turnout > 0 && t.yes > t.no;
    match (passed, p.payout_tx_id.is_some()) {
        (true, true) => Status::Paid,
        (true, false) => Status::Passed,
        _ => Status::Failed,
    }
}

#[derive(Clone)]
pub struct RegenVoteStore {
    proposals: sled::Tree,
    weights: sled::Tree,
    votes: sled::Tree,
    meta: sled::Tree,
}

fn key(id: &str, addr: &str) -> Vec<u8> {
    format!("{}\u{0}{}", id, addr).into_bytes()
}

fn prefix(id: &str) -> Vec<u8> {
    format!("{}\u{0}", id).into_bytes()
}

impl RegenVoteStore {
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        let db = sled::open(data_dir.join("regen-vote-db")).map_err(|e| format!("open regen-vote DB: {}", e))?;
        let t = |n: &str| db.open_tree(n).map_err(|e| format!("open {} tree: {}", n, e));
        Ok(Self { proposals: t("proposals")?, weights: t("weights")?, votes: t("votes")?, meta: t("meta")? })
    }

    /// Next human-readable proposal id: RP-1, RP-2, …
    fn next_id(&self) -> Result<String, String> {
        let n = self
            .meta
            .update_and_fetch(b"seq", |old| {
                let cur = old.map(|b| u64::from_be_bytes(b.try_into().unwrap_or([0; 8]))).unwrap_or(0);
                Some((cur + 1).to_be_bytes().to_vec())
            })
            .map_err(|e| format!("seq: {}", e))?
            .ok_or("seq missing")?;
        Ok(format!("RP-{}", u64::from_be_bytes(n.as_ref().try_into().map_err(|_| "seq")?)))
    }

    /// Store a new proposal with its weight snapshot. `id` in `p` is assigned here.
    pub fn create(&self, mut p: RegenProposal, snap: &Snapshot) -> Result<RegenProposal, String> {
        p.id = self.next_id()?;
        p.eligible_total_quanta = snap.eligible_total;
        p.cap_quanta = snap.cap;
        p.turnout_quanta = snap.turnout_needed;
        p.eligible_voters = snap.weights.len() as u64;
        let mut batch = sled::Batch::default();
        for (addr, w) in &snap.weights {
            batch.insert(key(&p.id, addr), w.to_be_bytes().to_vec());
        }
        self.weights.apply_batch(batch).map_err(|e| format!("snapshot: {}", e))?;
        self.put(&p)?;
        Ok(p)
    }

    fn put(&self, p: &RegenProposal) -> Result<(), String> {
        let v = serde_json::to_vec(p).map_err(|e| format!("serialize: {}", e))?;
        self.proposals.insert(p.id.as_bytes(), v).map_err(|e| format!("insert: {}", e))?;
        self.proposals.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<RegenProposal>, String> {
        match self.proposals.get(id.as_bytes()).map_err(|e| format!("get: {}", e))? {
            Some(v) => serde_json::from_slice(&v).map(Some).map_err(|e| format!("deserialize: {}", e)),
            None => Ok(None),
        }
    }

    /// All proposals, newest first.
    pub fn list(&self) -> Result<Vec<RegenProposal>, String> {
        let mut out: Vec<RegenProposal> = Vec::new();
        for item in self.proposals.iter() {
            let (_, v) = item.map_err(|e| format!("iter: {}", e))?;
            out.push(serde_json::from_slice(&v).map_err(|e| format!("deserialize: {}", e))?);
        }
        out.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
        Ok(out)
    }

    /// Snapshot weight of `addr` for proposal `id` (0 if not eligible).
    pub fn weight_of(&self, id: &str, addr: &str) -> Result<u128, String> {
        Ok(self
            .weights
            .get(key(id, addr))
            .map_err(|e| format!("weight: {}", e))?
            .and_then(|b| <[u8; 16]>::try_from(b.as_ref()).ok())
            .map(u128::from_be_bytes)
            .unwrap_or(0))
    }

    /// Record (or replace) a wallet's vote. One vote per wallet per proposal; the latest wins.
    pub fn cast(&self, v: &RegenVote) -> Result<(), String> {
        let bytes = serde_json::to_vec(v).map_err(|e| format!("serialize: {}", e))?;
        self.votes.insert(key(&v.proposal_id, &v.voter), bytes).map_err(|e| format!("vote: {}", e))?;
        self.votes.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    pub fn votes(&self, id: &str) -> Result<Vec<RegenVote>, String> {
        let mut out = Vec::new();
        for item in self.votes.scan_prefix(prefix(id)) {
            let (_, v) = item.map_err(|e| format!("iter: {}", e))?;
            out.push(serde_json::from_slice(&v).map_err(|e| format!("deserialize: {}", e))?);
        }
        Ok(out)
    }

    pub fn set_payout(&self, id: &str, tx_id: &str, xrge: f64) -> Result<RegenProposal, String> {
        let mut p = self.get(id)?.ok_or("proposal not found")?;
        p.payout_tx_id = Some(tx_id.to_string());
        p.payout_xrge = Some(xrge);
        self.put(&p)?;
        Ok(p)
    }

    pub fn cancel(&self, id: &str, reason: &str) -> Result<RegenProposal, String> {
        let mut p = self.get(id)?.ok_or("proposal not found")?;
        p.cancelled = true;
        p.cancel_reason = Some(reason.to_string());
        self.put(&p)?;
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q: u128 = QUANTA_PER_XRGE;

    fn wallet(a: &str) -> bool {
        a.starts_with("rouge1")
    }

    fn bal(pairs: &[(&str, u128)]) -> Vec<(String, u128)> {
        pairs.iter().map(|(a, b)| (a.to_string(), *b)).collect()
    }

    fn proposal(snap: &Snapshot, ends: i64) -> RegenProposal {
        RegenProposal {
            id: String::new(),
            title: "t".into(),
            summary: "s".into(),
            link: None,
            territory: None,
            recipient: None,
            requested_xrge: None,
            creator: "rouge1c".into(),
            created_at_ms: 0,
            starts_at_ms: 0,
            ends_at_ms: ends,
            snapshot_height: 1,
            eligible_total_quanta: snap.eligible_total,
            cap_quanta: snap.cap,
            turnout_quanta: snap.turnout_needed,
            cap_bps: 500,
            turnout_bps: 1000,
            excluded: vec![],
            eligible_voters: snap.weights.len() as u64,
            payout_tx_id: None,
            payout_xrge: None,
            cancelled: false,
            cancel_reason: None,
        }
    }

    fn vote(id: &str, voter: &str, c: Choice, w: u128) -> RegenVote {
        RegenVote {
            proposal_id: id.into(),
            voter: voter.into(),
            public_key: "pk".into(),
            choice: c,
            weight_quanta: w,
            cast_at_ms: 1,
            signed_payload: "{}".into(),
            signature: "sig".into(),
        }
    }

    #[test]
    fn snapshot_skips_sentinels_excluded_and_empty_and_caps_whales() {
        let b = bal(&[
            ("rouge1whale", 900 * Q),
            ("rouge1a", 50 * Q),
            ("rouge1b", 50 * Q),
            ("rouge1team", 5_000 * Q),
            ("__treasury__", 1_000 * Q),
            ("rouge1zero", 0),
        ]);
        let excluded: HashSet<String> = ["rouge1team".to_string()].into();
        let s = build_snapshot(b.iter().map(|(a, v)| (a, v)), &excluded, 500, 1000, wallet);
        assert_eq!(s.eligible_total, 1_000 * Q, "team, sentinel and empty wallets are not eligible");
        assert_eq!(s.cap, 50 * Q, "5% of 1,000");
        assert_eq!(s.turnout_needed, 100 * Q, "10% of 1,000");
        assert_eq!(s.weights.get("rouge1whale"), Some(&(50 * Q)), "whale capped at 5%");
        assert_eq!(s.weights.get("rouge1a"), Some(&(50 * Q)));
        assert!(!s.weights.contains_key("rouge1team"));
        assert!(!s.weights.contains_key("__treasury__"));
        assert!(!s.weights.contains_key("rouge1zero"));
    }

    #[test]
    fn outcome_needs_turnout_and_majority_and_respects_the_clock() {
        let b = bal(&[("rouge1a", 60 * Q), ("rouge1b", 60 * Q), ("rouge1c", 880 * Q)]);
        let s = build_snapshot(b.iter().map(|(a, v)| (a, v)), &HashSet::new(), 10_000, 1000, wallet);
        let p = proposal(&s, 100);
        // Open before the end, whatever the tally.
        assert_eq!(status(&p, &tally(&[vote("x", "rouge1a", Choice::Yes, 60 * Q)]), 99), Status::Open);
        // 60 of 1,000 = 6% turnout < 10% -> fails even though unanimous.
        assert_eq!(status(&p, &tally(&[vote("x", "rouge1a", Choice::Yes, 60 * Q)]), 100), Status::Failed);
        // 120 turnout (12%), yes 60 vs no 60 -> tie fails.
        let tie = [vote("x", "rouge1a", Choice::Yes, 60 * Q), vote("x", "rouge1b", Choice::No, 60 * Q)];
        assert_eq!(status(&p, &tally(&tie), 100), Status::Failed);
        // Abstain counts toward turnout but not the majority.
        let pass = [vote("x", "rouge1a", Choice::Yes, 60 * Q), vote("x", "rouge1b", Choice::Abstain, 60 * Q)];
        assert_eq!(status(&p, &tally(&pass), 100), Status::Passed);
        let mut paid = p.clone();
        paid.payout_tx_id = Some("tx".into());
        assert_eq!(status(&paid, &tally(&pass), 100), Status::Paid);
        let mut c = p.clone();
        c.cancelled = true;
        assert_eq!(status(&c, &tally(&pass), 100), Status::Cancelled);
    }

    #[test]
    fn store_roundtrip_ids_weights_and_revotes() {
        let dir = std::env::temp_dir().join(format!("regen-vote-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = RegenVoteStore::new(&dir).unwrap();
        let b = bal(&[("rouge1a", 10 * Q), ("rouge1b", 30 * Q)]);
        let s = build_snapshot(b.iter().map(|(a, v)| (a, v)), &HashSet::new(), 10_000, 1000, wallet);
        let p1 = store.create(proposal(&s, 100), &s).unwrap();
        let p2 = store.create(proposal(&s, 100), &s).unwrap();
        assert_eq!((p1.id.as_str(), p2.id.as_str()), ("RP-1", "RP-2"));
        assert_eq!(store.weight_of("RP-1", "rouge1b").unwrap(), 30 * Q);
        assert_eq!(store.weight_of("RP-1", "rouge1nobody").unwrap(), 0);
        // A wallet changing its vote replaces the earlier one.
        store.cast(&vote("RP-1", "rouge1a", Choice::No, 10 * Q)).unwrap();
        store.cast(&vote("RP-1", "rouge1a", Choice::Yes, 10 * Q)).unwrap();
        let v = store.votes("RP-1").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].choice, Choice::Yes);
        assert!(store.votes("RP-2").unwrap().is_empty(), "votes are per proposal");
        // Quanta round-trip as strings (JS-safe).
        let json = serde_json::to_value(store.get("RP-1").unwrap().unwrap()).unwrap();
        assert_eq!(json["eligibleTotalQuanta"], serde_json::json!((40 * Q).to_string()));
        assert_eq!(store.list().unwrap().len(), 2);
        let paid = store.set_payout("RP-1", "abc", 5.0).unwrap();
        assert_eq!(paid.payout_tx_id.as_deref(), Some("abc"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
