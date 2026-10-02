//! `rougechain release verify` — check the ML-DSA-65 (FIPS 204) signature of a release manifest.
//!
//! This is the post-quantum half of a signed release (see `docs/running-a-node/releases.md`):
//!
//! * the signed object is the manifest FILE — the signature covers its exact bytes;
//! * `<manifest>.mldsa65.sig` is one line of canonical base64 holding the raw 3309-byte signature
//!   (pure ML-DSA-65, empty context), as written by `scripts/release/sign-manifest.mjs`;
//! * the public key file (`releases/keys/release-mldsa65.pub`) is the lowercase hex of the raw
//!   1952-byte key; blank lines and lines starting with `#` are ignored.
//!
//! Everything is offline: no wallet, no node, no network. The node updater calls this with the
//! release key it carries; an operator can call it by hand with the key from `releases/keys/`.

use std::path::Path;

pub const MLDSA65_PUB_LEN: usize = 1952;
pub const MLDSA65_SIG_LEN: usize = 3309;
/// A manifest is a small JSON file; refuse to hash-and-verify something absurd.
pub const MAX_MANIFEST_BYTES: u64 = 262_144;

/// Exit codes of `rougechain release verify`.
pub const EXIT_VERIFIED: i32 = 0;
pub const EXIT_INVALID: i32 = 1;
pub const EXIT_USAGE: i32 = 2;

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// A file could not be read, or is not in the expected format (exit 2).
    Input(String),
    /// Everything parsed, and the signature does not verify (exit 1).
    BadSignature,
}

/// Strict base64 (standard alphabet, `=` padding, canonical): the inverse of Node's
/// `Buffer.toString('base64')`. Anything else — whitespace inside, URL-safe alphabet, missing
/// padding, non-zero trailing bits — is rejected, exactly as `decodeSigFile` does in the tooling.
pub fn decode_base64_strict(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let b = s.as_bytes();
    if b.is_empty() || b.len() % 4 != 0 {
        return Err("not base64 (length is not a multiple of 4)".into());
    }
    let pad = b.iter().rev().take_while(|&&c| c == b'=').count();
    if pad > 2 {
        return Err("not base64 (too much padding)".into());
    }
    let body = &b[..b.len() - pad];
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in body {
        let v = val(c).ok_or_else(|| "not base64 (invalid character)".to_string())?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // What is left in `acc` are the padding bits of the last group: they must be zero, and their
    // number must agree with the `=` count (2 bits ↔ "=", 4 bits ↔ "==").
    let expected_bits = match pad {
        0 => 0,
        1 => 2,
        _ => 4,
    };
    if bits != expected_bits || acc != 0 {
        return Err("not canonical base64".into());
    }
    Ok(out)
}

/// Decode the content of a `.mldsa65.sig` file: one base64 line of exactly 3309 bytes.
pub fn parse_sig_file(text: &str) -> Result<Vec<u8>, String> {
    let sig = decode_base64_strict(text.trim()).map_err(|e| format!("signature file: {}", e))?;
    if sig.len() != MLDSA65_SIG_LEN {
        return Err(format!("signature file: expected {} bytes, got {}", MLDSA65_SIG_LEN, sig.len()));
    }
    Ok(sig)
}

/// Decode the content of a `release-mldsa65.pub` file: lowercase hex of the raw 1952-byte key.
pub fn parse_pubkey_file(text: &str) -> Result<Vec<u8>, String> {
    let hex: String = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    if hex.len() != MLDSA65_PUB_LEN * 2 || !hex.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(format!("public key file: must be {} bytes of lowercase hex", MLDSA65_PUB_LEN));
    }
    quantum_vault_crypto::hex_to_bytes(&hex).map_err(|e| format!("public key file: {}", e))
}

/// Fingerprint of a release key: SHA-256 of the RAW public key bytes, lowercase hex.
pub fn fingerprint(raw_pub: &[u8]) -> String {
    quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(raw_pub))
}

