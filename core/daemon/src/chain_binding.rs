//! Network binding of signatures — every signature commits to the chain it is meant for.
//!
//! Two layers:
//!
//! * **Node rule (API, mempool, producer — node-local, no fork).** A signed payload — the
//!   `/api/v2/*` client format, a signed request (mail, messenger, names, votes) or a `rougechain`
//!   CLI envelope — that names a network (`chainId`, or `chain_id` in a CLI envelope) is refused
//!   unless it names this node's chain id ([`MISMATCH_CODE`]). With the operator flag
//!   `REQUIRE_SIGNED_CHAIN_ID` (`--require-signed-chain-id` / `QV_REQUIRE_SIGNED_CHAIN_ID=true`,
//!   default off) a signed payload that names no network is refused too ([`REQUIRED_CODE`]).
//!
//! * **Consensus rule CHAIN_ID_BINDING (fork; activation `None` on every network).** From the
//!   activation height a block is invalid if any transaction's signed bytes do not commit to the
//!   chain id (see [`consensus_tx_rule`] and [`signature_valid_chain_bound`]):
//!     - a transaction with `signed_payload` must be signed over exactly those bytes (no fallback
//!       to another format), and the JSON must carry the chain id: `chainId` in the `/api/v2`
//!       format, `chain_id` in a CLI envelope, equal to the chain id as an exact string;
//!     - a transaction without `signed_payload` (the V1 format, used for node-signed
//!       transactions) must be signed over `encode_tx_for_signing_chain` — the unchanged V1
//!       encoding behind a domain-separated, length-prefixed chain id. The plain V1 encoding and
//!       the legacy full-struct encoding are refused;
//!     - SHIELD_V2 transactions already commit to the network: their body carries
//!       `sha256(chain id)` and `shield_v2_tx_rule` refuses another one. A `shield_v2` (the
//!       account-signed type) may therefore keep the plain V1 encoding, which covers the body;
//!       the signer-less types have no account signature at all.
//!   Before activation nothing here runs, so acceptance, execution and storage are byte-identical
//!   to the previous release.
use std::sync::OnceLock;

use quantum_vault_crypto::pqc_verify;
use quantum_vault_types::{encode_tx_for_signing, encode_tx_for_signing_chain, TxV1};
use serde_json::Value;

/// Error code prefix: the payload names a different network than this node's.
pub const MISMATCH_CODE: &str = "CHAIN_ID_MISMATCH";
/// Error code prefix: the payload names no network and this node requires one.
pub const REQUIRED_CODE: &str = "CHAIN_ID_REQUIRED";
/// Field of the `/api/v2` client format and of signed requests.
pub const PAYLOAD_FIELD: &str = "chainId";
/// Field of the `rougechain` CLI envelope.
pub const ENVELOPE_FIELD: &str = "chain_id";

/// CHAIN_ID_BINDING consensus activation (mainnet schedule). `None` = not scheduled; the
/// per-network height lives in `upgrades.rs`.
pub const CHAIN_ID_BINDING_ACTIVATION_HEIGHT: Option<u64> = None;

