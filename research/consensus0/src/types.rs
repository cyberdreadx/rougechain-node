//! Primitive types shared by every module: identifiers, the modelled hash and
//! signature, exact integer helpers, votes, certificates and validator sets.
//!
//! Design references are to `docs/CONSENSUS_R2_DESIGN.md` ("§n").
//!
//! **What is modelled and what is real.** Hashes and signatures are *models*
//! (a non-cryptographic 256-bit mix and a keyed tag): CONSENSUS-0 tests the
//! rules, not the cryptography. The signed byte strings (§3.2) and all wire
//! and certificate *sizes* (§2.2, §3.6) are the real ones.

use std::collections::BTreeMap;
use std::fmt;

/// Block height.
pub type Height = u64;
/// Round number inside a height (§3.1).
pub type Round = u32;
/// Milliseconds. Header time and local clocks use the same unit.
pub type TimeMs = u64;
/// Voting weight: whole XRGE (§6.2 "fractions do not count", deviation D3).
pub type Weight = u128;
/// Ledger amounts: 1 XRGE = 10^9 quanta.
pub type Quanta = u128;

/// Quanta per XRGE (`core/daemon/src/units.rs:23` as cited by the design).
pub const QUANTA_PER_XRGE: u128 = 1_000_000_000;
/// ML-DSA-65 signature bytes (§1.1, §2.2).
pub const SIG_BYTES: u64 = 3_309;
/// ML-DSA-65 public key bytes (§1.1).
pub const KEY_BYTES: u64 = 1_952;
/// Wire size of one vote: type 1 + height 8 + round 4 + hash 32 + index 2 + signature (§2.2).
pub const VOTE_WIRE_BYTES: u64 = 1 + 8 + 4 + 32 + 2 + SIG_BYTES;
/// Fixed part of a commit certificate: version 1 + height 8 + round 4 + hash 32 + n_set 2 (§3.6).
pub const CERT_FIXED_BYTES: u64 = 47;
/// Evidence item size: LC1 E1 envelope plus round and vote type (§4.2).
pub const EVIDENCE_BYTES: u64 = 9_709;
/// `W` (total weight) must stay below 2^100 so that no schedule step can
/// overflow `i128` (§3.3). The same bound keeps `2T` inside `u128`.
pub const MAX_TOTAL_WEIGHT: u128 = 1u128 << 100;

/// A consensus key. The numeric value stands for the key hash, so the
/// derived ordering is the design's "key-hash order" (§3.3 tie-break, §3.6 bitmap order).
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct KeyId(pub u32);

/// A block hash (32 bytes, §3.2).
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId(pub [u8; 32]);

impl BlockId {
    /// Lowercase hex, 64 characters, as the signed bytes require (§3.2).
    pub fn hex(&self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push(HEX[usize::from(b >> 4)] as char);
            s.push(HEX[usize::from(b & 15)] as char);
        }
        s
    }
    /// Short form for traces.
    pub fn short(&self) -> String {
        self.hex()[..8].to_string()
    }
}

impl fmt::Debug for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{}", self.short())
    }
}

// ---------------------------------------------------------------------------
// Modelled hash
// ---------------------------------------------------------------------------

/// Deterministic, platform-independent 256-bit mixing hash (four FNV-1a lanes
/// with a final avalanche). **Not cryptographic**: it stands in for SHA-256 so
/// that block ids and state hashes are stable across runs and machines (P10).
#[derive(Clone)]
pub struct Hasher {
    lanes: [u64; 4],
}