/// Verify `sig_text` (content of the `.mldsa65.sig` file) over `manifest` (the file's exact bytes)
/// with the key in `pub_text` (content of the public key file). Returns the key fingerprint.
pub fn verify_bytes(manifest: &[u8], sig_text: &str, pub_text: &str) -> Result<String, VerifyError> {
    let pk = parse_pubkey_file(pub_text).map_err(VerifyError::Input)?;
    let sig = parse_sig_file(sig_text).map_err(VerifyError::Input)?;
    if manifest.is_empty() {
        return Err(VerifyError::Input("manifest: the file is empty".into()));
    }
    let ok = quantum_vault_crypto::pqc_verify(
        &quantum_vault_crypto::bytes_to_hex(&pk),
        manifest,
        &quantum_vault_crypto::bytes_to_hex(&sig),
    )
    .map_err(|e| VerifyError::Input(format!("public key file: {}", e)))?;
    if ok {
        Ok(fingerprint(&pk))
    } else {
        Err(VerifyError::BadSignature)
    }
}

fn read_limited(path: &Path, what: &str, max: u64) -> Result<Vec<u8>, VerifyError> {
    let meta = std::fs::metadata(path).map_err(|e| VerifyError::Input(format!("{}: cannot read {}: {}", what, path.display(), e)))?;
    if !meta.is_file() {
        return Err(VerifyError::Input(format!("{}: {} is not a regular file", what, path.display())));
    }
    if meta.len() > max {
        return Err(VerifyError::Input(format!("{}: {} is larger than {} bytes", what, path.display(), max)));
    }
    std::fs::read(path).map_err(|e| VerifyError::Input(format!("{}: cannot read {}: {}", what, path.display(), e)))
}

fn read_text(path: &Path, what: &str, max: u64) -> Result<String, VerifyError> {
    String::from_utf8(read_limited(path, what, max)?).map_err(|_| VerifyError::Input(format!("{}: {} is not text", what, path.display())))
}

pub fn verify_files(manifest: &Path, sig: &Path, pubkey: &Path) -> Result<String, VerifyError> {
    let bytes = read_limited(manifest, "manifest", MAX_MANIFEST_BYTES)?;
    let sig_text = read_text(sig, "signature file", 16_384)?;
    let pub_text = read_text(pubkey, "public key file", 16_384)?;
    verify_bytes(&bytes, &sig_text, &pub_text)
}

