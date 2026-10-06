//! The cryptographic primitives and encodings of spec §2 in plain Rust (no AIR): the
//! domain-separated sponge (§2.2), keys (§2.3), note commitment (§2.4), nullifier (§2.5), the
//! depth-32 Merkle node hash and a sparse reference tree (§2.6), the public-input and digest
//! encodings and the binding (§2.8), and the recipient's check (§2.4.1) — all over Poseidon2
//! (KoalaBear, width 24) exactly as shipped by the pinned Plonky3
//! (`default_koalabear_poseidon2_24`).
//!
//! Ported from `research/shield3/src/reference.rs` without changing any constant, tag or
//! encoding. The witness types, the transaction constructors and the deterministic test
//! generator of that file are in `witness.rs`, which exists only with the `test-prover` feature.

use std::collections::HashMap;
use std::sync::OnceLock;

use p3_field::PrimeCharacteristicRing;
use p3_koala_bear::{Poseidon2KoalaBear, default_koalabear_poseidon2_24};
use p3_symmetric::Permutation;

use crate::Felt;
use crate::layout::*;

pub type Digest = [Felt; DIGEST];
pub const ZERO_DIGEST: Digest = [Felt::ZERO; DIGEST];

/// The library's Poseidon2 permutation (not the AIR's round function).
pub fn permute(state: &mut [Felt; STATE_WIDTH]) {
    static PERM: OnceLock<Poseidon2KoalaBear<STATE_WIDTH>> = OnceLock::new();
    PERM.get_or_init(default_koalabear_poseidon2_24).permute_mut(state);
}

/// Domain-separated sponge: capacity = [len, domain, 0, 0, 0, 0, 0, 0], rate 16, input added
/// into the rate, zero padding (the length in the capacity makes that injective), digest = first
/// 8 rate elements.
pub fn hash_dom(domain: u32, elements: &[Felt]) -> Digest {
    hash_dom_idx(domain, 0, elements)
}

/// The same sponge with an index in the third capacity element:
/// capacity = [len, domain, index, 0, 0, 0, 0, 0]. Only `H_rho` uses a non-zero index.
pub fn hash_dom_idx(domain: u32, index: u32, elements: &[Felt]) -> Digest {
    let mut state = [Felt::ZERO; STATE_WIDTH];
    state[CAP] = Felt::from_u32(elements.len() as u32);
    state[CAP + 1] = Felt::from_u32(domain);
    state[CAP + 2] = Felt::from_u32(index);
    for chunk in elements.chunks(RATE) {
        for (s, &e) in state.iter_mut().zip(chunk) {
            *s += e;
        }
        permute(&mut state);
    }
    core::array::from_fn(|i| state[i])
}

pub fn merge(left: &Digest, right: &Digest) -> Digest {
    let mut v = [Felt::ZERO; 2 * DIGEST];
    v[..DIGEST].copy_from_slice(left);
    v[DIGEST..].copy_from_slice(right);
    hash_dom(D_MK, &v)
}

/// Four 16-bit limbs, least significant first.
pub fn limbs(v: u64) -> [Felt; NUM_LIMBS] {
    core::array::from_fn(|j| Felt::from_u32(((v >> (16 * j)) & 0xffff) as u32))
}

pub fn derive_nk(sk: &Digest) -> Digest {
    hash_dom(D_NK, sk)
}

pub fn derive_pk(sk: &Digest) -> Digest {
    hash_dom(D_PK, sk)
}

/// nf = H(D_NF; nk, rho)
pub fn nullifier(nk: &Digest, rho: &Digest) -> Digest {
    let mut v = [Felt::ZERO; 2 * DIGEST];
    v[..DIGEST].copy_from_slice(nk);
    v[DIGEST..].copy_from_slice(rho);
    hash_dom(D_NF, &v)
}

