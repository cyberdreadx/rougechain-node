//! TEST ONLY (`test-prover` feature): witness types, the three transaction constructors, a
//! deterministic witness generator and fixtures. Ported verbatim from
//! `research/shield3/src/reference.rs`; re-exported through `crate::reference` so that the ported
//! tests read as in the research tree. Nothing here is reachable in a default build.
//!
//! The constructors panic or return `Err` on bad arguments and draw their "randomness" from a
//! caller-supplied source: they are not wallet code (spec §5.6, §5.7).

use crate::Felt;
use crate::layout::*;
use crate::reference::{
    Digest, Note, PublicInputs, SparseTree, ZERO_DIGEST, binding_from_bytes, derive_nk, derive_pk, derive_rho,
    nullifier, root_from_path,
};
use p3_field::PrimeCharacteristicRing;

/// Deterministic generator for test and bench witnesses (splitmix64). Not for key material and
/// NOT the source of proof blinding (that is a ChaCha `StdRng`, see `config.rs`).
pub struct TestRng(pub u64);

impl TestRng {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    pub fn felt(&mut self) -> Felt {
        Felt::from_u64(self.next_u64())
    }
    pub fn digest(&mut self) -> Digest {
        core::array::from_fn(|_| self.felt())
    }
    pub fn seed32(&mut self) -> [u8; 32] {
        let mut s = [0u8; 32];
        for c in s.chunks_mut(8) {
            c.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        s
    }
}

/// One input of a join-split as a wallet holds it.
#[derive(Clone, Debug)]
pub struct InputNote {
    /// `true`: a real note, membership under the anchor is proven. `false`: a dummy; its value
    /// must be 0 and its path is not compared with the anchor.
    pub enabled: bool,
    pub sk: Digest,
    pub value: u64,
    pub rho: Digest,
    pub r: Digest,
    pub index: u32,
    pub path: [Digest; TREE_DEPTH],
}

impl InputNote {
    pub fn note(&self) -> Note {
        Note { value: self.value, pk: derive_pk(&self.sk), rho: self.rho, r: self.r }
    }
    pub fn nullifier(&self) -> Digest {
        nullifier(&derive_nk(&self.sk), &self.rho)
    }
    /// The root this input's path leads to (compared with the anchor only if `enabled`).
    pub fn root(&self) -> Digest {
        root_from_path(&self.note().commitment(), self.index, &self.path)
    }
}

/// A note the wallet owns and can spend: what `transfer` / `unshield` take.
#[derive(Clone, Debug)]
pub struct OwnedNote {
    pub sk: Digest,
    pub value: u64,
    pub rho: Digest,
    pub r: Digest,
    pub index: u32,
    pub path: [Digest; TREE_DEPTH],
}

/// What the sender chooses about a note it creates: value, recipient key and the commitment
/// randomness `r`. NOT `rho` — that is `derive_rho(nf, j)` of the creating transaction
/// (`JoinSplit::output_note`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputNote {
    pub value: u64,
    pub pk: Digest,
    pub r: Digest,
}

/// Source of the random digests the constructors need (dummy keys, the dummies' rho, r). A wallet
/// must back this with OS entropy; tests use `TestRng`.
pub trait DigestSource {
    fn next_digest(&mut self) -> Digest;
}

impl DigestSource for TestRng {
    fn next_digest(&mut self) -> Digest {
        self.digest()
    }
}

/// The full private witness plus the public amounts of one join-split.
#[derive(Clone, Debug)]
pub struct JoinSplit {
    pub inputs: [InputNote; NUM_INPUTS],
    pub outputs: [OutputNote; NUM_OUTPUTS],
    pub anchor: Digest,
    pub v_in: u64,
    pub v_out: u64,
    pub fee: u64,
    pub binding: Digest,
}

impl JoinSplit {
    /// The two nullifiers this join-split publishes.
    pub fn nullifiers(&self) -> [Digest; NUM_INPUTS] {
        [self.inputs[0].nullifier(), self.inputs[1].nullifier()]
    }

    /// rho of output `j`: derived from the two nullifiers and the index, never chosen.
    pub fn rho_out(&self, j: usize) -> Digest {
        derive_rho(&self.nullifiers(), j)
    }

    /// Output `j` as the full note that gets committed.
    pub fn output_note(&self, j: usize) -> Note {
        let o = &self.outputs[j];
        Note { value: o.value, pk: o.pk, rho: self.rho_out(j), r: o.r }
    }

    /// Public inputs computed by the reference implementation (not read from a trace).
    pub fn public(&self) -> PublicInputs {
        let nf = self.nullifiers();
        let cm = |j: usize| {
            let o = &self.outputs[j];
            Note { value: o.value, pk: o.pk, rho: derive_rho(&nf, j), r: o.r }.commitment()
        };
        PublicInputs {
            anchor: self.anchor,
            nf,
            cm_out: [cm(0), cm(1)],
            v_in: self.v_in,
            v_out: self.v_out,
            fee: self.fee,
            binding: self.binding,
        }
    }