impl Hasher {
    /// A hasher domain-separated by `tag`.
    pub fn new(tag: &str) -> Self {
        let mut h = Hasher {
            lanes: [
                0xcbf2_9ce4_8422_2325,
                0x9e37_79b9_7f4a_7c15,
                0xc2b2_ae3d_27d4_eb4f,
                0x1656_67b1_9e37_79f9,
            ],
        };
        h.bytes(tag.as_bytes());
        h
    }
    /// Absorb raw bytes (length-prefixed, so concatenations cannot collide trivially).
    pub fn bytes(&mut self, data: &[u8]) -> &mut Self {
        self.raw(&(data.len() as u64).to_le_bytes());
        self.raw(data);
        self
    }
    fn raw(&mut self, data: &[u8]) {
        for &b in data {
            for (i, lane) in self.lanes.iter_mut().enumerate() {
                *lane ^= u64::from(b).wrapping_add(i as u64);
                *lane = lane.wrapping_mul(0x0000_0100_0000_01b3);
                *lane = lane.rotate_left(5 + 2 * i as u32);
            }
        }
    }
    /// Absorb a u64.
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.raw(&v.to_le_bytes());
        self
    }
    /// Absorb a u128.
    pub fn u128(&mut self, v: u128) -> &mut Self {
        self.raw(&v.to_le_bytes());
        self
    }
    /// Absorb an i128.
    pub fn i128(&mut self, v: i128) -> &mut Self {
        self.raw(&v.to_le_bytes());
        self
    }
    /// Absorb an optional block id (`None` is distinct from every id).
    pub fn opt_id(&mut self, v: Option<&BlockId>) -> &mut Self {
        match v {
            None => self.u64(0),
            Some(id) => {
                self.u64(1);
                self.raw(&id.0);
                self
            }
        }
    }
    /// Absorb a block id.
    pub fn id(&mut self, v: &BlockId) -> &mut Self {
        self.raw(&v.0);
        self
    }
    fn avalanche(mut x: u64) -> u64 {
        x ^= x >> 30;
        x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        x ^= x >> 27;
        x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
        x ^ (x >> 31)
    }
    /// 256-bit result.
    pub fn finish(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        let mut carry = 0u64;
        for i in 0..4 {
            let mixed = Self::avalanche(self.lanes[i] ^ carry.rotate_left(17) ^ self.lanes[(i + 1) % 4].rotate_left(31));
            carry = mixed;
            out[i * 8..i * 8 + 8].copy_from_slice(&mixed.to_le_bytes());
        }
        out
    }
    /// 64-bit result.
    pub fn finish64(&self) -> u64 {
        let f = self.finish();
        let mut b = [0u8; 8];
        b.copy_from_slice(&f[..8]);
        u64::from_le_bytes(b)
    }
}

// ---------------------------------------------------------------------------
// Exact integer arithmetic (deviation D3; §4.3 "computed exactly"; §5.1 "all products exact")
// ---------------------------------------------------------------------------

/// Full 128×128 → 256-bit product as `(high, low)`.
fn full_mul(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = (1u128 << 64) - 1;
    let (a1, a0) = (a >> 64, a & MASK);
    let (b1, b0) = (b >> 64, b & MASK);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & MASK) + (p10 & MASK);
    let lo = (p00 & MASK) | ((mid & MASK) << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `(hi·2^128 + lo) / d` as `(quotient, remainder)`; `None` if `d == 0` or the
/// quotient does not fit `u128` (`hi >= d`).
fn div_wide(hi: u128, lo: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 || hi >= d {
        return None;
    }
    if hi == 0 {
        return Some((lo / d, lo % d));
    }
    let mut rem = hi;
    let mut q = 0u128;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    Some((q, rem))
}

/// `⌊a·b / d⌋` with a 256-bit intermediate. `None` when `d == 0` or the result
/// does not fit: the caller must treat that as an invalid block, never saturate
/// (§4.3 forbids the saturating `units::mul_div`).
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    let (hi, lo) = full_mul(a, b);
    div_wide(hi, lo, d).map(|(q, _)| q)
}

/// `⌊a·b / d⌋` for signed `a`, rounding toward negative infinity (§3.3 `floor_div`).
pub fn signed_mul_div_floor(a: i128, b: u128, d: u128) -> Option<i128> {
    if a >= 0 {
        let q = mul_div_floor(a.unsigned_abs(), b, d)?;
        i128::try_from(q).ok()
    } else {
        let (hi, lo) = full_mul(a.unsigned_abs(), b);
        let (q, r) = div_wide(hi, lo, d)?;
        let mag = if r == 0 { q } else { q.checked_add(1)? };
        // −mag must fit i128: mag ≤ 2^127.
        if mag > (1u128 << 127) {
            return None;
        }
        Some((mag as i128).wrapping_neg())
    }
}

/// Floor division of signed integers (toward negative infinity); `None` if `d == 0` or on overflow.
pub fn floor_div(a: i128, d: i128) -> Option<i128> {
    if d == 0 {
        return None;
    }
    let q = a.checked_div(d)?;
    let r = a.checked_rem(d)?;
    if r != 0 && ((r < 0) != (d < 0)) {
        q.checked_sub(1)
    } else {
        Some(q)
    }
}

