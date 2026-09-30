/**
 * Bridge amount + address validation. Amounts are parsed EXACTLY from the decimal string with
 * core's `toBaseUnits` (no float rounding), then converted to the units apps/web sends:
 *
 *   asset   deposit (Base side)                 withdraw (RougeChain side, signed `amount`)
 *   ETH     wei, must be a multiple of 1e12     qETH units (6 dp)  — node credits wei / 1e12
 *   USDC    USDC units (6 dp)                   qUSDC units (6 dp)
 *   XRGE    wei = whole XRGE × 1e18             whole XRGE          — node reads a u64
 *   BTC     (sent from any Bitcoin wallet)      qBTC sats (8 dp)
 *
 * Where apps/web silently rounds (Math.round / Math.floor on a float), this refuses instead, so
 * the user never bridges a different amount than the one they reviewed.
 */
import { toBaseUnits, checkBaseAddress } from "@rougechain/core/base-wallet";
import { S, fmt } from "./strings";

export type BridgeAsset = "ETH" | "USDC" | "XRGE" | "BTC";
export type BtcNetwork = "mainnet" | "testnet";

export interface AssetDef {
  id: BridgeAsset;
  /** Symbol on the external chain (Base / Bitcoin). */
  label: string;
  /** Symbol on RougeChain. */
  l1Label: string;
  /** Decimal places the bridge accepts for this asset (both directions). */
  decimals: number;
}

export const ASSETS: AssetDef[] = [
  { id: "ETH", label: "ETH", l1Label: "qETH", decimals: 6 },
  { id: "USDC", label: "USDC", l1Label: "qUSDC", decimals: 6 },
  { id: "XRGE", label: "XRGE", l1Label: "XRGE", decimals: 0 },
  { id: "BTC", label: "BTC", l1Label: "qBTC", decimals: 8 },
];

export function assetDef(id: BridgeAsset): AssetDef {
  return ASSETS.find((a) => a.id === id)!;
}

/** 1 qETH unit = 1e-6 ETH = 1e12 wei (the node credits `value_wei / 1e12`). */
export const WEI_PER_QETH_UNIT = 1_000_000_000_000n;
export const WEI_PER_XRGE = 10n ** 18n;
/** Protocol bridge fee, signed into every withdrawal (node rejects anything else). */
export const BRIDGE_FEE_XRGE = 0.1;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function units(input: string, asset: AssetDef): Parsed<bigint> {
  const s = input.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return { ok: false, error: S.errors.invalidAmount };
  const frac = s.split(".")[1] ?? "";
  if (frac.replace(/0+$/, "").length > asset.decimals) {
    return {
      ok: false,
      error: asset.decimals === 0 ? S.errors.wholeXrge : fmt(S.errors.tooManyDecimals, { symbol: asset.label, decimals: asset.decimals }),
    };
  }
  // Trailing zeros past the precision are harmless ("1.50" XRGE is not whole, "2.0" is).
  const trimmed = frac.length > asset.decimals ? s.slice(0, s.length - (frac.length - asset.decimals)).replace(/\.$/, "") : s;
  let v: bigint;
  try {
    v = toBaseUnits(trimmed, asset.decimals);
  } catch {
    return { ok: false, error: S.errors.invalidAmount };
  }
  if (v <= 0n) return { ok: false, error: S.errors.invalidAmount };
  return { ok: true, value: v };
}

export interface DepositAmount {
  /** What the Base transaction moves: wei for ETH/XRGE, 6-dp units for USDC. */
  baseUnits: bigint;
  /** What arrives on RougeChain, in L1 raw units (qETH/qUSDC units, whole XRGE). */
  l1Units: bigint;
}

/** Deposit amount (Base → RougeChain) for ETH / USDC / XRGE. */
export function parseDepositAmount(asset: BridgeAsset, input: string): Parsed<DepositAmount> {
  if (asset === "BTC") return { ok: false, error: S.errors.invalidAmount };
  const r = units(input, assetDef(asset));
  if (!r.ok) return r;
  if (asset === "ETH") return { ok: true, value: { baseUnits: r.value * WEI_PER_QETH_UNIT, l1Units: r.value } };
  if (asset === "XRGE") return { ok: true, value: { baseUnits: r.value * WEI_PER_XRGE, l1Units: r.value } };
  return { ok: true, value: { baseUnits: r.value, l1Units: r.value } };
}