/// rho of output `j` (0 or 1) of the transaction that publishes the nullifiers `nf`:
/// `H_rho(nf1, nf2, j)` = sponge over nf1 ‖ nf2 with capacity [16, D_RHO, j, 0, ...].
///
/// SHIELD-3 (review finding F-2). The sender does not choose it: the AIR derives it from the
/// public nullifiers and forces each output commitment to use it. Anyone can recompute it from
/// the transaction, so it is PUBLIC; the commitment stays hiding through `r`, and the note's
/// future nullifier `H(D_NF; nk, rho)` stays unlinkable through the secret `nk`.
pub fn derive_rho(nf: &[Digest; NUM_INPUTS], j: usize) -> Digest {
    let mut v = [Felt::ZERO; 2 * DIGEST];
    v[..DIGEST].copy_from_slice(&nf[0]);
    v[DIGEST..].copy_from_slice(&nf[1]);
    hash_dom_idx(D_RHO, j as u32, &v)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Note {
    pub value: u64,
    pub pk: Digest,
    pub rho: Digest,
    pub r: Digest,
}

impl Note {
    /// cm = H(D_CM; pk, rho, value limbs, r) — 28 elements, two permutations.
    pub fn commitment(&self) -> Digest {
        let mut v = Vec::with_capacity(LEN_CM as usize);
        v.extend_from_slice(&self.pk);
        v.extend_from_slice(&self.rho);
        v.extend_from_slice(&limbs(self.value));
        v.extend_from_slice(&self.r);
        hash_dom(D_CM, &v)
    }
}

/// Sparse Merkle tree of depth 32. Level 0 = leaves. Bit `l` of the leaf index equal to 0 means
/// the node on the path at level `l` is the LEFT child.
pub struct SparseTree {
    nodes: HashMap<(usize, u64), Digest>,
    empty: Vec<Digest>,
}

impl Default for SparseTree {
    fn default() -> Self {
        Self::new()
    }
}

impl SparseTree {
    pub fn new() -> Self {
        let mut empty = Vec::with_capacity(TREE_DEPTH + 1);
        empty.push(ZERO_DIGEST);
        for l in 0..TREE_DEPTH {
            let e = empty[l];
            empty.push(merge(&e, &e));
        }
        Self { nodes: HashMap::new(), empty }
    }

    fn node(&self, level: usize, index: u64) -> Digest {
        *self.nodes.get(&(level, index)).unwrap_or(&self.empty[level])
    }

    pub fn insert(&mut self, index: u32, leaf: Digest) {
        let mut idx = index as u64;
        self.nodes.insert((0, idx), leaf);
        for level in 0..TREE_DEPTH {
            let (l, r) = (self.node(level, idx & !1), self.node(level, idx | 1));
            idx >>= 1;
            self.nodes.insert((level + 1, idx), merge(&l, &r));
        }
    }

    pub fn root(&self) -> Digest {
        self.node(TREE_DEPTH, 0)
    }

    /// Siblings from the leaf level upward.
    pub fn path(&self, index: u32) -> [Digest; TREE_DEPTH] {
        let mut out = [ZERO_DIGEST; TREE_DEPTH];
        let mut idx = index as u64;
        for (level, slot) in out.iter_mut().enumerate() {
            *slot = self.node(level, idx ^ 1);
            idx >>= 1;
        }
        out
    }
}

/// Recomputes a root from a leaf, its index and its siblings.
pub fn root_from_path(leaf: &Digest, index: u32, path: &[Digest; TREE_DEPTH]) -> Digest {
    let mut cur = *leaf;
    for (level, sib) in path.iter().enumerate() {
        cur = if (index >> level) & 1 == 0 { merge(&cur, sib) } else { merge(sib, &cur) };
    }
    cur
}

/// KoalaBear modulus.
pub const MODULUS: u32 = 0x7f00_0001;

/// The statement. `to_values` is what both prover and verifier hand to Plonky3.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicInputs {
    pub anchor: Digest,
    pub nf: [Digest; NUM_INPUTS],
    pub cm_out: [Digest; NUM_OUTPUTS],
    pub v_in: u64,
    pub v_out: u64,
    pub fee: u64,
    pub binding: Digest,
}

/// Byte length of `PublicInputs::to_bytes`: 5 digests, 3 amounts, the binding.
pub const PUBLIC_INPUT_BYTES: usize = 5 * 32 + 3 * 8 + 32;

pub fn digest_to_bytes(d: &Digest) -> [u8; 32] {
    use p3_field::PrimeField32;
    let mut out = [0u8; 32];
    for (c, e) in out.chunks_mut(4).zip(d) {
        c.copy_from_slice(&e.as_canonical_u32().to_le_bytes());
    }
    out
}

