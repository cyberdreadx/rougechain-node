//! The normative test vectors of spec §8 (`vectors/`, copied unchanged from
//! `research/shield3/vectors/`) against the production verifier and the primitives of this crate.
//!
//! * `spec_8_1_files` — SHA-256 of every file as printed in §8.1, and sizes, Blake3, public bytes,
//!   commitments and derived rho as printed in §8.3 (the port of `review2_spec_vectors_on_disk`,
//!   reading `docs/SHIELDED_POOL_V2_SPEC.md` instead of `SPEC_DRAFT.md`).
//! * `spec_8_2_primitives` — every row of §8.2, the expected values copied from the
//!   specification's text, and all 33 empty-subtree values of `vectors.json`.
//! * `committed_vectors_verify` — the port of `research/shield3/tests/vectors.rs`.
//! * `spec_8_3_expected_results` — the five expected results of §8.3 for each vector, with EVERY
//!   single bit of the 216 public bytes flipped (the research test sampled every 32nd).
//! * `vectors_json_witnesses` — every private value of `vectors.json` recomputed with the
//!   reference functions.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --test vectors -- --test-threads=1`

use p3_field::{PrimeCharacteristicRing, PrimeField32};
use quantum_vault_shield_v2::reference::*;
use quantum_vault_shield_v2::{Felt, MAX_PROOF_BYTES, verify_spend};
use sha2::{Digest as _, Sha256};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors");
const SPEC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/SHIELDED_POOL_V2_SPEC.md");
const NAMES: [&str; 3] = ["shield", "transfer", "unshield"];

fn read(file: &str) -> Vec<u8> {
    std::fs::read(format!("{DIR}/{file}")).unwrap_or_else(|e| panic!("{file}: {e}"))
}

