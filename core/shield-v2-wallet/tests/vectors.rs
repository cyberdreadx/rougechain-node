//! The wallet test vectors of spec §8.4 (closes open issue O-15): key derivation, the shielded
//! address, note encryption, the body and binding of one transaction of each type, and the
//! state-root section after applying those three transactions through the pool rules.
//!
//! The committed files are `core/shield-v2/vectors/wallet/*.json`. This test regenerates every
//! value and compares; `SHIELD_V2_WRITE_VECTORS=1` writes the files instead. Generation is
//! deterministic only through the `test-vectors` hooks (a labelled SHA-256 stream instead of the
//! operating system's generator); the proof blinding is not part of any vector and cannot be
//! fixed from here. The node side of the cross-check — the daemon's own body parser and pool
//! store on the same files — is `node::shield_v2_wallet_interop_tests` in the daemon.

mod common;

use common::*;
use hkdf::Hkdf;
use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolState};
use quantum_vault_shield_v2::reference::{
    binding_from_bytes, derive_nk, derive_pk, derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Digest, Note,
    PublicInputs,
};
use quantum_vault_shield_v2::SpendWitness;
use quantum_vault_shield_v2_wallet::body::{binding_bytes, chain_tag, Body};
use quantum_vault_shield_v2_wallet::note_enc::{decrypt_note_with_key, encrypt_note_with_kem_randomness};
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

const P: u64 = 0x7f00_0001;

fn hx(b: &[u8]) -> String {
    hex::encode(b)
}
fn dg(d: &Digest) -> String {
    hx(&digest_to_bytes(d))
}
fn elements(b: &[u8; 32]) -> Vec<u32> {
    (0..8).map(|i| u32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]])).collect()
}

/// Key derivation (spec §5.2), with the HKDF outputs recomputed here independently of the crate.
fn key_vector(name: &str, phrase: &str) -> Value {
    let seed = bip39_seed(phrase, "").unwrap();
    let keys = ShieldedKeys::from_seed(&seed[..]).unwrap();
    let (sk, nk, pk, ek, dk) = keys.expose_for_vectors();

    let hk = Hkdf::<Sha256>::new(None, &seed[..]);
    let (mut sk_okm, mut view_okm) = ([0u8; 64], [0u8; 64]);
    hk.expand(b"rouge-shield/sk", &mut sk_okm).unwrap();
    hk.expand(b"rouge-shield/view", &mut view_okm).unwrap();
    let reduced: Vec<u32> = (0..8).map(|i| (u64::from_le_bytes(sk_okm[8 * i..8 * i + 8].try_into().unwrap()) % P) as u32).collect();
    assert_eq!(reduced, elements(&sk), "sk[i] = (LE u64 of okm[8i..8i+8]) mod p");
    let skd = digest_from_bytes(&sk).unwrap();
    assert_eq!(digest_to_bytes(&derive_nk(&skd)), nk);
    assert_eq!(digest_to_bytes(&derive_pk(&skd)), pk);

    let addr = keys.address();
    assert_eq!(addr.to_bytes(), [pk.to_vec(), ek.clone()].concat());
    let text = addr.encode();
    assert_eq!(ShieldedAddress::decode(&text).unwrap(), addr);
    json!({
        "name": name,
        "recovery_phrase": phrase,
        "passphrase": "",
        "bip39_seed": hx(&seed[..]),
        "sk_hkdf_info": "rouge-shield/sk",
        "sk_okm": hx(&sk_okm),
        "sk_elements": reduced,
        "sk": hx(&sk),
        "nk": hx(&nk),
        "nk_elements": elements(&nk),
        "pk": hx(&pk),
        "pk_elements": elements(&pk),
        "view_hkdf_info": "rouge-shield/view",
        "view_okm": hx(&view_okm),
        "ml_kem_768_d": hx(&view_okm[..32]),
        "ml_kem_768_z": hx(&view_okm[32..]),
        "ml_kem_768_ek": hx(&ek),
        "ml_kem_768_dk": hx(&dk),
        "ml_kem_768_dk_sha256": hx(&Sha256::digest(&dk)),
        "address_bytes_sha256": hx(&Sha256::digest(addr.to_bytes())),
        "address_fingerprint": addr.fingerprint(),
        "address": text,
    })
}