/// Strict: every 4-byte little-endian word must be a canonical field element (< p).
pub fn digest_from_bytes(b: &[u8]) -> Option<Digest> {
    if b.len() != 32 {
        return None;
    }
    let mut out = ZERO_DIGEST;
    for (c, e) in b.chunks(4).zip(out.iter_mut()) {
        let w = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        if w >= MODULUS {
            return None;
        }
        *e = Felt::from_u32(w);
    }
    Some(out)
}

impl PublicInputs {
    /// 60 field elements: anchor, nf1, nf2, cm_out1, cm_out2 (8 each), v_in, v_out, fee (four
    /// 16-bit limbs each, least significant first), binding (8).
    pub fn to_values(&self) -> Vec<Felt> {
        let mut v = Vec::with_capacity(NUM_PUBLIC_VALUES);
        v.extend_from_slice(&self.anchor);
        v.extend_from_slice(&self.nf[0]);
        v.extend_from_slice(&self.nf[1]);
        v.extend_from_slice(&self.cm_out[0]);
        v.extend_from_slice(&self.cm_out[1]);
        v.extend_from_slice(&limbs(self.v_in));
        v.extend_from_slice(&limbs(self.v_out));
        v.extend_from_slice(&limbs(self.fee));
        v.extend_from_slice(&self.binding);
        v
    }

    /// 216 bytes: anchor ‖ nf1 ‖ nf2 ‖ cm_out1 ‖ cm_out2 (32 each) ‖ v_in ‖ v_out ‖ fee (u64 LE)
    /// ‖ binding (32).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(PUBLIC_INPUT_BYTES);
        for d in [&self.anchor, &self.nf[0], &self.nf[1], &self.cm_out[0], &self.cm_out[1]] {
            v.extend_from_slice(&digest_to_bytes(d));
        }
        for a in [self.v_in, self.v_out, self.fee] {
            v.extend_from_slice(&a.to_le_bytes());
        }
        v.extend_from_slice(&digest_to_bytes(&self.binding));
        v
    }

    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() != PUBLIC_INPUT_BYTES {
            return None;
        }
        let dg = |i: usize| digest_from_bytes(&b[32 * i..32 * i + 32]);
        let amt = |i: usize| u64::from_le_bytes(b[160 + 8 * i..168 + 8 * i].try_into().unwrap());
        Some(Self {
            anchor: dg(0)?,
            nf: [dg(1)?, dg(2)?],
            cm_out: [dg(3)?, dg(4)?],
            v_in: amt(0),
            v_out: amt(1),
            fee: amt(2),
            binding: digest_from_bytes(&b[184..216])?,
        })
    }
}

/// Spec §2.8: `binding = binding_from_bytes(body)`, `body` being the 2,546-byte transaction body
/// of spec §3.2. Blake3 in key-derivation mode, each 4-byte little-endian word of the 32-byte
/// output reduced mod p. The context string is frozen byte for byte, including its
/// `research-0` suffix (spec §2.8, open issue O-13).
pub fn binding_from_bytes(tx_bytes: &[u8]) -> Digest {
    let h = blake3::derive_key("rouge-shield/v2/binding/research-0", tx_bytes);
    core::array::from_fn(|i| {
        let w = u32::from_le_bytes([h[4 * i], h[4 * i + 1], h[4 * i + 2], h[4 * i + 3]]);
        Felt::from_u32(w % MODULUS)
    })
}

/// What the RECIPIENT of output `j` does on receipt (spec §2.4.1). The sender delivers `(value, r)`
/// (encrypted to the recipient, spec §3.4); `rho` is NOT delivered. The recipient
/// takes `nf1`, `nf2`, the output index `j` and `cm_out_j` from the transaction on chain,
/// recomputes `rho = derive_rho(nf, j)` and accepts the note only if the commitment built from
/// its own `pk` matches the published one. Returns the full note (with its `rho`) to store.
pub fn receive_note(public: &PublicInputs, j: usize, my_pk: &Digest, value: u64, r: &Digest) -> Option<Note> {
    let note = Note { value, pk: *my_pk, rho: derive_rho(&public.nf, j), r: *r };
    (note.commitment() == public.cm_out[j]).then_some(note)
}

#[cfg(feature = "test-prover")]
pub use crate::witness::*;