fn vector(name: &str) -> (Vec<u8>, PublicInputs, Vec<u8>) {
    let public = read(&format!("{name}.public.bin"));
    let pi = PublicInputs::from_bytes(&public).expect("canonical public inputs");
    (public, pi, read(&format!("{name}.proof.bin")))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn digest(v: [u32; 8]) -> Digest {
    v.map(Felt::from_u32)
}

fn list(d: &[Felt]) -> String {
    format!("[{}]", d.iter().map(|x| x.as_canonical_u32().to_string()).collect::<Vec<_>>().join(", "))
}

fn seq(from: u32, to: u32) -> Vec<Felt> {
    (from..=to).map(Felt::from_u32).collect()
}

fn dg(from: u32) -> Digest {
    core::array::from_fn(|i| Felt::from_u32(from + i as u32))
}

#[test]
fn spec_8_1_files() {
    let spec = std::fs::read_to_string(SPEC).expect("the specification travels with the code");
    // §8.1: SHA-256 of the files
    let table: [(&str, &str); 7] = [
        ("vectors.json", "6c8c69b187026890bc291b6bda7addfb5ccc4edda02cb28bce57ffec6c27aaca"),
        ("shield.public.bin", "d374a870ff9f8cd09553136ce1846b8b0de535e557058b3ac5d144362f8915a1"),
        ("shield.proof.bin", "a41f5d172ea86f501356cb9b8eec1fb7e6a4259ab77be8889d53aed530e7804b"),
        ("transfer.public.bin", "cd394278eb8080b673cbebda03dacf1a0c17ea1425c979bbee783febd7deeb03"),
        ("transfer.proof.bin", "ad390b761fb56d3887e0722a3e6222420fb8c08d1df7ab63a92d6b73d79b985a"),
        ("unshield.public.bin", "f640477bcdbe2f7d308bcaa6e9d844df08c0149a7ebf1f91dd4e992096f8ea4d"),
        ("unshield.proof.bin", "9caf22b6a9cf9e3e99f35ec59150cac6153be2ce9cb729563adf1566e2bc80eb"),
    ];
    for (file, want) in table {
        assert_eq!(hex(&Sha256::digest(read(file))), want, "{file}");
        assert!(spec.contains(&format!("| `{file}` | `{want}` |")), "{file}: the hash is not the one in the specification");
    }
    // §8.3: what the specification prints about each transaction
    for name in NAMES {
        let (public, pi, proof) = vector(name);
        assert_eq!(public.len(), PUBLIC_INPUT_BYTES);
        let b3 = blake3::hash(&proof).to_hex().to_string();
        let line = format!("`vectors/{name}.proof.bin`, {} bytes, Blake3 `{b3}`", proof.len());
        assert!(spec.contains(&line), "the specification does not contain: {line}");
        assert!(spec.contains(&hex(&public)), "{name}: public bytes differ from the specification");
        for d in [&pi.anchor, &pi.nf[0], &pi.nf[1], &pi.cm_out[0], &pi.cm_out[1], &pi.binding] {
            assert!(spec.contains(&list(d)), "{name}: a public digest is not in the specification");
        }
        for j in 0..2 {
            assert!(spec.contains(&list(&derive_rho(&pi.nf, j))), "{name}: derived rho {j} is not in the specification");
        }
        assert!(proof.len() <= MAX_PROOF_BYTES);
        println!("VECTOR|{name}|{} bytes, Blake3 {b3}: as printed in the specification; public bytes, digests and derived rho as printed", proof.len());
    }
}

#[test]
fn spec_8_2_primitives() {
    // Poseidon2 permutation of [0, 1, …, 23]
    let mut state: [Felt; 24] = core::array::from_fn(|i| Felt::from_u32(i as u32));
    permute(&mut state);
    assert_eq!(
        list(&state),
        "[723511737, 87131171, 587052829, 1323145575, 949917837, 2060493993, 234724110, 834906887, 306751607, 1771020267, 329216878, 823818173, 765507096, 1447982946, 605505945, 247386051, 1223069940, 354661286, 233493652, 2075130821, 1961191294, 313483662, 1701936810, 1815724394]"
    );
    let (sk, rho, r) = (dg(1), dg(9), dg(21));
    // H(1; 1..8), H(2; 1..8)
    assert_eq!(derive_nk(&sk), digest([595169165, 1319949558, 100343831, 1316207761, 1502406953, 2038333709, 911296729, 1702281373]));
    assert_eq!(hash_dom(1, &seq(1, 8)), derive_nk(&sk));
    assert_eq!(derive_pk(&sk), digest([503064717, 456360397, 379665597, 1823540223, 137459452, 1974170947, 1422064588, 141399043]));
    assert_eq!(hash_dom(2, &seq(1, 8)), derive_pk(&sk));
    // H(3; 1..16): nullifier of nk = 1..8, rho = 9..16
    let nf = digest([1038027522, 310679221, 579707435, 482677477, 306161169, 1695676278, 1953830546, 119319773]);
    assert_eq!(nullifier(&dg(1), &rho), nf);
    assert_eq!(hash_dom(3, &seq(1, 16)), nf);
    // H(5; 1..16): Merkle node
    let node = digest([657568912, 152267029, 1520450300, 822796350, 745411925, 19510099, 1479479508, 1103660458]);
    assert_eq!(merge(&dg(1), &dg(9)), node);
    assert_eq!(hash_dom(5, &seq(1, 16)), node);
    // H(4; 1..28): two-block sponge
    assert_eq!(hash_dom(4, &seq(1, 28)), digest([1982285774, 1409472141, 2088989081, 123423727, 1020238694, 1437663514, 195750243, 1551669774]));
    // commitment, with its limbs
    let value = 0x0123_4567_89ab_cdefu64;
    assert_eq!(list(&limbs(value)), "[52719, 35243, 17767, 291]");
    assert_eq!(
        Note { value, pk: dg(1), rho, r }.commitment(),
        digest([350137339, 1849492580, 947277798, 542868595, 1789965415, 1250062654, 1254300323, 1955880556])
    );
    // H_rho
    let nfs = [dg(1), dg(9)];
    let rho0 = digest([1603212827, 2094382249, 1056528495, 59986379, 1078967191, 1191687171, 650718498, 867289535]);
    let rho1 = digest([1732965259, 671099154, 2092728354, 163104313, 640848453, 255301622, 1193769835, 1714681889]);
    assert_eq!(derive_rho(&nfs, 0), rho0);
    assert_eq!(derive_rho(&nfs, 1), rho1);
    assert_eq!(hash_dom_idx(6, 0, &seq(1, 16)), rho0);
    assert_eq!(hash_dom_idx(6, 1, &seq(1, 16)), rho1);
    // one permutation of nf1 ‖ nf2 ‖ [16, 6, k, 0, 0, 0, 0, 0]
    for (k, want) in [(0u32, rho0), (1, rho1)] {
        let mut s = [Felt::ZERO; 24];
        s[..16].copy_from_slice(&seq(1, 16));
        (s[16], s[17], s[18]) = (Felt::from_u32(16), Felt::from_u32(6), Felt::from_u32(k));
        permute(&mut s);
        assert_eq!(&s[..8], &want);
    }
    // output commitment with the derived rho
    assert_eq!(
        Note { value, pk: dg(1), rho: rho0, r }.commitment(),
        digest([527674917, 602702121, 326390822, 1575311313, 1394427594, 1823693299, 866678550, 2070370043])
    );
    // binding
    assert_eq!(binding_from_bytes(b""), digest([1049694149, 1036567868, 77557340, 245308734, 1726537877, 353180042, 580128092, 1381772360]));
    assert_eq!(binding_from_bytes(b"abc"), digest([1198618829, 931526174, 1956969216, 28667118, 22116650, 722833852, 568669320, 419013842]));
    // empty subtrees: levels 1, 2 and 32 as printed; all 33 from vectors.json
    let mut e = vec![ZERO_DIGEST];
    for l in 0..32 {
        e.push(merge(&e[l], &e[l]));
    }
    assert_eq!(e[1], digest([256768056, 1346670833, 169516431, 761082886, 23516395, 1696849271, 1264406107, 218204685]));
    assert_eq!(e[1], hash_dom(5, &[Felt::ZERO; 16]));
    assert_eq!(e[2], digest([1869782978, 1256714202, 1898727018, 1050234623, 586286605, 618690765, 1398433549, 512807105]));
    let e32 = digest([337192190, 2091044999, 403604861, 1802413220, 880295642, 444711869, 850406734, 1912470196]);
    assert_eq!(e[32], e32);
    assert_eq!(SparseTree::new().root(), e32);
    assert_eq!(quantum_vault_shield_v2::pool::empty_tree_root(), digest_to_bytes(&e32));
    let json: serde_json::Value = serde_json::from_slice(&read("vectors.json")).unwrap();
    let levels = json["primitives"]["empty_subtree_by_level_0_to_32"].as_array().unwrap();
    assert_eq!(levels.len(), 33);
    for (l, v) in levels.iter().enumerate() {
        assert_eq!(jd(v), e[l], "empty subtree, level {l}");
    }
    println!("VECTOR|primitives|every row of spec §8.2 and all 33 empty-subtree values reproduced");
}

/// A digest of `vectors.json` (a list of 8 canonical integers).
fn jd(v: &serde_json::Value) -> Digest {
    let a = v.as_array().expect("digest");
    assert_eq!(a.len(), 8);
    core::array::from_fn(|i| {
        let x = a[i].as_u64().unwrap();
        assert!(x < MODULUS as u64);
        Felt::from_u32(x as u32)
    })
}

fn ju(v: &serde_json::Value) -> u64 {
    v.as_str().expect("amount as a decimal string").parse().unwrap()
}

#[test]
fn vectors_json_witnesses() {
    let json: serde_json::Value = serde_json::from_slice(&read("vectors.json")).unwrap();
    let vectors = json["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 3);
    for (v, name) in vectors.iter().zip(NAMES) {
        assert_eq!(v["name"], name);
        let (public, pi, proof) = vector(name);
        assert_eq!(v["public_bytes_hex"], hex(&public));
        assert_eq!(v["proof_bytes"], proof.len());
        assert_eq!(v["proof_blake3"], blake3::hash(&proof).to_hex().to_string());
        let p = &v["public"];
        let from_json = PublicInputs {
            anchor: jd(&p["anchor"]),
            nf: [jd(&p["nf1"]), jd(&p["nf2"])],
            cm_out: [jd(&p["cm_out1"]), jd(&p["cm_out2"])],
            v_in: ju(&p["v_in"]),
            v_out: ju(&p["v_out"]),
            fee: ju(&p["fee"]),
            binding: jd(&p["binding"]),
        };
        assert_eq!(from_json, pi, "{name}");
        // the statement of spec §2.7, item by item, from the private values
        let mut value_in = 0u128;
        for (i, inp) in v["witness"]["inputs"].as_array().unwrap().iter().enumerate() {
            let (sk, rho, r) = (jd(&inp["sk"]), jd(&inp["rho"]), jd(&inp["r"]));
            let value = ju(&inp["value"]);
            let enabled = inp["enabled"].as_bool().unwrap();
            assert_eq!(derive_nk(&sk), jd(&inp["nk"]));
            assert_eq!(derive_pk(&sk), jd(&inp["pk"]));
            assert_eq!(nullifier(&derive_nk(&sk), &rho), pi.nf[i], "{name}: item 1, input {i}");
            assert_eq!(pi.nf[i], jd(&inp["nf"]));
            let cm = Note { value, pk: derive_pk(&sk), rho, r }.commitment();
            assert_eq!(cm, jd(&inp["cm"]));
            let path: Vec<Digest> = inp["path"].as_array().unwrap().iter().map(jd).collect();
            let path: [Digest; 32] = path.try_into().unwrap();
            let root = root_from_path(&cm, inp["index"].as_u64().unwrap() as u32, &path);
            assert_eq!(root, jd(&inp["path_root"]));
            if enabled {
                assert_eq!(root, pi.anchor, "{name}: item 2, input {i}");
            } else {
                assert_eq!(value, 0, "{name}: item 2, dummy input {i}");
            }
            value_in += value as u128;
        }
        let mut value_out = 0u128;
        for (j, out) in v["witness"]["outputs"].as_array().unwrap().iter().enumerate() {
            let value = ju(&out["value"]);
            let rho = derive_rho(&pi.nf, j);
            assert_eq!(rho, jd(&out[format!("rho = H_rho(nf1, nf2, {j})")]));
            let note = Note { value, pk: jd(&out["pk"]), rho, r: jd(&out["r"]) };
            assert_eq!(note.commitment(), pi.cm_out[j], "{name}: item 3, output {j}");
            assert_eq!(pi.cm_out[j], jd(&out["cm"]));
            // the recipient's check of spec §2.4.1
            assert_eq!(receive_note(&pi, j, &note.pk, value, &note.r), Some(note));
            assert!(receive_note(&pi, 1 - j, &note.pk, value, &note.r).is_none(), "wrong output index");
            assert!(receive_note(&pi, j, &note.pk, value + 1, &note.r).is_none(), "wrong value");
            value_out += value as u128;
        }
        assert_eq!(value_in + pi.v_in as u128, value_out + pi.v_out as u128 + pi.fee as u128, "{name}: item 4");
        assert_ne!(pi.nf[0], pi.nf[1], "{name}: item 5");
        assert_eq!(v["verify"], true);
        assert_eq!(v["verify_with_fee_plus_1"], false);
        println!("VECTOR|{name}|every private value of vectors.json recomputed; the statement of spec §2.7 holds");
    }
}

#[test]
fn committed_vectors_verify() {
    for name in NAMES {
        let (public, pi, proof) = vector(name);
        assert_eq!(pi.to_bytes(), public);
        verify_spend(&pi, &proof).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        // every public field is bound
        let mut n = 0;
        for byte in (0..PUBLIC_INPUT_BYTES).step_by(4) {
            let mut b = public.clone();
            b[byte] ^= 1;
            let Some(bad) = PublicInputs::from_bytes(&b) else { continue };
            assert!(verify_spend(&bad, &proof).is_err(), "{name}: altered public byte {byte} accepted");
            n += 1;
        }
        let swapped = PublicInputs { nf: [pi.nf[1], pi.nf[0]], ..pi.clone() };
        assert!(verify_spend(&swapped, &proof).is_err());
        let same = PublicInputs { nf: [pi.nf[0], pi.nf[0]], ..pi.clone() };
        assert!(format!("{:?}", verify_spend(&same, &proof).unwrap_err()).starts_with("DuplicateNullifier"));
        // a proof never verifies against another vector's statement
        for other in NAMES.iter().filter(|o| **o != name) {
            assert!(verify_spend(&vector(other).1, &proof).is_err(), "{name} proof accepted for the {other} statement");
        }
        println!("VECTOR|{name}|{} proof bytes|verifies; {n} single-bit alterations of the public inputs all refused", proof.len());
    }
}

/// With the `test-prover` feature: the reference implementation derives the same statement from
/// the same witness seed, and the proof bytes are reproducible from the witness and the fixed
/// blinding seed of spec §8.3.
#[cfg(feature = "test-prover")]
#[test]
fn committed_vectors_are_reproducible() {
    use quantum_vault_shield_v2::trace::honest_trace;
    use quantum_vault_shield_v2::verifier::prove_spend;
    for (name, kind, seed, blind) in
        [("shield", Kind::Shield, 1u64, 0x11u8), ("transfer", Kind::Transfer, 2, 0x22), ("unshield", Kind::Unshield, 3, 0x33)]
    {
        let (_, pi, proof) = vector(name);
        let js = sample(kind, seed);
        assert_eq!(js.public(), pi, "{name}");
        js.check().unwrap();
        for j in 0..2 {
            let o = js.outputs[j];
            assert_eq!(receive_note(&pi, j, &o.pk, o.value, &o.r).map(|n| n.commitment()), Some(pi.cm_out[j]));
        }
        let again = prove_spend(honest_trace(&js), &pi, [blind; 32]).unwrap();
        assert_eq!(again, proof, "{name}: proof bytes are not reproducible");
        println!("VECTOR|{name}|proof bytes reproduced from the witness seed and the blinding seed of spec §8.3");
    }
}

#[test]
fn spec_8_3_expected_results() {
    for name in NAMES {
        let (public, pi, proof) = vector(name);
        // accept
        verify_spend(&pi, &proof).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        // with fee + 1: refuse
        let mut bad = pi.clone();
        bad.fee += 1;
        assert!(verify_spend(&bad, &proof).is_err(), "{name}: fee + 1 accepted");
        // with any single bit of the 216 public bytes flipped: refuse
        let (mut by_verifier, mut by_decoder) = (0, 0);
        for bit in 0..8 * PUBLIC_INPUT_BYTES {
            let mut b = public.clone();
            b[bit / 8] ^= 1 << (bit % 8);
            match PublicInputs::from_bytes(&b) {
                None => by_decoder += 1,
                Some(other) => {
                    assert_ne!(other, pi);
                    assert!(verify_spend(&other, &proof).is_err(), "{name}: public bit {bit} flipped and accepted");
                    by_verifier += 1;
                }
            }
        }
        assert_eq!(by_verifier + by_decoder, 1728);
        // with nf2 := nf1: refuse
        let same = PublicInputs { nf: [pi.nf[0], pi.nf[0]], ..pi.clone() };
        assert!(verify_spend(&same, &proof).is_err(), "{name}: nf2 := nf1 accepted");
        // with the proof's last varint re-encoded non-minimally: refuse
        let n = proof.len();
        assert_eq!(&proof[n - 5..], &[0x0d, 0, 0, 0, 0]);
        let mut v = proof[..n - 5].to_vec();
        v.extend_from_slice(&[0x8d, 0x00]);
        v.extend_from_slice(&proof[n - 4..]);
        let e = verify_spend(&pi, &v).expect_err("non-minimal varint accepted");
        assert!(format!("{e:?}").starts_with("NonCanonicalEncoding"), "{name}: {e:?}");
        println!("VECTOR|{name}|spec §8.3: accept; fee + 1, nf2 := nf1, non-minimal last varint refused; 1728 single-bit flips of the public bytes: {by_verifier} refused by verify_spend, {by_decoder} by the strict decoder, 0 accepted");
    }
}