/// Note encryption (spec §3.4) with the encapsulation randomness fixed.
fn note_vector() -> Value {
    let keys = keys(PHRASE_1);
    let (_, _, _, ek, dk) = keys.expose_for_vectors();
    let f = |a: u32| -> Digest { digest_from_bytes(&(a..a + 8).flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>()).unwrap() };
    // the commitment vector of spec §8.2: value 0x0123456789abcdef, pk = 1..8, rho = 9..16, r = 21..28
    let value = 0x0123_4567_89ab_cdefu64;
    let r = f(21);
    let cm = Note { value, pk: f(1), rho: f(9), r }.commitment();
    assert_eq!(
        elements(&digest_to_bytes(&cm)),
        vec![350137339, 1849492580, 947277798, 542868595, 1789965415, 1250062654, 1254300323, 1955880556],
        "spec §8.2"
    );
    let (cm_b, r_b) = (digest_to_bytes(&cm), digest_to_bytes(&r));
    let m: [u8; 32] = core::array::from_fn(|i| i as u8);
    let (kem_ct, note_ct, ss) = encrypt_note_with_kem_randomness(&addr_ek(&ek), &cm_b, value, &r_b, m).unwrap();
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), &ss).expand(b"rouge-shield/v2/note", &mut key).unwrap();
    assert_eq!(decrypt_note_with_key(&dk, &kem_ct, &note_ct, &cm_b), Some((value, r_b)));
    let other = common::keys(PHRASE_2).expose_for_vectors().4;
    assert_eq!(decrypt_note_with_key(&other, &kem_ct, &note_ct, &cm_b), None);
    json!({
        "recipient": "wallet-1 (keys.json)",
        "value": value.to_string(),
        "r": hx(&r_b),
        "cm_out": hx(&cm_b),
        "ml_kem_768_encaps_randomness_m": hx(&m),
        "kem_ct": hx(&kem_ct),
        "shared_secret": hx(&ss),
        "hkdf_salt": hx(&[0u8; 32]),
        "hkdf_info": "rouge-shield/v2/note",
        "aes_256_gcm_key": hx(&key),
        "aes_256_gcm_nonce": hx(&[0u8; 12]),
        "aad": hx(&cm_b),
        "plaintext": hx(&[value.to_le_bytes().to_vec(), r_b.to_vec()].concat()),
        "note_ct": hx(&note_ct),
    })
}

fn addr_ek(ek: &[u8]) -> [u8; 1184] {
    ek.try_into().unwrap()
}

