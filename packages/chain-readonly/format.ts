/**
 * Display helpers shared by the explorer pages: rouge1 addresses, token units and transaction
 * summaries. Ported from apps/web/src/lib/address.ts, tx-display.ts and the token-decimals
 * helpers in apps/web/src/hooks/use-eth-price.ts, without any wallet or pricing code.
 */

// ─── rouge1 addresses: bech32m("rouge", sha256(pubkey bytes)) ────────────────

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const HRP = "rouge";

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function toWords(data: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const value of data) {
    acc = ((acc << 8) | value) & 0xffffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function bech32mEncode(hrp: string, data: Uint8Array): string {
  const words = toWords(data);
  const pm = polymod(hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0])) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (pm >> (5 * (5 - i))) & 31);
  return `${hrp}1${words.concat(checksum).map((d) => CHARSET[d]).join("")}`;
}

/** True for a checksum-valid rouge1 bech32m address (lower case, as the node emits them). */
export function isRougeAddress(input: string): boolean {
  if (typeof input !== "string" || !/^rouge1[02-9ac-hj-np-z]{6,90}$/.test(input)) return false;
  const words = [...input.slice(6)].map((c) => CHARSET.indexOf(c));
  return polymod(hrpExpand(HRP).concat(words)) === BECH32M_CONST;
}

export function isPubkeyHex(input: string): boolean {
  return /^[0-9a-f]{64,8192}$/.test(input) && input.length % 2 === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Small synchronous SHA-256 (FIPS 180-4), so addresses render without an async round trip.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
}

const addressCache = new Map<string, string>();

/** rouge1 address of an ML-DSA public key (hex). Matches core/crypto pub_key_to_address. */
export function pubkeyToAddress(pubkeyHex: string): string {
  const key = pubkeyHex.toLowerCase();
  if (!isPubkeyHex(key)) throw new Error("Not a public key");
  let cached = addressCache.get(key);
  if (!cached) {
    cached = bech32mEncode(HRP, sha256(hexToBytes(key)));
    if (addressCache.size >= 500) addressCache.delete(addressCache.keys().next().value!);
    addressCache.set(key, cached);
  }
  return cached;
}

/** rouge1 form of any identity the node reports: rouge1 stays, pubkey hex is derived, else null. */
export function toRougeAddress(identity: string): string | null {
  if (isRougeAddress(identity)) return identity;
  if (isPubkeyHex(identity.toLowerCase())) return pubkeyToAddress(identity);
  return null;
}

export function shorten(value: string, head = 10, tail = 6): string {
  if (!value) return "—";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// ─── Token units ─────────────────────────────────────────────────────────────

/**
 * Decimals for the built-in assets when the node's token directory hasn't loaded. The node's
 * /tokens `decimals` value always wins (see tokenDecimals).
 */
export const BUILTIN_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  XRGE: 0,
  QBTC: 8,
  QETH: 6,
  QUSDC: 6,
});

export function tokenDecimals(symbol: string, known?: ReadonlyMap<string, number>): number {
  const fromNode = known?.get(symbol) ?? known?.get(symbol.toUpperCase());
  if (fromNode !== undefined) return fromNode;
  return BUILTIN_DECIMALS[symbol.toUpperCase()] ?? 0;
}

function trimFixed(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") || "0" : s;
}

/**
 * Format a RAW on-chain amount in whole units: 3100 qBTC sats → "0.000031", 128660 qUSDC →
 * "0.12866". Never exponent notation, never invents precision.
 */
export function formatUnits(raw: number, decimals: number): string {
  if (!Number.isFinite(raw)) return "—";
  const human = decimals > 0 ? raw / 10 ** decimals : raw;
  const sign = human < 0 ? "-" : "";
  const abs = Math.abs(human);
  if (abs === 0) return "0";
  const maxDigits = decimals > 0 ? Math.min(decimals, 8) : 6;
  if (abs >= 1) return sign + abs.toLocaleString("en-US", { maximumFractionDigits: maxDigits });
  return sign + trimFixed(abs, maxDigits);
}

export function formatTokenAmount(raw: number, symbol: string, known?: ReadonlyMap<string, number>): string {
  return formatUnits(raw, tokenDecimals(symbol, known));
}

/** Fees and XRGE balances are reported by the node as whole-XRGE floats. */
export function formatXrge(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

// ─── Transactions ────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Which token a transaction's `amount` is denominated in (see apps/web/src/lib/tx-display.ts). */
export function txAmountSymbol(type: string, payload: Record<string, unknown>): string {
  if (type === "swap") return str(payload.token_a_symbol) ?? str(payload.token_in) ?? "XRGE";
  return str(payload.token_symbol) ?? str(payload.tokenSymbol) ?? "XRGE";
}

export function swapSides(payload: Record<string, unknown>) {
  return {
    tokenIn: str(payload.token_a_symbol) ?? str(payload.token_in),
    amountIn: num(payload.amount_a) ?? num(payload.amount_in) ?? num(payload.amount),
    tokenOut: str(payload.token_b_symbol) ?? str(payload.token_out),
    minOut: num(payload.min_amount_out),
    poolId: str(payload.pool_id),
  };
}

const TYPE_LABELS: Record<string, string> = {
  faucet: "Faucet",
  transfer: "Transfer",
  stake: "Stake",
  unstake: "Unstake",
  create_token: "Token created",
  swap: "Swap",
  create_pool: "Create pool",
  add_liquidity: "Add liquidity",
  remove_liquidity: "Remove liquidity",
  nft_mint: "NFT mint",
  nft_create_collection: "NFT collection",
  nft_transfer: "NFT transfer",
  contract_deploy: "Contract deploy",
  contract_call: "Contract call",
  bridge_mint: "Bridge mint",
  bridge_withdraw: "Bridge withdraw",
  shield: "Shield",
  unshield: "Unshield",
};

export function txTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ─── Media safety ────────────────────────────────────────────────────────────

/**
 * Only plain https images or inline raster data URIs may be shown. Never HTML, SVG documents,
 * scripts, frames, or http/ipfs/javascript schemes. Anything else is not rendered at all.
 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 400_000) return null;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** External links (token websites, metadata URIs): https only, shown as plain links. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
