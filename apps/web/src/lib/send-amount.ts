import { l1TokenDecimals } from "@rougechain/core/token-decimals";

/**
 * Amounts in the Send dialog. XRGE balances and transfers are in XRGE (fractions allowed, as
 * before). Every other token is held and transferred in RAW on-chain units and has the node's
 * `decimals` (qBTC 8, qETH/qUSDC 6, custom tokens 0), so what the user types — whole tokens,
 * e.g. "1" qUSDC — must be scaled to raw units (1 qUSDC = 1,000,000). Previously only qETH was
 * scaled, so "1" qBTC or qUSDC sent 1 raw unit (0.00000001 BTC / 0.000001 USDC).
 *
 * Integer string math (BigInt) — no float rounding on money.
 */
export type ParsedSendAmount = { ok: true; raw: number } | { ok: false; error: string };

function isXrge(symbol: string): boolean {
  return symbol.toUpperCase() === "XRGE";
}

export function tokenDecimals(symbol: string): number {
  return isXrge(symbol) ? 0 : l1TokenDecimals(symbol);
}

export function parseSendAmount(input: string, symbol: string): ParsedSendAmount {
  const text = input.trim();
  if (isXrge(symbol)) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? { ok: true, raw: n } : { ok: false, error: "Invalid amount" };
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { ok: false, error: "Invalid amount" };
  const d = tokenDecimals(symbol);
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > d) {
    return {
      ok: false,
      error: d === 0 ? `${symbol} can only be sent in whole units` : `${symbol} supports at most ${d} decimal places`,
    };
  }
  const raw = BigInt(m[1]) * 10n ** BigInt(d) + BigInt((frac + "0".repeat(d)).slice(0, d) || "0");
  if (raw <= 0n) return { ok: false, error: "Invalid amount" };
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "Amount too large" };
  return { ok: true, raw: Number(raw) };
}

/** Raw on-chain balance → the exact human string (trailing zeros trimmed), for display and Max. */
export function rawToDisplay(raw: number, symbol: string): string {
  if (isXrge(symbol)) return String(raw);
  const d = tokenDecimals(symbol);
  if (d === 0) return String(raw);
  const n = BigInt(Math.max(0, Math.floor(raw)));
  const base = 10n ** BigInt(d);
  const frac = (n % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}

/** Human-readable balance with thousands separators for the "Available" line and the picker. */
export function formatBalance(raw: number, symbol: string): string {
  const s = rawToDisplay(raw, symbol);
  const [int, frac] = s.split(".");
  const grouped = Number(int).toLocaleString("en-US");
  return frac ? `${grouped}.${frac}` : grouped;
}