// ---------------------------------------------------------------------------
// Modelled signatures and the real signed bytes (§3.2, deviation D1)
// ---------------------------------------------------------------------------

/// Signing-domain tag. V2 is today's finality vote (`core/finality/src/lib.rs:20-35`),
/// V3 the new consensus domain. They can never be confused (§3.2, §8.2).
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Domain {
    /// `ROUGECHAIN_FINALITY_VOTE_V2`: pre-fork, round 0 only.
    V2,
    /// `ROUGECHAIN_CONSENSUS_V3`: post-fork.
    V3,
}

impl Domain {
    /// The ASCII domain tag.
    pub fn tag(self) -> &'static str {
        match self {
            Domain::V2 => "ROUGECHAIN_FINALITY_VOTE_V2",
            Domain::V3 => "ROUGECHAIN_CONSENSUS_V3",
        }
    }
}

/// Vote type.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum VoteType {
    /// First voting step.
    Prevote,
    /// Second voting step; a quorum of these is a commit certificate.
    Precommit,
}

impl VoteType {
    /// The `type=` field of the signed bytes.
    pub fn name(self) -> &'static str {
        match self {
            VoteType::Prevote => "prevote",
            VoteType::Precommit => "precommit",
        }
    }
}

/// Signed bytes of a vote (§3.2): ASCII, `|` separators, decimal integers
/// without leading zeros, lowercase hex, `nil` for no block.
pub fn vote_sign_bytes(domain: Domain, chain_id: &str, kind: VoteType, height: Height, round: Round, block: Option<&BlockId>) -> String {
    let block = match block {
        Some(id) => id.hex(),
        None => "nil".to_string(),
    };
    format!("{}|chain={}|type={}|height={}|round={}|block={}", domain.tag(), chain_id, kind.name(), height, round, block)
}

/// Signed bytes of a proposal (§3.2). `pol` is the proposer's `valid_round` or `none`.
pub fn proposal_sign_bytes(chain_id: &str, height: Height, round: Round, pol: Option<Round>, block: &BlockId) -> String {
    let pol = match pol {
        Some(r) => r.to_string(),
        None => "none".to_string(),
    };
    format!("{}|chain={}|type=proposal|height={}|round={}|pol={}|block={}", Domain::V3.tag(), chain_id, height, round, pol, block.hex())
}

/// A modelled signature: valid iff `signer` is the claimed key and `tag`
/// matches the signed bytes. Stands for 3,309 bytes on the wire.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Sig {
    /// The key that produced it.
    pub signer: KeyId,
    /// Keyed digest of the signed bytes.
    pub tag: u64,
}

/// The capability to sign with a key. Only the harness (or, later, the node's
/// key store) constructs one; code without it cannot produce a valid [`Sig`]
/// for that key, which is how "a vote is valid iff signed by the key the
/// harness says holds it" is enforced.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct SigningKey(KeyId);

impl SigningKey {
    /// Model a key holder. In the node this is replaced by the ML-DSA-65 key.
    pub fn model(key: KeyId) -> Self {
        SigningKey(key)
    }
    /// The public identity.
    pub fn id(&self) -> KeyId {
        self.0
    }
    /// Sign bytes.
    pub fn sign(&self, bytes: &str) -> Sig {
        Sig { signer: self.0, tag: sig_tag(self.0, bytes) }
    }
}

fn sig_tag(key: KeyId, bytes: &str) -> u64 {
    let mut h = Hasher::new("sig");
    h.u64(u64::from(key.0)).bytes(bytes.as_bytes());
    h.finish64()
}

/// Verify a modelled signature over `bytes` by `key`.
pub fn verify_sig(key: KeyId, bytes: &str, sig: &Sig) -> bool {
    sig.signer == key && sig.tag == sig_tag(key, bytes)
}

/// A prevote or precommit (§3.2). `block == None` is a nil vote.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Vote {
    /// Prevote or precommit.
    pub kind: VoteType,
    /// Height voted on.
    pub height: Height,
    /// Round voted in.
    pub round: Round,
    /// Block hash, or `None` for nil.
    pub block: Option<BlockId>,
    /// The voter.
    pub voter: KeyId,
    /// Signature over [`vote_sign_bytes`].
    pub sig: Sig,
}