    /// The statement in plain Rust: what the AIR plus `verify_spend` must accept exactly. (The
    /// output rho needs no check here: `public()` cannot build a commitment with any other.)
    pub fn check(&self) -> Result<(), String> {
        for (i, inp) in self.inputs.iter().enumerate() {
            if inp.enabled {
                if inp.root() != self.anchor {
                    return Err(format!("input {} is not under the anchor", i + 1));
                }
            } else if inp.value != 0 {
                return Err(format!("dummy input {} has a non-zero value", i + 1));
            }
        }
        let lhs = self.inputs[0].value as u128 + self.inputs[1].value as u128 + self.v_in as u128;
        let rhs = self.outputs[0].value as u128 + self.outputs[1].value as u128 + self.v_out as u128 + self.fee as u128;
        if lhs != rhs {
            return Err(format!("balance: {lhs} != {rhs}"));
        }
        if self.inputs[0].nullifier() == self.inputs[1].nullifier() {
            return Err("the two nullifiers are equal".into());
        }
        Ok(())
    }
}

/// The research witness as the wallet prover's witness (tests only: this module does not exist in
/// a wallet build).
impl From<&JoinSplit> for crate::prover::SpendWitness {
    fn from(js: &JoinSplit) -> Self {
        let i = |n: usize| {
            let x = &js.inputs[n];
            crate::prover::InputWitness {
                enabled: x.enabled,
                sk: x.sk,
                value: x.value,
                rho: x.rho,
                r: x.r,
                index: x.index,
                path: x.path,
            }
        };
        let o = |n: usize| {
            let x = &js.outputs[n];
            crate::prover::OutputWitness { value: x.value, pk: x.pk, r: x.r }
        };
        crate::prover::SpendWitness { inputs: [i(0), i(1)], outputs: [o(0), o(1)] }
    }
}

/// A dummy input: fresh random key, rho and r, value 0, an arbitrary (all-zero, index 0) path.
/// Its nullifier is derived exactly like a real one and is unlinkable to anything.
pub fn dummy_input(src: &mut dyn DigestSource) -> InputNote {
    InputNote {
        enabled: false,
        sk: src.next_digest(),
        value: 0,
        rho: src.next_digest(),
        r: src.next_digest(),
        index: 0,
        path: [ZERO_DIGEST; TREE_DEPTH],
    }
}

/// A real (enabled) input from an owned note.
pub fn real_input(n: &OwnedNote) -> InputNote {
    InputNote { enabled: true, sk: n.sk, value: n.value, rho: n.rho, r: n.r, index: n.index, path: n.path }
}

/// An output: only `r` is drawn; rho follows from the transaction's nullifiers.
fn fresh_note(value: u64, pk: Digest, src: &mut dyn DigestSource) -> OutputNote {
    OutputNote { value, pk, r: src.next_digest() }
}

/// One or two owned notes -> two circuit inputs (the second is a dummy if there is one note).
fn inputs_from(notes: &[OwnedNote], src: &mut dyn DigestSource) -> Result<[InputNote; 2], String> {
    match notes {
        [a] => Ok([real_input(a), dummy_input(src)]),
        [a, b] => Ok([real_input(a), real_input(b)]),
        _ => Err("one or two input notes".into()),
    }
}

/// SHIELD: public value `v_in` enters the pool. Two dummy inputs; output 1 = `v_in - fee` to
/// `to_pk`; output 2 = a zero-value dummy note to a random key. `anchor` is any recent root (no
/// input is compared with it).
pub fn shield(
    anchor: Digest,
    v_in: u64,
    fee: u64,
    to_pk: Digest,
    binding: Digest,
    src: &mut dyn DigestSource,
) -> Result<JoinSplit, String> {
    if v_in == 0 {
        return Err("shield needs v_in > 0".into());
    }
    let value = v_in.checked_sub(fee).ok_or("fee exceeds v_in")?;
    let dummy_pk = src.next_digest();
    Ok(JoinSplit {
        inputs: [dummy_input(src), dummy_input(src)],
        outputs: [fresh_note(value, to_pk, src), fresh_note(0, dummy_pk, src)],
        anchor,
        v_in,
        v_out: 0,
        fee,
        binding,
    })
}

/// TRANSFER: `v_in = v_out = 0`. Output 1 = `amount` to `to_pk`; output 2 = the change to
/// `change_pk` (a zero-value note if there is none).
pub fn transfer(
    anchor: Digest,
    notes: &[OwnedNote],
    amount: u64,
    to_pk: Digest,
    change_pk: Digest,
    fee: u64,
    binding: Digest,
    src: &mut dyn DigestSource,
) -> Result<JoinSplit, String> {
    let inputs = inputs_from(notes, src)?;
    let total = inputs[0].value as u128 + inputs[1].value as u128;
    let change = total.checked_sub(amount as u128 + fee as u128).ok_or("insufficient input value")?;
    let change = u64::try_from(change).map_err(|_| "change does not fit in 64 bits")?;
    Ok(JoinSplit {
        inputs,
        outputs: [fresh_note(amount, to_pk, src), fresh_note(change, change_pk, src)],
        anchor,
        v_in: 0,
        v_out: 0,
        fee,
        binding,
    })
}

