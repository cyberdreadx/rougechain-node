//! Signed `/api/v2/*` requests — the same format the SDK and the site submit.
//!
//! A request is `{ payload, signature, public_key, payload_bytes_hex }`:
//!   * `payload` is a flat JSON object: the transaction's own fields plus `type`, `from` (the
//!     signer's public key), `timestamp` (ms; the node accepts ±5 minutes) and a random `nonce`
//!     (sdk/src/signer.ts `buildAndSign`);
//!   * `signature` is ML-DSA-65 over the payload serialised with sorted keys and no whitespace —
//!     byte for byte what the node's own `serde_json::to_string(&payload)` produces;
//!   * `payload_bytes_hex` carries those exact signed bytes, so the node verifies the signature
//!     over them directly (`verify_signed_tx` in the daemon) instead of relying on
//!     re-serialisation. The node also checks they parse to the same `payload`.
//! The node derives the executable transaction from the signed payload alone
//! (daemon `v2_binding`): stake/unstake read `amount` (integer), transfer reads `to`, `amount`,
//! `token`; the fee is fixed by the node (1 XRGE for all three).

use serde_json::{Map, Value};

/// Fee the node charges for stake, unstake and transfer (daemon `v2_binding`), in XRGE.
pub const V2_FEE_XRGE: u64 = 1;

/// The `/api/v2` route for a transaction type, if the node has one.
pub fn route_for(tx_type: &str) -> Option<&'static str> {
    match tx_type {
        "stake" => Some("/api/v2/stake"),
        "unstake" => Some("/api/v2/unstake"),
        "transfer" => Some("/api/v2/transfer"),
        "faucet" => Some("/api/v2/faucet"),
        _ => None,
    }
}

pub fn stake_fields(tx_type: &str, amount: u64) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("type".into(), Value::String(tx_type.into()));
    m.insert("amount".into(), Value::from(amount));
    m.insert("fee".into(), Value::from(V2_FEE_XRGE));
    m
}

pub fn transfer_fields(to: &str, amount: u64, token: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("type".into(), Value::String("transfer".into()));
    m.insert("to".into(), Value::String(to.into()));
    m.insert("amount".into(), Value::from(amount));
    m.insert("fee".into(), Value::from(V2_FEE_XRGE));
    m.insert("token".into(), Value::String(token.into()));
    m
}

pub fn faucet_fields() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("type".into(), Value::String("faucet".into()));
    m
}

/// Serialise with object keys sorted and no whitespace (the signed form).
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let entries: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(*k).unwrap(), canonical_json(&map[*k])))
                .collect();
            format!("{{{}}}", entries.join(","))
        }
        Value::Array(arr) => format!("[{}]", arr.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        _ => serde_json::to_string(value).unwrap(),
    }
}