impl Vote {
    /// Create and sign a V3 vote.
    pub fn sign(key: &SigningKey, chain_id: &str, kind: VoteType, height: Height, round: Round, block: Option<BlockId>) -> Vote {
        Self::sign_in(Domain::V3, key, chain_id, kind, height, round, block)
    }
    /// Create and sign a vote in an explicit domain (V2 is used only to model pre-fork history, §8.2).
    pub fn sign_in(domain: Domain, key: &SigningKey, chain_id: &str, kind: VoteType, height: Height, round: Round, block: Option<BlockId>) -> Vote {
        let bytes = vote_sign_bytes(domain, chain_id, kind, height, round, block.as_ref());
        Vote { kind, height, round, block, voter: key.id(), sig: key.sign(&bytes) }
    }
    /// Verify the signature in `domain`.
    pub fn verify(&self, domain: Domain, chain_id: &str) -> bool {
        let bytes = vote_sign_bytes(domain, chain_id, self.kind, self.height, self.round, self.block.as_ref());
        verify_sig(self.voter, &bytes, &self.sig)
    }
}

// ---------------------------------------------------------------------------
// Validator set
// ---------------------------------------------------------------------------

/// The eligible set `E(h)` with weights, in key order (§ terms table).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ValidatorSet {
    members: Vec<(KeyId, Weight)>,
    total: Weight,
}

/// Why a validator set could not be built.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SetError {
    /// The same key appears twice.
    DuplicateKey(KeyId),
    /// A member has zero weight (`E` contains only `stake > 0`).
    ZeroWeight(KeyId),
    /// Total weight is at or above 2^100 (§3.3).
    TotalTooLarge,
}

impl ValidatorSet {
    /// Build a set; members are sorted into key order.
    pub fn new(mut members: Vec<(KeyId, Weight)>) -> Result<Self, SetError> {
        members.sort();
        let mut total: Weight = 0;
        for (i, (key, w)) in members.iter().enumerate() {
            if *w == 0 {
                return Err(SetError::ZeroWeight(*key));
            }
            if i > 0 && members[i - 1].0 == *key {
                return Err(SetError::DuplicateKey(*key));
            }
            total = total.checked_add(*w).ok_or(SetError::TotalTooLarge)?;
            if total >= MAX_TOTAL_WEIGHT {
                return Err(SetError::TotalTooLarge);
            }
        }
        Ok(ValidatorSet { members, total })
    }
    /// Members in key order.
    pub fn members(&self) -> &[(KeyId, Weight)] {
        &self.members
    }
    /// Number of members.
    pub fn len(&self) -> usize {
        self.members.len()
    }
    /// True when there are no members (no quorum is then possible).
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
    /// Total weight `T`.
    pub fn total(&self) -> Weight {
        self.total
    }
    /// Weight of `key`, 0 if not a member.
    pub fn weight(&self, key: KeyId) -> Weight {
        match self.members.binary_search_by_key(&key, |m| m.0) {
            Ok(i) => self.members[i].1,
            Err(_) => 0,
        }
    }
    /// True if `key` is a member.
    pub fn contains(&self, key: KeyId) -> bool {
        self.members.binary_search_by_key(&key, |m| m.0).is_ok()
    }
    /// Quorum `q = ⌊2T/3⌋ + 1`: the least stake that is more than two thirds of `T`.
    /// `T < 2^100` (checked at construction) so `2T` cannot overflow.
    pub fn quorum(&self) -> Weight {
        if crate::mutation::active(crate::mutation::Mutation::QuorumOffByOne) {
            return self.total * 2 / 3;
        }
        self.total * 2 / 3 + 1
    }
    /// One-third bound `t1 = ⌊T/3⌋ + 1`: the least stake that is more than one third of `T`.
    pub fn one_third(&self) -> Weight {
        self.total / 3 + 1
    }
    /// Stable digest of the set.
    pub fn digest(&self) -> u64 {
        let mut h = Hasher::new("set");
        for (k, w) in &self.members {
            h.u64(u64::from(k.0)).u128(*w);
        }
        h.finish64()
    }
}

// ---------------------------------------------------------------------------
// Commit certificate (§3.6)
// ---------------------------------------------------------------------------

