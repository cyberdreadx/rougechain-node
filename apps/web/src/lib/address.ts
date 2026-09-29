/**
 * RougeChain Bech32m Address System
 *
 * Derives compact, human-readable addresses from PQC public keys:
 *   address = bech32m("rouge", SHA-256(raw_pubkey_bytes))
 *
 * Result: ~63-char address like "rouge1q8f3x7k2m4n9p..."
 * vs the raw 3904-char hex public key.
 *
 * Matches the Rust implementation in core/crypto/src/lib.rs exactly.
 */

// ─── Bech32m constants ──────────────────────────────────────────

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const HRP = "rouge";

// ─── Bech32m encoding (RFC 3572 / BIP-350) ──────────────────────

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const pm = polymod(values) ^ BECH32M_CONST;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((pm >> (5 * (5 - i))) & 31);
  return ret;
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === BECH32M_CONST;
}

/** Convert 8-bit byte array to 5-bit groups for Bech32 encoding */
function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("Invalid bit conversion");
  }
  return ret;
}

/** Convert 5-bit groups back to 8-bit bytes */
function convertBitsBack(data: number[], fromBits: number, toBits: number): Uint8Array {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  return new Uint8Array(ret);
}

function bech32mEncode(hrp: string, data: Uint8Array): string {
  const data5bit = convertBits(data, 8, 5, true);
  const checksum = createChecksum(hrp, data5bit);
  const combined = data5bit.concat(checksum);
  let result = hrp + "1";
  for (const d of combined) result += CHARSET[d];
  return result;
}

function bech32mDecode(str: string): { hrp: string; data: Uint8Array } {
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("Invalid bech32m string");
  const hrp = lower.slice(0, pos);
  const data5bit: number[] = [];
  for (let i = pos + 1; i < lower.length; i++) {
    const d = CHARSET.indexOf(lower[i]);
    if (d === -1) throw new Error(`Invalid character: ${lower[i]}`);
    data5bit.push(d);
  }
  if (!verifyChecksum(hrp, data5bit)) throw new Error("Invalid bech32m checksum");
  // Remove checksum (last 6 chars)
  const payload = data5bit.slice(0, data5bit.length - 6);
  return { hrp, data: convertBitsBack(payload, 5, 8) };
}

// ─── SHA-256 (Web Crypto) ───────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Synchronous SHA-256 using SubtleCrypto (returns promise) */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Derive a compact Bech32m address from an ML-DSA-65 public key (hex).
 *
 * address = bech32m_encode("rouge", SHA-256(pubkey_bytes))
 *
 * Returns a ~63-character string like "rouge1q8f3x7k2m4n9p..."
 * Matches the Rust implementation in core/crypto/src/lib.rs exactly.
 */
export async function pubkeyToAddress(publicKeyHex: string): Promise<string> {
  const pkBytes = hexToBytes(publicKeyHex);
  const hash = await sha256(pkBytes);
  return bech32mEncode(HRP, hash);
}

/**
 * Synchronous version using pre-computed SHA-256 hash.
 * Use when you already have the hash (e.g., from the daemon API).
 */
export function hashToAddress(hashHex: string): string {
  return bech32mEncode(HRP, hexToBytes(hashHex));
}

/**
 * Decode a Bech32m address back to its 32-byte SHA-256 hash (hex).
 */
export function addressToHash(address: string): string {
  const { data } = bech32mDecode(address);
  return bytesToHex(data);
}

/**
 * Check if a string is a valid RougeChain Bech32m address.
 */
export function isRougeAddress(input: string): boolean {
  if (!input.toLowerCase().startsWith("rouge1") || input.length < 10) return false;
  try {
    bech32mDecode(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format an address for compact display: "rouge1q8f3...k9m2"
 */
export function formatAddress(address: string, prefixLen = 12, suffixLen = 4): string {
  if (address.length <= prefixLen + suffixLen + 3) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

/**
 * Format a raw public key hex for compact display: "A8f3...9x2k"
 */
export function formatPubkey(pubkey: string, prefixLen = 8, suffixLen = 4): string {
  if (pubkey.length <= prefixLen + suffixLen + 3) return pubkey;
  return `${pubkey.slice(0, prefixLen)}...${pubkey.slice(-suffixLen)}`;
}

/**
 * Auto-detect if input is an address or pubkey, and format appropriately.
 */
export function formatIdentity(input: string): string {
  if (isRougeAddress(input)) return formatAddress(input);
  return formatPubkey(input);
}
