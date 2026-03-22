/**
 * RougeChain Bech32m Address Utilities for SDK
 *
 * Derives compact, human-readable addresses from PQC public keys:
 *   address = bech32m("rouge", SHA-256(raw_pubkey_bytes))
 *
 * Result: ~63-char address like "rouge1q8f3x7k2m4n9p..."
 * Matches the Rust implementation in core/crypto/src/lib.rs exactly.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const HRP = "rouge";

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
  const payload = data5bit.slice(0, data5bit.length - 6);
  const ret: number[] = [];
  let acc = 0, bits = 0;
  for (const value of payload) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      ret.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, data: new Uint8Array(ret) };
}

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

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

/**
 * Derive a compact Bech32m address from an ML-DSA-65 public key (hex).
 * Returns a ~63-character string like "rouge1q8f3x7k2m4n9p..."
 */
export async function pubkeyToAddress(publicKeyHex: string): Promise<string> {
  const pkBytes = hexToBytes(publicKeyHex);
  const hash = await sha256(pkBytes);
  return bech32mEncode(HRP, hash);
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