/// A commit certificate: precommit signatures over one `(height, round, block)`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CommitCert {
    /// Which rules it was produced under (§8.2: verified under the rules of the height it certifies).
    pub domain: Domain,
    /// Height of the certified block.
    pub height: Height,
    /// The commit round.
    pub round: Round,
    /// Hash of the certified block.
    pub block: BlockId,
    /// `n_set`: number of validators in `E(height)`.
    pub n_set: u16,
    /// One precommit signature per signer, in key order, no duplicates.
    pub sigs: Vec<(KeyId, Sig)>,
}

/// Why a certificate was rejected.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CertError {
    /// Wrong signing domain for the certified height.
    WrongDomain,
    /// `n_set` differs from the size of `E(height)`.
    SetSizeMismatch,
    /// Signers not strictly ascending in key order (covers duplicates).
    SignerOrder,
    /// A signer is not in `E(height)`.
    NotInSet(KeyId),
    /// A signature does not verify as a precommit for `(height, round, block)`.
    BadSignature(KeyId),
    /// Signer stake below `q`.
    BelowQuorum {
        /// Signer stake found.
        have: Weight,
        /// The quorum `q`.
        need: Weight,
    },
    /// A V2 certificate must be round 0 (`core/finality/src/lib.rs:85`).
    LegacyRoundNotZero,
}

impl CommitCert {
    /// Encoded size in bytes: `47 + ⌈n/8⌉ + 3,309·k` (§3.6).
    pub fn encoded_len(&self) -> u64 {
        cert_len(u64::from(self.n_set), self.sigs.len() as u64)
    }
    /// Signer keys in key order.
    pub fn signers(&self) -> impl Iterator<Item = KeyId> + '_ {
        self.sigs.iter().map(|s| s.0)
    }
    /// Verify against `E(height)`; returns the signer stake `W_S`.
    ///
    /// Rules (§3.6): every signature is a precommit for exactly
    /// `(height, round, block)`; no duplicate signer; signer stake `≥ q`.
    /// The `round ≥ header.round` rule needs the header and is checked by the caller.
    pub fn verify(&self, expect: Domain, chain_id: &str, set: &ValidatorSet) -> Result<Weight, CertError> {
        if self.domain != expect {
            return Err(CertError::WrongDomain);
        }
        if self.domain == Domain::V2 && self.round != 0 {
            return Err(CertError::LegacyRoundNotZero);
        }
        if usize::from(self.n_set) != set.len() {
            return Err(CertError::SetSizeMismatch);
        }
        let bytes = vote_sign_bytes(self.domain, chain_id, VoteType::Precommit, self.height, self.round, Some(&self.block));
        let mut stake: Weight = 0;
        let mut prev: Option<KeyId> = None;
        for (key, sig) in &self.sigs {
            if prev.is_some_and(|p| p >= *key) {
                return Err(CertError::SignerOrder);
            }
            prev = Some(*key);
            let w = set.weight(*key);
            if w == 0 {
                return Err(CertError::NotInSet(*key));
            }
            if !verify_sig(*key, &bytes, sig) {
                return Err(CertError::BadSignature(*key));
            }
            // Cannot overflow: bounded by set.total() < 2^100.
            stake += w;
        }
        let need = set.quorum();
        if stake < need {
            return Err(CertError::BelowQuorum { have: stake, need });
        }
        Ok(stake)
    }
    /// Stable digest.
    pub fn digest(&self) -> u64 {
        let mut h = Hasher::new("cert");
        h.u64(self.height).u64(u64::from(self.round)).id(&self.block).u64(u64::from(self.n_set));
        h.u64(matches!(self.domain, Domain::V3) as u64);
        for (k, s) in &self.sigs {
            h.u64(u64::from(k.0)).u64(s.tag);
        }
        h.finish64()
    }
}

/// Certificate size for a set of `n` with `k` signers (§3.6).
pub fn cert_len(n: u64, k: u64) -> u64 {
    CERT_FIXED_BYTES + n.div_ceil(8) + SIG_BYTES * k
}

// ---------------------------------------------------------------------------
// Evidence (§4.1, §4.2)
// ---------------------------------------------------------------------------

/// Duplicate-vote evidence: two votes by one key for the same
/// `(height, round, type)` with different `block` values.
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Evidence {
    /// First vote (the lower of the two in the derived order, so the pair is canonical).
    pub a: Vote,
    /// Second vote.
    pub b: Vote,
}