/// Build and sign a v2 request. `timestamp_ms` and `nonce` are parameters so tests are deterministic.
pub fn build_signed_v2(
    public_key_hex: &str,
    secret_key_hex: &str,
    mut fields: Map<String, Value>,
    timestamp_ms: u64,
    nonce: &str,
) -> Result<Value, String> {
    fields.insert("from".into(), Value::String(public_key_hex.to_string()));
    fields.insert("timestamp".into(), Value::from(timestamp_ms));
    fields.insert("nonce".into(), Value::String(nonce.to_string()));
    let payload = Value::Object(fields);
    let signed = canonical_json(&payload);
    let signature = quantum_vault_crypto::pqc_sign(secret_key_hex, signed.as_bytes()).map_err(|e| format!("Sign error: {}", e))?;
    Ok(serde_json::json!({
        "payload": payload,
        "signature": signature,
        "public_key": public_key_hex,
        "payload_bytes_hex": hex::encode(signed.as_bytes()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000_000;
    const NONCE: &str = "00112233445566778899aabbccddeeff";

    /// What the node's `verify_signed_tx` checks, step for step (daemon main.rs), given the
    /// request body and the node's clock. Returns the signed payload string on success.
    fn node_verify(req: &Value, node_now_ms: i64) -> Result<String, String> {
        let payload = req.get("payload").ok_or("no payload")?;
        let public_key = req["public_key"].as_str().ok_or("no public_key")?;
        let signature = req["signature"].as_str().ok_or("no signature")?;
        let payload_bytes: Vec<u8> = match req.get("payload_bytes_hex").and_then(|v| v.as_str()) {
            Some(h) => {
                let raw = quantum_vault_crypto::hex_to_bytes(h).map_err(|e| format!("Invalid payload_bytes_hex: {}", e))?;
                let parsed: Value = serde_json::from_slice(&raw).map_err(|e| format!("payload_bytes_hex is not valid JSON: {}", e))?;
                if &parsed != payload {
                    return Err("payload_bytes_hex does not match payload object".into());
                }
                raw
            }
            // The node re-serialises its parsed payload; its serde_json maps are sorted (that is
            // what makes SDK requests, which carry no payload_bytes_hex, verify).
            None => canonical_json(payload).into_bytes(),
        };
        let valid = quantum_vault_crypto::pqc_verify(public_key, &payload_bytes, signature).map_err(|e| format!("Signature verification failed: {}", e))?;
        if !valid {
            return Err("Invalid signature".into());
        }
        let timestamp = payload.get("timestamp").and_then(|v| v.as_i64()).ok_or("payload must include a 'timestamp' field")?;
        if (node_now_ms - timestamp).abs() > 5 * 60 * 1000 {
            return Err("Transaction expired (timestamp too old or too far in the future)".into());
        }
        if let Some(from) = payload.get("from").and_then(|v| v.as_str()) {
            if from != public_key {
                return Err("Payload 'from' does not match signing public key".into());
            }
        }
        String::from_utf8(payload_bytes).map_err(|_| "payload bytes are not valid UTF-8".into())
    }

    fn keypair() -> (String, String) {
        let k = quantum_vault_crypto::pqc_keygen();
        (k.public_key_hex, k.secret_key_hex)
    }

    #[test]
    fn stake_request_has_the_sdk_shape_and_passes_the_node_checks() {
        let (pk, sk) = keypair();
        let req = build_signed_v2(&pk, &sk, stake_fields("stake", 10_000), NOW, NONCE).unwrap();
        let p = req["payload"].as_object().unwrap();
        let mut keys: Vec<&str> = p.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["amount", "fee", "from", "nonce", "timestamp", "type"]);
        assert_eq!(p["type"], "stake");
        assert_eq!(p["from"], pk.as_str());
        assert_eq!(p["nonce"], NONCE);
        // the node reads these with as_u64 / as_i64: they must be JSON integers
        assert_eq!(p["amount"].as_u64(), Some(10_000));
        assert_eq!(p["fee"].as_u64(), Some(1));
        assert_eq!(p["timestamp"].as_i64(), Some(NOW as i64));
        assert_eq!(req["public_key"], pk.as_str());
        let signed = node_verify(&req, NOW as i64 + 1_000).unwrap();
        assert_eq!(
            signed,
            format!(r#"{{"amount":10000,"fee":1,"from":"{pk}","nonce":"{NONCE}","timestamp":{NOW},"type":"stake"}}"#)
        );
    }

    #[test]
    fn request_verifies_with_and_without_payload_bytes_hex() {
        // An SDK request has no payload_bytes_hex: the node re-serialises the payload (sorted keys).
        // The CLI signs exactly that serialisation, so both node paths accept the same signature.
        let (pk, sk) = keypair();
        for fields in [stake_fields("stake", 10_000), stake_fields("unstake", 12_345), transfer_fields(&"ab".repeat(1952), 25, "XRGE"), faucet_fields()] {
            let req = build_signed_v2(&pk, &sk, fields, NOW, NONCE).unwrap();
            let with = node_verify(&req, NOW as i64).unwrap();
            let mut without = req.clone();
            without.as_object_mut().unwrap().remove("payload_bytes_hex");
            let sorted: Value = serde_json::from_str(&canonical_json(&req["payload"])).unwrap();
            assert_eq!(sorted, req["payload"]);
            assert_eq!(node_verify(&without, NOW as i64).unwrap(), with);
            assert_eq!(hex::decode(req["payload_bytes_hex"].as_str().unwrap()).unwrap(), with.as_bytes());
        }
    }

    #[test]
    fn transfer_and_unstake_fields() {
        let (pk, sk) = keypair();
        let to = "cd".repeat(1952);
        let req = build_signed_v2(&pk, &sk, transfer_fields(&to, 7, "XRGE"), NOW, NONCE).unwrap();
        let p = &req["payload"];
        assert_eq!(p["type"], "transfer");
        assert_eq!(p["to"], to.as_str());
        assert_eq!(p["amount"].as_u64(), Some(7));
        assert_eq!(p["amount"].as_f64(), Some(7.0)); // v2_transfer reads the amount with as_f64
        assert_eq!(p["token"], "XRGE");
        assert_eq!(p["fee"].as_u64(), Some(1));
        node_verify(&req, NOW as i64).unwrap();
        let req = build_signed_v2(&pk, &sk, stake_fields("unstake", 10_000), NOW, NONCE).unwrap();
        assert_eq!(req["payload"]["type"], "unstake");
        assert_eq!(req["payload"]["amount"].as_u64(), Some(10_000));
        node_verify(&req, NOW as i64).unwrap();
    }

    #[test]
    fn tampering_is_rejected_by_the_node_checks() {
        let (pk, sk) = keypair();
        let good = build_signed_v2(&pk, &sk, stake_fields("stake", 10_000), NOW, NONCE).unwrap();
        // amount changed in the payload object only
        let mut t = good.clone();
        t["payload"]["amount"] = Value::from(20_000u64);
        assert_eq!(node_verify(&t, NOW as i64).unwrap_err(), "payload_bytes_hex does not match payload object");
        // amount changed in both the object and the bytes
        let mut t = good.clone();
        t["payload"]["amount"] = Value::from(20_000u64);
        t["payload_bytes_hex"] = Value::String(hex::encode(canonical_json(&t["payload"])));
        assert_eq!(node_verify(&t, NOW as i64).unwrap_err(), "Invalid signature");
        // same, with payload_bytes_hex dropped
        let mut t = good.clone();
        t["payload"]["amount"] = Value::from(20_000u64);
        t.as_object_mut().unwrap().remove("payload_bytes_hex");
        assert!(node_verify(&t, NOW as i64).is_err());
        // somebody else's public key
        let (other_pk, _) = keypair();
        let mut t = good.clone();
        t["public_key"] = Value::String(other_pk);
        assert!(node_verify(&t, NOW as i64).is_err());
        // signed by a key other than `from`
        let (_, other_sk) = keypair();
        let forged = build_signed_v2(&pk, &other_sk, stake_fields("stake", 10_000), NOW, NONCE).unwrap();
        assert!(node_verify(&forged, NOW as i64).is_err());
    }

    #[test]
    fn timestamp_window_is_five_minutes_either_way() {
        let (pk, sk) = keypair();
        let req = build_signed_v2(&pk, &sk, stake_fields("stake", 10_000), NOW, NONCE).unwrap();
        let now = NOW as i64;
        assert!(node_verify(&req, now + 5 * 60 * 1000).is_ok());
        assert!(node_verify(&req, now - 5 * 60 * 1000).is_ok());
        assert!(node_verify(&req, now + 5 * 60 * 1000 + 1).unwrap_err().contains("expired"));
        assert!(node_verify(&req, now - 5 * 60 * 1000 - 1).unwrap_err().contains("expired"));
    }

    #[test]
    fn two_requests_differ_by_nonce_so_signatures_are_not_replays() {
        let (pk, sk) = keypair();
        let a = build_signed_v2(&pk, &sk, stake_fields("stake", 10_000), NOW, "aa").unwrap();
        let b = build_signed_v2(&pk, &sk, stake_fields("stake", 10_000), NOW, "bb").unwrap();
        assert_ne!(a["payload_bytes_hex"], b["payload_bytes_hex"]);
        assert_ne!(a["signature"], b["signature"]);
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_level() {
        let v: Value = serde_json::from_str(r#"{"b":1,"a":{"z":[{"y":1,"x":"q\"uote"}],"c":null},"A":true}"#).unwrap();
        assert_eq!(canonical_json(&v), r#"{"A":true,"a":{"c":null,"z":[{"x":"q\"uote","y":1}]},"b":1}"#);
    }

    #[test]
    fn routes() {
        assert_eq!(route_for("stake"), Some("/api/v2/stake"));
        assert_eq!(route_for("unstake"), Some("/api/v2/unstake"));
        assert_eq!(route_for("transfer"), Some("/api/v2/transfer"));
        assert_eq!(route_for("faucet"), Some("/api/v2/faucet"));
        // governance has no signed v2 route on the node
        assert_eq!(route_for("cast_vote"), None);
        assert_eq!(route_for("delegate"), None);
    }
}
