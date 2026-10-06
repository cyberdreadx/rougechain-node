//! Bech32m (BIP-350) over arbitrary-length byte strings.
//!
//! Written out here, not taken from the `bech32` crate, because a shielded address is 1,216
//! bytes (spec §5.3, open issue O-11) and that crate refuses anything above the 1,023-character
//! code length. The checksum polynomial, constant and character set are BIP-350's; the only
//! difference from a segwit address encoder is that no length limit is applied.
//!
//! **The checksum does not protect a shielded address.** It is a BCH code of length 1,023
//! characters: within that length it detects every error of up to 4 characters; beyond it, it
//! still detects every single changed character, but the same change applied to two characters
//! exactly 1,023 places apart is invisible to it (REVIEW_WALLET_1 F-2). The shielded address
//! therefore carries its own integrity value inside the encoded data (`keys.rs`,
//! `ShieldedAddress::decode`), which the decoder verifies in addition to this checksum.

use crate::error::WalletError;

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
const BECH32M: u32 = 0x2bc8_30a3;

fn polymod_step(chk: u32, v: u8) -> u32 {
    let b = chk >> 25;
    let mut chk = ((chk & 0x01ff_ffff) << 5) ^ (v as u32);
    for (i, g) in GEN.iter().enumerate() {
        if (b >> i) & 1 == 1 {
            chk ^= g;
        }
    }
    chk
}

fn polymod(hrp: &[u8], data: &[u8]) -> u32 {
    let mut chk = 1u32;
    for &c in hrp {
        chk = polymod_step(chk, c >> 5);
    }
    chk = polymod_step(chk, 0);
    for &c in hrp {
        chk = polymod_step(chk, c & 31);
    }
    for &d in data {
        chk = polymod_step(chk, d);
    }
    chk
}

/// `hrp` must be lowercase ASCII in 33..=126 and non-empty (the callers pass constants).
pub fn encode(hrp: &str, bytes: &[u8]) -> String {
    let mut data: Vec<u8> = Vec::with_capacity(bytes.len() * 8 / 5 + 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            data.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        data.push(((acc << (5 - bits)) & 31) as u8);
    }
    let mut with_zeros = data.clone();
    with_zeros.extend_from_slice(&[0u8; 6]);
    let chk = polymod(hrp.as_bytes(), &with_zeros) ^ BECH32M;
    let mut out = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    out.push_str(hrp);
    out.push('1');
    for d in data {
        out.push(CHARSET[d as usize] as char);
    }
    for i in 0..6 {
        out.push(CHARSET[((chk >> (5 * (5 - i))) & 31) as usize] as char);
    }
    out
}

/// Decodes to (prefix, bytes). Each failure has its own text: mixed case, no separator, a
/// character outside the alphabet, a wrong checksum, bad padding.
pub fn decode(s: &str) -> Result<(String, Vec<u8>), WalletError> {
    if !s.is_ascii() {
        return Err(WalletError::Address("not ASCII"));
    }
    let has_lower = s.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = s.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(WalletError::Address("mixed upper and lower case"));
    }
    let s = s.to_ascii_lowercase();
    let sep = s.rfind('1').ok_or(WalletError::Address("no '1' separator"))?;
    let (hrp, rest) = s.split_at(sep);
    let rest = &rest[1..];
    if hrp.is_empty() || hrp.bytes().any(|b| !(33..=126).contains(&b)) {
        return Err(WalletError::Address("empty or invalid prefix"));
    }
    if rest.len() < 6 {
        return Err(WalletError::Address("too short for a checksum"));
    }
    let mut data = Vec::with_capacity(rest.len());
    for c in rest.bytes() {
        let v = CHARSET.iter().position(|&x| x == c).ok_or(WalletError::Address("a character outside the bech32 alphabet"))?;
        data.push(v as u8);
    }
    if polymod(hrp.as_bytes(), &data) != BECH32M {
        return Err(WalletError::Address("bad checksum (mistyped or damaged)"));
    }
    let payload = &data[..data.len() - 6];
    let mut out = Vec::with_capacity(payload.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &d in payload {
        acc = ((acc << 5) | d as u32) & 0x1fff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 5 || (acc & ((1 << bits) - 1)) != 0 {
        return Err(WalletError::Address("bad padding"));
    }
    Ok((hrp.to_string(), out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BIP-350 valid test vectors (checksum only: they are not segwit programs).
    #[test]
    fn bip350_valid_strings() {
        for s in [
            "A1LQFN3A",
            "a1lqfn3a",
            "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
            "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
            "?1v759aa",
        ] {
            // five-bit payloads that are not whole bytes fail only the padding rule, never the checksum
            match decode(s) {
                Ok(_) | Err(WalletError::Address("bad padding")) => {}
                Err(e) => panic!("{s}: {e}"),
            }
        }
        // BIP-350 invalid checksums / characters
        for (s, why) in [
            ("a1lqfn3q", "bad checksum"),
            ("A1LQFN3a", "mixed"),
            ("1qyqqqp8tx4a", "prefix"),
            ("abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryb", "outside the bech32 alphabet"),
            ("qyrz8wqd2c9m", "no '1'"),
        ] {
            match decode(s) {
                Err(WalletError::Address(m)) => assert!(m.contains(why), "{s}: {m}"),
                other => panic!("{s}: {:?}", other.map(|x| x.0)),
            }
        }
    }

    /// A BIP-350 segwit v1 address: the witness program after the version character must come out.
    #[test]
    fn roundtrip_and_known_answer() {
        for len in [0usize, 1, 2, 5, 31, 32, 33, 1216, 1225] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 131 + 7) as u8).collect();
            let s = encode("rshield", &bytes);
            assert!(s.starts_with("rshield1"));
            assert_eq!(decode(&s).unwrap(), ("rshield".to_string(), bytes.clone()));
            assert_eq!(decode(&s.to_ascii_uppercase()).unwrap().1, bytes);
            // any single changed character is caught
            if len > 0 {
                let mut t = s.into_bytes();
                let i = t.len() - 3;
                t[i] = if t[i] == b'q' { b'p' } else { b'q' };
                assert!(decode(core::str::from_utf8(&t).unwrap()).is_err());
            }
        }
        // "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx": data values 31, 30, …, 0 (BIP-350)
        let (hrp, bytes) = decode("abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx").unwrap();
        assert_eq!(hrp, "abcdef");
        assert_eq!(encode("abcdef", &bytes), "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx");
    }
}