impl Evidence {
    /// Build evidence from two votes if they conflict; `None` otherwise.
    /// Signatures are *not* checked here (see `chain::Ledger`).
    pub fn from_votes(x: &Vote, y: &Vote) -> Option<Evidence> {
        if x.voter != y.voter || x.height != y.height || x.round != y.round || x.kind != y.kind || x.block == y.block {
            return None;
        }
        let (a, b) = if x <= y { (*x, *y) } else { (*y, *x) };
        Some(Evidence { a, b })
    }
    /// The accused key.
    pub fn offender(&self) -> KeyId {
        self.a.voter
    }
    /// The offence height.
    pub fn height(&self) -> Height {
        self.a.height
    }
}

/// Group votes by slot and return every key with a provable duplicate vote,
/// mapped to the heights at which it offended. Used by the P3 checker.
pub fn duplicate_voters<'a>(votes: impl Iterator<Item = &'a Vote>) -> BTreeMap<(Height, KeyId), Evidence> {
    let mut first: BTreeMap<(Height, Round, VoteType, KeyId), Vote> = BTreeMap::new();
    let mut out = BTreeMap::new();
    for v in votes {
        let slot = (v.height, v.round, v.kind, v.voter);
        match first.get(&slot) {
            None => {
                first.insert(slot, *v);
            }
            Some(prev) => {
                if let Some(ev) = Evidence::from_votes(prev, v) {
                    out.entry((v.height, v.voter)).or_insert(ev);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_matches_small_cases_and_wide_products() {
        assert_eq!(mul_div_floor(7, 3, 2), Some(10));
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None);
        assert_eq!(mul_div_floor(1, 1, 0), None);
        // (2^127)·6 / 4 = 3·2^126
        assert_eq!(mul_div_floor(1u128 << 127, 6, 4), Some(3u128 << 126));
        // cross-check against native arithmetic on values that fit
        let mut x: u128 = 0x1234_5678_9abc_def0;
        for _ in 0..2000 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) & ((1u128 << 60) - 1);
            let (a, b, d) = (x, (x >> 7) | 1, (x >> 13) | 1);
            assert_eq!(mul_div_floor(a, b, d), Some(a * b / d));
        }
    }

    #[test]
    fn signed_floor_rounds_toward_negative_infinity() {
        assert_eq!(signed_mul_div_floor(-7, 1, 2), Some(-4));
        assert_eq!(signed_mul_div_floor(7, 1, 2), Some(3));
        assert_eq!(signed_mul_div_floor(-8, 1, 2), Some(-4));
        assert_eq!(floor_div(-7, 2), Some(-4));
        assert_eq!(floor_div(7, 2), Some(3));
        assert_eq!(floor_div(-7, 0), None);
        assert_eq!(floor_div(i128::MIN, -1), None);
    }

    #[test]
    fn quorum_and_one_third_definitions() {
        let set = |ws: &[u128]| ValidatorSet::new(ws.iter().enumerate().map(|(i, w)| (KeyId(i as u32), *w)).collect()).unwrap();
        // §7 small-set table: n → signers needed at equal stakes
        for (n, need) in [(1u128, 1u128), (2, 2), (3, 3), (4, 3), (10, 7), (30, 21)] {
            assert_eq!(set(&vec![1; n as usize]).quorum(), need, "n={n}");
        }
        // §5.4: T = 100,000 → q = 66,667
        assert_eq!(set(&[40_000, 30_000, 20_000, 10_000]).quorum(), 66_667);
        assert_eq!(set(&[1, 1, 1]).one_third(), 2);
        assert!(ValidatorSet::new(vec![(KeyId(1), 1), (KeyId(1), 2)]).is_err());
        assert!(ValidatorSet::new(vec![(KeyId(1), 0)]).is_err());
        assert!(ValidatorSet::new(vec![(KeyId(1), MAX_TOTAL_WEIGHT)]).is_err());
    }

    #[test]
    fn certificate_sizes_match_design_table_2_2() {
        // "Certificate, all signers" and "minimum quorum only" rows.
        assert_eq!(cert_len(4, 4), 13_284);
        assert_eq!(cert_len(10, 10), 33_139);
        assert_eq!(cert_len(30, 30), 99_321);
        assert_eq!(cert_len(4, 3), 9_975);
        assert_eq!(cert_len(10, 7), 23_212);
        assert_eq!(cert_len(30, 21), 69_540);
        assert_eq!(VOTE_WIRE_BYTES, 3_356);
    }
}
