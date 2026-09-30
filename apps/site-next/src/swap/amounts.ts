/**
 * Amount parsing for swaps and liquidity: what the user types (whole tokens, e.g. "1.5" qUSDC) →
 * RAW on-chain units by the node's decimals. Same integer-string (BigInt) semantics as apps/web's
 * `lib/send-amount.ts` `parseSendAmount` for every token with decimals, so no float rounding
 * touches money.
 *
 * One deliberate difference: the DEX takes `u64` amounts (daemon `amount_in` / `amount_a` /
 * `lp_amount`), and XRGE has 0 decimals, so XRGE here must be a whole number. apps/web silently
 * floors a fractional XRGE swap (`Math.floor(humanToRaw(1.5))` → 1); we say so instead.
 */
import { formatTokenAmount, l1TokenDecimals } from "@rougechain/core/token-decimals";
import { S } from "./strings";

export type ParsedAmount = { ok: true; raw: number } | { ok: false; error: string };

const isXrge = (symbol: string) => symbol.toUpperCase() === "XRGE";

/** Decimals the DEX uses for `symbol` (XRGE 0; others the node's decimals, as send-amount). */
export function tokenDecimals(symbol: string): number {
  return isXrge(symbol) ? 0 : l1TokenDecimals(symbol);
}

/** Human amount string → raw integer units. */
export function parseTokenAmount(input: string, symbol: string): ParsedAmount {
  const text = input.trim().replace(",", ".");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { ok: false, error: S.errors.invalidAmount };
  const d = tokenDecimals(symbol);
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > d) {
    return { ok: false, error: d === 0 ? S.errors.wholeUnits(symbol) : S.errors.tooManyDecimals(symbol, d) };
  }
  const raw = BigInt(m[1]) * 10n ** BigInt(d) + BigInt((frac + "0".repeat(d)).slice(0, d) || "0");
  if (raw <= 0n) return { ok: false, error: S.errors.invalidAmount };
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: S.errors.tooLarge };
  return { ok: true, raw: Number(raw) };
}

/** LP tokens are whole raw units (daemon `lp_amount: u64`). */
export function parseLpAmount(input: string): ParsedAmount {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: /^\d*[.,]\d+$/.test(text) ? S.errors.wholeUnits("LP") : S.errors.invalidAmount };
  const raw = BigInt(text);
  if (raw <= 0n) return { ok: false, error: S.errors.invalidAmount };
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: S.errors.tooLarge };
  return { ok: true, raw: Number(raw) };
}

/** Raw units → the exact human string (trailing zeros trimmed), e.g. for a "Max" button. */
export function rawToInput(raw: number, symbol: string): string {
  const d = tokenDecimals(symbol);
  const n = BigInt(Math.max(0, Math.floor(raw)));
  if (d === 0) return n.toString();
  const base = 10n ** BigInt(d);
  const frac = (n % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}

/** Human number → an input string with at most the token's decimals (for auto-filled fields). */
export function humanToInput(human: number, symbol: string): string {
  if (!Number.isFinite(human) || human <= 0) return "";
  const d = tokenDecimals(symbol);
  const s = human.toFixed(Math.min(d, 20));
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Display a raw amount (core's formatter — the one the wallet and explorer use). */
export function fmtAmount(raw: number, symbol?: string): string {
  return formatTokenAmount(raw, symbol);
}

/** LP tokens have no decimals: display raw with grouping. */
export function fmtLp(raw: number): string {
  return formatTokenAmount(raw);
}