fn witness_json(w: &SpendWitness, nf: &[Digest; 2]) -> Value {
    json!({
        "inputs": w.inputs.iter().map(|i| json!({
            "enabled": i.enabled,
            "sk": dg(&i.sk),
            "value": i.value.to_string(),
            "rho": dg(&i.rho),
            "r": dg(&i.r),
            "index": i.index,
            "path": i.path.iter().map(dg).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "outputs": w.outputs.iter().enumerate().map(|(j, o)| json!({
            "value": o.value.to_string(),
            "pk": dg(&o.pk),
            "r": dg(&o.r),
            "rho": dg(&derive_rho(nf, j)),
        })).collect::<Vec<_>>(),
    })
}

fn state_json(st: &PoolState, root_before: &str) -> Value {
    json!({
        "pool_total": st.pool_total.to_string(),
        "note_count": st.note_count,
        "tree_root": hx(&st.tree_root),
        "frontier": st.frontier.iter().map(|f| hx(f)).collect::<Vec<_>>(),
        "nullifier_count": st.nullifier_count,
        "nullifier_acc": hx(&st.nullifier_acc),
        "window": st.window.iter().map(|w| hx(w)).collect::<Vec<_>>(),
        "root_before": root_before,
        "root_after": st.state_root_section(root_before).unwrap(),
    })
}

/// One transaction of each type, chained: the shield's note is spent by the transfer, the
/// transfer's change by the unshield. Returns (transactions.json, state_root.json).
fn tx_and_state_vectors() -> (Value, Value) {
    let (w1, w2) = (keys(PHRASE_1), keys(PHRASE_2));
    let account_key = fake_account_key(0xa5);
    let recipient_account = [0x5a; 32];
    let root_before = hx(&Sha256::digest(b"rougechain shield_v2 wallet vectors: state root before the pool section"));
    let mut pool = Pool::open_or_init(MemoryPoolStore::new(), A).unwrap();
    let mut chain = Chain::new();
    let mut states = vec![json!({ "after": "activation, before any transaction", "state": state_json(&pool.state().unwrap(), &root_before) })];
    let mut txs = Vec::new();

    let record = |name: &str, tx: &UnprovenTx, chain: &mut Chain, pool: &mut Pool<MemoryPoolStore>, extra: Value, reads: Value| {
        let body = Body::decode(&tx.body).unwrap();
        assert_eq!(body.encode(), tx.body);
        assert_eq!(body.chain, chain_tag(CHAIN));
        // binding and public inputs as the node derives them (spec §3.6 check 20)
        let binding = binding_from_bytes(&tx.body);
        assert_eq!(digest_to_bytes(&binding), tx.binding);
        assert_eq!(binding_bytes(&tx.body), tx.binding);
        let public = [tx.body[42..226].to_vec(), tx.binding.to_vec()].concat();
        assert_eq!(PublicInputs::from_bytes(&public).unwrap(), tx.public);
        // the witness satisfies the statement for these public inputs
        quantum_vault_shield_v2::prover::check_statement(&tx.witness, &tx.public).expect("statement");
        let nf = tx.public.nf;
        for (i, inp) in tx.witness.inputs.iter().enumerate() {
            assert_eq!(nullifier(&derive_nk(&inp.sk), &inp.rho), nf[i]);
        }
        let height = chain.height + 1;
        chain.block(&[&tx.body]).unwrap();
        pool.apply_block(height, &[pool_tx(&tx.body)]).unwrap();
        assert_eq!(pool.state().unwrap(), chain.state());
        let mut v = json!({
            "name": name,
            "tx_type": tx.kind.tx_type(),
            "kind": tx.kind.byte(),
            "height": height,
            "expiry_height": body.expiry_height,
            "anchor": hx(&body.anchor),
            "nf1": hx(&body.nf[0]),
            "nf2": hx(&body.nf[1]),
            "cm_out1": hx(&body.cm_out[0]),
            "cm_out2": hx(&body.cm_out[1]),
            "v_in": body.v_in.to_string(),
            "v_out": body.v_out.to_string(),
            "fee": body.fee.to_string(),
            "account": hx(&body.account),
            "outputs": tx.outputs.iter().map(|o| json!({
                "slot": o.slot, "role": format!("{:?}", o.role).to_lowercase(), "value": o.value.to_string(), "r": hx(&o.r), "cm": hx(&o.cm),
            })).collect::<Vec<_>>(),
            "readable_by": reads,
            "witness": witness_json(&tx.witness, &nf),
            "body": hx(&tx.body),
            "body_sha256": hx(&Sha256::digest(&tx.body)),
            "binding": hx(&tx.binding),
            "binding_elements": elements(&tx.binding),
            "public_inputs": hx(&public),
        });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };

    // 1. shield: 10 XRGE from the account, fee 1, a 9 XRGE note for wallet-1
    let shield = deterministic::shield(
        &ShieldRequest { ctx: chain.ctx(), from_pub_key: &account_key, nonce: 1, v_in: 10 * Q, fee: Q, recipient: &w1.address() },
        "spec-8.4/shield",
    )
    .unwrap();
    let t = record(
        "shield",
        &shield,
        &mut chain,
        &mut pool,
        json!({ "from_pub_key_sha256": hx(&Sha256::digest(&account_key)), "from_pub_key_note": "1,952 arbitrary bytes b[i] = (29 i + 0xa5) mod 256; not a valid ML-DSA-65 key — only its SHA-256 enters the body" }),
        json!({ "wallet-1": "the payment slot" }),
    );
    txs.push(t);
    states.push(json!({ "after": "shield", "height": chain.height, "state": state_json(&pool.state().unwrap(), &root_before) }));

    let mut s1 = WalletState::new(w1.address().pk);
    s1.scan(&chain.page(0), &w1.scan_key()).unwrap();
    assert_eq!((s1.balance(), s1.anchor()), (9 * Q as u128, chain.state().tree_root));

    // 2. transfer: wallet-1 pays wallet-2 5 XRGE, fee 1, change 3
    let inputs = [s1.spend_input(s1.notes()[0].position).unwrap()];
    let transfer = deterministic::transfer(
        &TransferRequest { ctx: chain.ctx(), keys: &w1, inputs: &inputs, recipient: &w2.address(), amount: 5 * Q, fee: Q },
        "spec-8.4/transfer",
    )
    .unwrap();
    let t = record("transfer", &transfer, &mut chain, &mut pool, json!({}), json!({ "wallet-2": "the payment slot", "wallet-1": "the change slot" }));
    txs.push(t);
    states.push(json!({ "after": "transfer", "height": chain.height, "state": state_json(&pool.state().unwrap(), &root_before) }));
    s1.scan(&chain.page(s1.next_height()), &w1.scan_key()).unwrap();
    assert_eq!(s1.balance(), 3 * Q as u128);
    let mut s2 = WalletState::new(w2.address().pk);
    s2.scan(&chain.page(0), &w2.scan_key()).unwrap();
    assert_eq!(s2.balance(), 5 * Q as u128);

    // 3. unshield: wallet-1 pays 1.5 XRGE out of its 3 XRGE change, fee 1, change 0.5
    let change = s1.unspent().find(|n| n.value == 3 * Q).unwrap().position;
    let inputs = [s1.spend_input(change).unwrap()];
    let unshield = deterministic::unshield(
        &UnshieldRequest { ctx: chain.ctx(), keys: &w1, inputs: &inputs, to_account: recipient_account, v_out: 3 * Q / 2, fee: Q },
        "spec-8.4/unshield",
    )
    .unwrap();
    let t = record(
        "unshield",
        &unshield,
        &mut chain,
        &mut pool,
        json!({ "recipient_address": address_from_account(&recipient_account) }),
        json!({ "wallet-1": "the change slot" }),
    );
    txs.push(t);
    states.push(json!({ "after": "unshield", "height": chain.height, "state": state_json(&pool.state().unwrap(), &root_before) }));
    s1.scan(&chain.page(s1.next_height()), &w1.scan_key()).unwrap();
    assert_eq!(s1.balance(), Q as u128 / 2);
    assert_eq!(pool.state().unwrap().pool_total, (9 * Q - Q - 3 * Q / 2 - Q) as u128);

    let transactions = json!({
        "chain_id": CHAIN,
        "chain": hx(&chain_tag(CHAIN)),
        "activation_height": A,
        "note": "Bodies of spec §3.2 and their bindings (spec §2.8). No proof is part of these vectors: a proof's blinding is drawn inside the prover (spec §5.6) and is not reproducible. Every random choice of the wallet is given through the witness and the ciphertexts inside the body.",
        "wallets": { "wallet-1": PHRASE_1, "wallet-2": PHRASE_2 },
        "transactions": txs,
    });
    let state_root = json!({
        "note": "Spec §4.8: the pool section of the state root after each block, for the pool state reached by applying the transactions of transactions.json in order, one per block, from activation height 3. root_before is an arbitrary fixed 64-character string standing in for the root of the preceding extensions.",
        "activation_height": A,
        "states": states,
    });
    (transactions, state_root)
}

fn all_vectors() -> Vec<(&'static str, Value)> {
    let (transactions, state_root) = tx_and_state_vectors();
    vec![
        ("keys.json", json!({
            "note": "Spec §5.2 key derivation and the spec §5.3 shielded address (bech32m, prefix rshield).",
            "wallets": [key_vector("wallet-1", PHRASE_1), key_vector("wallet-2", PHRASE_2)],
        })),
        ("note_encryption.json", note_vector()),
        ("transactions.json", transactions),
        ("state_root.json", state_root),
    ]
}

#[test]
fn wallet_vectors_match_the_committed_files() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../shield-v2/vectors/wallet");
    let write = std::env::var("SHIELD_V2_WRITE_VECTORS").is_ok_and(|v| v == "1");
    if write {
        std::fs::create_dir_all(dir).unwrap();
    }
    for (name, value) in all_vectors() {
        let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
        let path = format!("{dir}/{name}");
        if write {
            std::fs::write(&path, &text).unwrap();
        } else {
            let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (generate with SHIELD_V2_WRITE_VECTORS=1)"));
            assert!(committed == text, "{name} differs from the regenerated vector");
        }
    }
}

/// The vectors are reproducible: two generations in one process are identical.
#[test]
fn generation_is_deterministic() {
    let (a, b) = (all_vectors(), all_vectors());
    for ((na, va), (_, vb)) in a.iter().zip(&b) {
        assert!(va == vb, "{na}");
    }
}

/// A reader's view of the committed transactions: each body decodes, its ciphertexts open for
/// the wallets the file names (and only for them), and the recipient check of spec §2.4.1 holds
/// with the rho derived from the body's own nullifiers.
#[test]
fn committed_transactions_are_readable_by_the_named_wallets() {
    let (transactions, _) = tx_and_state_vectors();
    let wallets = [("wallet-1", keys(PHRASE_1)), ("wallet-2", keys(PHRASE_2))];
    for tx in transactions["transactions"].as_array().unwrap() {
        let body = Body::decode(&hex::decode(tx["body"].as_str().unwrap()).unwrap()).unwrap();
        let nf = [digest_from_bytes(&body.nf[0]).unwrap(), digest_from_bytes(&body.nf[1]).unwrap()];
        for (name, k) in &wallets {
            let (_, _, pk, _, dk) = k.expose_for_vectors();
            let mut found = 0;
            for j in 0..2 {
                if let Some((value, r)) = decrypt_note_with_key(&dk, &body.kem_ct[j], &body.note_ct[j], &body.cm_out[j]) {
                    let note = Note { value, pk: digest_from_bytes(&pk).unwrap(), rho: derive_rho(&nf, j), r: digest_from_bytes(&r).unwrap() };
                    assert_eq!(digest_to_bytes(&note.commitment()), body.cm_out[j]);
                    found += 1;
                }
            }
            assert_eq!(found, tx["readable_by"].get(*name).is_some() as usize, "{} / {name}", tx["name"]);
        }
    }
}