/// UNSHIELD: public value `v_out` leaves the pool. Output 1 = the change to `change_pk`;
/// output 2 = a zero-value dummy note to a random key.
pub fn unshield(
    anchor: Digest,
    notes: &[OwnedNote],
    v_out: u64,
    change_pk: Digest,
    fee: u64,
    binding: Digest,
    src: &mut dyn DigestSource,
) -> Result<JoinSplit, String> {
    if v_out == 0 {
        return Err("unshield needs v_out > 0".into());
    }
    let inputs = inputs_from(notes, src)?;
    let total = inputs[0].value as u128 + inputs[1].value as u128;
    let change = total.checked_sub(v_out as u128 + fee as u128).ok_or("insufficient input value")?;
    let change = u64::try_from(change).map_err(|_| "change does not fit in 64 bits")?;
    let dummy_pk = src.next_digest();
    Ok(JoinSplit {
        inputs,
        outputs: [fresh_note(change, change_pk, src), fresh_note(0, dummy_pk, src)],
        anchor,
        v_in: 0,
        v_out,
        fee,
        binding,
    })
}

/// A wallet-side note together with the tree it sits in (tests, benches, the phone page).
pub struct Fixture {
    pub tree: SparseTree,
    pub notes: Vec<OwnedNote>,
}

/// A deterministic tree with a handful of foreign notes and `n` notes of ours with the given
/// values (paths taken after all insertions).
pub fn fixture(rng: &mut TestRng, values: &[u64]) -> Fixture {
    let mut tree = SparseTree::new();
    for _ in 0..5 {
        let other = Note { value: rng.next_u64(), pk: rng.digest(), rho: rng.digest(), r: rng.digest() };
        tree.insert(rng.next_u64() as u32, other.commitment());
    }
    let mut mine = Vec::new();
    for &value in values {
        let sk = rng.digest();
        let (rho, r) = (rng.digest(), rng.digest());
        let index = rng.next_u64() as u32;
        // neighbours in the same bottom subtree so the lowest siblings are not all "empty"
        tree.insert(index ^ 1, rng.digest());
        tree.insert(index ^ 0b1100, rng.digest());
        tree.insert(index, Note { value, pk: derive_pk(&sk), rho, r }.commitment());
        mine.push((sk, value, rho, r, index));
    }
    let notes = mine
        .into_iter()
        .map(|(sk, value, rho, r, index)| OwnedNote { sk, value, rho, r, index, path: tree.path(index) })
        .collect();
    Fixture { tree, notes }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// two dummy inputs, v_in > 0
    Shield,
    /// two real inputs, v_in = v_out = 0, payment + change
    Transfer,
    /// one real input and one dummy, v_in = v_out = 0
    Transfer1,
    /// one real input and one dummy, v_out > 0
    Unshield,
    /// two real inputs, v_out > 0
    Unshield2,
}

/// A deterministic honest join-split of the given kind.
pub fn sample(kind: Kind, seed: u64) -> JoinSplit {
    let mut rng = TestRng(seed ^ 0x5348_4c44_3200_0000);
    // values whose limbs force carries in the balance equations
    let v1 = 0x0000_0012_0000_0005u64 + (rng.next_u64() & 0xffff);
    let v2 = 0x0000_0003_fffe_fff0u64 + (rng.next_u64() & 0xffff);
    let fx = fixture(&mut rng, &[v1, v2]);
    let anchor = fx.tree.root();
    let binding = binding_from_bytes(&rng.next_u64().to_le_bytes());
    let (to_pk, change_pk) = (rng.digest(), rng.digest());
    let fee = 1_000u64;
    let js = match kind {
        Kind::Shield => shield(anchor, 250_000_000 + (seed & 0xff), fee, to_pk, binding, &mut rng),
        Kind::Transfer => transfer(anchor, &fx.notes, v1 + 77, to_pk, change_pk, fee, binding, &mut rng),
        Kind::Transfer1 => transfer(anchor, &fx.notes[..1], 123_456_789, to_pk, change_pk, fee, binding, &mut rng),
        Kind::Unshield => unshield(anchor, &fx.notes[..1], 250_000_000 + (seed & 0xff), change_pk, fee, binding, &mut rng),
        Kind::Unshield2 => unshield(anchor, &fx.notes, v1 + 0x1_0000_0001, change_pk, fee, binding, &mut rng),
    }
    .expect("sample");
    js.check().expect("sample must satisfy the statement");
    js
}