#[cfg(test)]
thread_local! {
    static TEST_OVERRIDE: std::cell::Cell<Option<Option<u64>>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_test_chain_id_binding(h: Option<u64>) {
    TEST_OVERRIDE.with(|c| c.set(Some(h)));
}

/// Is the CHAIN_ID_BINDING consensus rule in force for the block at `height`? (The test override
/// is thread-local: evaluate it once outside parallel workers.)
#[inline]
pub fn chain_id_binding_active(height: u64) -> bool {
    #[cfg(test)]
    {
        if let Some(h) = TEST_OVERRIDE.with(|c| c.get()) {
            return matches!(h, Some(a) if height >= a);
        }
    }
    matches!(crate::upgrades::current().chain_id_binding, Some(a) if height >= a)
}

// ---- process configuration (node rule for the API handlers, which have no node handle) ----------

struct Config {
    chain_id: String,
    require: bool,
}
static CONFIG: OnceLock<Config> = OnceLock::new();

/// Set this process's chain id and the `REQUIRE_SIGNED_CHAIN_ID` flag. Call once at startup.
pub fn init(chain_id: &str, require: bool) {
    let _ = CONFIG.set(Config { chain_id: chain_id.to_string(), require });
}

#[cfg(test)]
thread_local! {
    static TEST_REQUIRE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_test_require(v: Option<bool>) {
    TEST_REQUIRE.with(|c| c.set(v));
}

/// Is `REQUIRE_SIGNED_CHAIN_ID` on for this process? (Off when never initialised.)
pub fn require_signed() -> bool {
    #[cfg(test)]
    {
        if let Some(v) = TEST_REQUIRE.with(|c| c.get()) { return v; }
    }
    CONFIG.get().map_or(false, |c| c.require)
}

/// The rule for an API-submitted signed payload, with the process configuration. A process that
/// never called [`init`] (unit tests of unrelated handlers) applies nothing.
pub fn check_api_payload(p: &Value) -> Result<(), String> {
    #[cfg(test)]
    {
        if let Some(id) = TEST_CHAIN.with(|c| c.borrow().clone()) {
            return check_signed_payload(p, &id, require_signed());
        }
    }
    match CONFIG.get() {
        Some(c) => check_signed_payload(p, &c.chain_id, require_signed()),
        None => Ok(()),
    }
}

#[cfg(test)]
thread_local! {
    static TEST_CHAIN: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}
/// Test hook: the chain id the API rule uses on this thread (`None` = the process configuration).
#[cfg(test)]
pub(crate) fn set_test_api_chain_id(id: Option<&str>) {
    TEST_CHAIN.with(|c| *c.borrow_mut() = id.map(String::from));
}

/// Node rule for one signed JSON payload (pure). Every network field present must be a string
/// equal to `chain_id`; with `require`, the format's own field (`chain_id` for a CLI envelope,
/// `chainId` otherwise) must be present.
pub fn check_signed_payload(p: &Value, chain_id: &str, require: bool) -> Result<(), String> {
    let Some(obj) = p.as_object() else { return Ok(()) };
    for field in [PAYLOAD_FIELD, ENVELOPE_FIELD] {
        if let Some(v) = obj.get(field) {
            match v.as_str() {
                Some(s) if s == chain_id => {}
                Some(s) => return Err(format!("{}: payload is signed for network '{}', this node is '{}'", MISMATCH_CODE, s, chain_id)),
                None => return Err(format!("{}: '{}' must be the chain id string '{}'", MISMATCH_CODE, field, chain_id)),
            }
        }
    }
    if require && !obj.contains_key(own_field(p)) {
        return Err(format!("{}: signed payloads must name the network ('{}': '{}')", REQUIRED_CODE, own_field(p), chain_id));
    }
    Ok(())
}

fn own_field(p: &Value) -> &'static str {
    if crate::v2_binding::is_cli_envelope(p) { ENVELOPE_FIELD } else { PAYLOAD_FIELD }
}

/// Node rule for a transaction (mempool admission, producer): applies [`check_signed_payload`] to
/// its `signed_payload`. A transaction without one (the V1 format) is bound only by the consensus
/// rule; a `signed_payload` that is not JSON is left to the binding rule, which refuses it.
pub fn local_tx_rule(tx: &TxV1, chain_id: &str, require: bool) -> Result<(), String> {
    let Some(sp) = tx.signed_payload.as_deref() else { return Ok(()) };
    let Ok(p) = serde_json::from_str::<Value>(sp) else { return Ok(()) };
    check_signed_payload(&p, chain_id, require)
}

/// CHAIN_ID_BINDING consensus rule, payload half: from activation, a transaction's
/// `signed_payload` must carry the chain id (`chainId`, or `chain_id` in a CLI envelope) as
/// exactly `chain_id`. SHIELD_V2 types are exempt (their body commits to the chain and
/// `shield_v2_tx_rule` checks it). The signature half is [`signature_valid_chain_bound`].
pub fn consensus_tx_rule(tx: &TxV1, height: u64, chain_id: &str) -> Result<(), String> {
    if !chain_id_binding_active(height) || crate::shield_v2::is_shield_v2_type(&tx.tx_type) {
        return Ok(());
    }
    let Some(sp) = tx.signed_payload.as_deref() else { return Ok(()) };
    let p: Value = serde_json::from_str(sp).map_err(|e| format!("{}: signed_payload is not valid JSON: {}", REQUIRED_CODE, e))?;
    let field = own_field(&p);
    match p.get(field).and_then(|v| v.as_str()) {
        Some(s) if s == chain_id => Ok(()),
        Some(s) => Err(format!("{}: signed_payload names network '{}', this chain is '{}'", MISMATCH_CODE, s, chain_id)),
        None => Err(format!("{}: signed_payload must carry '{}' (the chain id) from the CHAIN_ID_BINDING upgrade", REQUIRED_CODE, field)),
    }
}

/// CHAIN_ID_BINDING consensus rule, signature half (judged only from activation; the caller
/// handles the SHIELD_V2 signer-less exemption, which is itself only in force from SHIELD_V2's
/// activation): is `tx.sig` valid in a format that commits to `chain_id`?
pub fn signature_valid_chain_bound(tx: &TxV1, chain_id: &str, authority_keys: &[String]) -> bool {
    let ok = |key: &str, bytes: &[u8]| pqc_verify(key, bytes, &tx.sig).ok() == Some(true);
    if let Some(sp) = tx.signed_payload.as_deref() {
        // only the signed payload, which `consensus_tx_rule` requires to carry the chain id
        return ok(&tx.from_pub_key, sp.as_bytes());
    }
    let bound = encode_tx_for_signing_chain(tx, chain_id);
    if ok(&tx.from_pub_key, &bound) {
        return true;
    }
    if tx.tx_type == crate::shield_v2::SHIELD_TX_TYPE && ok(&tx.from_pub_key, &encode_tx_for_signing(tx)) {
        return true; // the signed body carries the chain tag
    }
    // Authority-cosigned bridge withdrawal (see node::import_block), in the bound format.
    tx.tx_type == "bridge_withdraw" && authority_keys.iter().any(|k| ok(k, &bound))
}

/// The bytes a node signs for a V1-format transaction that goes into the block at `height`:
/// the network-bound encoding from CHAIN_ID_BINDING activation, the plain one before it.
pub fn v1_signing_bytes(tx: &TxV1, chain_id: &str, height: u64) -> Vec<u8> {
    if chain_id_binding_active(height) {
        encode_tx_for_signing_chain(tx, chain_id)
    } else {
        encode_tx_for_signing(tx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quantum_vault_crypto::{pqc_keygen, pqc_sign};
    use quantum_vault_types::TxPayload;
    use serde_json::json;

    const MAIN: &str = "rougechain-mainnet-1";
    const TEST: &str = "rougechain-devnet-1";

    #[test]
    fn signed_payload_rule_matching_mismatching_missing() {
        for p in [json!({"type": "transfer", "chainId": MAIN}), json!({"tx_type": "stake", "payload": {}, "chain_id": MAIN})] {
            assert!(check_signed_payload(&p, MAIN, false).is_ok(), "{p}");
            assert!(check_signed_payload(&p, MAIN, true).is_ok(), "{p}");
            let e = check_signed_payload(&p, TEST, false).unwrap_err();
            assert!(e.starts_with(MISMATCH_CODE), "{e}");
        }
        for bad in [json!({"chainId": 1}), json!({"chainId": null}), json!({"chainId": "ROUGECHAIN-MAINNET-1"}), json!({"chainId": MAIN, "chain_id": TEST})] {
            assert!(check_signed_payload(&bad, MAIN, false).unwrap_err().starts_with(MISMATCH_CODE), "{bad}");
        }
        let missing = json!({"type": "transfer"});
        assert!(check_signed_payload(&missing, MAIN, false).is_ok());
        assert!(check_signed_payload(&missing, MAIN, true).unwrap_err().starts_with(REQUIRED_CODE));
        // a CLI envelope must use its own field when required
        let env_wrong_field = json!({"tx_type": "stake", "payload": {}, "chainId": MAIN});
        assert!(check_signed_payload(&env_wrong_field, MAIN, false).is_ok());
        assert!(check_signed_payload(&env_wrong_field, MAIN, true).unwrap_err().starts_with(REQUIRED_CODE));
    }

    fn tx(sp: Option<&str>) -> TxV1 {
        TxV1 { version: 1, tx_type: "transfer".into(), from_pub_key: "ab".into(), nonce: 1,
            payload: TxPayload::default(), fee: 1.0, sig: String::new(), signed_payload: sp.map(String::from) }
    }

    #[test]
    fn local_rule_reads_the_signed_payload() {
        assert!(local_tx_rule(&tx(None), MAIN, true).is_ok(), "V1 is bound by consensus only");
        assert!(local_tx_rule(&tx(Some("not json")), MAIN, true).is_ok(), "left to the binding rule");
        assert!(local_tx_rule(&tx(Some(r#"{"chainId":"rougechain-devnet-1"}"#)), MAIN, false).unwrap_err().starts_with(MISMATCH_CODE));
        assert!(local_tx_rule(&tx(Some(r#"{"to":"x"}"#)), MAIN, false).is_ok());
        assert!(local_tx_rule(&tx(Some(r#"{"to":"x"}"#)), MAIN, true).unwrap_err().starts_with(REQUIRED_CODE));
    }

    #[test]
    fn consensus_rule_is_silent_before_activation_and_exact_after() {
        set_test_chain_id_binding(None);
        assert!(consensus_tx_rule(&tx(Some(r#"{"to":"x"}"#)), u64::MAX, MAIN).is_ok());
        set_test_chain_id_binding(Some(10));
        assert!(consensus_tx_rule(&tx(Some(r#"{"to":"x"}"#)), 9, MAIN).is_ok(), "before activation");
        assert!(consensus_tx_rule(&tx(Some(r#"{"to":"x"}"#)), 10, MAIN).unwrap_err().starts_with(REQUIRED_CODE));
        assert!(consensus_tx_rule(&tx(Some(r#"{"chainId":"rougechain-devnet-1"}"#)), 10, MAIN).unwrap_err().starts_with(MISMATCH_CODE));
        assert!(consensus_tx_rule(&tx(Some(r#"{"chainId":"rougechain-mainnet-1"}"#)), 10, MAIN).is_ok());
        // a CLI envelope carries `chain_id`; `chainId` does not satisfy it
        let env_ok = r#"{"tx_type":"transfer","payload":{},"chain_id":"rougechain-mainnet-1"}"#;
        let env_other = r#"{"tx_type":"transfer","payload":{},"chainId":"rougechain-mainnet-1"}"#;
        assert!(consensus_tx_rule(&tx(Some(env_ok)), 10, MAIN).is_ok());
        assert!(consensus_tx_rule(&tx(Some(env_other)), 10, MAIN).unwrap_err().starts_with(REQUIRED_CODE));
        assert!(consensus_tx_rule(&tx(Some("[]")), 10, MAIN).is_err());
        // V1 (no signed_payload): bound by the signature format instead
        assert!(consensus_tx_rule(&tx(None), 10, MAIN).is_ok());
        // SHIELD_V2 types: the body commits to the chain
        let mut s = tx(Some(r#"{"to":"x"}"#)); s.tx_type = crate::shield_v2::SHIELD_TX_TYPE.into();
        assert!(consensus_tx_rule(&s, 10, MAIN).is_ok());
        set_test_chain_id_binding(None);
    }

    #[test]
    fn chain_bound_signature_formats() {
        let kp = pqc_keygen();
        let authority = pqc_keygen();
        let mut t = tx(None);
        t.from_pub_key = kp.public_key_hex.clone();
        // plain V1 and legacy formats are not chain-bound
        t.sig = pqc_sign(&kp.secret_key_hex, &encode_tx_for_signing(&t)).unwrap();
        assert!(!signature_valid_chain_bound(&t, MAIN, &[]));
        // the bound V1 format verifies on its own chain only
        t.sig = pqc_sign(&kp.secret_key_hex, &encode_tx_for_signing_chain(&t, MAIN)).unwrap();
        assert!(signature_valid_chain_bound(&t, MAIN, &[]));
        assert!(!signature_valid_chain_bound(&t, TEST, &[]));
        // a signed payload: only its own bytes, no fallback to a V1 format
        let mut v2 = t.clone();
        v2.signed_payload = Some(format!(r#"{{"chainId":"{}"}}"#, MAIN));
        assert!(!signature_valid_chain_bound(&v2, MAIN, &[]), "a bound V1 signature does not stand in for the payload");
        v2.sig = pqc_sign(&kp.secret_key_hex, v2.signed_payload.as_deref().unwrap().as_bytes()).unwrap();
        assert!(signature_valid_chain_bound(&v2, MAIN, &[]));
        // authority-cosigned bridge withdrawal, bound format only
        let mut w = tx(None);
        w.tx_type = "bridge_withdraw".into();
        w.from_pub_key = kp.public_key_hex.clone();
        let keys = vec![authority.public_key_hex.clone()];
        w.sig = pqc_sign(&authority.secret_key_hex, &encode_tx_for_signing(&w)).unwrap();
        assert!(!signature_valid_chain_bound(&w, MAIN, &keys));
        w.sig = pqc_sign(&authority.secret_key_hex, &encode_tx_for_signing_chain(&w, MAIN)).unwrap();
        assert!(signature_valid_chain_bound(&w, MAIN, &keys));
        assert!(!signature_valid_chain_bound(&w, TEST, &keys));
        // shield_v2: the plain V1 encoding is accepted (its body carries the chain tag)
        let mut s = tx(None);
        s.tx_type = crate::shield_v2::SHIELD_TX_TYPE.into();
        s.from_pub_key = kp.public_key_hex.clone();
        s.sig = pqc_sign(&kp.secret_key_hex, &encode_tx_for_signing(&s)).unwrap();
        assert!(signature_valid_chain_bound(&s, MAIN, &[]));
    }

    #[test]
    fn v1_signing_bytes_follow_the_activation() {
        let t = tx(None);
        set_test_chain_id_binding(None);
        assert_eq!(v1_signing_bytes(&t, MAIN, u64::MAX), encode_tx_for_signing(&t));
        set_test_chain_id_binding(Some(5));
        assert_eq!(v1_signing_bytes(&t, MAIN, 4), encode_tx_for_signing(&t));
        assert_eq!(v1_signing_bytes(&t, MAIN, 5), encode_tx_for_signing_chain(&t, MAIN));
        set_test_chain_id_binding(None);
    }
}