/** Withdrawal amount (RougeChain → Base/Bitcoin) in the raw units signed into the payload. */
export function parseWithdrawAmount(asset: BridgeAsset, input: string): Parsed<number> {
  const r = units(input, assetDef(asset));
  if (!r.ok) return r;
  const n = Number(r.value);
  if (!Number.isSafeInteger(n)) return { ok: false, error: S.errors.invalidAmount };
  return { ok: true, value: n };
}

/** Raw L1 units → human string with the asset's decimals (no exponent notation). */
export function formatUnits(raw: bigint | number, decimals: number): string {
  const v = typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
  if (decimals === 0) return v.toString();
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? `.${frac}` : ""}`;
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** Base (EVM) withdrawal address: 0x + 40 hex (0x optional, as apps/web); mixed case must be EIP-55. */
export function parseEvmAddress(input: string): Parsed<`0x${string}`> {
  const s = input.trim();
  const withPrefix = s.startsWith("0x") || s.startsWith("0X") ? `0x${s.slice(2)}` : `0x${s}`;
  const check = checkBaseAddress(withPrefix);
  if (check === "ok") return { ok: true, value: withPrefix as `0x${string}` };
  return { ok: false, error: check === "bad-checksum" ? S.errors.badChecksum : S.errors.invalidEvmAddress };
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** Segwit address check (BIP-173 bech32 for v0, BIP-350 bech32m for v1+), with its checksum. */
function isValidSegwit(addr: string, hrp: string): boolean {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const a = addr.toLowerCase();
  if (!a.startsWith(`${hrp}1`) || a.length > 90) return false;
  const data: number[] = [];
  for (const c of a.slice(hrp.length + 1)) {
    const i = BECH32_CHARSET.indexOf(c);
    if (i < 0) return false;
    data.push(i);
  }
  if (data.length < 7) return false;
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = bech32Polymod(expand.concat(data));
  const version = data[0];
  if (version > 16) return false;
  const expected = version === 0 ? 1 : 0x2bc830a3;
  if (pm !== expected) return false;
  // Program length: 6 checksum chars and 1 version char; 5-bit groups → bytes.
  const progBytes = Math.floor(((data.length - 7) * 5) / 8);
  if (progBytes < 2 || progBytes > 40) return false;
  if (version === 0 && progBytes !== 20 && progBytes !== 32) return false;
  return true;
}

/**
 * Bitcoin payout address for the bridge's Bitcoin network. apps/web only checks length ≥ 14; a
 * typo'd address here means BTC paid to nowhere, so this also checks the network prefix, the
 * base58 alphabet, and the bech32/bech32m checksum. Sent verbatim (never 0x-prefixed).
 */
export function parseBtcAddress(input: string, network: BtcNetwork): Parsed<string> {
  const s = input.trim();
  const bad = { ok: false as const, error: fmt(S.errors.invalidBtcAddress, { network: network === "mainnet" ? "mainnet" : "testnet" }) };
  if (s.length < 14) return bad;
  const hrp = network === "mainnet" ? "bc" : "tb";
  if (s.toLowerCase().startsWith(`${hrp}1`)) return isValidSegwit(s, hrp) ? { ok: true, value: s } : bad;
  const legacy = network === "mainnet" ? /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/ : /^[mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/;
  return legacy.test(s) ? { ok: true, value: s } : bad;
}

/** A Base transaction hash (claim an existing deposit): 0x + 64 hex. */
export function isBaseTxHash(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

/** A Bitcoin txid (optionally 0x-prefixed, stripped like apps/web). */
export function normalizeBtcTxid(s: string): string | null {
  const t = s.trim().replace(/^0x/, "");
  return /^[0-9a-fA-F]{64}$/.test(t) ? t : null;
}
