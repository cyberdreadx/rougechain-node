/**
 * Which token a transaction's `amount` is denominated in, for explorer lists and details.
 *
 * Transfers name it in `token_symbol` (absent = native XRGE). Swaps carry the input token in
 * `token_a_symbol` and the output token in `token_b_symbol`; their `amount` is the input amount.
 */
type LoosePayload = Record<string, unknown> | undefined | null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function txAmountSymbol(type: string | undefined, payload: LoosePayload): string {
  const p = payload ?? {};
  if ((type ?? "").toLowerCase() === "swap") {
    return str(p.token_a_symbol) ?? str(p.token_in) ?? "XRGE";
  }
  return str(p.token_symbol) ?? str(p.tokenSymbol) ?? "XRGE";
}

/** Input/output side of a swap as recorded on-chain (older payload shapes included). */
export function swapSides(payload: LoosePayload): {
  tokenIn?: string; amountIn?: number; tokenOut?: string; minOut?: number; poolId?: string;
} {
  const p = payload ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    tokenIn: str(p.token_a_symbol) ?? str(p.token_in),
    amountIn: num(p.amount_a) ?? num(p.amount_in) ?? num(p.amount),
    tokenOut: str(p.token_b_symbol) ?? str(p.token_out),
    minOut: num(p.min_amount_out),
    poolId: str(p.pool_id),
  };
}