/// The command: prints one verdict line and returns the process exit code.
pub fn run_verify(manifest: &Path, sig: &Path, pubkey: &Path) -> i32 {
    match verify_files(manifest, sig, pubkey) {
        Ok(fpr) => {
            println!("VERIFIED: ML-DSA-65 signature of {} (release key {})", manifest.display(), fpr);
            EXIT_VERIFIED
        }
        Err(VerifyError::BadSignature) => {
            eprintln!("INVALID: the ML-DSA-65 signature does NOT verify {} against this public key", manifest.display());
            EXIT_INVALID
        }
        Err(VerifyError::Input(e)) => {
            eprintln!("error: {}", e);
            EXIT_USAGE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_file(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
    }
    fn read(rel: &str) -> Vec<u8> {
        std::fs::read(repo_file(rel)).unwrap_or_else(|e| panic!("{}: {}", rel, e))
    }
    fn text(rel: &str) -> String {
        String::from_utf8(read(rel)).unwrap()
    }
    const PUB: &str = "releases/keys/release-mldsa65.pub";
    /// Fingerprint published in releases/keys/README.md and docs/running-a-node/releases.md.
    const RELEASE_MLDSA65_FPR: &str = "ac4497980205f2ccbd810048bcd5ffd819d82400730cfbead41157cc56781b3c";

    fn encode_base64(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }

    /// The manifests published for node 1.6.0, signed on the release owner's machine with
    /// `sign-manifest.mjs` (@noble/post-quantum), must verify here (fips204) with the committed key.
    #[test]
    fn real_signed_manifests_verify_with_the_committed_release_key() {
        for net in ["mainnet", "testnet"] {
            let m = format!("releases/manifest-{}.json", net);
            let fpr = verify_bytes(&read(&m), &text(&format!("{}.mldsa65.sig", m)), &text(PUB))
                .unwrap_or_else(|e| panic!("{} did not verify: {:?}", m, e));
            assert_eq!(fpr, RELEASE_MLDSA65_FPR, "{}", net);
        }
    }

    #[test]
    fn real_manifests_verify_through_the_file_entry_point() {
        let m = repo_file("releases/manifest-mainnet.json");
        let s = repo_file("releases/manifest-mainnet.json.mldsa65.sig");
        assert_eq!(run_verify(&m, &s, &repo_file(PUB)), EXIT_VERIFIED);
        assert_eq!(run_verify(&m, &repo_file("releases/manifest-testnet.json.mldsa65.sig"), &repo_file(PUB)), EXIT_INVALID);
        assert_eq!(run_verify(&m, &repo_file("releases/does-not-exist.sig"), &repo_file(PUB)), EXIT_USAGE);
        // the Ed25519 signature file is not an ML-DSA-65 signature
        assert_eq!(run_verify(&m, &repo_file("releases/manifest-mainnet.json.ed25519.sig"), &repo_file(PUB)), EXIT_USAGE);
        // …and the Ed25519 key file is not an ML-DSA-65 key
        assert_eq!(run_verify(&m, &s, &repo_file("releases/keys/release-ed25519.pub.pem")), EXIT_USAGE);
    }

    #[test]
    fn a_manifest_changed_by_one_byte_is_rejected() {
        let sig = text("releases/manifest-mainnet.json.mldsa65.sig");
        let good = read("releases/manifest-mainnet.json");
        for at in [0usize, good.len() / 2, good.len() - 1] {
            let mut bad = good.clone();
            bad[at] ^= 0x01;
            assert_eq!(verify_bytes(&bad, &sig, &text(PUB)), Err(VerifyError::BadSignature), "byte {}", at);
        }
        // re-formatted (one extra newline) and truncated manifests do not verify either
        let mut longer = good.clone();
        longer.push(b'\n');
        assert_eq!(verify_bytes(&longer, &sig, &text(PUB)), Err(VerifyError::BadSignature));
        assert_eq!(verify_bytes(&good[..good.len() - 1], &sig, &text(PUB)), Err(VerifyError::BadSignature));
    }

    #[test]
    fn a_signature_of_another_manifest_is_rejected() {
        let mainnet = read("releases/manifest-mainnet.json");
        let testnet_sig = text("releases/manifest-testnet.json.mldsa65.sig");
        assert_eq!(verify_bytes(&mainnet, &testnet_sig, &text(PUB)), Err(VerifyError::BadSignature));
    }

    #[test]
    fn a_tampered_signature_is_rejected() {
        let m = read("releases/manifest-mainnet.json");
        let sig = parse_sig_file(&text("releases/manifest-mainnet.json.mldsa65.sig")).unwrap();
        for at in [0usize, 1000, MLDSA65_SIG_LEN - 1] {
            let mut bad = sig.clone();
            bad[at] ^= 0x80;
            assert_eq!(verify_bytes(&m, &encode_base64(&bad), &text(PUB)), Err(VerifyError::BadSignature), "byte {}", at);
        }
        // sanity: the re-encoded untouched signature still verifies (the encoder above is right)
        assert!(verify_bytes(&m, &encode_base64(&sig), &text(PUB)).is_ok());
    }

    #[test]
    fn another_key_is_rejected() {
        let m = read("releases/manifest-mainnet.json");
        let sig = text("releases/manifest-mainnet.json.mldsa65.sig");
        let other = quantum_vault_crypto::pqc_keygen();
        assert_eq!(verify_bytes(&m, &sig, &other.public_key_hex), Err(VerifyError::BadSignature));
        // a key file with one flipped nibble
        let mut hex = text(PUB).trim().to_string();
        let flipped = if hex.ends_with('0') { '1' } else { '0' };
        hex.pop();
        hex.push(flipped);
        assert!(verify_bytes(&m, &sig, &hex).is_err());
    }

    /// Format compatibility in the other direction: a signature made by this crate's signer in the
    /// tooling's file format verifies, and only over the exact bytes.
    #[test]
    fn round_trip_in_the_tooling_file_format() {
        let kp = quantum_vault_crypto::pqc_keygen();
        let manifest = b"{\n  \"schema\": 1,\n  \"version\": \"9.9.9\"\n}\n";
        let sig_hex = quantum_vault_crypto::pqc_sign(&kp.secret_key_hex, manifest).unwrap();
        let sig_file = format!("{}\n", encode_base64(&quantum_vault_crypto::hex_to_bytes(&sig_hex).unwrap()));
        let pub_file = format!("# test key\n{}\n", kp.public_key_hex);
        assert!(verify_bytes(manifest, &sig_file, &pub_file).is_ok());
        assert_eq!(verify_bytes(b"{}\n", &sig_file, &pub_file), Err(VerifyError::BadSignature));
    }

    #[test]
    fn malformed_signature_files_are_input_errors() {
        let m = read("releases/manifest-mainnet.json");
        let good = text("releases/manifest-mainnet.json.mldsa65.sig");
        let good = good.trim();
        let cases: Vec<(String, &str)> = vec![
            (String::new(), "empty"),
            ("this is not a signature".into(), "garbage"),
            (good[..good.len() - 4].to_string(), "truncated by 3 bytes"),
            (format!("{}AAAA", good), "3 bytes too long"),
            (good.replace('+', "-").replace('/', "_"), "url-safe alphabet"),
            (format!("{}\n{}", &good[..100], &good[100..]), "line break inside"),
            (format!("{}=", &good[..good.len() - 1]), "last character replaced by padding"),
        ];
        for (sig, what) in cases {
            match verify_bytes(&m, &sig, &text(PUB)) {
                Err(VerifyError::Input(_)) => {}
                other => panic!("{}: expected an input error, got {:?}", what, other),
            }
        }
    }

    #[test]
    fn malformed_public_key_files_are_input_errors() {
        let m = read("releases/manifest-mainnet.json");
        let sig = text("releases/manifest-mainnet.json.mldsa65.sig");
        let good = text(PUB);
        let good = good.trim();
        for (key, what) in [
            (String::new(), "empty"),
            (good[..good.len() - 2].to_string(), "one byte short"),
            (format!("{}00", good), "one byte long"),
            (good.to_uppercase(), "upper-case hex"),
            (text("releases/keys/release-ed25519.pub.pem"), "an Ed25519 PEM"),
        ] {
            match verify_bytes(&m, &sig, &key) {
                Err(VerifyError::Input(_)) => {}
                other => panic!("{}: expected an input error, got {:?}", what, other),
            }
        }
        assert_eq!(verify_bytes(b"", &sig, good), Err(VerifyError::Input("manifest: the file is empty".into())));
    }

    #[test]
    fn strict_base64() {
        assert_eq!(decode_base64_strict("AA==").unwrap(), vec![0]);
        assert_eq!(decode_base64_strict("AAA=").unwrap(), vec![0, 0]);
        assert_eq!(decode_base64_strict("AAAA").unwrap(), vec![0, 0, 0]);
        assert_eq!(decode_base64_strict("aGVsbG8=").unwrap(), b"hello".to_vec());
        for bad in ["", "A", "AA", "AAA", "AB==", "AAB=", "A===", "AA=A", "AA==AAAA", "AAA\n", " AAA", "AA-_"] {
            assert!(decode_base64_strict(bad).is_err(), "{:?} must be rejected", bad);
        }
        for len in 0..40usize {
            let data: Vec<u8> = (0..len as u8).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
            if len == 0 {
                continue;
            }
            assert_eq!(decode_base64_strict(&encode_base64(&data)).unwrap(), data);
        }
    }
}
